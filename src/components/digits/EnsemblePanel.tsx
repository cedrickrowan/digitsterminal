import { memo, useEffect, useRef, useState } from "react";
import type { Ensemble } from "@/lib/deriv/stats";
import type { Market } from "@/lib/deriv/types";
import { cadenceProfile } from "@/lib/deriv/cadence";
import { HUMAN_RESPONSE_MS } from "@/lib/deriv/entryTiming";
import { chimeClickNow, buzzAbort } from "@/lib/deriv/audio";

interface Props {
  ensemble: Ensemble;
  market: Market;
  barrier: number;
  pEven: number;
  pHigh: number;
  rise: { up: number; down: number };
  symbol: string;
  /** performance.now() of the last accepted tick. */
  getLastArrival: () => number;
  rttMs: number;
  /** Network/execution safety (ping + gap) from the terminal. */
  safe: boolean;
  /** Global hold (volatility spike / no consecutive variance / red network). */
  hold: string | null;
  lockedDigit: number | null;
  onLock: (d: number | null) => void;
  threshold: number; // 0.16..0.24
  onThreshold: (t: number) => void;
}

function directionFor(p: Props, target: number): { side: string; conf: number; tone: "cyan" | "magenta" } {
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
      return { side: `MATCH ${target}`, conf: p.ensemble.posterior[target] ?? 0, tone: "cyan" };
  }
}

/** Parity + barrier consensus for a digit target. */
export function digitConsensus(
  d: number,
  posterior: number[],
  pEven: number,
  barrier: number,
): { parity: boolean; barrierOk: boolean } {
  const pOver = 1 - posterior.slice(0, barrier + 1).reduce((a, b) => a + b, 0);
  const parity = (d % 2 === 0) === (pEven >= 0.5);
  const barrierOk = (d > barrier) === (pOver >= 0.5);
  return { parity, barrierOk };
}

