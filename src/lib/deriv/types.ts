export type Mode = "alert" | "simulated" | "live";
export type NetHealth = "green" | "yellow" | "red";

export interface RuleToggles {
  streak: boolean;
  prob: boolean;
  markov: boolean;
  sequence: boolean;
  cold: boolean;
  deviation: boolean;
}

export interface AppConfig {
  symbol: string;
  predictDigit: number;
  duration: number;
  stake: number;
  lookback: 25 | 50 | 100;
  latencyOffsetMs: number;
  mode: Mode;
  triggerStreak: number;
  triggerProbBelow: number;
  triggerMarkovAbove: number;
  triggerSequenceAbove: number;
  triggerColdProbBelow: number;
  triggerDeviationPct: number;
  rules: RuleToggles;
}

export interface Signal {
  id: number;
  ts: number;
  reason: string;
  predicted: number;
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
  lookback: 50,
  latencyOffsetMs: 1000,
  mode: "simulated",
  triggerStreak: 3,
  triggerProbBelow: 8,
  triggerMarkovAbove: 18,
  triggerSequenceAbove: 20,
  triggerColdProbBelow: 10,
  triggerDeviationPct: 4,
  rules: {
    streak: true,
    prob: true,
    markov: true,
    sequence: false,
    cold: false,
    deviation: false,
  },
};

export const SYMBOLS = [
  { value: "R_10", label: "Volatility 10" },
  { value: "R_25", label: "Volatility 25" },
  { value: "R_50", label: "Volatility 50" },
  { value: "R_75", label: "Volatility 75" },
  { value: "R_100", label: "Volatility 100" },
  { value: "1HZ10V", label: "Vol 10 (1s)" },
  { value: "1HZ100V", label: "Vol 100 (1s)" },
];
