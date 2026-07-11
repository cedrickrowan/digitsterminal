import { memo } from "react";
import type { AppConfig, Market, Mode, RuleToggles } from "@/lib/deriv/types";
import { SYMBOLS, LOOKBACK_OPTIONS } from "@/lib/deriv/types";


interface Props {
  cfg: AppConfig;
  onChange: (patch: Partial<AppConfig>) => void;
  connected: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  armed: boolean;
  onToggleArm: () => void;
}

const RULE_META: { key: keyof RuleToggles; label: string; field?: keyof AppConfig; suffix?: string }[] = [
  { key: "ensemble", label: "Ensemble% >", field: "triggerEnsembleAbove", suffix: "%" },
  { key: "markov", label: "Markov% >", field: "triggerMarkovAbove", suffix: "%" },
  { key: "differs", label: "Differs% <", field: "triggerDiffersBelow", suffix: "%" },
  { key: "streak", label: "Streak ≥", field: "triggerStreak" },
  { key: "prob", label: "Freq% <", field: "triggerProbBelow", suffix: "%" },
  { key: "sequence", label: "2-tick% >", field: "triggerSequenceAbove", suffix: "%" },
  { key: "cold", label: "Cold P% <", field: "triggerColdProbBelow", suffix: "%" },
  { key: "deviation", label: "|Δ from 10%| >", field: "triggerDeviationPct", suffix: "%" },
];

const MARKETS: { key: Market; label: string }[] = [
  { key: "matches", label: "Matches" },
  { key: "differs", label: "Differs" },
  { key: "overunder", label: "Over/Under" },
  { key: "evenodd", label: "Even/Odd" },
  { key: "risefall", label: "Rise/Fall" },
];


function ControlsImpl({ cfg, onChange, connected, onConnect, onDisconnect, armed, onToggleArm }: Props) {
  const setRule = (k: keyof RuleToggles, v: boolean) =>
    onChange({ rules: { ...cfg.rules, [k]: v } });

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
          <span className="text-muted-foreground">Lookback</span>
          <select
            className="rounded border border-input bg-background px-2 py-1.5 font-mono"
            value={cfg.lookback}
            onChange={(e) => onChange({ lookback: Number(e.target.value) })}
          >
            {LOOKBACK_OPTIONS.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">
            {cfg.market === "overunder" ? "Barrier (0-8)" : "Predict digit"}
          </span>

          {cfg.market === "overunder" ? (
            <input
              type="number" min={0} max={8}
              className="rounded border border-input bg-background px-2 py-1.5 font-mono"
              value={cfg.barrier}
              onChange={(e) => onChange({ barrier: Math.max(0, Math.min(8, Number(e.target.value))) })}
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
        <div className="mb-1 text-[10px] uppercase tracking-widest text-cyan">Trigger rules</div>
        <div className="grid grid-cols-1 gap-1">
          {RULE_META.map((r) => (
            <label key={r.key} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={cfg.rules[r.key]}
                onChange={(e) => setRule(r.key, e.target.checked)}
              />
              <span className="w-32 text-muted-foreground">{r.label}</span>
              {r.field && (
                <input
                  type="number"
                  step={r.suffix === "%" ? 0.5 : 1}
                  className="w-20 rounded border border-input bg-background px-2 py-1 font-mono"
                  value={cfg[r.field] as number}
                  onChange={(e) => onChange({ [r.field as string]: Number(e.target.value) } as Partial<AppConfig>)}
                />
              )}
              {r.suffix && <span className="text-muted-foreground">{r.suffix}</span>}
            </label>
          ))}
        </div>
      </div>

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
