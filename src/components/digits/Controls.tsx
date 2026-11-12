import { memo } from "react";
import type { AppConfig, Market, Mode, NavRuleToggles, NavThresholds } from "@/lib/deriv/types";
import { SYMBOLS } from "@/lib/deriv/types";
import { snapLookback } from "@/lib/deriv/storage";

const LOOKBACK_PRESETS = [3, 30, 60, 90, 150, 300, 600, 900];

interface Props {
  cfg: AppConfig;
  onChange: (patch: Partial<AppConfig>) => void;
  connected: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  armed: boolean;
  onToggleArm: () => void;
}
const NAV_RULE_META: {
  key: keyof NavRuleToggles;
  label: string;
  thr?: keyof NavThresholds;
  thrMax?: keyof NavThresholds;
  suffix?: string;
  step?: number;
}[] = [
  // Legacy 7 rules
  { key: "ensemble", label: "Ensemble% >", thr: "triggerEnsembleAbove", suffix: "%" },
  { key: "markov", label: "Markov% >", thr: "triggerMarkovAbove", suffix: "%" },
  { key: "streak", label: "Streak ≥", thr: "triggerStreak", step: 1 },
  { key: "prob", label: "Freq% <", thr: "triggerProbBelow", suffix: "%" },
  { key: "sequence", label: "Follow-D% >", thr: "triggerSequenceAbove", suffix: "%" },
  { key: "cold", label: "Cold P% <", thr: "triggerColdProbBelow", suffix: "%" },
  { key: "deviation", label: "|Δ from 10%| >", thr: "triggerDeviationPct", suffix: "%" },

  // Navigator 11 rules
  { key: "multiHit", label: "Multi-hit ≥2 (D)", thr: "multiHitPct", suffix: "%" },
  { key: "pairRun", label: "Pair/Run (d,d)", thr: "pairRunPct", suffix: "%" },
  { key: "landing", label: "Landing t+D", thr: "landingPct", suffix: "%" },
  { key: "freshness", label: "Fresh (anti-tired)" },
  { key: "parity", label: "Parity confluence", thr: "parityPct", suffix: "%" },
  { key: "barrier", label: "O/U confluence", thr: "barrierPct", suffix: "%" },
  { key: "lowEntropy", label: "Low-entropy regime", thr: "entropyZMax", step: 0.1 },
  { key: "antiRepeat", label: "Anti-repeat filter" },
  { key: "frequencyEnvelope", label: "Freq envelope [min, max]%", thr: "frequencyMinPct", thrMax: "frequencyMaxPct", suffix: "%" },
  { key: "markovD", label: "D-Step Markov", thr: "markovDPct", suffix: "%" },
  { key: "hurstFilter", label: "Hurst Non-Random (H)", thr: "hurstMinEdge", step: 0.01 },
  { key: "macroConfluence", label: "Macro Confluence Gate" },
];

const MARKETS: { key: Market; label: string }[] = [
  { key: "matches", label: "Matches" },
  { key: "differs", label: "Differs" },
  { key: "overunder", label: "Over/Under" },
  { key: "evenodd", label: "Even/Odd" },
  { key: "risefall", label: "Rise/Fall" },
];

