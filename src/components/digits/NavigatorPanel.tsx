import { memo } from "react";
import type { EngineResult, OverUnderBlock, ParityBlock, DirectionBlock } from "@/lib/deriv/navigator";
import type { Market } from "@/lib/deriv/types";

interface Props {
  result: EngineResult | null;
  /** ms elapsed since the last READY alert fired (0 when none pending). */
  alertElapsedMs: number;
  /** navigator buffer still seeding */
  waiting: boolean;
  /** seeding progress (filled / size ticks) */
  filled: number;
  size: number;
  market: Market;
  barrier: number;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

function pct1(x: number): string {
  const v = x * 100;
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
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

function Diag({ label, value, title, tone }: { label: string; value: string; title?: string; tone?: "good" | "bad" }) {
  return (
    <div className="flex items-center justify-between gap-2" title={title}>
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
}

function Row({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
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
}

/** Over/Under horizon block: recommendation, probabilities, barrier risk
 *  (dead zone) and momentum velocity. */
function OverUnderView({ b, duration }: { b: OverUnderBlock; duration: number }) {
  const tone = b.deadZone ? "border-danger text-danger" : b.rec === "HOLD" ? "border-border text-muted-foreground" : "border-success text-success";
  return (
    <div className={`mb-2 rounded border px-2 py-1.5 ${tone}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-sm font-extrabold tracking-wide">
          {b.deadZone ? "DEAD ZONE · HOLD" : b.rec === "HOLD" ? "HOLD" : `${b.rec} ${b.barrier}`}
        </span>
        <span className="font-mono text-[10px] tabular-nums">t+{duration}</span>
      </div>
      {b.deadZone && (
        <div className="font-mono text-[9px]">
          barrier tie P {pct(b.pTie)} ≥ 10% · signal blocked
        </div>
      )}
      <div className="mt-1 grid grid-cols-2 gap-x-3 font-mono text-[10px] tabular-nums">
        <span className="text-muted-foreground">P(Over {b.barrier})</span>
        <span className="text-right">{pct(b.pOver)}</span>
        <span className="text-muted-foreground">P(Under {b.barrier})</span>
        <span className="text-right">{pct(b.pUnder)}</span>
        <span className="text-muted-foreground">P(= {b.barrier}) risk</span>
        <span className={`text-right ${b.deadZone ? "text-danger font-bold" : ""}`}>{pct(b.pTie)}</span>
        <span className="text-muted-foreground">Velocity ΔP over</span>
        <span className={`text-right ${b.momentumOver > 0 ? "text-success" : b.momentumOver < 0 ? "text-danger" : ""}`}>
          {pct1(b.momentumOver)}
        </span>
        <span className="text-muted-foreground">Velocity ΔP under</span>
        <span className={`text-right ${b.momentumUnder > 0 ? "text-success" : b.momentumUnder < 0 ? "text-danger" : ""}`}>
          {pct1(b.momentumUnder)}
        </span>
        <span className="text-muted-foreground">Baseline over</span>
        <span className="text-right">{pct(b.baselineOver)}</span>
      </div>
    </div>
  );
}

/** Even/Odd horizon block: parity probabilities via M^D, runs-test
 *  corroboration and micro momentum. */
function ParityView({ b, runsZ, duration }: { b: ParityBlock; runsZ: number; duration: number }) {
  const corroborates = Math.abs(runsZ) < 1.96 || (b.rec === "EVEN" ? runsZ > 0 : runsZ < 0);
  const tone = b.rec === "HOLD" ? "border-border text-muted-foreground" : "border-success text-success";
  return (
    <div className={`mb-2 rounded border px-2 py-1.5 ${tone}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-sm font-extrabold tracking-wide">{b.rec === "HOLD" ? "HOLD" : b.rec}</span>
        <span className="font-mono text-[10px] tabular-nums">t+{duration}</span>
      </div>
      <div className="mt-1 grid grid-cols-2 gap-x-3 font-mono text-[10px] tabular-nums">
        <span className="text-muted-foreground">P(Even) M^D</span>
        <span className="text-right">{pct(b.pEven)}</span>
        <span className="text-muted-foreground">P(Odd) M^D</span>
        <span className="text-right">{pct(b.pOdd)}</span>
        <span className="text-muted-foreground">Velocity ΔP</span>
        <span className={`text-right ${b.velocity > 0 ? "text-success" : b.velocity < 0 ? "text-danger" : ""}`}>
          {pct1(b.velocity)}
        </span>
        <span className="text-muted-foreground">Baseline even</span>
        <span className="text-right">{pct(b.baselineEven)}</span>
        <span className="text-muted-foreground">Runs Z (WW)</span>
        <span className={`text-right ${corroborates ? "text-success" : "text-warning"}`} title="Wald–Wolfowitz parity runs test corroboration">
          {runsZ.toFixed(2)} {corroborates ? "✓" : "✗"}
        </span>
      </div>
    </div>
  );
}

/** Rise/Fall direction block: ΔS price-increment momentum + run length,
 *  cleanly separated from digit modulo arithmetic. */
function DirectionView({ b, duration }: { b: DirectionBlock; duration: number }) {
  const tone = b.rec === "HOLD" ? "border-border text-muted-foreground" : "border-success text-success";
  return (
    <div className={`mb-2 rounded border px-2 py-1.5 ${tone}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-sm font-extrabold tracking-wide">{b.rec === "HOLD" ? "HOLD" : b.rec}</span>
        <span className="font-mono text-[10px] tabular-nums">t+{duration}</span>
      </div>
      <div className="mt-1 grid grid-cols-2 gap-x-3 font-mono text-[10px] tabular-nums">
        <span className="text-muted-foreground">P(Rise)</span>
        <span className="text-right">{pct(b.pRise)}</span>
        <span className="text-muted-foreground">P(Fall)</span>
        <span className="text-right">{pct(b.pFall)}</span>
        <span className="text-muted-foreground">Velocity ΔP</span>
        <span className={`text-right ${b.velocity > 0 ? "text-success" : b.velocity < 0 ? "text-danger" : ""}`}>
          {pct1(b.velocity)}
        </span>
        <span className="text-muted-foreground">Baseline up</span>
        <span className="text-right">{pct(b.baselineUp)}</span>
        <span className="text-muted-foreground">Direction run</span>
        <span className="text-right">
          {b.runDir === "FLAT" ? "—" : `${b.runDir} ×${b.runLength}`}
        </span>
      </div>
    </div>
  );
}

function NavigatorPanelImpl({ result, alertElapsedMs, waiting, filled, size, market, barrier }: Props) {
  const ready = result?.alertDecision === "READY / MANUAL ALERT";
  const inWindow = ready && alertElapsedMs >= 0 && alertElapsedMs < (result?.executionCutoffMs ?? 700);
  const remaining = Math.ceil(Math.max(0, (result?.executionCutoffMs ?? 700) - alertElapsedMs));

  const decisionTone = inWindow
    ? "border-success text-success bg-success/10"
    : result?.alertDecision === "HOLD / UNSAFE LATENCY" || result?.alertDecision === "HOLD / DEAD ZONE"
      ? "border-warning text-warning"
      : "border-border text-muted-foreground";

  const bufLabel = result ? `${result.selectedDuration} · buffer ${size}` : `buffer ${size}`;

  return (
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-semibold tracking-wide">DIGITS NAVIGATOR · exact engine</span>
        <span className="font-mono text-[10px] text-muted-foreground">
          D={bufLabel}
        </span>
      </div>

      {waiting ? (
        <div className="py-3 text-center font-mono text-[11px] text-muted-foreground">
          seeding {size}-tick buffer… {filled}/{size}
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
              <div className="font-mono text-[9px]">
                <div className="text-muted-foreground">
                  {inWindow ? `SAFE / BUY NOW · ${result.executionCutoffMs}ms window` : "window expired"}
                </div>
              </div>
            )}
          </div>

          {market === "matches" && (
            <>
              <div className="mb-2 flex items-center gap-3">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border-2 border-primary bg-primary/10 font-mono text-2xl font-extrabold tabular-nums text-primary">
                  {result.navTargetDigit}
                </div>
                <div className="grid flex-1 grid-cols-2 gap-x-3 font-mono text-[10px] tabular-nums">
                  <span className="text-muted-foreground">multi-hit ≥2</span>
                  <span className="text-right font-bold">{pct(result.digits[result.navTargetDigit]?.multiHitProb ?? 0)}</span>
                  <span className="text-muted-foreground">landing t+{result.selectedDuration}</span>
                  <span className="text-right">{pct(result.digits[result.navTargetDigit]?.landingProb ?? 0)}</span>
                  <span className="text-muted-foreground">consecutive D</span>
                  <span className="text-right">{pct(result.digits[result.navTargetDigit]?.consecProb ?? 0)}</span>
                  <span className="text-muted-foreground">adj pair</span>
                  <span className="text-right">{pct(result.digits[result.navTargetDigit]?.pairProb ?? 0)}</span>
                  <span className="text-muted-foreground">adj triple</span>
                  <span className="text-right">{pct(result.digits[result.navTargetDigit]?.tripleProb ?? 0)}</span>
                  <span className="text-muted-foreground">≥3 hits</span>
                  <span className="text-right">{pct(result.digits[result.navTargetDigit]?.threeHitProb ?? 0)}</span>
                </div>
              </div>
              {/* Navigator trigger rules — strict AND over the selected digit */}
              <div className="mb-2 rounded border border-border px-2 py-1.5">
                <div className="mb-1 text-[9px] uppercase tracking-widest text-muted-foreground">
                  Trigger rules · strict AND{result.navRulesEnabled ? "" : " · none on → default floor"}
                </div>
                <div className="grid grid-cols-1 gap-0.5">
                  {result.navRuleHits.map((h) => (
                    <div
                      key={h.rule}
                      className={`flex items-center justify-between gap-2 font-mono text-[9px] ${h.enabled ? "" : "opacity-40"}`}
                    >
                      <span className={h.enabled ? (h.pass ? "text-success" : "text-danger") : "text-muted-foreground"}>
                        {h.enabled ? (h.pass ? "✓" : "✗") : "·"} {h.label}
                      </span>
                      <span className="truncate text-muted-foreground">{h.detail}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="mb-1 text-center font-mono text-[9px] text-muted-foreground">
                engine pick {result.topTargetDigit} · {pct(result.topTargetProb)} landing
              </div>
              <div className="mb-2 grid grid-cols-2 gap-2">
                <Pool label="Fresh pool" digits={result.freshPool} tone="fresh" />
                <Pool label="Tired pool (blocked)" digits={result.tiredPool} tone="tired" />
              </div>
            </>
          )}

          {market === "overunder" && result.overUnder && <OverUnderView b={result.overUnder} duration={result.selectedDuration} />}
          {market === "evenodd" && result.evenOdd && (
            <ParityView b={result.evenOdd} runsZ={result.runsZScore} duration={result.selectedDuration} />
          )}
          {market === "risefall" && result.riseFall && <DirectionView b={result.riseFall} duration={result.selectedDuration} />}
          {market !== "matches" && (
            <div className="mb-2 grid grid-cols-2 gap-x-3 font-mono text-[10px] tabular-nums">
              <span className="text-muted-foreground">Edge vs chance</span>
              <span className={`text-right ${result.marketEdge >= 0.08 ? "text-success font-bold" : ""}`}>
                {pct1(result.marketEdge)}
              </span>
              <span className="text-muted-foreground">Rec probability</span>
              <span className="text-right">{pct(result.marketRecProb)}</span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
            <Diag label="Runs Z (parity)" value={result.runsZScore.toFixed(2)} title="Wald–Wolfowitz runs test on even/odd" />
            <Diag label="Regime" value={result.regime.replace("_", " ").toLowerCase()} />
            <Diag label={`KL (${result.bufferFilled ? Math.min(20, result.bufferSize) : 20}-tick)`} value={result.klDivergence.toFixed(3)} title="KL divergence vs uniform, micro window" />
            <Diag label="KL EMA θ" value={result.adaptiveKlThreshold.toFixed(3)} title="Adaptive KL threshold (EMA decay)" />
            <Diag label="KS drift" value={result.ksDrift.toFixed(3)} title="Kolmogorov–Smirnov drift vs discrete uniform" />
            <Diag label="LZW ratio" value={result.lzwRatio.toFixed(3)} title="Lempel-Ziv-Welch compression ratio (lower = repeating blocks)" />
            <Diag label="CUSUM" value={result.cusum.toFixed(1) + (result.cusumShift ? " ⚠shift" : "")} title="Page-Hinkley regime-shift accumulator" />
            <Diag
              label="AMI lags"
              value={result.amiLags.map((v) => v.toFixed(2)).join(" ")}
              title={`Algorithmic mutual information across lags 1..${result.amiLags.length} (Miller-Madow corrected, scaled to buffer)`}
            />
            <Diag
              label="RTT / gate"
              value={`${Math.round(result.rttMs)} / <${result.pingThresholdMs}ms`}
              title={result.latencyGatePassed ? "Latency gate passed" : "Latency gate FAILED — hold"}
              tone={result.latencyGatePassed ? "good" : "bad"}
            />
            <Diag label="Engine time" value={`${result.analyzeMs.toFixed(1)}ms`} title="Full engine calculation time" />
          </div>
        </>
      )}
    </div>
  );
}

export const NavigatorPanel = memo(NavigatorPanelImpl);
