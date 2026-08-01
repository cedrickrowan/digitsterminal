// ============================================================================
// SUPER QUANT CORE — unified advanced mathematics & chaos-physics engine.
// Pure functions, allocation-lean, designed to complete in < 2ms on a
// low-spec mobile CPU (all loops bounded, no closures allocated per digit).
//
// Formulas implemented:
//   1. Lyapunov exponent            — chaos trajectory divergence
//   2. Hurst exponent (R/S)         — trend persistence / mean reversion
//   3. 1st + 2nd order Markov       — conditional transition channels
//   4. Fourier spectral harmonics   — cyclical wave synchronization
//   5. Kolmogorov–Smirnov test      — max CDF divergence from uniform
//   6. Autoregressive Poisson       — exponentially-decayed arrival intensity
// Additional (added for accuracy, not in the original draft):
//   7. Shannon entropy + surprisal  — information content weighting
//   8. Lag-1..3 autocorrelation     — serial dependence detection
//   9. Runs test Z-score            — randomness / streak structure
//  10. Laplace-smoothed χ² residual — bounded frequency-reversion tilt
// ============================================================================

export interface SuperQuantAnalysis {
  digit: number;
  accuracyScore: number; // 0 – 99.9
  probability: number; // normalized 0..1 posterior
  isQuantumTarget: boolean;
  isExhausted: boolean;
}

export interface SuperQuantDiagnostics {
  lyapunov: number;
  hurst: number;
  harmonic: number;
  ksDivergence: number;
  entropy: number;
  autocorr: number;
  runsZ: number;
  chi2: number;
  ordered: boolean;
  persistent: boolean;
  synchronized: boolean;
  anomalous: boolean;
  samples: number;
}

export interface SuperQuantResult {
  digits: SuperQuantAnalysis[];
  posterior: number[]; // length 10, sums to 1
  topDigit: number;
  topScore: number;
  diagnostics: SuperQuantDiagnostics;
  calcMs: number;
}

const EMPTY_DIAG: SuperQuantDiagnostics = {
  lyapunov: 0,
  hurst: 0.5,
  harmonic: 0,
  ksDivergence: 0,
  entropy: Math.log2(10),
  autocorr: 0,
  runsZ: 0,
  chi2: 0,
  ordered: false,
  persistent: false,
  synchronized: false,
  anomalous: false,
  samples: 0,
};

function neutral(calcMs: number): SuperQuantResult {
  const digits: SuperQuantAnalysis[] = new Array(10);
  for (let i = 0; i < 10; i++) {
    digits[i] = {
      digit: i,
      accuracyScore: 10,
      probability: 0.1,
      isQuantumTarget: false,
      isExhausted: false,
    };
  }
  return {
    digits,
    posterior: new Array(10).fill(0.1),
    topDigit: 0,
    topScore: 10,
    diagnostics: { ...EMPTY_DIAG },
    calcMs,
  };
}

