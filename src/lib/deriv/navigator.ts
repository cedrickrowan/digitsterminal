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
  /** Live session scorecard edge % (realized - expected) and settled count. */
  sessionEdgePct?: number;
  sessionSettledCount?: number;
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
  lorenzWing: "LEFT" | "RIGHT"; // Lorenz strange-attractor lobe (x < 0 vs x >= 0)
  lorenzFlip: boolean; // true when trajectory crosses x = 0 between butterfly wings
  lorenzEnergy: number; // normalized Lorenz z-axis attractor energy (0..1+)
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
  lorenzStable: "Lorenz Wing Stable",
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
  /** Raw numeric metric for tick-over-tick directional slope filtering. */
  metric?: number;
  /** "up" = must strictly increase; "down" = must strictly decrease; "none" = binary gate. */
  slopeDir?: "up" | "down" | "none";
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
  contractProbs: { step: number; prob: number }[] = [],
  market: Market = "matches",
  lorenzWing: "LEFT" | "RIGHT" = "RIGHT",
  lorenzFlip: boolean = false,
): NavRuleHit[] {
  const t = thr ?? NAV_THRESHOLDS_DEFAULT;
  const on = (k: keyof NavRuleToggles) => !!rules?.[k];
  const hits: NavRuleHit[] = [];

  // ==================== 7 LEGACY RULES ====================
    // 1. Ensemble Bayesian fusion
  const ens = win.length >= 10 ? ensemblePredict(win, duration) : null;
  const ensConfPct = ens ? ens.confidence * 100 : 0;
  const ensPass = !!ens && ens.topDigit === target && ensConfPct > (t.triggerEnsembleAbove ?? 22);
  hits.push({
    rule: "ensemble",
    label: NAV_RULE_LABELS.ensemble,
    enabled: on("ensemble"),
    pass: ensPass,
    metric: ensConfPct,
    slopeDir: "up",
    detail: ens
      ? `→${ens.topDigit} ${ensConfPct.toFixed(0)}% > ${t.triggerEnsembleAbove}%`
      : "insufficient history",
  });

  // 2. 1-step Markov transition P(target | currDigit)
  const pMarkov1Pct = pMarkov1Target * 100;
  hits.push({
    rule: "markov",
    label: NAV_RULE_LABELS.markov,
    enabled: on("markov"),
    pass: pMarkov1Pct > (t.triggerMarkovAbove ?? 18),
    metric: pMarkov1Pct,
    slopeDir: "up",
    detail: `P(${target}|${currDigit})=${pMarkov1Pct.toFixed(0)}% > ${t.triggerMarkovAbove}%`,
  });

  // 3. Trailing streak of target digit
  const stk = tailStreak(win);
  const stkLen = stk.digit === target ? stk.len : 0;
  const stkPass = stk.digit === target && stk.len >= (t.triggerStreak ?? 3);
  hits.push({
    rule: "streak",
    label: NAV_RULE_LABELS.streak,
    enabled: on("streak"),
    pass: stkPass,
    metric: stkLen,
    slopeDir: "up",
    detail: stk.digit === target ? `${stk.len}×${stk.digit} ≥ ${t.triggerStreak}` : `streak=0 (last=${currDigit})`,
  });

  // 4. Frequency below threshold (reversion — strengthens as frequency drops)
  const targetFreqPct = bufferSize > 0 ? (targetFreq / bufferSize) * 100 : 10;
  hits.push({
    rule: "prob",
    label: NAV_RULE_LABELS.prob,
    enabled: on("prob"),
    pass: targetFreqPct < (t.triggerProbBelow ?? 8),
    metric: targetFreqPct,
    slopeDir: "down",
    detail: `freq ${targetFreqPct.toFixed(1)}% < ${t.triggerProbBelow}%`,
  });

   // 5. Sequence followup across bot contract stride (C1..Max Contracts, skipping Bot Jump ticks)
  const entryDelay = Math.max(0, Number(t.entryDelayTicks ?? 1));
  const jumpTicks = Math.max(0, Number(t.botJumpTicks ?? 3));
  const maxRuns = Math.min(20, Math.max(1, Math.floor(Number(t.maxContracts ?? 5))));
  const firstSettle = entryDelay + Math.max(1, duration);
  const patternLen = Math.max(1, duration);
  const pattern = win.slice(-Math.min(patternLen, win.length));

  let bestSeq = sequenceFollowups(win, pattern, firstSettle);
  let bestStep = firstSettle;
  let bestPSeq = (bestSeq.probs[target] ?? 0) * 100;
  let strideHits = 0;
  let strideSamples = 0;

  if (jumpTicks > 0 && maxRuns > 1) {
    for (let c = 0; c < maxRuns; c++) {
      const cStep = firstSettle + c * (jumpTicks + Math.max(1, duration));
      const s = sequenceFollowups(win, pattern, cStep);
      if (s.total >= 3) {
        strideSamples++;
        const probPct = (s.probs[target] ?? 0) * 100;
        if (probPct > (t.triggerSequenceAbove ?? 20)) strideHits++;
        if (probPct > bestPSeq) {
          bestPSeq = probPct;
          bestSeq = s;
          bestStep = cStep;
        }
      }
    }
  } else {
    if (bestSeq.total >= 3) {
      strideSamples = 1;
      if (bestPSeq > (t.triggerSequenceAbove ?? 20)) strideHits = 1;
    }
  }

  hits.push({
    rule: "sequence",
    label: NAV_RULE_LABELS.sequence,
    enabled: on("sequence"),
    pass: strideSamples > 0 && bestPSeq > (t.triggerSequenceAbove ?? 20),
    metric: bestPSeq,
    slopeDir: "up",
    detail: jumpTicks > 0 && maxRuns > 1
      ? `[${bestSeq.pattern.join("")}]→+${bestStep} ${bestPSeq.toFixed(0)}% (${strideHits}/${strideSamples} runs) > ${t.triggerSequenceAbove}%`
      : `[${bestSeq.pattern.join("")}]→+${bestStep} ${bestPSeq.toFixed(0)}% > ${t.triggerSequenceAbove}%`,
  });
 
  // 6. Cold probability based on gap since last appearance (strengthens as cold P drops)
  const g = gapsSinceLast(win)[target] ?? bufferSize;
  const pCold = coldProb(g) * 100;
  hits.push({
    rule: "cold",
    label: NAV_RULE_LABELS.cold,
    enabled: on("cold"),
    pass: pCold < (t.triggerColdProbBelow ?? 10),
    metric: pCold,
    slopeDir: "down",
    detail: `gap=${g} P=${pCold.toFixed(1)}% < ${t.triggerColdProbBelow}%`,
  });

  // 7. Frequency deviation from 10% (|Δ| > min)
  const devPct = Math.abs(targetFreqPct - 10);
  hits.push({
    rule: "deviation",
    label: NAV_RULE_LABELS.deviation,
    enabled: on("deviation"),
    pass: devPct > (t.triggerDeviationPct ?? 4),
    metric: devPct,
    slopeDir: "up",
    detail: `|Δ|=${devPct.toFixed(1)}% > ${t.triggerDeviationPct}%`,
  });

  // ==================== 11 NAVIGATOR RULES ====================
  // 8. Multi-hit >= 2 in horizon
  const mHit = tm ? tm.multiHitProb * 100 : 0;
  const mHitThr = t.multiHitPct ?? 7;
  hits.push({
    rule: "multiHit",
    label: `Multi-hit ≥ 2 (${duration})`,
    enabled: on("multiHit"),
    pass: duration < 2 ? false : mHit >= mHitThr,
    metric: mHit,
    slopeDir: "up",
    detail: duration < 2 ? `Impossible (D < 2)` : `≥ ${mHitThr}% (Live: ${mHit.toFixed(1)}%)`,
  });

  // 9. Adjacent pair inside horizon
  hits.push({
    rule: "pairRun",
    label: NAV_RULE_LABELS.pairRun,
    enabled: on("pairRun"),
    pass: tm.pairProb >= t.pairRunPct / 100,
    metric: tm.pairProb,
    slopeDir: "up",
    detail: `pair ${pctOf(tm.pairProb)} ≥ ${t.pairRunPct}%`,
  });

   // 10. Exact Multi-Contract Settlement Peak (Contract 1 vs Contracts 2..4, skipping Bot Jump ticks)
  const delayTicks = Math.max(0, Number(t.entryDelayTicks ?? 1));
  const targetStep = delayTicks + duration;
  const notEarly = delayTicks === 0 || pMarkovDTarget >= pMarkov1Target;
  let strongerLaterContract: { idx: number; step: number; prob: number } | null = null;
  for (let i = 1; i < contractProbs.length; i++) {
    if (contractProbs[i].prob > pMarkovDTarget + 1e-6) {
      if (!strongerLaterContract || contractProbs[i].prob > strongerLaterContract.prob) {
        strongerLaterContract = { idx: i + 1, step: contractProbs[i].step, prob: contractProbs[i].prob };
      }
    }
  }
  const notLate = strongerLaterContract === null;
  hits.push({
    rule: "landing",
    label: NAV_RULE_LABELS.landing,
    enabled: on("landing"),
    pass: notEarly && notLate && pMarkovDTarget >= t.landingPct / 100,
    metric: pMarkovDTarget,
    slopeDir: "up",
    detail: !notEarly
      ? `blocked: delay t+${delayTicks} (${pctOf(pMarkov1Target)}) > C1 @ t+${targetStep}`
      : strongerLaterContract
        ? `blocked: C${strongerLaterContract.idx} @ t+${strongerLaterContract.step} (${pctOf(strongerLaterContract.prob)}) > C1 @ t+${targetStep}`
        : `C1 peak @ t+${targetStep} (${pctOf(pMarkovDTarget)} ≥ ${t.landingPct}%)`,
  });
 
    // 11. Anti-tired freshness (Matches requires FRESH; Differs requires TIRED on the spot)
  const freshnessPass = market === "differs" ? !fresh : fresh;
  hits.push({
    rule: "freshness",
    label: NAV_RULE_LABELS.freshness,
    enabled: on("freshness"),
    pass: freshnessPass,
    slopeDir: "none",
    detail: market === "differs"
      ? (!fresh ? "TIRED · differs ok" : "FRESH · suppressed for differs")
      : (fresh ? "FRESH · anti-tired ok" : "TIRED · suppressed"),
  });

  // 12. Parity confluence
  const even = target % 2 === 0;
  const pPar = parity ? (even ? parity.pEven : parity.pOdd) : 0;
  hits.push({
    rule: "parity",
    label: NAV_RULE_LABELS.parity,
    enabled: on("parity"),
    pass: !!parity && pPar >= t.parityPct / 100,
    metric: pPar,
    slopeDir: "up",
    detail: parity
      ? `P(${even ? "EVEN" : "ODD"}) ${pctOf(pPar)} ≥ ${t.parityPct}%`
      : "no parity block",
  });

  // 13. Over/Under barrier confluence
  let barrierPass = false;
  let barrierDetail = "no O/U block";
  let barrierProb = 0;
  if (ou) {
    if (ou.barrier === 0) {
      barrierPass = target > 0 && ou.rec === "OVER";
      barrierProb = ou.pOver;
      barrierDetail = `OVER 0 target ${target > 0 ? "ok" : "losing"}`;
    } else if (ou.barrier === 9) {
      barrierPass = target < 9 && ou.rec === "UNDER";
      barrierProb = ou.pUnder;
      barrierDetail = `UNDER 9 target ${target < 9 ? "ok" : "losing"}`;
    } else if (target === ou.barrier) {
      barrierDetail = `digit = barrier ${ou.barrier} · tie zone`;
    } else if (ou.deadZone) {
      barrierDetail = `dead zone P(tie) ${pctOf(ou.pTie)} ≥ 10%`;
    } else if (target > ou.barrier) {
      barrierPass = ou.rec === "OVER" && ou.pOver >= t.barrierPct / 100;
      barrierProb = ou.pOver;
      barrierDetail = `OVER ${pctOf(ou.pOver)} ≥ ${t.barrierPct}%`;
    } else {
      barrierPass = ou.rec === "UNDER" && ou.pUnder >= t.barrierPct / 100;
      barrierProb = ou.pUnder;
      barrierDetail = `UNDER ${pctOf(ou.pUnder)} ≥ ${t.barrierPct}%`;
    }
  }
  hits.push({
    rule: "barrier",
    label: NAV_RULE_LABELS.barrier,
    enabled: on("barrier"),
    pass: barrierPass,
    metric: barrierProb,
    slopeDir: "up",
    detail: barrierDetail,
  });

  // 14. Low-entropy regime (strengthens as entropy Z drops)
  hits.push({
    rule: "lowEntropy",
    label: NAV_RULE_LABELS.lowEntropy,
    enabled: on("lowEntropy"),
    pass: entropyZ <= t.entropyZMax,
    metric: entropyZ,
    slopeDir: "down",
    detail: `H-Z ${entropyZ.toFixed(2)} ≤ ${t.entropyZMax}`,
  });

  // 15. Anti-repeat filter (binary gate)
  const isRepeat = target === currDigit;
  hits.push({
    rule: "antiRepeat",
    label: NAV_RULE_LABELS.antiRepeat,
    enabled: on("antiRepeat"),
    pass: !isRepeat || on("pairRun"),
    slopeDir: "none",
    detail: isRepeat ? (on("pairRun") ? "repeat allowed by pairRun" : `repeat blocked (last = ${currDigit})`) : "no repeat ok",
  });

  // 16. Frequency envelope
  hits.push({
    rule: "frequencyEnvelope",
    label: NAV_RULE_LABELS.frequencyEnvelope,
    enabled: on("frequencyEnvelope"),
    pass: targetFreqPct >= t.frequencyMinPct && targetFreqPct <= t.frequencyMaxPct,
    metric: targetFreqPct,
    slopeDir: "up",
    detail: `freq ${targetFreqPct.toFixed(1)}% ∈ [${t.frequencyMinPct}%, ${t.frequencyMaxPct}%]`,
  });

  // 17. D-step Markov
  const markovDPct = pMarkovDTarget * 100;
  hits.push({
    rule: "markovD",
    label: NAV_RULE_LABELS.markovD,
    enabled: on("markovD"),
    pass: markovDPct >= t.markovDPct,
    metric: markovDPct,
    slopeDir: "up",
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
    metric: hurstEdge,
    slopeDir: "up",
    detail: `H=${hurstH.toFixed(2)} (${regimeTag} · |Δ|=${hurstEdge.toFixed(2)} ≥ ${minEdge.toFixed(2)})`,
  });

  // 19. Lorenz Attractor Wing Stability (binary gate — blocks chaotic x=0 wing-flip ticks)
  hits.push({
    rule: "lorenzStable",
    label: NAV_RULE_LABELS.lorenzStable,
    enabled: on("lorenzStable"),
    pass: !lorenzFlip,
    slopeDir: "none",
    detail: lorenzFlip ? "wing flip · regime shift" : `${lorenzWing} wing · stable`,
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
  private readonly prevLandingProb: Float64Array = new Float64Array(10).fill(-1);
  private readonly prevRuleMetrics: Map<string, number> = new Map();
  private lastSlopeTickId: number = -1;

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

  // Lorenz Strange Attractor Phase-Space State (σ=10, ρ=28, β=8/3)
  private lorenzX: number = 0.1;
  private lorenzY: number = 0.0;
  private lorenzZ: number = 25.0;

      // ---- PARALLEL DISCRETE PRNG ENGINE MEMORY STORAGE CHANNELS ----
  private cgr_x: number = 0.50;
  private cgr_y: number = 0.50;
  private readonly cgr_density_grid = new Float64Array(16);
  private renyi_entropy_q2: number = 3.32;
  private readonly renyi_window_history = new Float64Array(10);
  private readonly mrf_clique_potentials = new Float64Array(100);

  // ---- ADVANCED CONTEXT-TREE WEIGHTING (CTW) MEMORY STRUCTURES ----
  private readonly ctw_tree_counts = new Int32Array(4096 * 2); // Multi-order binary bit tracking dictionary tree nodes
  private readonly ctw_node_weights = new Float64Array(4096);  // Log-likelihood context tree blend estimators

  // ---- LINEAR FEEDBACK SHIFT REGISTER (LFSR) COMPLEXITY MONITORS ----
  private readonly bm_complexity_profile = new Int32Array(64); // Trailing history of computed complexity values
  private bm_current_linear_complexity: number = 32;          // System shift register length index (0..64)
  private readonly bm_scratch_C = new Int32Array(64);          // Berlekamp-Massey connectivity state tracker array
  private readonly bm_scratch_B = new Int32Array(64);          // Berlekamp-Massey historical feedback correction array
  // ---- HIDDEN MARKOV MODEL & VITERBI DECODER SCRATCH MATRICES ----
  private readonly hmm_A = new Float64Array(9);
  private readonly hmm_B = new Float64Array(30);
  private readonly viterbi_matrix = new Float64Array(300);
  private readonly viterbi_pointer = new Int32Array(300);

    constructor(bufferSize: number = NAV_BUFFER_SIZE) {
    const size = Math.round(clamp(bufferSize, 2, 900));
    this.bufferSize = size;
    this.buffer = new Uint8Array(size);
    
    this.microWindow = clamp(Math.round(size * 0.2), 3, 20);
    this.tailWindow = clamp(Math.round(size * 0.15), 3, 15);
    this.recentWindow = size <= 25 ? 3 : 4;
    this.countWindow = clamp(Math.round(size * 0.12), 3, 12);

    this.hmm_A.fill(1.0 / 3.0);
    for (let d = 0; d < 10; d++) {
      this.hmm_B[0 * 10 + d] = 0.10;
      this.hmm_B[1 * 10 + d] = (d % 2 === 0) ? 0.15 : 0.05;
      this.hmm_B[2 * 10 + d] = (d >= 3 && d <= 6) ? 0.16 : 0.06;
    }

    // Safe initialization anchors for structural discrete random number engine mappers
    this.cgr_x = 0.50;
    this.cgr_y = 0.50;
    this.cgr_density_grid.fill(0.0625); // Set uniform initial spatial coordinate probabilities
    this.mrf_clique_potentials.fill(0.10);
         // Clear and prepare Context-Tree Weighting memory node matrices safely
    this.ctw_tree_counts.fill(0);
    this.ctw_node_weights.fill(0.0);

    // Set initial structural complexity boundaries to maximum entropy state
    this.bm_current_linear_complexity = 32;
    this.bm_complexity_profile.fill(32);
    this.bm_scratch_C.fill(0);
    this.bm_scratch_B.fill(0);
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
    this.lorenzX = 0.1;
    this.lorenzY = 0.0;
    this.lorenzZ = 25.0;
    this.prevLandingProb.fill(-1);
    this.prevRuleMetrics.clear();
    this.lastSlopeTickId = -1;
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

   /** Exact probability of reaching a specified hit count in D future ticks matching the user's custom bot thresholds. */
    private computeHitCountProb(
    startDigit: number,
    targetDigit: number,
    D: number,
    requiredHits: number,
    bufA: Float64Array,
    bufB: Float64Array,
    botJump: number = 3,
    entryDelay: number = 1
  ): number {
    if (requiredHits <= 0) return 1.0;
    
    const initialDelay = entryDelay >= 0 ? entryDelay : 1; 
    const postContractRest = botJump >= 0 ? botJump : 0; 
    const isBotStrideMode = postContractRest > 0 || initialDelay > 0;
    
    const totalSteps = isBotStrideMode
      ? initialDelay + D + (requiredHits - 1) * (postContractRest + D)
      : D;
    if (totalSteps <= 0) return 0.0;

    const width = requiredHits + 1;
    bufA.fill(0);
    bufA[startDigit * width + 0] = 1.0;
    let current = bufA;
    let next = bufB;

    for (let step = 1; step <= totalSteps; step++) {
      next.fill(0);
      
      let isSettlement = false;
      if (isBotStrideMode) {
        const checkStep = step - initialDelay;
        if (checkStep > 0) {
          const cyclePeriod = D + postContractRest;
          const stepWithinCycle = (checkStep - 1) % cyclePeriod + 1;
          // Deriv evaluates outcome strictly on the final settlement tick
          if (stepWithinCycle === D) {
            isSettlement = true;
          }
        }
      } else {
        isSettlement = true;
      }

      for (let x = 0; x < 10; x++) {
        const rowOffset = x * 10;
        for (let c = 0; c <= requiredHits; c++) {
          const p = current[x * width + c];
          if (p === 0) continue;
          for (let y = 0; y < 10; y++) {
            const trans = this.T1[rowOffset + y];
            if (trans === 0) continue;
            const nc = isSettlement ? Math.min(requiredHits, c + (y === targetDigit ? 1 : 0)) : c;
            next[y * width + nc] += p * trans;
          }
        }
      }
      const tmp = current;
      current = next;
      next = tmp;
    }

    let result = 0.0;
    for (let x = 0; x < 10; x++) {
      result += current[x * width + requiredHits];
    }
    return Math.min(1.0, Math.max(0.0, result));
  }

    /** Exact probability of seeing a consecutive run matching the user's custom bot thresholds. */
    private computeRunAtLeastOnce(
    startDigit: number,
    targetDigit: number,
    D: number,
    runLength: number,
    bufA: Float64Array,
    bufB: Float64Array,
    botJump: number = 3,
    entryDelay: number = 1
  ): number {
    if (runLength <= 0) return 1.0;
    
    const initialDelay = entryDelay >= 0 ? entryDelay : 1; 
    const postContractRest = botJump >= 0 ? botJump : 0; 
    const isBotStrideMode = postContractRest > 0 || initialDelay > 0;
    
    const totalSteps = isBotStrideMode
      ? initialDelay + D + (runLength - 1) * (postContractRest + D)
      : D;
    if (totalSteps <= 0) return 0.0;

    const width = (runLength + 1) * 2;
    bufA.fill(0);
    bufA[startDigit * width + 0] = 1.0;
    let current = bufA;
    let next = bufB;

    for (let step = 1; step <= totalSteps; step++) {
      next.fill(0);
      
      let isSettlement = false;
      if (isBotStrideMode) {
        const checkStep = step - initialDelay;
        if (checkStep > 0) {
          const cyclePeriod = D + postContractRest;
          const stepWithinCycle = (checkStep - 1) % cyclePeriod + 1;
          if (stepWithinCycle === D) {
            isSettlement = true;
          }
        }
      } else {
        isSettlement = true;
      }

      for (let x = 0; x < 10; x++) {
        const rowOffset = x * 10;
        for (let r = 0; r <= runLength; r++) {
          for (let seen = 0; seen <= 1; seen++) {
            const p = current[x * width + r * 2 + seen];
            if (p === 0) continue;
            for (let y = 0; y < 10; y++) {
              const trans = this.T1[rowOffset + y];
              if (trans === 0) continue;
              let nr = r;
              let nseen = seen;
              if (isSettlement) {
                if (y === targetDigit) {
                  nr = Math.min(runLength, r + 1);
                  if (nr >= runLength) nseen = 1;
                } else {
                  nr = 0;
                }
              }
              next[y * width + nr * 2 + nseen] += p * trans;
            }
          }
        }
      }
      const tmp = current;
      current = next;
      next = tmp;
    }

    let result = 0.0;
    for (let x = 0; x < 10; x++) {
      for (let r = 0; r <= runLength; r++) {
        result += current[x * width + r * 2 + 1];
      }
    }
    return Math.min(1.0, Math.max(0.0, result));
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

    if (this.count < Math.min(this.bufferSize, 21)) return null;
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
    const N = Math.min(this.count, this.bufferSize);
    if (N < 2) return null;
    const D = Math.max(1, Math.min(100, Math.floor(input.duration || 3)));
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

        // 1b. Symmetrically Fuse Unified Context + VMM priors across ALL rows weighted by historical marginal frequency
    if (input.unifiedPrior && input.unifiedPrior.length === 10) {
      for (let row = 0; row < 10; row++) {
        const rowOffset = row * 10;
        let rowBlendSum = 0.0;
        
        for (let j = 0; j < 10; j++) {
          const pPrior = Math.max(1e-6, input.unifiedPrior[j]);
          // Weights the prior by historical marginal probability to maintain absolute structural stability across matrix powers
          const marginalWeight = (this.freq100[j] + 1.0) / (N + 10.0);
          
          this.T1[rowOffset + j] = 0.65 * this.T1[rowOffset + j] + 0.35 * pPrior * (marginalWeight / 0.10);
          rowBlendSum += this.T1[rowOffset + j];
        }
        
        if (rowBlendSum > 0) {
          const invSum = 1.0 / rowBlendSum;
          for (let j = 0; j < 10; j++) this.T1[rowOffset + j] *= invSum;
        }
      }
    }

                  // 2. Matrix Exponentiation for exact contract settlement ticks (C1, C2, C3, C4)
    const rawJump = input.navThresholds?.botJumpTicks;
    const botJump = Number.isFinite(rawJump) ? Math.max(0, rawJump!) : 3;
    const rawDelay = input.navThresholds?.entryDelayTicks;
    const entryDelay = Number.isFinite(rawDelay) ? Math.max(0, rawDelay!) : 1;
    // Contract 1 settles at entryDelay + D; each next contract adds (botJump + D)
    const settleStep = Math.max(1, entryDelay + D);
    this.matPower10x10(this.T1, settleStep, this.TD);


        // =========================================================================
    // 5. ADVANCED PRNG MODULE: CONTEXT-TREE WEIGHTING (CTW) HIGH-ORDER MEMORY
    // =========================================================================
    const ctw_prior = new Float64Array(10);
    ctw_prior.fill(0.10);
    {
      const depthDepthLimit = 4; // Tracks down to multi-layer Order-4 history paths simultaneously
      let contextNodeKey = 0;
      
      // Traverse history tree backwards up to the depth depth threshold limit boundary
      for (let depth = 0; depth < depthDepthLimit; depth++) {
        const lookbackIdx = N - 2 - depth;
        if (lookbackIdx >= 0) {
          const historicalDigitVal = this.buffer[lookbackIdx];
          contextNodeKey = (contextNodeKey << 3) ^ historicalDigitVal;
          const nodeAddressIndex = (contextNodeKey & 4095);
          
          // Increment tree binary state trajectory registers
          const bitParitySide = (currDigit % 2 === 0) ? 0 : 1;
          this.ctw_tree_counts[nodeAddressIndex * 2 + bitParitySide]++;
          
          // Compute log-likelihood weighting allocations dynamically
          const zeroCount = this.ctw_tree_counts[nodeAddressIndex * 2 + 0];
          const oneCount = this.ctw_tree_counts[nodeAddressIndex * 2 + 1];
          this.ctw_node_weights[nodeAddressIndex] = Math.log((zeroCount + 0.5) / (zeroCount + oneCount + 1.0));
        }
      }

      // Map context node weights directly into target algorithmic predictions
      for (let j = 0; j < 10; j++) {
        const structuralNodeAddress = (contextNodeKey ^ j) & 4095;
        const probabilityBiasFromWeight = Math.abs(this.ctw_node_weights[structuralNodeAddress]);
        const boundedCtwDensity = clamp(1.0 / (1.0 + probabilityBiasFromWeight), 0.01, 0.90);
        ctw_prior[j] = 0.85 * ctw_prior[j] + 0.15 * boundedCtwDensity;
      }
    }

    // =========================================================================
    // 6. ADVANCED PRNG MODULE: BERLEKAMP-MASSEY LINEAR COMPLEXITY PROFILE
    // =========================================================================
    {
      const maxBmLength = Math.min(this.count, 64);
      const s = new Int32Array(maxBmLength);
      
      // Load current sequence data into binary state tracking frames
      for (let i = 0; i < maxBmLength; i++) {
        s[i] = (this.buffer[this.count - maxBmLength + i] % 2 === 0) ? 0 : 1;
      }

      // Initialize shift registers and feedback connectivity correction vectors
      // Set the feedback connection roots cleanly across all array indices using loop index tracker 'k'
      for (let k = 0; k < 64; k++) {
        this.bm_scratch_C[k] = 1;
        this.bm_scratch_B[k] = 1;
      }

      let L = 0; // Current computed discrete linear complexity length register
      let m = -1; // System linear step shift memory register anchor
      
      

      // Execute Berlekamp-Massey discrete loop minimization passes
      for (let i = 0; i < maxBmLength; i++) {
        let discrepancy = s[i];
        for (let j = 1; j <= L; j++) {
          if (i - j >= 0) {
            discrepancy ^= this.bm_scratch_C[j] * s[i - j];
          }
        }

        if (discrepancy !== 0) {
          const temp_T = new Int32Array(64);
          temp_T.set(this.bm_scratch_C);
          const shiftDistanceIndex = i - m;

          for (let j = 0; j < 64 - shiftDistanceIndex; j++) {
            this.bm_scratch_C[j + shiftDistanceIndex] ^= this.bm_scratch_B[j];
          }

          if (2 * L <= i) {
            L = i + 1 - L;
            m = i;
            this.bm_scratch_B.set(temp_T);
          }
        }
      }

      this.bm_current_linear_complexity = clamp(L, 0, 64);
      this.bm_complexity_profile[this.deltaCount % 64] = this.bm_current_linear_complexity;
    }

    // =========================================================================
    // PARALLEL DISCRETE PRNG ENGINE STRUCTURE TRACKING CHANNELS
    // =========================================================================
    const prng_ensemble_prior = new Float64Array(10);
    prng_ensemble_prior.fill(0.10);

    // Security perimeter filter: if linear complexity drops, force safety dilution
    if (this.bm_current_linear_complexity < (Math.min(this.count, 64) * 0.35)) {
      for (let j = 0; j < 10; j++) {
        prng_ensemble_prior[j] = 0.65 * prng_ensemble_prior[j] + 0.35 * ctw_prior[j];
      }
    }

    // 1. Chaos Game Representation (CGR) Coordinate Quadrant Fractal Mapping
    {
      // Map discrete input string digits to exact corner vertices inside a bounding unit plane box
      // Grid corners coordinates: 0-2 (Bottom Left), 3-4 (Top Left), 5-7 (Top Right), 8-9 (Bottom Right)
      let vertexX = 0.0, vertexY = 0.0;
      if (currDigit <= 2) { vertexX = 0.0; vertexY = 0.0; }
      else if (currDigit <= 4) { vertexX = 0.0; vertexY = 1.0; }
      else if (currDigit <= 7) { vertexX = 1.0; vertexY = 1.0; }
      else { vertexX = 1.0; vertexY = 0.0; }

      // Discrete step trajectory update: jump exactly 50% of the distance toward target anchor vertex
      this.cgr_x = 0.5 * this.cgr_x + 0.5 * vertexX;
      this.cgr_y = 0.5 * this.cgr_y + 0.5 * vertexY;

      // Classify active coordinate vectors inside a discrete 4x4 coordinate spatial density quadrant
      const gridX = Math.min(3, Math.max(0, Math.floor(this.cgr_x * 4)));
      const gridY = Math.min(3, Math.max(0, Math.floor(this.cgr_y * 4)));
      const spatialIndex = gridY * 4 + gridX;

      // Apply historical trace attenuation decay to map state tracking memory loops
      for (let i = 0; i < 16; i++) this.cgr_density_grid[i] *= 0.95;
      this.cgr_density_grid[spatialIndex] += 0.05;

      // Extract geometric density weights to apply safe structural tracking indicators
      for (let j = 0; j < 10; j++) {
        const structuralAnchorVertex = (j <= 2) ? 0 : (j <= 4) ? 4 : (j <= 7) ? 12 : 15;
        const localizedCgrBiasWeight = this.cgr_density_grid[structuralAnchorVertex];
        prng_ensemble_prior[j] = 0.85 * prng_ensemble_prior[j] + 0.15 * localizedCgrBiasWeight;
      }
    }

    // 2. Order-2 Renyi Entropy Sensitivity Window Monitoring Envelope
    {
      let sumQuadraticProbabilities = 0.0;
      for (let d = 0; d < 10; d++) {
        const empiricalProbability = this.freq100[d] / N;
        sumQuadraticProbabilities += empiricalProbability * empiricalProbability;
        this.renyi_window_history[d] = empiricalProbability;
      }
      
      // Calculate Order-2 Renyi Entropy equation parameters: H_2 = -log2(Σ p_i^2)
      this.renyi_entropy_q2 = sumQuadraticProbabilities > 0 ? -Math.log2(sumQuadraticProbabilities) : Math.log2(10);

      // Defensive ceiling fallback check: if entropy plunges inside structural sequence repeating zones, mute skews
      if (this.renyi_entropy_q2 < 2.65) {
        for (let j = 0; j < 10; j++) {
          prng_ensemble_prior[j] = 0.70 * prng_ensemble_prior[j] + 0.30 * 0.10;
        }
      }
    }

        // 3. Discrete Markov Random Fields Spatial Gibbs Clique Energy States
    {
      this.freqMicro.fill(0);
      const preMicroStart = Math.max(0, N - this.microWindow);
      for (let i = preMicroStart; i < N; i++) {
        this.freqMicro[this.buffer[i]]++;
      }
      const currentTransitionRowStartOffset = currDigit * 10;
      let totalCliqueGridSystemEnergy = 0.0;

      
      // Compute spatial cliques potentials over structural lookback limits
      for (let j = 0; j < 10; j++) {
        const microHistoricalFrequentistDensity = this.freqMicro[j] / this.microWindow;
        // Map Gibbs clique potential configuration boundaries using energy density functions
        this.mrf_clique_potentials[currentTransitionRowStartOffset + j] = Math.exp(-1.5 * Math.abs(this.T1[currentTransitionRowStartOffset + j] - microHistoricalFrequentistDensity));
        totalCliqueGridSystemEnergy += this.mrf_clique_potentials[currentTransitionRowStartOffset + j];
      }

      // Infuse Gibbs random field energy priors safely back into parallel tracking vectors
      if (totalCliqueGridSystemEnergy > 0) {
        for (let j = 0; j < 10; j++) {
          const spatialGibbsPriorDensity = this.mrf_clique_potentials[currentTransitionRowStartOffset + j] / totalCliqueGridSystemEnergy;
          prng_ensemble_prior[j] = 0.80 * prng_ensemble_prior[j] + 0.20 * spatialGibbsPriorDensity;
        }
      }
    }

      // 4. Keep M^D transition matrix mathematically pure for horizon D
     // (Prevent 1-step heuristics from overwriting D-step transition probabilities)

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

    // 6d. Lorenz Attractor Phase-Space Integration (RK2 midpoint step, σ=10, ρ=28, β=8/3)
    const prevWingLeft = this.lorenzX < 0;
    {
      const sigma = 10.0;
      const rho = 28.0;
      const beta = 8.0 / 3.0;
      const dt = 0.015;
      const drive = ((currDigit - 4.5) / 4.5) * 2.5; // bounded tick perturbation (-2.5..+2.5)

      const dx1 = sigma * (this.lorenzY - this.lorenzX) + drive;
      const dy1 = this.lorenzX * (rho - this.lorenzZ) - this.lorenzY;
      const dz1 = this.lorenzX * this.lorenzY - beta * this.lorenzZ;

      const mx = this.lorenzX + 0.5 * dt * dx1;
      const my = this.lorenzY + 0.5 * dt * dy1;
      const mz = this.lorenzZ + 0.5 * dt * dz1;

      const dx2 = sigma * (my - mx) + drive;
      const dy2 = mx * (rho - mz) - my;
      const dz2 = mx * my - beta * mz;

      this.lorenzX = clamp(this.lorenzX + dt * dx2, -40, 40);
      this.lorenzY = clamp(this.lorenzY + dt * dy2, -40, 40);
      this.lorenzZ = clamp(this.lorenzZ + dt * dz2, 0, 60);
    }
    const lorenzWing: EngineResult["lorenzWing"] = this.lorenzX < 0 ? "LEFT" : "RIGHT";
    const lorenzFlip = (this.lorenzX < 0) !== prevWingLeft;
    const lorenzEnergy = this.lorenzZ / 50.0;

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
      const multiHitProb = this.computeHitCountProb(currDigit, d, D, 2, this.dpHitA, this.dpHitB, botJump, entryDelay);
      const threeHitProb = this.computeHitCountProb(currDigit, d, D, 3, this.dpHitB, this.dpHitA, botJump, entryDelay);
      const pairProb = this.computeRunAtLeastOnce(currDigit, d, D, 2, this.dpRunA, this.dpRunB, botJump, entryDelay);
      const tripleProb = this.computeRunAtLeastOnce(currDigit, d, D, 3, this.dpRunB, this.dpRunA, botJump, entryDelay);

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

    // If no fresh digits are found for Matches, flag HOLD rather than returning null
    const noFreshMatches = freshPool.length === 0 && (input.market ?? "matches") === "matches";
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
    const edgeGateOn = !!input.navThresholds?.edgeGateEnabled;
    const edgeGateMin = input.navThresholds?.edgeGateMinPct ?? 0;
    const settledCount = input.sessionSettledCount ?? 0;
    const liveEdgePct = input.sessionEdgePct ?? 0;
    const sessionEdgePass = !edgeGateOn || settledCount === 0 || liveEdgePct >= edgeGateMin;
    const lorenzStableOk = !input.navRules?.lorenzStable || !lorenzFlip;
    const overUnder = this.computeOverUnder(currOffset, barrier, deadZoneLimit, freshPool, sessionEdgePass && lorenzStableOk, zRun);
    const evenOdd = this.computeParity(currOffset, freshPool, sessionEdgePass && lorenzStableOk, zRun);
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
    // Entry-delay tick probability (if entryDelay > 0, check step = entryDelay; otherwise step 1)
    let pMarkovDelayTarget = this.T1[currOffset + targetDigit];
    if (entryDelay > 1) {
      const TDelay = new Float64Array(100);
      this.matPower10x10(this.T1, entryDelay, TDelay);
      pMarkovDelayTarget = TDelay[currOffset + targetDigit];
    }
        // Evaluate exact settlement probabilities across Contracts 1..maxContracts
    const rawMaxContracts = input.navThresholds?.maxContracts;
    const totalContracts = Number.isFinite(rawMaxContracts) ? Math.min(20, Math.max(1, Math.floor(rawMaxContracts!))) : 5;
    const contractProbs: { step: number; prob: number }[] = [{ step: settleStep, prob: pMarkovDTarget }];
    const TContract = new Float64Array(100);
    for (let c = 1; c < totalContracts; c++) {
      const cStep = settleStep + c * (botJump + D);
      this.matPower10x10(this.T1, cStep, TContract);
      contractProbs.push({ step: cStep, prob: TContract[currOffset + targetDigit] });
    }
    const win = Array.from(this.buffer.subarray(0, N));

    // Evaluate the trigger rules checklist against the exact settlement horizon
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
      pMarkovDelayTarget,
      contractProbs,
      market,
      lorenzWing,
      lorenzFlip,
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
      // Map straight to the uncorrupted single-digit frequentist matrix row landing odds synchronized with your entry delay loops
      const trueLandingProb = this.TD[currOffset + topPick];
      marketRecProb = trueLandingProb;
      marketEdge = trueLandingProb - 0.10; // Edge over the 10% uniform random floor
      marketScore = Math.max(0, marketEdge);
    }

        // 9. Alert decision — dual ping gates + market-aware probability floors.
    let alertDecision: EngineResult["alertDecision"] = "HOLD / NO SIGNAL";

    let allSelectedPass = true;
    let selectedCount = 0;
    const checkedRules = input.navRules ?? {};
    for (const ruleKey in checkedRules) {
      if (checkedRules[ruleKey as keyof typeof checkedRules]) {
        selectedCount++;
        const match = navRuleHits.find((h) => h.rule === ruleKey);
        if (!match?.pass) {
          allSelectedPass = false;
        }
      }
    }
    const currLanding = digitMetrics[targetDigit]?.landingProb ?? 0.1;
    const prevLanding = this.prevLandingProb[targetDigit];
    // Strict directional slope:
    // - Matches: every enabled numeric rule must be strictly strengthening beyond its threshold
    // - Differs: landing probability must be strictly decreasing below the ceiling
    let allRulesIncreasing = true;
    for (const h of navRuleHits) {
      if (!h.enabled || h.slopeDir === "none" || h.metric === undefined) continue;
      const key = `${targetDigit}:${h.rule}`;
      const prevVal = this.prevRuleMetrics.get(key);
      if (prevVal !== undefined) {
        if (h.slopeDir === "up" && !(h.metric > prevVal + 1e-6)) {
          allRulesIncreasing = false;
          h.detail += ` · ↓/flat (prev ${prevVal.toFixed(2)})`;
        } else if (h.slopeDir === "down" && !(h.metric < prevVal - 1e-6)) {
          allRulesIncreasing = false;
          h.detail += ` · ↑/flat (prev ${prevVal.toFixed(2)})`;
        }
      }
    }
    const differsStrictlyFalling = prevLanding < 0 || currLanding < prevLanding - 1e-6;
    
    if (!pingOk) {
      alertDecision = "HOLD / UNSAFE LATENCY";
    } else if (market === "matches") {
      if (selectedCount === 0) {
        alertDecision = "HOLD / NO SIGNAL";
      } else if (matchesReady && allSelectedPass && allRulesIncreasing && sessionEdgePass) {
        alertDecision = "READY / MANUAL ALERT";
      } else {
        alertDecision = "HOLD / RULES NOT MET";
      }
       } else if (market === "differs") {
      const differsCeiling = (input.navThresholds?.differsProbabilityCeilingPct ?? 12) / 100;
      const differsColdGapMin = checkedRules.freshness ? 0 : (input.navThresholds?.differsColdGapMin ?? 5);
      const targetColdGap = N - 1 - (this.buffer.lastIndexOf(targetDigit));

      // Active cluster burst guard: block Differs if target digit appeared >= 2 times in the last 5 ticks
      let burstCount5 = 0;
      const burstStart = Math.max(0, N - 5);
      for (let i = burstStart; i < N; i++) {
        if (this.buffer[i] === targetDigit) burstCount5++;
      }

      const differsMathReady =
        currLanding <= differsCeiling &&
        targetColdGap >= differsColdGapMin &&
        burstCount5 < 2 &&
        differsStrictlyFalling;
      const combinedDiffersReady = differsMathReady && (selectedCount === 0 || allSelectedPass) && sessionEdgePass;
      if (combinedDiffersReady) alertDecision = "READY / MANUAL ALERT";
      else alertDecision = "HOLD / RULES NOT MET";
    } else if (market === "overunder" || market === "evenodd" || market === "risefall") {

      // Analysis-only markets: calculations run continuously, alerts stay restricted to Matches & Differs
      alertDecision = "HOLD / NO SIGNAL";
    }

    // Update previous-tick baselines ONLY when a new tick arrives (not on UI slider recompute)
    const tickIdNow = input.tickId ?? -1;
    if (tickIdNow < 0 || tickIdNow !== this.lastSlopeTickId) {
      this.lastSlopeTickId = tickIdNow;
      for (let d = 0; d < 10; d++) {
        this.prevLandingProb[d] = digitMetrics[d].landingProb;
      }
      for (const h of navRuleHits) {
        if (h.metric !== undefined && h.slopeDir !== "none") {
          this.prevRuleMetrics.set(`${targetDigit}:${h.rule}`, h.metric);
        }
      }
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
      lorenzWing,
      lorenzFlip,
      lorenzEnergy,
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
     private computeOverUnder(
    currOffset: number,
    barrier: number,
    deadZoneLimit = NAV_TIE_DEAD_ZONE,
    freshPool: number[] = [],
    sessionEdgePass: boolean = true,
    runsZScore: number = 0,
  ): OverUnderBlock {
    const N = Math.min(this.count, this.bufferSize);
    let rawOver = 0.0;
    let rawUnder = 0.0;
    let maxOverLoser = 0.0;  // highest single losing digit for OVER (0..barrier)
    let maxUnderLoser = 0.0; // highest single losing digit for UNDER (barrier..9)
    let freshOverCount = 0;
    let freshUnderCount = 0;

    for (let d = 0; d < 10; d++) {
      const p = this.TD[currOffset + d];
      const isFresh = freshPool.includes(d);
      if (d > barrier) {
        rawOver += p;
        if (isFresh) freshOverCount++;
      } else if (d < barrier) {
        rawUnder += p;
        if (isFresh) freshUnderCount++;
      }
      if (d <= barrier && p > maxOverLoser) maxOverLoser = p;
      if (d >= barrier && p > maxUnderLoser) maxUnderLoser = p;
    }
    const pTie = this.TD[currOffset + barrier];
    const pOver = rawOver;
    const pUnder = rawUnder;

    let baseOverCount = 0;
    let baseUnderCount = 0;
    for (let d = 0; d < 10; d++) {
      if (d > barrier) baseOverCount += this.freq100[d];
      else if (d < barrier) baseUnderCount += this.freq100[d];
    }
    const baselineOver = N > 0 ? baseOverCount / N : (9 - barrier) / 10;
    const baselineUnder = N > 0 ? baseUnderCount / N : barrier / 10;

    let microOverCount = 0;
    let microUnderCount = 0;
    for (let d = 0; d < 10; d++) {
      if (d > barrier) microOverCount += this.freqMicro[d];
      else if (d < barrier) microUnderCount += this.freqMicro[d];
    }
    const microN = Math.min(N, this.microWindow);
    const microOver = microN > 0 ? microOverCount / microN : baselineOver;
    const microUnder = microN > 0 ? microUnderCount / microN : baselineUnder;
    const momentumOver = microOver - baselineOver;
    const momentumUnder = microUnder - baselineUnder;

    // Fresh (anti-tired) digit density on each side
    const overDigitsTotal = Math.max(1, 9 - barrier);
    const underDigitsTotal = Math.max(1, barrier);
    const overFreshRatio = barrier < 9 ? freshOverCount / overDigitsTotal : 0;
    const underFreshRatio = barrier > 0 ? freshUnderCount / underDigitsTotal : 0;
    // Winning side must have at least 1 fresh digit and >= fresh density of the opposite side
    const overFreshOk = freshOverCount >= 1 && (barrier === 0 || overFreshRatio >= underFreshRatio);
    const underFreshOk = freshUnderCount >= 1 && (barrier === 9 || underFreshRatio >= overFreshRatio);

    // Exact uniform random baselines for the selected barrier (0..9)
    const fairOver = (9 - barrier) / 10;
    const fairUnder = barrier / 10;
    const minEdgeRequired = 0.045; // Must beat fair baseline by >= +4.5%

    const isBoundary = barrier === 0 || barrier === 9;
    const tieBlocked = !isBoundary && pTie >= deadZoneLimit;
    const notChoppy = runsZScore <= 1.96;

    const overSafe =
      notChoppy &&
      sessionEdgePass &&
      barrier < 9 &&
      !tieBlocked &&
      maxOverLoser < (barrier === 0 ? deadZoneLimit * 1.5 : deadZoneLimit) &&
      pOver >= fairOver + minEdgeRequired &&
      pOver >= baselineOver &&
      momentumOver >= 0 &&
      overFreshOk;

    const underSafe =
      notChoppy &&
      sessionEdgePass &&
      barrier > 0 &&
      !tieBlocked &&
      maxUnderLoser < (barrier === 9 ? deadZoneLimit * 1.5 : deadZoneLimit) &&
      pUnder >= fairUnder + minEdgeRequired &&
      pUnder >= baselineUnder &&
      momentumUnder >= 0 &&
      underFreshOk;

    const deadZone = tieBlocked || (!overSafe && !underSafe && (maxOverLoser >= deadZoneLimit || maxUnderLoser >= deadZoneLimit));

    let rec: OverUnderBlock["rec"] = "HOLD";
    let prob = Math.max(pOver, pUnder);
    let velocity = pOver >= pUnder ? momentumOver : momentumUnder;

    if (overSafe && underSafe) {
      const overEdgeScore = (pOver - fairOver) + 0.35 * momentumOver + 0.05 * overFreshRatio;
      const underEdgeScore = (pUnder - fairUnder) + 0.35 * momentumUnder + 0.05 * underFreshRatio;
      if (overEdgeScore >= underEdgeScore) {
        rec = "OVER";
        prob = pOver;
        velocity = momentumOver;
      } else {
        rec = "UNDER";
        prob = pUnder;
        velocity = momentumUnder;
      }
    } else if (overSafe) {
      rec = "OVER";
      prob = pOver;
      velocity = momentumOver;
    } else if (underSafe) {
      rec = "UNDER";
      prob = pUnder;
      velocity = momentumUnder;
    } else {
      rec = "HOLD";
      if (barrier === 0 || (barrier < 9 && (pOver - fairOver) >= (pUnder - fairUnder))) {
        prob = pOver;
        velocity = momentumOver;
      } else {
        prob = pUnder;
        velocity = momentumUnder;
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
   *  matrix exponentiation, corroborated by Wald–Wolfowitz pair/run clustering
   *  (runsZScore <= 0), micro-window momentum, fresh parity balance, and
   *  the live Session Edge Gate. */
  private computeParity(
    currOffset: number,
    freshPool: number[] = [],
    sessionEdgePass: boolean = true,
    runsZScore: number = 0,
  ): ParityBlock {
    const N = Math.min(this.count, this.bufferSize);
    let rawEven = 0.0;
    let freshEvenCount = 0;
    let freshOddCount = 0;
    for (let d = 0; d < 10; d++) {
      if (d % 2 === 0) {
        rawEven += this.TD[currOffset + d];
        if (freshPool.includes(d)) freshEvenCount++;
      } else {
        if (freshPool.includes(d)) freshOddCount++;
      }
    }

    let baseEven = 0;
    for (let d = 0; d < 10; d += 2) baseEven += this.freq100[d];
    const baselineEven = N > 0 ? baseEven / N : 0.5;
    const baselineOdd = 1.0 - baselineEven;

    let microEven = 0;
    for (let d = 0; d < 10; d += 2) microEven += this.freqMicro[d];
    const microN = Math.min(N, this.microWindow);
    const microEvenFrac = microN > 0 ? microEven / microN : 0.5;
    const momentumEven = microEvenFrac - baselineEven;
    const momentumOdd = (1.0 - microEvenFrac) - baselineOdd;

    // Combine M^D matrix probability with signed micro-window momentum
    const pEven = clamp(rawEven + 0.35 * momentumEven, 0.05, 0.95);
    const pOdd = 1.0 - pEven;

    // Pair/streak clustering gate: negative runsZScore confirms digits are
    // grouping into Even/Odd pairs & streaks rather than alternating E-O-E-O
    const pairClusteringActive = runsZScore <= 0.0;
    const minEdgeRequired = 0.045; // >= 54.5% win prob to clear payout spread

    const evenFreshOk = freshEvenCount >= 1 && freshEvenCount >= freshOddCount;
    const oddFreshOk = freshOddCount >= 1 && freshOddCount >= freshEvenCount;

    const evenSafe =
      sessionEdgePass &&
      pairClusteringActive &&
      pEven >= 0.5 + minEdgeRequired &&
      pEven >= baselineEven &&
      momentumEven >= 0 &&
      evenFreshOk;

    const oddSafe =
      sessionEdgePass &&
      pairClusteringActive &&
      pOdd >= 0.5 + minEdgeRequired &&
      pOdd >= baselineOdd &&
      momentumOdd >= 0 &&
      oddFreshOk;

    let rec: ParityBlock["rec"] = "HOLD";
    let prob = Math.max(pEven, pOdd);
    let velocity = pEven >= pOdd ? momentumEven : momentumOdd;

    if (evenSafe && (!oddSafe || pEven >= pOdd)) {
      rec = "EVEN";
      prob = pEven;
      velocity = momentumEven;
    } else if (oddSafe) {
      rec = "ODD";
      prob = pOdd;
      velocity = momentumOdd;
    } else {
      rec = "HOLD";
      if (pEven >= pOdd) {
        prob = pEven;
        velocity = momentumEven;
      } else {
        prob = pOdd;
        velocity = momentumOdd;
      }
    }

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
