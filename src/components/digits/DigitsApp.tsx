import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DerivClient } from "@/lib/deriv/derivClient";
import { loadConfig, saveConfig } from "@/lib/deriv/storage";
import type { AppConfig, NetHealth, Signal } from "@/lib/deriv/types";
import {
  chiSquaredUniform,
  coldProb,
  frequencies,
  gapsSinceLast,
  shannonEntropy,
  tailStreak,
  twoTickFollowups,
} from "@/lib/deriv/stats";
import { beep } from "@/lib/deriv/audio";
import { NetworkBadge } from "./NetworkBadge";
import { Controls } from "./Controls";
import { DigitGrid } from "./DigitGrid";
import { RecentTicks } from "./RecentTicks";
import { StatsPanel } from "./StatsPanel";
import { SignalsLog } from "./SignalsLog";

const MAX_BUFFER = 500;
const STALE_GAP_MS = 800;
const SAFE_PING_MS = 500;

export default function DigitsApp() {
  const [cfg, setCfg] = useState<AppConfig>(() => loadConfig());
  const [connected, setConnected] = useState(false);
  const [armed, setArmed] = useState(false);
  const [flash, setFlash] = useState(false);
  const [pingMs, setPingMs] = useState(0);
  const [driftMs, setDriftMs] = useState(0);
  const [stale, setStale] = useState(false);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [, forceRender] = useState(0);

  // Hot data refs (avoid re-render thrash on every tick)
  const bufRef = useRef<number[]>([]);
  const lastArrivalRef = useRef<number>(0);
  const totalTicksRef = useRef(0);
  const pingMedianRef = useRef<number[]>([]);
  const clientRef = useRef<DerivClient | null>(null);
  const cfgRef = useRef(cfg);
  const armedRef = useRef(armed);
  const authedRef = useRef(false);
  const pendingSimRef = useRef<Array<{ id: number; tickIndex: number; predicted: number }>>([]);
  const lastSignalTickRef = useRef(-100);
  const renderScheduled = useRef(false);

  useEffect(() => { cfgRef.current = cfg; saveConfig(cfg); }, [cfg]);
  useEffect(() => { armedRef.current = armed; }, [armed]);

  const scheduleRender = useCallback(() => {
    if (renderScheduled.current) return;
    renderScheduled.current = true;
    setTimeout(() => {
      renderScheduled.current = false;
      forceRender((x) => (x + 1) & 0x3fffffff);
    }, 100);
  }, []);

  const evaluateAndMaybeFire = useCallback(() => {
    const buf = bufRef.current;
    const cfgNow = cfgRef.current;
    const win = buf.slice(-cfgNow.lookback);
    if (win.length < Math.min(10, cfgNow.lookback)) return;
    const freq = frequencies(win);
    const pPredict = freq[cfgNow.predictDigit] / win.length;
    const { digit: tailD, len: tailLen } = tailStreak(win);
    const streakMatch = tailD === cfgNow.predictDigit && tailLen >= cfgNow.triggerStreak;
    const probMatch = pPredict * 100 < cfgNow.triggerProbBelow;
    if (!streakMatch && !probMatch) return;

    // Debounce: at least 3 ticks between signals
    if (totalTicksRef.current - lastSignalTickRef.current < 3) return;
    lastSignalTickRef.current = totalTicksRef.current;

    const reasons: string[] = [];
    if (streakMatch) reasons.push(`streak ${tailLen}×${tailD}`);
    if (probMatch) reasons.push(`p=${(pPredict * 100).toFixed(1)}%`);
    const reason = reasons.join(" · ");

    const sig: Signal = {
      id: Date.now() + Math.random(),
      ts: Date.now(),
      reason,
      predicted: cfgNow.predictDigit,
      mode: cfgNow.mode,
    };

    if (!armedRef.current) {
      // Still log as info
      pushSignal(sig);
      return;
    }

    // Network safety filter for live & simulated execution
    const median = medianOf(pingMedianRef.current);
    const lastGap = lastArrivalRef.current
      ? performance.now() - lastArrivalRef.current
      : 0;
    const networkUnsafe = median > SAFE_PING_MS || lastGap > STALE_GAP_MS;

    if (cfgNow.mode === "alert") {
      beep();
      setFlash(true);
      setTimeout(() => setFlash(false), 180);
      pushSignal(sig);
      return;
    }

    if (networkUnsafe) {
      pushSignal({ ...sig, reason: reason + " (aborted: net)" });
      return;
    }

    if (cfgNow.mode === "simulated") {
      pendingSimRef.current.push({
        id: sig.id,
        tickIndex: totalTicksRef.current + cfgNow.duration,
        predicted: cfgNow.predictDigit,
      });
      pushSignal(sig);
    } else if (cfgNow.mode === "live") {
      const c = clientRef.current;
      if (!c || !authedRef.current) {
        pushSignal({ ...sig, reason: reason + " (no auth)" });
        return;
      }
      setTimeout(() => {
        c.buyDigitMatches({
          symbol: cfgNow.symbol,
          duration: cfgNow.duration,
          stake: cfgNow.stake,
          barrier: cfgNow.predictDigit,
        });
      }, Math.max(0, cfgNow.latencyOffsetMs - 1000));
      pushSignal(sig);
    }
  }, []);

  const pushSignal = useCallback((s: Signal) => {
    setSignals((prev) => [...prev.slice(-40), s]);
  }, []);

  const resolveSims = useCallback((latestDigit: number) => {
    const idx = totalTicksRef.current;
    const remaining: typeof pendingSimRef.current = [];
    const resolved: Array<{ id: number; result: "win" | "loss" }> = [];
    for (const p of pendingSimRef.current) {
      if (idx >= p.tickIndex) {
        resolved.push({ id: p.id, result: latestDigit === p.predicted ? "win" : "loss" });
      } else {
        remaining.push(p);
      }
    }
    pendingSimRef.current = remaining;
    if (resolved.length) {
      setSignals((prev) =>
        prev.map((s) => {
          const r = resolved.find((x) => x.id === s.id);
          return r ? { ...s, resolvedDigit: latestDigit, result: r.result } : s;
        }),
      );
    }
  }, []);

  const handleConnect = useCallback(() => {
    const client = new DerivClient({
      onOpen: () => {
        setConnected(true);
        authedRef.current = false;
        client.subscribeTicks(cfgRef.current.symbol, 100);
        if (cfgRef.current.mode === "live" && cfgRef.current.token) {
          client.authorize(cfgRef.current.token, (msg) => {
            authedRef.current = !msg.error;
          });
        }
      },
      onClose: () => setConnected(false),
      onHistory: (digits) => {
        bufRef.current = digits.slice(-MAX_BUFFER);
        totalTicksRef.current = bufRef.current.length;
        scheduleRender();
      },
      onTick: (digit, _q, _e, arrival) => {
        const prev = lastArrivalRef.current;
        const gap = prev ? arrival - prev : 0;
        lastArrivalRef.current = arrival;
        const isStale = prev !== 0 && gap > STALE_GAP_MS;
        setStale(isStale);
        const b = bufRef.current;
        b.push(digit);
        if (b.length > MAX_BUFFER) b.splice(0, b.length - MAX_BUFFER);
        totalTicksRef.current++;
        resolveSims(digit);
        if (!isStale) evaluateAndMaybeFire();
        scheduleRender();
      },
      onPing: (rtt) => {
        const arr = pingMedianRef.current;
        arr.push(rtt);
        if (arr.length > 10) arr.shift();
        setPingMs(medianOf(arr));
      },
      onTimeSync: (drift) => setDriftMs(drift),
      onBuy: (msg) => {
        const ok = !msg.error;
        pushSignal({
          id: Date.now() + Math.random(),
          ts: Date.now(),
          reason: ok ? `LIVE buy id=${msg.buy?.contract_id}` : `LIVE error: ${msg.error?.message}`,
          predicted: cfgRef.current.predictDigit,
          mode: "live",
        });
      },
      onError: (e) => {
        pushSignal({
          id: Date.now() + Math.random(),
          ts: Date.now(),
          reason: `err: ${e}`,
          predicted: cfgRef.current.predictDigit,
          mode: cfgRef.current.mode,
        });
      },
    });
    clientRef.current = client;
    client.connect();
  }, [evaluateAndMaybeFire, pushSignal, resolveSims, scheduleRender]);

  const handleDisconnect = useCallback(() => {
    clientRef.current?.disconnect();
    clientRef.current = null;
    setConnected(false);
    authedRef.current = false;
  }, []);

  // Resubscribe when symbol changes while connected
  useEffect(() => {
    if (!connected || !clientRef.current) return;
    bufRef.current = [];
    lastArrivalRef.current = 0;
    totalTicksRef.current = 0;
    clientRef.current.subscribeTicks(cfg.symbol, 100);
  }, [cfg.symbol, connected]);

  useEffect(() => () => clientRef.current?.disconnect(), []);

  // Derived stats (recomputed on render, throttled by scheduleRender)
  const buf = bufRef.current;
  const win = buf.slice(-cfg.lookback);
  const freq = useMemo(() => frequencies(win), [win.length, totalTicksRef.current]);
  const win20 = buf.slice(-20);
  const win50 = buf.slice(-50);
  const win100 = buf.slice(-100);
  const chi = chiSquaredUniform(frequencies(win100), win100.length);
  const h20 = shannonEntropy(frequencies(win20), win20.length);
  const h50 = shannonEntropy(frequencies(win50), win50.length);
  const h100 = shannonEntropy(frequencies(win100), win100.length);
  const gaps = gapsSinceLast(win);
  let coldDigit = 0;
  for (let i = 1; i < 10; i++) if (gaps[i] > gaps[coldDigit]) coldDigit = i;
  const coldGap = gaps[coldDigit];

  const followPrefix: [number, number] | null =
    buf.length >= 2 ? [buf[buf.length - 2], buf[buf.length - 1]] : null;
  const follow = followPrefix
    ? twoTickFollowups(win, followPrefix[0], followPrefix[1])
    : { probs: new Array(10).fill(0), total: 0, counts: [] };

  const health: NetHealth =
    pingMs === 0
      ? "yellow"
      : pingMs > SAFE_PING_MS
        ? "red"
        : pingMs > 250
          ? "yellow"
          : "green";

  const setPartial = useCallback((patch: Partial<AppConfig>) => {
    setCfg((c) => ({ ...c, ...patch }));
  }, []);

  return (
    <div className={`min-h-screen bg-background p-3 text-foreground ${flash ? "ring-4 ring-danger" : ""}`}>
      <header className="mb-3">
        <h1 className="text-base font-bold">Deriv Digits · Matches</h1>
        <p className="text-[11px] text-muted-foreground">
          Mobile-optimized analysis. Trade only what you can lose.
        </p>
      </header>

      <div className="space-y-3">
        <NetworkBadge health={health} pingMs={pingMs} driftMs={driftMs} ticks={totalTicksRef.current} stale={stale} />
        <Controls
          cfg={cfg}
          onChange={setPartial}
          connected={connected}
          onConnect={handleConnect}
          onDisconnect={handleDisconnect}
          armed={armed}
          onToggleArm={() => setArmed((a) => !a)}
        />
        <DigitGrid freq={freq} total={win.length} predict={cfg.predictDigit} />
        <RecentTicks digits={buf} />
        <StatsPanel
          chi={chi}
          h20={h20}
          h50={h50}
          h100={h100}
          coldDigit={coldDigit}
          coldGap={coldGap}
          coldProb={coldProb(coldGap)}
          followPrefix={followPrefix}
          followProbs={follow.probs}
          followTotal={follow.total}
        />
        <SignalsLog signals={signals} />
        <footer className="pb-6 text-center text-[10px] text-muted-foreground">
          Public app_id 1089 · token stays on device · not financial advice
        </footer>
      </div>
    </div>
  );
}

function medianOf(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
