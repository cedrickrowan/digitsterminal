// Microstructure & data-integrity guards.
//  - Duplicate / out-of-order epoch rejection.
//  - Network burst rejection (packets arriving far faster than the asset's
//    cadence whose epochs don't advance by a full cadence step).
//  - Price-step constraint scaled to each asset's own rolling |Δ| baseline.
//  - Abnormal volatility spike gate (step > 3σ of rolling baseline).
import { cadenceProfile } from "./cadence";

export type GuardVerdict = "accept" | "duplicate" | "burst" | "corrupt";

export interface GuardResult {
  verdict: GuardVerdict;
  spike: boolean;
  step: number;
  sigma: number;
}

const BASELINE = 120; // rolling |Δ| samples
const MIN_BASELINE = 20; // samples before the step constraint engages
const SPIKE_SIGMA = 3;
const CORRUPT_SIGMA = 12; // a step this far out is a bad print, not volatility
const SPIKE_HOLD_TICKS = 3;

export class MicrostructureGuard {
  private symbol = "";
  private lastEpoch = 0;
  private lastArrival = 0;
  private lastPrice: number | null = null;
  private steps: number[] = [];
  private holdLeft = 0;
  accepted = 0;
  rejected = { duplicate: 0, burst: 0, corrupt: 0 };
  spikes = 0;

  reset(symbol: string) {
    this.symbol = symbol;
    this.lastEpoch = 0;
    this.lastArrival = 0;
    this.lastPrice = null;
    this.steps = [];
    this.holdLeft = 0;
    this.accepted = 0;
    this.rejected = { duplicate: 0, burst: 0, corrupt: 0 };
    this.spikes = 0;
  }

  /** Seed the |Δ| baseline from history so the gate is warm immediately. */
  seed(symbol: string, prices: number[]) {
    this.reset(symbol);
    for (let i = 1; i < prices.length; i++) this.pushStep(Math.abs(prices[i] - prices[i - 1]));
    if (prices.length) this.lastPrice = prices[prices.length - 1];
  }

  private pushStep(s: number) {
    if (!Number.isFinite(s)) return;
    this.steps.push(s);
    if (this.steps.length > BASELINE) this.steps.shift();
  }

  private stats() {
    const n = this.steps.length;
    if (n < 2) return { mean: 0, sd: 0 };
    let m = 0;
    for (const s of this.steps) m += s;
    m /= n;
    let v = 0;
    for (const s of this.steps) v += (s - m) * (s - m);
    return { mean: m, sd: Math.sqrt(v / (n - 1)) };
  }

  get spikeActive(): boolean {
    return this.holdLeft > 0;
  }

  check(symbol: string, price: number, epoch: number, arrivalMs: number): GuardResult {
    if (symbol !== this.symbol) this.reset(symbol);
    const cad = cadenceProfile(symbol);
    const { mean, sd } = this.stats();

    // Duplicate / out-of-order epoch.
    if (epoch && this.lastEpoch && epoch <= this.lastEpoch) {
      this.rejected.duplicate++;
      return { verdict: "duplicate", spike: this.spikeActive, step: 0, sigma: 0 };
    }
    // Burst: arrives <15% of cadence after the previous one AND the epoch did
    // not advance by a full cadence step → replayed/queued packet.
    const gap = this.lastArrival ? arrivalMs - this.lastArrival : Infinity;
    const epochStep = epoch && this.lastEpoch ? epoch - this.lastEpoch : Infinity;
    if (gap < cad.tickMs * 0.15 && epochStep * 1000 < cad.tickMs) {
      this.rejected.burst++;
      return { verdict: "burst", spike: this.spikeActive, step: 0, sigma: 0 };
    }

    const step = this.lastPrice === null ? 0 : Math.abs(price - this.lastPrice);
    const sigma = sd > 0 ? (step - mean) / sd : 0;
    const warm = this.steps.length >= MIN_BASELINE;

    if (warm && sd > 0 && sigma > CORRUPT_SIGMA) {
      this.rejected.corrupt++;
      return { verdict: "corrupt", spike: this.spikeActive, step, sigma };
    }

    this.lastEpoch = epoch || this.lastEpoch;
    this.lastArrival = arrivalMs;
    this.lastPrice = price;
    this.accepted++;

    if (warm && sd > 0 && sigma > SPIKE_SIGMA) {
      this.holdLeft = SPIKE_HOLD_TICKS;
      this.spikes++;
    } else if (this.holdLeft > 0) {
      this.holdLeft--;
    }
    if (step > 0) this.pushStep(step);
    return { verdict: "accept", spike: this.spikeActive, step, sigma };
  }
}
