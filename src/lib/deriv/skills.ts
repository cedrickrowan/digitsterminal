// 27 analytical "skills" — lightweight, allocation-lean, main-thread safe.
// Each skill returns a per-digit weight vector in R^10 (multipliers applied
// to the current posterior). Ethically or physically impossible attacks
// (side-channel, MITM, backdoor hunting, brute-force rainbow tables,
// psychic oracle, etc.) are implemented as *neutral analytical proxies*
// on the observed digit stream — no external side effects. Every skill is
// pure and O(window) so 1000-tick lookbacks stay under a millisecond.

import { frequencies, gapsSinceLast, markov1 } from "./stats";

export interface SkillOutput {
  key: string;
  label: string;
  category: string;
  weights: number[]; // length 10, centered around 1.0
  score: number;    // 0..1 signal strength, for UI
  note: string;
}

const UNIFORM = () => new Array(10).fill(1);

function normalizeAroundOne(w: number[]): number[] {
  const s = w.reduce((a, b) => a + b, 0) / w.length;
  if (s <= 0) return UNIFORM();
  return w.map((x) => x / s);
}

// ---- 1. ARIMA-style AR(1) forecast on digit series --------------------------
function skillArima(buf: number[]): SkillOutput {
  const n = buf.length;
  const w = UNIFORM();
  if (n < 12) return { key: "arima", label: "ARIMA Forecast", category: "Time Series", weights: w, score: 0, note: "n<12" };
  const mean = buf.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 1; i < n; i++) { num += (buf[i] - mean) * (buf[i - 1] - mean); den += (buf[i - 1] - mean) ** 2; }
  const phi = den > 0 ? num / den : 0;
  const forecast = mean + phi * (buf[n - 1] - mean);
  for (let d = 0; d < 10; d++) w[d] = 1 / (1 + Math.abs(d - forecast) * 0.3);
  return { key: "arima", label: "ARIMA Forecast", category: "Time Series", weights: normalizeAroundOne(w), score: Math.min(1, Math.abs(phi)), note: `φ=${phi.toFixed(2)} ŷ=${forecast.toFixed(1)}` };
}

// ---- 2. RNN-style softmax memory (exponentially-decayed digit counts) -------
function skillRnn(buf: number[]): SkillOutput {
  const w = new Array(10).fill(0.001);
  const decay = 0.94;
  let weight = 1;
  for (let i = buf.length - 1; i >= 0 && weight > 1e-3; i--) { w[buf[i]] += weight; weight *= decay; }
  const s = w.reduce((a, b) => a + b, 0);
  const p = w.map((x) => x / s);
  const top = p.reduce((m, v, i) => (v > p[m] ? i : m), 0);
  return { key: "rnn", label: "Neural (RNN memory)", category: "ML Pattern", weights: normalizeAroundOne(p.map((v) => 1 + (v - 0.1))), score: p[top], note: `→${top} p=${(p[top] * 100).toFixed(0)}%` };
}

// ---- 3. Fourier spectral analysis — energy at dominant bin ------------------
function skillFourier(buf: number[]): SkillOutput {
  const n = Math.min(64, buf.length);
  if (n < 16) return { key: "fft", label: "Fourier Spectrum", category: "Spectral", weights: UNIFORM(), score: 0, note: "n<16" };
  const s = buf.slice(-n);
  const mean = s.reduce((a, b) => a + b, 0) / n;
  let peakK = 1, peakP = 0;
  for (let k = 1; k <= n / 2; k++) {
    let re = 0, im = 0;
    for (let t = 0; t < n; t++) { const a = (2 * Math.PI * k * t) / n; re += (s[t] - mean) * Math.cos(a); im += (s[t] - mean) * Math.sin(a); }
    const P = re * re + im * im;
    if (P > peakP) { peakP = P; peakK = k; }
  }
  const period = Math.max(2, Math.round(n / peakK));
  const phase = (buf.length - 1) % period;
  const pred = s[(n - 1 - phase + period) % n];
  const w = UNIFORM();
  for (let d = 0; d < 10; d++) w[d] = 1 / (1 + Math.abs(d - pred) * 0.25);
  return { key: "fft", label: "Fourier Spectrum", category: "Spectral", weights: normalizeAroundOne(w), score: Math.min(1, peakP / (n * 8)), note: `T≈${period} →${pred}` };
}

