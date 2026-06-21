import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DerivClient, type AuthInfo, type ContractType } from "@/lib/deriv/derivClient";
import { loadConfig, loadToken, saveConfig, saveToken } from "@/lib/deriv/storage";
import type { AppConfig, NetHealth, Signal } from "@/lib/deriv/types";
import {
  biasIndex,
  chiSquaredIndependence,
  chiSquaredUniform,
  coldProb,
  ensemblePredict,
  entropyZ,
  frequencies,
  gapsSinceLast,
  hotCold,
  markov1,
  riseFall,
  shannonEntropy,
  splitStats,
  topNgrams,
  twoTickFollowups,
} from "@/lib/deriv/stats";
import { evaluateRules } from "@/lib/deriv/triggers";
import { beep } from "@/lib/deriv/audio";
import { signOut } from "./LoginScreen";
import { NetworkBadge } from "./NetworkBadge";
import { Controls } from "./Controls";
import { DigitGrid } from "./DigitGrid";
import { RecentTicks } from "./RecentTicks";
import { StatsPanel } from "./StatsPanel";
import { SignalsLog } from "./SignalsLog";
import { PredictedDigit } from "./PredictedDigit";
import { MarkovMatrix } from "./MarkovMatrix";
import { EnsemblePanel } from "./EnsemblePanel";
import { SplitPanel } from "./SplitPanel";
import { PatternsPanel } from "./PatternsPanel";
import { TokenConnector } from "./TokenConnector";
import { TradeConsole } from "./TradeConsole";

const MAX_BUFFER = 500;

