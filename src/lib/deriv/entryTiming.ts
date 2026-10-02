import { cadenceProfile } from "./cadence";
// Dynamic Entry Timing Engine.
// Converts network RTT, jitter and tick cadence into a manual-entry stage.

export type EntryStage = "IDLE" | "PREPARE" | "CLICK_NOW" | "ABORT";

export const HUMAN_RESPONSE_MS = 250;

export function isOneSecondSymbol(symbol: string): boolean {
  return /^1HZ\d+V$/.test(symbol);
}

/** Execution budget = tick cadence. */
export function executionBudgetMs(symbol: string): number {
  return cadenceProfile(symbol).budgetMs;
}

/** Safe green window inside the budget. */
export function safeWindowMs(symbol: string): number {
  return cadenceProfile(symbol).safeWindowMs;
}

/** Jitter ceiling before entry is locked out. */
export function jitterLimitMs(symbol: string): number {
  return cadenceProfile(symbol).jitterLimitMs;
}

/** Rolling sample window with mean + standard deviation. */
export class RollingStats {
  private buf: number[] = [];
  constructor(private size = 20) {}
  push(v: number) {
    if (!Number.isFinite(v) || v <= 0) return;
    this.buf.push(v);
    if (this.buf.length > this.size) this.buf.shift();
  }
  clear() {
    this.buf = [];
  }
  count() {
    return this.buf.length;
  }
  mean() {
    if (!this.buf.length) return 0;
    let s = 0;
    for (const v of this.buf) s += v;
    return s / this.buf.length;
  }
  std() {
    const n = this.buf.length;
    if (n < 2) return 0;
    const m = this.mean();
    let s = 0;
    for (const v of this.buf) s += (v - m) * (v - m);
    return Math.sqrt(s / (n - 1));
  }
}

export interface EntryTimingInput {
  symbol: string;
  msSinceTick: number; // time since the last tick arrived
  rttMs: number; // rolling mean RTT
  rttJitterMs: number; // std dev of RTT
  arrivalJitterMs: number; // std dev of tick inter-arrival gaps
  setupForming: boolean; // conditions approaching (PREPARE)
  setupGreen: boolean; // all gates passed (CLICK NOW candidate)
}

export interface EntryTiming {
  stage: EntryStage;
  budgetMs: number;
  safeMs: number;
  /** Time the order actually lands after the last tick: elapsed + RTT/2 + human response. */
  effectiveMs: number;
  /** Remaining time inside the safe window (negative = late). */
  remainingMs: number;
  jitterMs: number;
  reason: string;
}

export function computeEntryTiming(i: EntryTimingInput): EntryTiming {
  const budgetMs = executionBudgetMs(i.symbol);
  const safeMs = safeWindowMs(i.symbol);
  const jitterMs = Math.max(i.rttJitterMs, i.arrivalJitterMs);
  const effectiveMs = i.msSinceTick + i.rttMs / 2 + HUMAN_RESPONSE_MS;
  const remainingMs = safeMs - effectiveMs;
  const base = { budgetMs, safeMs, effectiveMs, remainingMs, jitterMs };

  if (!i.setupGreen) {
    return {
      ...base,
      stage: i.setupForming ? "PREPARE" : "IDLE",
      reason: i.setupForming ? "setup forming" : "waiting for setup",
    };
  }
  if (jitterMs > jitterLimitMs(i.symbol)) {
    return { ...base, stage: "ABORT", reason: `jitter ${Math.round(jitterMs)}ms` };
  }
  if (effectiveMs >= budgetMs || remainingMs <= 0) {
    return { ...base, stage: "ABORT", reason: "past safe window" };
  }
  return { ...base, stage: "CLICK_NOW", reason: `${Math.round(remainingMs)}ms left` };
}