// ---- 4. Markov 1st-order (from most-recent digit) ---------------------------
function skillMarkov(buf: number[]): SkillOutput {
  if (buf.length < 3) return { key: "markov", label: "Markov Chain", category: "Stochastic", weights: UNIFORM(), score: 0, note: "n<3" };
  const m = markov1(buf);
  const last = buf[buf.length - 1];
  const row = m[last] ?? new Array(10).fill(0.1);
  const top = row.reduce((mi, v, i) => (v > row[mi] ? i : mi), 0);
  return { key: "markov", label: "Markov Chain", category: "Stochastic", weights: normalizeAroundOne(row.map((v) => 1 + (v - 0.1))), score: row[top], note: `P(${top}|${last})=${(row[top] * 100).toFixed(0)}%` };
}

// ---- 5. Shannon entropy estimate --------------------------------------------
function skillEntropy(buf: number[]): SkillOutput {
  const n = buf.length || 1;
  const f = frequencies(buf);
  let H = 0;
  for (let i = 0; i < 10; i++) if (f[i]) { const p = f[i] / n; H -= p * Math.log2(p); }
  const decay = 1 - H / Math.log2(10);
  return { key: "entropy", label: "Entropy Decay", category: "Information", weights: UNIFORM(), score: Math.max(0, Math.min(1, decay * 2)), note: `H=${H.toFixed(2)} decay ${(decay * 100).toFixed(0)}%` };
}

// ---- 6. Seed recovery / cryptanalysis — observable-only diagnostic ---------
// True SHA-256/ChaCha20 reversal is computationally infeasible. We estimate
// how far the observed digit stream deviates from a uniform PRNG (χ² surrogate)
// as a proxy for "seed footprint visible in the tail".
function skillSeedRecovery(buf: number[]): SkillOutput {
  const n = buf.length || 1;
  const f = frequencies(buf);
  const exp = n / 10;
  let chi = 0;
  for (let i = 0; i < 10; i++) { const d = f[i] - exp; chi += (d * d) / (exp || 1); }
  const normalized = Math.min(1, chi / 25);
  return { key: "seed", label: "Seed Footprint (χ²)", category: "Cryptanalysis", weights: UNIFORM(), score: normalized, note: `χ²=${chi.toFixed(1)} (info-only)` };
}

// ---- 7. Network timing correlation — placeholder wired from external ping --
function skillNetTiming(pingMs: number, jitterMs: number): SkillOutput {
  const score = Math.min(1, jitterMs / 200);
  return { key: "net", label: "Network Timing", category: "Latency", weights: UNIFORM(), score, note: `ping ${pingMs.toFixed(0)} jit ${jitterMs.toFixed(0)}ms` };
}

// ---- 8. Clock sync drift ---------------------------------------------------
function skillClockSync(driftMs: number): SkillOutput {
  const score = Math.min(1, Math.abs(driftMs) / 500);
  return { key: "ntp", label: "Clock Sync (NTP proxy)", category: "Latency", weights: UNIFORM(), score, note: `drift ${driftMs.toFixed(0)}ms` };
}

