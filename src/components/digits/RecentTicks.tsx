import { memo } from "react";

function RecentTicksImpl({ digits }: { digits: number[] }) {
  const last = digits.slice(-20);
  return (
    <div className="flex flex-wrap gap-1 rounded-md border border-border bg-card px-2 py-2 font-mono text-xs">
      {last.length === 0 && <span className="text-muted-foreground">awaiting ticks…</span>}
      {last.map((d, i) => (
        <span
          key={i}
          className="inline-flex h-6 w-6 items-center justify-center rounded bg-secondary text-secondary-foreground"
        >
          {d}
        </span>
      ))}
    </div>
  );
}

export const RecentTicks = memo(RecentTicksImpl);
