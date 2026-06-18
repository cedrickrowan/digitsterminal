import { memo } from "react";
import type { Ensemble } from "@/lib/deriv/stats";
import type { Market } from "@/lib/deriv/types";

interface Props {
  ensemble: Ensemble;
  market: Market;
  barrier: number;
  pEven: number;
  pHigh: number;
  rise: { up: number; down: number };
  safe: boolean;
  countdownMs: number;
  purchaseInMs: number; // suggested buy lead = countdownMs - latencyOffset
}

function Bar({ label, value, side }: { label: string; value: number; side: "left" | "right" }) {
  const pct = Math.round(value * 100);
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className={`w-10 font-mono tabular-nums ${side === "left" ? "text-cyan" : "text-magenta"}`}>{pct}%</span>
      <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
        <div
          className={`absolute inset-y-0 ${side === "left" ? "left-0 bg-cyan shadow-[0_0_8px_var(--color-cyan)]" : "right-0 bg-magenta shadow-[0_0_8px_var(--color-magenta)]"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-12 text-right text-muted-foreground">{label}</span>
    </div>
  );
}

function directionFor(p: Props): { side: string; conf: number; tone: "cyan" | "magenta" } {
  switch (p.market) {
    case "overunder": {
      const pOver = 1 - p.ensemble.posterior.slice(0, p.barrier + 1).reduce((a, b) => a + b, 0);
      return pOver >= 0.5
        ? { side: `OVER ${p.barrier}`, conf: pOver, tone: "cyan" }
        : { side: `UNDER ${p.barrier}`, conf: 1 - pOver, tone: "magenta" };
    }
    case "evenodd":
      return p.pEven >= 0.5
        ? { side: "EVEN", conf: p.pEven, tone: "cyan" }
        : { side: "ODD", conf: 1 - p.pEven, tone: "magenta" };
    case "risefall":
      return p.rise.up >= p.rise.down
        ? { side: "RISE", conf: p.rise.up / Math.max(1, p.rise.up + p.rise.down), tone: "cyan" }
        : { side: "FALL", conf: p.rise.down / Math.max(1, p.rise.up + p.rise.down), tone: "magenta" };
    default:
      return {
        side: `MATCH ${p.ensemble.topDigit}`,
        conf: p.ensemble.confidence,
        tone: "cyan",
      };
  }
}

function EnsemblePanelImpl(p: Props) {
  const dir = directionFor(p);
  return (
    <div className="relative overflow-hidden rounded-lg border border-cyan/40 bg-gradient-to-b from-card to-background px-3 py-3 shadow-[0_0_24px_-8px_var(--color-cyan)]">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-widest text-cyan">Ensemble · Bayesian fusion</span>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
            p.safe
              ? "bg-cyan/15 text-cyan shadow-[0_0_8px_var(--color-cyan)]"
              : "bg-danger/20 text-danger"
          }`}
        >
          {p.safe ? "SAFE" : "ABORT"}
        </span>
      </div>

      <div className="flex items-end gap-3">
        <div
          className={`relative flex h-20 w-20 shrink-0 items-center justify-center rounded-xl border ${
            dir.tone === "cyan" ? "border-cyan" : "border-magenta"
          } bg-background/60`}
          style={{
            boxShadow:
              dir.tone === "cyan"
                ? "0 0 24px -2px var(--color-cyan), inset 0 0 18px -6px var(--color-cyan)"
                : "0 0 24px -2px var(--color-magenta), inset 0 0 18px -6px var(--color-magenta)",
          }}
        >
          <span className="absolute inset-0 animate-ping rounded-xl border border-current opacity-30" />
          <span className={`font-mono text-2xl font-bold ${dir.tone === "cyan" ? "text-cyan" : "text-magenta"}`}>
            {dir.side}
          </span>
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>Confidence</span>
            <span className={`font-mono ${dir.tone === "cyan" ? "text-cyan" : "text-magenta"}`}>
              {(dir.conf * 100).toFixed(1)}%
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
            <div
              className={`h-full ${dir.tone === "cyan" ? "bg-cyan" : "bg-magenta"}`}
              style={{
                width: `${dir.conf * 100}%`,
                boxShadow:
                  dir.tone === "cyan"
                    ? "0 0 10px var(--color-cyan)"
                    : "0 0 10px var(--color-magenta)",
              }}
            />
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>Next tick in</span>
            <span className="font-mono tabular-nums text-foreground">{Math.max(0, p.countdownMs)}ms</span>
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>Buy now if ≤</span>
            <span
              className={`font-mono tabular-nums ${
                p.purchaseInMs <= 0 ? "text-warning" : "text-cyan"
              }`}
            >
              {p.purchaseInMs <= 0 ? "TOO LATE" : `${p.purchaseInMs}ms`}
            </span>
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-10 gap-0.5">
        {p.ensemble.posterior.map((q, i) => (
          <div
            key={i}
            className={`flex flex-col items-center rounded-sm border py-1 text-[10px] ${
              i === p.ensemble.topDigit ? "border-cyan" : "border-border"
            }`}
            style={{
              backgroundColor: `color-mix(in oklab, var(--color-cyan) ${Math.min(70, q * 220)}%, transparent)`,
            }}
          >
            <span className="font-mono font-semibold leading-none">{i}</span>
            <span className="font-mono tabular-nums">{Math.round(q * 100)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export const EnsemblePanel = memo(EnsemblePanelImpl);
