// Background market-context analytics. Pure, allocation-lean helpers that
// enrich the digit prediction with underlying price momentum, tick-delta
// volatility, a 3-state HMM regime estimate, Poisson cluster anomalies, and
// a consolidated signal-router payload. UI is not touched.

export type MarketDirection = "UPTREND" | "DOWNTREND" | "FLAT";
export type VolatilityState = "HIGH" | "NORMAL" | "LOW";
export type HmmState = "MEAN_REVERTING" | "TRENDING_HIGH" | "TRENDING_LOW";

export interface PriceEmaResult {
  ema5: number;
  ema20: number;
  direction: MarketDirection;
}

// Simple EMA over the tail of a numeric series. `period` must be > 0.
function ema(series: number[], period: number): number {
  if (series.length === 0) return 0;
  const k = 2 / (period + 1);
  let e = series[0];
  for (let i = 1; i < series.length; i++) e = series[i] * k + e * (1 - k);
  return e;
}

export function priceEma(prices: number[]): PriceEmaResult {
  if (prices.length < 2) return { ema5: prices[0] ?? 0, ema20: prices[0] ?? 0, direction: "FLAT" };
  const tail20 = prices.slice(-20);
  const tail5 = prices.slice(-5);
  const e5 = ema(tail5, 5);
  const e20 = ema(tail20, 20);
  const drift = Math.abs(e5 - e20);
  const scale = Math.max(1e-9, Math.abs(e20)) * 1e-5; // treat sub-ppm gaps as flat
  let direction: MarketDirection = "FLAT";
  if (drift > scale) direction = e5 > e20 ? "UPTREND" : "DOWNTREND";
  return { ema5: e5, ema20: e20, direction };
}

// Tick-delta volatility detector. Compares the newest |Δ| to the std-dev of
// the last 30 |Δ|s to classify HIGH / NORMAL / LOW volatility.
export function volatilityState(deltas: number[]): {
  state: VolatilityState;
  latest: number;
  baseline: number;
} {
  if (deltas.length < 3) return { state: "NORMAL", latest: 0, baseline: 0 };
  const tail = deltas.slice(-30);
  const latest = tail[tail.length - 1];
  let mean = 0;
  for (let i = 0; i < tail.length; i++) mean += tail[i];
  mean /= tail.length;
  let variance = 0;
  for (let i = 0; i < tail.length; i++) {
    const d = tail[i] - mean;
    variance += d * d;
  }
  const std = Math.sqrt(variance / tail.length);
  const baseline = std;
  let state: VolatilityState = "NORMAL";
  if (baseline > 0) {
    if (latest > baseline * 1.5) state = "HIGH";
    else if (latest < baseline * 0.5) state = "LOW";
  }
  return { state, latest, baseline };
}

// Lightweight 3-state HMM classification. We use the last 50 digits to
// estimate the emission probability of each hidden state and pick the
// argmax; no Viterbi decoding — the emission model is descriptive enough
// for a filter and keeps the mobile budget tiny.
export function hmmState(window: number[]): { state: HmmState; scores: Record<HmmState, number> } {
  const w = window.slice(-50);
  const n = w.length;
  const scores: Record<HmmState, number> = {
    MEAN_REVERTING: 0.34,
    TRENDING_HIGH: 0.33,
    TRENDING_LOW: 0.33,
  };
  if (n < 6) return { state: "MEAN_REVERTING", scores };
  let high = 0;
  let low = 0;
  let mean = 0;
  for (let i = 0; i < n; i++) {
    const d = w[i];
    mean += d;
    if (d >= 6) high++;
    else if (d <= 3) low++;
  }
  mean /= n;
  let sqErr = 0;
  for (let i = 0; i < n; i++) {
    const g = w[i] - mean;
    sqErr += g * g;
  }
  const variance = sqErr / n;
  // Emission model: closeness to canonical regime signatures.
  const meanRevertScore = Math.exp(-Math.abs(mean - 4.5)) * (variance > 5 ? 1.1 : 0.9);
  const trendHighScore = (high / n) * (mean > 5 ? 1.2 : 0.7);
  const trendLowScore = (low / n) * (mean < 4 ? 1.2 : 0.7);
  const total = meanRevertScore + trendHighScore + trendLowScore || 1;
  scores.MEAN_REVERTING = meanRevertScore / total;
  scores.TRENDING_HIGH = trendHighScore / total;
  scores.TRENDING_LOW = trendLowScore / total;
  let state: HmmState = "MEAN_REVERTING";
  if (scores.TRENDING_HIGH > scores[state]) state = "TRENDING_HIGH";
  if (scores.TRENDING_LOW > scores[state]) state = "TRENDING_LOW";
  return { state, scores };
}

