// Pure statistical helpers. Operate over a number[] window of digits 0-9.

export function frequencies(window: number[]): number[] {
  const f = new Array(10).fill(0);
  for (let i = 0; i < window.length; i++) f[window[i]]++;
  return f;
}

export function chiSquaredUniform(freq: number[], n: number): number {
  if (n === 0) return 0;
  const expected = n / 10;
  let chi = 0;
  for (let i = 0; i < 10; i++) {
    const d = freq[i] - expected;
    chi += (d * d) / expected;
  }
  return chi;
}

// Pearson chi-squared independence on the 10x10 bigram contingency table.
// H0: next digit is independent of previous digit.
export function chiSquaredIndependence(window: number[]): { chi: number; df: number } {
  if (window.length < 12) return { chi: 0, df: 81 };
  const obs: number[][] = Array.from({ length: 10 }, () => new Array(10).fill(0));
  const rowSum = new Array(10).fill(0);
  const colSum = new Array(10).fill(0);
  let total = 0;
  for (let i = 0; i < window.length - 1; i++) {
    const a = window[i],
      b = window[i + 1];
    obs[a][b]++;
    rowSum[a]++;
    colSum[b]++;
    total++;
  }
  let chi = 0;
  for (let a = 0; a < 10; a++) {
    for (let b = 0; b < 10; b++) {
      const exp = (rowSum[a] * colSum[b]) / Math.max(1, total);
      if (exp <= 0) continue;
      const d = obs[a][b] - exp;
      chi += (d * d) / exp;
    }
  }
  return { chi, df: 81 };
}

export function shannonEntropy(freq: number[], n: number): number {
  if (n === 0) return 0;
  let h = 0;
  for (let i = 0; i < 10; i++) {
    if (freq[i] === 0) continue;
    const p = freq[i] / n;
    h -= p * Math.log2(p);
  }
  return h;
}

// Z-score of observed entropy vs ideal uniform max log2(10)≈3.3219.
// Approximate variance of H_hat under uniform: Var ≈ (k-1) / (2 n ln2^2) is rough;
// we use a stable plug-in: z = (H - H_uniform) / sqrt((H_uniform * (1 - H_uniform / log2(10))) / n)
export function entropyZ(h: number, n: number): number {
  if (n < 5) return 0;
  const Hmax = Math.log2(10);
  const se = Math.sqrt(Math.max(1e-9, (Hmax * (1 - h / Hmax)) / n));
  return (h - Hmax) / se;
}

// "Bias index" — total variation distance from uniform, in [0,1].
export function biasIndex(freq: number[], n: number): number {
  if (n === 0) return 0;
  let tv = 0;
  for (let i = 0; i < 10; i++) tv += Math.abs(freq[i] / n - 0.1);
  return tv / 2;
}

export function coldProb(gap: number): number {
  return Math.pow(0.9, gap);
}

export function gapsSinceLast(window: number[]): number[] {
  const gaps = new Array(10).fill(window.length);
  for (let i = window.length - 1, g = 0; i >= 0; i--, g++) {
    const d = window[i];
    if (gaps[d] === window.length) gaps[d] = g;
  }
  return gaps;
}

// 1-step Markov P(next | prev), rows sum to 1.
export function markov1(window: number[]): number[][] {
  const m: number[][] = Array.from({ length: 10 }, () => new Array(10).fill(0));
  const rowTotals = new Array(10).fill(0);
  for (let i = 0; i < window.length - 1; i++) {
    m[window[i]][window[i + 1]]++;
    rowTotals[window[i]]++;
  }
  for (let a = 0; a < 10; a++) {
    if (!rowTotals[a]) continue;
    for (let b = 0; b < 10; b++) m[a][b] /= rowTotals[a];
  }
  return m;
}