export function runSuperQuantAnalysis(
  ticksBuffer: number[],
  deltasBuffer: number[],
  horizonTicks: number,
): SuperQuantResult {
  const t0 = performance.now();
  const len = ticksBuffer.length;
  // Guard: below 32 samples nothing here is statistically meaningful.
  if (len < 32) return neutral(performance.now() - t0);

  const lastDigit = ticksBuffer[len - 1];
  const penultDigit = ticksBuffer[len - 2];

  // ---- 1. LYAPUNOV EXPONENT ------------------------------------------------
  // Mean log divergence between consecutive trajectory separations. A low
  // exponent means the stream is locally ordered (predictable), a high one
  // means chaotic expansion.
  let lyapunovSum = 0;
  let trajectories = 0;
  const lyaWindow = Math.min(15, len - 1);
  for (let i = 1; i <= lyaWindow; i++) {
    const diff = Math.abs(ticksBuffer[len - i] - ticksBuffer[len - i - 1]);
    const safeDiff = diff === 0 ? 0.0001 : diff; // avoid log(0) freeze
    lyapunovSum += Math.log(safeDiff);
    trajectories++;
  }
  const lyapunov = trajectories > 0 ? lyapunovSum / trajectories : 1;
  const ordered = lyapunov < 0.9;

  // ---- 2. HURST EXPONENT (rescaled range) ---------------------------------
  const hurstSize = Math.min(16, len);
  let sumH = 0;
  for (let i = len - hurstSize; i < len; i++) sumH += ticksBuffer[i];
  const avgH = sumH / hurstSize;
  let cum = 0;
  let maxDev = 0;
  let minDev = 0;
  let varSum = 0;
  for (let i = len - hurstSize; i < len; i++) {
    const dev = ticksBuffer[i] - avgH;
    cum += dev;
    if (cum > maxDev) maxDev = cum;
    if (cum < minDev) minDev = cum;
    varSum += dev * dev;
  }
  const range = maxDev - minDev;
  const stDev = Math.sqrt(varSum / hurstSize) || 0.0001;
  const hurst = Math.log((range || 0.0001) / stDev) / Math.log(hurstSize);
  const persistent = hurst > 0.52;

  // ---- 3. MARKOV CHANNELS (1st + 2nd order) --------------------------------
  const markov1 = new Array<number>(10).fill(0);
  const markov2 = new Array<number>(10).fill(0);
  let total1 = 0;
  let total2 = 0;
  for (let i = 2; i < len; i++) {
    if (ticksBuffer[i - 1] === lastDigit) {
      markov1[ticksBuffer[i]]++;
      total1++;
      if (ticksBuffer[i - 2] === penultDigit) {
        markov2[ticksBuffer[i]]++;
        total2++;
      }
    }
  }

  // ---- 4. FOURIER SPECTRAL HARMONICS --------------------------------------
  // Discrete correlation of |Δprice| against a period-4 cosine basis plus a
  // period-8 companion; captures the dominant micro-cycle energy.
  let harmonic = 0;
  let harmonic8 = 0;
  const traceWindow = Math.min(16, deltasBuffer.length);
  const startDelta = deltasBuffer.length - traceWindow;
  for (let i = 0; i < traceWindow; i++) {
    const mag = Math.abs(deltasBuffer[startDelta + i]);
    harmonic += mag * Math.cos((2 * Math.PI * i) / 4);
    harmonic8 += mag * Math.cos((2 * Math.PI * i) / 8);
  }
  const synchronized = harmonic > 0.04 || harmonic8 > 0.04;

  // ---- 5. KOLMOGOROV–SMIRNOV UNIFORMITY TEST ------------------------------
  const ksSize = Math.min(20, len);
  const ksCounts = new Array<number>(10).fill(0);
  for (let i = len - ksSize; i < len; i++) ksCounts[ticksBuffer[i]]++;
  let ksDivergence = 0;
  let cdf = 0;
  for (let d = 0; d < 10; d++) {
    cdf += ksCounts[d] / ksSize;
    const div = Math.abs(cdf - (d + 1) / 10);
    if (div > ksDivergence) ksDivergence = div;
  }
  const anomalous = ksDivergence > 0.16;

  // ---- 6. AUTOREGRESSIVE POISSON DENSITY ----------------------------------
  // Exponentially decayed arrival intensity; recent occurrences dominate.
  const decay = 0.28;
  const poisson = new Array<number>(10).fill(0.1);
  // Only the last ~64 ticks contribute meaningfully (exp(-0.28*64) ≈ 1.7e-8),
  // which keeps this O(64) instead of O(len*10).
  const poissonStart = Math.max(0, len - 64);
  for (let i = poissonStart; i < len; i++) {
    poisson[ticksBuffer[i]] += Math.exp(-decay * (len - 1 - i));
  }

  // ---- 7. SHANNON ENTROPY + SURPRISAL -------------------------------------
  const winSize = Math.min(50, len);
  const counts = new Array<number>(10).fill(0);
  for (let i = len - winSize; i < len; i++) counts[ticksBuffer[i]]++;
  let entropy = 0;
  for (let d = 0; d < 10; d++) {
    if (counts[d] === 0) continue;
    const p = counts[d] / winSize;
    entropy -= p * Math.log2(p);
  }

  // ---- 8. AUTOCORRELATION (lags 1-3) --------------------------------------
  let mean = 0;
  for (let i = len - winSize; i < len; i++) mean += ticksBuffer[i];
  mean /= winSize;
  let denom = 0;
  for (let i = len - winSize; i < len; i++) {
    const g = ticksBuffer[i] - mean;
    denom += g * g;
  }
  denom = denom || 1e-9;
  let autocorr = 0;
  for (let lag = 1; lag <= 3; lag++) {
    let num = 0;
    for (let i = len - winSize + lag; i < len; i++) {
      num += (ticksBuffer[i] - mean) * (ticksBuffer[i - lag] - mean);
    }
    autocorr += num / denom;
  }
  autocorr /= 3;

  // ---- 9. RUNS TEST Z-SCORE (randomness of high/low sequence) -------------
  let runs = 1;
  let nHigh = 0;
  let nLow = 0;
  for (let i = len - winSize; i < len; i++) {
    const hi = ticksBuffer[i] >= 5;
    if (hi) nHigh++;
    else nLow++;
    if (i > len - winSize && hi !== ticksBuffer[i - 1] >= 5) runs++;
  }
  let runsZ = 0;
  if (nHigh > 0 && nLow > 0) {
    const n = nHigh + nLow;
    const expected = (2 * nHigh * nLow) / n + 1;
    const variance =
      (2 * nHigh * nLow * (2 * nHigh * nLow - n)) / (n * n * (n - 1) || 1);
    runsZ = variance > 0 ? (runs - expected) / Math.sqrt(variance) : 0;
  }

  // ---- 10. χ² RESIDUAL (Laplace-smoothed frequency reversion) -------------
  const expectedCount = winSize / 10;
  let chi2 = 0;
  const residual = new Array<number>(10);
  for (let d = 0; d < 10; d++) {
    const diff = counts[d] - expectedCount;
    chi2 += (diff * diff) / (expectedCount || 1);
    // negative residual (under-represented) → positive reversion tilt
    residual[d] = -diff / Math.max(1, Math.sqrt(expectedCount));
  }

  // ==== UNIFIED PREDICTIVE MAPPING LAYER ===================================
  const digits: SuperQuantAnalysis[] = new Array(10);
  const raw = new Array<number>(10);
  let top = 0;

  for (let d = 0; d < 10; d++) {
    let score = poisson[d] * 15;

    if (horizonTicks <= 1) {
      if (total1 > 0) score += (markov1[d] / total1) * 55;
      if (ordered && d !== lastDigit) score += 15;
    } else if (horizonTicks === 2) {
      if (total2 > 0) score += (markov2[d] / total2) * 60;
      else if (total1 > 0) score += (markov1[d] / total1) * 45;
      if (synchronized && d === lastDigit) score += 20;
    } else {
      if (total2 > 0) score += (markov2[d] / total2) * 45;
      else if (total1 > 0) score += (markov1[d] / total1) * 35;
      if (persistent && d === lastDigit) score += 25;
      // Original draft referenced an undefined `markovTensor`; the intended
      // check is the 2nd-order channel count for this digit.
      if (anomalous && markov2[d] > 1) score += 15;
    }

    // Extra structural terms
    score += residual[d] * 4; // frequency reversion
    if (anomalous) score += ksDivergence * 20 * (counts[d] < expectedCount ? 1 : -1);
    // Entropy weighting: the flatter the stream, the less we trust structure.
    const entropyTrust = 1 + (Math.log2(10) - entropy) * 0.25;
    score *= entropyTrust;
    // Serial dependence: strong positive autocorrelation favours continuation.
    if (autocorr > 0.15 && d === lastDigit) score += 8;
    if (autocorr < -0.15 && d !== lastDigit) score += 4;
    // Runs structure: heavy streaking (negative Z) tilts toward the opposite half.
    if (runsZ < -1.5) score += (lastDigit >= 5 ? (d < 5 ? 5 : 0) : d >= 5 ? 5 : 0);

    // Micro-fatigue tracker — prevents late streak-chasing.
    let micro = 0;
    const scanDepth = Math.min(6, len);
    for (let i = len - scanDepth; i < len; i++) if (ticksBuffer[i] === d) micro++;

    const isExhausted = micro >= 3;
    const isQuantumTarget = micro >= 1 && micro < 3 && score > 42 && ordered;
    const finalScore = isExhausted ? score * 0.01 : score;
    const bounded = Math.max(0, Math.min(99.9, Math.round(finalScore * 10) / 10));

    raw[d] = Math.max(0.01, bounded);
    digits[d] = {
      digit: d,
      accuracyScore: bounded,
      probability: 0, // filled after normalization
      isQuantumTarget,
      isExhausted,
    };
    if (bounded > digits[top].accuracyScore) top = d;
  }

  let sum = 0;
  for (let d = 0; d < 10; d++) sum += raw[d];
  const posterior = new Array<number>(10);
  for (let d = 0; d < 10; d++) {
    posterior[d] = sum > 0 ? raw[d] / sum : 0.1;
    digits[d].probability = posterior[d];
  }

  return {
    digits,
    posterior,
    topDigit: top,
    topScore: digits[top].accuracyScore,
    diagnostics: {
      lyapunov,
      hurst,
      harmonic,
      ksDivergence,
      entropy,
      autocorr,
      runsZ,
      chi2,
      ordered,
      persistent,
      synchronized,
      anomalous,
      samples: len,
    },
    calcMs: performance.now() - t0,
  };
}

// Blend the SuperQuant posterior with an existing ensemble posterior using a
// geometric (log-linear) opinion pool — preserves confident agreement while
// damping single-model outliers. Result is normalized.
export function fusePosteriors(a: number[], b: number[], wB = 0.5): number[] {
  const out = new Array<number>(10);
  let s = 0;
  for (let i = 0; i < 10; i++) {
    const pa = Math.max(1e-6, a[i] ?? 0.1);
    const pb = Math.max(1e-6, b[i] ?? 0.1);
    const v = Math.pow(pa, 1 - wB) * Math.pow(pb, wB);
    out[i] = v;
    s += v;
  }
  for (let i = 0; i < 10; i++) out[i] = s > 0 ? out[i] / s : 0.1;
  return out;
}
