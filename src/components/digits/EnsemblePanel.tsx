import { memo } from "react";
import type { EngineResult } from "@/lib/deriv/navigator";
import type { Ensemble } from "@/lib/deriv/stats";
import type { Market } from "@/lib/deriv/types";

interface Props {
  /** Navigator output — the single mathematical engine state every panel reads. */
  nav: EngineResult | null;
  /** Legacy Bayesian ensemble, only used while the navigator buffer is seeding. */
  ensemble: Ensemble;
  market: Market;
  barrier: number;
  /** Matches always follows the user's configured target, including while seeding. */
  predictDigit: number;
  pEven: number;
  pHigh: number;
  rise: { up: number; down: number };
  safe: boolean;
  /** ms elapsed since the last navigator READY alert (0 when none pending). */
  alertElapsedMs: number;
  nextTickInMs: number;
  purchaseInMs: number;
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

/** Unified decision view — matches the navigator's horizon math for the
 *  selected market and duration D. Falls back to the legacy Bayesian fusion
 *  only while the navigator buffer is still seeding. */
function decisionFor(p: Props): { side: string; conf: number; tone: "cyan" | "magenta"; source: "navigator" | "legacy" } {
  const nav = p.nav;
  if (nav) {
    if (p.market === "differs") {
      const target = p.predictDigit;
      const landing = nav.digits[target]?.landingProb ?? 0.1;
      return { side: `DIFFERS ${target}`, conf: 1 - landing, tone: "magenta", source: "navigator" };
    }
        if (p.market === "overunder" && nav.overUnder) {
      const b = nav.overUnder;
      if (b.barrier === 9) {
        return {
          side: b.rec === "HOLD" ? "HOLD" : `UNDER 9`,
          conf: b.pUnder,
          tone: "magenta",
          source: "navigator",
        };
      }
      if (b.barrier === 0) {
        return {
          side: b.rec === "HOLD" ? "HOLD" : `OVER 0`,
          conf: b.pOver,
          tone: "cyan",
          source: "navigator",
        };
      }
      if (b.deadZone) {
        return {
          side: `DEAD ZONE (${b.barrier})`,
          conf: b.pTie,
          tone: "magenta",
          source: "navigator",
        };
      }
      if (b.rec === "HOLD") {
        const leadUnder = b.pUnder >= b.pOver;
        return {
          side: "HOLD",
          conf: leadUnder ? b.pUnder : b.pOver,
          tone: leadUnder ? "magenta" : "cyan",
          source: "navigator",
        };
      }
      return b.rec === "UNDER"
        ? { side: `UNDER ${b.barrier}`, conf: b.pUnder, tone: "magenta", source: "navigator" }
        : { side: `OVER ${b.barrier}`, conf: b.pOver, tone: "cyan", source: "navigator" };
    }

    if (p.market === "evenodd" && nav.evenOdd) {
      const b = nav.evenOdd;
      return b.rec === "ODD"
        ? { side: "ODD", conf: b.pOdd, tone: "magenta", source: "navigator" }
        : { side: "EVEN", conf: b.pEven, tone: "cyan", source: "navigator" };
    }
    if (p.market === "risefall" && nav.riseFall) {
      const b = nav.riseFall;
      return b.rec === "FALL"
        ? { side: "FALL", conf: b.pFall, tone: "magenta", source: "navigator" }
        : { side: "RISE", conf: b.pRise, tone: "cyan", source: "navigator" };
    }
    return { side: `MATCH ${nav.topTargetDigit}`, conf: nav.topTargetProb, tone: "cyan", source: "navigator" };
  }
  // Legacy fallback (navigator still seeding).
  switch (p.market) {
    case "differs": {
      const target = p.predictDigit;
      const prob = p.ensemble.posterior[target] ?? 0.1;
      return {
        side: `DIFFERS ${target}`,
        conf: 1 - prob,
        tone: "magenta",
        source: "legacy",
      };
    }
    case "overunder": {
      const pOver = 1 - p.ensemble.posterior.slice(0, p.barrier + 1).reduce((a, b) => a + b, 0);
      return pOver >= 0.5
        ? { side: `OVER ${p.barrier}`, conf: pOver, tone: "cyan", source: "legacy" }
        : { side: `UNDER ${p.barrier}`, conf: 1 - pOver, tone: "magenta", source: "legacy" };
    }
    case "evenodd":
      return p.pEven >= 0.5
        ? { side: "EVEN", conf: p.pEven, tone: "cyan", source: "legacy" }
        : { side: "ODD", conf: 1 - p.pEven, tone: "magenta", source: "legacy" };
    case "risefall": {
      const total = Math.max(1, p.rise.up + p.rise.down);
      return p.rise.up >= p.rise.down
        ? { side: "RISE", conf: p.rise.up / total, tone: "cyan", source: "legacy" }
        : { side: "FALL", conf: p.rise.down / total, tone: "magenta", source: "legacy" };
    }
    default: {
      const target = p.predictDigit;
      return {
        side: `MATCH ${target}`,
        conf: p.ensemble.posterior[target] ?? 0,
        tone: "cyan",
        source: "legacy",
      };
    }
  }
}


function EnsemblePanelImpl(p: Props) {
  const dir = decisionFor(p);
  // Horizon probability grid: navigator landing probabilities when live.
  const posterior: number[] = p.nav ? p.nav.digits.map((d) => d.landingProb) : p.ensemble.posterior;
  const highlightDigit = p.nav
    ? p.nav.topTargetDigit
    : p.market === "matches" ? p.ensemble.topDigit : p.ensemble.topDigit;

  // Strict 700 ms navigator window — synchronized with the audio alert.
  const cutoff = p.nav?.executionCutoffMs ?? 700;
  const ready = p.nav?.alertDecision === "READY / MANUAL ALERT";
  const inWindow = ready && p.alertElapsedMs >= 0 && p.alertElapsedMs < cutoff;
  const remaining = Math.max(0, cutoff - p.alertElapsedMs);

  return (
    <div className="relative overflow-hidden rounded-lg border border-cyan/40 bg-gradient-to-b from-card to-background px-3 py-3 shadow-[0_0_24px_-8px_var(--color-cyan)]">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-widest text-cyan">
          ENSEMBLE - BAYESIAN FUSION · D={p.nav?.selectedDuration ?? "—"}
        </span>
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
          <span className={`font-mono text-center text-lg font-bold leading-tight ${dir.tone === "cyan" ? "text-cyan" : "text-magenta"}`}>
            {dir.side}
          </span>
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>{p.market === "matches" ? "Landing confidence" : "Confidence"}</span>
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
            <span className="font-mono tabular-nums">{Math.max(0, p.nextTickInMs)}ms</span>
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>Buy now if ≤</span>
            <span className={`font-mono tabular-nums ${p.purchaseInMs <= 0 ? "text-danger font-bold" : "text-cyan"}`}>
              {p.purchaseInMs <= 0 ? "TOO LATE" : `${p.purchaseInMs}ms`}
            </span>
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>{ready ? "700ms entry window" : "Alert state"}</span>
            <span
              className={`font-mono tabular-nums ${
                inWindow ? "text-success font-bold" : ready ? "text-danger" : "text-muted-foreground"
              }`}
            >
              {inWindow ? `SAFE / BUY NOW · ${remaining}ms` : ready ? "TOO LATE / ABORT" : "HOLD"}
            </span>
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>Engine</span>
            <span className="font-mono">{dir.source === "navigator" ? "navigator exact DP" : "legacy fusion (seeding)"}</span>
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-10 gap-0.5 border-t border-border pt-2">
        {posterior.map((q, i) => (
          <div
            key={i}
            className={`flex flex-col items-center rounded-sm border py-1 text-[10px] ${
              i === highlightDigit ? "border-cyan" : "border-border"
            }`}
            style={{
              backgroundColor: `color-mix(in oklab, var(--color-cyan) ${Math.min(70, q * 220)}%, transparent)`,
            }}
          >
            <span className="font-mono font-semibold leading-none">{i}</span>
            <span className="font-mono tabular-nums">{(q * 100).toFixed(1)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export const EnsemblePanel = memo(EnsemblePanelImpl);