// 2-step Markov P(next | a, b). Returns a function lookup to avoid 1000-cell allocation cost.
export function markov2(window: number[]): { dist: (a: number, b: number) => number[]; counts: number } {
  const map = new Map<number, number[]>();
  const totals = new Map<number, number>();
  for (let i = 0; i < window.length - 2; i++) {
    const key = window[i] * 10 + window[i + 1];
    let row = map.get(key);
    if (!row) {
      row = new Array(10).fill(0);
      map.set(key, row);
    }
    row[window[i + 2]]++;
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  return {
    counts: map.size,
    dist: (a: number, b: number) => {
      const key = a * 10 + b;
      const row = map.get(key);
      const t = totals.get(key) ?? 0;
      if (!row || t === 0) return new Array(10).fill(0.1);
      return row.map((c) => c / t);
    },
  };
}

export function twoTickFollowups(
  window: number[],
  a: number,
  b: number,
): { counts: number[]; total: number; probs: number[] } {
  const counts = new Array(10).fill(0);
  let total = 0;
  for (let i = 0; i < window.length - 2; i++) {
    if (window[i] === a && window[i + 1] === b) {
      counts[window[i + 2]]++;
      total++;
    }
  }
  const probs = counts.map((c) => (total ? c / total : 0));
  return { counts, total, probs };
}

// Empirical D-tick sequence follow-up: given the trailing `pattern` digits
// (the last D observations, or as many as exist), tally which digit appears
// D ticks after each historical occurrence of that pattern. This replaces the
// hard-coded 2-tick bigram follow-up so the horizon matches the selected
// contract duration D.
export function sequenceFollowups(
  window: number[],
  pattern: number[],
  d: number,
): { counts: number[]; total: number; probs: number[]; pattern: number[] } {
  const counts = new Array(10).fill(0);
  let total = 0;
  const plen = Math.min(pattern.length, window.length);
  const prefix = plen > 0 ? pattern.slice(-plen) : [];
  if (plen === 0 || d < 1) return { counts, total, probs: counts.map(() => 0), pattern: prefix };
  const offset = plen - 1 + d; // index of the digit D ticks after the pattern
  for (let i = 0; i + offset < window.length; i++) {
    let match = true;
    for (let k = 0; k < plen; k++) {
      if (window[i + k] !== prefix[k]) {
        match = false;
        break;
      }
    }
    if (match) {
      counts[window[i + offset]]++;
      total++;
    }
  }
  const probs = counts.map((c) => (total ? c / total : 0));
  return { counts, total, probs, pattern: prefix };
}

export function tailStreak(window: number[]): { digit: number; len: number } {
  if (window.length === 0) return { digit: -1, len: 0 };
  const d = window[window.length - 1];
  let len = 1;
  for (let i = window.length - 2; i >= 0 && window[i] === d; i--) len++;
  return { digit: d, len };
}

// Even/Odd, High(5-9)/Low(0-4) splits.
export function splitStats(window: number[]) {
  let even = 0,
    high = 0;
  for (let i = 0; i < window.length; i++) {
    if (window[i] % 2 === 0) even++;
    if (window[i] >= 5) high++;
  }
  const n = window.length || 1;
  return {
    even,
    odd: window.length - even,
    high,
    low: window.length - high,
    pEven: even / n,
    pOdd: 1 - even / n,
    pHigh: high / n,
    pLow: 1 - high / n,
  };
}

// Over/Under probability vs a barrier (digit > barrier vs <=)
export function overUnder(freq: number[], n: number, barrier: number) {
  if (n === 0) return { pOver: 0, pUnder: 0 };
  let over = 0;
  for (let i = barrier + 1; i < 10; i++) over += freq[i];
  return { pOver: over / n, pUnder: 1 - over / n };
}

// Rise / Fall direction over last K closes (proxy from digit trend baseline 4.5).
export function riseFall(window: number[], k = 10) {
  if (window.length < 2) return { up: 0, down: 0, lastDelta: 0 };
  const slice = window.slice(-k);
  let up = 0,
    down = 0;
  for (let i = 1; i < slice.length; i++) {
    if (slice[i] > slice[i - 1]) up++;
    else if (slice[i] < slice[i - 1]) down++;
  }
  const lastDelta = slice[slice.length - 1] - slice[slice.length - 2];
  return { up, down, lastDelta };
}

// Hot / Cold over last `n` ticks (default 30).
export function hotCold(window: number[], n = 30) {
  const w = window.slice(-n);
  const f = frequencies(w);
  let hot = 0,
    cold = 0;
  for (let i = 1; i < 10; i++) {
    if (f[i] > f[hot]) hot = i;
    if (f[i] < f[cold]) cold = i;
  }
  return { hot, cold, freq: f, n: w.length };
}

// Top-K bigrams/trigrams by frequency.
export function topNgrams(window: number[], k: 2 | 3, top = 5) {
  const counts = new Map<string, number>();
  for (let i = 0; i <= window.length - k; i++) {
    const key = window.slice(i, i + k).join("");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([pattern, count]) => ({ pattern, count }));
}

// ---- Ensemble + Bayesian fusion --------------------------------------------

// Frequency-reversion: digits below uniform get higher mass.
function freqReversion(freq: number[], n: number): number[] {
  if (n === 0) return new Array(10).fill(0.1);
  const inv = new Array(10);
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const p = freq[i] / n;
    inv[i] = Math.max(0.001, 0.2 - p); // pull-back from uniform
    sum += inv[i];
  }
  return inv.map((v) => v / sum);
}

