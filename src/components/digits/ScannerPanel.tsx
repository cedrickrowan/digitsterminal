import { memo } from "react";
import { SYMBOLS } from "@/lib/deriv/types";
import type { Market } from "@/lib/deriv/types";

export interface ScanRow {
  symbol: string;
  pending: boolean;
  ok: boolean;
  error?: string;
  /** Ranking score of the engine recommendation for the scanned market. */
  score: number;
  /** Probability edge vs the random baseline. */
  edge: number;
  /** Horizon probability of the recommended side. */
  recProb: number;
  /** "DIGIT 7" | "OVER 4" | "EVEN" | "RISE" | "" */
  action: string;
  /** Round-trip time of the history fetch (ms). */
  rttMs: number;
  /** Fetch RTT inside the alert ping gate for this symbol type. */
  latencyOk: boolean;
}

interface Props {
  rows: ScanRow[];
  scanning: boolean;
  market: Market;
  onScan: () => void;
}

const MARKET_LABEL: Record<Market, string> = {
  matches: "Matches",
  differs: "Differs",
  overunder: "Over/Under",
  evenodd: "Even/Odd",
  risefall: "Rise/Fall",
};

function labelFor(symbol: string): string {
  return SYMBOLS.find((s) => s.value === symbol)?.label ?? symbol;
}

function ScannerPanelImpl({ rows, scanning, market, onScan }: Props) {
  const done = rows.filter((r) => !r.pending).length;
  const ranked = rows
    .slice()
    .sort((a, b) => {
      if (a.pending !== b.pending) return a.pending ? 1 : -1;
      return b.score - a.score;
    });
  const best = ranked.find((r) => !r.pending && r.ok && r.score > 0);

  return (
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold tracking-wide">MULTI-MARKET SCANNER</div>
          <div className="text-[9px] uppercase tracking-widest text-muted-foreground">
            {MARKET_LABEL[market]} · lookback snapshot · manual alerts only
          </div>
        </div>
        <button
          type="button"
          onClick={onScan}
          disabled={scanning}
          className={`shrink-0 rounded border px-3 py-1.5 text-[11px] font-semibold ${
            scanning
              ? "border-input bg-background text-muted-foreground"
              : "border-cyan bg-cyan/15 text-cyan shadow-[0_0_10px_-2px_var(--color-cyan)]"
          }`}
        >
          {scanning ? `Scanning ${done}/${rows.length}…` : "Scan Markets"}
        </button>
      </div>

      <div className="max-h-56 overflow-auto rounded bg-background/60">
        {rows.length === 0 ? (
          <div className="px-2 py-3 text-center font-mono text-[10px] text-muted-foreground">
            Tap Scan Markets to rank every volatility for {MARKET_LABEL[market].toLowerCase()}.
          </div>
        ) : (
          ranked.map((r) => {
            const isBest = best && r.symbol === best.symbol;
            return (
              <div
                key={r.symbol}
                className={`flex items-center justify-between gap-2 border-b border-border/50 px-2 py-1 last:border-b-0 ${
                  isBest ? "bg-cyan/10" : ""
                }`}
              >
                <div className="min-w-0">
                  <div className={`truncate text-[10px] ${isBest ? "font-bold text-cyan" : ""}`}>
                    {labelFor(r.symbol)}
                    {isBest && <span className="ml-1 text-[9px] uppercase tracking-widest">· best setup</span>}
                  </div>
                  <div className="font-mono text-[9px] text-muted-foreground">
                    {r.pending
                      ? "fetching…"
                      : !r.ok
                        ? (r.error ?? "failed")
                        : r.action
                          ? `${r.action} · rec ${r.edge >= 0 ? "+" : ""}${(r.edge * 100).toFixed(1)}%`
                          : "no signal — hold"}
                  </div>
                </div>
                <div className="shrink-0 text-right font-mono text-[10px] tabular-nums">
                  {r.pending ? (
                    <span className="text-muted-foreground">—</span>
                  ) : r.ok ? (
                    <>
                      <div className={r.score > 0 ? "font-bold text-success" : "text-muted-foreground"}>
                        {(r.score * 100).toFixed(1)}%
                      </div>
                      <div className={r.latencyOk ? "text-success" : "text-danger"}>
                        {Math.round(r.rttMs)}ms {r.latencyOk ? "✓" : "✗"}
                      </div>
                    </>
                  ) : (
                    <span className="text-danger">✗</span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export const ScannerPanel = memo(ScannerPanelImpl);
