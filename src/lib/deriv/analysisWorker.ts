/// <reference lib="webworker" />
// Background analysis Web Worker — keeps the FIFO ring buffer, higher-order
// Markov, entropy-decay, and time-seed math off the mobile UI thread so the
// live terminal ticks stay smooth on low-end devices (target < 5ms).
// Also runs the full Digits Navigator corrected engine (exact DP hit-count
// probabilities, M^D landing, fatigue filter, runs/KL/KS/AMI/LZW/CUSUM).

import { DigitEngine, type EngineReport } from "./engine";
import { DigitsEngine, type EngineResult } from "./navigator";
import type { AppConfig } from "./types";

type InMsg =
  | { type: "init"; lookback: number; seed: number[] }
  | { type: "lookback"; lookback: number }
  | { type: "tick"; digit: number; ts: number; cfg: AppConfig; rttMs?: number }
  | { type: "reset"; lookback: number }
  | { type: "navSeed"; digits: number[] };

type OutMsg =
  | { type: "report"; report: EngineReport }
  | { type: "nav"; result: EngineResult | null };

let engine: DigitEngine | null = null;
let navEngine: DigitsEngine | null = null;

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
      navEngine = new DigitsEngine();
      break;
    case "navSeed":
      // Seed the navigator's exact 100-digit FIFO buffer from history.
      if (!navEngine) navEngine = new DigitsEngine();
      navEngine.seed(msg.digits.filter((d) => d >= 0 && d <= 9).slice(-100));
      break;
    case "tick": {
      if (!engine) engine = new DigitEngine(50);
      engine.push(msg.digit, msg.ts);
      const report = engine.analyze(msg.cfg);
      const out: OutMsg = { type: "report", report };
      (self as unknown as Worker).postMessage(out);

      // Digits Navigator corrected engine — full calculation per tick.
      if (!navEngine) navEngine = new DigitsEngine();
      const nav = navEngine.calculate({
        price: 0,
        pip: 0,
        epoch: msg.ts,
        duration: msg.cfg.duration,
        symbol: msg.cfg.symbol,
        rttMs: msg.rttMs,
        digit: msg.digit,
      });
      const navOut: OutMsg = { type: "nav", result: nav };
      (self as unknown as Worker).postMessage(navOut);
      break;
    }
  }
};

export {}; // ensure module scope
