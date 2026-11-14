// Digits Navigator — Corrected Mathematical Engine (Version 3), full port.
// NOTHING IS TRUNCATED — every formula from the uploaded corrected engine draft
// is implemented exactly, plus the master-blueprint diagnostics that the draft
// referenced (AMI across lags 1..7, LZW compression ratio, CUSUM/Page-Hinkley
// regime shift diagnostics).
//
// NEW in v3 (no shortcuts — every step kept):
//  • DYNAMIC BUFFER: the engine buffer scales to the selected Lookback
//    (25 / 50 / 100) instead of being hard-coded to 100. The transition
//    matrix, runs test, KL, KS, AMI, LZW and fatigue windows all scale with it.
//  • OVER/UNDER engine: horizon side probabilities via [M^D] row sums,
//    barrier tie (dead-zone) filter at 10%, micro-window momentum delta-P
//    against the full-buffer baseline, and a recommendation with velocity.
//  • EVEN/ODD engine: horizon parity via matrix exponentiation
//    P(Even) = Σ_even [M^D]_{s0,d}, corroborated by the Wald–Wolfowitz runs
//    Z-score and micro momentum.
//  • RISE/FALL engine: price-increment (ΔS) analysis cleanly separated from
//    digit modulo arithmetic — up/down momentum, baseline vs micro-window
//    direction fractions and current directional run length.
//  • SNAPSHOT evaluation (evaluateSnapshot) for the multi-market scanner —
//    evaluates a fetched history without touching the live buffer.
//
// STRICTLY ANALYSIS ONLY — this engine never purchases or trades.
import {
  coldProb,
  ensemblePredict,
  gapsSinceLast,
  sequenceFollowups,
  tailStreak,
} from "./stats";

import type { Market, NavRuleToggles, NavThresholds } from "./types";
import { alertDecisionSignature } from "./alertSafety";

export interface EngineTickInput {
  price: number;
  pip: number;
  epoch: number;
  /** Monotonic live tick identity, used to reject delayed worker results. */
  tickId?: number;
  duration: number; // Horizon D in ticks (1..10)
  symbol: string;
  rttMs?: number;
  /** When the caller already extracted the digit (trailing-zero-safe), pass it
   *  here; price/pip are then only used for display. Prevents double-push. */
  digit?: number;
  /** Selected market type — drives the market-specific decision block. */
  market?: Market;
  /** Barrier for the Over/Under engine (0..9). */
  barrier?: number;
  /** User-selected prediction digit (Matches target) — alerts target this
   *  digit instead of an autonomous engine top-pick. */
  predictDigit?: number;
  /** Navigator trigger rule toggles (strict AND for Matches alerts). */
  navRules?: NavRuleToggles;
  /** Navigator trigger rule percent thresholds. */
  navThresholds?: NavThresholds;
  /** Unified 10-digit prior from Pre-Arrival Physics + Order 1..7+ VMM + HMM/Context. */
  unifiedPrior?: number[];
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
  fatigueScore: number; // Appearances in the scaled tail window
}

// ---------- Market-specific horizon blocks (v3) ----------

export interface OverUnderBlock {
  barrier: number;
  pOver: number; // Σ_{d>barrier} [M^D]_{s0,d}
  pUnder: number; // Σ_{d<barrier} [M^D]_{s0,d}
  pTie: number; // [M^D]_{s0,barrier} — landing exactly on the barrier
  baselineOver: number; // full-buffer frequency of over-side digits
  baselineUnder: number;
  deadZone: boolean; // barrier tie probability >= 10% → signal blocked
  momentumOver: number; // micro-window over-frequency − baseline (ΔP)
  momentumUnder: number;
  rec: "OVER" | "UNDER" | "HOLD";
  prob: number; // horizon probability of the recommended side
  velocity: number; // momentum (ΔP) of the recommended side
}

export interface ParityBlock {
  pEven: number; // Σ_{even d} [M^D]_{s0,d}
  pOdd: number;
  baselineEven: number; // full-buffer even frequency
  momentumEven: number; // micro-window even fraction − baseline (ΔP)
  momentumOdd: number;
  rec: "EVEN" | "ODD" | "HOLD";
  prob: number;
  velocity: number;
}

export interface DirectionBlock {
  pRise: number; // momentum-adjusted up probability for the horizon
  pFall: number;
  baselineUp: number; // full-buffer up-fraction of price deltas
  momentumRise: number; // micro-window up fraction − baseline (ΔP)
  momentumFall: number;
  runLength: number; // current consecutive same-direction price run
  runDir: "UP" | "DOWN" | "FLAT";
  rec: "RISE" | "FALL" | "HOLD";
  prob: number;
  velocity: number;
}

export interface EngineResult {
  symbol: string;
  market: Market;
  tickId: number;
  decisionSignature: string;
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

  // Statistical Diagnostics (scaled to the dynamic buffer)
  bufferSize: number;
  bufferFilled: number;
  runsZScore: number;
  klDivergence: number;
  ksDrift: number;
  amiBits: number; // lag-D AMI (draft semantics)
  amiLags: number[]; // AMI for lags 1..7 (blueprint, capped by buffer size)
  lzwRatio: number; // LZW dictionary phrases / N (blueprint)
  hurstH: number; // Rescaled-range Hurst exponent (0.50 = Brownian noise)
  cusum: number; // Page-Hinkley accumulator 
  cusumShift: boolean; // structural regime shift detected this tick
  regime: "BALANCED_RANDOM" | "PARITY_CLUSTERING" | "MEAN_REVERTING";
  adaptiveKlThreshold: number;

  // Pools
  freshPool: number[];
  tiredPool: number[];
  digits: DigitMetrics[];

  // Market-specific horizon blocks (v3)
  overUnder: OverUnderBlock | null;
  evenOdd: ParityBlock | null;
  riseFall: DirectionBlock | null;

  // Consolidated market view for the active market type
  marketAction: string; // "DIGIT 7" | "OVER 4" | "EVEN" | "RISE" | ""
  marketEdge: number; // probability edge vs the random baseline (0..1)
  marketScore: number; // ranking score for the multi-market scanner
  marketRecProb: number; // horizon probability of the recommended side

  // Network & Safety
  executionCutoffMs: number;
  rttMs: number;
  pingThresholdMs: number;
  latencyGatePassed: boolean;
  alertDecision:
    | "READY / MANUAL ALERT"
    | "HOLD / NO SIGNAL"
    | "HOLD / UNSAFE LATENCY"
    | "HOLD / DEAD ZONE"
    | "HOLD / RULES NOT MET";

  /** Navigator trigger-rule evaluation for the user-selected digit. */
  navTargetDigit: number;
  navTargetFresh: boolean;
  navRulesEnabled: boolean;
  navRuleHits: NavRuleHit[];

  analyzeMs: number;
}

export const NAV_BUFFER_SIZE = 100;
export const NAV_MICRO_WINDOW = 20;
export const NAV_TAIL_WINDOW = 15;
export const NAV_MULTI_HIT_FLOOR = 0.07; // 7.0% provisional density floor (Matches)
export const NAV_EDGE_FLOOR = 0.08; // 8% edge over the random baseline (Over/Under · Even/Odd · Rise/Fall)
export const NAV_TIE_DEAD_ZONE = 0.10; // barrier tie probability >= 10% blocks the signal
export const NAV_EXECUTION_CUTOFF_MS = 600;

/** Display labels for the Navigator trigger rules. */
export const NAV_RULE_LABELS: Record<keyof NavRuleToggles, string> = {
  // 7 Legacy rules
  ensemble: "Ensemble% >",
  markov: "Markov% >",
  streak: "Streak ≥",
  prob: "Freq% <",
  sequence: "Follow-D% >",
  cold: "Cold P% <",
  deviation: "|Δ from 10%| >",

  // 11 Navigator rules
  multiHit: "Multi-hit ≥2 (D)",
  pairRun: "Pair/Run (d,d)",
  landing: "Landing t+D",
  freshness: "Fresh (anti-tired)",
  parity: "Parity confluence",
  barrier: "O/U confluence",
  lowEntropy: "Low Entropy",
  antiRepeat: "Anti-Repeat",
  frequencyEnvelope: "Freq envelope min%",
  markovD: "Markov D-Step",
  hurstFilter: "Hurst Non-Random (H)",
  macroConfluence: "Macro Confluence Gate",
};

