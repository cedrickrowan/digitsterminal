// Composable trigger rules engine.

import type { AppConfig } from "./types";
import {
  coldProb,
  ensemblePredict,
  frequencies,
  gapsSinceLast,
  markov1,
  tailStreak,
  twoTickFollowups,
} from "./stats";

export interface RuleContext {
  window: number[];
  cfg: AppConfig;
}

export interface RuleHit {
  rule: string;
  detail: string;
}

export function evaluateRules({ window, cfg }: RuleContext): RuleHit[] {
  const hits: RuleHit[] = [];
  if (window.length < 10) return hits;
  const n = window.length;
  const freq = frequencies(window);
  const pPredict = freq[cfg.predictDigit] / n;

  if (cfg.rules.streak) {
    const { digit, len } = tailStreak(window);
    if (digit === cfg.predictDigit && len >= cfg.triggerStreak) {
      hits.push({ rule: "streak", detail: `${len}×${digit}` });
    }
  }

  if (cfg.rules.prob && pPredict * 100 < cfg.triggerProbBelow) {
    hits.push({ rule: "prob", detail: `freq=${(pPredict * 100).toFixed(1)}%` });
  }

  if (cfg.rules.markov) {
    const last = window[window.length - 1];
    const m = markov1(window);
    const pTrans = m[last]?.[cfg.predictDigit] ?? 0;
    if (pTrans * 100 > cfg.triggerMarkovAbove) {
      hits.push({ rule: "markov", detail: `P(${cfg.predictDigit}|${last})=${(pTrans * 100).toFixed(0)}%` });
    }
  }

  if (cfg.rules.sequence && window.length >= 2) {
    const a = window[window.length - 2];
    const b = window[window.length - 1];
    const { probs, total } = twoTickFollowups(window, a, b);
    if (total >= 3 && probs[cfg.predictDigit] * 100 > cfg.triggerSequenceAbove) {
      hits.push({
        rule: "sequence",
        detail: `[${a}→${b}]→${cfg.predictDigit} ${(probs[cfg.predictDigit] * 100).toFixed(0)}%`,
      });
    }
  }

  if (cfg.rules.cold) {
    const g = gapsSinceLast(window)[cfg.predictDigit];
    const p = coldProb(g);
    if (p * 100 < cfg.triggerColdProbBelow) {
      hits.push({ rule: "cold", detail: `gap=${g} P=${(p * 100).toFixed(1)}%` });
    }
  }

  if (cfg.rules.deviation) {
    const dev = Math.abs(pPredict * 100 - 10);
    if (dev > cfg.triggerDeviationPct) {
      hits.push({ rule: "deviation", detail: `Δ=${dev.toFixed(1)}%` });
    }
  }

  if (cfg.rules.ensemble) {
    const e = ensemblePredict(window);
    if (e.topDigit === cfg.predictDigit && e.confidence * 100 > cfg.triggerEnsembleAbove) {
      hits.push({ rule: "ensemble", detail: `→${e.topDigit} ${(e.confidence * 100).toFixed(0)}%` });
    }
  }

  if (cfg.rules.differs) {
    // Differs fires when chosen digit's Bayesian-smoothed frequency is very low
    // → high probability the next tick DIFFERS from it.
    const alphaSmoothed = (freq[cfg.predictDigit] + 1) / (n + 10);
    if (alphaSmoothed * 100 < cfg.triggerDiffersBelow) {
      hits.push({ rule: "differs", detail: `p=${(alphaSmoothed * 100).toFixed(1)}%` });
    }
  }

  return hits;
}

