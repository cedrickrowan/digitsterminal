// Composable trigger rules engine.

import type { AppConfig } from "./types";
import {
  coldProb,
  ensemblePredict,
  frequencies,
  gapsSinceLast,
  markov1,
  sequenceFollowups,
  tailStreak,
} from "./stats";

export interface RuleContext {
  window: number[];
  cfg: AppConfig;
}

export interface RuleHit {
  rule: string;
  detail: string;
}

/** Number of legacy trigger rules the user has switched on. */
export function enabledRuleCount(cfg: AppConfig): number {
  return Object.values(cfg.rules).filter(Boolean).length;
}

/** True only when EVERY enabled legacy rule fired on this window (strict AND).
 *  If no legacy rules are enabled, they do not block (returns true). */
export function allRulesAgree(cfg: AppConfig, hits: RuleHit[]): boolean {
  const enabledKeys = (Object.keys(cfg.rules) as Array<keyof AppConfig["rules"]>).filter(
    (k) => cfg.rules[k],
  );
  if (enabledKeys.length === 0) return true;
  const fired = new Set(hits.map((h) => h.rule));
  return enabledKeys.every((k) => fired.has(k));
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

  if (cfg.rules.sequence && window.length >= 1) {
    const horizon = Math.max(1, cfg.duration);
    const pattern = window.slice(-Math.min(horizon, window.length));
    const { probs, total, pattern: prefix } = sequenceFollowups(window, pattern, horizon);
    if (total >= 3 && probs[cfg.predictDigit] * 100 > cfg.triggerSequenceAbove) {
      hits.push({
        rule: "sequence",
        detail: `[${prefix.join("")}]→+${horizon} ${(probs[cfg.predictDigit] * 100).toFixed(0)}%`,
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

  return hits;
}
