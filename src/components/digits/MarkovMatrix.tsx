import { memo } from "react";

interface Props {
  matrix: number[][]; // 10x10 probs
  lastDigit: number;
  predict: number;
}

function MarkovMatrixImpl({ matrix, lastDigit, predict }: Props) {
  return (
    <div className="rounded-md border border-border bg-card px-2 py-2 text-[10px]">
      <div className="mb-1 flex items-center justify-between px-1 text-xs">
        <span className="font-semibold">Markov 1-step P(next | prev)</span>
        <span className="text-muted-foreground">row=prev · col=next</span>
      </div>
      <div className="grid grid-cols-11 gap-[2px] font-mono tabular-nums">
        <div />
        {Array.from({ length: 10 }, (_, c) => (
          <div
            key={`h-${c}`}
            className={`text-center ${c === predict ? "text-primary font-bold" : "text-muted-foreground"}`}
          >
            {c}
          </div>
        ))}
        {matrix.map((row, r) => (
          <Row key={r} r={r} row={row} highlightRow={r === lastDigit} predict={predict} />
        ))}
      </div>
    </div>
  );
}

function RowImpl({
  r,
  row,
  highlightRow,
  predict,
}: {
  r: number;
  row: number[];
  highlightRow: boolean;
  predict: number;
}) {
  return (
    <>
      <div
        className={`text-center ${
          highlightRow ? "text-primary font-bold" : "text-muted-foreground"
        }`}
      >
        {r}
      </div>
      {row.map((p, c) => {
        const alpha = Math.min(0.85, p * 2.5);
        const focus = highlightRow && c === predict;
        return (
          <div
            key={c}
            className={`flex items-center justify-center rounded-sm py-0.5 ${
              focus ? "ring-1 ring-primary" : ""
            }`}
            style={{ backgroundColor: `hsl(var(--primary-hsl) / ${alpha})` }}
          >
            {p > 0 ? Math.round(p * 100) : ""}
          </div>
        );
      })}
    </>
  );
}
const Row = memo(RowImpl);

export const MarkovMatrix = memo(MarkovMatrixImpl);