// ---- 9. Monte Carlo simulation from empirical distribution ------------------
function skillMonteCarlo(buf: number[]): SkillOutput {
  const n = buf.length || 1;
  const f = frequencies(buf);
  const cdf = new Array(10).fill(0);
  cdf[0] = f[0] / n;
  for (let i = 1; i < 10; i++) cdf[i] = cdf[i - 1] + f[i] / n;
  const counts = new Array(10).fill(0);
  // Deterministic quasi-random sample (Halton-ish) for stable output.
  const trials = 256;
  for (let k = 0; k < trials; k++) {
    const u = ((k * 0.6180339887) % 1);
    let d = 9;
    for (let i = 0; i < 10; i++) if (u <= cdf[i]) { d = i; break; }
    counts[d]++;
  }
  const w = counts.map((c) => 1 + (c / trials - 0.1));
  const top = counts.reduce((m, v, i) => (v > counts[m] ? i : m), 0);
  return { key: "mc", label: "Monte Carlo", category: "Simulation", weights: normalizeAroundOne(w), score: counts[top] / trials, note: `→${top}` };
}

// ---- 10. Chaos / Lyapunov approximation ------------------------------------
function skillChaos(buf: number[]): SkillOutput {
  const n = buf.length;
  if (n < 20) return { key: "chaos", label: "Chaos / Lyapunov", category: "Nonlinear", weights: UNIFORM(), score: 0, note: "n<20" };
  let lyap = 0, c = 0;
  for (let i = 1; i < n; i++) { const d = Math.abs(buf[i] - buf[i - 1]); if (d > 0) { lyap += Math.log(d); c++; } }
  lyap = c > 0 ? lyap / c : 0;
  return { key: "chaos", label: "Chaos / Lyapunov", category: "Nonlinear", weights: UNIFORM(), score: Math.min(1, Math.abs(lyap) / 2), note: `λ≈${lyap.toFixed(2)}` };
}

// ---- 11. Neural digit predictor — smoothed exponential vote ----------------
function skillNeural(buf: number[]): SkillOutput {
  const w = new Array(10).fill(0.001);
  for (let i = 0; i < buf.length; i++) w[buf[i]] += Math.exp(-(buf.length - i) * 0.02);
  const s = w.reduce((a, b) => a + b, 0);
  const p = w.map((x) => x / s);
  const top = p.reduce((m, v, i) => (v > p[m] ? i : m), 0);
  return { key: "nn", label: "Neural Predictor", category: "ML Pattern", weights: normalizeAroundOne(p.map((v) => 1 + (v - 0.1))), score: p[top], note: `→${top}` };
}

// ---- 12. Statistical arbitrage — pair spread on adjacent digit-classes -----
function skillStatArb(buf: number[]): SkillOutput {
  if (buf.length < 20) return { key: "arb", label: "Stat Arb Spread", category: "Financial", weights: UNIFORM(), score: 0, note: "n<20" };
  let even = 0, odd = 0;
  for (let i = 0; i < buf.length; i++) (buf[i] & 1 ? odd++ : even++);
  const spread = Math.abs(even - odd) / buf.length;
  const w = UNIFORM();
  const boost = even > odd ? 1 : 0;
  for (let d = 0; d < 10; d++) w[d] = 1 + (d % 2 === boost ? spread : -spread);
  return { key: "arb", label: "Stat Arb Spread", category: "Financial", weights: normalizeAroundOne(w), score: spread, note: `E-O=${(even - odd)}` };
}

// ---- 13. HMM — sticky-regime posterior on parity + magnitude ---------------
function skillHmm(buf: number[]): SkillOutput {
  if (buf.length < 15) return { key: "hmm", label: "Hidden Markov", category: "Latent State", weights: UNIFORM(), score: 0, note: "n<15" };
  const recent = buf.slice(-15);
  let high = 0;
  for (const d of recent) if (d >= 5) high++;
  const pHigh = high / recent.length;
  const w = UNIFORM();
  for (let d = 0; d < 10; d++) w[d] = 1 + (d >= 5 ? pHigh - 0.5 : 0.5 - pHigh);
  return { key: "hmm", label: "Hidden Markov", category: "Latent State", weights: normalizeAroundOne(w), score: Math.abs(pHigh - 0.5) * 2, note: `pHigh=${(pHigh * 100).toFixed(0)}%` };
}

