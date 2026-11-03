import { memo } from "react";

interface Props {
  freq: number[];
  total: number;
  /** Newest tick digit (null = none yet) — gets the new-tick pulse ring. */
  lastDigit: number | null;
}

/** Deriv-style circular digit frequency badges: one ring per digit 0-9,
 *  showing the live percentage over the active lookback window. The most
 *  recent tick pulses so the user can see the new arrival instantly. */
function DigitBadgesImpl({ freq, total, lastDigit }: Props) {
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-widest text-cyan">Digit frequency · lookback</span>
        <span className="font-mono text-[10px] text-muted-foreground">{total} ticks</span>
      </div>
      <div className="grid grid-cols-10 gap-1">
        {freq.map((c, d) => {
          const pct = total ? (c / total) * 100 : 0;
          const isLast = d === lastDigit;
          // Alpha tracks deviation from the uniform 10% baseline.
          const alpha = Math.min(0.75, 0.08 + (Math.abs(pct - 10) / 10) * 0.7);
          return (
            <div key={d} className="flex min-w-0 flex-col items-center">
              <div
                className={`relative flex h-9 w-9 items-center justify-center rounded-full border font-mono text-[11px] font-bold tabular-nums ${
                  isLast ? "border-cyan text-cyan" : "border-border text-foreground"
                }`}
                style={{ backgroundColor: `hsl(var(--primary-hsl) / ${alpha})` }}
              >
                {isLast && <span className="absolute inset-0 animate-ping rounded-full border border-cyan opacity-40" />}
                {pct.toFixed(0)}
              </div>
              <span className="mt-0.5 text-[10px] leading-none text-muted-foreground">{d}</span>
            </div>
          );
        })}
      </div>
      <div className="mt-1 text-right font-mono text-[9px] text-muted-foreground">rings show % of lookback</div>
    </div>
  );
}

export const DigitBadges = memo(DigitBadgesImpl);
