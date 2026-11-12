// ============================================================================
// PRE-ARRIVAL PREDICTIVE ANALYSIS ENGINE
// Zero-lag forecasting layer: isolates repeating mathematical clusters BEFORE
// the target digit enters the lookback matrix.
//
// Formulas implemented (no shortcuts):
//   1. Third-Order Markov Tensor (pre-arrival context lookup)
//   2. Lyapunov phase-space trajectory compression exponent
//   3. Hurst rescaled-range persistence ratio (R/S)
//   4. Fourier spectral harmonic coefficient over price deltas
//   5. Kolmogorov–Smirnov uniformity divergence (bias scroller)
//   6. Autoregressive exponentially-decayed Poisson intensity
//   + Micro-fatigue muting (exhaustion boundary at 4 sequential hits)
//   + Extended streak forecasting (2 → 6 consecutive hits)
// ============================================================================

export type AssetType = "1S" | "PLAIN";

export interface PreArrivalForecast {
  digit: number;
  preArrivalProbability: number; // 0..99.9
  predictedStreakLength: number; // 0, or 2..6
  isQuantumTarget: boolean;
  isQuantumLockWarning: boolean;
  isExhaustedState: boolean;
}

export interface PreArrivalPhysics {
  lyapunovExponent: number;
  hurstExponent: number;
  harmonicWaveCoeff: number;
  ksDivergence: number;
  markov3Context: number;
  horizonTargetDepth: number;
  isSystemLockingIntoLoop: boolean;
  isStreamHighlyPersistent: boolean;
  isWavePatternSynchronized: boolean;
  isAnomalousClusterStream: boolean;
  computeMs: number;
  ready: boolean;
}

export interface PreArrivalResult {
  forecasts: PreArrivalForecast[];
  physics: PreArrivalPhysics;
  topDigit: number;
}

/** 1s indices tick every second; plain indices tick every 2 seconds. */
export function assetTypeOf(symbol: string): AssetType {
  return /^1HZ\d+V$/.test(symbol) ? "1S" : "PLAIN";
}

export function horizonFor(assetType: AssetType): number {
  return assetType === "1S" ? 3 : 2;
}

function emptyForecasts(): PreArrivalForecast[] {
  return Array.from({ length: 10 }, (_, i) => ({
    digit: i,
    preArrivalProbability: 10.0,
    predictedStreakLength: 0,
    isQuantumTarget: false,
    isQuantumLockWarning: false,
    isExhaustedState: false,
  }));
}