// Poisson cluster detector on the last 100 digits. Returns a per-digit
// weight multiplier centred on 1.0 — digits whose observed count deviates
// strongly from the uniform expectation get a stronger tilt (mean-reversion
// away from over-emitted digits, boost toward under-emitted digits).
export function poissonClusterWeights(window: number[]): number[] {
  const w = window.slice(-100);
  const n = w.length;
  const out = new Array(10).fill(1);
  if (n < 20) return out;
  const expected = n / 10;
  const stdev = Math.sqrt(expected); // Poisson σ ≈ √λ
  for (let d = 0; d < 10; d++) {
    let count = 0;
    for (let i = 0; i < n; i++) if (w[i] === d) count++;
    const z = (count - expected) / Math.max(1e-9, stdev);
    // Convert z-score to a bounded multiplier: strong over-emission (z>>0)
    // pulls weight down; strong under-emission lifts it. Cap in [0.6, 1.4].
    const tilt = Math.max(-0.4, Math.min(0.4, -0.12 * z));
    out[d] = 1 + tilt;
  }
  return out;
}

// Combine the base ensemble posterior with the market context. Bounded
// multipliers only — never zero out a digit, keep the array normalized.
export function applyContextWeights(
  posterior: number[],
  ctx: {
    direction: MarketDirection;
    volatility: VolatilityState;
    hmm: HmmState;
    poissonWeights: number[];
  },
): number[] {
  const out = new Array(10);
  for (let d = 0; d < 10; d++) {
    let w = posterior[d] * (ctx.poissonWeights[d] ?? 1);
    // Direction / volatility tilt across the 0-9 spectrum.
    if (ctx.direction === "UPTREND" && ctx.volatility === "HIGH" && d >= 5) w *= 1.2;
    if (ctx.direction === "DOWNTREND" && ctx.volatility === "HIGH" && d <= 4) w *= 1.2;
    if (ctx.direction === "FLAT" && ctx.volatility === "LOW" && d <= 4) w *= 1.15;
    // HMM regime nudges
    if (ctx.hmm === "TRENDING_HIGH" && d >= 6) w *= 1.1;
    if (ctx.hmm === "TRENDING_LOW" && d <= 3) w *= 1.1;
    if (ctx.hmm === "MEAN_REVERTING" && (d === 4 || d === 5)) w *= 1.05;
    out[d] = w;
  }
  let s = 0;
  for (let i = 0; i < 10; i++) s += out[i];
  if (s <= 0) return posterior.slice();
  for (let i = 0; i < 10; i++) out[i] /= s;
  return out;
}

export interface SignalRouterPayload {
  alphaDigit: number;
  matrixTarget: { boundary: number; side: "OVER" | "UNDER"; probability: number } | null;
  evenOddBias: { choice: "EVEN" | "ODD"; probability: number };
  trendDirection: "RISE" | "FALL" | "FLAT";
}

export function buildSignalRouter(
  posterior: number[],
  pEven: number,
  rise: { up: number; down: number },
): SignalRouterPayload {
  let alpha = 0;
  for (let i = 1; i < 10; i++) if (posterior[i] > posterior[alpha]) alpha = i;
    // Over/Under boundary at the highest cumulative probability ≥ 0.75 (3-way aware).
  let target: SignalRouterPayload["matrixTarget"] = null;
  for (let b = 0; b <= 9; b++) {
    let over = 0;
    for (let i = b + 1; i < 10; i++) over += posterior[i];
    let under = 0;
    for (let i = 0; i < b; i++) under += posterior[i];
    const tie = posterior[b] ?? 0;

    // Skip dead-zone barriers where landing on the barrier has >= 10% lose-lose risk
    if (tie >= 0.10) continue;

    if (b < 9 && over >= 0.75 && (!target || over > target.probability)) {
      target = { boundary: b, side: "OVER", probability: over };
    } else if (b > 0 && under >= 0.75 && (!target || under > target.probability)) {
      target = { boundary: b, side: "UNDER", probability: under };
    }
  }
  const evenOddBias: SignalRouterPayload["evenOddBias"] =
    pEven >= 0.5
      ? { choice: "EVEN", probability: pEven }
      : { choice: "ODD", probability: 1 - pEven };
  let trendDirection: SignalRouterPayload["trendDirection"] = "FLAT";
  if (rise.up > rise.down * 1.2) trendDirection = "RISE";
  else if (rise.down > rise.up * 1.2) trendDirection = "FALL";
  return { alphaDigit: alpha, matrixTarget: target, evenOddBias, trendDirection };
}
