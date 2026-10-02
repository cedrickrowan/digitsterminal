// Dual-window buffer analysis + Stride-3 execution lattice.
import { transitionMatrix, matPow } from "./matrix";
import { decayPerTick } from "./cadence";

export const FAST_MIN = 30;
export const FAST_MAX = 50;
export const SLOW_MIN = 100;
export const SLOW_MAX = 150;
export const LATTICE_STEPS = [3, 6, 9, 12] as const;

export function fastSize(lookback: number): number {
  return Math.max(FAST_MIN, Math.min(FAST_MAX, lookback));
}

export interface LatticePoint {
  step: number; // t+3, t+6, …
  dist: number[];
  topDigit: number;
  topProb: number;
  role: "entry" | "running";
}

export interface DualBufferReport {
  fastLen: number;
  slowLen: number;
  fastFreq: number[]; // proportions
  slowFreq: number[]; // cadence-decayed empirical baseline
  slowVariance: number; // variance of digit values in slow window
  anomalyZ: number[]; // fast vs slow z-score per digit
  maxAnomalyDigit: number;
  streakDigit: number;
  streakLen: number;
  lattice: LatticePoint[];
}

function freq(win: number[]): number[] {
  const f = new Array(10).fill(0);
  for (const d of win) if (d >= 0 && d <= 9) f[d]++;
  const n = win.length || 1;
  return f.map((c) => c / n);
}

export function analyzeDual(all: number[], lookback: number, symbol: string): DualBufferReport {
  const fast = all.slice(-fastSize(lookback));
  const slow = all.slice(-SLOW_MAX);
  const fastFreq = freq(fast);

  // Slow baseline weighted by a 240s half-life, normalized to cadence.
  const lam = decayPerTick(symbol, 240);
  const w = new Array(10).fill(0);
  let wsum = 0;
  for (let i = 0; i < slow.length; i++) {
    const age = slow.length - 1 - i;
    const k = Math.exp(-lam * age);
    w[slow[i]] += k;
    wsum += k;
  }
  const slowFreq = w.map((x) => (wsum ? x / wsum : 0.1));

  let mean = 0;
  for (const d of slow) mean += d;
  mean /= slow.length || 1;
  let v = 0;
  for (const d of slow) v += (d - mean) * (d - mean);
  const slowVariance = slow.length > 1 ? v / (slow.length - 1) : 0;

  const nF = fast.length || 1;
  const anomalyZ = fastFreq.map((p, i) => {
    const p0 = Math.min(0.99, Math.max(0.01, slowFreq[i]));
    return (p - p0) / Math.sqrt((p0 * (1 - p0)) / nF);
  });
  let maxAnomalyDigit = 0;
  for (let i = 1; i < 10; i++) if (Math.abs(anomalyZ[i]) > Math.abs(anomalyZ[maxAnomalyDigit])) maxAnomalyDigit = i;

  let streakDigit = fast.length ? fast[fast.length - 1] : -1;
  let streakLen = 0;
  for (let i = fast.length - 1; i >= 0 && fast[i] === streakDigit; i--) streakLen++;

  // Stride-3 lattice on the slow-buffer transition matrix (stable baseline).
  const last = all.length ? all[all.length - 1] : -1;
  const lattice: LatticePoint[] = [];
  if (slow.length >= 10 && last >= 0) {
    const P = transitionMatrix(slow, 0.35);
    for (const step of LATTICE_STEPS) {
      const dist = matPow(P, step)[last].slice();
      let top = 0;
      for (let i = 1; i < 10; i++) if (dist[i] > dist[top]) top = i;
      lattice.push({ step, dist, topDigit: top, topProb: dist[top], role: step === 3 ? "entry" : "running" });
    }
  }

  return {
    fastLen: fast.length,
    slowLen: slow.length,
    fastFreq,
    slowFreq,
    slowVariance,
    anomalyZ,
    maxAnomalyDigit,
    streakDigit,
    streakLen,
    lattice,
  };
}
