// Digits Navigator — Corrected Mathematical Engine (Version 2), full port.
// NOTHING IS TRUNCATED — every formula from the uploaded corrected engine draft
// is implemented exactly, plus the master-blueprint diagnostics that the draft
// referenced (AMI across lags 1..7, LZW compression ratio, CUSUM/Page-Hinkley
// regime shift, Kelly criterion and Gambler's-Ruin advisory).
//
// Includes:
//  1. Exact dynamic programming for multi-appearance (>= 2 and >= 3 hits) over horizon D
//  2. Exact run-at-least-once probability (adjacent pair / triple) over horizon D
//  3. Exact landing probability via matrix exponentiation M^D
//  4. 15-tick deep tail fatigue & streak disqualification filter
//  5. Wald-Wolfowitz Runs Test, KL Divergence with EMA, KS Drift, AMI with Miller-Madow
//  6. Dual ping thresholds (<350ms for 1HZ symbols, <500ms for plain)
//  7. Candidate ranking based strictly on multi-appearance probability
//  8. LZW compression ratio (blueprint §6.5)
//  9. CUSUM / Page-Hinkley regime-shift monitor (blueprint §6.6)
// 10. AMI across lags k = 1..7 (blueprint §6.4)
// 11. Advisory Kelly fraction & Gambler's-Ruin drought probability (blueprint §8)
//
// STRICTLY ANALYSIS ONLY — this engine never purchases or trades.

export interface EngineTickInput {
  price: number;
  pip: number;
  epoch: number;
  duration: number; // Horizon D in ticks (1..10)
  symbol: string;
  rttMs?: number;
  /** When the caller already extracted the digit (trailing-zero-safe), pass it
   *  here; price/pip are then only used for display. Prevents double-push. */
  digit?: number;
}

export interface DigitMetrics {
  digit: number;
  landingProb: number; // Exact probability of landing on tick t+D
  multiHitProb: number; // Exact probability of >= 2 appearances in {t+1..t+D}
  consecProb: number; // Exact probability of D consecutive appearances
  pairProb: number; // Exact probability of >= 1 adjacent pair (d,d)
  tripleProb: number; // Exact probability of >= 1 adjacent triple (d,d,d)
  threeHitProb: number; // Exact probability of >= 3 appearances in {t+1..t+D}
  status: "FRESH" | "TIRED" | "TOP_PICK";
  fatigueScore: number; // Appearances in last 15 ticks
}

export interface EngineResult {
  symbol: string;
  currentTick: number;
  currentPrice: string;
  selectedDuration: number;
  topTargetDigit: number;
  topTargetProb: number;
  multiHitProb: number;
  consecProb: number;
  pairProb: number;
  tripleProb: number;
  threeHitProb: number;

  // Statistical Diagnostics
  runsZScore: number;
  klDivergence: number;
  ksDrift: number;
  amiBits: number; // lag-D AMI (draft semantics)
  amiLags: number[]; // AMI for lags 1..7 (blueprint)
  lzwRatio: number; // LZW dictionary phrases / N (blueprint)
  cusum: number; // Page-Hinkley accumulator
  cusumShift: boolean; // structural regime shift detected this tick
  regime: "BALANCED_RANDOM" | "PARITY_CLUSTERING" | "MEAN_REVERTING";
  adaptiveKlThreshold: number;

  // Pools
  freshPool: number[];
  tiredPool: number[];
  digits: DigitMetrics[];

  // Network & Safety
  executionCutoffMs: number;
  rttMs: number;
  pingThresholdMs: number;
  latencyGatePassed: boolean;
  alertDecision: "READY / MANUAL ALERT" | "HOLD / NO SIGNAL" | "HOLD / UNSAFE LATENCY";

  // Advisory risk (display-only — never executes)
  kellyFraction: number;
  ruinProb: number;
  analyzeMs: number;
}

