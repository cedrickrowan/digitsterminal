import { memo } from "react";
import type { AuthInfo, ContractType } from "@/lib/deriv/derivClient";

export interface OrderRecord {
  id: number;
  ts: number;
  label: string;
  ok: boolean;
  detail: string;
}

interface Props {
  auth: AuthInfo | null;
  connected: boolean;
  autoFire: boolean;
  onAutoFireChange: (v: boolean) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  /** Contract that will be sent the moment the gate passes. */
  planned: { type: ContractType; label: string; barrier?: number };
  stake: number;
  durationTicks: number;
  gateReady: boolean;
  confidence: number;
  rulesSatisfied: boolean;
  networkOk: boolean;
  busy: boolean;
  orders: OrderRecord[];
}

function Light({ on, label }: { on: boolean; label: string }) {
  return (
    <div className="flex items-center gap-1">
      <span
        className={`h-2 w-2 rounded-full ${
          on ? "bg-success shadow-[0_0_8px_var(--color-success)]" : "bg-danger/70"
        }`}
      />
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
    </div>
  );
}

function OrderExecutionPanelImpl(p: Props) {
  return (
    <div
      className={`space-y-2 rounded-lg border px-3 py-2 text-xs ${
        p.gateReady && p.auth
          ? "border-success bg-success/5 shadow-[0_0_20px_-6px_var(--color-success)]"
          : "border-cyan/40 bg-card"
      }`}
      style={{ touchAction: "manipulation" }}
    >
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-widest text-cyan">Order execution</span>
        <span
          className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
            p.auth ? "border-success text-success" : "border-warning text-warning"
          }`}
        >
          {p.auth ? (p.auth.isVirtual ? "DEMO" : "REAL") : "NOT LINKED"}
        </span>
      </div>

      {p.auth ? (
        <div className="flex items-center justify-between rounded border border-border bg-background/40 px-2 py-1.5 font-mono text-[11px]">
          <span>{p.auth.loginid}</span>
          <span className="text-cyan">
            {p.auth.balance.toFixed(2)} {p.auth.currency}
          </span>
        </div>
      ) : (
        <button
          type="button"
          onClick={p.onConnect}
          className="h-11 w-full rounded-lg border border-cyan bg-cyan/15 font-mono text-sm font-bold uppercase tracking-wider text-cyan shadow-[0_0_12px_-2px_var(--color-cyan)] active:scale-[0.98]"
        >
          Connect Deriv account
        </button>
      )}

      <div className="grid grid-cols-3 gap-2 rounded border border-border bg-background/40 px-2 py-1.5 font-mono text-[11px]">
        <div>
          <div className="text-[9px] uppercase text-muted-foreground">Contract</div>
          <div className="text-cyan">{p.planned.label}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase text-muted-foreground">Stake</div>
          <div>{p.stake.toFixed(2)}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase text-muted-foreground">Ticks</div>
          <div>{p.durationTicks}</div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Light on={p.confidence > 0.85} label={`conf ${(p.confidence * 100).toFixed(0)}%`} />
        <Light on={p.rulesSatisfied} label="rules" />
        <Light on={p.networkOk} label="network" />
        <Light on={!!p.auth && p.connected} label="account" />
      </div>

      <label className="flex items-center justify-between rounded border border-border bg-background/40 px-2 py-1.5">
        <span className="font-semibold">Auto-fire on signal</span>
        <input
          type="checkbox"
          checked={p.autoFire}
          onChange={(e) => p.onAutoFireChange(e.target.checked)}
          className="h-5 w-5 accent-[var(--color-cyan)]"
          aria-label="Auto-fire live orders when the gate passes"
        />
      </label>

      <div
        className={`rounded border px-2 py-1.5 text-center font-mono text-[11px] font-bold uppercase tracking-wider ${
          p.busy
            ? "border-warning text-warning"
            : p.gateReady && p.auth && p.autoFire
              ? "border-success text-success"
              : "border-border text-muted-foreground"
        }`}
      >
        {p.busy
          ? "Sending order…"
          : !p.auth
            ? "Link account to execute"
            : !p.autoFire
              ? "Auto-fire off · monitoring"
              : p.gateReady
                ? "FIRING — gate passed"
                : "Armed · waiting for gate"}
      </div>

      {p.orders.length > 0 && (
        <ul className="space-y-1">
          {p.orders.slice(0, 5).map((o) => (
            <li
              key={o.id}
              className={`truncate rounded border px-2 py-1 font-mono text-[10px] ${
                o.ok ? "border-success/50 text-success" : "border-danger/50 text-danger"
              }`}
            >
              {new Date(o.ts).toLocaleTimeString()} · {o.label} · {o.detail}
            </li>
          ))}
        </ul>
      )}

      {!p.auth && (
        <p className="text-[10px] leading-snug text-muted-foreground">
          Login happens on Deriv's own OAuth page — no token typing here. You return signed in and
          orders fire straight to your account.
        </p>
      )}
    </div>
  );
}

export const OrderExecutionPanel = memo(OrderExecutionPanelImpl);
