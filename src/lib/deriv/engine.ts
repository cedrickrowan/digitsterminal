// Analysis engine — pure, allocation-lean, runs on main thread or in a Web Worker.
// Uses Uint8Array FIFO ring buffer sized to the user's manual `lookback` setting
// so counters can never exceed the configured window (structural guarantee).

import type { AppConfig } from "./types";
import { forecastHorizon, type HorizonForecast } from "./matrix";

export interface EngineReport {
  tickIndex: number;
  coreSpeedMs: number;
  bufferSize: number;
  lookback: number;
  intervalMs: number;
  intervalStdMs: number;
  entropyDecay: number; // 0..1, distance from uniform equilibrium
  confidenceAdjust: number; // multiplier applied to top-digit confidence
  bitmask: number; // Sync=8 Rise=1 Even=2 Over=4 (sticky — never drops to 000)
  higherOrder: {
    order2: number[]; // 10-length prob dist from (a,b) -> next
    order3: number[]; // 10-length prob dist from (a,b,c) -> next
  };
  /** Matrix-power multi-tick horizon forecast (P² plain / P³ 1s). */
  horizon: HorizonForecast;
  log: string;
}


// Small fast frequencies using preallocated typed array
function freqU8(buf: Uint8Array, from: number, len: number, out: Uint32Array): void {
  out.fill(0);
  const cap = buf.length;
  for (let i = 0; i < len; i++) {
    const d = buf[(from + i) % cap];
    if (d < 10) out[d]++;
  }
}

export class DigitEngine {
  // Ring buffer sized strictly to lookback (FIFO — oldest evicted on push).
  private ring: Uint8Array;
  private cap = 0;
  private size = 0;
  private head = 0; // index of oldest
  private tickIndex = 0;

  // Higher-order Markov transition counts (bounded, tiny)
  //   order2: 100 rows × 10 cols → 1000
  //   order3: 1000 rows × 10 cols → 10000
  private mk2Counts = new Uint32Array(100 * 10);
  private mk2Row = new Uint32Array(100);
  private mk3Counts = new Uint32Array(1000 * 10);
  private mk3Row = new Uint32Array(1000);

  // Inter-tick interval buffer for time-seed tracking (32 samples)
  private intervals = new Float32Array(32);
  private ivHead = 0;
  private ivCount = 0;
  private lastTs = 0;

  private freqBuf = new Uint32Array(10);
  private lookback: number;
  // Sticky bitmask — a transient tie must never collapse the mask to 000.
  private lastMask = 0;


  constructor(lookback: number) {
    this.lookback = Math.max(5, lookback);
    this.cap = this.lookback;
    this.ring = new Uint8Array(this.cap);
  }

  resizeLookback(next: number): void {
    const target = Math.max(5, next);
    if (target === this.cap) return;
    // Preserve most recent min(size, target) digits, oldest-first.
    const keep = Math.min(this.size, target);
    const snapshot = new Uint8Array(keep);
    for (let i = 0; i < keep; i++) {
      snapshot[i] = this.ring[(this.head + this.size - keep + i) % this.cap];
    }
    this.ring = new Uint8Array(target);
    this.ring.set(snapshot);
    this.cap = target;
    this.size = keep;
    this.head = 0;
    this.lookback = target;
    // higher-order counts recomputed lazily on next analyze
    this.rebuildMarkov();
  }

  seed(digits: number[]): void {
    for (let i = 0; i < digits.length; i++) {
      const d = digits[i];
      if (d < 0 || d > 9) continue;
      this.pushRaw(d);
    }
    this.rebuildMarkov();
  }

  private pushRaw(d: number): void {
    if (this.size < this.cap) {
      this.ring[(this.head + this.size) % this.cap] = d;
      this.size++;
    } else {
      // FIFO eviction — oldest slot is `head`, overwrite and advance head.
      this.ring[this.head] = d;
      this.head = (this.head + 1) % this.cap;
    }
  }

  private rebuildMarkov(): void {
    this.mk2Counts.fill(0);
    this.mk2Row.fill(0);
    this.mk3Counts.fill(0);
    this.mk3Row.fill(0);
    if (this.size < 3) return;
    // Iterate in temporal order
    for (let i = 0; i < this.size - 2; i++) {
      const a = this.ring[(this.head + i) % this.cap];
      const b = this.ring[(this.head + i + 1) % this.cap];
      const c = this.ring[(this.head + i + 2) % this.cap];
      const k2 = a * 10 + b;
      this.mk2Counts[k2 * 10 + c]++;
      this.mk2Row[k2]++;
      if (i < this.size - 3) {
        const d = this.ring[(this.head + i + 3) % this.cap];
        const k3 = a * 100 + b * 10 + c;
        this.mk3Counts[k3 * 10 + d]++;
        this.mk3Row[k3]++;
      }
    }
  }

