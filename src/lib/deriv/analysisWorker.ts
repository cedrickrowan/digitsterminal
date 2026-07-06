/// <reference lib="webworker" />
// Background analysis Web Worker — keeps the FIFO ring buffer, higher-order
// Markov, entropy-decay, and time-seed math off the mobile UI thread so the
// live terminal ticks stay smooth on low-end devices (target < 5ms).

import { DigitEngine, type EngineReport } from "./engine";
import type { AppConfig } from "./types";

type InMsg =
  | { type: "init"; lookback: number; seed: number[] }
  | { type: "lookback"; lookback: number }
  | { type: "tick"; digit: number; ts: number; cfg: AppConfig }
  | { type: "reset"; lookback: number };

type OutMsg = { type: "report"; report: EngineReport };

let engine: DigitEngine | null = null;

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
      break;
    case "tick": {
      if (!engine) engine = new DigitEngine(50);
      engine.push(msg.digit, msg.ts);
      const report = engine.analyze(msg.cfg);
      const out: OutMsg = { type: "report", report };
      (self as unknown as Worker).postMessage(out);
      break;
    }
  }
};

export {}; // ensure module scope
