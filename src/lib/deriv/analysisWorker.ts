/// <reference lib="webworker" />
// Background analysis Web Worker — keeps the FIFO ring buffer, higher-order
// Markov, entropy-decay, and time-seed math off the mobile UI thread so the
// live terminal ticks stay smooth on low-end devices (target < 5ms).
// Also runs the full Digits Navigator corrected engine (exact DP hit-count
// probabilities, M^D landing, fatigue filter, runs/KL/KS/AMI/LZW/CUSUM,
// dynamic lookback-sized buffer, Over/Under · Even/Odd · Rise/Fall horizon
// blocks, and the multi-market scanner snapshot evaluation).

import { DigitEngine, type EngineReport } from "./engine";
import { DigitsEngine, NAV_BUFFER_SIZE, type EngineResult } from "./navigator";
import { assetTypeOf, fusePreArrival, runPreArrivalAnalysis } from "./preArrival";
import { applyContextWeights, hmmState, poissonClusterWeights, priceEma, volatilityState } from "./marketContext";
import type { AppConfig, Market, NavRuleToggles, NavThresholds } from "./types";

type InMsg =
  | { type: "init"; lookback: number; seed: number[] }
  | { type: "lookback"; lookback: number }
  | { type: "tick"; digit: number; ts: number; tickId: number; quote: number; pip: number; cfg: AppConfig; rttMs?: number }
  | { type: "reset"; lookback: number }
  | { type: "navSeed"; digits: number[]; size?: number }
  | { type: "navLookback"; size: number }
  | {
      type: "scanEval";
      id: number;
      symbol: string;
      digits: number[];
      prices: number[];
      pip: number;
      duration: number;
      market: Market;
      barrier: number;
      rttMs: number;
      predictDigit?: number;
      navRules?: NavRuleToggles;
      navThresholds?: NavThresholds;
    };

type OutMsg =
  | { type: "report"; report: EngineReport }
  | { type: "nav"; result: EngineResult | null }
  | { type: "navStatus"; filled: number; size: number }
  | { type: "scanResult"; id: number; symbol: string; rttMs: number; result: EngineResult | null };

let engine: DigitEngine | null = null;
let navEngine: DigitsEngine | null = null;
const workerPrices: number[] = [];
const workerDeltas: number[] = [];

const post = (msg: OutMsg) => (self as unknown as Worker).postMessage(msg);

/** Report navigator buffer seeding progress (filled / size) to the UI. */
const postNavStatus = () => {
  post({ type: "navStatus", filled: navEngine?.filled ?? 0, size: navEngine?.capacity ?? 0 });
};

/** Recreate the navigator when the requested buffer size differs (dynamic
 *  lookback: 25 / 50 / 100). */
const ensureNav = (size: number | undefined) => {
  const target = Math.round(size ?? NAV_BUFFER_SIZE);
  if (!navEngine || navEngine.capacity !== target) navEngine = new DigitsEngine(target);
  return navEngine;
};