  push(digit: number, timestampMs: number): void {
    if (digit < 0 || digit > 9) return;
    this.tickIndex++;
    // Incrementally update higher-order counts using the trailing triples that
    // are about to leave / enter the window.
    if (this.size >= 3) {
      const a = this.ring[(this.head + this.size - 3) % this.cap];
      const b = this.ring[(this.head + this.size - 2) % this.cap];
      const c = this.ring[(this.head + this.size - 1) % this.cap];
      const k2 = b * 10 + c;
      this.mk2Counts[k2 * 10 + digit]++;
      this.mk2Row[k2]++;
      if (this.size >= 4 || this.size >= 3) {
        // trigram a→b→c produced `digit`
        const k3 = a * 10 * 10 + b * 10 + c;
        this.mk3Counts[k3 * 10 + digit]++;
        this.mk3Row[k3]++;
      }
    }
    // If the buffer was full, we are about to evict the oldest — decrement its
    // outgoing bigram/trigram contributions to keep counts strictly bounded to
    // the lookback window.
    if (this.size === this.cap && this.cap >= 4) {
      const o0 = this.ring[this.head]; // being evicted
      const o1 = this.ring[(this.head + 1) % this.cap];
      const o2 = this.ring[(this.head + 2) % this.cap];
      const o3 = this.ring[(this.head + 3) % this.cap];
      const k2 = o0 * 10 + o1;
      if (this.mk2Row[k2] > 0) {
        this.mk2Counts[k2 * 10 + o2]--;
        this.mk2Row[k2]--;
      }
      if (this.cap >= 5) {
        const k3 = o0 * 100 + o1 * 10 + o2;
        if (this.mk3Row[k3] > 0) {
          this.mk3Counts[k3 * 10 + o3]--;
          this.mk3Row[k3]--;
        }
      }
    }
    this.pushRaw(digit);
    if (this.lastTs && timestampMs > this.lastTs) {
      const dt = timestampMs - this.lastTs;
      this.intervals[this.ivHead] = dt;
      this.ivHead = (this.ivHead + 1) % this.intervals.length;
      if (this.ivCount < this.intervals.length) this.ivCount++;
    }
    this.lastTs = timestampMs;
  }

  // Best-effort snapshot of current buffer, temporal order, oldest→newest.
  snapshot(): number[] {
    const out = new Array<number>(this.size);
    for (let i = 0; i < this.size; i++) out[i] = this.ring[(this.head + i) % this.cap];
    return out;
  }

  // 2nd-order distribution from the two most recent digits (b,c) → next.
  order2Dist(): number[] {
    if (this.size < 2) return new Array(10).fill(0.1);
    const b = this.ring[(this.head + this.size - 2) % this.cap];
    const c = this.ring[(this.head + this.size - 1) % this.cap];
    const k = b * 10 + c;
    const total = this.mk2Row[k];
    if (total === 0) return new Array(10).fill(0.1);
    const out = new Array(10);
    for (let i = 0; i < 10; i++) out[i] = this.mk2Counts[k * 10 + i] / total;
    return out;
  }

  // 3rd-order distribution from the last three digits (a,b,c) → next.
  order3Dist(): number[] {
    if (this.size < 3) return new Array(10).fill(0.1);
    const a = this.ring[(this.head + this.size - 3) % this.cap];
    const b = this.ring[(this.head + this.size - 2) % this.cap];
    const c = this.ring[(this.head + this.size - 1) % this.cap];
    const k = a * 100 + b * 10 + c;
    const total = this.mk3Row[k];
    if (total === 0) return new Array(10).fill(0.1);
    const out = new Array(10);
    for (let i = 0; i < 10; i++) out[i] = this.mk3Counts[k * 10 + i] / total;
    return out;
  }

