import { useCallback, useEffect, useRef, useState } from "react";
import { PrngInputForm, type PrngInputs } from "./PrngInputForm";
import { PrngTable } from "./PrngTable";
import { PrngChart } from "./PrngChart";
import { SeedHistoryLog, type SeedHistoryEntry } from "./SeedHistoryLog";
import { generatePrng, type PrngRow } from "./prngCore";

interface Props {
  /** Feed the generated decimal digits into the terminal's analysis engine. */
  onFeedDigits?: (digits: number[]) => void;
}

const DEFAULT_INPUTS: PrngInputs = {
  serverSeed: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  clientSeed: "cedrick-client-01",
  startNonce: 1,
  steps: 100,
};

function randomClientSeed(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return "c-" + Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export default function PrngSimulator({ onFeedDigits }: Props) {
  // Draft = form input state (isolated so typing doesn't re-render table/chart).
  const [draft, setDraft] = useState<PrngInputs>(DEFAULT_INPUTS);
  // Applied = the inputs actually driving the heavy compute (updated on Generate).
  const [applied, setApplied] = useState<PrngInputs>(DEFAULT_INPUTS);
  const [rows, setRows] = useState<PrngRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<SeedHistoryEntry[]>([]);
  const [rotated, setRotated] = useState(false);
  const [pendingVerify, setPendingVerify] = useState<PrngInputs | null>(null);

  const prevAppliedRef = useRef<PrngInputs | null>(null);

  const setPartial = useCallback((patch: Partial<PrngInputs>) => {
    setDraft((d) => ({ ...d, ...patch }));
  }, []);

  const runGenerate = useCallback(
    async (inputs: PrngInputs) => {
      setBusy(true);
      try {
        const out = await generatePrng(
          inputs.serverSeed,
          inputs.clientSeed,
          inputs.startNonce,
          inputs.steps,
        );
        setRows(out);
        onFeedDigits?.(out.map((r) => r.digit));
      } finally {
        setBusy(false);
      }
    },
    [onFeedDigits],
  );

  // Apply → recompute (memoized: only when applied inputs change).
  useEffect(() => {
    void runGenerate(applied);
  }, [applied, runGenerate]);

  // Seed rotation detection: hash change OR nonce reset (→1) OR manual.
  useEffect(() => {
    const prev = prevAppliedRef.current;
    prevAppliedRef.current = applied;
    if (!prev) return;
    const hashChanged = prev.serverSeed !== applied.serverSeed;
    const nonceReset = prev.startNonce > 1 && applied.startNonce === 1;
    if (hashChanged || nonceReset) {
      const entry: SeedHistoryEntry = {
        id: Date.now() + Math.random(),
        ts: Date.now(),
        lastNonce: prev.startNonce + prev.steps - 1,
        retiredHash: prev.serverSeed,
        reason: hashChanged ? "hash-change" : "nonce-reset",
      };
      setHistory((h) => [...h.slice(-9), entry]);
      setRotated(true);
      setPendingVerify(prev);
    }
  }, [applied]);

  const handleGenerate = useCallback(() => {
    setRotated(false);
    setApplied(draft);
  }, [draft]);

  const handleRotateClient = useCallback(() => {
    const nextClient = randomClientSeed();
    const prev = applied;
    setDraft((d) => ({ ...d, clientSeed: nextClient, startNonce: 1 }));
    const nextApplied: PrngInputs = { ...applied, clientSeed: nextClient, startNonce: 1 };
    setHistory((h) => [
      ...h.slice(-9),
      {
        id: Date.now() + Math.random(),
        ts: Date.now(),
        lastNonce: prev.startNonce + prev.steps - 1,
        retiredHash: prev.serverSeed,
        reason: "manual",
      },
    ]);
    setRotated(true);
    setPendingVerify(prev);
    setApplied(nextApplied);
  }, [applied]);

  const handleVerify = useCallback(() => {
    if (!pendingVerify) return;
    setDraft(pendingVerify);
    setApplied(pendingVerify);
    setPendingVerify(null);
    setRotated(false);
  }, [pendingVerify]);

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border bg-card px-3 py-2 text-[11px]">
        <div className="flex items-center justify-between">
          <div className="font-semibold">Deriv PRNG Simulator</div>
          <span
            className={`rounded border px-2 py-0.5 font-mono text-[10px] ${
              rotated
                ? "border-warning bg-warning/10 text-warning"
                : "border-success bg-success/10 text-success"
            }`}
          >
            {rotated ? "● ROTATED / ARCHIVED" : "● ACTIVE"}
          </span>
        </div>
        <div className="mt-1 text-[10px] text-muted-foreground">
          SHA-256(server-client-nonce) → first 8 hex → u32 / 0xFFFFFFFF → decimal ∈ [0,1). Deterministic.
        </div>
      </div>

      <PrngInputForm
        draft={draft}
        onChange={setPartial}
        onGenerate={handleGenerate}
        onRotateClient={handleRotateClient}
        busy={busy}
      />

      <PrngChart rows={rows} />
      <PrngTable rows={rows} />
      <SeedHistoryLog entries={history} onVerify={handleVerify} verifyEnabled={rotated && !!pendingVerify} />
    </div>
  );
}