function EnsemblePanelImpl(p: Props) {
  const target = p.lockedDigit ?? p.ensemble.topDigit;
  const dir = directionFor(p, target);
  const cad = cadenceProfile(p.symbol);
  const prob = p.ensemble.posterior[target] ?? 0;
  const cons = digitConsensus(target, p.ensemble.posterior, p.pEven, p.barrier);
  const qualifies = prob >= p.threshold && cons.parity && cons.barrierOk && !p.hold && p.safe;

  // Live per-frame millisecond countdown (independent of the 4fps app ticker).
  const [now, setNow] = useState(0);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      setNow(performance.now());
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    // rAF pauses in hidden tabs; a slow interval keeps state honest there.
    const iv = window.setInterval(() => setNow(performance.now()), 250);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(iv);
    };
  }, []);

  const last = p.getLastArrival();
  const elapsed = last && now ? Math.max(0, now - last) : 0;
  const nextTickMs = Math.max(0, Math.round(cad.tickMs - elapsed));
  const buyIfMs = Math.round(cad.safeWindowMs - (elapsed + p.rttMs / 2 + HUMAN_RESPONSE_MS));
  const inWindow = last > 0 && buyIfMs > 0 && nextTickMs > 0;
  const status: "SAFE" | "ABORT" = inWindow && p.safe && !p.hold ? "SAFE" : "ABORT";

  // Audio only for a manually locked target (auto mode uses the entry-stage cues).
  const prevRef = useRef<"SAFE" | "ABORT">("ABORT");
  const firedSafeRef = useRef(false);
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = status;
    if (p.lockedDigit === null) return;
    if (status === "SAFE" && prev !== "SAFE" && qualifies) {
      chimeClickNow();
      firedSafeRef.current = true;
    } else if (status === "ABORT" && prev === "SAFE" && firedSafeRef.current) {
      buzzAbort();
      firedSafeRef.current = false;
    }
  }, [status, qualifies, p.lockedDigit]);

  const tone = dir.tone === "cyan" ? "text-cyan" : "text-magenta";
  const pct = Math.min(100, dir.conf * 100);

  return (
    <div className="rounded-lg border border-cyan/40 bg-card px-3 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-widest text-cyan">Ensemble · Bayesian fusion</span>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wider ${
            status === "SAFE" ? "bg-cyan/15 text-cyan" : "bg-danger text-background"
          }`}
        >
          {status}
        </span>
      </div>

      {p.hold && (
        <div className="mb-2 rounded border border-warning px-2 py-1 text-center font-mono text-[11px] font-bold text-warning">
          {p.hold}
        </div>
      )}

      <div className="flex items-end gap-3">
        <div
          className={`flex h-20 w-24 shrink-0 items-center justify-center rounded-xl border ${
            dir.tone === "cyan" ? "border-cyan" : "border-magenta"
          } bg-background/60`}
        >
          <span className={`text-center font-mono text-xl font-bold leading-tight ${tone}`}>{dir.side}</span>
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>Confidence</span>
            <span className={`font-mono ${tone}`}>{(dir.conf * 100).toFixed(1)}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
            <div className={`h-full ${dir.tone === "cyan" ? "bg-cyan" : "bg-magenta"}`} style={{ width: `${pct}%` }} />
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>Next tick in</span>
            <span className="font-mono tabular-nums text-foreground">{nextTickMs}ms</span>
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>Buy now if ≤</span>
            <span className={`font-mono font-bold tabular-nums ${buyIfMs <= 0 ? "text-danger" : "text-cyan"}`}>
              {buyIfMs <= 0 ? "TOO LATE" : `${buyIfMs}ms`}
            </span>
          </div>
          {/* Window progress: fills as the safe window is consumed. */}
          <div className="relative h-1 overflow-hidden rounded-full bg-secondary">
            <div
              className={`h-full ${inWindow ? "bg-cyan" : "bg-danger"}`}
              style={{ width: `${Math.min(100, (elapsed / cad.tickMs) * 100)}%` }}
            />
            <div
              className="absolute inset-y-0 w-px bg-foreground"
              style={{ left: `${(cad.safeWindowMs / cad.tickMs) * 100}%` }}
            />
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between text-[10px] text-muted-foreground">
        <span>
          Target {p.lockedDigit === null ? "AUTO" : "LOCKED"} · {target} · {(prob * 100).toFixed(1)}%
          {" · "}
          <span className={cons.parity ? "text-cyan" : "text-danger"}>parity</span>
          {" · "}
          <span className={cons.barrierOk ? "text-cyan" : "text-danger"}>barrier</span>
          {" · "}
          <span className={qualifies ? "text-success" : "text-muted-foreground"}>
            {qualifies ? "QUALIFIED" : "not qualified"}
          </span>
        </span>
        <button
          type="button"
          onClick={() => p.onLock(null)}
          className={`rounded border px-2 py-0.5 font-mono ${
            p.lockedDigit === null ? "border-cyan text-cyan" : "border-input"
          }`}
        >
          AUTO
        </button>
      </div>

      <div className="mt-1 grid grid-cols-10 gap-0.5">
        {p.ensemble.posterior.map((q, i) => {
          const isT = i === target;
          const pass = q >= p.threshold;
          return (
            <button
              type="button"
              key={i}
              aria-label={`Lock digit ${i}`}
              onClick={() => p.onLock(p.lockedDigit === i ? null : i)}
              className={`flex flex-col items-center rounded-sm border py-1 text-[10px] ${
                isT ? (p.lockedDigit === i ? "border-success ring-1 ring-success" : "border-cyan") : "border-border"
              }`}
              style={{
                backgroundColor: `color-mix(in oklab, var(--color-cyan) ${Math.min(70, q * 220)}%, transparent)`,
              }}
            >
              <span className="font-mono font-semibold leading-none">{i}</span>
              <span className={`font-mono tabular-nums ${pass ? "text-success" : ""}`}>{(q * 100).toFixed(0)}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
        <span>Threshold</span>
        <input
          type="range"
          aria-label="Target threshold"
          min={0.16}
          max={0.24}
          step={0.01}
          value={p.threshold}
          onChange={(e) => p.onThreshold(Number(e.target.value))}
          className="h-2 flex-1 accent-cyan"
        />
        <span className="w-8 font-mono text-cyan">{Math.round(p.threshold * 100)}%</span>
      </div>
    </div>
  );
}

export const EnsemblePanel = memo(EnsemblePanelImpl);
