import { memo } from "react";
import type { AppConfig, Mode } from "@/lib/deriv/types";
import { SYMBOLS } from "@/lib/deriv/types";

interface Props {
  cfg: AppConfig;
  onChange: (patch: Partial<AppConfig>) => void;
  connected: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  armed: boolean;
  onToggleArm: () => void;
}

function ControlsImpl({ cfg, onChange, connected, onConnect, onDisconnect, armed, onToggleArm }: Props) {
  return (
    <div className="space-y-2 rounded-md border border-border bg-card px-3 py-2 text-xs">
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Symbol</span>
          <select
            className="rounded border border-input bg-background px-2 py-1.5"
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
            className="rounded border border-input bg-background px-2 py-1.5"
            value={cfg.lookback}
            onChange={(e) => onChange({ lookback: Number(e.target.value) as 25 | 50 | 100 })}
          >
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Predict digit</span>
          <input
            type="number" min={0} max={9}
            className="rounded border border-input bg-background px-2 py-1.5"
            value={cfg.predictDigit}
            onChange={(e) => onChange({ predictDigit: Math.max(0, Math.min(9, Number(e.target.value))) })}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Duration (ticks)</span>
          <input
            type="number" min={1} max={10}
            className="rounded border border-input bg-background px-2 py-1.5"
            value={cfg.duration}
            onChange={(e) => onChange({ duration: Math.max(1, Number(e.target.value)) })}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Stake</span>
          <input
            type="number" min={0.35} step="0.01"
            className="rounded border border-input bg-background px-2 py-1.5"
            value={cfg.stake}
            onChange={(e) => onChange({ stake: Number(e.target.value) })}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Exec latency (ms)</span>
          <input
            type="number" min={0} step={50}
            className="rounded border border-input bg-background px-2 py-1.5"
            value={cfg.latencyOffsetMs}
            onChange={(e) => onChange({ latencyOffsetMs: Number(e.target.value) })}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Trigger streak ≥</span>
          <input
            type="number" min={2} max={9}
            className="rounded border border-input bg-background px-2 py-1.5"
            value={cfg.triggerStreak}
            onChange={(e) => onChange({ triggerStreak: Number(e.target.value) })}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">…or P below %</span>
          <input
            type="number" min={1} max={20} step="0.5"
            className="rounded border border-input bg-background px-2 py-1.5"
            value={cfg.triggerProbBelow}
            onChange={(e) => onChange({ triggerProbBelow: Number(e.target.value) })}
          />
        </label>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">Mode</span>
        {(["alert", "simulated", "live"] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onChange({ mode: m })}
            className={`flex-1 rounded border px-2 py-1.5 capitalize ${
              cfg.mode === m ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background"
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Deriv API token (live mode only)</span>
        <input
          type="password"
          className="rounded border border-input bg-background px-2 py-1.5 font-mono"
          value={cfg.token}
          placeholder="paste token"
          onChange={(e) => onChange({ token: e.target.value })}
        />
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={cfg.rememberToken}
          onChange={(e) => onChange({ rememberToken: e.target.checked })}
        />
        <span className="text-muted-foreground">Remember token in this browser (insecure)</span>
      </label>

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
            className="flex-1 rounded border border-primary bg-primary px-2 py-2 font-semibold text-primary-foreground"
          >
            Connect
          </button>
        )}
        <button
          type="button"
          onClick={onToggleArm}
          className={`flex-1 rounded border px-2 py-2 font-semibold ${
            armed ? "border-danger bg-danger text-white" : "border-input bg-background"
          }`}
        >
          {armed ? "Disarm" : "Arm"}
        </button>
      </div>
    </div>
  );
}

export const Controls = memo(ControlsImpl);
