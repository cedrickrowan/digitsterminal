import { memo } from "react";

interface Props {
  freq: number[];
  total: number;
  predict: number;
}

function Cell({ d, pct, isPredict }: { d: number; pct: number; isPredict: boolean }) {
  // Alpha based on deviation from uniform 10%. Strong color = stronger skew.
  const dev = Math.abs(pct - 10) / 10; // 0..>1
  const alpha = Math.min(0.85, 0.1 + dev * 0.8);
  return (
    <div
      className={`flex flex-col items-center justify-center rounded-md border py-2 ${
        isPredict ? "border-primary" : "border-border"
      }`}
      style={{ backgroundColor: `hsl(var(--primary-hsl) / ${alpha})` }}
    >
      <span className="text-lg font-bold leading-none">{d}</span>
      <span className="mt-0.5 text-[10px] tabular-nums text-foreground/90">{pct.toFixed(1)}%</span>
    </div>
  );
}

const CellMemo = memo(Cell);

function DigitGridImpl({ freq, total, predict }: Props) {
  return (
    <div className="grid grid-cols-5 gap-1.5">
      {freq.map((c, d) => (
        <CellMemo key={d} d={d} pct={total ? (c / total) * 100 : 0} isPredict={d === predict} />
      ))}
    </div>
  );
}

export const DigitGrid = memo(DigitGridImpl);
