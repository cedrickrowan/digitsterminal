import { memo } from "react";

interface Props {
  digit: number;
  entryPrice: number | null;
  lastPrice: number | null;
  matched: boolean;
  armed: boolean;
}

function PredictedDigitImpl({ digit, entryPrice, lastPrice, matched, armed }: Props) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-3">
      <div className="relative flex h-20 w-20 shrink-0 items-center justify-center">
        {/* Pulsing rings */}
        <span
          className={`absolute inset-0 rounded-full border-2 ${
            matched ? "border-success" : "border-primary"
          } opacity-60 animate-ping`}
          style={{ animationDuration: armed ? "1.2s" : "2.5s" }}
        />
        <span
          className={`absolute inset-2 rounded-full border ${
            matched ? "border-success/70" : "border-primary/70"
          }`}
        />
        <span
          className={`relative flex h-14 w-14 items-center justify-center rounded-full text-3xl font-extrabold tabular-nums ${
            matched
              ? "bg-success text-primary-foreground"
              : "bg-primary text-primary-foreground"
          }`}
        >
          {digit}
        </span>
      </div>
      <div className="min-w-0 flex-1 text-xs">
        <div className="text-muted-foreground">Predicted digit (DIGITMATCH)</div>
        <div className="mt-0.5 font-mono tabular-nums">
          Entry: <span className="font-semibold">{entryPrice != null ? entryPrice : "—"}</span>
        </div>
        <div className="font-mono tabular-nums">
          Last: <span className="font-semibold">{lastPrice != null ? lastPrice : "—"}</span>
        </div>
        <div className={`mt-1 font-semibold ${matched ? "text-success" : "text-muted-foreground"}`}>
          {entryPrice == null
            ? armed
              ? "Armed · waiting for trigger…"
              : "Idle"
            : matched
              ? "MATCH ✓"
              : "Open · awaiting resolution"}
        </div>
      </div>
    </div>
  );
}

export const PredictedDigit = memo(PredictedDigitImpl);