function ControlsImpl({ cfg, onChange, connected, onConnect, onDisconnect, armed, onToggleArm }: Props) {

  const setNavRule = (k: keyof NavRuleToggles, v: boolean) =>
    onChange({ navRules: { ...cfg.navRules, [k]: v } });

  const setNavThreshold = (k: keyof NavThresholds, v: number) => {
    const next = { ...cfg.navThresholds } as unknown as Record<string, number>;
    next[k] = v;
    onChange({ navThresholds: next as unknown as NavThresholds });
  };

  return (
    <div className="space-y-2 rounded-lg border border-border bg-card px-3 py-2 text-xs">
      <div className="flex gap-1">
        {MARKETS.map((m) => (
          <button
            key={m.key}
            type="button"
            onClick={() => onChange({ market: m.key })}
            className={`flex-1 rounded border px-1 py-1.5 text-[11px] font-mono uppercase tracking-wider ${
              cfg.market === m.key
                ? "border-cyan bg-cyan/10 text-cyan shadow-[0_0_10px_-2px_var(--color-cyan)]"
                : "border-input bg-background text-muted-foreground"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Symbol</span>
          <select
            className="rounded border border-input bg-background px-2 py-1.5 font-mono"
            value={cfg.symbol}
            onChange={(e) => onChange({ symbol: e.target.value })}
          >
            {SYMBOLS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Lookback (×3, 3-900)</span>
          <div className="flex gap-1">
            <input
              type="number" min={3} max={900} step={3}
              className="w-16 rounded border border-input bg-background px-2 py-1.5 font-mono"
              value={cfg.lookback}
              onChange={(e) => onChange({ lookback: snapLookback(Number(e.target.value)) })}
            />
            <select
              className="min-w-0 flex-1 rounded border border-input bg-background px-1 py-1.5 font-mono"
              value={LOOKBACK_PRESETS.includes(cfg.lookback) ? cfg.lookback : ""}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (v) onChange({ lookback: v });
              }}
            >
              <option value="">more…</option>
              {LOOKBACK_PRESETS.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </div>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">
            {cfg.market === "overunder" ? "Barrier (0-9)" : "Predict digit"}
          </span>
          {cfg.market === "overunder" ? (
            <input
              type="number" min={0} max={9}
              className="rounded border border-input bg-background px-2 py-1.5 font-mono"
              value={cfg.barrier}
              onChange={(e) => onChange({ barrier: Math.max(0, Math.min(9, Number(e.target.value))) })}
            />
          ) : (
            <input
              type="number" min={0} max={9}
              className="rounded border border-input bg-background px-2 py-1.5 font-mono"
              value={cfg.predictDigit}
              onChange={(e) => onChange({ predictDigit: Math.max(0, Math.min(9, Number(e.target.value))) })}
            />
          )}
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Duration (ticks)</span>
          <input
            type="number" min={1} max={10}
            className="rounded border border-input bg-background px-2 py-1.5 font-mono"
            value={cfg.duration}
            onChange={(e) => onChange({ duration: Math.max(1, Number(e.target.value)) })}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Exec lag (ms)</span>
          <input
            type="number" min={0} step={50}
            className="rounded border border-input bg-background px-2 py-1.5 font-mono"
            value={cfg.latencyOffsetMs}
            onChange={(e) => onChange({ latencyOffsetMs: Number(e.target.value) })}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Stake</span>
          <input
            type="number" min={0.35} step="0.01"
            className="rounded border border-input bg-background px-2 py-1.5 font-mono"
            value={cfg.stake}
            onChange={(e) => onChange({ stake: Number(e.target.value) })}
          />
        </label>
      </div>

      <div className="border-t border-border pt-2">
        <div className="mb-1 text-[10px] uppercase tracking-widest text-cyan">Execution safety guard</div>
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Max ping (ms)</span>
            <input
              type="number" min={50} step={50}
              className="rounded border border-input bg-background px-2 py-1.5 font-mono"
              value={cfg.safePingMs}
              onChange={(e) => onChange({ safePingMs: Number(e.target.value) })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Max tick gap (ms)</span>
            <input
              type="number" min={100} step={50}
              className="rounded border border-input bg-background px-2 py-1.5 font-mono"
              value={cfg.safeGapMs}
              onChange={(e) => onChange({ safeGapMs: Number(e.target.value) })}
            />
          </label>
        </div>
      </div>

      <div className="border-t border-border pt-2">
        <div className="mb-1 text-[10px] uppercase tracking-widest text-cyan">Trigger rules · Matches (strict AND · 19 rules)</div>
        <div className="grid grid-cols-1 gap-1">
          {NAV_RULE_META.map((r) => (
            <label key={r.key} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={cfg.navRules[r.key]}
                onChange={(e) => setNavRule(r.key, e.target.checked)}
              />
              <span className="w-32 text-muted-foreground">{r.label}</span>
              
  {r.thr && (
    <input
      type="number"
      step={r.step ?? 0.5}
      min={r.suffix === "%" ? 0 : undefined}
      max={r.suffix === "%" ? 100 : undefined}
      className="w-16 rounded border border-input bg-background px-2 py-1 font-mono"
      value={cfg.navThresholds[r.thr]}
      onChange={(e) => setNavThreshold(r.thr!, Number(e.target.value))}
    />
   )}
   {r.thrMax && (
    <input
      type="number"
      step={r.step ?? 0.5}
      min={0}
      max={100}
      className="w-16 rounded border border-input bg-background px-2 py-1 font-mono"
      value={cfg.navThresholds[r.thrMax]}
      onChange={(e) => setNavThreshold(r.thrMax!, Number(e.target.value))}
     />
     )}
              {r.suffix && <span className="text-muted-foreground">{r.suffix}</span>}
            </label>
          ))}
        </div>
      </div>
     {cfg.market === "differs" && (
  <div className="border-t border-border pt-2">
    <div className="mb-1 text-[10px] uppercase tracking-widest text-cyan">Differs Strategy Controls</div>
    <div className="grid grid-cols-2 gap-2">
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Landing Ceiling % (&lt;)</span>
        <input
          type="number"
          min={1}
          max={20}
          step={0.5}
          className="rounded border border-input bg-background px-2 py-1.5 font-mono"
          value={cfg.navThresholds.differsProbabilityCeilingPct}
          onChange={(e) => setNavThreshold("differsProbabilityCeilingPct", Number(e.target.value))}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Min Cold Gap (ticks)</span>
        <input
          type="number"
          min={1}
          max={50}
          step={1}
          className="rounded border border-input bg-background px-2 py-1.5 font-mono"
          value={cfg.navThresholds.differsColdGapMin}
          onChange={(e) => setNavThreshold("differsColdGapMin", Number(e.target.value))}
        />
      </label>
    </div>
  </div>
)}
      
      <div className="flex items-center gap-1 border-t border-border pt-2">
        <span className="mr-1 text-muted-foreground">Mode</span>
        {(["alert", "simulated", "live"] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onChange({ mode: m })}
            className={`flex-1 rounded border px-2 py-1.5 capitalize ${
              cfg.mode === m
                ? "border-cyan bg-cyan/10 text-cyan"
                : "border-input bg-background text-muted-foreground"
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      <div className="flex gap-2 pt-1">
        {connected ? (
          <button
            type="button"
            onClick={onDisconnect}
            className="flex-1 rounded border border-input bg-background px-2 py-2 font-semibold"
          >
            Disconnect
          </button>
        ) : (
          <button
            type="button"
            onClick={onConnect}
            className="flex-1 rounded border border-cyan bg-cyan/15 px-2 py-2 font-semibold text-cyan shadow-[0_0_10px_-2px_var(--color-cyan)]"
          >
            Connect
          </button>
        )}
        <button
          type="button"
          onClick={onToggleArm}
          className={`flex-1 rounded border px-2 py-2 font-semibold ${
            armed
              ? "border-magenta bg-magenta/20 text-magenta shadow-[0_0_10px_-2px_var(--color-magenta)]"
              : "border-input bg-background text-muted-foreground"
          }`}
        >
          {armed ? "Disarm" : "Arm"}
        </button>
      </div>
    </div>
  );
}

export const Controls = memo(ControlsImpl);
