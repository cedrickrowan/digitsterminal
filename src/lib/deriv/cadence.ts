// Asset calibration: decimal precision + tick cadence profile.
// Decimals verified live against Deriv ticks_history pip_size (Oct 2026).

export const CALIBRATED_DECIMALS: Record<string, number> = {
  R_10: 3, R_25: 3, R_50: 4, R_75: 4, R_100: 2,
  "1HZ10V": 2, "1HZ15V": 3, "1HZ25V": 2, "1HZ30V": 3, "1HZ50V": 2,
  "1HZ75V": 2, "1HZ90V": 3, "1HZ100V": 2,
};

/** Deriv sends pip_size as an integer decimal count; tolerate 0.01-style too. */
export function normalizePip(pip: unknown): number | null {
  const n = Number(pip);
  if (!Number.isFinite(n)) return null;
  if (Number.isInteger(n) && n >= 0 && n <= 8) return n;
  if (n > 0 && n < 1) {
    const d = Math.round(-Math.log10(n));
    return d >= 0 && d <= 8 ? d : null;
  }
  return null;
}

/** Calibrated map is authoritative for known assets; live pip only for unknown ones. */
export function decimalsFor(symbol: string, livePip?: unknown): number {
  const cal = CALIBRATED_DECIMALS[symbol];
  if (cal !== undefined) return cal;
  return normalizePip(livePip) ?? 2;
}

/**
 * Last digit via integer scaling at calibrated precision — avoids float
 * string artefacts (e.g. 2606.86 at 3dp → 2606860 → digit 0).
 */
export function extractLastDigit(price: number, decimals: number): number {
  if (!Number.isFinite(price)) return -1;
  const scaled = Math.round(Math.abs(price) * Math.pow(10, decimals));
  if (!Number.isFinite(scaled)) return -1;
  const d = scaled % 10;
  // Cross-check with fixed-precision string (trailing zeros preserved).
  const s = Math.abs(price).toFixed(decimals);
  const sd = parseInt(s.charAt(s.length - 1), 10);
  if (sd !== d) return Number.isInteger(sd) && sd >= 0 && sd <= 9 ? sd : -1;
  return d;
}

export interface CadenceProfile {
  is1s: boolean;
  tickMs: number;
  budgetMs: number;
  safeWindowMs: number;
  jitterLimitMs: number;
  staleAfterMs: number;
}

export function cadenceProfile(symbol: string): CadenceProfile {
  const is1s = /^1HZ\d+V$/.test(symbol);
  return is1s
    ? { is1s, tickMs: 1000, budgetMs: 1000, safeWindowMs: 700, jitterLimitMs: 120, staleAfterMs: 4000 }
    : { is1s, tickMs: 2000, budgetMs: 2000, safeWindowMs: 1500, jitterLimitMs: 250, staleAfterMs: 4000 };
}

/**
 * Cadence-normalized exponential decay: a half-life expressed in SECONDS is
 * converted to a per-tick rate, so 1s and 2s streams forget at the same
 * wall-clock speed. λ_tick = ln2 · tickMs / (halfLifeSec · 1000).
 */
export function decayPerTick(symbol: string, halfLifeSec: number): number {
  const { tickMs } = cadenceProfile(symbol);
  return (Math.LN2 * tickMs) / (halfLifeSec * 1000);
}
