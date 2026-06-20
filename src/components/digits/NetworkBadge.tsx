import { memo, useEffect, useState } from "react";
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

interface NetInfo {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  online: boolean;
}

function readNetInfo(): NetInfo {
  const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { connection?: { effectiveType?: string; downlink?: number; rtt?: number; addEventListener?: (t: string, l: () => void) => void; removeEventListener?: (t: string, l: () => void) => void } }) : null;
  const c = nav?.connection;
  return {
    effectiveType: c?.effectiveType,
    downlink: c?.downlink,
    rtt: c?.rtt,
    online: typeof navigator !== "undefined" ? navigator.onLine : true,
  };
}

function NetworkBadgeImpl({ health, pingMs, driftMs, ticks, stale }: Props) {
  const [info, setInfo] = useState<NetInfo>(() => readNetInfo());

  useEffect(() => {
    const update = () => setInfo(readNetInfo());
    const nav = navigator as Navigator & { connection?: { addEventListener?: (t: string, l: () => void) => void; removeEventListener?: (t: string, l: () => void) => void } };
    const c = nav.connection;
    c?.addEventListener?.("change", update);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    const id = window.setInterval(update, 5000);
    return () => {
      c?.removeEventListener?.("change", update);
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
      clearInterval(id);
    };
  }, []);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${colorMap[health]}`} />
        <span className="font-mono font-medium">{pingMs > 0 ? `${Math.round(pingMs)}ms` : "—"}</span>
        {!info.online && <span className="text-danger">OFFLINE</span>}
        {stale && <span className="text-danger">STALE</span>}
        {info.effectiveType && (
          <span className="rounded border border-border px-1 py-px text-[10px] uppercase text-muted-foreground">
            {info.effectiveType}
          </span>
        )}
      </div>
      <div className="font-mono text-muted-foreground">
        {info.downlink ? `${info.downlink}↓Mbps · ` : ""}
        {info.rtt ? `dev ${info.rtt}ms · ` : ""}
        drift {Math.round(driftMs)}ms · {ticks} ticks
      </div>
    </div>
  );
}

export const NetworkBadge = memo(NetworkBadgeImpl);
