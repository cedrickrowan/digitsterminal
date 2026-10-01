import type { EntryTiming } from "@/lib/deriv/entryTiming";

const LABEL: Record<EntryTiming["stage"], string> = {
  IDLE: "STANDBY",
  PREPARE: "PREPARE",
  CLICK_NOW: "CLICK NOW",
  ABORT: "LATE / ABORT",
};

const STYLE: Record<EntryTiming["stage"], string> = {
  IDLE: "border-input text-muted-foreground",
  PREPARE: "border-warning text-warning",
  CLICK_NOW: "border-success bg-success/20 text-success",
  ABORT: "border-danger bg-danger/15 text-danger",
};

export function EntryStageBar({ t, rttMs }: { t: EntryTiming; rttMs: number }) {
  const pct = Math.max(0, Math.min(100, (t.effectiveMs / t.budgetMs) * 100));
  const safePct = (t.safeMs / t.budgetMs) * 100;
  return (
    <div className={`rounded border px-3 py-2 font-mono ${STYLE[t.stage]}`}>
      <div className="flex items-center justify-between">
        <span className="text-lg font-bold tracking-widest">{LABEL[t.stage]}</span>
        <span className="text-[10px]">{t.reason}</span>
      </div>
      <div className="relative mt-1 h-1.5 w-full rounded bg-muted">
        <div className="absolute inset-y-0 left-0 rounded bg-current" style={{ width: `${pct}%` }} />
        <div className="absolute inset-y-0 w-px bg-foreground" style={{ left: `${safePct}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>RTT {Math.round(rttMs)}ms · jitter {Math.round(t.jitterMs)}ms</span>
        <span>
          safe {"<"} {t.safeMs}ms / budget {t.budgetMs}ms · +250ms human
        </span>
      </div>
    </div>
  );
}