export const NAV_BUFFER_SIZE = 100;
export const NAV_MICRO_WINDOW = 20;
export const NAV_TAIL_WINDOW = 15;
export const NAV_MULTI_HIT_FLOOR = 0.07; // 7.0% provisional density floor
export const NAV_EXECUTION_CUTOFF_MS = 700;
/** Advisory Kelly payout odds for a digit Matches contract (~9x). */
export const NAV_KELLY_ODDS = 9;
/** Gambler's-ruin drought horizon (ticks without a hit) and bankroll units. */
export const NAV_RUIN_DROUGHT_TICKS = 10;
export const NAV_RUIN_BANKROLL_UNITS = 20;

export class DigitsEngine {
  private static readonly BUFFER_SIZE = NAV_BUFFER_SIZE;
  private static readonly MICRO_WINDOW = NAV_MICRO_WINDOW;
  private static readonly TAIL_WINDOW = NAV_TAIL_WINDOW;

  private readonly buffer: Uint8Array = new Uint8Array(DigitsEngine.BUFFER_SIZE);
  private count: number = 0;

  // Transition matrix M (10x10)
  private readonly T1: Float64Array = new Float64Array(100);
  private readonly TD: Float64Array = new Float64Array(100);
  private readonly scratchA: Float64Array = new Float64Array(100);
  private readonly scratchB: Float64Array = new Float64Array(100);

  // Scratch vectors
  private readonly freq100: Int32Array = new Int32Array(10);
  private readonly freq20: Int32Array = new Int32Array(10);
  private readonly freqTail: Int32Array = new Int32Array(10);

  // Dynamic Programming state tables for exact multi-hit calculation.
  // Preallocated once (blueprint §9.2) so the V8 GC never pauses mid-alert:
  //   hit-count DP needs 10 × (requiredHits+1) ≤ 40 states,
  //   run DP needs 10 × (runLength+1) × 2 ≤ 80 states.
  private readonly dpHitA: Float64Array = new Float64Array(40);
  private readonly dpHitB: Float64Array = new Float64Array(40);
  private readonly dpRunA: Float64Array = new Float64Array(80);
  private readonly dpRunB: Float64Array = new Float64Array(80);
  private readonly pairCounts = new Int32Array(100);
  private readonly margX = new Int32Array(10);
  private readonly margY = new Int32Array(10);
  private readonly lzwDict = new Set<number>();

  // Adaptive KL threshold moving average
  private emaKl: number = 0.2;
  private readonly alpha: number = 0.05;

  // CUSUM / Page-Hinkley state
  private cusumAcc: number = 0;

  public static extractDigit(price: number, pip: number): number {
    const s = price.toFixed(pip);
    const ch = s.charAt(s.length - 1);
    const d = parseInt(ch, 10);
    return Number.isInteger(d) && d >= 0 && d <= 9 ? d : -1;
  }

  public pushTick(digit: number): void {
    if (digit < 0 || digit > 9) return;
    if (this.count < DigitsEngine.BUFFER_SIZE) {
      this.buffer[this.count++] = digit;
    } else {
      this.buffer.copyWithin(0, 1, DigitsEngine.BUFFER_SIZE);
      this.buffer[DigitsEngine.BUFFER_SIZE - 1] = digit;
    }
  }

  /** Seed the buffer from history (oldest → newest). */
  public seed(digits: number[]): void {
    for (const d of digits) this.pushTick(d);
  }

  public reset(): void {
    this.count = 0;
    this.emaKl = 0.2;
    this.cusumAcc = 0;
  }

  private matMul10x10(A: Float64Array, B: Float64Array, Out: Float64Array): void {
    for (let i = 0; i < 10; i++) {
      const iOffset = i * 10;
      for (let j = 0; j < 10; j++) {
        let sum = 0.0;
        for (let k = 0; k < 10; k++) {
          sum += A[iOffset + k] * B[k * 10 + j];
        }
        Out[iOffset + j] = sum;
      }
    }
  }

  private matPower10x10(Base: Float64Array, D: number, Result: Float64Array): void {
    if (D <= 1) {
      Result.set(Base);
      return;
    }
    this.scratchA.set(Base);
    Result.fill(0);
    for (let i = 0; i < 10; i++) Result[i * 10 + i] = 1.0;

    let p = D;
    while (p > 0) {
      if (p % 2 === 1) {
        this.matMul10x10(Result, this.scratchA, this.scratchB);
        Result.set(this.scratchB);
      }
      p = Math.floor(p / 2);
      if (p > 0) {
        this.matMul10x10(this.scratchA, this.scratchA, this.scratchB);
        this.scratchA.set(this.scratchB);
      }
    }
  }

