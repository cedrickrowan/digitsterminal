import { memo } from "react";

interface Props {
  chi: number;
  h20: number;
  h50: number;
  h100: number;
  coldDigit: number;
  coldGap: number;
  coldProb: number;
  followPrefix: [number, number] | null;
  followProbs: number[];
  followTotal: number;
}

function StatsPanelImpl(p: Props) {
  return (
    <div className="space-y-2 rounded-md border border-border bg-card px-3 py-2 text-xs">
      <div className="grid grid-cols-2 gap-1 tabular-nums">
        <div>χ² (100): <span className="font-semibold">{p.chi.toFixed(2)}</span></div>
        <div>H₂₀: <span className="font-semibold">{p.h20.toFixed(2)}</span></div>
        <div>H₅₀: <span className="font-semibold">{p.h50.toFixed(2)}</span></div>
        <div>H₁₀₀: <span className="font-semibold">{p.h100.toFixed(2)}</span></div>
      </div>
      <div className="border-t border-border pt-2">
        Coldest: digit <span className="font-semibold">{p.coldDigit}</span> · gap {p.coldGap} ·
        P(stay cold) = {(p.coldProb * 100).toFixed(2)}%
      </div>
      <div className="border-t border-border pt-2">
        2-tick follow-up{" "}
        {p.followPrefix ? (
          <span className="font-mono">
            [{p.followPrefix[0]}→{p.followPrefix[1]}]
          </span>
        ) : (
          "—"
        )}{" "}
        <span className="text-muted-foreground">({p.followTotal} matches)</span>
        <div className="mt-1 grid grid-cols-10 gap-0.5">
          {p.followProbs.map((pr, d) => (
            <div
              key={d}
              className="flex flex-col items-center rounded-sm border border-border py-1 text-[10px]"
              style={{ backgroundColor: `hsl(var(--primary-hsl) / ${Math.min(0.8, pr * 2)})` }}
            >
              <span className="font-semibold leading-none">{d}</span>
              <span className="tabular-nums">{(pr * 100).toFixed(0)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export const StatsPanel = memo(StatsPanelImpl);
