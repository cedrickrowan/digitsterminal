import { memo } from "react";
import type { NetHealth } from "@/lib/deriv/types";

interface Props {
  health: NetHealth;
  pingMs: number;
  driftMs: number;
  ticks: number;
  stale: boolean;
}

const colorMap: Record<NetHealth, string> = {
  green: "bg-success",
  yellow: "bg-warning",
  red: "bg-danger",
};

function NetworkBadgeImpl({ health, pingMs, driftMs, ticks, stale }: Props) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${colorMap[health]}`} />
        <span className="font-medium">{pingMs > 0 ? `${Math.round(pingMs)}ms` : "—"}</span>
        {stale && <span className="text-danger">STALE</span>}
      </div>
      <div className="text-muted-foreground">drift {Math.round(driftMs)}ms · {ticks} ticks</div>
    </div>
  );
}

export const NetworkBadge = memo(NetworkBadgeImpl);
