import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Subject } from "rxjs";
import { auditTime } from "rxjs/operators";
import { DerivClient, type AuthInfo, type ConnState, type ContractType } from "@/lib/deriv/derivClient";
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
import { forecastHorizon, horizonForSymbol } from "@/lib/deriv/matrix";
import { beep } from "@/lib/deriv/audio";
import {
  evaluateLayeredEnsemble,
  meetsExecutionFloor,
  type LayeredResult,
} from "@/lib/deriv/layeredEnsemble";



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
import { SignalCard, type SignalState } from "./SignalCard";
import { MultiAppearancePanel } from "./MultiAppearancePanel";
import { OrderExecutionPanel, type OrderRecord } from "./OrderExecutionPanel";



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
  const [autoFire, setAutoFire] = useState(false);
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const lastFireTickRef = useRef(-99);

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
  // Timestamp of the last main-thread gate evaluation (burst rate limiter).
  const lastEvalRef = useRef(0);
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
  // 5-tick EMA of the raw server-clock drift: smoothed = cur*0.4 + prev*0.6.
  const smoothedDriftRef = useRef(0);
  // Latch: once |smoothedDrift| > 1000ms we hold trades until it settles < 400ms.
  const [syncing, setSyncing] = useState(false);
  const syncingRef = useRef(false);
  // Second-Run Persistence Shield state.
  const streakLatchRef = useRef<{ digit: number; of: number; startTick: number } | null>(null);
  // Layered-ensemble gate state read by the (non-reactive) fire evaluator.
  const layeredRef = useRef<LayeredResult | null>(null);
  const rulesOkRef = useRef(false);




  useEffect(() => { cfgRef.current = cfg; saveConfig(cfg); }, [cfg]);
  useEffect(() => { armedRef.current = armed; }, [armed]);

  // Countdown ticker @ 4fps — light, only updates a single number/bar.
  // Paused whenever the page is hidden or shrunk to a background floating
  // window, so a throttled phone never accumulates a backlog of timer work.
  useEffect(() => {
    let id = 0;
    const start = () => {
      if (id) return;
      id = window.setInterval(() => setTick((t) => (t + 1) & 0x3fffffff), 250);
    };
    const stop = () => {
      if (!id) return;
      clearInterval(id);
      id = 0;
    };
    const sync = () => (document.visibilityState === "visible" ? start() : stop());
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", sync);
    };
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
    // While the page is hidden/backgrounded there is nothing to paint — the
    // ring buffers keep recording, and the first visible frame catches up.
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    renderScheduled.current = true;
    setTimeout(() => {
      renderScheduled.current = false;
      forceRender((x) => (x + 1) & 0x3fffffff);
    }, 140);
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
    setOpenEntry(null);
    setMatched(false);
    setLastPrice(0);
    setStale(false);
    workerRef.current?.postMessage({ type: "reset", lookback: cfgRef.current.lookback });
    scheduleRender();
  }, [scheduleRender]);

  const evaluateAndMaybeFire = useCallback(() => {
    const cfgNow = cfgRef.current;
    const win = bufRef.current!.lastN(cfgNow.lookback);
    if (win.length < 10) return;

    // ---- STRICT ALERT GATES (Layer 3 gatekeeping) ----
    // 1) Every enabled TRIGGER RULES percentage must be satisfied (AND, not OR).
    if (enabledRuleCount(cfgNow) === 0) return;
    const hits = evaluateRules({ window: win, cfg: cfgNow });
    if (!allRulesAgree(cfgNow, hits)) return;
    // 2) Network must be strictly GREEN or YELLOW — RED blocks everything.
    if (healthRef.current === "red") return;
    // 3) Circuit breakers (chi-square / variance / ping / sync) must be clear.
    const layeredNow = layeredRef.current;
    if (layeredNow?.blocked) return;
    // 4) Weighted layered confidence must be STRICTLY above 85%.
    if (!meetsExecutionFloor(confRef.current)) return;

    if (totalTicksRef.current - lastSignalTickRef.current < 3) return;
    lastSignalTickRef.current = totalTicksRef.current;

    const reason =
      hits.map((h) => `${h.rule}:${h.detail}`).join(" · ") +
      ` · L1 ${((layeredNow?.layer1 ?? 0) * 100).toFixed(0)}%` +
      ` · L2 ${((layeredNow?.layer2 ?? 0) * 100).toFixed(0)}%` +
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
    const gapBudget = Math.max(cfgNow.safeGapMs, gapsRef.current!.median() * 1.6);
    const networkUnsafe = median > cfgNow.safePingMs || lastGap > gapBudget;

    if (cfgNow.mode === "alert") {
      // Precision execution scheduler. The horizon offset pushes the trigger
      // out to the tick we actually forecast (t+2 plain / t+3 for 1s indices).
      //
      //   drift < 0  → terminal lagging  → pull forward:  ... + drift ...
      //   drift > 0  → terminal ahead    → push back:     ... − drift ...
      //
      // Both branches use the 5-tick EMA-smoothed drift so erratic network
      // spikes cannot make the countdown jitter.
      const now = performance.now();
      const interval = gapsRef.current!.median() || 2000;
      const sinceLast = lastArrivalRef.current ? now - lastArrivalRef.current : 0;
      const nextTickIn = Math.max(0, interval - sinceLast);
      const horizon = horizonForSymbol(cfgNow.symbol);
      const targetHorizonOffset = (horizon - 1) * interval;
      const ping = median;
      const smoothedDrift = smoothedDriftRef.current;
      const lag = cfgNow.latencyOffsetMs + cfgNow.reactionOffsetMs;
      const preciseTriggerTime =
        smoothedDrift < 0
          ? nextTickIn + targetHorizonOffset - ping + smoothedDrift - lag
          : nextTickIn + targetHorizonOffset - ping - smoothedDrift - lag;
      const target = now + Math.max(0, preciseTriggerTime);
      nextFireAtRef.current = target;
      if (fireTimerRef.current !== null) clearTimeout(fireTimerRef.current);
      fireTimerRef.current = window.setTimeout(() => {
        const actual = performance.now();
        const variance = actual - target;
        beep();
        setFlash(true);
        setTimeout(() => setFlash(false), 180);
        setExecDiag((prev) => {
          const line = `fire · Δ${variance >= 0 ? "+" : ""}${variance.toFixed(1)}ms · t+${horizon} · ping ${ping.toFixed(0)} · drift ${smoothedDrift >= 0 ? "+" : ""}${smoothedDrift.toFixed(0)} · lag ${lag}`;
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
        scheduleRender();
      },
      onTick: (digit, quote, _e, arrival, sym) => {
        // Isolation guard: a late packet from the previous volatility must
        // never enter this instrument's statistics.
        if (sym !== cfgRef.current.symbol) return;
        const prev = lastArrivalRef.current;
        const gap = prev ? arrival - prev : 0;
        lastArrivalRef.current = arrival;
        if (gap > 0) gapsRef.current!.push(gap);
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
        const staleBudget = Math.max(
          cfgRef.current.safeGapMs,
          gapsRef.current!.median() * 1.6,
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
        const visible = typeof document === "undefined" || document.visibilityState === "visible";
        if (visible) setLastPrice(quote);
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
            tickStreamRef.current?.next({ digit: latest.digit, ts: performance.now() });
            resolveSims(latest.digit);
            // Rate limiter: never run the main-thread gate evaluation more
            // than once per 180ms. A burst of queued ticks (multi-window
            // wake-up, 1s indices) can otherwise stack synchronous work and
            // lock the UI thread. The newest tick always wins.
            const nowMs = performance.now();
            if (!isStale && nowMs - lastEvalRef.current >= 180) {
              lastEvalRef.current = nowMs;
              evaluateAndMaybeFire();
            }
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
      onTimeSync: (drift) => {
        // 5-tick EMA smoothing — keeps the visual countdown free of jitter.
        const smoothed = drift * 0.4 + smoothedDriftRef.current * 0.6;
        smoothedDriftRef.current = smoothed;
        driftMsRef.current = smoothed;
        setDriftMs(smoothed);
        // Safety-abort latch: engage above 1000ms, release only under 400ms.
        const mag = Math.abs(smoothed);
        if (!syncingRef.current && mag > 1000) {
          syncingRef.current = true;
          setSyncing(true);
        } else if (syncingRef.current && mag < 400) {
          syncingRef.current = false;
          setSyncing(false);
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

  // Use null sentinel so digit 0 is never confused with "no data". All downstream
  // checks must use strict null/undefined comparisons (digit !== null && digit !== undefined),
  // never truthy checks like `if (lastDigit)` which would drop a legitimate 0.
  const lastDigit: number | null =
    buf.length > 0 && buf[buf.length - 1] !== undefined ? buf[buf.length - 1] : null;

  const health: NetHealth =
    pingMs === 0 ? "yellow" : pingMs > cfg.safePingMs ? "red" : pingMs > 250 ? "yellow" : "green";
  healthRef.current = health;

  // Execution safety guard
  const lastGapNow = lastArrivalRef.current ? performance.now() - lastArrivalRef.current : 0;
  const gapBudgetNow = Math.max(cfg.safeGapMs, gapsRef.current!.median() * 1.6);
  const safe = pingMs > 0 && pingMs <= cfg.safePingMs && lastGapNow <= gapBudgetNow;

  // Expected next-tick countdown (median inter-tick gap minus elapsed)
  const tickInterval = gapsRef.current!.median() || 2000;
  const countdownMs = Math.round(Math.max(0, tickInterval - lastGapNow));
  const purchaseInMs = countdownMs - cfg.latencyOffsetMs;
  // suppress unused-tick warning
  void tick;

  // ---- HORIZON FORECAST (async from the worker; local fallback on cold start)
  const horizonFc = useMemo(
    () => engineReport?.horizon ?? forecastHorizon(buf, cfg.symbol, 10, 0.35),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engineReport, tickKey, cfg.symbol],
  );
  const horizonTicks = horizonFc.horizon;

  // ---- LAYERED ENSEMBLE (Layer 1 momentum / Layer 2 filters / Layer 3 breakers)
  // Target = the digit most likely to REPEAT inside the executed 3-tick span,
  // already compensated for Deriv's 1-tick (first buy) / 2-tick (running) jump.
  const targetDigit = cfg.market === "matches" ? cfg.predictDigit : horizonFc.topDigit;
  const targetMulti = horizonFc.multi[targetDigit];
  void targetMulti;
  const runFc = horizonFc.runs?.[targetDigit];
  const runProb = runFc?.pRunSafe ?? 0;
  const consecutiveProb = runFc?.pConsecutive ?? 0;
  const targetN = runFc && runFc.pTriple >= 0.3 ? 3 : 2;

  const preF = context.pre.forecasts[targetDigit];
  const intervalCv =
    engineReport && engineReport.intervalMs > 0
      ? engineReport.intervalStdMs / engineReport.intervalMs
      : 0;

  // TRIGGER RULES panel — every enabled percentage rule must be satisfied.
  const ruleHits = useMemo(
    () => (derived.win.length >= 10 ? evaluateRules({ window: derived.win, cfg }) : []),
    [derived.win, cfg],
  );
  const rulesSatisfied = enabledRuleCount(cfg) > 0 && allRulesAgree(cfg, ruleHits);
  rulesOkRef.current = rulesSatisfied;


  const layered = evaluateLayeredEnsemble({
    window: derived.win,
    target: targetDigit,
    posterior: context.weighted,
    stepDists: horizonFc.stepDists ?? [],
    horizon: horizonTicks,
    runProb,
    consecutiveProb,

    bigrams: derived.bigrams,
    trigrams: derived.trigrams,
    chiUnif: derived.chi,
    chiIndep: derived.chiIndep,
    intervalCv,
    pingMs,
    safePingMs: cfg.safePingMs,
    health,
    stale,
    syncing,
    neutralFallback: horizonFc.neutralFallback,
    exhausted: preF?.isExhaustedState ?? false,
  });

  // The Bayesian Fusion confidence bar now reflects the weighted layer vote.
  const gateConf = layered.confidence;
  confRef.current = gateConf;
  layeredRef.current = layered;

  // Worst-case market probability across every tick the contract can settle on
  // (t+1..t+4), so a one- or two-tick jump cannot invalidate the call.
  const mkt = horizonFc.market;
  const marketEdge =
    cfg.market === "matches"
      ? runProb
      : cfg.market === "overunder"
        ? Math.max(mkt?.overProb?.[cfg.barrier] ?? 0, mkt?.underProb?.[cfg.barrier] ?? 0)
        : cfg.market === "evenodd"
          ? Math.max(mkt?.even ?? 0, mkt?.odd ?? 0)
          : Math.max(derived.rf.up, derived.rf.down);
  // Matches needs a real repeat edge; directional markets need a robust majority.
  const edgeFloor = cfg.market === "matches" ? 0.3 : 0.6;

  const greenBase =
    !layered.blocked &&
    safe &&
    !horizonFc.neutralFallback &&
    meetsExecutionFloor(gateConf) &&
    rulesSatisfied &&
    marketEdge >= edgeFloor;




  // Second-Run Persistence Shield — hold the green card lit across the whole
  // forecast run so a missed first tick can still be struck on the next one.
  {
    const latch = streakLatchRef.current;
    const runLen = Math.max(targetN, preF?.predictedStreakLength ?? 0);
    if (greenBase && (!latch || latch.digit !== targetDigit)) {
      streakLatchRef.current = {
        digit: targetDigit,
        of: Math.max(2, Math.min(7, runLen)),
        startTick: totalTicksRef.current,
      };
    } else if (
      latch &&
      (latch.digit !== targetDigit ||
        totalTicksRef.current - latch.startTick >= latch.of ||
        syncing ||
        health === "red")
    ) {
      streakLatchRef.current = null;
    }
  }
  const latchNow = streakLatchRef.current;
  const streakInfo = latchNow
    ? {
        step: Math.min(latchNow.of, totalTicksRef.current - latchNow.startTick + 1),
        of: latchNow.of,
      }
    : null;

  const cardState: SignalState = syncing ? "violet" : greenBase || latchNow ? "green" : "red";

  // Latency-corrected time until the multi-appearance window opens.
  const windowInMs = (() => {
    const smoothedDrift = smoothedDriftRef.current;
    const offset = (horizonTicks - 1) * tickInterval;
    const lag = cfg.latencyOffsetMs + cfg.reactionOffsetMs;
    const base = countdownMs + offset - pingMs - lag;
    return smoothedDrift < 0 ? base + smoothedDrift : base - smoothedDrift;
  })();
  // 1-tick pre-warning: flash exactly 1000ms before the window opens.
  const preWarn = windowInMs > 0 && windowInMs <= 1000;


  const setPartial = useCallback((patch: Partial<AppConfig>) => {
    setCfg((c) => ({ ...c, ...patch }));
  }, []);

  // ---- Deriv OAuth: no token typing. Deriv redirects back with token1=... ----
  const connectDeriv = useCallback(() => {
    const appId = (import.meta.env["VITE_DERIV_APP_ID"] as string | undefined) ?? "1089";
    const redirect = window.location.origin + window.location.pathname;
    window.location.href =
      `https://oauth.deriv.com/oauth2/authorize?app_id=${encodeURIComponent(appId)}` +
      `&l=en&brand=deriv&redirect_uri=${encodeURIComponent(redirect)}`;
  }, []);

  const disconnectDeriv = useCallback(() => {
    setToken("");
    saveToken("");
    clientRef.current?.setToken(null);
    setAuth(null);
    setAutoFire(false);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("token1");
    if (!t) return;
    setToken(t);
    saveToken(t);
    clientRef.current?.setToken(t);
    window.history.replaceState({}, "", window.location.pathname);
  }, []);

  useEffect(() => {
    if (token) clientRef.current?.setToken(token);
  }, [token]);

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
      const label = `${contractType}${barrier !== undefined ? " " + barrier : ""}`;
      const detail = res.ok
        ? `stake ${res.buyPrice?.toFixed(2)} · payout ${res.payout?.toFixed(2)}`
        : String(res.error);
      setLastBuyResult(res.ok ? `✓ ${label} · ${detail}` : `✗ ${detail}`);
      setOrders((o) => [{ id: Date.now() + Math.random(), ts: Date.now(), label, ok: res.ok, detail }, ...o].slice(0, 12));
    },
    [auth, cfg.symbol, cfg.stake, cfg.duration],
  );

  // ---- Planned contract derived from the active market + forecast target ----
  // Direction comes from the jump-robust (worst-tick) probabilities so the side
  // stays valid whether the contract settles on t+1, t+2, t+3 or t+4.
  const planned = useMemo<{ type: ContractType; label: string; barrier?: number }>(() => {
    switch (cfg.market) {
      case "overunder":
        return (mkt?.overProb?.[cfg.barrier] ?? 0) >= (mkt?.underProb?.[cfg.barrier] ?? 0)
          ? { type: "DIGITOVER", label: `OVER ${cfg.barrier}`, barrier: cfg.barrier }
          : { type: "DIGITUNDER", label: `UNDER ${cfg.barrier}`, barrier: cfg.barrier };
      case "evenodd":
        return (mkt?.even ?? 0.5) >= (mkt?.odd ?? 0.5)
          ? { type: "DIGITEVEN", label: "EVEN" }
          : { type: "DIGITODD", label: "ODD" };
      case "risefall":
        return derived.rf.up >= derived.rf.down
          ? { type: "CALL", label: "RISE" }
          : { type: "PUT", label: "FALL" };
      default:
        return { type: "DIGITMATCH", label: `MATCH ${targetDigit}`, barrier: targetDigit };
    }
  }, [cfg.market, cfg.barrier, mkt, derived.rf, targetDigit]);


  // ---- AUTO-FIRE: send a live order the instant the strict gate passes ----
  const gateReady = greenBase && !syncing && health !== "red";
  useEffect(() => {
    if (!autoFire || !auth || !gateReady || buyBusy) return;
    if (totalTicksRef.current - lastFireTickRef.current < Math.max(3, horizonTicks)) return;
    lastFireTickRef.current = totalTicksRef.current;
    void handleBuy(planned.type, planned.barrier);
  }, [autoFire, auth, gateReady, buyBusy, planned, handleBuy, horizonTicks]);

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
          <span
            title={connDetail}
            className={`rounded border px-2 py-0.5 text-[10px] font-mono ${
              connState === "live" && connected
                ? "border-cyan text-cyan"
                : connState === "offline"
                  ? "border-danger text-danger"
                  : "border-warning text-warning animate-pulse"
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

      <div className="space-y-3">
        <NetworkBadge health={health} pingMs={pingMs} driftMs={driftMs} ticks={totalTicksRef.current} stale={stale} />

        {/* PERIPHERAL SIGNAL BLOCK — the only thing a trader needs mid-setup */}
        <SignalCard
          state={cardState}
          digit={targetDigit}
          runProb={runProb}
          targetN={targetN}
          horizon={horizonTicks}
          windowInMs={windowInMs}
          preWarn={preWarn}
          streak={streakInfo}
          smoothedDrift={smoothedDriftRef.current}
        />

        <OrderExecutionPanel
          auth={auth}
          connected={connected}
          autoFire={autoFire}
          onAutoFireChange={setAutoFire}
          onConnect={connectDeriv}
          onDisconnect={disconnectDeriv}
          planned={planned}
          stake={cfg.stake}
          durationTicks={cfg.duration}
          gateReady={gateReady}
          confidence={gateConf}
          rulesSatisfied={rulesSatisfied}
          networkOk={health !== "red"}
          busy={buyBusy}
          orders={orders}
        />

        {/* Human Reaction Offset — compensates manual finger-tap delay */}
        <div className="rounded-lg border border-border bg-card px-3 py-2">
          <div className="mb-1 flex items-center justify-between text-[11px]">
            <span className="font-semibold">Human Reaction Offset</span>
            <span className="font-mono text-cyan">{cfg.reactionOffsetMs} ms</span>
          </div>
          <input
            type="range"
            min={0}
            max={1200}
            step={25}
            value={cfg.reactionOffsetMs}
            onChange={(e) => setPartial({ reactionOffsetMs: Number(e.target.value) })}
            className="w-full accent-[var(--color-cyan)]"
            aria-label="Human Reaction Offset in milliseconds"
          />
        </div>

        <MultiAppearancePanel horizon={horizonFc} target={targetDigit} />

        <details className="rounded-lg border border-border bg-card px-3 py-2">
          <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-widest text-cyan">
            Analytics detail
          </summary>
          <div className="mt-2 space-y-3">
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
            <PreArrivalPanel
              forecasts={context.pre.forecasts}
              physics={context.pre.physics}
              topDigit={context.pre.topDigit}
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
            <MarkovMatrix matrix={derived.mk} lastDigit={lastDigit} predict={horizonFc.topDigit} />
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
          </div>
        </details>

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
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="font-semibold">Execution Diagnostics</span>
            <span className="rounded border border-input px-1.5 py-0.5 text-right font-mono text-[9px] text-muted-foreground">
              nextTick + {(horizonTicks - 1)}×Δt − ping {smoothedDriftRef.current < 0 ? "+" : "−"} |drift| − lag(
              {cfg.latencyOffsetMs + cfg.reactionOffsetMs}ms)
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
