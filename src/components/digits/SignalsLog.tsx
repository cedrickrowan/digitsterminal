import { memo } from "react";
import type { Signal } from "@/lib/deriv/types";

function SignalsLogImpl({ signals }: { signals: Signal[] }) {
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2 text-xs">
      <div className="mb-1 font-semibold">Signals</div>
      {signals.length === 0 && <div className="text-muted-foreground">No signals yet.</div>}
      <ul className="space-y-1">
        {signals.slice(-8).reverse().map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-2">
            <span className="truncate">
              <span className="text-muted-foreground">
                {new Date(s.ts).toLocaleTimeString()}
              </span>{" "}
              · {s.reason} · pred {s.predicted}
            </span>
            <span
              className={
                s.result === "win"
                  ? "shrink-0 font-semibold text-success"
                  : s.result === "loss"
                    ? "shrink-0 font-semibold text-danger"
                    : "shrink-0 text-muted-foreground"
              }
            >
              {s.result ? s.result.toUpperCase() : s.mode}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export const SignalsLog = memo(SignalsLogImpl);
