import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Subject } from "rxjs";
import { auditTime } from "rxjs/operators";
import { DerivClient, decimalsForSymbol, type AuthInfo, type ConnState, type ContractType } from "@/lib/deriv/derivClient";
import { DigitRing, FloatRing } from "@/lib/deriv/ring";
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
import { allRulesAgree, enabledRuleCount, evaluateRules } from "@/lib/deriv/triggers";
import type { EngineReport } from "@/lib/deriv/engine";
import {
  applyContextWeights,
  buildSignalRouter,
  hmmState,
  poissonClusterWeights,
  priceEma,
  volatilityState,
} from "@/lib/deriv/marketContext";
import {
  assetTypeOf,
  fusePreArrival,
  runPreArrivalAnalysis,
} from "@/lib/deriv/preArrival";
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
import { PreArrivalPanel } from "./PreArrivalPanel";
import { NavigatorPanel } from "./NavigatorPanel";
import type { EngineResult } from "@/lib/deriv/navigator";


const MAX_BUFFER = 500;

export default function DigitsApp() {
  const [cfg, setCfg] = useState<AppConfig>(() => loadConfig());
  const [connected, setConnected] = useState(false);
  const [connState, setConnState] = useState<ConnState>("connecting");
  const [connDetail, setConnDetail] = useState("");
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

  // ---- Persistent circular byte buffers (never touched by React renders) ----
  const bufRef = useRef<DigitRing | null>(null);
  if (!bufRef.current) bufRef.current = new DigitRing(MAX_BUFFER);
  const gapsRef = useRef<FloatRing | null>(null);
  if (!gapsRef.current) gapsRef.current = new FloatRing(16);
  const priceSeriesRef = useRef<FloatRing | null>(null);
  if (!priceSeriesRef.current) priceSeriesRef.current = new FloatRing(20);
  const priceDeltasRef = useRef<FloatRing | null>(null);
  if (!priceDeltasRef.current) priceDeltasRef.current = new FloatRing(64);

  const lastArrivalRef = useRef<number>(0);
  const totalTicksRef = useRef(0);
  const lastPriceRef = useRef<number>(0);
  const pingMedianRef = useRef<number[]>([]);
  const confRef = useRef(0);
  const healthRef = useRef<NetHealth>("yellow");
  const clientRef = useRef<DerivClient | null>(null);
  const cfgRef = useRef(cfg);
  const armedRef = useRef(armed);
  const pendingSimRef = useRef<Array<{ id: number; tickIndex: number; predicted: number; entryPrice: number }>>([]);
  const lastSignalTickRef = useRef(-100);
  const renderScheduled = useRef(false);
  // Background analysis engine (Web Worker) + reactive tick stream
  const workerRef = useRef<Worker | null>(null);
  const tickStreamRef = useRef<Subject<{ digit: number; ts: number }> | null>(null);
  const hiddenSinceRef = useRef<number>(0);
  const [engineReport, setEngineReport] = useState<EngineReport | null>(null);
  const [engineLog, setEngineLog] = useState<string[]>([]);
  // Digits Navigator corrected engine — exact DP probabilities per tick.
  const [navResult, setNavResult] = useState<EngineResult | null>(null);
  const navReadyAtRef = useRef(0); // performance.now() of the last READY alert
  const navWasReadyRef = useRef(false);
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

  const [theme, setTheme] = useState<"dark" | "light">("dark");
  useEffect(() => {
    const t = localStorage.getItem("cdt-theme");
    if (t === "light") setTheme("light");
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
    localStorage.setItem("cdt-theme", theme);
  }, [theme]);

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
    worker.onmessage = (e: MessageEvent<{ type: string; report?: EngineReport; result?: EngineResult | null }>) => {
      if (e.data?.type === "report" && e.data.report) {
        const report = e.data.report;
        setEngineReport(report);
        setEngineLog((prev) => {
          const next = prev.length >= 60 ? prev.slice(-59) : prev.slice();
          next.push(report.log);
          return next;
        });
        return;
      }
      if (e.data?.type === "nav") {
        const nav = e.data.result ?? null;
        setNavResult(nav);
        const ready = nav?.alertDecision === "READY / MANUAL ALERT";
        if (ready && !navWasReadyRef.current) {
          // New READY alert: start the 700 ms human-response window + audio lock.
          navReadyAtRef.current = performance.now();
          navWasReadyRef.current = true;
          beep(1200, 260);
          setSignals((prev) => [
            ...prev.slice(-40),
            {
              id: Date.now() + Math.random(),
              ts: Date.now(),
              reason: `NAV READY · digit ${nav!.topTargetDigit} · multiHit ${(nav!.multiHitProb * 100).toFixed(2)}%`,
              predicted: nav!.topTargetDigit,
              market: cfgRef.current.market,
              mode: cfgRef.current.mode,
            },
          ]);
        } else if (!ready && navWasReadyRef.current) {
          navReadyAtRef.current = 0;
          navWasReadyRef.current = false;
        }
      }
    };

    const stream = new Subject<{ digit: number; ts: number; rtt: number }>();
    tickStreamRef.current = stream;
    // auditTime coalesces bursts so a wake-up backlog can't spam the worker.
    const sub = stream.pipe(auditTime(0)).subscribe(({ digit, ts, rtt }) => {
      worker.postMessage({ type: "tick", digit, ts, cfg: cfgRef.current, rttMs: rtt });
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

  /** Hard reset of every analysis buffer — used on symbol change so a new
   *  volatility never inherits the previous instrument's statistics. */
  const resetAnalysis = useCallback(() => {
    bufRef.current!.reset();
    gapsRef.current!.reset();
    priceSeriesRef.current!.reset();
    priceDeltasRef.current!.reset();
    lastArrivalRef.current = 0;
    totalTicksRef.current = 0;
    lastPriceRef.current = 0;
    confRef.current = 0;
    pendingTickRef.current = null;
    pendingSimRef.current = [];
    lastSignalTickRef.current = 0;
    setNavResult(null);
    navReadyAtRef.current = 0;
    navWasReadyRef.current = false;
    setOpenEntry(null);
    setMatched(false);
    setLastPrice(null);
    setStale(false);
    workerRef.current?.postMessage({ type: "reset", lookback: cfgRef.current.lookback });
    scheduleRender();
  }, [scheduleRender]);

  const evaluateAndMaybeFire = useCallback(() => {
    const cfgNow = cfgRef.current;
    const win = bufRef.current!.lastN(cfgNow.lookback);
    if (win.length < 10) return;

    // ---- STRICT ALERT GATES ----
    // 1) Every enabled trigger rule must agree (AND, not OR).
    if (enabledRuleCount(cfgNow) === 0) return;
    const hits = evaluateRules({ window: win, cfg: cfgNow });
    if (!allRulesAgree(cfgNow, hits)) return;
    // 2) Ping gate by index type: 1s < 350ms, plain < 500ms.
    {
      const p = medianOf(pingMedianRef.current);
      if (p <= 0 || p >= pingLimitFor(cfgNow.symbol)) return;
    }

    if (totalTicksRef.current - lastSignalTickRef.current < 3) return;
    lastSignalTickRef.current = totalTicksRef.current;

    const reason =
      hits.map((h) => `${h.rule}:${h.detail}`).join(" · ") +
      ` · conf ${(confRef.current * 100).toFixed(0)}%`;
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
    // Slow feeds (2s indices, polled fallback) legitimately exceed the raw
    // 800ms guard — scale the gap budget to the observed tick cadence.
    const gapBudget = Math.max(cfgNow.safeGapMs, cadenceOf(cfgNow.symbol, gapsRef.current!.median()) * 1.6);
    const networkUnsafe = median >= pingLimitFor(cfgNow.symbol) || lastGap > gapBudget;

    if (cfgNow.mode === "alert") {
      // Precision execution scheduler: aim the audible fire at
      // (expected next tick) − (ping + drift + configured lag buffer),
      // using performance.now() so we're immune to wall-clock jitter.
      const now = performance.now();
      const interval = cadenceOf(cfgNow.symbol, gapsRef.current!.median());
      const sinceLast = lastArrivalRef.current ? now - lastArrivalRef.current : 0;
      const nextTickIn = Math.max(0, interval - sinceLast);
      const ping = median;
      const drift = Math.abs(driftMsRef.current);
      const lag = cfgNow.latencyOffsetMs;
      const target = now + Math.max(0, nextTickIn - ping - drift - lag);
      nextFireAtRef.current = target;
      if (fireTimerRef.current !== null) clearTimeout(fireTimerRef.current);
      fireTimerRef.current = window.setTimeout(() => {
        const actual = performance.now();
        const variance = actual - target;
        beep();
        setFlash(true);
        setTimeout(() => setFlash(false), 180);
        setExecDiag((prev) => {
          const line = `fire · Δ${variance >= 0 ? "+" : ""}${variance.toFixed(1)}ms · ping ${ping.toFixed(0)} · drift ${drift.toFixed(0)} · lag ${lag}`;
          const next = prev.length >= 30 ? prev.slice(-29) : prev.slice();
          next.push(line);
          return next;
        });
      }, Math.max(0, target - now));
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
      onStatus: (state, attempt, detail) => {
        setConnState(state);
        setConnDetail(detail ? `${detail}` : attempt > 0 ? `attempt ${attempt}` : "");
      },
      onHistory: (digits, last, sym) => {
        // Isolation guard: ignore history for any symbol that is no longer selected.
        if (sym !== cfgRef.current.symbol) return;
        // Strict filter: keep every digit 0-9 (including 0). Drop only sentinel -1 (parse failure).
        const clean = digits.filter((d) => d !== null && d !== undefined && d >= 0 && d <= 9);
        const ring = bufRef.current!;
        ring.reset();
        ring.pushMany(clean.slice(-MAX_BUFFER));
        totalTicksRef.current = ring.length;
        lastPriceRef.current = last;
        setLastPrice(last);
        // Reseed the worker's ring buffer to match the trimmed history.
        workerRef.current?.postMessage({ type: "reset", lookback: cfgRef.current.lookback });
        workerRef.current?.postMessage({ type: "init", lookback: cfgRef.current.lookback, seed: clean.slice(-cfgRef.current.lookback) });
        // Navigator engine needs the full exact 100-tick buffer from history.
        workerRef.current?.postMessage({ type: "navSeed", digits: clean.slice(-100) });
        scheduleRender();
      },
      onTick: (digit, quote, _e, arrival, sym) => {
        // Isolation guard: a late packet from the previous volatility must
        // never enter this instrument's statistics.
        if (sym !== cfgRef.current.symbol) return;
        const prev = lastArrivalRef.current;
        const gap = prev ? arrival - prev : 0;
        lastArrivalRef.current = arrival;
        // Only record plausible gaps for this index type (ignore wake/poll outliers).
        if (gap > 0 && gap < expectedCadence(sym) * 5) gapsRef.current!.push(gap);
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
          clientRef.current?.subscribeTicks(cfgRef.current.symbol, 100);
          return;
        }
        // Cadence-aware: 1s indices ≈1000ms, plain indices ≈2000ms.
        const staleBudget = Math.max(
          cfgRef.current.safeGapMs,
          cadenceOf(cfgRef.current.symbol, gapsRef.current!.median()) * 1.6,
        );
        const isStale = prev !== 0 && gap > staleBudget;
        setStale(isStale);
        // Strict validity check — digit === 0 is valid and must pass through.
        const validDigit = digit !== null && digit !== undefined && digit >= 0 && digit <= 9;
        if (!validDigit) {
          scheduleRender();
          return;
        }
        bufRef.current!.push(digit);
        totalTicksRef.current++;
        lastPriceRef.current = quote;
        setLastPrice(quote);
        // Price EMA + Δ volatility feed (fixed-size Float32 ring buffers).
        {
          const ps = priceSeriesRef.current!;
          const prevPrice = ps.length ? ps.last() : quote;
          ps.push(quote);
          priceDeltasRef.current!.push(Math.abs(quote - prevPrice));
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
            tickStreamRef.current?.next({ digit: latest.digit, ts: performance.now(), rtt: medianOf(pingMedianRef.current) });
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

  // Symbol switch: wipe every statistic so the new volatility is analysed
  // from a completely fresh state (no cross-instrument contamination).
  useEffect(() => {
    if (!connected || !clientRef.current) return;
    resetAnalysis();
    clientRef.current.subscribeTicks(cfg.symbol, 100);
  }, [cfg.symbol, connected, resetAnalysis]);

  const tickKey = totalTicksRef.current;
  // Snapshot the circular byte buffer once per throttled render pass.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const buf = useMemo(() => bufRef.current!.toArray(), [tickKey]);

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

  // Background market-context layer — EMA direction, tick-Δ volatility,
  // 3-state HMM regime, Poisson cluster weights, and a consolidated signal
  // router payload. Feeds only the prediction math; UI is unchanged.
  const context = useMemo(() => {
    const p = priceSeriesRef.current!.toArray();
    const d = priceDeltasRef.current!.toArray();
    const ema = priceEma(p);
    const vol = volatilityState(d);
    const hmm = hmmState(buf);
    const poissonW = poissonClusterWeights(buf);
    const ctxWeighted = applyContextWeights(derived.ens.posterior, {
      direction: ema.direction,
      volatility: vol.state,
      hmm: hmm.state,
      poissonWeights: poissonW,
    });
    // Zero-lag pre-arrival layer: 3rd-order Markov tensor, Lyapunov, Hurst,
    // Fourier harmonics, KS bias and AR-Poisson intensity — fused into the
    // posterior with micro-fatigue muting.
    const pre = runPreArrivalAnalysis(buf, d, assetTypeOf(cfgRef.current.symbol));
    const weighted = pre.physics.ready
      ? fusePreArrival(ctxWeighted, pre.forecasts)
      : ctxWeighted;
    let topDigit = 0;
    for (let i = 1; i < 10; i++) if (weighted[i] > weighted[topDigit]) topDigit = i;
    const router = buildSignalRouter(weighted, derived.split.pEven, {
      up: derived.rf.up,
      down: derived.rf.down,
    });
    return { ema, vol, hmm, weighted, topDigit, router, pre };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickKey, derived, cfg.symbol]);

  // Router payload is kept as a live diagnostic even though the UI shell
  // does not surface it — downstream consumers (worker, logs) read it.
  void context.router;

  // Live fused confidence used by the alert gate (market aware).
  const gateConf = Math.min(
    1,
    (cfg.market === "matches"
      ? (context.weighted[cfg.predictDigit] ?? 0)
      : (context.weighted[context.topDigit] ?? 0)) * (engineReport?.confidenceAdjust ?? 1),
  );
  confRef.current = gateConf;


  // Use null sentinel so digit 0 is never confused with "no data". All downstream
  // checks must use strict null/undefined comparisons (digit !== null && digit !== undefined),
  // never truthy checks like `if (lastDigit)` which would drop a legitimate 0.
  const lastDigit: number | null =
    buf.length > 0 && buf[buf.length - 1] !== undefined ? buf[buf.length - 1] : null;

  const pingLimit = pingLimitFor(cfg.symbol);
  const health: NetHealth =
    pingMs === 0 ? "yellow" : pingMs >= pingLimit ? "red" : pingMs > pingLimit * 0.6 ? "yellow" : "green";
  healthRef.current = health;

  // Execution safety guard
  const lastGapNow = lastArrivalRef.current ? performance.now() - lastArrivalRef.current : 0;
  const gapBudgetNow = Math.max(cfg.safeGapMs, cadenceOf(cfg.symbol, gapsRef.current!.median()) * 1.6);
  const safe = pingMs > 0 && pingMs < pingLimit && lastGapNow <= gapBudgetNow;

  // Expected next-tick countdown (median inter-tick gap minus elapsed)
  const tickInterval = cadenceOf(cfg.symbol, gapsRef.current!.median());
  const pip = clientRef.current?.getPipSize() ?? decimalsForSymbol(cfg.symbol);
  const serverTime = new Date(Date.now() + driftMs).toISOString().slice(11, 19);
  const countdownMs = Math.round(Math.max(0, tickInterval - lastGapNow));
  const purchaseInMs = countdownMs - cfg.latencyOffsetMs;
  // Navigator 700 ms human-response window (numeric countdown, no progress bar)
  const navReady = navResult?.alertDecision === "READY / MANUAL ALERT";
  const navElapsed = navReady && navReadyAtRef.current > 0 ? performance.now() - navReadyAtRef.current : 0;
  const navWaiting = totalTicksRef.current < 100;
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
    <div className={`min-h-screen p-3 mx-auto max-w-6xl text-foreground ${flash ? "ring-4 ring-magenta" : ""}`}>
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
          <span className="rounded border border-input px-2 py-0.5 text-[11px] font-mono tabular-nums" title="Deriv server time (UTC)">
            {serverTime}
          </span>
          <button
            type="button"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            className="rounded border border-input px-2 py-0.5 text-[10px] font-mono"
          >
            {theme === "dark" ? "Light" : "Dark"}
          </button>
          <span
            title={connDetail}
            className={`rounded border px-2 py-0.5 text-[10px] font-mono ${
              connState === "live" && connected
                ? "border-cyan text-cyan"
                : connState === "offline"
                  ? "border-danger text-danger"
                  : "border-warning text-warning"
            }`}
          >
            {connState === "live" && connected
              ? "LIVE FEED"
              : connState === "reconnecting"
                ? "RECONNECTING"
                : connState === "connecting"
                  ? "CONNECTING"
                  : "OFFLINE"}
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

      <div className="grid gap-3 md:grid-cols-2 [&>*]:min-w-0">
        <NetworkBadge health={health} pingMs={pingMs} driftMs={driftMs} ticks={totalTicksRef.current} stale={stale} />
        <div className="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{cfg.symbol} · live price</div>
            <div className="font-mono tabular-nums text-xl">
              {lastPrice != null ? (() => { const s = lastPrice.toFixed(pip); return (<>{s.slice(0, -1)}<span className="text-3xl font-extrabold text-cyan">{s.slice(-1)}</span></>); })() : "—"}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Last digit</div>
            <div className="font-mono text-4xl font-extrabold text-cyan tabular-nums">{lastDigit !== null ? lastDigit : "—"}</div>
          </div>
        </div>
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
              pip={pip}
              matched={matched}
              armed={armed}
              confidence={conf}
              highlight={highlight}
            />
          );
        })()}
        <PreArrivalPanel
          forecasts={context.pre.forecasts}
          physics={context.pre.physics}
          topDigit={context.pre.topDigit}
        />
        <NavigatorPanel result={navResult} alertElapsedMs={navElapsed} waiting={navWaiting} />
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
        <footer className="md:col-span-2 pb-6 text-center text-[10px] text-muted-foreground">
          Deriv public feed · analysis only · not financial advice
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

function expectedCadence(symbol: string): number {
  return /^1HZ\d+V$/.test(symbol) ? 1000 : 2000;
}

/** Observed median gap, clamped to a sane band around the index's nominal cadence. */
function cadenceOf(symbol: string, median: number): number {
  const exp = expectedCadence(symbol);
  if (!median || median <= 0) return exp;
  return Math.min(exp * 2, Math.max(exp * 0.5, median));
}

/** Alert ping ceiling: 1s indices < 350ms, plain indices < 500ms. */
function pingLimitFor(symbol: string): number {
  return /^1HZ\d+V$/.test(symbol) ? 350 : 500;
}
