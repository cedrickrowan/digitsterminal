import { memo } from "react";

export interface SeedHistoryEntry {
  id: number;
  ts: number;
  lastNonce: number;
  retiredHash: string;
  reason: "manual" | "nonce-reset" | "hash-change";
}

interface Props {
  entries: SeedHistoryEntry[];
  onVerify: () => void;
  verifyEnabled: boolean;
}

function SeedHistoryLogImpl({ entries, onVerify, verifyEnabled }: Props) {
  return (
    <div className="rounded-md border border-border bg-card p-2 text-[11px]">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-semibold">Seed History Log</span>
        <button
          type="button"
          onClick={onVerify}
          disabled={!verifyEnabled}
          className={`rounded border px-2 py-1 text-[10px] font-mono ${
            verifyEnabled
              ? "border-warning text-warning animate-pulse"
              : "border-input text-muted-foreground opacity-50"
          }`}
          style={{ touchAction: "manipulation" }}
        >
          Verify Last Session
        </button>
      </div>
      <div className="max-h-32 overflow-auto rounded bg-background/60 p-1 font-mono text-[10px] leading-tight">
        {entries.length === 0 ? (
          <div className="text-muted-foreground">No rotations yet…</div>
        ) : (
          entries
            .slice()
            .reverse()
            .map((e) => (
              <div key={e.id} className="border-b border-border/30 py-1 last:border-0">
                <div className="text-muted-foreground">
                  {new Date(e.ts).toLocaleTimeString()} · {e.reason} · last nonce {e.lastNonce}
                </div>
                <div className="truncate text-cyan">{e.retiredHash || "—"}</div>
              </div>
            ))
        )}
      </div>
    </div>
  );
}

export const SeedHistoryLog = memo(SeedHistoryLogImpl);