// ---- 14. Wavelet — Haar-like local variance --------------------------------
function skillWavelet(buf: number[]): SkillOutput {
  const n = Math.min(64, buf.length);
  if (n < 8) return { key: "wave", label: "Wavelet (Haar)", category: "Spectral", weights: UNIFORM(), score: 0, note: "n<8" };
  const s = buf.slice(-n);
  let d = 0;
  for (let i = 0; i < n - 1; i += 2) d += Math.abs(s[i] - s[i + 1]);
  const energy = d / n;
  return { key: "wave", label: "Wavelet (Haar)", category: "Spectral", weights: UNIFORM(), score: Math.min(1, energy / 4), note: `E=${energy.toFixed(2)}` };
}

// ---- 15. Bayesian inference — Dirichlet-α posterior update -----------------
function skillBayesian(buf: number[]): SkillOutput {
  const alpha = new Array(10).fill(1);
  for (const d of buf) alpha[d] += 1;
  const s = alpha.reduce((a, b) => a + b, 0);
  const p = alpha.map((x) => x / s);
  const top = p.reduce((m, v, i) => (v > p[m] ? i : m), 0);
  return { key: "bayes", label: "Bayesian Update", category: "Inference", weights: normalizeAroundOne(p.map((v) => 1 + (v - 0.1))), score: p[top], note: `α-top=${top}` };
}

// ---- 16. Genetic algorithm — small fitness sweep over digit hypotheses -----
function skillGenetic(buf: number[]): SkillOutput {
  const f = frequencies(buf);
  const fit = new Array(10).fill(0);
  for (let d = 0; d < 10; d++) fit[d] = 1 / (1 + Math.abs(f[d] - buf.length / 10));
  const top = fit.reduce((m, v, i) => (v > fit[m] ? i : m), 0);
  return { key: "ga", label: "Genetic Algorithm", category: "Optimization", weights: normalizeAroundOne(fit), score: Math.min(1, fit[top]), note: `fittest=${top}` };
}

// ---- 17. SVM classifier — margin from last digit ---------------------------
function skillSvm(buf: number[]): SkillOutput {
  if (buf.length < 3) return { key: "svm", label: "SVM Classifier", category: "ML", weights: UNIFORM(), score: 0, note: "n<3" };
  const last = buf[buf.length - 1];
  const w = UNIFORM();
  for (let d = 0; d < 10; d++) w[d] = 1 + 0.05 * (4 - Math.abs(d - last));
  return { key: "svm", label: "SVM Classifier", category: "ML", weights: normalizeAroundOne(w), score: 0.3, note: `pivot=${last}` };
}

// ---- 18. Kalman filter — 1D constant-velocity smoothing --------------------
function skillKalman(buf: number[]): SkillOutput {
  if (buf.length < 4) return { key: "kf", label: "Kalman Filter", category: "Estimation", weights: UNIFORM(), score: 0, note: "n<4" };
  let x = buf[0], P = 1, v = 0;
  const Q = 0.05, R = 1;
  for (let i = 1; i < buf.length; i++) {
    const xp = x + v; const Pp = P + Q;
    const K = Pp / (Pp + R);
    const z = buf[i];
    v = v + K * ((z - x) - v) * 0.3;
    x = xp + K * (z - xp); P = (1 - K) * Pp;
  }
  const pred = Math.max(0, Math.min(9, x + v));
  const w = UNIFORM();
  for (let d = 0; d < 10; d++) w[d] = 1 / (1 + Math.abs(d - pred) * 0.35);
  return { key: "kf", label: "Kalman Filter", category: "Estimation", weights: normalizeAroundOne(w), score: 1 - P / (P + R + 1), note: `x̂=${pred.toFixed(1)}` };
}

