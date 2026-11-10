import { memo, useState } from "react";
import type { ContractType } from "@/lib/deriv/derivClient";

interface Props {
  authorized: boolean;
  stake: number;
  duration: number;
  barrier: number;
  predictDigit: number;
  onStakeChange: (n: number) => void;
  onDurationChange: (n: number) => void;
  onBarrierChange: (n: number) => void;
  onPredictDigitChange: (n: number) => void;
  onBuy: (contractType: ContractType, barrier?: number) => void;
  safe: boolean;
  lastResult?: string;
  busy: boolean;
}

function Btn({
  label,
  tone,
  onClick,
  disabled,
}: {
  label: string;
  tone: "cyan" | "magenta" | "warn" | "good";
  onClick: () => void;
  disabled?: boolean;
}) {
  const toneCls =
    tone === "cyan"
      ? "border-cyan bg-cyan/15 text-cyan shadow-[0_0_10px_-2px_var(--color-cyan)]"
      : tone === "magenta"
        ? "border-magenta bg-magenta/15 text-magenta shadow-[0_0_10px_-2px_var(--color-magenta)]"
        : tone === "good"
          ? "border-emerald-500 bg-emerald-500/15 text-emerald-400"
          : "border-amber-500 bg-amber-500/15 text-amber-400";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`h-12 flex-1 rounded-lg border font-mono text-sm font-bold uppercase tracking-wider active:scale-[0.98] disabled:opacity-40 disabled:active:scale-100 ${toneCls}`}
    >
      {label}
    </button>
  );
}

