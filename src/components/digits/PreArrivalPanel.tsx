import { memo } from "react";
import type { PreArrivalForecast, PreArrivalPhysics } from "@/lib/deriv/preArrival";

interface Props {
  forecasts: PreArrivalForecast[];
  physics: PreArrivalPhysics;
  topDigit: number;
}

function Flag({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      className={`rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase ${
        on ? "border-cyan text-cyan" : "border-input text-muted-foreground"
      }`}
    >
      {label}
    </span>
  );
}

function PreArrivalPanelImpl({ forecasts, physics, topDigit }: Props) {
  return (
    <div className="rounded-md border border-border bg-card px-2 py-2 text-[11px]">
      <div className="mb-1 flex items-center justify-between px-1">
        <span className="font-semibold">
          Pre-Arrival Engine <span className="text-muted-foreground">· horizon {physics.horizonTargetDepth}t</span>
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {physics.ready ? `${physics.computeMs.toFixed(1)}ms` : "warming…"}
        </span>
      </div>

      <div className="mb-2 flex flex-wrap gap-1">
        <Flag on={physics.isSystemLockingIntoLoop} label="loop lock" />
        <Flag on={physics.isStreamHighlyPersistent} label="persistent" />
        <Flag on={physics.isWavePatternSynchronized} label="wave sync" />
        <Flag on={physics.isAnomalousClusterStream} label="cluster bias" />
      </div>

      <div className="mb-2 grid grid-cols-3 gap-1 font-mono text-[10px] text-muted-foreground">
        <div>λ <span className="text-foreground">{physics.lyapunovExponent.toFixed(3)}</span></div>
        <div>H <span className="text-foreground">{physics.hurstExponent.toFixed(3)}</span></div>
        <div>FFT <span className="text-foreground">{physics.harmonicWaveCoeff.toFixed(3)}</span></div>
        <div>KS <span className="text-foreground">{physics.ksDivergence.toFixed(3)}</span></div>
        <div>M3 <span className="text-foreground">{physics.markov3Context}</span></div>
        <div>top <span className="text-foreground">{topDigit >= 0 ? topDigit : "—"}</span></div>
      </div>

      <div className="grid grid-cols-5 gap-1">
        {forecasts.map((f) => {
          const alpha = Math.min(0.85, f.preArrivalProbability / 90);
          return (
            <div
              key={f.digit}
              className={`rounded-sm border px-1 py-1 text-center ${
                f.isExhaustedState
                  ? "border-danger/60 opacity-60"
                  : f.isQuantumLockWarning
                    ? "border-success ring-1 ring-success"
                    : "border-input"
              }`}
              style={{ backgroundColor: `hsl(var(--primary-hsl) / ${alpha})` }}
            >
              <div className="font-mono text-sm font-bold tabular-nums">{f.digit}</div>
              <div className="font-mono text-[10px] tabular-nums">
                {f.preArrivalProbability.toFixed(1)}%
              </div>
              <div className="text-[9px] uppercase text-muted-foreground">
                {f.isExhaustedState
                  ? "spent"
                  : f.predictedStreakLength > 0
                    ? `x${f.predictedStreakLength}`
                    : "—"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const PreArrivalPanel = memo(PreArrivalPanelImpl);
