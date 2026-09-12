// ============================================================================
// LAYERED ENSEMBLE STRATEGY — gatekeeping / prioritisation wrapper.
//
// SAFETY: this module does NOT re-implement or modify any of the 14 existing
// formulas. It only READS their outputs (streaks, matrix-power Markov steps,
// Bayesian posterior, digrams/trigrams, chi-square, variance, ping/sync) and
// restructures how they interact, prioritise and vote.
//
//   Layer 1 — Speed & Momentum   : streak counters + multi-step Markov (P¹..Pʰ)
//   Layer 2 — Probability Filters: Bayesian fusion + top digrams + trigrams
//   Layer 3 — Circuit Breakers   : chi-square, variance, network latency/sync
//
// Aggregation is a dynamic Weighted Confidence Score:
//     Final Score = Σ (Formula_Result × Formula_Weight) / Σ Weight
// with Layer 1 carrying the highest weights so fast streak setups are never
// diluted by slower, lagging metrics. Layer 3 never votes — it multiplies the
// score down and can hard-block execution outright.
// ============================================================================

import type { NetHealth } from "./types";
import { tailStreak } from "./stats";

export interface LayerVote {
  layer: 1 | 2 | 3;
  name: string;
  /** Normalised 0..1 result of the underlying formula for the target digit. */
  score: number;
  weight: number;
  detail: string;
}

export interface LayeredInputs {
  window: number[];
  target: number;
  /** Existing fused posterior (context + pre-arrival weighted). */
  posterior: number[];
  /** Per-tick matrix powers P¹..Pʰ from forecastHorizon(). */
  stepDists: number[][];
  horizon: 2 | 3;
  /** Jump-safe P(target repeats >=2x inside the executed 3-tick span). */
  runProb: number;
  /** P(two back-to-back hits inside the executed span). */
  consecutiveProb?: number;

  bigrams: Array<{ pattern: string; count: number }>;
  trigrams: Array<{ pattern: string; count: number }>;
  chiUnif: number;
  chiIndep: number;
  /** Inter-tick interval dispersion (std/mean), 0 = perfectly regular. */
  intervalCv: number;
  pingMs: number;
  safePingMs: number;
  health: NetHealth;
  stale: boolean;
  syncing: boolean;
  neutralFallback: boolean;
  exhausted: boolean;
}

export interface LayeredResult {
  /** Weighted Bayesian-fusion confidence, 0..1. Drives the confidence bar. */
  confidence: number;
  /** Raw weighted vote before the circuit-breaker multiplier. */
  rawScore: number;
  breakerMultiplier: number;
  votes: LayerVote[];
  layer1: number;
  layer2: number;
  blocked: boolean;
  blockReason: string;
}

// ---- Base weights ----------------------------------------------------------
// Layer 1 dominates (0.62 of the vote mass) so active streaks fire instantly.
export const LAYER_WEIGHTS = Object.freeze({
  streak: 0.3,
  markovMultiStep: 0.32,
  runRepeat: 0.28,
  bayesian: 0.18,
  digram: 0.1,
  trigram: 0.08,
});


/** Chi-square critical values (df=9, α=0.01 / α=0.05) used as breaker bands. */
const CHI_RANDOM_FLOOR = 8.34; // below → indistinguishable from uniform noise
const CHI_UNSTABLE_CEIL = 30.0; // far above → distribution has broken structure