self.onmessage = (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  switch (msg.type) {
    case "init":
      engine = new DigitEngine(msg.lookback);
      engine.seed(msg.seed);
      break;
    case "lookback":
      engine?.resizeLookback(msg.lookback);
      break;
    case "reset":
      engine = new DigitEngine(msg.lookback);
      navEngine = new DigitsEngine(msg.lookback);
      workerPrices.length = 0;
      workerDeltas.length = 0;
      postNavStatus();
      break;
    case "navSeed": {
      // Seed the navigator's exact FIFO buffer from history (dynamic size).
      const nav = ensureNav(msg.size);
      nav.seed(msg.digits.filter((d) => d >= 0 && d <= 9).slice(-nav.capacity));
      postNavStatus();
      break;
    }
    case "navLookback": {
      // Lookback changed → fresh navigator at the new size; the UI re-seeds
      // it from the main-thread ring buffer immediately after.
      navEngine = new DigitsEngine(msg.size);
      postNavStatus();
      break;
    }
    case "scanEval": {
      // Multi-market scanner: evaluate a fetched history snapshot on a
      // dedicated throwaway engine (the live buffer is never touched).
      const digits = msg.digits.filter((d) => d >= 0 && d <= 9);
      let result: EngineResult | null = null;
      if (digits.length >= 21) {
        const scanEngine = new DigitsEngine(digits.length);
        result = scanEngine.evaluateSnapshot(digits, msg.prices, {
          price: msg.prices[msg.prices.length - 1] ?? 0,
          pip: msg.pip,
          epoch: 0,
          duration: msg.duration,
          symbol: msg.symbol,
          rttMs: msg.rttMs,
          market: msg.market,
          barrier: msg.barrier,
          predictDigit: msg.predictDigit,
          navRules: msg.navRules,
          navThresholds: msg.navThresholds,
        });
      }
      post({ type: "scanResult", id: msg.id, symbol: msg.symbol, rttMs: msg.rttMs, result });
      break;
    }
    case "tick": {
      if (!engine) engine = new DigitEngine(50);
      engine.push(msg.digit, msg.ts);
      const report = engine.analyze(msg.cfg);
      post({ type: "report", report });

      // Track live prices & deltas inside worker for unified context & physics
      if (Number.isFinite(msg.quote) && msg.quote > 0) {
        if (workerPrices.length > 0) {
          workerDeltas.push(Math.abs(msg.quote - workerPrices[workerPrices.length - 1]));
          if (workerDeltas.length > 64) workerDeltas.shift();
        }
        workerPrices.push(msg.quote);
        if (workerPrices.length > 64) workerPrices.shift();
      }

      // Build unified 10-digit prior from Engine + MarketContext + Pre-Arrival Physics (at exact msg.cfg.duration)
      const snap = engine.snapshot();
      let unifiedPrior: number[] | undefined;
      if (snap.length >= 20) {
        const base = new Array<number>(10);
        let baseSum = 0;
        for (let d = 0; d < 10; d++) {
          const v = 0.5 * (report.higherOrder.order2[d] ?? 0.1) + 0.5 * (report.higherOrder.order3[d] ?? 0.1);
          base[d] = Math.max(1e-4, v);
          baseSum += base[d];
        }
        for (let d = 0; d < 10; d++) base[d] /= baseSum;

        const ema = priceEma(workerPrices);
        const vol = volatilityState(workerDeltas);
        const hmm = hmmState(snap);
        const poissonW = poissonClusterWeights(snap);
        const ctxWeighted = applyContextWeights(base, {
          direction: ema.direction,
          volatility: vol.state,
          hmm: hmm.state,
          poissonWeights: poissonW,
        });
        const pre = runPreArrivalAnalysis(snap, workerDeltas, assetTypeOf(msg.cfg.symbol), msg.cfg.duration);
        unifiedPrior = pre.physics.ready ? fusePreArrival(ctxWeighted, pre.forecasts) : ctxWeighted;
      }

      // Digits Navigator corrected engine — full calculation per tick.
      const nav = ensureNav(msg.cfg.lookback);
      const navResult = nav.calculate({
        price: msg.quote,
        pip: msg.pip,
        epoch: msg.ts,
        tickId: msg.tickId,
        duration: msg.cfg.duration,
        symbol: msg.cfg.symbol,
        rttMs: msg.rttMs,
        digit: msg.digit,
        market: msg.cfg.market,
        barrier: msg.cfg.barrier,
        predictDigit: msg.cfg.predictDigit,
        navRules: msg.cfg.navRules,
        navThresholds: msg.cfg.navThresholds,
        unifiedPrior,
      });
      if (navResult) {
        post({ type: "nav", result: navResult });
      } else {
        // Explicitly clear stale READY state when the navigator has no result.
        post({ type: "nav", result: null });
        postNavStatus();
      }
      break;
        }
      

export {}; // ensure module scope
