export type Mode = "alert" | "simulated" | "live";
export type NetHealth = "green" | "yellow" | "red";

export interface AppConfig {
  symbol: string;
  predictDigit: number;
  duration: number;
  stake: number;
  lookback: 25 | 50 | 100;
  latencyOffsetMs: number;
  mode: Mode;
  rememberToken: boolean;
  token: string;
  triggerStreak: number;
  triggerProbBelow: number;
}

export interface Signal {
  id: number;
  ts: number;
  reason: string;
  predicted: number;
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
  rememberToken: false,
  token: "",
  triggerStreak: 3,
  triggerProbBelow: 8,
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