  /** Exact probability of reaching a specified hit count in D future ticks. */
  private computeHitCountProb(
    startDigit: number,
    targetDigit: number,
    D: number,
    requiredHits: number,
    current: Float64Array,
    next: Float64Array,
  ): number {
    if (D < requiredHits) return 0.0;
    const width = requiredHits + 1;
    current.fill(0);
    next.fill(0);
    current[startDigit * width] = 1.0;
    for (let step = 0; step < D; step++) {
      next.fill(0);
      for (let x = 0; x < 10; x++) {
        for (let c = 0; c < width; c++) {
          const p = current[x * width + c];
          if (p === 0) continue;
          for (let y = 0; y < 10; y++) {
            const nc = Math.min(requiredHits, c + (y === targetDigit ? 1 : 0));
            next[y * width + nc] += p * this.T1[x * 10 + y];
          }
        }
      }
      // swap in place (both are preallocated scratch buffers)
      for (let i = 0; i < 10 * width; i++) {
        const t = current[i];
        current[i] = next[i];
        next[i] = t;
      }
    }
    let result = 0;
    for (let x = 0; x < 10; x++) result += current[x * width + requiredHits];
    return result;
  }

  /** Exact probability of seeing at least one run of runLength target digits in the D future ticks. */
  private computeRunAtLeastOnce(
    startDigit: number,
    targetDigit: number,
    D: number,
    runLength: number,
    current: Float64Array,
    next: Float64Array,
  ): number {
    if (D < runLength) return 0.0;
    const runStates = runLength + 1;
    const stateCount = 10 * runStates * 2; // digit × current run length × event seen
    current.fill(0);
    next.fill(0);
    const idx = (digit: number, run: number, seen: number) => (digit * runStates + run) * 2 + seen;
    current[idx(startDigit, 0, 0)] = 1.0; // current observation is outside future horizon
    for (let step = 0; step < D; step++) {
      next.fill(0);
      for (let x = 0; x < 10; x++) {
        for (let run = 0; run < runStates; run++) {
          for (let seen = 0; seen <= 1; seen++) {
            const p = current[idx(x, run, seen)];
            if (p === 0) continue;
            for (let y = 0; y < 10; y++) {
              const nr = y === targetDigit ? Math.min(runLength, run + 1) : 0;
              const ns = seen || nr >= runLength ? 1 : 0;
              next[idx(y, nr, ns)] += p * this.T1[x * 10 + y];
            }
          }
        }
      }
      for (let i = 0; i < stateCount; i++) {
        const t = current[i];
        current[i] = next[i];
        next[i] = t;
      }
    }
    let result = 0;
    for (let x = 0; x < 10; x++) for (let run = 0; run < runStates; run++) result += current[idx(x, run, 1)];
    return result;
  }

  /** AMI between X_t and X_{t+k} with Miller-Madow bias correction (bits). */
  private amiAtLag(k: number): number {
    const nPairs = DigitsEngine.BUFFER_SIZE - k;
    if (nPairs <= 20) return 0;
    this.pairCounts.fill(0);
    this.margX.fill(0);
    this.margY.fill(0);
    for (let i = 0; i < nPairs; i++) {
      const x = this.buffer[i];
      const y = this.buffer[i + k];
      this.pairCounts[x * 10 + y]++;
      this.margX[x]++;
      this.margY[y]++;
    }
    let ami = 0.0;
    for (let x = 0; x < 10; x++) {
      for (let y = 0; y < 10; y++) {
        const c = this.pairCounts[x * 10 + y];
        if (c > 0) {
          const pxy = c / nPairs;
          const px = this.margX[x] / nPairs;
          const py = this.margY[y] / nPairs;
          ami += pxy * Math.log2(pxy / (px * py));
        }
      }
    }
    // Miller-Madow bias correction: (R-1)^2 / (2N ln2) with R = 10 symbols.
    const mmCorrection = 81.0 / (2.0 * nPairs * Math.LN2);
    return Math.max(0.0, ami - mmCorrection);
  }

