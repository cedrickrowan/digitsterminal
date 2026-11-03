export type Mode = "alert" | "simulated" | "live";
export type NetHealth = "green" | "yellow" | "red";
export type Market = "matches" | "overunder" | "evenodd" | "risefall";

export interface RuleToggles {
  streak: boolean;
  prob: boolean;
  markov: boolean;
  sequence: boolean;
  cold: boolean;
  deviation: boolean;
  ensemble: boolean;
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
  { value: "1HZ150V", label: "Volatility 150 (1s)" },
  { value: "1HZ250V", label: "Volatility 250 (1s)" },
];
