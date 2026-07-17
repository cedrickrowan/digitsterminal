import { memo, useMemo, useState } from "react";
import type { PrngRow } from "./prngCore";

interface Props {
  rows: PrngRow[];
}

const PAGE_SIZE = 50;

function PrngTableImpl({ rows }: Props) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const p = Math.min(page, pageCount - 1);

  const view = useMemo(() => {
    const start = p * PAGE_SIZE;
    return rows.slice(start, start + PAGE_SIZE);
  }, [rows, p]);

  return (
    <div className="rounded-md border border-border bg-card p-2 text-[11px]">
      <div className="mb-1 flex items-center justify-between px-1">
        <span className="font-semibold">PRNG Table</span>
        <span className="text-muted-foreground font-mono text-[10px]">
          {rows.length} rows · page {p + 1}/{pageCount}
        </span>
      </div>
      <div className="max-h-64 overflow-auto rounded bg-background/60">
        <table className="w-full font-mono text-[10px]">
          <thead className="sticky top-0 bg-card text-muted-foreground">
            <tr>
              <th className="px-2 py-1 text-left">Tick</th>
              <th className="px-2 py-1 text-left">Nonce</th>
              <th className="px-2 py-1 text-left">Hex</th>
              <th className="px-2 py-1 text-right">Decimal</th>
              <th className="px-2 py-1 text-right">Digit</th>
            </tr>
          </thead>
          <tbody>
            {view.map((r) => (
              <tr key={r.tick} className="border-t border-border/40">
                <td className="px-2 py-1">{r.tick}</td>
                <td className="px-2 py-1">{r.nonce}</td>
                <td className="px-2 py-1 text-cyan">{r.hexFrag}</td>
                <td className="px-2 py-1 text-right tabular-nums">{r.decimal.toFixed(6)}</td>
                <td className="px-2 py-1 text-right font-bold text-primary">{r.digit}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pageCount > 1 && (
        <div className="mt-2 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setPage((x) => Math.max(0, x - 1))}
            disabled={p === 0}
            className="rounded border border-input px-2 py-1 text-[10px] disabled:opacity-40"
            style={{ touchAction: "manipulation" }}
          >
            ◀ Prev
          </button>
          <input
            type="range"
            min={0}
            max={pageCount - 1}
            value={p}
            onChange={(e) => setPage(parseInt(e.target.value, 10))}
            className="flex-1"
          />
          <button
            type="button"
            onClick={() => setPage((x) => Math.min(pageCount - 1, x + 1))}
            disabled={p >= pageCount - 1}
            className="rounded border border-input px-2 py-1 text-[10px] disabled:opacity-40"
            style={{ touchAction: "manipulation" }}
          >
            Next ▶
          </button>
        </div>
      )}
    </div>
  );
}

export const PrngTable = memo(PrngTableImpl);
