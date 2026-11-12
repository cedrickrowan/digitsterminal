import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Subject } from "rxjs";
import { auditTime } from "rxjs/operators";
import { DerivClient, decimalsForSymbol, type AuthInfo, type ConnState, type ContractType } from "@/lib/deriv/derivClient";
import { fetchScanHistories } from "@/lib/deriv/scanner";
import { SYMBOLS } from "@/lib/deriv/types";
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
  sequenceFollowups,
} from "@/lib/deriv/stats";
// eslint-disable-next-line @typescript-eslint/no-duplicate-imports
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
import { ScannerPanel, type ScanRow } from "./ScannerPanel";
import { DigitBadges } from "./DigitBadges";
import { SessionScorecard } from "./SessionScorecard";
import type { EngineResult } from "@/lib/deriv/navigator";
import { isFeedSafe, isNavigatorAlertEligible } from "@/lib/deriv/alertSafety";


const MAX_BUFFER = 900;

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
  const connectedRef = useRef(connected);
  const staleRef = useRef(stale);
  connectedRef.current = connected;
  staleRef.current = stale;
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
  const tickStreamRef = useRef<Subject<{ digit: number; ts: number; tickId: number; rtt: number; quote: number; pip: number }> | null>(null);
  const hiddenSinceRef = useRef<number>(0);
  const [engineReport, setEngineReport] = useState<EngineReport | null>(null);
  const [engineLog, setEngineLog] = useState<string[]>([]);
  // Digits Navigator corrected engine — exact DP probabilities per tick.
  const [navResult, setNavResult] = useState<EngineResult | null>(null);
  // Navigator buffer seeding progress (dynamic lookback-sized buffer).
  const [navStatus, setNavStatus] = useState<{ filled: number; size: number }>({ filled: 0, size: 100 });
  // Multi-market scanner state.
  const [scanRows, setScanRows] = useState<ScanRow[]>([]);
  const [scanning, setScanning] = useState(false);
  const scanningRef = useRef(false);
  const scanPendingRef = useRef(0);
  const navReadyAtRef = useRef(0); // performance.now() of the last READY alert
  const navWasReadyRef = useRef(false);
  const navResultRef = useRef<EngineResult | null>(null);
  // Execution diagnostics — post-tick timing variance vs the scheduled fire.
  const [execDiag, setExecDiag] = useState<string[]>([]);
  const nextFireAtRef = useRef<number>(0); // performance.now() target for next scheduled fire
  const fireTimerRef = useRef<number | null>(null);
  const alertTickIdRef = useRef(0);
  // LIFO tick coalescer — if multiple tick packets are queued in the same
  // task, only the newest wins. Older packets are discarded before analysis.
  const pendingTickRef = useRef<{ digit: number; quote: number; arrival: number; epoch: number; tickId: number } | null>(null);
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

  // Countdown ticker at 30fps for smooth live timing on mobile displays.
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => (t + 1) & 0x3fffffff), 33);
    return () => clearInterval(id);
  }, []);

  const cancelLeadUpFire = useCallback(() => {
    if (fireTimerRef.current !== null) {
      window.clearTimeout(fireTimerRef.current);
      fireTimerRef.current = null;
    }
    nextFireAtRef.current = 0;
  }, []);

  /** SINGLE legacy lead-up scheduler — the only place an audible fire is
   *  scheduled. Target = next expected tick arrival − (ping + drift +
   *  configured latency offset), on performance.now() so wall-clock jitter
   *  can't skew it. One pending fire at a time: re-arming clears the old
   *  timer, so a navigator READY and a legacy trigger can never double-beep. */
  const scheduleLeadUpFire = useCallback(() => {
    const cfgNow = cfgRef.current;
    const now = performance.now();
    const interval = cadenceOf(cfgNow.symbol, gapsRef.current?.median() ?? 0);
    const sinceLast = lastArrivalRef.current ? now - lastArrivalRef.current : 0;
    const nextTickIn = Math.max(0, interval - sinceLast);
    const ping = medianOf(pingMedianRef.current);
    const drift = Math.abs(driftMsRef.current);
    const lag = cfgNow.latencyOffsetMs;
    const target = now + Math.max(0, nextTickIn - ping - drift - lag);
    cancelLeadUpFire();
    nextFireAtRef.current = target;
    fireTimerRef.current = window.setTimeout(() => {
      fireTimerRef.current = null;
      const currentNav = navResultRef.current;
      const elapsedSinceReady = navWasReadyRef.current && navReadyAtRef.current > 0
        ? performance.now() - navReadyAtRef.current
        : Number.POSITIVE_INFINITY;
      const currentInterval = cadenceOf(cfgRef.current.symbol, gapsRef.current?.median() ?? 0);
      const currentSinceTick = lastArrivalRef.current
        ? performance.now() - lastArrivalRef.current
        : currentInterval;
      const currentBuyWindow = currentInterval - currentSinceTick - cfgRef.current.latencyOffsetMs;
      const currentPing = medianOf(pingMedianRef.current);
      const currentCfg = cfgRef.current;
      const currentGapBudget = Math.max(
        currentCfg.safeGapMs,
        cadenceOf(currentCfg.symbol, gapsRef.current?.median() ?? 0) * 1.6,
      );
            const feedSafe = isFeedSafe({
        connected: connectedRef.current,
        staleGap: staleRef.current,
        symbol: currentCfg.symbol,
        rttMs: medianOf(pingMedianRef.current),
        lastArrivalAt: lastArrivalRef.current,
        now: performance.now(),
        gapBudgetMs: currentGapBudget,
      });
      if (
        !armedRef.current ||
        !feedSafe ||
        !currentNav ||
        currentNav.alertDecision !== "READY / MANUAL ALERT" ||
        elapsedSinceReady >= (currentNav.executionCutoffMs ?? 600) ||
        currentBuyWindow <= 0 ||
        currentPing <= 0 ||
        currentPing >= currentNav.pingThresholdMs
      ) {
        nextFireAtRef.current = 0;
        return;
      }

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
  }, [cancelLeadUpFire]);

  // Spin up the analysis Web Worker + RxJS tick stream once. The worker owns
  // the FIFO ring buffer, higher-order Markov, entropy-decay and time-seed
  // math so the mobile UI thread stays free.
  useEffect(() => {
    const worker = new Worker(new URL("../../lib/deriv/analysisWorker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    worker.postMessage({ type: "init", lookback: cfgRef.current.lookback, seed: [] });
    worker.onmessage = (e: MessageEvent<{
      type: string;
      report?: EngineReport;
      result?: EngineResult | null;
      filled?: number;
      size?: number;
      symbol?: string;
      rttMs?: number;
    }>) => {
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
      if (e.data?.type === "navStatus") {
        setNavStatus({ filled: e.data.filled ?? 0, size: e.data.size ?? 0 });
        if ((e.data.filled ?? 0) < (e.data.size ?? 0)) {
          cancelLeadUpFire();
          navResultRef.current = null;
          navWasReadyRef.current = false;
          navReadyAtRef.current = 0;
          setNavResult(null);
        }
        return;
      }
      if (e.data?.type === "scanResult" && e.data.symbol) {
        const symbol = e.data.symbol;
        const rttMs = e.data.rttMs ?? 0;
        const result = e.data.result ?? null;
        const latencyOk = rttMs > 0 && rttMs < pingLimitFor(symbol);
        setScanRows((prev) =>
          prev.map((r) =>
            r.symbol === symbol
              ? {
                  ...r,
                  pending: false,
                  ok: !!result,
                  error: result ? undefined : "no signal",
                  score: result?.marketScore ?? 0,
                  edge: result?.marketEdge ?? 0,
                  recProb: result?.marketRecProb ?? 0,
                  action: result?.marketAction ?? "",
                  rttMs,
                  latencyOk,
                }
              : r,
          ),
        );
        scanPendingRef.current = Math.max(0, scanPendingRef.current - 1);
        if (scanPendingRef.current === 0) {
          scanningRef.current = false;
          setScanning(false);
        }
        return;
      }
      if (e.data?.type === "nav") {
        const nav = e.data.result ?? null;
        if (nav && nav.tickId !== totalTicksRef.current) return;
        const currentCfg = cfgRef.current;
        const currentGapBudget = Math.max(
          currentCfg.safeGapMs,
          cadenceOf(currentCfg.symbol, gapsRef.current?.median() ?? 0) * 1.6,
        );
        const feedSafe = isFeedSafe({
          connected: connectedRef.current,
          staleGap: staleRef.current,
          symbol: currentCfg.symbol,
          rttMs: medianOf(pingMedianRef.current),
          lastArrivalAt: lastArrivalRef.current,
          now: performance.now(),
          gapBudgetMs: currentGapBudget,
        });
        const wasReady = navWasReadyRef.current;
        const winNow = bufRef.current ? bufRef.current.lastN(currentCfg.lookback) : [];
        const legacyHitsNow = winNow.length >= 10 ? evaluateRules({ window: winNow, cfg: currentCfg }) : [];
        const legacyPassNow = allRulesAgree(currentCfg, legacyHitsNow);
        const ready = isNavigatorAlertEligible(nav, currentCfg, feedSafe, totalTicksRef.current, legacyPassNow);
        const displayNav =
          nav && !feedSafe && nav.alertDecision === "READY / MANUAL ALERT"
            ? { ...nav, alertDecision: "HOLD / UNSAFE LATENCY" as const }
            : nav;
        navResultRef.current = displayNav;
        setNavResult(displayNav);
                        if (ready) {
          // A fresh worker result for a new tick starts a fresh 600ms response window.
          navReadyAtRef.current = performance.now();
          alertTickIdRef.current = nav?.tickId ?? 0;
          navWasReadyRef.current = true;
          if (armedRef.current && feedSafe) {
            cancelLeadUpFire();
            beep();
            setFlash(true);
            window.setTimeout(() => setFlash(false), nav?.executionCutoffMs ?? 600);
          }
        }

        if (ready && !wasReady) {
          // New READY alert: start the strict 600 ms human-response window,
          // visual flash for the whole window + the SINGLE lead-up beep
          // scheduled at next tick arrival − ping − drift − latency offset.
          setSignals((prev) => [
            ...prev.slice(-40),
            {
              id: Date.now() + Math.random(),
              ts: Date.now(),
              reason: `NAV READY · digit ${nav!.navTargetDigit} · rules ${nav!.navRulesEnabled ? "AND-met" : "default floor"} · edge ${(nav!.marketEdge * 100).toFixed(1)}%`,
              predicted: nav!.navTargetDigit,
              market: cfgRef.current.market,
              expected: nav!.marketRecProb,
              mode: cfgRef.current.mode,
            },
          ]);
        } else if (!ready && navWasReadyRef.current) {
          cancelLeadUpFire();
          navReadyAtRef.current = 0;
          navWasReadyRef.current = false;
        } else if (!ready) {
          cancelLeadUpFire();
        }
      }
    };

    const stream = new Subject<{ digit: number; ts: number; tickId: number; rtt: number; quote: number; pip: number }>();
    tickStreamRef.current = stream;
    // auditTime coalesces bursts so a wake-up backlog can't spam the worker.
    const sub = stream.pipe(auditTime(0)).subscribe(({ digit, ts, tickId, rtt, quote, pip }) => {
      worker.postMessage({ type: "tick", digit, ts, tickId, cfg: cfgRef.current, rttMs: rtt, quote, pip });
    });
    return () => {
      cancelLeadUpFire();
      sub.unsubscribe();
      stream.complete();
      worker.terminate();
      workerRef.current = null;
      tickStreamRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cancelLeadUpFire, scheduleLeadUpFire]);

  // Notify the worker when the user changes lookback: the analysis ring AND
  // the navigator buffer both resize, and the navigator is re-seeded from the
  // main-thread ring so it doesn't wait for 100 fresh live ticks.
  useEffect(() => {
    workerRef.current?.postMessage({ type: "lookback", lookback: cfg.lookback });
    workerRef.current?.postMessage({ type: "navLookback", size: cfg.lookback });
    const seed = bufRef.current!.lastN(cfg.lookback);
    if (seed.length > 0) {
      workerRef.current?.postMessage({ type: "navSeed", digits: seed, size: cfg.lookback });
    }
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
    navResultRef.current = null;
    cancelLeadUpFire();
    setOpenEntry(null);
    setMatched(false);
    setLastPrice(null);
    setStale(false);
    workerRef.current?.postMessage({ type: "reset", lookback: cfgRef.current.lookback });
    scheduleRender();
  }, [cancelLeadUpFire, scheduleRender]);

  const evaluateAndMaybeFire = useCallback(() => {
    const cfgNow = cfgRef.current;
    // Navigator is the sole source of alert-mode READY; legacy triggers may
    // still drive simulated entries but cannot bypass Navigator confluence.
    if (cfgNow.mode === "alert") return;
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
      expected: confRef.current,
      mode: cfgNow.mode,
    };

    if (!armedRef.current) {
      pushSignal(sig);
      return;
    }

    const median = medianOf(pingMedianRef.current);
    const lastGap = lastArrivalRef.current ? performance.now() - lastArrivalRef.current : Number.POSITIVE_INFINITY;
    // Slow feeds (2s indices, polled fallback) legitimately exceed the raw
    // 800ms guard — scale the gap budget to the observed tick cadence.
    const gapBudget = Math.max(cfgNow.safeGapMs, cadenceOf(cfgNow.symbol, gapsRef.current!.median()) * 1.6);
    const networkUnsafe = !isFeedSafe({
      connected: connectedRef.current,
      staleGap: staleRef.current,
      symbol: cfgNow.symbol,
      rttMs: median,
      lastArrivalAt: lastArrivalRef.current,
      now: performance.now(),
      gapBudgetMs: gapBudget,
    });

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
  }, [pushSignal, scheduleLeadUpFire]);

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
      onClose: () => {
        cancelLeadUpFire();
        setConnected(false);
      },
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
        // Navigator engine seeds its lookback-sized buffer from history.
        workerRef.current?.postMessage({ type: "navSeed", digits: clean.slice(-(cfgRef.current.lookback)), size: cfgRef.current.lookback });
        scheduleRender();
      },
      onTick: (digit, quote, _e, arrival, sym) => {
        // Isolation guard: a late packet from the previous volatility must
        // never enter this instrument's statistics.
        if (sym !== cfgRef.current.symbol) return;
        // A fresh arrival invalidates a timer scheduled for the previous tick.
        cancelLeadUpFire();
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
          clientRef.current?.subscribeTicks(cfgRef.current.symbol, 900);
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
        pendingTickRef.current = { digit, quote, arrival, epoch: 0, tickId: totalTicksRef.current };
        if (!coalesceScheduledRef.current) {
          coalesceScheduledRef.current = true;
          queueMicrotask(() => {
            coalesceScheduledRef.current = false;
            const latest = pendingTickRef.current;
            pendingTickRef.current = null;
            if (!latest) return;
            // Fan the newest tick into the worker analysis engine.
            tickStreamRef.current?.next({
              digit: latest.digit,
              ts: performance.now(),
              tickId: latest.tickId,
              rtt: medianOf(pingMedianRef.current),
              quote: latest.quote,
              pip: clientRef.current?.getPipSize() ?? decimalsForSymbol(cfgRef.current.symbol),
            });
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
  }, [cancelLeadUpFire, evaluateAndMaybeFire, pushSignal, resolveSims, scheduleRender, token]);

  const handleDisconnect = useCallback(() => {
    cancelLeadUpFire();
    clientRef.current?.disconnect();
    clientRef.current = null;
    setConnected(false);
  }, [cancelLeadUpFire]);

  useEffect(() => {
    handleConnect();
    return () => clientRef.current?.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "hidden") {
        cancelLeadUpFire();
        hiddenSinceRef.current = performance.now();
      } else if (document.visibilityState === "visible") {
        // Keep marker set; onTick will use it to detect the wake-burst.
        if (!clientRef.current) handleConnect();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [cancelLeadUpFire, handleConnect]);

  // Symbol switch: wipe every statistic so the new volatility is analysed
  // from a completely fresh state (no cross-instrument contamination).
  useEffect(() => {
    if (!connected || !clientRef.current) return;
    resetAnalysis();
    clientRef.current.subscribeTicks(cfg.symbol, 900);
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
    const followHorizon = Math.max(1, cfg.duration);
    const followPrefix: number[] | null =
      buf.length >= 1 ? buf.slice(-Math.min(followHorizon, buf.length)) : null;
    const follow = followPrefix
      ? sequenceFollowups(win, followPrefix, followHorizon)
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
  const pip = clientRef.current?.getPipSize() ?? decimalsForSymbol(cfg.symbol);
  const serverTime = new Date(Date.now() + driftMs).toISOString().slice(11, 19);
  // Live "Next tick in" / "Buy now if ≤" countdown (restored): the lead window
  // closes latencyOffsetMs before the next expected tick — TOO LATE past that.
  const tickInterval = cadenceOf(cfg.symbol, gapsRef.current!.median());
  const countdownMs = Math.round(Math.max(0, tickInterval - lastGapNow));
  const purchaseInMs = countdownMs - cfg.latencyOffsetMs;
  // Navigator 600 ms human-response window (numeric countdown, no progress bar)
  const navReady = navResult?.alertDecision === "READY / MANUAL ALERT";
  const navElapsed = navReady && navReadyAtRef.current > 0 ? performance.now() - navReadyAtRef.current : 0;
  useEffect(() => {
    if (!navReady) {
      cancelLeadUpFire();
      return;
    }
    if (navElapsed >= (navResult?.executionCutoffMs ?? 600) || purchaseInMs <= 0) {
      cancelLeadUpFire();
    }
  }, [cancelLeadUpFire, navElapsed, navReady, navResult?.executionCutoffMs, purchaseInMs, tick]);
  const navWaiting = navStatus.filled < navStatus.size;
  // suppress unused-tick warning
  void tick;

  const setPartial = useCallback((patch: Partial<AppConfig>) => {
    setCfg((c) => ({ ...c, ...patch }));
  }, []);

  /** Multi-market scanner: fetch a lookback-sized history snapshot for every
   *  synthetic index on a short-lived public WebSocket, then hand each
   *  snapshot to the navigator inside the Web Worker for evaluation. */
  const runScan = useCallback(async () => {
    if (scanningRef.current) return;
    scanningRef.current = true;
    setScanning(true);
    const cfgNow = cfgRef.current;
    const symbols = SYMBOLS.map((s) => s.value);
    setScanRows(
      symbols.map((sym) => ({ symbol: sym, pending: true, ok: false, score: 0, edge: 0, recProb: 0, action: "", rttMs: 0, latencyOk: false })),
    );
    const fetches = await fetchScanHistories(symbols, cfgNow.lookback);
    scanPendingRef.current = 0;
    fetches.forEach((f, idx) => {
      if (!f.ok) {
        setScanRows((prev) =>
          prev.map((r) => (r.symbol === f.symbol ? { ...r, pending: false, ok: false, error: f.error } : r)),
        );
        return;
      }
      scanPendingRef.current++;
      workerRef.current?.postMessage({
        type: "scanEval",
        id: idx,
        symbol: f.symbol,
        digits: f.digits,
        prices: f.prices,
        pip: f.pip,
        duration: cfgNow.duration,
        market: cfgNow.market,
        barrier: cfgNow.barrier,
        rttMs: f.rttMs,
        predictDigit: cfgNow.predictDigit,
        navRules: cfgNow.navRules,
        navThresholds: cfgNow.navThresholds,
      });
    });
    if (scanPendingRef.current === 0) {
      scanningRef.current = false;
      setScanning(false);
    }
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
          nav={navResult}
          ensemble={derived.ens}
          market={cfg.market}
          barrier={cfg.barrier}
          predictDigit={cfg.predictDigit}
          pEven={navResult?.evenOdd ? navResult.evenOdd.pEven : derived.split.pEven}
          pHigh={derived.split.pHigh}
          rise={{ 
            up: navResult?.riseFall ? navResult.riseFall.pRise : derived.rf.up, 
            down: navResult?.riseFall ? navResult.riseFall.pFall : derived.rf.down 
          }}
          safe={safe}
          alertElapsedMs={navElapsed}
          nextTickInMs={countdownMs}
          purchaseInMs={purchaseInMs}
        />

                <PredictedDigit
          digit={cfg.market === "matches" || cfg.market === "differs" ? cfg.predictDigit : context.topDigit}
          entryPrice={openEntry?.price ?? null}
          lastPrice={lastPrice}
          pip={pip}
          matched={matched}
          armed={armed}
          confidence={
            cfg.market === "differs" && navResult?.digits[cfg.predictDigit]
              ? 1 - navResult.digits[cfg.predictDigit].landingProb
              : Math.min(1, (context.weighted[cfg.market === "matches" ? cfg.predictDigit : context.topDigit] ?? 0) * (engineReport?.confidenceAdjust ?? 1))
          }
          highlight={
            cfg.market === "matches"
              ? (context.weighted[cfg.predictDigit] ?? 0) * (engineReport?.confidenceAdjust ?? 1) >= 0.7
              : cfg.market === "differs" && navResult?.digits[cfg.predictDigit]
                ? 1 - navResult.digits[cfg.predictDigit].landingProb >= 0.92
                : false
          }
        />
        <NavigatorPanel
          result={navResult}
          alertElapsedMs={navElapsed}
          waiting={navWaiting}
          filled={navStatus.filled}
          size={navStatus.size}
          market={cfg.market}
          barrier={cfg.barrier}
        />
        <details className="md:col-span-2 rounded-md border border-border bg-card px-3 py-2">
          <summary className="cursor-pointer list-none font-mono text-[11px] font-semibold uppercase tracking-wider text-cyan">
            ▼ ANALYTICS DETAIL
          </summary>
        {(() => {
          return null;
        })()}
        <PreArrivalPanel
          forecasts={context.pre.forecasts}
          physics={context.pre.physics}
          topDigit={context.pre.topDigit}
        />
        <ScannerPanel rows={scanRows} scanning={scanning} market={cfg.market} onScan={runScan} />
        <DigitGrid freq={derived.freq} total={derived.win.length} predict={cfg.predictDigit} />
        <DigitBadges freq={derived.freq} total={derived.win.length} lastDigit={lastDigit} />

                <SplitPanel
          nav={navResult}
          fallback={{ 
            pEven: navResult?.evenOdd ? navResult.evenOdd.pEven : derived.split.pEven, 
            pHigh: derived.split.pHigh, 
            riseUp: navResult?.riseFall ? navResult.riseFall.pRise : derived.rf.up, 
            riseDown: navResult?.riseFall ? navResult.riseFall.pFall : derived.rf.down 
          }}
          hot={derived.hc.hot}
          cold={derived.hc.cold}
          hotFreq={derived.hc.freq}
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
          followHorizon={Math.max(1, cfg.duration)}
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
        <SessionScorecard signals={signals} />
        <EngineLog
          entries={engineLog}
          coreSpeedMs={engineReport?.coreSpeedMs ?? 0}
          intervalMs={engineReport?.intervalMs ?? 0}
          intervalStdMs={engineReport?.intervalStdMs ?? 0}
          entropyDecay={engineReport?.entropyDecay ?? 0}
          bitmask={engineReport?.bitmask ?? 0}
        />
        </details>
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
