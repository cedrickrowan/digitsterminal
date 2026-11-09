import type { EngineResult } from "./navigator";
import type { AppConfig, NavRuleToggles, NavThresholds } from "./types";

export type AlertDecisionConfig = Pick<
  AppConfig,
  "symbol" | "market" | "duration" | "predictDigit" | "barrier"
> & Partial<Pick<AppConfig, "navRules" | "navThresholds">>;

export interface FeedSafetyInput {
  connected: boolean;
  staleGap: boolean;
  symbol: string;
  rttMs: number;
  lastArrivalAt: number;
  now: number;
  gapBudgetMs: number;
}

export function pingLimitForSymbol(symbol: string): number {
  return /^1HZ\d+V$/.test(symbol) ? 350 : 500;
}

export function isFeedSafe(input: FeedSafetyInput): boolean {
  const pingLimit = pingLimitForSymbol(input.symbol);
  const age = input.now - input.lastArrivalAt;
  return (
    input.connected &&
    !input.staleGap &&
    input.rttMs > 0 &&
    Number.isFinite(input.rttMs) &&
    input.rttMs < pingLimit &&
    input.lastArrivalAt > 0 &&
    age >= 0 &&
    age <= input.gapBudgetMs
  );
}

export function alertDecisionSignature(
  config: AlertDecisionConfig,
  rules: NavRuleToggles | undefined = config.navRules,
  thresholds: NavThresholds | undefined = config.navThresholds,
): string {
  return JSON.stringify([
    config.symbol,
    config.market,
    config.duration,
    config.predictDigit,
    config.barrier,
    rules ? Object.values(rules) : null,
    thresholds ? Object.values(thresholds) : null,
  ]);
}

export function isNavigatorAlertEligible(
  result: EngineResult | null,
  config: AlertDecisionConfig,
  feedSafe: boolean,
  currentTickId?: number,
  legacyRulesPass = true,
): boolean {
  if (
    !result ||
    !feedSafe ||
    !legacyRulesPass ||
    result.alertDecision !== "READY / MANUAL ALERT" ||
    result.symbol !== config.symbol ||
    result.market !== config.market ||
    result.selectedDuration !== config.duration ||
    result.decisionSignature !== alertDecisionSignature(config) ||
    (currentTickId !== undefined && result.tickId !== currentTickId)
  ) {
    return false;
  }

  if (config.market === "matches" || config.market === "differs") {
    if (result.navTargetDigit !== config.predictDigit) return false;
    const rules = config.navRules;
    if (!rules) return false;
    return (Object.keys(rules) as Array<keyof NavRuleToggles>).every((rule) => {
      if (!rules[rule]) return true;
      const hit = result.navRuleHits.find((item) => item.rule === rule);
      return hit?.enabled === true && hit.pass;
    });
  }

  if (config.market === "overunder") return result.overUnder?.barrier === config.barrier;
  return true;
}