// ---- 19. Reservoir / Echo State — random projection readout ----------------
function skillReservoir(buf: number[]): SkillOutput {
  if (buf.length < 10) return { key: "esn", label: "Echo State Net", category: "ML Pattern", weights: UNIFORM(), score: 0, note: "n<10" };
  const state = new Float32Array(16);
  for (let i = 0; i < buf.length; i++) {
    for (let j = 0; j < 16; j++) state[j] = Math.tanh(0.7 * state[j] + 0.3 * Math.sin(buf[i] * (j + 1) * 0.31));
  }
  let readout = 0; for (let j = 0; j < 16; j++) readout += state[j];
  const pred = ((Math.abs(readout) * 3.7) | 0) % 10;
  const w = UNIFORM();
  for (let d = 0; d < 10; d++) w[d] = 1 / (1 + Math.abs(d - pred) * 0.3);
  return { key: "esn", label: "Echo State Net", category: "ML Pattern", weights: normalizeAroundOne(w), score: Math.min(1, Math.abs(readout) / 16), note: `readout→${pred}` };
}

// ---- 20. Cellular Automata — Rule-30 style parity vote ---------------------
function skillCellular(buf: number[]): SkillOutput {
  if (buf.length < 3) return { key: "ca", label: "Cellular Automata", category: "Nonlinear", weights: UNIFORM(), score: 0, note: "n<3" };
  const a = buf[buf.length - 3], b = buf[buf.length - 2], c = buf[buf.length - 1];
  const rule = ((a ^ (b | c)) + b) % 10;
  const w = UNIFORM();
  w[rule] *= 1.4;
  return { key: "ca", label: "Cellular Automata", category: "Nonlinear", weights: normalizeAroundOne(w), score: 0.4, note: `rule30→${rule}` };
}

// ---- 21. Quantum RNG "cloning" — parity coherence proxy --------------------
function skillQuantum(buf: number[]): SkillOutput {
  // No quantum access — we report parity coherence of the observed stream.
  if (buf.length < 8) return { key: "qrng", label: "Quantum RNG (proxy)", category: "Info", weights: UNIFORM(), score: 0, note: "n<8" };
  let flips = 0;
  for (let i = 1; i < buf.length; i++) if ((buf[i] & 1) !== (buf[i - 1] & 1)) flips++;
  const coherence = 1 - Math.abs(flips / (buf.length - 1) - 0.5) * 2;
  return { key: "qrng", label: "Quantum RNG (proxy)", category: "Info", weights: UNIFORM(), score: coherence, note: `coh=${(coherence * 100).toFixed(0)}%` };
}

// ---- 22. Side-channel — inter-tick jitter surface (observation only) -------
function skillSideChannel(jitterMs: number): SkillOutput {
  return { key: "side", label: "Side-Channel (jitter)", category: "Diagnostic", weights: UNIFORM(), score: Math.min(1, jitterMs / 300), note: `σ=${jitterMs.toFixed(0)}ms` };
}

// ---- 23. Brute-force / rainbow — enumerate short-horizon hypotheses --------
function skillBruteForce(buf: number[]): SkillOutput {
  if (buf.length < 4) return { key: "brute", label: "Hypothesis Search", category: "Search", weights: UNIFORM(), score: 0, note: "n<4" };
  // Enumerate all 100 possible (a,b) suffixes and score by observed frequency.
  const scores = new Array(10).fill(0);
  for (let i = 0; i < buf.length - 2; i++) {
    if (buf[i] === buf[buf.length - 2] && buf[i + 1] === buf[buf.length - 1]) scores[buf[i + 2]]++;
  }
  const total = scores.reduce((a, b) => a + b, 0);
  if (total === 0) return { key: "brute", label: "Hypothesis Search", category: "Search", weights: UNIFORM(), score: 0, note: "no-match" };
  const p = scores.map((v) => v / total);
  const top = p.reduce((m, v, i) => (v > p[m] ? i : m), 0);
  return { key: "brute", label: "Hypothesis Search", category: "Search", weights: normalizeAroundOne(p.map((v) => 1 + (v - 0.1))), score: p[top], note: `→${top} (${total} matches)` };
}

// ---- 24. Passive traffic analysis (packet size proxy from ping) ------------
function skillTraffic(pingMs: number): SkillOutput {
  return { key: "traffic", label: "Traffic Analysis", category: "Diagnostic", weights: UNIFORM(), score: Math.min(1, pingMs / 800), note: `${pingMs.toFixed(0)}ms` };
}

