// Navigator trigger-rule verification (run: bun src/lib/deriv/navigator.rules.test.ts)
// Covers: strict AND over enabled rules, configurable thresholds (>= semantics),
// alerts targeting the user-selected digit (never an autonomous top-pick),
// the fixed ping gates (<350ms 1s / <500ms plain), and the no-rules fallback.
import { DigitsEngine, type EngineResult } from "./navigator";
import type { NavRuleToggles, NavThresholds } from "./types";

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

const D = 3;
// 25-tick buffer: [0,1,2,3]×6 + [7] — no adjacent repeats, so 0/1/4/5/6/8/9
// stay fresh while 2/3/7 are tired (they sit inside the recent window).
const digits: number[] = [];
for (let i = 0; i < 24; i++) digits.push(i % 4);
digits.push(7);
const prices = digits.map((_, i) => 1000 + i * 0.01);

const allOff: NavRuleToggles = {
  multiHit: false,
  pairRun: false,
  landing: false,
  freshness: false,
  parity: false,
  barrier: false,
  lowEntropy: false,
  antiRepeat: false,
  frequencyEnvelope: false,
  markovD: false,
  hurstFilter: false,
};
const thr: NavThresholds = {
  multiHitPct: 7,
  pairRunPct: 3,
  landingPct: 12,
  parityPct: 55,
  barrierPct: 55,
  entropyZMax: -1,
  frequencyMinPct: 0,
  frequencyMaxPct: 20,
  markovDPct: 12,
  differsProbabilityCeilingPct: 12,
  differsColdGapMin: 5,
  hurstMinEdge: 0.05,
};


function run(target: number, rules: NavRuleToggles, thresholds = thr, symbol = "R_100", rtt = 100): EngineResult {
  const eng = new DigitsEngine(25);
  const r = eng.evaluateSnapshot(digits, prices, {
    price: prices[prices.length - 1],
    pip: 2,
    epoch: 0,
    duration: D,
    symbol,
    rttMs: rtt,
    market: "matches",
    barrier: 4,
    predictDigit: target,
    navRules: rules,
    navThresholds: thresholds,
  });
  if (!r) throw new Error("engine returned null");
  return r;
}

console.log("Digits Navigator trigger rules");
const base = run(0, allOff);
if (!base) {
  console.error("engine returned null — test setup broken");
  process.exit(1);
}
const p0 = base.digits[0].multiHitProb;
console.log(`  measured P(≥2 hits of digit 0 in D=${D}) = ${(p0 * 100).toFixed(2)}%`);

check("all eleven rule lines are reported", base.navRuleHits.length === 11 && base.navRuleHits.every((h) => !!h.label));
check("no rules enabled → legacy default floor", base.navRulesEnabled === false && base.alertDecision === "HOLD / NO SIGNAL");
check("target digit is the user's selection (0)", base.navTargetDigit === 0 && base.navTargetFresh === true);

// Configurable multi-hit threshold: >= semantics, flips READY exactly at the set %.
const rMultiOn = run(0, { ...allOff, multiHit: true }, { ...thr, multiHitPct: Math.max(0, Math.floor(p0 * 100)) });
check("multi-hit ≥ set threshold → READY", rMultiOn.alertDecision === "READY / MANUAL ALERT");
const rMultiHigh = run(0, { ...allOff, multiHit: true }, { ...thr, multiHitPct: Math.min(100, Math.ceil(p0 * 100) + 1) });
check("multi-hit below threshold → HOLD / RULES NOT MET", rMultiHigh.alertDecision === "HOLD / RULES NOT MET");

// Strict AND: freshness must block a tired target even though the engine's
// own top-pick (a fresh digit) would otherwise qualify.
const rTired = run(3, { ...allOff, multiHit: true, freshness: true }, { ...thr, multiHitPct: Math.max(0, Math.floor(p0 * 100)) });
check("tired target blocked by freshness rule", rTired.alertDecision === "HOLD / RULES NOT MET");
check("tired target reported as not fresh", rTired.navTargetDigit === 3 && rTired.navTargetFresh === false);
check("engine top-pick is a fresh digit, not the tired target", rTired.topTargetDigit !== 3 && rTired.freshPool.includes(rTired.topTargetDigit));
const freshHit = rTired.navRuleHits.find((h) => h.rule === "freshness");
check("freshness rule marked failing for digit 3", !!freshHit && freshHit.enabled && !freshHit.pass);

// Strict AND: one passing rule + one failing enabled rule → HOLD.
const rAnd = run(0, { ...allOff, multiHit: true, landing: true }, { ...thr, multiHitPct: Math.max(0, Math.floor(p0 * 100)), landingPct: 100 });
check("one failing enabled rule blocks READY (strict AND)", rAnd.alertDecision === "HOLD / RULES NOT MET");

// Fixed ping gates: 1s indices < 350ms, plain indices < 500ms.
const r1sUnsafe = run(0, { ...allOff, multiHit: true }, { ...thr, multiHitPct: Math.max(0, Math.floor(p0 * 100)) }, "1HZ10V", 400);
check("1s index: 400ms RTT fails the 350ms gate", r1sUnsafe.pingThresholdMs === 350 && !r1sUnsafe.latencyGatePassed && r1sUnsafe.alertDecision === "HOLD / UNSAFE LATENCY");
const rPlainOk = run(0, { ...allOff, multiHit: true }, { ...thr, multiHitPct: Math.max(0, Math.floor(p0 * 100)) }, "R_100", 400);
check("plain index: 400ms RTT passes the 500ms gate", rPlainOk.pingThresholdMs === 500 && rPlainOk.latencyGatePassed && rPlainOk.alertDecision === "READY / MANUAL ALERT");
const rNoRtt = run(0, { ...allOff, multiHit: true }, thr, "R_100", NaN);
check("missing RTT fails closed", !rNoRtt.latencyGatePassed && rNoRtt.alertDecision === "HOLD / UNSAFE LATENCY");

if (failures > 0) {
  console.error(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("all navigator rule checks passed");
