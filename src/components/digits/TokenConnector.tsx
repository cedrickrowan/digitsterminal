import { memo, useState } from "react";
import type { AuthInfo } from "@/lib/deriv/derivClient";

interface Props {
  token: string;
  onTokenChange: (t: string) => void;
  auth: AuthInfo | null;
  connected: boolean;
  onApply: () => void;
  onClear: () => void;
}

function TokenConnectorImpl({ token, onTokenChange, auth, connected, onApply, onClear }: Props) {
  const [reveal, setReveal] = useState(false);
  return (
    <div className="space-y-2 rounded-lg border border-border bg-card px-3 py-2 text-xs">
      <div className="text-[10px] uppercase tracking-widest text-cyan">Deriv connection</div>
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Deriv API Token</span>
        <div className="flex gap-1">
          <input
            type={reveal ? "text" : "password"}
            className="min-w-0 flex-1 rounded border border-input bg-background px-2 py-1.5 font-mono"
            placeholder="Paste token (scope: Read, Trade)"
            value={token}
            onChange={(e) => onTokenChange(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={() => setReveal((r) => !r)}
            className="shrink-0 rounded border border-input bg-background px-2 text-muted-foreground"
          >
            {reveal ? "Hide" : "Show"}
          </button>
        </div>
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onApply}
          disabled={!connected}
          className="flex-1 rounded border border-cyan bg-cyan/15 px-2 py-1.5 font-semibold text-cyan shadow-[0_0_10px_-2px_var(--color-cyan)] disabled:opacity-50"
        >
          Authorize
        </button>
        <button
          type="button"
          onClick={onClear}
          className="flex-1 rounded border border-input bg-background px-2 py-1.5 text-muted-foreground"
        >
          Clear
        </button>
      </div>
      <div className="rounded border border-border bg-background/40 px-2 py-1.5 font-mono text-[11px]">
        {auth ? (
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                auth.isVirtual
                  ? "border border-cyan/60 bg-cyan/10 text-cyan"
                  : "border border-magenta/60 bg-magenta/10 text-magenta"
              }`}
            >
              {auth.isVirtual ? "DEMO" : "REAL"}
            </span>
            <span className="text-muted-foreground">{auth.loginid}</span>
            <span className="ml-auto text-foreground">
              {auth.balance.toFixed(2)} {auth.currency}
            </span>
          </div>
        ) : (
          <span className="text-muted-foreground">Not authorized — analysis only.</span>
        )}
      </div>
    </div>
  );
}

export const TokenConnector = memo(TokenConnectorImpl);
