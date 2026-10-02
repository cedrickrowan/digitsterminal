import { memo } from "react";
import type { DualBufferReport } from "@/lib/deriv/dualBuffer";

function DualBufferPanelImpl({ r, tape }: { r: DualBufferReport; tape: number[] }) {
  const max = Math.max(0.2, ...r.fastFreq, ...r.slowFreq);
  return (
    <div className="space-y-2 rounded-md border border-border bg-card px-2 py-2 text-[11px]">
      <div className="flex items-center justify-between px-1">
        <span className="font-semibold">Stride-3 Lattice · Dual Buffer</span>
        <span className="font-mono text-[10px] text-muted-foreground">
          fast {r.fastLen} · slow {r.slowLen} · var {r.slowVariance.toFixed(2)}
        </span>
      </div>

      <div className="grid grid-cols-4 gap-1">
        {r.lattice.length === 0 && (
          <div className="col-span-4 text-center text-muted-foreground">buffering…</div>
        )}
        {r.lattice.map((p) => (
          <div
            key={p.step}
            className={`rounded-sm border px-1 py-1 text-center ${
              p.role === "entry" ? "border-success ring-1 ring-success" : "border-input"
            }`}
          >
            <div className="font-mono text-[10px] text-muted-foreground">
              t+{p.step} {p.role === "entry" ? "entry" : "run"}
            </div>
            <div className="font-mono text-base font-bold">{p.topDigit}</div>
            <div className="font-mono text-[10px]">{(p.topProb * 100).toFixed(1)}%</div>
          </div>
        ))}
      </div>

      <div>
        <div className="mb-1 px-1 text-[10px] uppercase tracking-wider text-muted-foreground">
          Fast (cyan) vs slow baseline (grey) · |z| max digit {r.maxAnomalyDigit} (
          {r.anomalyZ[r.maxAnomalyDigit]?.toFixed(1)}) · streak {r.streakDigit}×{r.streakLen}
        </div>
        <div className="grid grid-cols-10 gap-1">
          {r.fastFreq.map((f, d) => (
            <div key={d} className="flex flex-col items-center">
              <div className="flex h-12 items-end gap-px">
                <div className="w-1.5 bg-cyan" style={{ height: `${(f / max) * 100}%` }} />
                <div className="w-1.5 bg-muted-foreground" style={{ height: `${(r.slowFreq[d] / max) * 100}%` }} />
              </div>
              <span className={`font-mono text-[10px] ${Math.abs(r.anomalyZ[d]) >= 2 ? "text-warning" : ""}`}>
                {d}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-0.5 font-mono text-[10px]">
        {tape.map((d, i) => (
          <span
            key={i}
            className={`inline-flex h-4 w-4 items-center justify-center rounded-sm ${
              i >= tape.length - r.fastLen ? "bg-secondary text-secondary-foreground" : "text-muted-foreground"
            }`}
          >
            {d}
          </span>
        ))}
      </div>
    </div>
  );
}

export const DualBufferPanel = memo(DualBufferPanelImpl);
