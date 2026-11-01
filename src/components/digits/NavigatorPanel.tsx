import { memo } from "react";
import type { EngineResult } from "@/lib/deriv/navigator";

interface Props {
  result: EngineResult | null;
  /** ms elapsed since the last READY alert fired (0 when none pending). */
  alertElapsedMs: number;
  waiting: boolean; // engine seeded but buffer not yet full (100 ticks)
}

function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

function Pool({ label, digits, tone }: { label: string; digits: number[]; tone: "fresh" | "tired" }) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="mt-0.5 flex flex-wrap gap-1">
        {digits.length === 0 ? (
          <span className="font-mono text-[10px] text-muted-foreground">—</span>
        ) : (
          digits.map((d) => (
            <span
              key={d}
              className={`inline-flex h-5 w-5 items-center justify-center rounded border font-mono text-[11px] font-bold tabular-nums ${
                tone === "fresh" ? "border-success text-success" : "border-danger/60 text-danger"
              }`}
            >
              {d}
            </span>
          ))
        )}
      </div>
    </div>
  );
}

function Diag({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex items-center justify-between gap-2" title={title}>
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <span className="font-mono text-[10px] tabular-nums">{value}</span>
    </div>
  );
}

function NavigatorPanelImpl({ result, alertElapsedMs, waiting }: Props) {
  const ready = result?.alertDecision === "READY / MANUAL ALERT";
  const inWindow = ready && alertElapsedMs <= (result?.executionCutoffMs ?? 700);
  const remaining = Math.max(0, (result?.executionCutoffMs ?? 700) - alertElapsedMs);

  const decisionTone = inWindow
    ? "border-success text-success bg-success/10"
    : result?.alertDecision === "HOLD / UNSAFE LATENCY"
      ? "border-warning text-warning"
      : "border-border text-muted-foreground";

  return (
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-semibold tracking-wide">DIGITS NAVIGATOR · exact engine</span>
        <span className="font-mono text-[10px] text-muted-foreground">
          D={result ? result.selectedDuration : "—"} · buffer 100
        </span>
      </div>

      {waiting ? (
        <div className="py-3 text-center font-mono text-[11px] text-muted-foreground">
          seeding 100-tick buffer…
        </div>
      ) : !result ? (
        <div className="py-3 text-center font-mono text-[11px] text-muted-foreground">
          no fresh candidate pool — HOLD
        </div>
      ) : (
        <>
          {/* Alert decision + 700 ms human-response window (numeric countdown only) */}
          <div className={`mb-2 rounded border px-2 py-1.5 ${decisionTone}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[11px] font-bold">{result.alertDecision}</span>
              {ready && (
                <span className="font-mono text-sm font-extrabold tabular-nums">
                  {inWindow ? `${remaining}ms` : "TOO LATE / ABORT"}
                </span>
              )}
            </div>
            {ready && (
              <div className="font-mono text-[9px] text-muted-foreground">
                {inWindow ? `SAFE / BUY NOW · ${result.executionCutoffMs}ms window` : "window expired"}
              </div>
            )}
          </div>

          <div className="mb-2 flex items-center gap-3">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border-2 border-primary bg-primary/10 font-mono text-2xl font-extrabold tabular-nums text-primary">
              {result.topTargetDigit}
            </div>
            <div className="grid flex-1 grid-cols-2 gap-x-3 font-mono text-[10px] tabular-nums">
              <span className="text-muted-foreground">multi-hit ≥2</span>
              <span className="text-right font-bold">{pct(result.multiHitProb)}</span>
              <span className="text-muted-foreground">landing t+{result.selectedDuration}</span>
              <span className="text-right">{pct(result.topTargetProb)}</span>
              <span className="text-muted-foreground">consecutive D</span>
              <span className="text-right">{pct(result.consecProb)}</span>
              <span className="text-muted-foreground">adj pair</span>
              <span className="text-right">{pct(result.pairProb)}</span>
              <span className="text-muted-foreground">adj triple</span>
              <span className="text-right">{pct(result.tripleProb)}</span>
              <span className="text-muted-foreground">≥3 hits</span>
              <span className="text-right">{pct(result.threeHitProb)}</span>
            </div>
          </div>

          <div className="mb-2 grid grid-cols-2 gap-2">
            <Pool label="Fresh pool" digits={result.freshPool} tone="fresh" />
            <Pool label="Tired pool (blocked)" digits={result.tiredPool} tone="tired" />
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
            <Diag label="Runs Z (parity)" value={result.runsZScore.toFixed(2)} title="Wald–Wolfowitz runs test on even/odd" />
            <Diag label="Regime" value={result.regime.replace("_", " ").toLowerCase()} />
            <Diag label="KL (20-tick)" value={result.klDivergence.toFixed(3)} title="KL divergence vs uniform, last 20 ticks" />
            <Diag label="KL EMA θ" value={result.adaptiveKlThreshold.toFixed(3)} title="Adaptive KL threshold (EMA decay)" />
            <Diag label="KS drift" value={result.ksDrift.toFixed(3)} title="Kolmogorov–Smirnov drift vs discrete uniform" />
            <Diag label="LZW ratio" value={result.lzwRatio.toFixed(3)} title="Lempel-Ziv-Welch compression ratio (lower = repeating blocks)" />
            <Diag label="CUSUM" value={result.cusum.toFixed(1) + (result.cusumShift ? " ⚠shift" : "")} title="Page-Hinkley regime-shift accumulator" />
            <Diag
              label="AMI lags 1–7"
              value={result.amiLags.map((v) => v.toFixed(2)).join(" ")}
              title="Algorithmic mutual information across lags 1..7 (Miller-Madow corrected)"
            />
            <Diag label="Kelly f* (advisory)" value={pct(result.kellyFraction)} title="Advisory Kelly fraction — never executes" />
            <Diag label="Ruin P (advisory)" value={pct(result.ruinProb)} title="Gambler's-ruin drought probability — advisory" />
            <Diag
              label="RTT / gate"
              value={`${Math.round(result.rttMs)} / <${result.pingThresholdMs}ms`}
              title={result.latencyGatePassed ? "Latency gate passed" : "Latency gate FAILED — hold"}
            />
            <Diag label="Engine time" value={`${result.analyzeMs.toFixed(1)}ms`} title="Full engine calculation time" />
          </div>
        </>
      )}
    </div>
  );
}

export const NavigatorPanel = memo(NavigatorPanelImpl);
