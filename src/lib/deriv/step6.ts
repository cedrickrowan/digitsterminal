// Step 6 — landing-tick density, incline velocity, market directives, ping gates.
// Pure functions; reads existing engine outputs, modifies none of them.
import { cadenceProfile } from "./cadence";
import type { ParityResult, BarrierResult, RiseFallResult } from "./marketEngines";

/** Landing ticks covering a late click (t+2), normal entry (t+3) and a 2-tick bot jump (t+5). */
export const LANDING_TICKS = [2, 3, 5] as const;
export const LANDING_MIN_HITS = 2;
export const LANDING_DENSITY_FLOOR = 0.07; // P(≥2 of 3 landing ticks) — fair ≈ 2.8%, gate at ~2.5× fair
export const EXHAUSTED_GAP = 12;
export const DIRECTIVE_FLOOR = 0.58;
export const HAZARD_CEIL = 0.12;
export const KALMAN_V_MIN = 0.0002;

/** Laplace-smoothed first-order transition matrix from a window. */
function transition(window: number[]): number[][] {
  const c = Array.from({ length: 10 }, () => new Array(10).fill(1));
  for (let i = 1; i < window.length; i++) {
    const a = window[i - 1];
    const b = window[i];
    if (a >= 0 && a <= 9 && b >= 0 && b <= 9) c[a][b]++;
  }
  return c.map((row) => {
    const s = row.reduce((x, y) => x + y, 0);
    return row.map((x) => x / s);
  });
}

export interface LandingDensity {
  /** P(target appears on ≥2 of t+2, t+3, t+5), exact Markov DP. */
  density: number;
  /** Marginal P(target) at each landing tick. */
  perTick: number[];
  ok: boolean;
}

/**
 * Exact joint DP over ticks 1..5: state = (digit, hits on landing ticks so far).
 * No independence assumption between landing ticks.
 */
export function landingDensity(window: number[], target: number): LandingDensity {
  const last = window.length ? window[window.length - 1] : -1;
  if (last < 0 || last > 9) return { density: 0, perTick: [0, 0, 0], ok: false };
  const P = transition(window);
  const maxT = LANDING_TICKS[LANDING_TICKS.length - 1];
  // dist[d][h]
  let dist = Array.from({ length: 10 }, () => new Array(4).fill(0));
  dist[last][0] = 1;
  const perTick: number[] = [];
  for (let t = 1; t <= maxT; t++) {
    const next = Array.from({ length: 10 }, () => new Array(4).fill(0));
    const landing = (LANDING_TICKS as readonly number[]).includes(t);
    for (let d = 0; d < 10; d++)
      for (let h = 0; h < 4; h++) {
        const m = dist[d][h];
        if (!m) continue;
        for (let e = 0; e < 10; e++) {
          const nh = landing && e === target ? Math.min(3, h + 1) : h;
          next[e][nh] += m * P[d][e];
        }
      }
    dist = next;
    if (landing) perTick.push(dist[target].reduce((a, b) => a + b, 0));
  }
  let density = 0;
  for (let d = 0; d < 10; d++) for (let h = LANDING_MIN_HITS; h < 4; h++) density += dist[d][h];
  return { density, perTick, ok: density >= LANDING_DENSITY_FLOOR };
}

export interface InclineResult {
  vCluster: number; // f_fast − f_slow
  deviation: number; // f_fast − 0.10 neutral baseline
  gap: number; // ticks since last appearance
  rising: boolean;
  exhausted: boolean;
}

export function incline(window: number[], fastFreq: number[], slowFreq: number[], target: number): InclineResult {
  const vCluster = (fastFreq[target] ?? 0) - (slowFreq[target] ?? 0);
  const deviation = (fastFreq[target] ?? 0) - 0.1;
  let gap = window.length;
  for (let i = window.length - 1; i >= 0; i--)
    if (window[i] === target) {
      gap = window.length - 1 - i;
      break;
    }
  return { vCluster, deviation, gap, rising: vCluster > 0 && deviation > 0, exhausted: gap > EXHAUSTED_GAP };
}

export function pingHold(symbol: string, pingMs: number): string | null {
  const lim = cadenceProfile(symbol).is1s ? 350 : 700;
  return pingMs > lim ? `HOLD - PING > ${lim}ms` : null;
}

export interface Directive {
  text: string; // e.g. "TRADE EVEN" or "HOLD - …"
  active: boolean;
}

export function marketDirective(
  market: string,
  target: number,
  parity: ParityResult,
  bar: BarrierResult,
  rf: RiseFallResult,
  prices: number[],
): Directive {
  switch (market) {
    case "evenodd": {
      if (parity.regime === "NEUTRAL") return { text: "HOLD - PARITY NEUTRAL", active: false };
      if (parity.confidence < DIRECTIVE_FLOOR) return { text: `HOLD - PARITY < ${Math.round(DIRECTIVE_FLOOR * 100)}%`, active: false };
      if (parity.runsRegime === "RANDOM") return { text: "HOLD - RANDOM RUNS", active: false };
      return { text: `TRADE ${parity.regime}`, active: true };
    }
    case "overunder": {
      if (bar.pEqual >= HAZARD_CEIL) return { text: "HOLD - BARRIER HAZARD", active: false };
      if (bar.direction === "NEUTRAL" || bar.confidence < DIRECTIVE_FLOOR)
        return { text: `HOLD - BARRIER < ${Math.round(DIRECTIVE_FLOOR * 100)}%`, active: false };
      return { text: `TRADE ${bar.direction} ${bar.barrier}`, active: true };
    }
    case "risefall": {
      // No flat ticks across the last stride-3 span (3 increments).
      const tail = prices.slice(-4);
      let flat = tail.length < 4;
      for (let i = 1; i < tail.length; i++) if (tail[i] === tail[i - 1]) flat = true;
      if (flat) return { text: "HOLD - FLAT TICKS", active: false };
      if (Math.abs(rf.velocity) <= KALMAN_V_MIN || rf.signal === "HOLD")
        return { text: "HOLD - FLAT/DRIFTLESS", active: false };
      return { text: `TRADE ${rf.signal}`, active: true };
    }
    default:
      return { text: `MATCH ${target}`, active: true };
  }
}
