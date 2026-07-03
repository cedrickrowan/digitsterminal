// Network anomaly guard: detects slippage and packet bunching, and locks
// out signal firing for a cooldown after repeated anomalies. Pure state
// machine — safe to unit test and to drive from any tick source.

export const NET_GUARD = {
  SLIPPAGE_MS: 1200,
  BUNCH_MS: 100,
  LOCKOUT_MS: 300_000,
  ANOMALY_LIMIT: 3,
  DECAY: 0.1,
} as const;

export type NetGuardReason = "SLIPPAGE" | "BUNCHING" | null;

export interface NetGuardState {
  counter: number;
  lockedUntil: number; // wall-clock ms (Date.now())
  reason: NetGuardReason;
  lastSlippageMs: number;
  lastBunchingMs: number;
}

export function createNetGuardState(): NetGuardState {
  return {
    counter: 0,
    lockedUntil: 0,
    reason: null,
    lastSlippageMs: 0,
    lastBunchingMs: 0,
  };
}

export interface NetGuardInput {
  slippageMs: number;
  bunchingMs: number | null; // null when there is no previous tick baseline
  now?: number;
}

/**
 * Mutates and returns state. Call once per tick after digit extraction.
 * safe === true → signals may fire. safe === false → block signals only
 * (charts/stats keep updating in the caller).
 */
export function evaluateNetGuard(state: NetGuardState, input: NetGuardInput): NetGuardState & { safe: boolean } {
  const now = input.now ?? Date.now();
  state.lastSlippageMs = input.slippageMs;
  state.lastBunchingMs = input.bunchingMs ?? 0;

  let anomaly = false;
  let reason: NetGuardReason = null;

  if (input.slippageMs > NET_GUARD.SLIPPAGE_MS) {
    anomaly = true;
    reason = "SLIPPAGE";
  } else if (input.bunchingMs !== null && input.bunchingMs > 0 && input.bunchingMs < NET_GUARD.BUNCH_MS) {
    anomaly = true;
    reason = "BUNCHING";
  }

  if (anomaly) {
    state.counter += 1;
    state.reason = reason;
    if (state.counter >= NET_GUARD.ANOMALY_LIMIT) {
      state.lockedUntil = now + NET_GUARD.LOCKOUT_MS;
      state.counter = 0;
    }
  } else if (state.counter > 0) {
    state.counter = Math.max(0, state.counter - NET_GUARD.DECAY);
    if (state.counter === 0) state.reason = null;
  }

  const safe = now >= state.lockedUntil;
  return { ...state, safe };
}

export function isLocked(state: NetGuardState, now = Date.now()): boolean {
  return now < state.lockedUntil;
}
