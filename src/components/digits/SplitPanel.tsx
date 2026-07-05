import { memo } from "react";

interface Props {
  pEven: number;
  pHigh: number;
  hot: number;
  cold: number;
  hotFreq: number[];
  riseUp: number;
  riseDown: number;
}

function Pair({
  leftLabel,
  leftPct,
  rightLabel,
  rightPct,
}: {
  leftLabel: string;
  leftPct: number;
  rightLabel: string;
  rightPct: number;
}) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-[10px] font-mono tabular-nums">
        <span className="text-cyan">{leftLabel} {Math.round(leftPct * 100)}%</span>
        <span className="text-magenta">{Math.round(rightPct * 100)}% {rightLabel}</span>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-secondary">
        <div
          className="bg-cyan shadow-[0_0_8px_var(--color-cyan)]"
          style={{ width: `${leftPct * 100}%` }}
        />
        <div
          className="bg-magenta shadow-[0_0_8px_var(--color-magenta)]"
          style={{ width: `${rightPct * 100}%` }}
        />
      </div>
    </div>
  );
}

function SplitPanelImpl(p: Props) {
  const total = Math.max(1, p.riseUp + p.riseDown);
  return (
    <div className="space-y-2 rounded-lg border border-border bg-card px-3 py-2">
      <div className="text-[10px] uppercase tracking-widest text-cyan">Split analysis</div>
      <Pair leftLabel="EVEN" leftPct={p.pEven} rightLabel="ODD" rightPct={1 - p.pEven} />
      <Pair leftLabel="UNDER(0-4)" leftPct={1 - p.pHigh} rightLabel="OVER(5-9)" rightPct={p.pHigh} />
      <Pair leftLabel="RISE" leftPct={p.riseUp / total} rightLabel="FALL" rightPct={p.riseDown / total} />
      <div className="flex justify-between border-t border-border pt-2 text-[11px]">
        <span className="text-muted-foreground">
          Hot (decay): <span className="font-mono font-bold text-cyan">{p.hot}</span> ×{p.hotFreq[p.hot].toFixed(1)}
        </span>
        <span className="text-muted-foreground">
          Cold (decay): <span className="font-mono font-bold text-magenta">{p.cold}</span> ×{p.hotFreq[p.cold].toFixed(1)}
        </span>
      </div>
    </div>
  );
}

export const SplitPanel = memo(SplitPanelImpl);
