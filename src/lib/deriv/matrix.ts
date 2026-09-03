// ============================================================================
// MATRIX POWER + NORMALIZATION CORE
// Multi-tick digit forecasting via Markov transition-matrix exponentiation.
//   Plain indices  -> P^2  (t+2 horizon)
//   1s indices     -> P^3  (t+3 horizon)
// Plus strict softmax normalization so the 10 digit probabilities always
// total exactly 100.0% (kills the 104% display overflow bug).
// ============================================================================

export const UNIFORM10: readonly number[] = Object.freeze(new Array(10).fill(0.1));

/** 1s indices tick every second -> deeper horizon to absorb refresh + hardware lag. */
export function isOneSecondIndex(symbol: string, label?: string): boolean {
  const s = (symbol || "").toUpperCase();
  if (/^1HZ\d+V$/.test(s)) return true;
  if (s.includes("1S")) return true;
  return (label ?? "").toLowerCase().includes("1s");
}

/** t+3 for 1s indices, t+2 for plain indices. */
export function horizonForSymbol(symbol: string, label?: string): 2 | 3 {
  return isOneSecondIndex(symbol, label) ? 3 : 2;
}

export function identity10(): number[][] {
  return Array.from({ length: 10 }, (_, i) => {
    const row = new Array(10).fill(0);
    row[i] = 1;
    return row;
  });
}

export function matMul(A: number[][], B: number[][]): number[][] {
  const out: number[][] = Array.from({ length: 10 }, () => new Array(10).fill(0));
  for (let i = 0; i < 10; i++) {
    const Ai = A[i];
    const Oi = out[i];
    for (let k = 0; k < 10; k++) {
      const a = Ai[k];
      if (a === 0) continue;
      const Bk = B[k];
      for (let j = 0; j < 10; j++) Oi[j] += a * Bk[j];
    }
  }
  return out;
}

/** P^n via repeated squaring. n >= 1. */
export function matPow(P: number[][], n: number): number[][] {
  let result = identity10();
  let base = P.map((r) => r.slice());
  let e = Math.max(1, Math.floor(n));
  while (e > 0) {
    if (e & 1) result = matMul(result, base);
    base = matMul(base, base);
    e >>= 1;
  }
  return result;
}

/**
 * Row-stochastic transition matrix with Laplace smoothing. Rows that never
 * occurred fall back to the uniform neutral layer instead of all-zeros, so no
 * downstream formula is ever multiplied by a structural zero.
 */
export function transitionMatrix(window: number[], alpha = 0.35): number[][] {
  const m: number[][] = Array.from({ length: 10 }, () => new Array(10).fill(0));
  const totals = new Array(10).fill(0);
  for (let i = 0; i < window.length - 1; i++) {
    const a = window[i];
    const b = window[i + 1];
    if (a < 0 || a > 9 || b < 0 || b > 9) continue;
    m[a][b]++;
    totals[a]++;
  }
  for (let a = 0; a < 10; a++) {
    if (totals[a] === 0) {
      for (let b = 0; b < 10; b++) m[a][b] = 0.1;
      continue;
    }
    const denom = totals[a] + alpha * 10;
    for (let b = 0; b < 10; b++) m[a][b] = (m[a][b] + alpha) / denom;
  }
  return m;
}

/** Rows of P^1 .. P^k evaluated from a known starting digit. */
export function stepDistributions(P: number[][], from: number, steps: number): number[][] {
  const out: number[][] = [];
  let row = new Array(10).fill(0);
  if (from >= 0 && from <= 9) row[from] = 1;
  else row = UNIFORM10.slice();
  for (let s = 0; s < steps; s++) {
    const next = new Array(10).fill(0);
    for (let i = 0; i < 10; i++) {
      const w = row[i];
      if (w === 0) continue;
      const Pi = P[i];
      for (let j = 0; j < 10; j++) next[j] += w * Pi[j];
    }
    row = next;
    out.push(row.slice());
  }
  return out;
}

/** Plain re-normalization to sum 1 (guards NaN / all-zero). */
export function normalizeToOne(v: number[]): number[] {
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    if (!Number.isFinite(v[i]) || v[i] < 0) v[i] = 0;
    s += v[i];
  }
  if (s <= 1e-12) return UNIFORM10.slice();
  return v.map((x) => x / s);
}

/**
 * Strict softmax over log-probabilities. Temperature 1 reproduces the exact
 * probability vector; lower temperature sharpens. Always sums to exactly 1.
 */
export function softmaxNormalize(v: number[], temperature = 1): number[] {
  const logs = v.map((x) => Math.log(Math.max(1e-12, Number.isFinite(x) ? x : 0)) / Math.max(0.05, temperature));
  const max = Math.max(...logs);
  const exps = logs.map((l) => Math.exp(l - max));
  let s = 0;
  for (const e of exps) s += e;
  if (!Number.isFinite(s) || s <= 0) return UNIFORM10.slice();
  return exps.map((e) => e / s);
}

/**
 * One-decimal percentages that provably sum to 100.0 — largest-remainder
 * method, residue absorbed by the biggest bucket. Fixes the 104% overflow.
 */