function normalize(v: number[]): number[] {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i];
  if (s <= 0) return new Array(v.length).fill(1 / v.length);
  return v.map((x) => x / s);
}

export interface Ensemble {
  posterior: number[]; // length 10
  topDigit: number;
  confidence: number; // posterior[top]
  components: {
    freqRev: number[];
    mk1: number[];
    mk2: number[];
    poisson: number[]; // per-digit variance multipliers in (0,1]
  };
  poisson: {
    lookback: number;
    contractTicks: number;
    lambdaPerTick: number[];
    pZero: number[];
    pGtTwo: number[];
    multiplier: number[];
  };
}

// ---- Poisson Distribution Variance Filter ----------------------------------
// Models occurrences of each digit over the upcoming contract window as
// Poisson(λ·T), where λ = recent rate per tick (last `lookback` ticks) and T
// is the contract duration in ticks. Penalize digits whose probability of
// clustering early (X > 2) is high — they tend to be "spent" before the
// terminal tick, producing false signals on the final tick.
function poissonPMF(k: number, mu: number): number {
  if (mu <= 0) return k === 0 ? 1 : 0;
  let logp = -mu + k * Math.log(mu);
  for (let i = 2; i <= k; i++) logp -= Math.log(i);
  return Math.exp(logp);
}

export function poissonVarianceFilter(
  window: number[],
  contractTicks = 4,
  lookback = 50,
): {
  lambdaPerTick: number[];
  pZero: number[];
  pGtTwo: number[];
  multiplier: number[];
} {
  const w = window.slice(-lookback);
  const n = w.length || 1;
  const f = frequencies(w);
  const lambdaPerTick = f.map((c) => c / n);
  const pZero = new Array(10).fill(0);
  const pGtTwo = new Array(10).fill(0);
  const multiplier = new Array(10).fill(1);
  const T = Math.max(1, contractTicks);
  for (let d = 0; d < 10; d++) {
    const mu = lambdaPerTick[d] * T;
    const p0 = poissonPMF(0, mu);
    const p1 = poissonPMF(1, mu);
    const p2 = poissonPMF(2, mu);
    const pGt2 = Math.max(0, 1 - p0 - p1 - p2);
    pZero[d] = p0;
    pGtTwo[d] = pGt2;
    const clusterPenalty = 0.6 * pGt2;
    const droughtAdj = lambdaPerTick[d] > 0.1 ? 0.15 * p0 : 0;
    multiplier[d] = Math.max(0.35, 1 - clusterPenalty - droughtAdj);
  }
  return { lambdaPerTick, pZero, pGtTwo, multiplier };
}

// Ensemble: weighted mix of frequency reversion + Markov 1st + Markov 2nd,
// scaled by the Poisson variance filter as a structural multiplier.
export function ensemblePredict(window: number[], contractTicks = 4): Ensemble {
  const n = window.length;
  const freq = frequencies(window);
  const freqRev = freqReversion(freq, n);
  const mk1m = markov1(window);
  const last = n ? window[n - 1] : 0;
  const prev = n > 1 ? window[n - 2] : last;
  const mk1Row = mk1m[last] && mk1m[last].some((x) => x > 0) ? mk1m[last] : new Array(10).fill(0.1);
  const mk2 = markov2(window).dist(prev, last);

  const eps = 1e-3;
  const fused = new Array(10);
  for (let i = 0; i < 10; i++) {
    const lf = Math.log(freqRev[i] + eps);
    const l1 = Math.log(mk1Row[i] + eps);
    const l2 = Math.log(mk2[i] + eps);
    fused[i] = Math.exp(0.25 * lf + 0.4 * l1 + 0.35 * l2);
  }

  const pois = poissonVarianceFilter(window, contractTicks, 50);
  const scaled = fused.map((v, i) => v * pois.multiplier[i]);
  const posterior = normalize(scaled);

  let topDigit = 0;
  for (let i = 1; i < 10; i++) if (posterior[i] > posterior[topDigit]) topDigit = i;
  return {
    posterior,
    topDigit,
    confidence: posterior[topDigit],
    components: { freqRev, mk1: mk1Row, mk2, poisson: pois.multiplier },
    poisson: {
      lookback: 50,
      contractTicks,
      lambdaPerTick: pois.lambdaPerTick,
      pZero: pois.pZero,
      pGtTwo: pois.pGtTwo,
      multiplier: pois.multiplier,
    },
  };
}
