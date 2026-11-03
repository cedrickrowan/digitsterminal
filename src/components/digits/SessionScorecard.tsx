import { memo } from "react";
import type { Signal } from "@/lib/deriv/types";

interface Props {
  signals: Signal[];
}

/** Session scorecard: realized simulated outcomes vs the engine's expected
 *  probability for the same entries. A positive edge means the engine is
 *  beating its own expectation over the session. */
function SessionScorecardImpl({ signals }: Props) {
  const resolved = signals.filter((s) => s.result === "win" || s.result === "loss");
  const wins = resolved.reduce((a, s) => a + (s.result === "win" ? 1 : 0), 0);
  const losses = resolved.length - wins;
  const realized = resolved.length ? wins / resolved.length : 0;
  const expected = resolved.length
    ? resolved.reduce((a, s) => a + (s.expected ?? 0), 0) / resolved.length
    : 0;
  const edge = realized - expected;

  const Row = ({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) => (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <span
        className={`font-mono text-[10px] tabular-nums ${
          tone === "good" ? "text-success" : tone === "bad" ? "text-danger" : ""
        }`}
      >
        {value}
      </span>
    </div>
  );

  return (
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-widest text-cyan">Session scorecard</span>
        <span className="font-mono text-[10px] text-muted-foreground">{resolved.length} settled</span>
      </div>
      {resolved.length === 0 ? (
        <div className="py-2 text-center font-mono text-[10px] text-muted-foreground">
          no settled simulated entries yet
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
          <Row label="Wins" value={`${wins}`} tone="good" />
          <Row label="Losses" value={`${losses}`} tone="bad" />
          <Row label="Realized hit rate" value={`${(realized * 100).toFixed(1)}%`} />
          <Row label="Expected (avg)" value={`${(expected * 100).toFixed(1)}%`} />
          <Row
            label="Edge vs expected"
            value={`${edge >= 0 ? "+" : ""}${(edge * 100).toFixed(1)}%`}
            tone={edge >= 0 ? "good" : "bad"}
          />
          <Row label="Open entries" value={`${signals.filter((s) => s.result === undefined && s.entryPrice !== undefined).length}`} />
        </div>
      )}
    </div>
  );
}

export const SessionScorecard = memo(SessionScorecardImpl);