function clamp01(x: number): number {
  return !Number.isFinite(x) ? 0 : x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Layer 1a — direct streak counter momentum for the target digit. */
function streakScore(window: number[], target: number): { score: number; detail: string } {
  const t = tailStreak(window);
  const run = t.digit === target ? t.len : 0;
  // Also count target density in the last 5 ticks (fast momentum proxy).
  const tail5 = window.slice(-5);
  const hits5 = tail5.reduce((a, d) => a + (d === target ? 1 : 0), 0);
  const score = clamp01(Math.min(1, run / 3) * 0.65 + Math.min(1, hits5 / 3) * 0.35);
  return { score, detail: `run ${run} · 5t ${hits5}` };
}

/** Layer 1b — multi-step Markov transitions P¹..Pʰ, weighted toward the horizon tick. */
function markovMultiStepScore(
  stepDists: number[][],
  target: number,
  horizon: number,
): { score: number; detail: string } {
  if (!stepDists.length) return { score: 0, detail: "no matrix" };
  let num = 0;
  let den = 0;
  const parts: string[] = [];
  for (let i = 0; i < stepDists.length; i++) {
    const p = stepDists[i]?.[target] ?? 0;
    // Later steps weigh more: the execution tick is the horizon tick.
    const w = 1 + i;
    num += p * w;
    den += w;
    parts.push(`P${i + 1} ${(p * 100).toFixed(1)}%`);
  }
  const avg = den ? num / den : 0;
  // A 10% hit is pure chance; scale so 10% → 0 and 35%+ → 1.
  const score = clamp01((avg - 0.1) / 0.25);
  return { score, detail: `${parts.join(" · ")} · t+${horizon}` };
}

/** Layer 2b/2c — n-gram continuation support for the target digit. */
function ngramScore(
  grams: Array<{ pattern: string; count: number }>,
  window: number[],
  k: 2 | 3,
  target: number,
): { score: number; detail: string } {
  if (window.length < k || grams.length === 0) return { score: 0, detail: "n/a" };
  const prefix = window.slice(-(k - 1)).join("");
  const want = prefix + String(target);
  const total = grams.reduce((a, g) => a + g.count, 0) || 1;
  const hit = grams.find((g) => g.pattern === want);
  const share = hit ? hit.count / total : 0;
  const score = clamp01(share / 0.4);
  return { score, detail: hit ? `${want} ×${hit.count} (${(share * 100).toFixed(0)}%)` : `${want} unseen` };
}

/**
 * Evaluate every layer and produce the dynamic weighted confidence score.
 */
export function evaluateLayeredEnsemble(input: LayeredInputs): LayeredResult {
  const votes: LayerVote[] = [];

  // ---------------- LAYER 1 — SPEED & MOMENTUM ----------------
  const s = streakScore(input.window, input.target);
  votes.push({ layer: 1, name: "streak", score: s.score, weight: LAYER_WEIGHTS.streak, detail: s.detail });
  const mk = markovMultiStepScore(input.stepDists, input.target, input.horizon);
  votes.push({
    layer: 1,
    name: "markov P¹..Pʰ",
    score: mk.score,
    weight: LAYER_WEIGHTS.markovMultiStep,
    detail: mk.detail,
  });
  // Layer 1c — exact jump-safe repeat probability over the executed 3-tick span.
  // Chance level for >=2 hits of one digit in 3 ticks is ~2.8%; 40%+ saturates.
  const runRaw = clamp01(input.runProb);
  const consec = clamp01(input.consecutiveProb ?? 0);
  const runScore = clamp01(((runRaw - 0.05) / 0.35) * 0.8 + ((consec - 0.03) / 0.3) * 0.2);
  votes.push({
    layer: 1,
    name: "3-tick repeat",
    score: runScore,
    weight: LAYER_WEIGHTS.runRepeat,
    detail: `run ${(runRaw * 100).toFixed(1)}% · pair ${(consec * 100).toFixed(1)}%`,
  });



  // ---------------- LAYER 2 — PROBABILITY FILTERS ----------------
  const post = clamp01(input.posterior[input.target] ?? 0);
  // Posterior is a 10-way distribution: 0.10 is chance, 0.45 is saturation.
  const bayes = clamp01((post - 0.1) / 0.35);
  votes.push({
    layer: 2,
    name: "bayesian fusion",
    score: bayes,
    weight: LAYER_WEIGHTS.bayesian,
    detail: `${(post * 100).toFixed(1)}% posterior`,
  });
  const dg = ngramScore(input.bigrams, input.window, 2, input.target);
  votes.push({ layer: 2, name: "digram", score: dg.score, weight: LAYER_WEIGHTS.digram, detail: dg.detail });
  const tg = ngramScore(input.trigrams, input.window, 3, input.target);
  votes.push({ layer: 2, name: "trigram", score: tg.score, weight: LAYER_WEIGHTS.trigram, detail: tg.detail });

  // Weighted vote — Σ(result × weight) / Σ(weight).
  let num = 0;
  let den = 0;
  for (const v of votes) {
    num += v.score * v.weight;
    den += v.weight;
  }
  const rawScore = den ? num / den : 0;
  const layer1 =
    (s.score * LAYER_WEIGHTS.streak +
      mk.score * LAYER_WEIGHTS.markovMultiStep +
      runScore * LAYER_WEIGHTS.runRepeat) /
    (LAYER_WEIGHTS.streak + LAYER_WEIGHTS.markovMultiStep + LAYER_WEIGHTS.runRepeat);

  const layer2 =
    (bayes * LAYER_WEIGHTS.bayesian + dg.score * LAYER_WEIGHTS.digram + tg.score * LAYER_WEIGHTS.trigram) /
    (LAYER_WEIGHTS.bayesian + LAYER_WEIGHTS.digram + LAYER_WEIGHTS.trigram);

  // ---------------- LAYER 3 — CIRCUIT BREAKERS ----------------
  let mult = 1;
  const breakerNotes: string[] = [];
  let blocked = false;
  let blockReason = "";

  // Chi-square uniformity: too low = pure randomness, too high = broken data.
  if (input.chiUnif < CHI_RANDOM_FLOOR) {
    mult *= 0.55;
    breakerNotes.push(`X²unif ${input.chiUnif.toFixed(1)} random`);
  } else if (input.chiUnif > CHI_UNSTABLE_CEIL) {
    mult *= 0.7;
    breakerNotes.push(`X²unif ${input.chiUnif.toFixed(1)} unstable`);
  }
  // Independence chi-square: extreme values mean the transition table is noise.
  if (input.chiIndep > 160) {
    mult *= 0.8;
    breakerNotes.push(`X²indep ${input.chiIndep.toFixed(0)}`);
  }
  // Arrival variance: irregular cadence corrupts horizon timing.
  if (input.intervalCv > 0.35) {
    mult *= 0.75;
    breakerNotes.push(`var cv ${input.intervalCv.toFixed(2)}`);
  }
  // Ping proportional decay inside the safe band.
  if (input.pingMs > 0) {
    const ratio = input.pingMs / Math.max(1, input.safePingMs);
    if (ratio > 0.6) {
      mult *= Math.max(0.7, 1 - (ratio - 0.6) * 0.6);
      breakerNotes.push(`ping ${input.pingMs.toFixed(0)}ms`);
    }
  }
  if (input.neutralFallback) {
    mult *= 0.5;
    breakerNotes.push("hurst neutral");
  }
  if (input.exhausted) {
    mult *= 0.5;
    breakerNotes.push("fatigue muted");
  }

  // Hard blocks — no alert, no execution, regardless of score.
  if (input.health === "red") {
    blocked = true;
    blockReason = `network RED · ping ${input.pingMs.toFixed(0)}ms`;
  } else if (input.syncing) {
    blocked = true;
    blockReason = "clock drift · resyncing";
  } else if (input.stale) {
    blocked = true;
    blockReason = "stale tick gap";
  } else if (input.pingMs > input.safePingMs) {
    blocked = true;
    blockReason = `ping ${input.pingMs.toFixed(0)}ms > ${input.safePingMs}ms`;
  }

  votes.push({
    layer: 3,
    name: "circuit breakers",
    score: mult,
    weight: 0,
    detail: blocked ? `BLOCKED · ${blockReason}` : breakerNotes.join(" · ") || "clear",
  });

  const confidence = blocked ? 0 : clamp01(rawScore * mult);

  return {
    confidence,
    rawScore,
    breakerMultiplier: mult,
    votes,
    layer1,
    layer2,
    blocked,
    blockReason,
  };
}

/** Hard execution floor — strictly greater than 85%. */
export const EXECUTION_CONFIDENCE_FLOOR = 0.85;

export function meetsExecutionFloor(conf: number): boolean {
  return conf > EXECUTION_CONFIDENCE_FLOOR;
}