export default function DigitsApp() {
  const [cfg, setCfg] = useState<AppConfig>(() => loadConfig());
  const [connected, setConnected] = useState(false);
  const [armed, setArmed] = useState(false);
  const [flash, setFlash] = useState(false);
  const [pingMs, setPingMs] = useState(0);
  const [driftMs, setDriftMs] = useState(0);
  const [stale, setStale] = useState(false);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [lastPrice, setLastPrice] = useState<number | null>(null);
  const [openEntry, setOpenEntry] = useState<{ price: number; tick: number } | null>(null);
  const [matched, setMatched] = useState(false);
  const [, forceRender] = useState(0);
  const [token, setToken] = useState<string>(() => loadToken());
  const [auth, setAuth] = useState<AuthInfo | null>(null);
  const [buyBusy, setBuyBusy] = useState(false);
  const [lastBuyResult, setLastBuyResult] = useState<string>("");

  const bufRef = useRef<number[]>([]);
  const lastArrivalRef = useRef<number>(0);
  const totalTicksRef = useRef(0);
  const lastPriceRef = useRef<number>(0);
  const pingMedianRef = useRef<number[]>([]);
  const gapsRef = useRef<number[]>([]); // inter-tick gaps for interval estimate
  const clientRef = useRef<DerivClient | null>(null);
  const cfgRef = useRef(cfg);
  const armedRef = useRef(armed);
  const pendingSimRef = useRef<Array<{ id: number; tickIndex: number; predicted: number; entryPrice: number }>>([]);
  const lastSignalTickRef = useRef(-100);
  const renderScheduled = useRef(false);
  // ticker for countdown updates
  const [tick, setTick] = useState(0);

  useEffect(() => { cfgRef.current = cfg; saveConfig(cfg); }, [cfg]);
  useEffect(() => { armedRef.current = armed; }, [armed]);

  // Countdown ticker @ 5fps — light, only updates a single number/bar.
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => (t + 1) & 0x3fffffff), 200);
    return () => clearInterval(id);
  }, []);

  const scheduleRender = useCallback(() => {
    if (renderScheduled.current) return;
    renderScheduled.current = true;
    setTimeout(() => {
      renderScheduled.current = false;
      forceRender((x) => (x + 1) & 0x3fffffff);
    }, 120);
  }, []);

  const pushSignal = useCallback((s: Signal) => {
    setSignals((prev) => [...prev.slice(-40), s]);
  }, []);

  const evaluateAndMaybeFire = useCallback(() => {
    const buf = bufRef.current;
    const cfgNow = cfgRef.current;
    const win = buf.slice(-cfgNow.lookback);
    if (win.length < 10) return;

    const hits = evaluateRules({ window: win, cfg: cfgNow });
    if (hits.length === 0) return;

    if (totalTicksRef.current - lastSignalTickRef.current < 3) return;
    lastSignalTickRef.current = totalTicksRef.current;

    const reason = hits.map((h) => `${h.rule}:${h.detail}`).join(" · ");
    const sig: Signal = {
      id: Date.now() + Math.random(),
      ts: Date.now(),
      reason,
      predicted: cfgNow.predictDigit,
      market: cfgNow.market,
      mode: cfgNow.mode,
    };

    if (!armedRef.current) {
      pushSignal(sig);
      return;
    }

    const median = medianOf(pingMedianRef.current);
    const lastGap = lastArrivalRef.current ? performance.now() - lastArrivalRef.current : 0;
    const networkUnsafe = median > cfgNow.safePingMs || lastGap > cfgNow.safeGapMs;

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

    const entryPrice = lastPriceRef.current;
    pendingSimRef.current.push({
      id: sig.id,
      tickIndex: totalTicksRef.current + cfgNow.duration,
      predicted: cfgNow.predictDigit,
      entryPrice,
    });
    setOpenEntry({ price: entryPrice, tick: totalTicksRef.current });
    setMatched(false);
    pushSignal({ ...sig, entryPrice, entryTick: totalTicksRef.current });
  }, [pushSignal]);

  const resolveSims = useCallback((latestDigit: number) => {
    const idx = totalTicksRef.current;
    const remaining: typeof pendingSimRef.current = [];
    const resolved: Array<{ id: number; result: "win" | "loss" }> = [];
    for (const p of pendingSimRef.current) {
      if (idx >= p.tickIndex) {
        const win = latestDigit === p.predicted;
        resolved.push({ id: p.id, result: win ? "win" : "loss" });
        if (win) setMatched(true);
        setOpenEntry(null);
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
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
      onHistory: (digits, last) => {
        // Strict filter: keep every digit 0-9 (including 0). Drop only sentinel -1 (parse failure).
        const clean = digits.filter((d) => d !== null && d !== undefined && d >= 0 && d <= 9);
        bufRef.current = clean.slice(-MAX_BUFFER);
        totalTicksRef.current = bufRef.current.length;
        lastPriceRef.current = last;
        setLastPrice(last);
        scheduleRender();
      },
      onTick: (digit, quote, _e, arrival) => {
        const prev = lastArrivalRef.current;
        const gap = prev ? arrival - prev : 0;
        lastArrivalRef.current = arrival;
        if (gap > 0) {
          const g = gapsRef.current;
          g.push(gap);
          if (g.length > 12) g.shift();
        }
        const isStale = prev !== 0 && gap > cfgRef.current.safeGapMs;
        setStale(isStale);
        // Strict validity check — digit === 0 is valid and must pass through.
        const validDigit = digit !== null && digit !== undefined && digit >= 0 && digit <= 9;
        if (!validDigit) {
          scheduleRender();
          return;
        }
        const b = bufRef.current;
        b.push(digit);
        if (b.length > MAX_BUFFER) b.splice(0, b.length - MAX_BUFFER);
        totalTicksRef.current++;
        lastPriceRef.current = quote;
        setLastPrice(quote);
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
      onAuth: (info) => setAuth(info),
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
    if (token) client.setToken(token);
  }, [evaluateAndMaybeFire, pushSignal, resolveSims, scheduleRender, token]);

  const handleDisconnect = useCallback(() => {
    clientRef.current?.disconnect();
    clientRef.current = null;
    setConnected(false);
  }, []);

  useEffect(() => {
    handleConnect();
    return () => clientRef.current?.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible" && !clientRef.current) handleConnect();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [handleConnect]);

  useEffect(() => {
    if (!connected || !clientRef.current) return;
    bufRef.current = [];
    lastArrivalRef.current = 0;
    totalTicksRef.current = 0;
    pendingSimRef.current = [];
    gapsRef.current = [];
    setOpenEntry(null);
    setMatched(false);
    clientRef.current.subscribeTicks(cfg.symbol, 100);
  }, [cfg.symbol, connected]);

  const tickKey = totalTicksRef.current;
  const buf = bufRef.current;

  const derived = useMemo(() => {
    const win = buf.slice(-cfg.lookback);
    const win20 = buf.slice(-20);
    const win50 = buf.slice(-50);
    const win100 = buf.slice(-100);
    const freq = frequencies(win);
    const f100 = frequencies(win100);
    const gaps = gapsSinceLast(win);
    let coldDigit = 0;
    for (let i = 1; i < 10; i++) if (gaps[i] > gaps[coldDigit]) coldDigit = i;
    const followPrefix: [number, number] | null =
      buf.length >= 2 ? [buf[buf.length - 2], buf[buf.length - 1]] : null;
    const follow = followPrefix
      ? twoTickFollowups(win, followPrefix[0], followPrefix[1])
      : { probs: new Array(10).fill(0), total: 0, counts: [] };
    const mk = markov1(win);
    const split = splitStats(win);
    const hc = hotCold(buf, 30);
    const rf = riseFall(buf, 12);
    const ens = ensemblePredict(win);
    const bigrams = topNgrams(win, 2, 5);
    const trigrams = topNgrams(win, 3, 5);
    const chiIndep = chiSquaredIndependence(win).chi;
    const h20 = shannonEntropy(frequencies(win20), win20.length);
    const h50 = shannonEntropy(frequencies(win50), win50.length);
    const h100 = shannonEntropy(f100, win100.length);
    return {
      freq, win, win20, win50, win100,
      chi: chiSquaredUniform(f100, win100.length),
      chiIndep,
      h20, h50, h100,
      hZ20: entropyZ(h20, win20.length),
      hZ50: entropyZ(h50, win50.length),
      bias: biasIndex(freq, win.length),
      coldDigit,
      coldGap: gaps[coldDigit],
      follow,
      followPrefix,
      mk,
      split,
      hc,
      rf,
      ens,
      bigrams,
      trigrams,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickKey, cfg.lookback, cfg.predictDigit]);

  // Use null sentinel so digit 0 is never confused with "no data". All downstream
  // checks must use strict null/undefined comparisons (digit !== null && digit !== undefined),
  // never truthy checks like `if (lastDigit)` which would drop a legitimate 0.
  const lastDigit: number | null =
    buf.length > 0 && buf[buf.length - 1] !== undefined ? buf[buf.length - 1] : null;

  const health: NetHealth =
    pingMs === 0 ? "yellow" : pingMs > cfg.safePingMs ? "red" : pingMs > 250 ? "yellow" : "green";

  // Execution safety guard
  const lastGapNow = lastArrivalRef.current ? performance.now() - lastArrivalRef.current : 0;
  const safe = pingMs > 0 && pingMs <= cfg.safePingMs && lastGapNow <= cfg.safeGapMs;

  // Expected next-tick countdown (median inter-tick gap minus elapsed)
  const tickInterval = medianOf(gapsRef.current) || 2000;
  const countdownMs = Math.round(Math.max(0, tickInterval - lastGapNow));
  const purchaseInMs = countdownMs - cfg.latencyOffsetMs;
  // suppress unused-tick warning
  void tick;

  const setPartial = useCallback((patch: Partial<AppConfig>) => {
    setCfg((c) => ({ ...c, ...patch }));
  }, []);

  const applyToken = useCallback(() => {
    saveToken(token);
    clientRef.current?.setToken(token);
  }, [token]);

  const clearToken = useCallback(() => {
    setToken("");
    saveToken("");
    clientRef.current?.setToken(null);
    setAuth(null);
  }, []);

  const handleBuy = useCallback(
    async (contractType: ContractType, barrier?: number) => {
      if (!clientRef.current || !auth) return;
      setBuyBusy(true);
      setLastBuyResult("Sending order…");
      const res = await clientRef.current.buy({
        contractType,
        symbol: cfg.symbol,
        stake: cfg.stake,
        durationTicks: cfg.duration,
        barrier,
        currency: auth.currency,
      });
      setBuyBusy(false);
      if (res.ok) {
        setLastBuyResult(
          `✓ ${contractType}${barrier !== undefined ? " " + barrier : ""} · stake ${res.buyPrice?.toFixed(2)} · payout ${res.payout?.toFixed(2)}`,
        );
      } else {
        setLastBuyResult(`✗ ${res.error}`);
      }
    },
    [auth, cfg.symbol, cfg.stake, cfg.duration],
  );

  return (
    <div className={`min-h-screen p-3 text-foreground ${flash ? "ring-4 ring-magenta" : ""}`}>
      <header className="mb-3 flex items-center justify-between">
        <div>
          <h1 className="text-base font-bold tracking-wide">
            <span className="text-cyan">DERIV</span>
            <span className="text-muted-foreground"> · </span>
            <span>DIGITS TERMINAL</span>
          </h1>
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
            Bayesian ensemble · Markov · Mobile-grade safety
          </p>
        </div>
        <div className="flex items-center gap-1">
          <span className={`rounded border px-2 py-0.5 text-[10px] font-mono ${connected ? "border-cyan text-cyan" : "border-danger text-danger"}`}>
            {connected ? "LIVE FEED" : "OFFLINE"}
          </span>
          <button
            type="button"
            onClick={signOut}
            className="rounded border border-input px-2 py-0.5 text-[10px] font-mono text-muted-foreground"
          >
            Logout
          </button>
        </div>
      </header>

      <div className="space-y-3">
        <NetworkBadge health={health} pingMs={pingMs} driftMs={driftMs} ticks={totalTicksRef.current} stale={stale} />
        {(() => {
          const valid = lastDigit !== null && lastDigit !== undefined && lastDigit >= 0 && lastDigit <= 9;
          const ensembleOK = valid && derived.win.length >= 10;
          const markovOK = valid;
          const followOK = valid && derived.followPrefix !== null;
          const chiOK = derived.win100.length >= 10;
          const uiOK = valid;
          const pill = (label: string, ok: boolean) => (
            <span
              key={label}
              className={`rounded border px-1.5 py-0.5 font-mono ${ok ? "border-cyan/60 text-cyan" : "border-danger/60 text-danger"}`}
            >
              {label}:{ok ? "✓" : "✗"}
            </span>
          );
          return (
            <div className="flex flex-wrap items-center gap-1 rounded border border-border/60 bg-background/40 px-2 py-1 text-[10px]">
              <span className="font-mono text-muted-foreground">DBG</span>
              <span className="font-mono text-cyan">
                lastDigit={lastDigit === null ? "null" : String(lastDigit)}
              </span>
              <span className="font-mono text-muted-foreground">buf={buf.length}</span>
              {pill("Ensemble", ensembleOK)}
              {pill("Markov", markovOK)}
              {pill("Follow", followOK)}
              {pill("ChiSq", chiOK)}
              {pill("UI", uiOK)}
            </div>
          );
        })()}
        <EnsemblePanel
          ensemble={derived.ens}
          market={cfg.market}
          barrier={cfg.barrier}
          pEven={derived.split.pEven}
          pHigh={derived.split.pHigh}
          rise={{ up: derived.rf.up, down: derived.rf.down }}
          safe={safe}
          countdownMs={countdownMs}
          purchaseInMs={purchaseInMs}
        />
        {(() => {
          const isMatches = cfg.market === "matches";
          const displayDigit = isMatches ? cfg.predictDigit : derived.ens.topDigit;
          const conf = isMatches
            ? derived.ens.posterior[cfg.predictDigit] ?? 0
            : derived.ens.confidence;
          const highlight = isMatches && conf >= 0.7;
          return (
            <PredictedDigit
              digit={displayDigit}
              entryPrice={openEntry?.price ?? null}
              lastPrice={lastPrice}
              matched={matched}
              armed={armed}
              confidence={conf}
              highlight={highlight}
            />
          );
        })()}
        <TokenConnector
          token={token}
          onTokenChange={setToken}
          auth={auth}
          connected={connected}
          onApply={applyToken}
          onClear={clearToken}
        />
        <TradeConsole
          authorized={!!auth}
          stake={cfg.stake}
          duration={cfg.duration}
          barrier={cfg.barrier}
          predictDigit={cfg.predictDigit}
          onStakeChange={(n) => setPartial({ stake: n })}
          onDurationChange={(n) => setPartial({ duration: n })}
          onBarrierChange={(n) => setPartial({ barrier: n })}
          onPredictDigitChange={(n) => setPartial({ predictDigit: n })}
          onBuy={handleBuy}
          safe={safe}
          lastResult={lastBuyResult}
          busy={buyBusy}
        />
        <DigitGrid freq={derived.freq} total={derived.win.length} predict={cfg.predictDigit} />
        <SplitPanel
          pEven={derived.split.pEven}
          pHigh={derived.split.pHigh}
          hot={derived.hc.hot}
          cold={derived.hc.cold}
          hotFreq={derived.hc.freq}
          riseUp={derived.rf.up}
          riseDown={derived.rf.down}
        />
        <RecentTicks digits={buf} />
        <MarkovMatrix matrix={derived.mk} lastDigit={lastDigit} predict={derived.ens.topDigit} />
        <PatternsPanel
          bigrams={derived.bigrams}
          trigrams={derived.trigrams}
          chiUnif={derived.chi}
          chiIndep={derived.chiIndep}
          hZ20={derived.hZ20}
          hZ50={derived.hZ50}
          bias={derived.bias}
        />
        <StatsPanel
          chi={derived.chi}
          h20={derived.h20}
          h50={derived.h50}
          h100={derived.h100}
          coldDigit={derived.coldDigit}
          coldGap={derived.coldGap}
          coldProb={coldProb(derived.coldGap)}
          followPrefix={derived.followPrefix}
          followProbs={derived.follow.probs}
          followTotal={derived.follow.total}
        />
        <Controls
          cfg={cfg}
          onChange={setPartial}
          connected={connected}
          onConnect={handleConnect}
          onDisconnect={handleDisconnect}
          armed={armed}
          onToggleArm={() => setArmed((a) => !a)}
        />
        <SignalsLog signals={signals} />
        <footer className="pb-6 text-center text-[10px] text-muted-foreground">
          Public app_id 1089 · analysis only · not financial advice
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
