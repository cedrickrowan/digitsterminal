import { memo } from "react";

interface Props {
  digit: number;
  entryPrice: number | null;
  lastPrice: number | null;
  matched: boolean;
  armed: boolean;
  confidence?: number; // 0..1
  highlight?: boolean; // green flashing when conf >= 0.7 on matches
}

function PredictedDigitImpl({ digit, entryPrice, lastPrice, matched, armed, confidence = 0, highlight = false }: Props) {
  const showGreen = highlight || matched;
  return (
    <div
      className={`flex items-center gap-3 rounded-md border px-3 py-3 transition-colors ${
        showGreen
          ? "border-success bg-success/5 shadow-[0_0_24px_-4px_var(--color-success,theme(colors.green.500))]"
          : "border-border bg-card"
      }`}
    >
      <div className="relative flex h-20 w-20 shrink-0 items-center justify-center">
        <span
          className={`absolute inset-0 rounded-full border-2 opacity-70 ${
            showGreen ? "border-success" : "border-primary"
          }`}
          style={{
            animation: `ping ${highlight ? "0.7s" : armed ? "1.2s" : "2.5s"} cubic-bezier(0,0,0.2,1) infinite`,
          }}
        />
        <span
          className={`absolute inset-2 rounded-full border ${
            showGreen ? "border-success/80" : "border-primary/70"
          }`}
          style={highlight ? { animation: "pulse 0.6s ease-in-out infinite" } : undefined}
        />
        <span
          className={`relative flex h-14 w-14 items-center justify-center rounded-full text-3xl font-extrabold tabular-nums ${
            showGreen
              ? "bg-success text-primary-foreground shadow-[0_0_18px_var(--color-success,theme(colors.green.500))]"
              : "bg-primary text-primary-foreground"
          }`}
          style={highlight ? { animation: "pulse 0.6s ease-in-out infinite" } : undefined}
        >
          {digit}
        </span>
      </div>
      <div className="min-w-0 flex-1 text-xs">
        <div className="text-muted-foreground flex items-center justify-between">
          <span>Predicted digit</span>
          {confidence > 0 && (
            <span className={`font-mono tabular-nums ${highlight ? "text-success" : "text-cyan"}`}>
              {(confidence * 100).toFixed(1)}%
            </span>
          )}
        </div>
        <div className="mt-0.5 font-mono tabular-nums">
          Entry: <span className="font-semibold">{entryPrice != null ? entryPrice : "—"}</span>
        </div>
        <div className="font-mono tabular-nums">
          Last: <span className="font-semibold">{lastPrice != null ? lastPrice : "—"}</span>
        </div>
        <div className={`mt-1 font-semibold ${showGreen ? "text-success" : "text-muted-foreground"}`}>
          {highlight
            ? "HIGH CONFIDENCE · ENTRY ZONE"
            : entryPrice == null
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
