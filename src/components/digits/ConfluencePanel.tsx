import { memo } from "react";
import type { Confluence } from "@/lib/deriv/stats";

interface Props {
  conf: Confluence;
  velocity: number;
  prngZ: number;
  prngShift: boolean;
}

function ConfluencePanelImpl({ conf, velocity, prngZ, prngShift }: Props) {
  return (
    <div className="space-y-2 rounded-lg border border-cyan/40 bg-card px-3 py-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-widest text-cyan">
          Confluence matrix
        </span>
        <span
          className={`rounded px-2 py-0.5 text-[10px] font-mono ${
            prngShift
              ? "border border-danger text-danger"
              : "border border-border text-muted-foreground"
          }`}
        >
          PRNG Z {prngZ.toFixed(2)}
          {prngShift ? " · FLUSH" : ""}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1 text-[11px] font-mono">
        {conf.labels.map((l, i) => (
          <span
            key={i}
            className="rounded border border-cyan/50 bg-cyan/10 px-1.5 py-0.5 text-cyan"
          >
            {l}
          </span>
        ))}
        <span className="text-muted-foreground">→</span>
        <span className="rounded border border-magenta/50 bg-magenta/10 px-1.5 py-0.5 text-magenta">
          {conf.subgroup.length ? conf.subgroup.join(" · ") : "—"}
        </span>
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground tabular-nums">
        <span>Joint strength: <span className="text-foreground">{(conf.strength * 100).toFixed(1)}%</span></span>
        <span>Velocity: <span className="text-foreground">{(velocity * 100).toFixed(0)}%</span></span>
      </div>
    </div>
  );
}

export const ConfluencePanel = memo(ConfluencePanelImpl);