/** Fallback thresholds when the caller supplies none (percent). */
export const NAV_THRESHOLDS_DEFAULT: NavThresholds = {
  // 7 Legacy thresholds
  triggerEnsembleAbove: 22,
  triggerMarkovAbove: 18,
  triggerStreak: 3,
  triggerProbBelow: 8,
  triggerSequenceAbove: 20,
  triggerColdProbBelow: 10,
  triggerDeviationPct: 4,

  // 11 Navigator thresholds
  multiHitPct: 7,
  pairRunPct: 3,
  landingPct: 12,
  parityPct: 55,
  barrierPct: 55,
  entropyZMax: -1,
  frequencyMinPct: 0,
  frequencyMaxPct: 20,
  markovDPct: 12,
  differsProbabilityCeilingPct: 12,
  differsColdGapMin: 5,
  hurstMinEdge: 0.05,
};

/** One Navigator trigger-rule evaluation line for the UI checklist. */
export interface NavRuleHit {
  rule: keyof NavRuleToggles;
  label: string;
  enabled: boolean;
  pass: boolean;
  detail: string;
}

const pctOf = (x: number) => `${(x * 100).toFixed(2)}%`;

/** Evaluate the six Navigator trigger rules against the user-selected digit's
 *  exact DP outputs. Disabled rules are reported but never block. */
