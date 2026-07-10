import { memo, useMemo } from "react";
import type { PrngRow } from "./prngCore";

interface Props {
  rows: PrngRow[];
}

const W = 600;
const H = 140;
const PAD = 4;

function PrngChartImpl({ rows }: Props) {
  const path = useMemo(() => {
    if (rows.length === 0) return "";
    const n = rows.length;
    const stepX = (W - PAD * 2) / Math.max(1, n - 1);
    let d = "";
    for (let i = 0; i < n; i++) {
      const x = PAD + i * stepX;
      const y = PAD + (1 - rows[i].decimal) * (H - PAD * 2);
      d += (i === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1) + " ";
    }
    return d;
  }, [rows]);

  return (
    <div className="rounded-md border border-border bg-card p-2 text-[11px]">
      <div className="mb-1 flex items-center justify-between px-1">
        <span className="font-semibold">PRNG Decimal Stream</span>
        <span className="text-muted-foreground font-mono text-[10px]">y ∈ [0,1] · n={rows.length}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-32 w-full">
        <line x1={PAD} y1={H / 2} x2={W - PAD} y2={H / 2} stroke="hsl(var(--primary-hsl) / 0.15)" strokeDasharray="2 3" />
        <path d={path} fill="none" stroke="hsl(var(--primary-hsl) / 0.95)" strokeWidth={1.2} />
      </svg>
    </div>
  );
}

export const PrngChart = memo(PrngChartImpl);