  /** Lempel-Ziv-Welch compression ratio: dictionary phrases / N. Lower ratio
   *  indicates repeating block sequences (blueprint §6.5). */
  private lzwRatio(): number {
    const N = DigitsEngine.BUFFER_SIZE;
    this.lzwDict.clear();
    let phrases = 0;
    let w = -1; // current phrase, -1 = empty
    for (let i = 0; i < N; i++) {
      const c = this.buffer[i];
      const wc = w < 0 ? c : w * 10 + c;
      if (w >= 0 && this.lzwDict.has(wc)) {
        w = wc;
      } else {
        if (w >= 0) this.lzwDict.add(wc);
        phrases++;
        w = c;
      }
    }
    if (w >= 0) phrases++;
    return phrases / N;
  }

  public calculate(input: EngineTickInput): EngineResult | null {
    const t0 = performance.now();
    let digit: number;
    if (input.digit !== undefined && input.digit >= 0 && input.digit <= 9) {
      digit = input.digit;
    } else {
      digit = DigitsEngine.extractDigit(input.price, input.pip);
      if (digit === -1) return null;
    }
    this.pushTick(digit);

    if (this.count < DigitsEngine.BUFFER_SIZE) {
      return null;
    }

    const D = Math.max(1, Math.min(10, Math.floor(input.duration || 3)));
    const currDigit = this.buffer[DigitsEngine.BUFFER_SIZE - 1];

    // 1. Build transition matrix with Laplace smoothing (+1 prior)
    this.T1.fill(1.0);
    this.freq100.fill(0);

    for (let i = 0; i < DigitsEngine.BUFFER_SIZE - 1; i++) {
      const a = this.buffer[i];
      const b = this.buffer[i + 1];
      this.T1[a * 10 + b] += 1.0;
      this.freq100[a]++;
    }
    this.freq100[currDigit]++;

    for (let i = 0; i < 10; i++) {
      const offset = i * 10;
      let rowSum = 0.0;
      for (let j = 0; j < 10; j++) rowSum += this.T1[offset + j];
      const inv = 1.0 / rowSum;
      for (let j = 0; j < 10; j++) this.T1[offset + j] *= inv;
    }

    // 2. Matrix Exponentiation for Landing Probability M^D
    this.matPower10x10(this.T1, D, this.TD);

    // 3. Wald-Wolfowitz Runs Test on Parity
    let runs = 1;
    let nEven = 0;
    for (let i = 0; i < DigitsEngine.BUFFER_SIZE; i++) {
      if (this.buffer[i] % 2 === 0) nEven++;
      if (i > 0 && this.buffer[i] % 2 !== this.buffer[i - 1] % 2) {
        runs++;
      }
    }
    const nOdd = DigitsEngine.BUFFER_SIZE - nEven;
    const muR = (2.0 * nEven * nOdd) / DigitsEngine.BUFFER_SIZE + 1.0;
    const varR =
      (2.0 * nEven * nOdd * (2.0 * nEven * nOdd - DigitsEngine.BUFFER_SIZE)) /
      (DigitsEngine.BUFFER_SIZE * DigitsEngine.BUFFER_SIZE * (DigitsEngine.BUFFER_SIZE - 1));
    const zRun = (runs - muR) / (Math.sqrt(varR) + 1e-6);

    // 4. Micro-window KL Divergence (last 20 ticks)
    this.freq20.fill(0);
    const microStart = DigitsEngine.BUFFER_SIZE - DigitsEngine.MICRO_WINDOW;
    for (let i = microStart; i < DigitsEngine.BUFFER_SIZE; i++) {
      this.freq20[this.buffer[i]]++;
    }
    let dKl = 0.0;
    for (let i = 0; i < 10; i++) {
      const p = (this.freq20[i] + 1e-5) / DigitsEngine.MICRO_WINDOW;
      dKl += p * Math.log2(p / 0.1);
    }
    this.emaKl = (1.0 - this.alpha) * this.emaKl + this.alpha * dKl;

    // 5. KS Drift vs Discrete Uniform
    let empCdf = 0.0;
    let ksDrift = 0.0;
    for (let i = 0; i < 10; i++) {
      empCdf += this.freq100[i] / DigitsEngine.BUFFER_SIZE;
      const uniCdf = (i + 1) * 0.1;
      const diff = Math.abs(empCdf - uniCdf);
      if (diff > ksDrift) ksDrift = diff;
    }

    // 6. AMI with Miller-Madow Bias Correction
    //    lag-D value (draft semantics) + full lag sweep k = 1..7 (blueprint §6.4)
    const amiLags: number[] = [];
    const maxLag = Math.min(7, DigitsEngine.BUFFER_SIZE - 21);
    for (let k = 1; k <= maxLag; k++) amiLags.push(this.amiAtLag(k));
    const amiBits = D <= maxLag ? amiLags[D - 1] : this.amiAtLag(D);

    // 6b. LZW compression ratio (blueprint §6.5)
    const lzw = this.lzwRatio();

    // 6c. CUSUM / Page-Hinkley regime-shift monitor (blueprint §6.6).
    //     S_k = max(0, S_{k-1} + (X_k − μ − allowance)); shift when S_k > h.
    //     On shift, adaptive thresholds decay-reset to avoid stale projections.
    let mean = 0;
    for (let i = 0; i < DigitsEngine.BUFFER_SIZE; i++) mean += this.buffer[i];
    mean /= DigitsEngine.BUFFER_SIZE;
    let cusumShift = false;
    for (let i = microStart; i < DigitsEngine.BUFFER_SIZE; i++) {
      this.cusumAcc = Math.max(0, this.cusumAcc + (this.buffer[i] - mean - 0.5));
      if (this.cusumAcc > 18) {
        cusumShift = true;
        this.cusumAcc = 0;
        this.emaKl = 0.2;
      }
    }

    // 7. Strict 15-tick Fatigue & Streak Filter
    this.freqTail.fill(0);
    const tailStart = DigitsEngine.BUFFER_SIZE - DigitsEngine.TAIL_WINDOW;
    const streakedDigits = new Set<number>();

    for (let i = tailStart; i < DigitsEngine.BUFFER_SIZE; i++) {
      this.freqTail[this.buffer[i]]++;
      if (i > tailStart && this.buffer[i] === this.buffer[i - 1]) {
        streakedDigits.add(this.buffer[i]);
      }
    }

    const recent4 = new Set<number>();
    for (let i = DigitsEngine.BUFFER_SIZE - 4; i < DigitsEngine.BUFFER_SIZE; i++) {
      recent4.add(this.buffer[i]);
    }
    const count12 = new Int32Array(10);
    for (let i = DigitsEngine.BUFFER_SIZE - 12; i < DigitsEngine.BUFFER_SIZE; i++) {
      count12[this.buffer[i]]++;
    }

    const freshPool: number[] = [];
    const tiredPool: number[] = [];

    for (let d = 0; d < 10; d++) {
      const isTired = recent4.has(d) || count12[d] >= 2 || streakedDigits.has(d);
      if (isTired) {
        tiredPool.push(d);
      } else {
        freshPool.push(d);
      }
    }

    // 8. Projection Metrics per Digit
    const currOffset = currDigit * 10;
    const digitMetrics: DigitMetrics[] = [];

    for (let d = 0; d < 10; d++) {
      const landingProb = this.TD[currOffset + d];

      // Exact D consecutive appearances: M(s0, d) * M(d, d)^(D-1)
      const pFirst = this.T1[currOffset + d];
      const pStay = this.T1[d * 10 + d];
      const consecProb = pFirst * Math.pow(pStay, D - 1);

      // Exact Multi-Appearance via Dynamic Programming
      const multiHitProb = this.computeHitCountProb(currDigit, d, D, 2, this.dpHitA, this.dpHitB);
      const threeHitProb = this.computeHitCountProb(currDigit, d, D, 3, this.dpHitB, this.dpHitA);
      const pairProb = this.computeRunAtLeastOnce(currDigit, d, D, 2, this.dpRunA, this.dpRunB);
      const tripleProb = this.computeRunAtLeastOnce(currDigit, d, D, 3, this.dpRunB, this.dpRunA);

      digitMetrics.push({
        digit: d,
        landingProb,
        multiHitProb,
        consecProb,
        pairProb,
        tripleProb,
        threeHitProb,
        status: freshPool.includes(d) ? "FRESH" : "TIRED",
        fatigueScore: this.freqTail[d],
      });
    }

    // Never fall back to tired targets. If none are fresh, return no signal.
    if (freshPool.length === 0) return null;
    // Rank candidates STRICTLY by exact multi-appearance probability
    const eligiblePool = freshPool;
    eligiblePool.sort((a, b) => digitMetrics[b].multiHitProb - digitMetrics[a].multiHitProb);
    const topPick = eligiblePool[0];

    digitMetrics[topPick].status = "TOP_PICK";

    // Market Regime Classification
    let regime: EngineResult["regime"] = "BALANCED_RANDOM";
    if (zRun < -1.96) regime = "PARITY_CLUSTERING";
    else if (zRun > 1.96) regime = "MEAN_REVERTING";

    const fmtPrice = input.price > 0 ? input.price.toFixed(input.pip) : "";
    const is1sSymbol = input.symbol.startsWith("1HZ");
    const pingThresholdMs = is1sSymbol ? 350 : 500;
    const actualRtt = input.rttMs ?? Number.POSITIVE_INFINITY;
    const pingOk = Number.isFinite(actualRtt) && actualRtt < pingThresholdMs;
    const passesFloor = digitMetrics[topPick].multiHitProb >= NAV_MULTI_HIT_FLOOR;

    let alertDecision: EngineResult["alertDecision"] = "HOLD / NO SIGNAL";
    if (!pingOk) {
      alertDecision = "HOLD / UNSAFE LATENCY";
    } else if (passesFloor && freshPool.includes(topPick)) {
      alertDecision = "READY / MANUAL ALERT";
    } else {
      alertDecision = "HOLD / NO SIGNAL";
    }

    // 9. Advisory risk engine (blueprint §8) — display-only, never executes.
    //    Kelly: f* = (b·p − q) / b with p = top-pick multi-hit probability.
    const pWin = digitMetrics[topPick].multiHitProb;
    const qLose = 1 - pWin;
    const kellyFraction = Math.max(0, (NAV_KELLY_ODDS * pWin - qLose) / NAV_KELLY_ODDS);
    //    Gambler's Ruin: P = 1 − (1 − (1−p)^n)^m over a n-tick drought, m units.
    const droughtNoHit = Math.pow(1 - pWin, NAV_RUIN_DROUGHT_TICKS);
    const ruinProb = 1 - Math.pow(1 - droughtNoHit, NAV_RUIN_BANKROLL_UNITS);

    return {
      symbol: input.symbol,
      currentTick: currDigit,
      currentPrice: fmtPrice,
      selectedDuration: D,
      topTargetDigit: topPick,
      topTargetProb: digitMetrics[topPick].landingProb,
      multiHitProb: digitMetrics[topPick].multiHitProb,
      consecProb: digitMetrics[topPick].consecProb,
      pairProb: digitMetrics[topPick].pairProb,
      tripleProb: digitMetrics[topPick].tripleProb,
      threeHitProb: digitMetrics[topPick].threeHitProb,
      runsZScore: zRun,
      klDivergence: dKl,
      ksDrift,
      amiBits,
      amiLags,
      lzwRatio: lzw,
      cusum: this.cusumAcc,
      cusumShift,
      regime,
      adaptiveKlThreshold: this.emaKl,
      freshPool,
      tiredPool,
      digits: digitMetrics,
      executionCutoffMs: NAV_EXECUTION_CUTOFF_MS,
      rttMs: Number.isFinite(actualRtt) ? actualRtt : 0,
      pingThresholdMs,
      latencyGatePassed: pingOk,
      alertDecision,
      kellyFraction,
      ruinProb,
      analyzeMs: performance.now() - t0,
    };
  }
}
