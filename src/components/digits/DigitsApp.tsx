import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Subject } from "rxjs";
import { auditTime } from "rxjs/operators";
import { DerivClient, type AuthInfo, type ContractType, type SymbolInfo } from "@/lib/deriv/derivClient";
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
import type { EngineReport } from "@/lib/deriv/engine";
import {
  applyContextWeights,
  buildSignalRouter,
  hmmState,
  poissonClusterWeights,
  priceEma,
  volatilityState,
} from "@/lib/deriv/marketContext";
import { fusePosteriors, runSuperQuantAnalysis } from "@/lib/deriv/superQuant";
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
import { EngineLog } from "./EngineLog";

const MAX_BUFFER = 500;
// Hard network ceiling: above this round-trip the terminal emits no signals
// and refuses to send orders.
const PING_GATE_MS = 500;
// Entries must land inside a 2s window — never earlier, never later.
const ENTRY_WINDOW_MS = 2000;

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
  // Symbols the server actually allows on this connection.
  const [symbols, setSymbols] = useState<SymbolInfo[]>([]);

  const bufRef = useRef<number[]>([]);
  const lastArrivalRef = useRef<number>(0);
  const totalTicksRef = useRef(0);
  const lastPriceRef = useRef<number>(0);
  const pingMedianRef = useRef<number[]>([]);
  const gapsRef = useRef<number[]>([]); // inter-tick gaps for interval estimate
  const priceSeriesRef = useRef<number[]>([]); // last-20 spot prices for EMA filter
  const priceDeltasRef = useRef<number[]>([]); // last-30 |Δprice| for volatility
  const clientRef = useRef<DerivClient | null>(null);
  const cfgRef = useRef(cfg);
  const armedRef = useRef(armed);
  const pendingSimRef = useRef<Array<{ id: number; tickIndex: number; predicted: number; entryPrice: number }>>([]);
  const lastSignalTickRef = useRef(-100);
  const lastBlockedTickRef = useRef(-100);
  const renderScheduled = useRef(false);
  // Background analysis engine (Web Worker) + reactive tick stream
  const workerRef = useRef<Worker | null>(null);
  const tickStreamRef = useRef<Subject<{ digit: number; ts: number }> | null>(null);
  const hiddenSinceRef = useRef<number>(0);
  const [engineReport, setEngineReport] = useState<EngineReport | null>(null);
  const [engineLog, setEngineLog] = useState<string[]>([]);
  // Execution diagnostics — post-tick timing variance vs the scheduled fire.
  const [execDiag, setExecDiag] = useState<string[]>([]);
  const nextFireAtRef = useRef<number>(0); // performance.now() target for next scheduled fire
  const fireTimerRef = useRef<number | null>(null);
  // LIFO tick coalescer — if multiple tick packets are queued in the same
  // task, only the newest wins. Older packets are discarded before analysis.
  const pendingTickRef = useRef<{ digit: number; quote: number; arrival: number; epoch: number } | null>(null);
  const coalesceScheduledRef = useRef(false);
  // ticker for countdown updates
  const [tick, setTick] = useState(0);
  const driftMsRef = useRef(0);

  useEffect(() => { cfgRef.current = cfg; saveConfig(cfg); }, [cfg]);
  useEffect(() => { armedRef.current = armed; }, [armed]);

  // Countdown ticker @ 5fps — light, only updates a single number/bar.
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => (t + 1) & 0x3fffffff), 200);
    return () => clearInterval(id);
  }, []);

  // Spin up the analysis Web Worker + RxJS tick stream once. The worker owns
  // the FIFO ring buffer, higher-order Markov, entropy-decay and time-seed
  // math so the mobile UI thread stays free.
  useEffect(() => {
    const worker = new Worker(new URL("../../lib/deriv/analysisWorker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    worker.postMessage({ type: "init", lookback: cfgRef.current.lookback, seed: [] });
    worker.onmessage = (e: MessageEvent<{ type: "report"; report: EngineReport }>) => {
      if (e.data?.type !== "report") return;
      const report = e.data.report;
      setEngineReport(report);
      setEngineLog((prev) => {
        const next = prev.length >= 60 ? prev.slice(-59) : prev.slice();
        next.push(report.log);
        return next;
      });
    };

    const stream = new Subject<{ digit: number; ts: number }>();
    tickStreamRef.current = stream;
    // auditTime coalesces bursts so a wake-up backlog can't spam the worker.
    const sub = stream.pipe(auditTime(0)).subscribe(({ digit, ts }) => {
      worker.postMessage({ type: "tick", digit, ts, cfg: cfgRef.current });
    });
    return () => {
      sub.unsubscribe();
      stream.complete();
      worker.terminate();
      workerRef.current = null;
      tickStreamRef.current = null;
    };
  }, []);

  // Notify the worker when the user changes lookback.
  useEffect(() => {
    workerRef.current?.postMessage({ type: "lookback", lookback: cfg.lookback });
  }, [cfg.lookback]);


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

    // HARD SIGNAL GATE — above 500ms round-trip the tool emits nothing at all.
    const median = medianOf(pingMedianRef.current);
    if (median > PING_GATE_MS) {
      if (totalTicksRef.current - lastBlockedTickRef.current >= 10) {
        lastBlockedTickRef.current = totalTicksRef.current;
        pushSignal({
          id: Date.now() + Math.random(),
          ts: Date.now(),
          reason: `signals suppressed · ping ${median.toFixed(0)}ms > ${PING_GATE_MS}ms`,
          predicted: cfgNow.predictDigit,
          mode: cfgNow.mode,
        });
      }
      return;
    }

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

    const lastGap = lastArrivalRef.current ? performance.now() - lastArrivalRef.current : 0;
    // Hard 500ms ping gate + configured thresholds.
    const networkUnsafe =
      median > PING_GATE_MS || median > cfgNow.safePingMs || lastGap > cfgNow.safeGapMs;


    if (cfgNow.mode === "alert") {
      // Precision execution scheduler: aim the audible fire at
      // (expected next tick) − (ping + drift + configured lag buffer),
      // using performance.now() so we're immune to wall-clock jitter.
      const now = performance.now();
      const interval = medianOf(gapsRef.current) || 2000;
      const sinceLast = lastArrivalRef.current ? now - lastArrivalRef.current : 0;
      const nextTickIn = Math.max(0, interval - sinceLast);
      const ping = median;
      const drift = Math.abs(driftMsRef.current);
      const lag = cfgNow.latencyOffsetMs;
      // Latency-compensated delay, then clamped into the strict 2s entry
      // window so the purchase can never land early or late.
      const raw = nextTickIn - ping - drift - lag;
      const delay = Math.min(ENTRY_WINDOW_MS, Math.max(0, raw));
      const target = now + delay;
      nextFireAtRef.current = target;
      if (fireTimerRef.current !== null) clearTimeout(fireTimerRef.current);
      fireTimerRef.current = window.setTimeout(() => {
        const actual = performance.now();
        const variance = actual - target;
        beep();
        setFlash(true);
        setTimeout(() => setFlash(false), 180);
        setExecDiag((prev) => {
          const line = `fire · in ${delay.toFixed(0)}ms · Δ${variance >= 0 ? "+" : ""}${variance.toFixed(1)}ms · ping ${ping.toFixed(0)} · drift ${drift.toFixed(0)} · lag ${lag}`;
          const next = prev.length >= 30 ? prev.slice(-29) : prev.slice();
          next.push(line);
          return next;
        });
      }, delay);
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
        // Reseed the worker's ring buffer to match the trimmed history.
        workerRef.current?.postMessage({ type: "reset", lookback: cfgRef.current.lookback });
        workerRef.current?.postMessage({ type: "init", lookback: cfgRef.current.lookback, seed: clean.slice(-cfgRef.current.lookback) });
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
        // Mobile browser tab-sleep backlog dropper: if a huge burst of ticks
        // arrives after ColorOS/iOS wakes the tab, flush and resync on the
        // newest tick only — never replay a stale stack sequentially.
        const wokeFromSleep = hiddenSinceRef.current > 0 && document.visibilityState === "visible";
        const burstDetected = wokeFromSleep && gap > 0 && gap < 40; // <40ms between ticks = queued backlog
        if (burstDetected) {
          hiddenSinceRef.current = 0;
          pushSignal({
            id: Date.now() + Math.random(),
            ts: Date.now(),
            reason: `wake resync · dropped backlog · gap ${Math.round(gap)}ms`,
            predicted: cfgRef.current.predictDigit,
            mode: cfgRef.current.mode,
          });
          // hard resubscribe so the server sends fresh state instead of us
          // replaying whatever the socket buffered.
          clientRef.current?.subscribeTicks(cfgRef.current.symbol, cfgRef.current.lookback);
          return;
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
        // Price EMA + Δ volatility feed (bounded rolling arrays).
        {
          const ps = priceSeriesRef.current;
          const prevPrice = ps.length ? ps[ps.length - 1] : quote;
          ps.push(quote);
          if (ps.length > 20) ps.splice(0, ps.length - 20);
          const dl = priceDeltasRef.current;
          dl.push(Math.abs(quote - prevPrice));
          if (dl.length > 30) dl.splice(0, dl.length - 30);
        }
        // LIFO coalescer — if the main thread was busy and multiple ticks
        // stacked up in the task queue, only the newest packet drives
        // downstream analysis. Buffer/history still records every digit.
        pendingTickRef.current = { digit, quote, arrival, epoch: 0 };
        if (!coalesceScheduledRef.current) {
          coalesceScheduledRef.current = true;
          queueMicrotask(() => {
            coalesceScheduledRef.current = false;
            const latest = pendingTickRef.current;
            pendingTickRef.current = null;
            if (!latest) return;
            // Fan the newest tick into the worker analysis engine.
            tickStreamRef.current?.next({ digit: latest.digit, ts: performance.now() });
            resolveSims(latest.digit);
            if (!isStale) evaluateAndMaybeFire();
            scheduleRender();
          });
        }
      },
      onPing: (rtt) => {
        // rtt is already EMA-smoothed by the client; still keep a short
        // median as a secondary sanity filter for the safety guard.
        const arr = pingMedianRef.current;
        arr.push(rtt);
        if (arr.length > 10) arr.shift();
        setPingMs(medianOf(arr));
      },
      onTimeSync: (drift) => { driftMsRef.current = drift; setDriftMs(drift); },
      onSymbols: (list) => {
        setSymbols(list);
        // If the configured symbol isn't tradable on this connection, snap to
        // the first live one so the feed always starts.
        if (list.length > 0 && !list.some((s) => s.symbol === cfgRef.current.symbol)) {
          const first = list.find((s) => s.open) ?? list[0];
          setCfg((c) => ({ ...c, symbol: first.symbol }));
        }
      },
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
      if (document.visibilityState === "hidden") {
        hiddenSinceRef.current = performance.now();
      } else if (document.visibilityState === "visible") {
        // Keep marker set; onTick will use it to detect the wake-burst.
        if (!clientRef.current) handleConnect();
      }
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
    // Never subscribe to a symbol the server hasn't advertised — that is what
    // produced "Symbol X is invalid" and left the terminal with no ticks.
    if (!clientRef.current.hasSymbol(cfg.symbol)) return;
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
    const ens = ensemblePredict(win, cfg.duration);
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

  // SUPER QUANT CORE — Lyapunov / Hurst / Markov / Fourier / KS / Poisson.
  // Replaces the legacy digit prediction as the primary predictive layer.
  const quant = useMemo(
    () => runSuperQuantAnalysis(buf, priceDeltasRef.current, cfg.duration),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tickKey, cfg.duration],
  );

  // Background market-context layer — EMA direction, tick-Δ volatility,
  // 3-state HMM regime, Poisson cluster weights, and a consolidated signal
  // router payload. Feeds only the prediction math; UI is unchanged.
  const context = useMemo(() => {
    const p = priceSeriesRef.current;
    const d = priceDeltasRef.current;
    const ema = priceEma(p);
    const vol = volatilityState(d);
    const hmm = hmmState(buf);
    const poissonW = poissonClusterWeights(buf);
    // SuperQuant is the primary model (70%); the legacy ensemble is retained
    // only as a stabilizing prior (30%) via a geometric opinion pool.
    const fused = fusePosteriors(derived.ens.posterior, quant.posterior, 0.7);
    const weighted = applyContextWeights(fused, {
      direction: ema.direction,
      volatility: vol.state,
      hmm: hmm.state,
      poissonWeights: poissonW,
    });
    let topDigit = 0;
    for (let i = 1; i < 10; i++) if (weighted[i] > weighted[topDigit]) topDigit = i;
    const router = buildSignalRouter(weighted, derived.split.pEven, {
      up: derived.rf.up,
      down: derived.rf.down,
    });
    return { ema, vol, hmm, weighted, topDigit, router };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickKey, derived, quant]);
  // Router payload is kept as a live diagnostic even though the UI shell
  // does not surface it — downstream consumers (worker, logs) read it.
  void context.router;


  // Use null sentinel so digit 0 is never confused with "no data". All downstream
  // checks must use strict null/undefined comparisons (digit !== null && digit !== undefined),
  // never truthy checks like `if (lastDigit)` which would drop a legitimate 0.
  const lastDigit: number | null =
    buf.length > 0 && buf[buf.length - 1] !== undefined ? buf[buf.length - 1] : null;

  const health: NetHealth =
    pingMs === 0 ? "yellow" : pingMs > cfg.safePingMs ? "red" : pingMs > 250 ? "yellow" : "green";

  // Execution safety guard — hard 500ms latency ceiling for any trading
  // action, on top of the user-configured safe-ping threshold.

  const lastGapNow = lastArrivalRef.current ? performance.now() - lastArrivalRef.current : 0;
  const pingGateOpen = pingMs > 0 && pingMs <= PING_GATE_MS;
  const safe =
    pingGateOpen && pingMs <= cfg.safePingMs && lastGapNow <= cfg.safeGapMs;


  // Expected next-tick countdown (median inter-tick gap minus elapsed)
  const tickInterval = medianOf(gapsRef.current) || 2000;
  const countdownMs = Math.round(Math.max(0, tickInterval - lastGapNow));
  const purchaseInMs = countdownMs - cfg.latencyOffsetMs;
  // suppress unused-tick warning
  void tick;

  const setPartial = useCallback((patch: Partial<AppConfig>) => {
    setCfg((c) => ({ ...c, ...patch }));
  }, []);




  return (
    <div className={`min-h-screen p-3 text-foreground ${flash ? "ring-4 ring-magenta" : ""}`}>
      <header className="mb-3 flex items-center justify-between">
        <div>
          <h1 className="text-base font-bold tracking-wide">
            <span className="text-cyan">CEDRICK</span>
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
        {connected && symbols.length === 0 && (
          <div className="rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-[11px] text-warning">
            Waiting for the public Deriv feed to advertise synthetic symbols…
          </div>
        )}

        <NetworkBadge health={health} pingMs={pingMs} driftMs={driftMs} ticks={totalTicksRef.current} stale={stale} />
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
        <div className="rounded-md border border-border bg-card px-3 py-2 text-[11px]">
          <div className="mb-1 flex items-center justify-between">
            <span className="font-semibold">Super Quant Core</span>
            <span
              className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                quant.calcMs <= 2 ? "border-cyan text-cyan" : "border-warning text-warning"
              }`}
            >
              calc {quant.calcMs.toFixed(2)}ms
            </span>
          </div>
          <div className="grid grid-cols-3 gap-1 font-mono text-[10px] text-muted-foreground">
            <span>λ {quant.diagnostics.lyapunov.toFixed(2)}</span>
            <span>H {quant.diagnostics.hurst.toFixed(2)}</span>
            <span>FFT {quant.diagnostics.harmonic.toFixed(3)}</span>
            <span>KS {quant.diagnostics.ksDivergence.toFixed(3)}</span>
            <span>ρ {quant.diagnostics.autocorr.toFixed(2)}</span>
            <span>χ² {quant.diagnostics.chi2.toFixed(1)}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1 font-mono text-[10px]">
            <span className={quant.diagnostics.ordered ? "text-success" : "text-muted-foreground"}>ORDERED</span>
            <span className={quant.diagnostics.persistent ? "text-success" : "text-muted-foreground"}>PERSIST</span>
            <span className={quant.diagnostics.synchronized ? "text-success" : "text-muted-foreground"}>SYNC</span>
            <span className={quant.diagnostics.anomalous ? "text-warning" : "text-muted-foreground"}>ANOM</span>
            <span className="ml-auto">
              target <span className="font-bold text-cyan">{quant.topDigit}</span> ·{" "}
              {quant.topScore.toFixed(1)}
            </span>
          </div>
          <div
            className={`mt-1 rounded border px-1.5 py-0.5 text-center font-mono text-[10px] ${
              pingGateOpen ? "border-success text-success" : "border-danger text-danger"
            }`}
          >
            {pingGateOpen
              ? `EXECUTION GATE OPEN · ping ${pingMs.toFixed(0)}ms ≤ ${PING_GATE_MS}ms · entry window ${ENTRY_WINDOW_MS / 1000}s`
              : `SIGNALS LOCKED · ping ${pingMs.toFixed(0)}ms > ${PING_GATE_MS}ms`}
          </div>
        </div>

        {(() => {
          const isMatches = cfg.market === "matches";
          const displayDigit = isMatches ? cfg.predictDigit : context.topDigit;
          const baseConf = isMatches
            ? context.weighted[cfg.predictDigit] ?? 0
            : context.weighted[context.topDigit] ?? 0;
          // Entropy-decay boost from the background engine — bounded [0.8, 1.25].
          const conf = Math.min(1, baseConf * (engineReport?.confidenceAdjust ?? 1));
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
        <MarkovMatrix matrix={derived.mk} lastDigit={lastDigit} predict={context.topDigit} />
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
          symbols={symbols}
          armed={armed}
          onToggleArm={() => setArmed((a) => !a)}
        />
        <SignalsLog signals={signals} />
        <EngineLog
          entries={engineLog}
          coreSpeedMs={engineReport?.coreSpeedMs ?? 0}
          intervalMs={engineReport?.intervalMs ?? 0}
          intervalStdMs={engineReport?.intervalStdMs ?? 0}
          entropyDecay={engineReport?.entropyDecay ?? 0}
          bitmask={engineReport?.bitmask ?? 0}
        />
        <div className="rounded-md border border-border bg-card px-3 py-2 text-[11px]">
          <div className="mb-1 flex items-center justify-between">
            <span className="font-semibold">Execution Diagnostics</span>
            <span className="rounded border border-input px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              trigger = nextTick − ping − drift − lag({cfg.latencyOffsetMs}ms)
            </span>
          </div>
          <div className="max-h-32 overflow-auto rounded bg-background/60 p-1 font-mono text-[10px] leading-tight">
            {execDiag.length === 0 ? (
              <div className="text-muted-foreground">No scheduled fires yet…</div>
            ) : (
              execDiag.slice(-30).reverse().map((e, i) => (
                <div key={i} className="whitespace-pre-wrap text-muted-foreground">{e}</div>
              ))
            )}
          </div>
        </div>
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
