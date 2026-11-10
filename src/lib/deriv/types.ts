export type Mode = "alert" | "simulated" | "live";
export type NetHealth = "green" | "yellow" | "red";
export type Market = "matches" | "differs" | "overunder" | "evenodd" | "risefall";

export interface RuleToggles {
  streak: boolean;
  prob: boolean;
  markov: boolean;
  sequence: boolean;
  cold: boolean;
  deviation: boolean;
  ensemble: boolean;
}

/** Unified trigger rules (Matches) — strict AND when enabled (all 18 rules). */
export interface NavRuleToggles {
  // 7 Legacy rules
  ensemble: boolean;
  markov: boolean;
  streak: boolean;
  prob: boolean;
  sequence: boolean;
  cold: boolean;
  deviation: boolean;

  // 11 Navigator rules
  multiHit: boolean;
  pairRun: boolean;
  landing: boolean;
  freshness: boolean;
  parity: boolean;
  barrier: boolean;
  lowEntropy: boolean;
  antiRepeat: boolean;
  frequencyEnvelope: boolean;
  markovD: boolean;
  hurstFilter: boolean;
  macroConfluence: boolean;
}

/** Percent thresholds for the unified trigger rules. */
export interface NavThresholds {
  // 7 Legacy thresholds
  triggerEnsembleAbove: number;
  triggerMarkovAbove: number;
  triggerStreak: number;
  triggerProbBelow: number;
  triggerSequenceAbove: number;
  triggerColdProbBelow: number;
  triggerDeviationPct: number;

  // 11 Navigator thresholds
  multiHitPct: number;
  pairRunPct: number;
  landingPct: number;
  parityPct: number;
  barrierPct: number;
  entropyZMax: number;
  frequencyMinPct: number;
  frequencyMaxPct: number;
  markovDPct: number;
  differsProbabilityCeilingPct: number;
  differsColdGapMin: number;
  hurstMinEdge: number;
}

export interface AppConfig {
  symbol: string;
  predictDigit: number;
  duration: number;
  stake: number;
  lookback: number; // any multiple of 3, 3..900 (see snapLookback)
  latencyOffsetMs: number;
  mode: Mode;
  market: Market;
  barrier: number; // for over/under
  triggerStreak: number;
  triggerProbBelow: number;
  triggerMarkovAbove: number;
  triggerSequenceAbove: number;
  triggerColdProbBelow: number;
  triggerDeviationPct: number;
  triggerEnsembleAbove: number; // confidence %
  safePingMs: number; // execution safety: max ping
  safeGapMs: number; // execution safety: max inter-tick gap
  rules: RuleToggles;
  navRules: NavRuleToggles;
  navThresholds: NavThresholds;
}

export interface Signal {
  id: number;
  ts: number;
  reason: string;
  predicted: number;
  market?: Market;
  side?: string; // "OVER 5" | "EVEN" | "RISE" etc.
  entryPrice?: number;
  entryTick?: number;
  resolvedDigit?: number;
  result?: "win" | "loss";
  /** Engine-expected probability at signal time (scorecard baseline). */
  expected?: number;
  mode: Mode;
}

export const DEFAULT_CONFIG: AppConfig = {
  symbol: "R_100",
  predictDigit: 5,
  duration: 1,
  stake: 1,
  lookback: 30,
  latencyOffsetMs: 1000,
  mode: "simulated",
  market: "matches",
  barrier: 4,
  triggerStreak: 3,
  triggerProbBelow: 8,
  triggerMarkovAbove: 18,
  triggerSequenceAbove: 20,
  triggerColdProbBelow: 10,
  triggerDeviationPct: 4,
  triggerEnsembleAbove: 22,
  safePingMs: 500,
  safeGapMs: 800,
  rules: {
    streak: false,
    prob: false,
    markov: true,
    sequence: false,
    cold: false,
    deviation: false,
    ensemble: true,
  },
  // Navigator rule defaults mirror the previous engine behaviour: exact
  // multi-hit ≥ 7% density floor + freshness (anti-tired) suppression.
    navRules: {
    // Legacy 7
    ensemble: false,
    markov: false,
    streak: false,
    prob: false,
    sequence: false,
    cold: false,
    deviation: false,
    // Navigator 11
    multiHit: true,
    pairRun: false,
    landing: false,
    freshness: true,
    parity: false,
    barrier: false,
    lowEntropy: false,
    antiRepeat: false,
    frequencyEnvelope: false,
    markovD: false,
    hurstFilter: false,
  },

  navThresholds: {
    // Legacy 7
    triggerEnsembleAbove: 22,
    triggerMarkovAbove: 18,
    triggerStreak: 3,
    triggerProbBelow: 8,
    triggerSequenceAbove: 20,
    triggerColdProbBelow: 10,
    triggerDeviationPct: 4,
    // Navigator 11
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
  },
};
// Verified live against Deriv (app_id 1089). 1HZ200V / 1HZ300V are not offered.
export const SYMBOLS = [
  { value: "R_10", label: "Volatility 10" },
  { value: "R_25", label: "Volatility 25" },
  { value: "R_50", label: "Volatility 50" },
  { value: "R_75", label: "Volatility 75" },
  { value: "R_100", label: "Volatility 100" },
  { value: "1HZ10V", label: "Volatility 10 (1s)" },
  { value: "1HZ15V", label: "Volatility 15 (1s)" },
  { value: "1HZ25V", label: "Volatility 25 (1s)" },
  { value: "1HZ30V", label: "Volatility 30 (1s)" },
  { value: "1HZ50V", label: "Volatility 50 (1s)" },
  { value: "1HZ75V", label: "Volatility 75 (1s)" },
  { value: "1HZ90V", label: "Volatility 90 (1s)" },
  { value: "1HZ100V", label: "Volatility 100 (1s)" },
];
