import { memo, useEffect, useState } from "react";
import type { NetHealth } from "@/lib/deriv/types";
import { NET_GUARD, type NetGuardState } from "@/lib/deriv/netGuard";

interface Props {
  health: NetHealth;
  pingMs: number;
  driftMs: number;
  ticks: number;
  stale: boolean;
  guard?: NetGuardState & { safe: boolean };
}

const colorMap: Record<NetHealth, string> = {
  green: "bg-success",
  yellow: "bg-warning",
  red: "bg-danger",
};

function NetworkBadgeImpl({ health, pingMs, driftMs, ticks, stale, guard }: Props) {
  // 1s ticker so lockout countdown re-renders live.
  const [, setNow] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setNow((n) => (n + 1) & 0x3fffffff), 1000);
    return () => clearInterval(id);
  }, []);

  const now = Date.now();
  const locked = guard && now < guard.lockedUntil;
  const lockedSecs = locked ? Math.ceil((guard!.lockedUntil - now) / 1000) : 0;
  const warnCount = guard && !locked ? Math.floor(guard.counter) : 0;

  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${colorMap[health]}`} />
        <span className="font-medium">{pingMs > 0 ? `${Math.round(pingMs)}ms` : "—"}</span>
        {stale && <span className="text-danger">STALE</span>}
        {locked && (
          <span className="rounded border border-danger px-1.5 py-0.5 text-[10px] font-mono text-danger">
            UNSAFE · {guard!.reason ?? "NET"} · {lockedSecs}s
          </span>
        )}
        {!locked && warnCount > 0 && (
          <span className="rounded border border-warning px-1.5 py-0.5 text-[10px] font-mono text-warning">
            ⚠ {warnCount}/{NET_GUARD.ANOMALY_LIMIT}
          </span>
        )}
      </div>
      <div className="text-muted-foreground">drift {Math.round(driftMs)}ms · {ticks} ticks</div>
    </div>
  );
}

export const NetworkBadge = memo(NetworkBadgeImpl);