  analyze(cfg: AppConfig): EngineReport {
    const t0 = performance.now();
    const len = this.size;
    freqU8(this.ring, this.head, len, this.freqBuf);
    const n = len || 1;

    // Rolling 30-tick split analysis
    const startIdx = Math.max(0, len - 30);
    let even = 0, high = 0, upMoves = 0, downMoves = 0;
    let prevDigit = -1;
    for (let i = startIdx; i < len; i++) {
      const d = this.ring[(this.head + i) % this.cap];
      if ((d & 1) === 0) even++;
      if (d >= 5) high++;
      if (prevDigit >= 0) {
        if (d > prevDigit) upMoves++;
        else if (d < prevDigit) downMoves++;
      }
      prevDigit = d;
    }
    const w30 = Math.max(1, len - startIdx);
    const pEven = even / w30;
    const pHigh = high / w30;

    // Entropy on rolling 30 window
    let H = 0;
    const w30Freq = new Uint32Array(10);
    for (let i = startIdx; i < len; i++) {
      w30Freq[this.ring[(this.head + i) % this.cap]]++;
    }
    for (let i = 0; i < 10; i++) {
      if (w30Freq[i] === 0) continue;
      const p = w30Freq[i] / w30;
      H -= p * Math.log2(p);
    }
    const Hmax = Math.log2(10);
    // "Decay" = how far below uniform max entropy (0 = perfectly uniform, 1 = degenerate)
    const entropyDecay = Math.max(0, Math.min(1, 1 - H / Hmax));
    // Distribution shift from 50/50 equilibrium on even/high axes
    const splitShift = Math.max(Math.abs(pEven - 0.5), Math.abs(pHigh - 0.5));
    // When PRNG decays / split shifts hard, we boost confidence on the
    // reversion side. Multiplier stays within a sane band [0.8, 1.25].
    const confidenceAdjust =
      1 + Math.min(0.25, entropyDecay * 0.6 + Math.max(0, splitShift - 0.15) * 0.5);

    // Bitwise flag mask — Sync=8, Rise=1, Even=2, Over(barrier)=4.
    // Bit 3 (Sync) is asserted whenever the stream has usable state, and the
    // whole mask is sticky: on a transient tie we carry the previous mask so
    // the binary matrix can never read `mask=0000` mid-cycle.
    const last = len > 0 ? this.ring[(this.head + len - 1) % this.cap] : -1;
    let mask = 0;
    if (upMoves > downMoves) mask |= 1;
    else if (upMoves === downMoves) mask |= this.lastMask & 1;
    if (last >= 0 && (last & 1) === 0) mask |= 2;
    if (last >= 0 && last > cfg.barrier) mask |= 4;
    if (len > 0) mask |= 8; // stream synced
    if (mask === 0) mask = this.lastMask || 8;
    this.lastMask = mask;


    // Time-seed interval stats
    let ivMean = 0, ivVar = 0;
    if (this.ivCount > 1) {
      for (let i = 0; i < this.ivCount; i++) ivMean += this.intervals[i];
      ivMean /= this.ivCount;
      for (let i = 0; i < this.ivCount; i++) {
        const d = this.intervals[i] - ivMean;
        ivVar += d * d;
      }
      ivVar /= this.ivCount;
    }
    const ivStd = Math.sqrt(ivVar);

    const order2 = this.order2Dist();
    const order3 = this.order3Dist();

    // ---- Matrix-power horizon forecast (async: runs inside the worker) ----
    // Plain index -> P², 1s index -> P³, plus cumulative multi-appearance
    // probabilities across a rolling 10-tick sliding window.
    const horizon = forecastHorizon(this.snapshot(), cfg.symbol, 10, 0.35);

    const coreSpeedMs = performance.now() - t0;

    // Human-readable per-tick health/status log
    const targetFreq = this.freqBuf[cfg.predictDigit] / n;
    const tgt = horizon.multi[cfg.predictDigit];
    const log =
      `[Tick ${this.tickIndex}] sync clean · buf ${this.size}/${this.cap} · ` +
      `Δt ${ivMean ? ivMean.toFixed(0) : "-"}ms±${ivStd.toFixed(0)} · ` +
      `H=${H.toFixed(2)} decay ${(entropyDecay * 100).toFixed(0)}% · ` +
      `hurst ${horizon.hurst.toFixed(2)}${horizon.neutralFallback ? " (neutral)" : ""} · ` +
      `P^${horizon.horizon}(${cfg.predictDigit})=${(horizon.horizonDist[cfg.predictDigit] * 100).toFixed(1)}% · ` +
      `x2/10=${((tgt?.tail[2] ?? 0) * 100).toFixed(0)}% · ` +
      `p(${cfg.predictDigit})=${(targetFreq * 100).toFixed(1)}% · ` +
      `mask=${mask.toString(2).padStart(4, "0")} · core ${coreSpeedMs.toFixed(2)}ms`;

    return {
      tickIndex: this.tickIndex,
      coreSpeedMs,
      bufferSize: this.size,
      lookback: this.cap,
      intervalMs: ivMean,
      intervalStdMs: ivStd,
      entropyDecay,
      confidenceAdjust,
      bitmask: mask,
      higherOrder: { order2, order3 },
      horizon,
      log,

    };
  }
}