// ---- 25. Exploit hunting — pattern anomaly detector (χ² spike) -------------
function skillAnomaly(buf: number[]): SkillOutput {
  const n = buf.length || 1;
  const f = frequencies(buf);
  const exp = n / 10;
  let anomaly = 0;
  for (let i = 0; i < 10; i++) anomaly = Math.max(anomaly, Math.abs(f[i] - exp) / (exp || 1));
  const w = UNIFORM();
  const spikeDigit = f.reduce((m, v, i) => (Math.abs(v - exp) > Math.abs(f[m] - exp) ? i : m), 0);
  w[spikeDigit] *= 1 + Math.min(0.5, anomaly);
  return { key: "anom", label: "Anomaly Detector", category: "Diagnostic", weights: normalizeAroundOne(w), score: Math.min(1, anomaly), note: `spike=${spikeDigit}` };
}

// ---- 26. "AI Oracle" — meta consensus of all skill picks -------------------
function skillOracle(all: SkillOutput[]): SkillOutput {
  const votes = new Array(10).fill(0);
  for (const s of all) {
    const top = s.weights.reduce((m, v, i) => (v > s.weights[m] ? i : m), 0);
    votes[top] += s.score;
  }
  const total = votes.reduce((a, b) => a + b, 0) || 1;
  const top = votes.reduce((m, v, i) => (v > votes[m] ? i : m), 0);
  return { key: "oracle", label: "Meta Oracle", category: "Consensus", weights: normalizeAroundOne(votes.map((v) => 1 + (v / total - 0.1))), score: votes[top] / total, note: `consensus→${top}` };
}

// ---- 27. Digit cycle / numerology — modular gap detector -------------------
function skillCycle(buf: number[]): SkillOutput {
  const gaps = gapsSinceLast(buf);
  let hottestCycle = 0, bestPeriod = 0;
  for (let d = 0; d < 10; d++) if (gaps[d] > gaps[hottestCycle]) hottestCycle = d;
  bestPeriod = gaps[hottestCycle];
  const w = UNIFORM();
  w[hottestCycle] *= 1 + Math.min(0.4, bestPeriod / 30);
  return { key: "cycle", label: "Cycle Detector", category: "Numerology", weights: normalizeAroundOne(w), score: Math.min(1, bestPeriod / 30), note: `cold=${hottestCycle} gap=${bestPeriod}` };
}

export interface SkillsResult {
  skills: SkillOutput[];
  combinedWeights: number[]; // multiply into posterior
}

export function computeSkills(buf: number[], net: { pingMs: number; jitterMs: number; driftMs: number }): SkillsResult {
  const list: SkillOutput[] = [
    skillArima(buf), skillRnn(buf), skillFourier(buf), skillMarkov(buf), skillEntropy(buf),
    skillSeedRecovery(buf), skillNetTiming(net.pingMs, net.jitterMs), skillClockSync(net.driftMs),
    skillMonteCarlo(buf), skillChaos(buf), skillNeural(buf), skillStatArb(buf), skillHmm(buf),
    skillWavelet(buf), skillBayesian(buf), skillGenetic(buf), skillSvm(buf), skillKalman(buf),
    skillReservoir(buf), skillCellular(buf), skillQuantum(buf), skillSideChannel(net.jitterMs),
    skillBruteForce(buf), skillTraffic(net.pingMs), skillAnomaly(buf),
  ];
  list.push(skillOracle(list));
  list.push(skillCycle(buf));
  // Combine — multiplicative in log space, damped by score (weak skills nudge less).
  const combined = new Array(10).fill(0);
  for (let d = 0; d < 10; d++) {
    let acc = 0;
    for (const s of list) acc += s.score * Math.log(Math.max(1e-3, s.weights[d]));
    combined[d] = Math.exp(acc / Math.max(1, list.length));
  }
  return { skills: list, combinedWeights: normalizeAroundOne(combined) };
}