export function percentages10(v: number[]): number[] {
  const p = normalizeToOne(v.slice());
  const scaled = p.map((x) => x * 1000);
  const floors = scaled.map((x) => Math.floor(x));
  let used = floors.reduce((a, b) => a + b, 0);
  const remainders = scaled
    .map((x, i) => ({ i, r: x - Math.floor(x) }))
    .sort((a, b) => b.r - a.r);
  let k = 0;
  while (used < 1000 && k < remainders.length) {
    floors[remainders[k].i]++;
    used++;
    k++;
    if (k === remainders.length && used < 1000) k = 0;
  }
  return floors.map((x) => x / 10);
}

/**
 * Poisson-binomial tail: given per-step hit probabilities across a rolling
 * window, returns tail[N] = P(digit appears at least N times).
 */
export function appearanceTail(stepProbs: number[]): number[] {
  let dist = [1];
  for (const raw of stepProbs) {
    const p = Math.min(0.999, Math.max(0, raw));
    const next = new Array(dist.length + 1).fill(0);
    for (let i = 0; i < dist.length; i++) {
      next[i] += dist[i] * (1 - p);
      next[i + 1] += dist[i] * p;
    }
    dist = next;
  }
  const tail = new Array(dist.length).fill(0);
  let acc = 0;
  for (let i = dist.length - 1; i >= 0; i--) {
    acc += dist[i];
    tail[i] = Math.min(1, acc);
  }
  return tail;
}

/** Rescaled-range Hurst exponent over the trailing window. */
export function hurstExponent(window: number[], size = 24): number {
  const n = Math.min(size, window.length);
  if (n < 8) return 0.5;
  const seg = window.slice(-n);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += seg[i];
  const avg = sum / n;
  let cum = 0;
  let maxDev = 0;
  let minDev = 0;
  let varSum = 0;
  for (let i = 0; i < n; i++) {
    cum += seg[i] - avg;
    if (cum > maxDev) maxDev = cum;
    if (cum < minDev) minDev = cum;
    varSum += (seg[i] - avg) ** 2;
  }
  const range = maxDev - minDev;
  const sd = Math.sqrt(varSum / n) || 1e-4;
  const h = Math.log((range || 1e-4) / sd) / Math.log(n);
  return Number.isFinite(h) ? h : 0.5;
}

/** Pure-randomness band: no exploitable memory -> use the neutral layer. */
export function isRandomWalkBand(h: number): boolean {
  return h >= 0.48 && h <= 0.53;
}

export interface MultiAppearance {
  digit: number;
  /** P(appears at least N times) for N = 0..windowSize */
  tail: number[];
  /** Horizon-step probability from P^h. */
  horizonProb: number;
  /** Highest N (2..7+) still above the confidence floor. */
  bestN: number;
  bestNProb: number;
}

export interface HorizonForecast {
  horizon: 2 | 3;
  windowSize: number;
  /** Softmax-normalized P^h row from the current digit. */
  horizonDist: number[];
  /**
   * Per-tick lookahead rows: index 0 = P¹ (tick 1), index 1 = P² (tick 2),
   * index 2 = P³ (tick 3, 1s indices only). Each row sums to 1.
   */
  stepDists: number[][];
  multi: MultiAppearance[];
  topDigit: number;
  hurst: number;
  neutralFallback: boolean;
}


/**
 * Full horizon forecast: P^h distribution + cumulative multi-appearance
 * probabilities across a rolling 10-tick sliding window.
 */
export function forecastHorizon(
  window: number[],
  symbol: string,
  windowSize = 10,
  minProb = 0.35,
): HorizonForecast {
  const horizon = horizonForSymbol(symbol);
  const h = hurstExponent(window);
  const usable = window.length >= 12;
  const neutralFallback = !usable || isRandomWalkBand(h);

  const P = neutralFallback
    ? Array.from({ length: 10 }, () => UNIFORM10.slice())
    : transitionMatrix(window);
  const from = window.length ? window[window.length - 1] : -1;
  const steps = stepDistributions(P, from, Math.max(windowSize, horizon));
  const horizonRow = steps[horizon - 1] ?? UNIFORM10.slice();
  const horizonDist = neutralFallback ? UNIFORM10.slice() : softmaxNormalize(horizonRow);
  // Per-tick matrix powers: tick1 = P¹, tick2 = P², tick3 = P³ (1s indices).
  const stepDists = Array.from({ length: horizon }, (_, i) =>
    neutralFallback ? UNIFORM10.slice() : normalizeToOne((steps[i] ?? UNIFORM10.slice()).slice()),
  );


  const multi: MultiAppearance[] = [];
  for (let d = 0; d < 10; d++) {
    const stepProbs = steps.slice(0, windowSize).map((r) => r[d]);
    const tail = appearanceTail(stepProbs);
    let bestN = 0;
    let bestNProb = 0;
    for (let N = 7; N >= 2; N--) {
      const p = tail[N] ?? 0;
      if (p >= minProb) {
        bestN = N;
        bestNProb = p;
        break;
      }
    }
    if (bestN === 0) {
      bestN = 2;
      bestNProb = tail[2] ?? 0;
    }
    multi.push({ digit: d, tail, horizonProb: horizonDist[d], bestN, bestNProb });
  }

  let topDigit = 0;
  for (let d = 1; d < 10; d++) {
    const a = multi[d].tail[2] * 0.6 + horizonDist[d] * 0.4;
    const b = multi[topDigit].tail[2] * 0.6 + horizonDist[topDigit] * 0.4;
    if (a > b) topDigit = d;
  }

  return { horizon, windowSize, horizonDist, stepDists, multi, topDigit, hurst: h, neutralFallback };
}