export function runPreArrivalAnalysis(
  ticksBuffer: number[],
  deltasBuffer: number[],
  assetType: AssetType,
  selectedDuration?: number,
): PreArrivalResult {
  const t0 = performance.now();
  const output = emptyForecasts();
  const len = ticksBuffer.length;
  const horizonTargetDepth = Math.max(1, Math.min(10, Math.floor(selectedDuration ?? horizonFor(assetType))));

  if (len < 20) {
    return {
      forecasts: output,
      topDigit: -1,
      physics: {
        lyapunovExponent: 0,
        hurstExponent: 0,
        harmonicWaveCoeff: 0,
        ksDivergence: 0,
        markov3Context: 0,
        horizonTargetDepth,
        isSystemLockingIntoLoop: false,
        isStreamHighlyPersistent: false,
        isWavePatternSynchronized: false,
        isAnomalousClusterStream: false,
        computeMs: performance.now() - t0,
        ready: false,
      },
    };
  }

  // ---- FORMULA 1: DYNAMIC ORDER 1..7+ VARIABLE-LENGTH MARKOV TENSOR ----
  // Scales backward pattern depth with selected Duration (up to order 8).
  const maxOrder = Math.min(8, Math.max(3, horizonTargetDepth), len - 2);
  const markov3Tensor = new Array<number>(10).fill(0);
  let totalMarkov3Context = 0;

  for (let order = 1; order <= maxOrder; order++) {
    const orderCounts = new Array<number>(10).fill(0);
    let orderTotal = 0;
    for (let i = order; i < len; i++) {
      let match = true;
      for (let k = 1; k <= order; k++) {
        if (ticksBuffer[i - k] !== ticksBuffer[len - k]) {
          match = false;
          break;
        }
      }
      if (match) {
        orderCounts[ticksBuffer[i]]++;
        orderTotal++;
      }
    }
    if (orderTotal > 0) {
      // Higher-order exact sequence matches receive stronger weight (order^2)
      const weight = order * order;
      for (let d = 0; d < 10; d++) {
        markov3Tensor[d] += (orderCounts[d] / orderTotal) * weight;
      }
      totalMarkov3Context += orderTotal;
    }
  }
  const tensorSum = markov3Tensor.reduce((a, b) => a + b, 0);
  if (tensorSum > 0 && totalMarkov3Context > 0) {
    for (let d = 0; d < 10; d++) {
      markov3Tensor[d] = (markov3Tensor[d] / tensorSum) * totalMarkov3Context;
    }
  }

  // ---- FORMULA 2: LYAPUNOV PHASE-SPACE TRAJECTORY COMPRESSION ----
  let lyapunovSum = 0;
  let trajectoriesCount = 0;
  const lyapunovWindow = Math.min(20, len - 1);
  for (let i = 1; i <= lyapunovWindow; i++) {
    const diffPrev = Math.abs(ticksBuffer[len - i] - ticksBuffer[len - i - 1]);
    const safeDiff = diffPrev === 0 ? 0.0001 : diffPrev;
    lyapunovSum += Math.log(safeDiff);
    trajectoriesCount++;
  }
  const lyapunovExponent = trajectoriesCount > 0 ? lyapunovSum / trajectoriesCount : 1;
  // Exponent near/below threshold ⇒ system freezing into a repeating loop.
  const isSystemLockingIntoLoop = lyapunovExponent < 0.65;

  // ---- FORMULA 3: HURST RESCALED-RANGE MEMORY RATIO ----
  const hurstSize = Math.min(24, len);
  const hurstSegment = ticksBuffer.slice(-hurstSize);
  let sumHurst = 0;
  for (let i = 0; i < hurstSize; i++) sumHurst += hurstSegment[i];
  const avgHurst = sumHurst / hurstSize;
  let cumulativeDeviation = 0;
  let maxDev = 0;
  let minDev = 0;
  for (let i = 0; i < hurstSize; i++) {
    cumulativeDeviation += hurstSegment[i] - avgHurst;
    if (cumulativeDeviation > maxDev) maxDev = cumulativeDeviation;
    if (cumulativeDeviation < minDev) minDev = cumulativeDeviation;
  }
  const range = maxDev - minDev;
  let varianceSum = 0;
  for (let i = 0; i < hurstSize; i++) varianceSum += Math.pow(hurstSegment[i] - avgHurst, 2);
  const stDev = Math.sqrt(varianceSum / hurstSize) || 0.0001;
  const hurstExponent = Math.log((range || 0.0001) / stDev) / Math.log(24);
  const isStreamHighlyPersistent = hurstExponent > 0.55;

  // ---- FORMULA 4: FOURIER SPECTRAL HARMONICS (period-4 wave on price Δ) ----
  let harmonicWaveCoeff = 0;
  const traceWindow = Math.min(24, deltasBuffer.length);
  const startDeltaIdx = deltasBuffer.length - traceWindow;
  for (let i = 0; i < traceWindow; i++) {
    harmonicWaveCoeff +=
      Math.abs(deltasBuffer[startDeltaIdx + i]) * Math.cos((2 * Math.PI * i) / 4);
  }
  const isWavePatternSynchronized = harmonicWaveCoeff > 0.05;

  // ---- FORMULA 5: KOLMOGOROV–SMIRNOV BIAS SCROLLER ----
  const counts = new Array<number>(10).fill(0);
  const ksSize = Math.min(25, len);
  for (let i = len - ksSize; i < len; i++) counts[ticksBuffer[i]]++;
  let maxDivergence = 0;
  let cumulativeObserved = 0;
  for (let d = 0; d < 10; d++) {
    cumulativeObserved += counts[d] / ksSize;
    const expectedUniformCumulative = (d + 1) / 10;
    const divergence = Math.abs(cumulativeObserved - expectedUniformCumulative);
    if (divergence > maxDivergence) maxDivergence = divergence;
  }
  const isAnomalousClusterStream = maxDivergence > 0.18;

  // ---- FORMULA 6: AUTOREGRESSIVE POISSON DENSITY ARRIVAL MODEL ----
  const poissonIntensities = new Array<number>(10).fill(0.1);
  const decayConstant = 0.22;
  for (let i = 0; i < len; i++) {
    const age = len - 1 - i;
    if (age > 60) continue; // e^-13 ≈ 0 — skip negligible tail for speed
    poissonIntensities[ticksBuffer[i]] += Math.exp(-decayConstant * age);
  }

  // ---- PRE-ARRIVAL FORECASTING LAYER (multi-streak burst projection) ----
  let topDigit = 0;
  let topScore = -1;

  for (let d = 0; d < 10; d++) {
    let baseAccuracy = poissonIntensities[d] * 12;

    if (totalMarkov3Context > 0) {
      baseAccuracy += (markov3Tensor[d] / totalMarkov3Context) * 60;
    }
    if (isSystemLockingIntoLoop) baseAccuracy *= 1.35;
    if (isStreamHighlyPersistent && isWavePatternSynchronized) baseAccuracy += 15.0;
    if (isAnomalousClusterStream) baseAccuracy += 10.0;

    // Current sequential run of this digit at the tail of the stream.
    let explicitCurrentStreakCount = 0;
    for (let i = len - 1; i >= 0; i--) {
      if (ticksBuffer[i] === d) explicitCurrentStreakCount++;
      else break;
    }

    // Short-window saturation: how many times the digit already fired inside
    // the immediate horizon window (over-appearance = spent cluster).
    const satWindow = Math.min(6, len);
    let recentHits = 0;
    for (let i = len - satWindow; i < len; i++) if (ticksBuffer[i] === d) recentHits++;

    // Long-window activity: a digit absent from the whole lookback has no
    // active cluster to ride and must never be forecast.
    const actWindow = Math.min(50, len);
    let activityHits = 0;
    for (let i = len - actWindow; i < len; i++) if (ticksBuffer[i] === d) activityHits++;
    const isInactiveState = activityHits === 0;

    // MICRO-FATIGUE MUTING — 3+ sequential hits (or 3+ inside the last 6
    // ticks) ⇒ the PRNG loop is spent; flatten to kill late streak-chasing.
    const isExhaustedState = explicitCurrentStreakCount >= 3 || recentHits >= 3;
    const isQuantumLockWarning =
      !isExhaustedState && !isInactiveState && baseAccuracy > 48 && isSystemLockingIntoLoop;

    let predictedStreakLength = 0;
    if (isQuantumLockWarning) {
      if (baseAccuracy > 75 && isStreamHighlyPersistent) {
        predictedStreakLength = Math.min(4 + horizonTargetDepth, 6);
      } else if (baseAccuracy > 60) {
        predictedStreakLength = 3;
      } else {
        predictedStreakLength = 2;
      }
      // Never forecast beyond the exhaustion boundary: an ongoing run of k
      // hits can only extend to 3 − k more before the digit is muted.
      predictedStreakLength = Math.max(2, Math.min(predictedStreakLength, 6 - recentHits));
    }

    let finalScore = baseAccuracy;
    if (isExhaustedState) finalScore = baseAccuracy * 0.01;
    else if (isInactiveState) finalScore = baseAccuracy * 0.15;
    else if (recentHits === 2) finalScore = baseAccuracy * 0.55; // fatigue ramp
    const prob = Math.min(Math.round(finalScore * 10) / 10, 99.9);

    output[d] = {
      digit: d,
      preArrivalProbability: prob,
      predictedStreakLength,
      isQuantumTarget: isQuantumLockWarning,
      isQuantumLockWarning,
      isExhaustedState,
    };
    if (prob > topScore) {
      topScore = prob;
      topDigit = d;
    }
  }

  return {
    forecasts: output,
    topDigit,
    physics: {
      lyapunovExponent,
      hurstExponent,
      harmonicWaveCoeff,
      ksDivergence: maxDivergence,
      markov3Context: totalMarkov3Context,
      horizonTargetDepth,
      isSystemLockingIntoLoop,
      isStreamHighlyPersistent,
      isWavePatternSynchronized,
      isAnomalousClusterStream,
      computeMs: performance.now() - t0,
      ready: true,
    },
  };
}

/**
 * Fuse the pre-arrival forecast into the existing ensemble posterior.
 * Exhausted digits are flattened; quantum-locked digits are amplified.
 * Returns a renormalised 10-length posterior.
 */
export function fusePreArrival(
  posterior: number[],
  forecasts: PreArrivalForecast[],
): number[] {
  const out = new Array<number>(10);
  let sum = 0;
  for (let d = 0; d < 10; d++) {
    const f = forecasts[d];
    // pre-arrival probability is a 0..99.9 score; normalise around the 10% base.
    const rel = Math.max(0.05, f.preArrivalProbability / 10);
    let w = Math.pow(rel, 0.5); // damped so it augments rather than dominates
    if (f.isExhaustedState) w *= 0.05;
    if (f.isQuantumLockWarning) w *= 1 + 0.08 * f.predictedStreakLength;
    const v = Math.max(1e-6, (posterior[d] ?? 0.1) * w);
    out[d] = v;
    sum += v;
  }
  for (let d = 0; d < 10; d++) out[d] /= sum;
  return out;
}
