// Calibrated per-market engines (Step 5). Pure functions — no side effects.
//   1. Matches   : Dirichlet-Multinomial posterior, flat prior α0 = 1, cadence-normalized decay
//   2. Even/Odd  : Wald-Wolfowitz runs test + Bernoulli CUSUM + lag-3 parity autocorrelation
//   3. Over/Under: ECDF with DKW bounds + fast/slow two-sample KS + three-way barrier hazard
//   4. Rise/Fall : Kalman price velocity + DFA drift on stride-3 samples (prices only)
//   5. Consensus : Matches candidate must agree with the parity and barrier regimes
import { decayPerTick } from "./cadence";

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

// ---------------------------------------------------------------- 1. MATCHES
export const DIRICHLET_ALPHA0 = 1.0;
export const DIRICHLET_HALF_LIFE_SEC = 60;

export interface DirichletResult {
  posterior: number[]; // posterior mean, sums to 1
  alpha: number[]; // posterior concentration per digit
  total: number;
  lambdaPerTick: number;
  effectiveN: number;
  topDigit: number;
  topProb: number;
  /** 90% marginal credible half-width for the top digit (Beta marginal). */
  topHalfWidth: number;
}

export function dirichletMatches(window: number[], symbol: string): DirichletResult {
  const lam = decayPerTick(symbol, DIRICHLET_HALF_LIFE_SEC);
  const alpha = new Array(10).fill(DIRICHLET_ALPHA0);
  let effectiveN = 0;
  for (let i = 0; i < window.length; i++) {
    const d = window[i];
    if (d < 0 || d > 9) continue;
    const w = Math.exp(-lam * (window.length - 1 - i));
    alpha[d] += w;
    effectiveN += w;
  }
  const total = alpha.reduce((a, b) => a + b, 0);
  const posterior = alpha.map((a) => a / total);
  let top = 0;
  for (let i = 1; i < 10; i++) if (posterior[i] > posterior[top]) top = i;
  const a = alpha[top];
  const b = total - a;
  const varTop = (a * b) / (total * total * (total + 1));
  return {
    posterior,
    alpha,
    total,
    lambdaPerTick: lam,
    effectiveN,
    topDigit: top,
    topProb: posterior[top],
    topHalfWidth: 1.645 * Math.sqrt(varTop),
  };
}

// --------------------------------------------------------------- 2. EVEN/ODD
export type ParityRegime = "EVEN" | "ODD" | "NEUTRAL";

export interface ParityResult {
  regime: ParityRegime;
  confidence: number; // 0.5..1
  pEven: number;
  runsZ: number; // <0 clustering, >0 alternating
  runsRegime: "CLUSTERING" | "ALTERNATING" | "RANDOM";
  cusumEven: number;
  cusumOdd: number;
  cusumAlarm: ParityRegime;
  lag3: number; // autocorrelation of ±1 parity at lag 3
  detail: string;
}

const CUSUM_P1 = 0.6; // shift alternative (60/40)
const CUSUM_H = 2.5; // decision threshold (log-likelihood units)

