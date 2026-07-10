import { memo } from "react";

export interface PrngInputs {
  serverSeed: string;
  clientSeed: string;
  startNonce: number;
  steps: number;
}

interface Props {
  draft: PrngInputs;
  onChange: (patch: Partial<PrngInputs>) => void;
  onGenerate: () => void;
  onRotateClient: () => void;
  busy: boolean;
}

function PrngInputFormImpl({ draft, onChange, onGenerate, onRotateClient, busy }: Props) {
  return (
    <div className="rounded-md border border-border bg-card p-3 text-[11px]">
      <div className="mb-2 font-semibold">PRNG Inputs</div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Server Seed</span>
          <input
            type="text"
            value={draft.serverSeed}
            onChange={(e) => onChange({ serverSeed: e.target.value })}
            className="rounded border border-input bg-background px-2 py-1 font-mono text-[11px]"
            placeholder="hashed server seed…"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Client Seed</span>
          <div className="flex gap-1">
            <input
              type="text"
              value={draft.clientSeed}
              onChange={(e) => onChange({ clientSeed: e.target.value })}
              className="flex-1 rounded border border-input bg-background px-2 py-1 font-mono text-[11px]"
              placeholder="client seed…"
            />
            <button
              type="button"
              onClick={onRotateClient}
              className="rounded border border-input px-2 py-1 text-[10px] font-mono text-cyan"
              style={{ touchAction: "manipulation" }}
            >
              Rotate
            </button>
          </div>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Starting Nonce</span>
          <input
            type="number"
            min={0}
            value={draft.startNonce}
            onChange={(e) => onChange({ startNonce: Math.max(0, parseInt(e.target.value || "0", 10)) })}
            className="rounded border border-input bg-background px-2 py-1 font-mono text-[11px]"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Generate Steps (max 1000)</span>
          <input
            type="number"
            min={1}
            max={1000}
            value={draft.steps}
            onChange={(e) =>
              onChange({ steps: Math.max(1, Math.min(1000, parseInt(e.target.value || "1", 10))) })
            }
            className="rounded border border-input bg-background px-2 py-1 font-mono text-[11px]"
          />
        </label>
      </div>
      <button
        type="button"
        onClick={onGenerate}
        disabled={busy}
        className="mt-3 w-full rounded border border-cyan bg-cyan/10 px-3 py-2 text-[12px] font-semibold text-cyan disabled:opacity-50"
        style={{ touchAction: "manipulation" }}
      >
        {busy ? "Computing SHA-256 stream…" : "Generate Sequence"}
      </button>
    </div>
  );
}

export const PrngInputForm = memo(PrngInputFormImpl);
