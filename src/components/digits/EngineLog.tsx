import { memo } from "react";

interface Props {
  entries: string[];
  coreSpeedMs: number;
  intervalMs: number;
  intervalStdMs: number;
  entropyDecay: number;
  bitmask: number;
}

function fmtMask(m: number): string {
  const bits = m.toString(2).padStart(4, "0");
  const parts: string[] = [];
  if (m & 1) parts.push("RISE/FALL");
  if (m & 2) parts.push("EVEN/ODD");
  if (m & 4) parts.push("OVER/UNDER");
  return `${bits}${parts.length ? " · " + parts.join(" + ") : " · RAW"}`;
}

function EngineLogImpl({
  entries,
  coreSpeedMs,
  intervalMs,
  intervalStdMs,
  entropyDecay,
  bitmask,
}: Props) {
  const speedColor =
    coreSpeedMs <= 2
      ? "text-success"
      : coreSpeedMs <= 5
        ? "text-cyan"
        : "text-danger";
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2 text-[11px]">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold">Engine · Rule Console</span>
        <div className="flex flex-wrap items-center gap-2 font-mono tabular-nums">
          <span className={`rounded border border-input px-1.5 py-0.5 ${speedColor}`}>
            Core Speed: {coreSpeedMs.toFixed(2)}ms
          </span>
          <span className="rounded border border-input px-1.5 py-0.5 text-muted-foreground">
            Δt {intervalMs ? intervalMs.toFixed(0) : "—"}ms ± {intervalStdMs.toFixed(0)}
          </span>
          <span className="rounded border border-input px-1.5 py-0.5 text-muted-foreground">
            Decay {(entropyDecay * 100).toFixed(0)}%
          </span>
          <span className="rounded border border-input px-1.5 py-0.5 text-muted-foreground">
            Mask {fmtMask(bitmask)}
          </span>
        </div>
      </div>
      <div className="max-h-40 overflow-auto rounded bg-background/60 p-1 font-mono text-[10px] leading-tight">
        {entries.length === 0 ? (
          <div className="text-muted-foreground">Awaiting ticks…</div>
        ) : (
          entries
            .slice(-60)
            .reverse()
            .map((e, i) => (
              <div key={i} className="whitespace-pre-wrap text-muted-foreground">
                {e}
              </div>
            ))
        )}
      </div>
    </div>
  );
}

export const EngineLog = memo(EngineLogImpl);