export function parityEngine(window: number[]): ParityResult {
  const x = window.filter((d) => d >= 0 && d <= 9).map((d) => (d % 2 === 0 ? 1 : 0));
  const n = x.length;
  const n1 = x.reduce((a, b) => a + b, 0);
  const n0 = n - n1;
  const pEven = n ? n1 / n : 0.5;

  // Wald-Wolfowitz runs test.
  let runs = n ? 1 : 0;
  for (let i = 1; i < n; i++) if (x[i] !== x[i - 1]) runs++;
  let runsZ = 0;
  if (n1 > 0 && n0 > 0 && n > 2) {
    const mu = (2 * n1 * n0) / n + 1;
    const v = (2 * n1 * n0 * (2 * n1 * n0 - n)) / (n * n * (n - 1));
    runsZ = v > 0 ? (runs - mu) / Math.sqrt(v) : 0;
  }
  const runsRegime = runsZ < -1.96 ? "CLUSTERING" : runsZ > 1.96 ? "ALTERNATING" : "RANDOM";

  // Bernoulli CUSUM (two-sided).
  const incE1 = Math.log(CUSUM_P1 / 0.5);
  const incE0 = Math.log((1 - CUSUM_P1) / 0.5);
  let sE = 0;
  let sO = 0;
  for (const b of x) {
    sE = Math.max(0, sE + (b ? incE1 : incE0));
    sO = Math.max(0, sO + (b ? incE0 : incE1));
  }
  const cusumAlarm: ParityRegime = sE > CUSUM_H && sE >= sO ? "EVEN" : sO > CUSUM_H ? "ODD" : "NEUTRAL";

  // Lag-3 autocorrelation on ±1 series.
  let lag3 = 0;
  if (n > 6) {
    const s = x.map((b) => (b ? 1 : -1));
    const m = s.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) den += (s[i] - m) * (s[i] - m);
    for (let i = 3; i < n; i++) num += (s[i] - m) * (s[i - 3] - m);
    lag3 = den > 0 ? num / den : 0;
  }

  // Vote: + = EVEN, - = ODD.
  let vote = 0;
  vote += clamp((pEven - 0.5) * 6, -1, 1); // bias
  if (cusumAlarm === "EVEN") vote += 1;
  else if (cusumAlarm === "ODD") vote -= 1;
  const lastP = n ? (x[n - 1] ? 1 : -1) : 0;
  if (runsRegime === "CLUSTERING") vote += 0.5 * lastP; // runs continue
  else if (runsRegime === "ALTERNATING") vote -= 0.5 * lastP; // flips
  // Stride-3: parity at t+3 echoes parity at t when lag-3 correlation is positive.
  const p3 = n >= 3 ? (x[n - 3] ? 1 : -1) : 0;
  if (Math.abs(lag3) > 0.1) vote += clamp(lag3 * 3, -1, 1) * p3 * 0.5;

  const regime: ParityRegime = vote >= 0.75 ? "EVEN" : vote <= -0.75 ? "ODD" : "NEUTRAL";
  const confidence = clamp(0.5 + Math.abs(vote) * 0.08, 0.5, 0.75);
  return {
    regime,
    confidence,
    pEven,
    runsZ,
    runsRegime,
    cusumEven: sE,
    cusumOdd: sO,
    cusumAlarm,
    lag3,
    detail: `runs z ${runsZ.toFixed(2)} ${runsRegime.toLowerCase()} · CUSUM E${sE.toFixed(1)}/O${sO.toFixed(1)} · ρ3 ${lag3.toFixed(2)}`,
  };
}

// ------------------------------------------------------------- 3. OVER/UNDER
export type BarrierDir = "OVER" | "UNDER" | "NEUTRAL";

export interface BarrierResult {
  barrier: number;
  pUnder: number;
  pEqual: number;
  pOver: number;
  dkwEps: number;
  ksD: number;
  ksCrit: number;
  ksShift: boolean;
  direction: BarrierDir;
  confidence: number;
  hazard: boolean;
  detail: string;
}

function ecdf(win: number[]): number[] {
  const c = new Array(10).fill(0);
  for (const d of win) if (d >= 0 && d <= 9) c[d]++;
  const n = win.length || 1;
  const F = new Array(10);
  let acc = 0;
  for (let i = 0; i < 10; i++) {
    acc += c[i];
    F[i] = acc / n;
  }
  return F;
}

/** Equality hazard: P(digit == barrier) this much above the 10% fair rate. */
export const BARRIER_HAZARD_P = 0.13;