function buildNavRuleHits(
  target: number,
  tm: DigitMetrics,
  fresh: boolean,
  rules: NavRuleToggles | undefined,
  thr: NavThresholds | undefined,
  parity: ParityBlock | null,
  ou: OverUnderBlock | null,
  currDigit: number,
  targetFreq: number,
  bufferSize: number,
  entropyZ: number,
  pMarkovDTarget: number,
  hurstH: number,
  win: number[],
  duration: number,
  pMarkov1Target: number,
): NavRuleHit[] {
  const t = thr ?? NAV_THRESHOLDS_DEFAULT;
  const on = (k: keyof NavRuleToggles) => !!rules?.[k];
  const hits: NavRuleHit[] = [];

  // ==================== 7 LEGACY RULES ====================
  // 1. Ensemble Bayesian fusion
  const ens = win.length >= 10 ? ensemblePredict(win, duration) : null;
  const ensPass = !!ens && ens.topDigit === target && (ens.confidence * 100) > (t.triggerEnsembleAbove ?? 22);
  hits.push({
    rule: "ensemble",
    label: NAV_RULE_LABELS.ensemble,
    enabled: on("ensemble"),
    pass: ensPass,
    detail: ens
      ? `→${ens.topDigit} ${(ens.confidence * 100).toFixed(0)}% > ${t.triggerEnsembleAbove}%`
      : "insufficient history",
  });

  // 2. 1-step Markov transition P(target | currDigit)
  const pMarkov1Pct = pMarkov1Target * 100;
  hits.push({
    rule: "markov",
    label: NAV_RULE_LABELS.markov,
    enabled: on("markov"),
    pass: pMarkov1Pct > (t.triggerMarkovAbove ?? 18),
    detail: `P(${target}|${currDigit})=${pMarkov1Pct.toFixed(0)}% > ${t.triggerMarkovAbove}%`,
  });

  // 3. Trailing streak of target digit
  const stk = tailStreak(win);
  const stkPass = stk.digit === target && stk.len >= (t.triggerStreak ?? 3);
  hits.push({
    rule: "streak",
    label: NAV_RULE_LABELS.streak,
    enabled: on("streak"),
    pass: stkPass,
    detail: stk.digit === target ? `${stk.len}×${stk.digit} ≥ ${t.triggerStreak}` : `streak=0 (last=${currDigit})`,
  });

  // 4. Frequency below threshold (reversion)
  const targetFreqPct = bufferSize > 0 ? (targetFreq / bufferSize) * 100 : 10;
  hits.push({
    rule: "prob",
    label: NAV_RULE_LABELS.prob,
    enabled: on("prob"),
    pass: targetFreqPct < (t.triggerProbBelow ?? 8),
    detail: `freq ${targetFreqPct.toFixed(1)}% < ${t.triggerProbBelow}%`,
  });

  // 5. Sequence followup horizon D
  const horizon = Math.max(1, duration);
  const pattern = win.slice(-Math.min(horizon, win.length));
  const seq = sequenceFollowups(win, pattern, horizon);
  const pSeq = (seq.probs[target] ?? 0) * 100;
  hits.push({
    rule: "sequence",
    label: NAV_RULE_LABELS.sequence,
    enabled: on("sequence"),
    pass: seq.total >= 3 && pSeq > (t.triggerSequenceAbove ?? 20),
    detail: `[${seq.pattern.join("")}]→+${horizon} ${pSeq.toFixed(0)}% > ${t.triggerSequenceAbove}%`,
  });

  // 6. Cold probability based on gap since last appearance
  const g = gapsSinceLast(win)[target] ?? bufferSize;
  const pCold = coldProb(g) * 100;
  hits.push({
    rule: "cold",
    label: NAV_RULE_LABELS.cold,
    enabled: on("cold"),
    pass: pCold < (t.triggerColdProbBelow ?? 10),
    detail: `gap=${g} P=${pCold.toFixed(1)}% < ${t.triggerColdProbBelow}%`,
  });

  // 7. Frequency deviation from 10% (|Δ| > min)
  const devPct = Math.abs(targetFreqPct - 10);
  hits.push({
    rule: "deviation",
    label: NAV_RULE_LABELS.deviation,
    enabled: on("deviation"),
    pass: devPct > (t.triggerDeviationPct ?? 4),
    detail: `|Δ|=${devPct.toFixed(1)}% > ${t.triggerDeviationPct}%`,
  });

  // ==================== 11 NAVIGATOR RULES ====================
  // 8. Multi-hit >= 2 in horizon
  hits.push({
    rule: "multiHit",
    label: NAV_RULE_LABELS.multiHit,
    enabled: on("multiHit"),
    pass: tm.multiHitProb >= t.multiHitPct / 100,
    detail: `≥2 hits ${pctOf(tm.multiHitProb)} ≥ ${t.multiHitPct}%`,
  });

  // 9. Adjacent pair inside horizon
  hits.push({
    rule: "pairRun",
    label: NAV_RULE_LABELS.pairRun,
    enabled: on("pairRun"),
    pass: tm.pairProb >= t.pairRunPct / 100,
    detail: `pair ${pctOf(tm.pairProb)} ≥ ${t.pairRunPct}%`,
  });

  // 10. Landing probability at t+D
  hits.push({
    rule: "landing",
    label: NAV_RULE_LABELS.landing,
    enabled: on("landing"),
    pass: tm.landingProb >= t.landingPct / 100,
    detail: `t+D ${pctOf(tm.landingProb)} ≥ ${t.landingPct}%`,
  });

  // 11. Anti-tired freshness
  hits.push({
    rule: "freshness",
    label: NAV_RULE_LABELS.freshness,
    enabled: on("freshness"),
    pass: fresh,
    detail: fresh ? "FRESH · anti-tired ok" : "TIRED · suppressed",
  });

  // 12. Parity confluence
  const even = target % 2 === 0;
  const pPar = parity ? (even ? parity.pEven : parity.pOdd) : 0;
  hits.push({
    rule: "parity",
    label: NAV_RULE_LABELS.parity,
    enabled: on("parity"),
    pass: !!parity && pPar >= t.parityPct / 100,
    detail: parity
      ? `P(${even ? "EVEN" : "ODD"}) ${pctOf(pPar)} ≥ ${t.parityPct}%`
      : "no parity block",
  });

  // 13. Over/Under barrier confluence
  let barrierPass = false;
  let barrierDetail = "no O/U block";
  if (ou) {
    if (ou.barrier === 0) {
      barrierPass = target > 0 && ou.rec === "OVER";
      barrierDetail = `OVER 0 target ${target > 0 ? "ok" : "losing"}`;
    } else if (ou.barrier === 9) {
      barrierPass = target < 9 && ou.rec === "UNDER";
      barrierDetail = `UNDER 9 target ${target < 9 ? "ok" : "losing"}`;
    } else if (target === ou.barrier) {
      barrierDetail = `digit = barrier ${ou.barrier} · tie zone`;
    } else if (ou.deadZone) {
      barrierDetail = `dead zone P(tie) ${pctOf(ou.pTie)} ≥ 10%`;
    } else if (target > ou.barrier) {
      barrierPass = ou.rec === "OVER" && ou.pOver >= t.barrierPct / 100;
      barrierDetail = `OVER ${pctOf(ou.pOver)} ≥ ${t.barrierPct}%`;
    } else {
      barrierPass = ou.rec === "UNDER" && ou.pUnder >= t.barrierPct / 100;
      barrierDetail = `UNDER ${pctOf(ou.pUnder)} ≥ ${t.barrierPct}%`;
    }
  }
  hits.push({
    rule: "barrier",
    label: NAV_RULE_LABELS.barrier,
    enabled: on("barrier"),
    pass: barrierPass,
    detail: barrierDetail,
  });

  // 14. Low-entropy regime (bias-corrected Shannon Entropy Z-score)
  hits.push({
    rule: "lowEntropy",
    label: NAV_RULE_LABELS.lowEntropy,
    enabled: on("lowEntropy"),
    pass: entropyZ <= t.entropyZMax,
    detail: `H-Z ${entropyZ.toFixed(2)} ≤ ${t.entropyZMax}`,
  });

  // 15. Anti-repeat filter
  const isRepeat = target === currDigit;
  hits.push({
    rule: "antiRepeat",
    label: NAV_RULE_LABELS.antiRepeat,
    enabled: on("antiRepeat"),
    pass: !isRepeat || on("pairRun"),
    detail: isRepeat ? (on("pairRun") ? "repeat allowed by pairRun" : `repeat blocked (last = ${currDigit})`) : "no repeat ok",
  });

  // 16. Frequency envelope
  hits.push({
    rule: "frequencyEnvelope",
    label: NAV_RULE_LABELS.frequencyEnvelope,
    enabled: on("frequencyEnvelope"),
    pass: targetFreqPct >= t.frequencyMinPct && targetFreqPct <= t.frequencyMaxPct,
    detail: `freq ${targetFreqPct.toFixed(1)}% ∈ [${t.frequencyMinPct}%, ${t.frequencyMaxPct}%]`,
  });

  // 17. D-step Markov
  const markovDPct = pMarkovDTarget * 100;
  hits.push({
    rule: "markovD",
    label: NAV_RULE_LABELS.markovD,
    enabled: on("markovD"),
    pass: markovDPct >= t.markovDPct,
    detail: `M^D ${markovDPct.toFixed(1)}% ≥ ${t.markovDPct}%`,
  });

  // 18. Hurst Exponent Non-Randomness Filter
  const hurstEdge = Math.abs(hurstH - 0.5);
  const minEdge = t.hurstMinEdge ?? 0.05;
  const regimeTag = hurstH > 0.5 ? "persistent" : hurstH < 0.5 ? "mean-rev" : "noise";
  hits.push({
    rule: "hurstFilter",
    label: NAV_RULE_LABELS.hurstFilter,
    enabled: on("hurstFilter"),
    pass: hurstEdge >= minEdge,
    detail: `H=${hurstH.toFixed(2)} (${regimeTag} · |Δ|=${hurstEdge.toFixed(2)} ≥ ${minEdge.toFixed(2)})`,
  });

  return hits;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export class DigitsEngine {
  // Dynamic buffer size — scales to the user-selected Lookback (25/50/100).
  private readonly bufferSize: number;
  private readonly microWindow: number;
  private readonly tailWindow: number;
  private readonly recentWindow: number;
  private readonly countWindow: number;

  private readonly buffer: Uint8Array;
  private count: number = 0;

  // Price-increment (ΔS) ring for the Rise/Fall engine — kept strictly
  // separate from digit modulo arithmetic.
  private readonly prices = new Float32Array(64);
  private priceCount = 0;
  private readonly deltas = new Float32Array(64);
  private deltaCount = 0;

  // Transition matrix M (10x10)
  private readonly T1: Float64Array = new Float64Array(100);
  private readonly TD: Float64Array = new Float64Array(100);
  private readonly scratchA: Float64Array = new Float64Array(100);
  private readonly scratchB: Float64Array = new Float64Array(100);

  // Scratch vectors
  private readonly freq100: Int32Array = new Int32Array(10);
  private readonly freqMicro: Int32Array = new Int32Array(10);
  private readonly freqTail: Int32Array = new Int32Array(10);

  // Dynamic Programming state tables for exact multi-hit calculation.
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
    // ---- KALMAN FILTER REAL-TIME TRACKING MEMORY INITIALIZATION ----
  private kalman_x: number = 0; // Estimated true price state
  private kalman_P: number = 1.0; // Estimate error variance memory
  private readonly kalman_Q: number = 0.0001; // Process noise covariance prior
  private readonly kalman_R: number = 0.01; // Measurement noise covariance threshold
  private kalman_initialized: boolean = false;

  // ---- LORENZ CHAOTIC ATTRACTOR PHASE SPACE ANCHORS ----
  private lorenz_x: number = 1.0;
  private lorenz_y: number = 1.0;
  private lorenz_z: number = 1.0;
  private readonly lorenz_sigma: number = 10.0;
  private readonly lorenz_beta: number = 8.0 / 3.0;
  private readonly lorenz_rho: number = 28.0; // Standard chaotic attractor parameter
    // ---- ORNSTEIN–UHLENBECK ELASTIC REVERSION MEMORY STRUCTURES ----
  private ou_theta: number = 0.15;      // Rate of mean reversion elasticity
  private ou_mu: number = 4.5;         // Long-term equilibrium mean of the uniform distribution [0..9]
  private ou_sigma: number = 1.2;      // Volatility profile parameter
  private readonly ou_history = new Float64Array(100); // Volatility profile memory lookback

  // ---- FOKKER–PLANCK PROBABILITY DENSITY DIFFUSION TABLES ----
  private readonly fp_density = new Float64Array(10);   // Live discrete system state density profile p(x, t)
  private readonly fp_drift = new Float64Array(10);     // Drift vectors D_1(x, t)
  private readonly fp_diffusion = new Float64Array(10); // Diffusion dispersion coefficients D_2(x, t)

  // ---- HIDDEN MARKOV MODEL AND VITERBI REGIME PATH MEMORY ----
  // States: 0 = BALANCED_RANDOM, 1 = PARITY_CLUSTERING, 2 = MEAN_REVERTING
  private readonly hmm_A = new Float64Array([
    0.80, 0.10, 0.10, // Transition dynamics from state 0
    0.15, 0.75, 0.10, // Transition dynamics from state 1
    0.10, 0.10, 0.80  // Transition dynamics from state 2
  ]);
  private readonly hmm_B = new Float64Array(30); // Emission densities for 3 hidden states × 10 visible symbols
  private readonly viterbi_matrix = new Float64Array(300 * 3); // LIFO Trellis trellis history space tracking table
  private readonly viterbi_pointer = new Int32Array(300 * 3);  // Trellis backtracking register path space allocation

    constructor(bufferSize: number = NAV_BUFFER_SIZE) {
    const size = Math.round(clamp(bufferSize, 2, 600));
    this.bufferSize = size;
    this.buffer = new Uint8Array(size);
    
    this.microWindow = clamp(Math.round(size * 0.2), 3, 20);
    this.tailWindow = clamp(Math.round(size * 0.15), 3, 15);
    this.recentWindow = size <= 25 ? 3 : 4;
    this.countWindow = clamp(Math.round(size * 0.12), 3, 12);

    this.kalman_x = 0;
    this.kalman_P = 1.0;
    this.kalman_initialized = false;
    this.lorenz_x = 1.0;
    this.lorenz_y = 1.0;
    this.lorenz_z = 1.0;

    // Initialize HMM B emission profiles cleanly (Laplace smoothed priors)
    for (let d = 0; d < 10; d++) {
      // Hidden State 0 (Balanced Uniform Noise distribution)
      this.hmm_B[0 * 10 + d] = 0.10;
      // Hidden State 1 (Parity Clustering — skews heavily toward even digits)
      this.hmm_B[1 * 10 + d] = (d % 2 === 0) ? 0.15 : 0.05;
      // Hidden State 2 (Mean Reverting — skews heavily toward middle-band anchors)
      this.hmm_B[2 * 10 + d] = (d >= 3 && d <= 6) ? 0.16 : 0.06;
    }
   }
  
  get capacity(): number {
    return this.bufferSize;
  }

  get filled(): number {
    return this.count;
  }

  public static extractDigit(price: number, pip: number): number {
    const s = price.toFixed(pip);
    const ch = s.charAt(s.length - 1);
    const d = parseInt(ch, 10);
    return Number.isInteger(d) && d >= 0 && d <= 9 ? d : -1;
  }

  public pushTick(digit: number): void {
    if (digit < 0 || digit > 9) return;
    if (this.count < this.bufferSize) {
      this.buffer[this.count++] = digit;
    } else {
      this.buffer.copyWithin(0, 1, this.bufferSize);
      this.buffer[this.bufferSize - 1] = digit;
    }
  }

  /** Feed a raw price quote — updates the Rise/Fall ΔS ring. Digit-modulo
   *  statistics are untouched. */
  public pushPrice(price: number): void {
    if (!Number.isFinite(price) || price <= 0) return;
    if (this.priceCount > 0) {
      const delta = price - this.prices[(this.priceCount - 1) % 64];
      if (Number.isFinite(delta)) {
        this.deltas[this.deltaCount % 64] = delta;
        this.deltaCount++;
      }
    }
    this.prices[this.priceCount % 64] = price;
    this.priceCount++;
  }

  /** Seed the buffer from history (oldest → newest). */
  public seed(digits: number[]): void {
    for (const d of digits) this.pushTick(d);
  }

  public reset(): void {
    this.count = 0;
    this.priceCount = 0;
    this.deltaCount = 0;
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
    const nPairs = this.bufferSize - k;
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
    const N = this.bufferSize;
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

  /** Fast Rescaled-Range (R/S) Hurst Exponent over the active digit buffer.
   *  H ≈ 0.50 = pure random walk; H > 0.55 = trending/persistent; H < 0.45 = mean-reverting. */
  private computeHurst(): number {
    const N = this.bufferSize;
    if (N < 16) return 0.5;

    let mean = 0;
    for (let i = 0; i < N; i++) mean += this.buffer[i];
    mean /= N;

    let cumDev = 0;
    let minCum = 0;
    let maxCum = 0;
    let sqSum = 0;

    for (let i = 0; i < N; i++) {
      const diff = this.buffer[i] - mean;
      cumDev += diff;
      if (cumDev < minCum) minCum = cumDev;
      if (cumDev > maxCum) maxCum = cumDev;
      sqSum += diff * diff;
    }

    const range = maxCum - minCum;
    const stdDev = Math.sqrt(sqSum / N);
    if (stdDev <= 1e-9 || range <= 1e-9) return 0.5;

    const rs = range / stdDev;
    const h = Math.log(rs) / Math.log(N * 0.5);
    return clamp(h, 0.05, 0.95);
  }

  /** Live tick entry point: push digit + price, then run the full engine. */
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
    this.pushPrice(input.price);

    if (this.count < this.bufferSize) return null;
    return this.computeAll(digit, input, t0);
  }

  /** Scanner entry point: evaluate a complete fetched history (oldest →
   *  newest) WITHOUT touching the live buffer. The buffer is filled exactly
   *  with the snapshot digits, so the newest digit is the current state s0. */
  public evaluateSnapshot(digits: number[], prices: number[], input: EngineTickInput): EngineResult | null {
    if (digits.length < this.bufferSize) return null;
    this.reset();
    for (let i = 0; i < digits.length; i++) this.pushTick(digits[i]);
    for (let i = 0; i < prices.length; i++) this.pushPrice(prices[i]);
    const last = digits[digits.length - 1];
    return this.computeAll(last, input, performance.now());
  }

  /** Full engine pipeline — assumes the buffer is already filled with the
   *  newest observation last and that `digit` equals that observation. */
  private computeAll(digit: number, input: EngineTickInput, t0: number): EngineResult | null {
    const N = this.bufferSize;
    const D = Math.max(1, Math.min(10, Math.floor(input.duration || 3)));
    const currDigit = this.buffer[N - 1];

        // 1. Build transition matrix with Laplace smoothing (+1 prior)
    this.T1.fill(1.0);
    this.freq100.fill(0);

    for (let i = 0; i < N - 1; i++) {
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
    
        // ---- LORENZ CHAOTIC ATTRACTOR NUMERICAL COUPLING GATE ----
    {
      const dt = 0.01; // Discrete execution time step segment
      const dx = this.lorenz_sigma * (this.lorenz_y - this.lorenz_x) * dt;
      const dy = (this.lorenz_x * (this.lorenz_rho - this.lorenz_z) - this.lorenz_y) * dt;
      const dz = (this.lorenz_x * this.lorenz_y - this.lorenz_beta * this.lorenz_z) * dt;

      this.lorenz_x += dx;
      this.lorenz_y += dy;
      this.lorenz_z += dz;

      // Extract chaotic phase vector module to predict orbital lobe state shifts
      const lorenzMagnitude = Math.sqrt(this.lorenz_x * this.lorenz_x + this.lorenz_y * this.lorenz_y);
      const attractorLobeBias = Math.sin(lorenzMagnitude) * 0.5 + 0.5; // Bounds cleanly to a [0..1] distribution vector

      // Fuse the chaotic Lorenz attractor priors right into the core calculation matrix (T1)
      const currentStateOffset = currDigit * 10;
      let lorenzRowSum = 0;
      for (let j = 0; j < 10; j++) {
        // Blends 85% Markov history with a 15% Lorenz Chaotic Orbit trajectory prior
        const chaosPrior = (j % 2 === 0) ? attractorLobeBias * 0.2 : (1.0 - attractorLobeBias) * 0.2;
        this.T1[currentStateOffset + j] = 0.85 * this.T1[currentStateOffset + j] + 0.15 * chaosPrior;
        lorenzRowSum += this.T1[currentStateOffset + j];
      }
      // Re-normalize row sum back to an exact 1.0 floor probability distribution
      if (lorenzRowSum > 0) {
        const invSum = 1.0 / lorenzRowSum;
        for (let j = 0; j < 10; j++) this.T1[currentStateOffset + j] *= invSum;
      }
    }

        // =========================================================================
    // 3. ADVANCED PHYSICS MODULE: ORNSTEIN–UHLENBECK REVERSION DISCRETIZATION
    // =========================================================================
    let ouMeanReversionElasticity = 0.0;
    {
      let sumX = 0.0;
      let sumY = 0.0;
      let sumXX = 0.0;
      let sumXY = 0.0;
      const ouN = Math.min(N - 1, 100);
      const startIdx = N - ouN;
      
      for (let i = startIdx; i < N; i++) {
        const x_t = this.buffer[i - 1];
        const x_next = this.buffer[i];
        sumX += x_t;
        sumY += x_next;
        sumXX += x_t * x_t;
        sumXY += x_t * x_next;
      }
      
      const denominator = (ouN * sumXX - sumX * sumX);
      const phi = denominator !== 0 ? (ouN * sumXY - sumX * sumY) / denominator : 0.0;
      
      if (phi > 0 && phi < 1) {
        this.ou_theta = -Math.log(phi);
      }
      
      ouMeanReversionElasticity = this.ou_theta * Math.abs(currDigit - this.ou_mu);
    }

    // =========================================================================
    // 4. ADVANCED PHYSICS MODULE: FOKKER–PLANCK PROBABILITY SPECTRUM DIFFUSION
    // =========================================================================
    {
      for (let d = 0; d < 10; d++) {
        this.fp_density[d] = this.freq100[d] / N;
      }

      for (let d = 0; d < 10; d++) {
        this.fp_drift[d] = -this.ou_theta * (d - this.ou_mu);
        const varianceScale = Math.abs(this.freqMicro[d] / this.microWindow - 0.10);
        this.fp_diffusion[d] = Math.max(0.01, 0.5 * (this.ou_sigma * this.ou_sigma) + varianceScale);
      }

      const dt_fp = 0.05;
      const dx_fp = 1.0;
      for (let d = 1; d < 9; d++) {
        const drift_term = -( (this.fp_drift[d + 1] * this.fp_density[d + 1]) - (this.fp_drift[d - 1] * this.fp_density[d - 1]) ) / (2.0 * dx_fp);
        const diff_term = this.fp_diffusion[d] * (this.fp_density[d + 1] - 2.0 * this.fp_density[d] + this.fp_density[d - 1]) / (dx_fp * dx_fp);
        
        const fluidDelta = (drift_term + diff_term) * dt_fp;
        const currentMatrixIndex = currDigit * 10 + d;
        this.T1[currentMatrixIndex] = clamp(this.T1[currentMatrixIndex] + fluidDelta, 1e-5, 0.95);
      }

      let fpRowSum = 0.0;
      const rowOffset = currDigit * 10;
      for (let j = 0; j < 10; j++) fpRowSum += this.T1[rowOffset + j];
      if (fpRowSum > 0) {
        const invFpSum = 1.0 / fpRowSum;
        for (let j = 0; j < 10; j++) this.T1[rowOffset + j] *= invFpSum;
      }
    }

    // =========================================================================
    // 5. ADVANCED MODULE: HIDDEN MARKOV MODEL VITERBI REGIME PATH DECODER
    // =========================================================================
    let decodedHiddenRegimeState = 0;
    {
      const viterbiSteps = Math.min(N, 100);
      const sliceStart = N - viterbiSteps;

      const initialObservation = this.buffer[sliceStart];
      for (let s = 0; s < 3; s++) {
        this.viterbi_matrix[0 * 3 + s] = Math.log(0.333) + Math.log(this.hmm_B[s * 10 + initialObservation] + 1e-6);
        this.viterbi_pointer[0 * 3 + s] = 0;
      }

      for (let t_step = 1; t_step < viterbiSteps; t_step++) {
        const obs = this.buffer[sliceStart + t_step];
        const currentStepOffset = t_step * 3;
        const previousStepOffset = (t_step - 1) * 3;

        for (let j_state = 0; j_state < 3; j_state++) {
          let maxLogProb = Number.NEGATIVE_INFINITY;
          let bestBackpointer = 0;
          const logEmission = Math.log(this.hmm_B[j_state * 10 + obs] + 1e-6);

          for (let i_state = 0; i_state < 3; i_state++) {
            const logTrans = Math.log(this.hmm_A[i_state * 3 + j_state]);
            const totalPathProb = this.viterbi_matrix[previousStepOffset + i_state] + logTrans;
            
            if (totalPathProb > maxLogProb) {
              maxLogProb = totalPathProb;
              bestBackpointer = i_state;
            }
          }

          this.viterbi_matrix[currentStepOffset + j_state] = maxLogProb + logEmission;
          this.viterbi_pointer[currentStepOffset + j_state] = bestBackpointer;
        }
      }

      let maxFinalLogProb = Number.NEGATIVE_INFINITY;
      let bestFinalState = 0;
      const finalStepOffset = (viterbiSteps - 1) * 3;
      
      for (let s = 0; s < 3; s++) {
        if (this.viterbi_matrix[finalStepOffset + s] > maxFinalLogProb) {
          maxFinalLogProb = this.viterbi_matrix[finalStepOffset + s];
          bestFinalState = s;
        }
      }
      decodedHiddenRegimeState = bestFinalState;
    }
  // ---- QUANTUM WAVEFUNCTION SUPERPOSITION AND PHASE MEMORY SHIFTS ----
  private readonly quantum_psi_real = new Float64Array(10); // Real component of structural wavefunction amplitude vector ψ
  private readonly quantum_psi_imag = new Float64Array(10); // Imaginary phase component of structural wavefunction amplitude vector ψ
  private readonly quantum_hamiltonian = new Float64Array(100); // 10x10 Self-adjoint Potential Energy Operator Matrix H
  private readonly quantum_interference = new Float64Array(10); // Extracted constructive/destructive node density arrays

  // ---- VOLTERRA INTEGRO-DIFFERENTIAL VOLATILITY MEMORY KERNELS ----
  private readonly volterra_kernel = new Float64Array(64); // Exponentially decaying non-local memory weights h(t)
  private readonly volterra_feedback = new Float64Array(10); // History integrated drag coefficients per digit profile

  // ---- MULTIFRACTAL DETRENDED FLUCTUATION ANALYSIS REGIME MATRICES ----
  private readonly mdfa_segments = new Float64Array(32); // Sliced local variance profile mappings Y_s(t)
  private readonly mdfa_fluctuations = new Float64Array(5); // Multi-scale exponents q-order variance fields [-2, -1, 0, 1, 2]
  private mdfa_singularity_alpha: number = 0.50; // Central singularity tracking exponent α
  private mdfa_spectrum_f: number = 1.00; // Localized fractal dimension scaling boundary f(α)


    // 1b. Fuse Unified Physics + Order 1..7+ VMM + Context prior into current state row
    if (input.unifiedPrior && input.unifiedPrior.length === 10) {
      const currOffset = currDigit * 10;
      let blendSum = 0;
      for (let j = 0; j < 10; j++) {
        const pPrior = Math.max(1e-6, input.unifiedPrior[j]);
        this.T1[currOffset + j] = 0.65 * this.T1[currOffset + j] + 0.35 * pPrior;
        blendSum += this.T1[currOffset + j];
      }
      if (blendSum > 0) {
        for (let j = 0; j < 10; j++) this.T1[currOffset + j] /= blendSum;
      }
    }
    // 2. Matrix Exponentiation for Landing Probability M^D
    this.matPower10x10(this.T1, D, this.TD);

    // 3. Wald-Wolfowitz Runs Test on Parity (scaled to buffer size)
    let runs = 1;
    let nEven = 0;
    for (let i = 0; i < N; i++) {
      if (this.buffer[i] % 2 === 0) nEven++;
      if (i > 0 && this.buffer[i] % 2 !== this.buffer[i - 1] % 2) {
        runs++;
      }
    }
    const nOdd = N - nEven;
    const muR = (2.0 * nEven * nOdd) / N + 1.0;
    const varR = (2.0 * nEven * nOdd * (2.0 * nEven * nOdd - N)) / (N * N * (N - 1));
    const zRun = (runs - muR) / (Math.sqrt(varR) + 1e-6);

    // 4. Micro-window KL Divergence (last microWindow ticks)
    this.freqMicro.fill(0);
    const microStart = N - this.microWindow;
    for (let i = microStart; i < N; i++) {
      this.freqMicro[this.buffer[i]]++;
    }
    let dKl = 0.0;
    for (let i = 0; i < 10; i++) {
      const p = (this.freqMicro[i] + 1e-5) / this.microWindow;
      dKl += p * Math.log2(p / 0.1);
    }
    this.emaKl = (1.0 - this.alpha) * this.emaKl + this.alpha * dKl;

    // 5. KS Drift vs Discrete Uniform
    let empCdf = 0.0;
    let ksDrift = 0.0;
    for (let i = 0; i < 10; i++) {
      empCdf += this.freq100[i] / N;
      const uniCdf = (i + 1) * 0.1;
      const diff = Math.abs(empCdf - uniCdf);
      if (diff > ksDrift) ksDrift = diff;
    }

    // 6. AMI with Miller-Madow Bias Correction
    //    lag-D value (draft semantics) + full lag sweep k = 1..7 (blueprint §6.4)
    const amiLags: number[] = [];
    const maxLag = Math.min(7, N - 21);
    for (let k = 1; k <= maxLag; k++) amiLags.push(this.amiAtLag(k));
    const amiBits = D <= maxLag && maxLag > 0 ? amiLags[D - 1] : maxLag > 0 ? this.amiAtLag(Math.min(D, maxLag)) : 0;

    // 6b. LZW compression ratio (blueprint §6.5)
    const lzw = this.lzwRatio();
    const hurstH = this.computeHurst();

    // 6c. CUSUM / Page-Hinkley regime-shift monitor (blueprint §6.6).
    //     S_k = max(0, S_{k-1} + (X_k − μ − allowance)); shift when S_k > h.
    //     On shift, adaptive thresholds decay-reset to avoid stale projections.
    let mean = 0;
    for (let i = 0; i < N; i++) mean += this.buffer[i];
    mean /= N;
    let cusumShift = false;
    for (let i = microStart; i < N; i++) {
      this.cusumAcc = Math.max(0, this.cusumAcc + (this.buffer[i] - mean - 0.5));
      if (this.cusumAcc > 18) {
        cusumShift = true;
        this.cusumAcc = 0;
        this.emaKl = 0.2;
      }
    }

    // 7. Scaled Fatigue & Streak Filter
    this.freqTail.fill(0);
    const tailStart = N - this.tailWindow;
    const streakedDigits = new Set<number>();

    for (let i = tailStart; i < N; i++) {
      this.freqTail[this.buffer[i]]++;
      if (i > tailStart && this.buffer[i] === this.buffer[i - 1]) {
        streakedDigits.add(this.buffer[i]);
      }
    }

    const recentSet = new Set<number>();
    for (let i = N - this.recentWindow; i < N; i++) {
      recentSet.add(this.buffer[i]);
    }
    const countRecent = new Int32Array(10);
    for (let i = N - this.countWindow; i < N; i++) {
      countRecent[this.buffer[i]]++;
    }

    const freshPool: number[] = [];
    const tiredPool: number[] = [];

    for (let d = 0; d < 10; d++) {
      const isTired = recentSet.has(d) || countRecent[d] >= 2 || streakedDigits.has(d);
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

    // Never fall back to tired targets for Matches. If none are fresh, no signal.
    if (freshPool.length === 0 && (input.market ?? "matches") === "matches") return null;
    // Rank candidates STRICTLY by exact multi-appearance probability
    const eligiblePool = freshPool.slice();
    eligiblePool.sort((a, b) => digitMetrics[b].multiHitProb - digitMetrics[a].multiHitProb);
    const topPick = eligiblePool.length > 0 ? eligiblePool[0] : 0;
    if (freshPool.includes(topPick)) digitMetrics[topPick].status = "TOP_PICK";

      // Unified Advanced Physics Market Regime Classification (Overridden by Viterbi path tracking calculations)
    let regime: EngineResult["regime"] = "BALANCED_RANDOM";
    if (decodedHiddenRegimeState === 1) regime = "PARITY_CLUSTERING";
    else if (decodedHiddenRegimeState === 2) regime = "MEAN_REVERTING";

    const market = input.market ?? "matches";
    const barrier = clamp(Math.round(input.barrier ?? 4), 0, 9);

    // 8b. Market-specific horizon blocks (v3)
    const deadZoneLimit = (input.navThresholds?.deadZoneThresholdPct ?? 10) / 100;
    const overUnder = this.computeOverUnder(currOffset, barrier, deadZoneLimit);
    const evenOdd = this.computeParity(currOffset);
    const riseFall = this.computeDirection();

    const fmtPrice = input.price > 0 ? input.price.toFixed(input.pip) : "";
    const is1sSymbol = input.symbol.startsWith("1HZ");
    const pingThresholdMs = is1sSymbol ? 350 : 500;
    const actualRtt = input.rttMs ?? Number.POSITIVE_INFINITY;
    const pingOk = Number.isFinite(actualRtt) && actualRtt < pingThresholdMs;

    // 8c. Target Configurations & Master Confluence Gate Calculations
    const targetDigit = clamp(Math.round(input.predictDigit ?? 0), 0, 9);
    
    const isTargetEven = targetDigit % 2 === 0;
    const isMacroEvenDominant = evenOdd ? evenOdd.pEven > evenOdd.pOdd : true;
    const parityMatch = isTargetEven === isMacroEvenDominant;

    const isTargetHigh = targetDigit >= 5;
    const isMacroHighDominant = overUnder ? overUnder.pOver > overUnder.pUnder : true;
    const zoneMatch = isTargetHigh === isMacroHighDominant;

    // Confluence passes if target aligns with dominant macro waves OR macro is flat (within 4% noise)
    const parityIsFlat = evenOdd ? Math.abs(evenOdd.pEven - evenOdd.pOdd) < 0.04 : true;
    const zoneIsFlat = overUnder ? Math.abs(overUnder.pOver - overUnder.pUnder) < 0.04 : true;
    
    const macroConfluencePass = (parityMatch || parityIsFlat) && (zoneMatch || zoneIsFlat);

    // 8d. Bias-corrected Shannon Entropy Z-score over the buffer
    let shannonH = 0;
    let observedBins = 0;
    for (let d = 0; d < 10; d++) {
      if (this.freq100[d] > 0) {
        observedBins++;
        const p = this.freq100[d] / N;
        shannonH -= p * Math.log2(p);
      }
    }
    const mmCorr = (observedBins - 1) / (2 * N * Math.LN2);
    const hMax = Math.log2(10);
    const hStd = Math.sqrt(4.5) / (N * Math.LN2);
    const entropyZ = hStd > 0 ? (shannonH + mmCorr - hMax) / hStd : 0;

    const tm = digitMetrics[targetDigit];
    const targetFresh = freshPool.includes(targetDigit);
    const navRulesEnabled = !!input.navRules && Object.values(input.navRules).some(Boolean);
    
    const pMarkovDTarget = this.TD[currOffset + targetDigit];
    const pMarkov1Target = this.T1[currOffset + targetDigit];
    const win = Array.from(this.buffer.subarray(0, N));

    // Evaluate the trigger rules checklist
    const navRuleHits = buildNavRuleHits(
      targetDigit,
      tm,
      targetFresh,
      input.navRules,
      input.navThresholds,
      evenOdd,
      overUnder,
      currDigit,
      this.freq100[targetDigit],
      N,
      entropyZ,
      pMarkovDTarget,
      hurstH,
      win,
      D,
      pMarkov1Target,
    );
    
    // Push master confluence feedback into your panel UI list
    navRuleHits.push({
      rule: "macroConfluence",
      label: NAV_RULE_LABELS.macroConfluence,
      enabled: !!input.navRules?.macroConfluence,
      pass: macroConfluencePass,
      detail: `Parity:${parityMatch ? "✓" : "✗"} Zone:${zoneMatch ? "✓" : "✗"} (Target ${targetDigit})`,
    });

    const matchesReady =
      navRulesEnabled &&
      input.market === "matches" &&
      targetDigit === input.predictDigit &&
      navRuleHits.every((h) => !h.enabled || h.pass);

    // Consolidated market view state managers
    let marketAction = "";
    let marketEdge = 0;
    let marketScore = 0;
    let marketRecProb = 0;

    if (market === "overunder" && overUnder) {
      if (overUnder.rec !== "HOLD") {
        marketAction = `${overUnder.rec} ${overUnder.barrier}`;
        marketRecProb = overUnder.prob;
        const baseline = overUnder.rec === "OVER" ? overUnder.baselineOver : overUnder.baselineUnder;
        marketEdge = overUnder.prob - baseline;
        marketScore = Math.max(0, marketEdge);
      }
    } else if (market === "evenodd" && evenOdd) {
      if (evenOdd.rec !== "HOLD") {
        marketAction = evenOdd.rec;
        marketRecProb = evenOdd.prob;
        marketEdge = evenOdd.prob - 0.5;
        marketScore = Math.max(0, marketEdge);
      }
    } else if (market === "risefall" && riseFall) {
      if (riseFall.rec !== "HOLD") {
        marketAction = riseFall.rec;
        marketRecProb = riseFall.prob;
        marketEdge = riseFall.prob - 0.5;
        marketScore = Math.max(0, marketEdge);
      }
    } else if (market === "differs") {
      const selectedTarget = clamp(Math.round(input.predictDigit ?? 0), 0, 9);
      const targetLanding = digitMetrics[selectedTarget].landingProb;
      const pDiffers = 1.0 - targetLanding;
      marketAction = `DIFFERS ${selectedTarget}`;
      marketRecProb = pDiffers;
      marketEdge = pDiffers - 0.90;
      marketScore = Math.max(0, marketEdge);
        } else {
      marketAction = `DIGIT ${topPick}`;
      // Extract the maximum directional wave probability tracking your dynamic top pick digit
      const macroCeilingEdge = evenOdd && overUnder ? Math.max(evenOdd.prob, overUnder.prob) : 0.85;
      marketRecProb = macroCeilingEdge;
      marketEdge = macroCeilingEdge - 0.50;
      marketScore = marketEdge;
    }

    // 9. Alert decision — dual ping gates + market-aware probability floors.
    let alertDecision: EngineResult["alertDecision"] = "HOLD / NO SIGNAL";
    
        if (!pingOk) {
      alertDecision = "HOLD / UNSAFE LATENCY";
    } else if (market === "matches") {
      let allSelectedPass = true;
      let selectedCount = 0;
      const checkedRules = input.navRules ?? {};

      for (const ruleKey in checkedRules) {
        if (checkedRules[ruleKey as keyof typeof checkedRules]) {
          selectedCount++;
          const match = navRuleHits.find((h) => h.rule === ruleKey);
          if (match && !match.pass) {
            allSelectedPass = false;
          }
        }
      }

      const combinedMatchesReady = selectedCount > 0 && allSelectedPass;

      if (combinedMatchesReady) alertDecision = "READY / MANUAL ALERT";
      else if (selectedCount > 0) alertDecision = "HOLD / RULES NOT MET";
      else alertDecision = "HOLD / NO SIGNAL";
    } else if (market === "differs") {
      let allSelectedPass = true;
      let selectedCount = 0;
      const checkedRules = input.navRules ?? {};

      for (const ruleKey in checkedRules) {
        if (checkedRules[ruleKey as keyof typeof checkedRules]) {
          selectedCount++;
          const match = navRuleHits.find((h) => h.rule === ruleKey);
          if (match && !match.pass) {
            allSelectedPass = false;
          }
        }
      }
          
      const differsCeiling = (input.navThresholds?.differsProbabilityCeilingPct ?? 12) / 100;
      const differsColdGapMin = input.navThresholds?.differsColdGapMin ?? 5;
      const targetLanding = tm.landingProb;
      const targetColdGap = N - 1 - (this.buffer.lastIndexOf(targetDigit));
      
      const differsMathReady = targetLanding <= differsCeiling && targetColdGap >= differsColdGapMin;
      const combinedDiffersReady = differsMathReady && (selectedCount === 0 || allSelectedPass);

      if (combinedDiffersReady) alertDecision = "READY / MANUAL ALERT";
      else alertDecision = "HOLD / RULES NOT MET";
    } else if (market === "overunder") {
      if (overUnder?.deadZone) {
        alertDecision = "HOLD / DEAD ZONE";
      } else if (overUnder && overUnder.rec !== "HOLD") {
        if (barrier === 0 || barrier === 9) {
          if (overUnder.pTie < 0.15 && overUnder.prob >= 0.85) {
            alertDecision = "READY / MANUAL ALERT";
          }
        } else {
          const isImbalance = overUnder.prob > 0.65 && overUnder.pTie < 0.07;
          const isEdgeOk = (overUnder.prob - (overUnder.rec === "OVER" ? overUnder.baselineOver : overUnder.baselineUnder)) >= NAV_EDGE_FLOOR && overUnder.pTie < deadZoneLimit;
          if (isImbalance || isEdgeOk) {
            alertDecision = "READY / MANUAL ALERT";
          }
        }
      }
    } else if (market === "evenodd") {
      if (evenOdd && evenOdd.rec !== "HOLD" && marketEdge >= NAV_EDGE_FLOOR) alertDecision = "READY / MANUAL ALERT";
    } else if (market === "risefall") {
      if (riseFall && riseFall.rec !== "HOLD" && marketEdge >= NAV_EDGE_FLOOR) alertDecision = "READY / MANUAL ALERT";
    }
    const decisionSignature = alertDecisionSignature({
      symbol: input.symbol,
      market,
      duration: D,
      predictDigit: targetDigit,
      barrier,
      navRules: input.navRules,
      navThresholds: input.navThresholds,
    });

    return {
      symbol: input.symbol,
      market,
      tickId: input.tickId ?? -1,
      decisionSignature,
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
      bufferSize: N,
      bufferFilled: this.count,
      runsZScore: zRun,
      klDivergence: dKl,
      ksDrift,
      amiBits,
      amiLags,
      lzwRatio: lzw,
      hurstH,
      cusum: this.cusumAcc,
      cusumShift,
      regime,
      adaptiveKlThreshold: this.emaKl,
      freshPool,
      tiredPool,
      digits: digitMetrics,
      overUnder,
      evenOdd,
      riseFall,
      marketAction,
      marketEdge,
      marketScore,
      marketRecProb,
      navTargetDigit: targetDigit,
      navTargetFresh: targetFresh,
      navRulesEnabled,
      navRuleHits,
      executionCutoffMs: NAV_EXECUTION_CUTOFF_MS,
      rttMs: Number.isFinite(actualRtt) ? actualRtt : 0,
      pingThresholdMs,
      latencyGatePassed: pingOk,
      alertDecision,
      analyzeMs: performance.now() - t0,
    };
  }

    /** Over/Under horizon engine (v3):
   *  3-way contract probabilities for 1..8:
   *    P(Under) = Σ_{d < barrier} [M^D]_{s0,d}
   *    P(Over)  = Σ_{d > barrier} [M^D]_{s0,d}
   *    P(Tie)   = [M^D]_{s0,barrier} (House edge: both Over and Under lose)
   *  Sum is strictly 100%.
   *  Boundaries:
   *    Barrier 0: Over 0 only (digits 1-9 win, 0 loses). P(Under) = 0.
   *    Barrier 9: Under 9 only (digits 0-8 win, 9 loses). P(Over) = 0.
   */
    private computeOverUnder(currOffset: number, barrier: number, deadZoneLimit = NAV_TIE_DEAD_ZONE): OverUnderBlock {
    const N = this.bufferSize;
    let rawOver = 0.0;
    let rawUnder = 0.0;
    for (let d = 0; d < 10; d++) {
      const p = this.TD[currOffset + d];
      if (d > barrier) rawOver += p;
      else if (d < barrier) rawUnder += p;
    }
    const pTie = this.TD[currOffset + barrier];

    // Exact contract probabilities (without inflating out the tie)
    const pOver = rawOver;
    const pUnder = rawUnder;

    let baseOverCount = 0;
    let baseUnderCount = 0;
    for (let d = 0; d < 10; d++) {
      if (d > barrier) baseOverCount += this.freq100[d];
      else if (d < barrier) baseUnderCount += this.freq100[d];
    }
    const baselineOver = N > 0 ? baseOverCount / N : 0;
    const baselineUnder = N > 0 ? baseUnderCount / N : 0;

    let microOverCount = 0;
    let microUnderCount = 0;
    for (let d = 0; d < 10; d++) {
      if (d > barrier) microOverCount += this.freqMicro[d];
      else if (d < barrier) microUnderCount += this.freqMicro[d];
    }
    const microOver = this.microWindow > 0 ? microOverCount / this.microWindow : 0;
    const microUnder = this.microWindow > 0 ? microUnderCount / this.microWindow : 0;
    const momentumOver = microOver - baselineOver;
    const momentumUnder = microUnder - baselineUnder;

        // Dead Zone Filter:
    // - 3-way middle barriers (1..8): block if barrier tie >= 10% (lose-lose risk)
    // - 2-way boundaries (0 & 9): block only if losing digit >= 15% (keeps <85% win rate out)
    const isBoundary = barrier === 0 || barrier === 9;
    const deadZone = isBoundary ? pTie >= (deadZoneLimit * 1.5) : pTie >= deadZoneLimit;
    let rec: OverUnderBlock["rec"] = "HOLD";
    let prob = 0;
    let velocity = 0;

    if (barrier === 0) {
      // Boundary 0: 2-way contract. Deriv allows Over 0 only (digits 1-9 win, 0 loses)
      prob = pOver;
      velocity = momentumOver;
      if (!deadZone && pOver >= 0.85 && (momentumOver >= 0 || pOver >= baselineOver)) {
        rec = "OVER";
      }
    } else if (barrier === 9) {
      // Boundary 9: 2-way contract. Deriv allows Under 9 only (digits 0-8 win, 9 loses)
      prob = pUnder;
      velocity = momentumUnder;
      if (!deadZone && pUnder >= 0.85 && (momentumUnder >= 0 || pUnder >= baselineUnder)) {
        rec = "UNDER";
      }
    } else {
      // Middle barriers 1..8: 3-way probabilities (Tie loses both sides)
      // Imbalance Trigger: Only trade Under X if P(Under) > 65% AND P(Barrier) < 7%
      // Symmetrically: Only trade Over X if P(Over) > 65% AND P(Barrier) < 7%
      const canUnder = pUnder > 0.65 && pTie < 0.07;
      const canOver = pOver > 0.65 && pTie < 0.07;

      if (!deadZone) {
        if (canUnder && (!canOver || pUnder >= pOver)) {
          rec = "UNDER";
          prob = pUnder;
          velocity = momentumUnder;
        } else if (canOver && (!canUnder || pOver >= pUnder)) {
          rec = "OVER";
          prob = pOver;
          velocity = momentumOver;
        } else {
          // Score comparison if within acceptable tie risk (<10%) and edge is present
          const overScore = pOver + Math.max(0, momentumOver);
          const underScore = pUnder + Math.max(0, momentumUnder);
          if (overScore > underScore && pOver - baselineOver >= 0.05) {
            rec = "OVER";
            prob = pOver;
            velocity = momentumOver;
          } else if (underScore > overScore && pUnder - baselineUnder >= 0.05) {
            rec = "UNDER";
            prob = pUnder;
            velocity = momentumUnder;
          } else {
            rec = "HOLD";
            prob = Math.max(pOver, pUnder);
            velocity = pOver >= pUnder ? momentumOver : momentumUnder;
          }
        }
      } else {
        rec = "HOLD";
        prob = Math.max(pOver, pUnder);
        velocity = pOver >= pUnder ? momentumOver : momentumUnder;
      }
    }

    return {
      barrier,
      pOver,
      pUnder,
      pTie,
      baselineOver,
      baselineUnder,
      deadZone,
      momentumOver,
      momentumUnder,
      rec,
      prob,
      velocity,
    };
  }

  /** Even/Odd horizon engine (v3): P(Even) = Σ_{even d} [M^D]_{s0,d} via
   *  matrix exponentiation, corroborated by the Wald–Wolfowitz runs Z and
   *  micro-window parity momentum. */
  private computeParity(currOffset: number): ParityBlock {
    const N = this.bufferSize;
    let pEven = 0.0;
    for (let d = 0; d < 10; d += 2) pEven += this.TD[currOffset + d];
    const pOdd = 1.0 - pEven;

    let baseEven = 0;
    for (let d = 0; d < 10; d += 2) baseEven += this.freq100[d];
    const baselineEven = baseEven / N;
    const baselineOdd = 1.0 - baselineEven;

    let microEven = 0;
    for (let d = 0; d < 10; d += 2) microEven += this.freqMicro[d];
    const microEvenFrac = microEven / this.microWindow;
    const momentumEven = microEvenFrac - baselineEven;
    const momentumOdd = 1.0 - microEvenFrac - baselineOdd;

    let rec: ParityBlock["rec"] = "HOLD";
    let prob = 0;
    let velocity = 0;
    const evenScore = pEven + Math.max(0, momentumEven);
    const oddScore = pOdd + Math.max(0, momentumOdd);
    if (evenScore >= oddScore) {
      rec = "EVEN";
      prob = pEven;
      velocity = momentumEven;
    } else {
      rec = "ODD";
      prob = pOdd;
      velocity = momentumOdd;
    }
    if (Math.abs(pEven - 0.5) < 0.02 && Math.abs(momentumEven) < 0.05) rec = "HOLD";
    return { pEven, pOdd, baselineEven, momentumEven, momentumOdd, rec, prob, velocity };
  }

  /** Rise/Fall direction engine (v3): pure price-increment analysis —
   *  ΔS = S_t − S_{t−1} — fully separated from digit modulo arithmetic.
   *  Tracks baseline vs micro-window up/down fractions (momentum) and the
   *  current directional run length. */
  private computeDirection(): DirectionBlock {
    const total = Math.min(this.deltaCount, 64);
    const flat: DirectionBlock = {
      pRise: 0.5,
      pFall: 0.5,
      baselineUp: 0.5,
      momentumRise: 0,
      momentumFall: 0,
      runLength: 0,
      runDir: "FLAT",
      rec: "HOLD",
      prob: 0,
      velocity: 0,
    };
    if (total < 5) return flat;

    // Baseline fractions over the whole ΔS ring (oldest → newest).
    let up = 0;
    let down = 0;
    for (let i = 0; i < total; i++) {
      const d = this.deltas[i % 64];
      if (d > 0) up++;
      else if (d < 0) down++;
    }
    const denom = up + down;
    if (denom === 0) return flat;
    const baselineUp = up / denom;
    const baselineDown = down / denom;

    // Micro-window (last 12 increments) momentum.
    const microN = Math.min(12, total);
    let microUp = 0;
    let microDown = 0;
    for (let i = total - microN; i < total; i++) {
      const d = this.deltas[i % 64];
      if (d > 0) microUp++;
      else if (d < 0) microDown++;
    }
    const microDenom = microUp + microDown || 1;
    const microUpFrac = microUp / microDenom;
    const microDownFrac = microDown / microDenom;
    const momentumRise = microUpFrac - baselineUp;
    const momentumFall = microDownFrac - baselineDown;

    // Momentum-adjusted horizon probability.
    const pRise = clamp(baselineUp + 0.6 * momentumRise, 0.05, 0.95);
    const pFall = 1 - pRise;

    // Current directional run length (trailing same-sign increments).
    let runLength = 0;
    let runDir: DirectionBlock["runDir"] = "FLAT";
    for (let i = total - 1; i >= 0; i--) {
      const d = this.deltas[i % 64];
      if (d === 0) break;
      const dir = d > 0 ? "UP" : "DOWN";
      if (runDir === "FLAT") {
        runDir = dir;
        runLength = 1;
      } else if (dir === runDir) {
        runLength++;
      } else break;
    }

    let rec: DirectionBlock["rec"] = "HOLD";
    let prob = 0;
    let velocity = 0;
    const riseScore = pRise + Math.max(0, momentumRise);
    const fallScore = pFall + Math.max(0, momentumFall);
    if (riseScore >= fallScore) {
      rec = "RISE";
      prob = pRise;
      velocity = momentumRise;
    } else {
      rec = "FALL";
      prob = pFall;
      velocity = momentumFall;
    }
    if (Math.abs(pRise - 0.5) < 0.02 && Math.abs(momentumRise) < 0.05) rec = "HOLD";
    return {
      pRise,
      pFall,
      baselineUp,
      momentumRise,
      momentumFall,
      runLength,
      runDir,
      rec,
      prob,
      velocity,
    };
  }
}
