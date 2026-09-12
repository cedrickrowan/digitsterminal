import { memo } from "react";
import type { HorizonForecast } from "@/lib/deriv/matrix";

interface Props {
  horizon: HorizonForecast;
  target: number;
}

const LEVELS = [2, 3, 4, 5, 6, 7];

/**
 * Cumulative probability that a digit appears at least N times across the
 * rolling 10-tick sliding window (Poisson-binomial over P^1..P^10).
 */
function MultiAppearancePanelImpl({ horizon, target }: Props) {
  const tgt = horizon.multi[target];
  return (
    <div className="rounded-md border border-border bg-card px-2 py-2 text-[11px]">
      <div className="mb-1 flex items-center justify-between px-1">
        <span className="font-semibold">
          Multi-Appearance · P<sup>{horizon.horizon}</sup>
          <span className="text-muted-foreground"> · 10-tick window</span>
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          H {horizon.hurst.toFixed(2)}
          {horizon.neutralFallback ? " · neutral" : ""}
        </span>
      </div>

      <div className="mb-2 grid grid-cols-6 gap-1">
        {LEVELS.map((n) => {
          const p = tgt?.tail[n] ?? 0;
          return (
            <div
              key={n}
              className="rounded-sm border border-input px-1 py-1 text-center"
              style={{ backgroundColor: `hsl(var(--primary-hsl) / ${Math.min(0.8, p)})` }}
            >
              <div className="font-mono text-[10px] text-muted-foreground">≥{n}x</div>
              <div className="font-mono text-xs font-bold tabular-nums">
                {(p * 100).toFixed(0)}%
              </div>
            </div>
          );
        })}
      </div>

      <div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Repeat ≥2x in next 3 ticks · jump safe (t+1 / t+2 entry)
      </div>
      <div className="mb-2 grid grid-cols-5 gap-1">
        {(horizon.runs ?? []).map((r) => (
          <div
            key={r.digit}
            className={`rounded-sm border px-1 py-1 text-center ${
              r.digit === horizon.runTopDigit ? "border-success ring-1 ring-success" : "border-input"
            }`}
          >
            <div className="font-mono text-sm font-bold tabular-nums">{r.digit}</div>
            <div className="font-mono text-[10px] tabular-nums">{(r.pRunSafe * 100).toFixed(1)}%</div>
            <div className="font-mono text-[9px] text-muted-foreground">
              pair {(r.pConsecutive * 100).toFixed(0)}%
            </div>
          </div>
        ))}
      </div>



      <div className="grid grid-cols-5 gap-1">
        {horizon.multi.map((m) => (
          <div
            key={m.digit}
            className={`rounded-sm border px-1 py-1 text-center ${
              m.digit === horizon.topDigit ? "border-cyan ring-1 ring-cyan" : "border-input"
            }`}
          >
            <div className="font-mono text-sm font-bold tabular-nums">{m.digit}</div>
            <div className="font-mono text-[10px] tabular-nums">
              {(m.horizonProb * 100).toFixed(1)}%
            </div>
            <div className="font-mono text-[9px] text-muted-foreground">
              {m.bestN}x·{(m.bestNProb * 100).toFixed(0)}%
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export const MultiAppearancePanel = memo(MultiAppearancePanelImpl);