export function barrierEngine(
  fast: number[],
  slow: number[],
  barrier: number,
  calibrated: number[],
): BarrierResult {
  const Ff = ecdf(fast);
  const Fs = ecdf(slow);
  const n = slow.length || 1;
  const m = fast.length || 1;
  const dkwEps = Math.sqrt(Math.log(2 / 0.05) / (2 * n));

  // Two-sample KS (fast vs slow).
  let ksD = 0;
  for (let i = 0; i < 10; i++) ksD = Math.max(ksD, Math.abs(Ff[i] - Fs[i]));
  const ksCrit = 1.36 * Math.sqrt((n + m) / (n * m));
  const ksShift = ksD > ksCrit;

  // Three-way probabilities from the calibrated Dirichlet posterior.
  let pUnder = 0;
  let pOver = 0;
  for (let i = 0; i < 10; i++) {
    if (i < barrier) pUnder += calibrated[i];
    else if (i > barrier) pOver += calibrated[i];
  }
  const pEqual = calibrated[barrier] ?? 0;

  // Fair split for this barrier (uniform digits).
  const fairOver = (9 - barrier) / 10;
  const fairUnder = barrier / 10;
  const sUnder = barrier > 0 ? Fs[barrier - 1] : 0; // ECDF P(d < barrier)
  const sOver = 1 - Fs[barrier];
  const fUnder = barrier > 0 ? Ff[barrier - 1] : 0;
  const fOver = 1 - Ff[barrier];

  // DKW: slow ECDF must clear fair rate by ε, or KS must confirm a fast shift.
  let direction: BarrierDir = "NEUTRAL";
  if (sOver - dkwEps > fairOver || (ksShift && fOver > sOver && pOver > fairOver)) direction = "OVER";
  else if (sUnder - dkwEps > fairUnder || (ksShift && fUnder > sUnder && pUnder > fairUnder))
    direction = "UNDER";
  if (direction === "NEUTRAL" && pOver - pUnder > 0.08) direction = "OVER";
  else if (direction === "NEUTRAL" && pUnder - pOver > 0.08) direction = "UNDER";

  const hazard = pEqual >= BARRIER_HAZARD_P;
  const confidence = direction === "OVER" ? pOver : direction === "UNDER" ? pUnder : Math.max(pOver, pUnder);
  return {
    barrier,
    pUnder,
    pEqual,
    pOver,
    dkwEps,
    ksD,
    ksCrit,
    ksShift,
    direction,
    confidence,
    hazard,
    detail: `U ${(pUnder * 100).toFixed(1)} · =${barrier} ${(pEqual * 100).toFixed(1)} · O ${(pOver * 100).toFixed(1)} · DKW ±${(dkwEps * 100).toFixed(1)} · KS ${ksD.toFixed(2)}/${ksCrit.toFixed(2)}`,
  };
}

// --------------------------------------------------------------- 4. RISE/FALL
export type RiseFallSignal = "RISE" | "FALL" | "HOLD";

export interface RiseFallResult {
  signal: RiseFallSignal;
  velocity: number; // Kalman velocity per stride
  velocityZ: number;
  dfaAlpha: number; // >0.5 persistent, <0.5 anti-persistent
  samples: number;
  confidence: number;
  detail: string;
}

function dfaAlpha(inc: number[]): number {
  const n = inc.length;
  if (n < 12) return 0.5;
  const mean = inc.reduce((a, b) => a + b, 0) / n;
  const y: number[] = [];
  let acc = 0;
  for (const v of inc) {
    acc += v - mean;
    y.push(acc);
  }
  const pts: Array<[number, number]> = [];
  for (const s of [4, 6, 8, 12, 16]) {
    if (s * 2 > n) continue;
    const boxes = Math.floor(n / s);
    let f2 = 0;
    for (let b = 0; b < boxes; b++) {
      // Linear detrend inside the box.
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (let i = 0; i < s; i++) {
        const yy = y[b * s + i];
        sx += i; sy += yy; sxx += i * i; sxy += i * yy;
      }
      const slope = (s * sxy - sx * sy) / (s * sxx - sx * sx || 1);
      const icpt = (sy - slope * sx) / s;
      for (let i = 0; i < s; i++) {
        const r = y[b * s + i] - (icpt + slope * i);
        f2 += r * r;
      }
    }
    const F = Math.sqrt(f2 / (boxes * s));
    if (F > 0) pts.push([Math.log(s), Math.log(F)]);
  }
  if (pts.length < 2) return 0.5;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [a, b] of pts) { sx += a; sy += b; sxx += a * a; sxy += a * b; }
  const k = pts.length;
  return (k * sxy - sx * sy) / (k * sxx - sx * sx || 1);
}

