import { memo } from "react";
import type { DirectionBlock, EngineResult, OverUnderBlock, ParityBlock } from "@/lib/deriv/navigator";

interface Props {
  /** Navigator horizon blocks — the same engine state as every other panel. */
  nav: EngineResult | null;
  /** Legacy fallbacks while the navigator buffer is still seeding. */
  fallback: { pEven: number; pHigh: number; riseUp: number; riseDown: number };
  barrier: number;
  hot: number;
  cold: number;
  hotFreq: number[];
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
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
        <span className="text-cyan">{leftLabel} {pct(leftPct)}</span>
        <span className="text-magenta">{pct(rightPct)} {rightLabel}</span>
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
  const nav = p.nav;
  const evenOdd: ParityBlock | null = nav?.evenOdd ?? null;
  const overUnder: OverUnderBlock | null = nav?.overUnder ?? null;
  const direction: DirectionBlock | null = nav?.riseFall ?? null;

  // Sync inputs with exact 3-way and 2-way matrix realities
  const pEven = evenOdd ? evenOdd.pEven : p.fallback.pEven;
  const pOdd = evenOdd ? evenOdd.pOdd : (1 - p.fallback.pEven);
  
  const pOver = overUnder ? overUnder.pOver : p.fallback.pHigh;
  const pUnder = overUnder ? overUnder.pUnder : (1 - p.fallback.pHigh);
  const ouLabel = overUnder ? String(overUnder.barrier) : String(p.barrier);
  
  const pRise = direction ? direction.pRise : p.fallback.riseUp / Math.max(1, p.fallback.riseUp + p.fallback.riseDown);
  const pFall = direction ? direction.pFall : 1 - pRise;

  return (
    <div className="space-y-2 rounded-lg border border-border bg-card px-3 py-2">
      <div className="text-[10px] uppercase tracking-widest text-cyan">Split analysis · horizon D={nav?.selectedDuration ?? "—"}</div>
      <Pair leftLabel="EVEN" leftPct={pEven} rightLabel="ODD" rightPct={pOdd} />
      <Pair leftLabel={`OVER ${ouLabel}`} leftPct={pOver} rightLabel={`UNDER ${ouLabel}`} rightPct={pUnder} />
      <Pair leftLabel="RISE" leftPct={pRise} rightLabel="FALL" rightPct={pFall} />

      <div className="flex justify-between border-t border-border pt-2 text-[11px]">
        <span className="text-muted-foreground">
          Hot (30): <span className="font-mono font-bold text-cyan">{p.hot}</span> ×{p.hotFreq[p.hot]}
        </span>
        <span className="text-muted-foreground">
          Cold (30): <span className="font-mono font-bold text-magenta">{p.cold}</span> ×{p.hotFreq[p.cold]}
        </span>
      </div>
    </div>
  );
}

export const SplitPanel = memo(SplitPanelImpl);
