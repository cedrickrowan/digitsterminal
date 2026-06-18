import { memo } from "react";

interface Item { pattern: string; count: number }

interface Props {
  bigrams: Item[];
  trigrams: Item[];
  chiUnif: number;
  chiIndep: number;
  hZ20: number;
  hZ50: number;
  bias: number;
}

function List({ title, items }: { title: string; items: Item[] }) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-widest text-cyan">{title}</div>
      <div className="grid grid-cols-5 gap-1">
        {items.map((it) => (
          <div
            key={it.pattern}
            className="flex flex-col items-center rounded border border-cyan/30 bg-background/60 py-1 font-mono text-[11px]"
          >
            <span className="text-cyan">{it.pattern}</span>
            <span className="text-muted-foreground tabular-nums">×{it.count}</span>
          </div>
        ))}
        {items.length === 0 && <span className="col-span-5 text-[10px] text-muted-foreground">no data</span>}
      </div>
    </div>
  );
}

function PatternsPanelImpl(p: Props) {
  return (
    <div className="space-y-2 rounded-lg border border-border bg-card px-3 py-2">
      <List title="Top bigrams" items={p.bigrams} />
      <List title="Top trigrams" items={p.trigrams} />
      <div className="grid grid-cols-2 gap-1 border-t border-border pt-2 text-[10px] font-mono tabular-nums">
        <div>χ² uniform: <span className="text-cyan">{p.chiUnif.toFixed(1)}</span></div>
        <div>χ² indep: <span className="text-cyan">{p.chiIndep.toFixed(1)}</span></div>
        <div>Z(H₂₀): <span className={p.hZ20 < -1.96 ? "text-magenta" : "text-cyan"}>{p.hZ20.toFixed(2)}</span></div>
        <div>Z(H₅₀): <span className={p.hZ50 < -1.96 ? "text-magenta" : "text-cyan"}>{p.hZ50.toFixed(2)}</span></div>
        <div className="col-span-2">Bias index: <span className="text-cyan">{(p.bias * 100).toFixed(1)}%</span></div>
      </div>
    </div>
  );
}

export const PatternsPanel = memo(PatternsPanelImpl);