export function riseFallEngine(prices: number[]): RiseFallResult {
  // Stride-3 sampling: one observation per 3 ticks (contract landing lattice).
  const s: number[] = [];
  for (let i = prices.length - 1; i >= 0; i -= 3) s.unshift(prices[i]);
  const samples = s.length;
  if (samples < 8) {
    return { signal: "HOLD", velocity: 0, velocityZ: 0, dfaAlpha: 0.5, samples, confidence: 0.5, detail: "warming up" };
  }
  const inc: number[] = [];
  for (let i = 1; i < samples; i++) inc.push(s[i] - s[i - 1]);
  const im = inc.reduce((a, b) => a + b, 0) / inc.length;
  const iv = inc.reduce((a, b) => a + (b - im) * (b - im), 0) / Math.max(1, inc.length - 1);
  const isd = Math.sqrt(iv) || 1e-9;

  // Constant-velocity Kalman filter: state [x, v].
  const q = iv * 0.05; // process noise on velocity
  const r = iv * 0.5; // measurement noise
  let x = s[0], v = 0;
  let p00 = iv, p01 = 0, p11 = iv;
  for (let i = 1; i < samples; i++) {
    // predict
    x = x + v;
    const n00 = p00 + 2 * p01 + p11;
    const n01 = p01 + p11;
    const n11 = p11 + q;
    // update
    const sInn = n00 + r;
    const k0 = n00 / sInn;
    const k1 = n01 / sInn;
    const inn = s[i] - x;
    x += k0 * inn;
    v += k1 * inn;
    p00 = (1 - k0) * n00;
    p01 = (1 - k0) * n01;
    p11 = n11 - k1 * n01;
  }
  const velocityZ = (v / isd) * Math.sqrt(samples);
  const alpha = dfaAlpha(inc);

  // Requires a velocity edge AND non-anti-persistent drift (DFA α ≥ 0.5).
  let signal: RiseFallSignal = "HOLD";
  if (alpha >= 0.5 && velocityZ > 1.0) signal = "RISE";
  else if (alpha >= 0.5 && velocityZ < -1.0) signal = "FALL";
  const confidence = signal === "HOLD" ? 0.5 : clamp(0.5 + Math.abs(velocityZ) * 0.05 + (alpha - 0.5) * 0.2, 0.5, 0.8);
  return {
    signal,
    velocity: v,
    velocityZ,
    dfaAlpha: alpha,
    samples,
    confidence,
    detail: `Kalman v ${v.toExponential(2)} (z ${velocityZ.toFixed(2)}) · DFA α ${alpha.toFixed(2)} · n ${samples}`,
  };
}

// --------------------------------------------------------------- 5. CONSENSUS
export interface ConsensusResult {
  candidate: number;
  parityOk: boolean;
  barrierOk: boolean;
  conflict: boolean;
}

/** NEUTRAL regimes never conflict; an active regime must agree with the digit. */
export function matchesConsensus(
  candidate: number,
  parity: ParityResult,
  bar: BarrierResult,
): ConsensusResult {
  const even = candidate % 2 === 0;
  const parityOk = parity.regime === "NEUTRAL" || (parity.regime === "EVEN") === even;
  const barrierOk =
    bar.direction === "NEUTRAL" ||
    (bar.direction === "OVER" && candidate > bar.barrier) ||
    (bar.direction === "UNDER" && candidate < bar.barrier);
  return { candidate, parityOk, barrierOk, conflict: !parityOk || !barrierOk };
}
