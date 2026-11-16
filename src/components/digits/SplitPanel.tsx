import { memo } from "react";
import type { DirectionBlock, EngineResult, OverUnderBlock, ParityBlock } from "@/lib/deriv/navigator";

interface Props {
  nav: EngineResult | null;
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

function OverUnder3Way({
  barrier,
  pUnder,
  pTie,
  pOver,
  deadZone,
}: {
  barrier: number;
  pUnder: number;
  pTie: number;
  pOver: number;
  deadZone: boolean;
}) {
  const underPct = Math.round(pUnder * 100);
  const tiePct = Math.round(pTie * 100);
  const overPct = Math.round(pOver * 100);

  if (barrier === 0) {
    return (
      <div>
        <div className="mb-1 flex justify-between text-[10px] font-mono tabular-nums">
          <span className="text-muted-foreground">UNDER 0 (N/A) 0%</span>
          <span className="text-amber-400 font-bold">BARRIER 0 (LOSE) {tiePct}%</span>
          <span className="text-cyan">OVER 0 {overPct}%</span>
        </div>
        <div className="flex h-2 overflow-hidden rounded-full bg-secondary">
          <div className="bg-amber-400/80 shadow-[0_0_8px_rgba(251,191,36,0.6)]" style={{ width: `${tiePct}%` }} />
          <div className="bg-cyan shadow-[0_0_8px_var(--color-cyan)]" style={{ width: `${overPct}%` }} />
        </div>
      </div>
    );
  }

  if (barrier === 9) {
    return (
      <div>
        <div className="mb-1 flex justify-between text-[10px] font-mono tabular-nums">
          <span className="text-magenta">UNDER 9 {underPct}%</span>
          <span className="text-amber-400 font-bold">BARRIER 9 (LOSE) {tiePct}%</span>
          <span className="text-muted-foreground">OVER 9 (N/A) 0%</span>
        </div>
        <div className="flex h-2 overflow-hidden rounded-full bg-secondary">
          <div className="bg-magenta shadow-[0_0_8px_var(--color-magenta)]" style={{ width: `${underPct}%` }} />
          <div className="bg-amber-400/80 shadow-[0_0_8px_rgba(251,191,36,0.6)]" style={{ width: `${tiePct}%` }} />
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-1 flex justify-between text-[10px] font-mono tabular-nums">
        <span className="text-magenta">UNDER {barrier} {underPct}%</span>
        <span className={deadZone ? "text-danger font-bold" : "text-amber-400 font-semibold"}>
          {deadZone ? `DEAD ZONE ${barrier}` : `BARRIER ${barrier}`} (LOSE) {tiePct}%
        </span>
        <span className="text-cyan">OVER {barrier} {overPct}%</span>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-secondary">
        <div className="bg-magenta shadow-[0_0_8px_var(--color-magenta)]" style={{ width: `${underPct}%` }} />
        <div
          className={deadZone ? "bg-danger shadow-[0_0_8px_var(--color-danger)]" : "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.5)]"}
          style={{ width: `${tiePct}%` }}
        />
        <div className="bg-cyan shadow-[0_0_8px_var(--color-cyan)]" style={{ width: `${overPct}%` }} />
      </div>
    </div>
  );
}

function SplitPanelImpl(p: Props) {
  const nav = p.nav;
  const evenOdd: ParityBlock | null = nav?.evenOdd ?? null;
  const overUnder: OverUnderBlock | null = nav?.overUnder ?? null;
  const direction: DirectionBlock | null = nav?.riseFall ?? null;

  const pEven = evenOdd ? evenOdd.pEven : p.fallback.pEven;
  const pOdd = evenOdd ? evenOdd.pOdd : (1 - p.fallback.pEven);
  
  const b = overUnder?.barrier ?? p.barrier;
  const pOver = overUnder ? overUnder.pOver : p.fallback.pHigh;
  const pUnder = overUnder ? overUnder.pUnder : (1 - p.fallback.pHigh);
  const pTie = overUnder ? overUnder.pTie : Math.max(0, 1 - pOver - pUnder);
  const deadZone = overUnder ? overUnder.deadZone : pTie >= 0.10;
  
  const pRise = direction ? direction.pRise : p.fallback.riseUp / Math.max(1, p.fallback.riseUp + p.fallback.riseDown);
  const pFall = direction ? direction.pFall : 1 - pRise;

  return (
    <div className="space-y-2 rounded-lg border border-border bg-card px-3 py-2">
      <div className="text-[10px] uppercase tracking-widest text-cyan">Split analysis · horizon D={nav?.selectedDuration ?? "—"}</div>
      <Pair leftLabel="EVEN" leftPct={pEven} rightLabel="ODD" rightPct={pOdd} />
      <OverUnder3Way barrier={b} pUnder={pUnder} pTie={pTie} pOver={pOver} deadZone={deadZone} />
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
