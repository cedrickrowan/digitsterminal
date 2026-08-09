import { memo } from "react";

export type SignalState = "green" | "red" | "violet";

interface Props {
  state: SignalState;
  digit: number;
  /** Cumulative probability of the required multi-appearance run (0..1). */
  runProb: number;
  targetN: number;
  horizon: 2 | 3;
  /** ms until the multi-appearance window opens (already latency corrected). */
  windowInMs: number;
  preWarn: boolean;
  streak: { step: number; of: number } | null;
  smoothedDrift: number;
}

/**
 * Peripheral-friendly signal block. Designed to be read with the corner of the
 * eye on a split screen: one massive solid colour, no micro-text clutter.
 */
function SignalCardImpl({
  state,
  digit,
  runProb,
  targetN,
  horizon,
  windowInMs,
  preWarn,
  streak,
  smoothedDrift,
}: Props) {
  const bg =
    state === "green" ? "bg-success" : state === "violet" ? "bg-violet" : "bg-danger";
  const fg = state === "violet" ? "text-white" : "text-background";

  const headline =
    state === "violet"
      ? "NETWORK SYNCING"
      : state === "green"
        ? streak
          ? "STREAK CONTINUING"
          : "EXECUTE NOW"
        : "HOLD — NO SETUP";

  const sub =
    state === "violet"
      ? "HOLD TRADES"
      : state === "green"
        ? streak
          ? `STEP ${streak.step} OF ${streak.of}`
          : `MATCH DIGIT ${digit} · ${targetN}x IN 10`
        : "CHAOTIC NOISE";

  return (
    <div
      className={`relative overflow-hidden rounded-xl ${bg} ${fg} px-4 py-5 text-center ${
        preWarn && state === "green" ? "prewarn-glow" : ""
      }`}
    >
      <div className="text-xs font-bold uppercase tracking-[0.3em] opacity-80">
        {headline}
      </div>

      {state === "green" ? (
        <div className="mt-1 flex items-center justify-center gap-4">
          <div className="font-mono text-7xl font-black leading-none tabular-nums">
            {digit}
          </div>
          <div className="text-left">
            <div className="font-mono text-2xl font-bold tabular-nums">
              {(runProb * 100).toFixed(1)}%
            </div>
            <div className="text-[11px] font-semibold uppercase tracking-wider opacity-80">
              t+{horizon} horizon
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-2 font-mono text-4xl font-black leading-none tracking-tight">
          {state === "violet" ? `${Math.round(Math.abs(smoothedDrift))}ms` : "—"}
        </div>
      )}

      <div className="mt-2 text-sm font-bold uppercase tracking-widest">{sub}</div>

      {state === "green" && (
        <div className="mt-2 font-mono text-[11px] font-semibold uppercase tracking-wider opacity-80">
          {windowInMs <= 0
            ? "WINDOW OPEN"
            : `WINDOW IN ${Math.round(windowInMs)}ms${preWarn ? " · GET READY" : ""}`}
        </div>
      )}
    </div>
  );
}

export const SignalCard = memo(SignalCardImpl);