function TradeConsoleImpl({
  authorized,
  stake,
  duration,
  barrier,
  predictDigit,
  onStakeChange,
  onDurationChange,
  onBarrierChange,
  onPredictDigitChange,
  onBuy,
  safe,
  lastResult,
  busy,
}: Props) {
  const [confirmType, setConfirmType] = useState<ContractType | null>(null);
  const disabled = !authorized || busy;

  const fire = (t: ContractType, b?: number) => {
    if (!safe) {
      setConfirmType(t);
      // user must tap again to confirm when network unsafe
      setTimeout(() => setConfirmType(null), 2500);
      return;
    }
    onBuy(t, b);
  };
  const confirm = (t: ContractType, b?: number) => {
    setConfirmType(null);
    onBuy(t, b);
  };

  const needConfirm = (t: ContractType) => confirmType === t;

  return (
    <div className="space-y-2 rounded-lg border border-border bg-card px-3 py-2 text-xs">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-widest text-cyan">Trade console</span>
        <span
          className={`rounded border px-1.5 py-0.5 text-[10px] font-mono ${
            safe ? "border-emerald-500 text-emerald-400" : "border-amber-500 text-amber-400"
          }`}
        >
          {safe ? "NET OK" : "NET RISKY"}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Stake (USD)</span>
          <input
            type="number" min={0.35} step="0.01" inputMode="decimal"
            className="h-10 rounded border border-input bg-background px-2 font-mono text-sm"
            value={stake}
            onChange={(e) => onStakeChange(Number(e.target.value))}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Ticks</span>
          <input
            type="number" min={1} max={10} inputMode="numeric"
            className="h-10 rounded border border-input bg-background px-2 font-mono text-sm"
            value={duration}
            onChange={(e) => onDurationChange(Math.max(1, Math.min(10, Number(e.target.value))))}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Digit (0–9)</span>
          <input
            type="number" min={0} max={9} inputMode="numeric"
            className="h-10 rounded border border-input bg-background px-2 font-mono text-sm"
            value={predictDigit}
            onChange={(e) => onPredictDigitChange(Math.max(0, Math.min(9, Number(e.target.value))))}
          />
        </label>
      </div>

      {/* Row 1: Matches / Differs */}
      <div className="flex gap-2">
        <Btn
          label={needConfirm("DIGITMATCH") ? `Tap to confirm` : `Matches ${predictDigit}`}
          tone={needConfirm("DIGITMATCH") ? "warn" : "cyan"}
          disabled={disabled}
          onClick={() => (needConfirm("DIGITMATCH") ? confirm("DIGITMATCH", predictDigit) : fire("DIGITMATCH", predictDigit))}
        />
        <Btn
          label={needConfirm("DIGITDIFF") ? `Tap to confirm` : `Differs ${predictDigit}`}
          tone={needConfirm("DIGITDIFF") ? "warn" : "magenta"}
          disabled={disabled}
          onClick={() => (needConfirm("DIGITDIFF") ? confirm("DIGITDIFF", predictDigit) : fire("DIGITDIFF", predictDigit))}
        />
      </div>

            {/* Row 2: Over / Under with barrier */}
      <div className="flex items-center gap-2">
        <Btn
          label={needConfirm("DIGITOVER") ? `Tap to confirm` : `Over ${barrier}`}
          tone={needConfirm("DIGITOVER") ? "warn" : "cyan"}
          disabled={disabled}
          onClick={() => (needConfirm("DIGITOVER") ? confirm("DIGITOVER", barrier) : fire("DIGITOVER", barrier))}
        />
        <div className="flex h-12 shrink-0 flex-col items-center justify-center rounded-lg border border-input bg-background px-1">
          <span className="text-[9px] uppercase text-muted-foreground">barrier</span>
          <div className="flex items-center gap-1">
            <button type="button" className="h-6 w-6 rounded border border-input font-mono" onClick={() => onBarrierChange(Math.max(0, barrier - 1))}>−</button>
            <span className="w-5 text-center font-mono text-sm font-bold text-cyan">{barrier}</span>
            <button type="button" className="h-6 w-6 rounded border border-input font-mono" onClick={() => onBarrierChange(Math.min(9, barrier + 1))}>+</button>
          </div>
        </div>
         <Btn
          label={needConfirm("DIGITUNDER") ? `Tap to confirm` : `Under ${barrier}`}
          tone={needConfirm("DIGITUNDER") ? "warn" : "magenta"}
          disabled={disabled}
          onClick={() => (needConfirm("DIGITUNDER") ? confirm("DIGITUNDER", barrier) : fire("DIGITUNDER", barrier))}
        />
      </div>

      {/* Row 3: Even / Odd */}
      <div className="flex gap-2">
        <Btn
          label={needConfirm("DIGITEVEN") ? `Tap to confirm` : "Even"}
          tone={needConfirm("DIGITEVEN") ? "warn" : "cyan"}
          disabled={disabled}
          onClick={() => (needConfirm("DIGITEVEN") ? confirm("DIGITEVEN") : fire("DIGITEVEN"))}
        />
        <Btn
          label={needConfirm("DIGITODD") ? `Tap to confirm` : "Odd"}
          tone={needConfirm("DIGITODD") ? "warn" : "magenta"}
          disabled={disabled}
          onClick={() => (needConfirm("DIGITODD") ? confirm("DIGITODD") : fire("DIGITODD"))}
        />
      </div>

      {/* Row 4: Rise / Fall */}
      <div className="flex gap-2">
        <Btn
          label={needConfirm("CALL") ? `Tap to confirm` : "Rise"}
          tone={needConfirm("CALL") ? "warn" : "good"}
          disabled={disabled}
          onClick={() => (needConfirm("CALL") ? confirm("CALL") : fire("CALL"))}
        />
        <Btn
          label={needConfirm("PUT") ? `Tap to confirm` : "Fall"}
          tone={needConfirm("PUT") ? "warn" : "magenta"}
          disabled={disabled}
          onClick={() => (needConfirm("PUT") ? confirm("PUT") : fire("PUT"))}
        />
      </div>

      {!authorized && (
        <div className="rounded border border-amber-500/40 bg-amber-500/5 px-2 py-1 text-[11px] text-amber-400">
          Paste a Deriv API token above to enable live trading.
        </div>
      )}
      {lastResult && (
        <div className="truncate rounded border border-border bg-background/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">
          {lastResult}
        </div>
      )}
    </div>
  );
}

export const TradeConsole = memo(TradeConsoleImpl);
