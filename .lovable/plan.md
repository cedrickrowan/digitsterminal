## Add Network Anomaly Guard (Slippage + Bunching Filter)

Add a defensive network filter to the web app that detects unsafe execution windows and blocks trading signals (but keeps ticks flowing for charts/stats).

### What it detects

- **Slippage**: `localMs/1000 - tick.epoch` > 1.2s → tick arrived too late vs server time.
- **Bunching**: gap since previous tick < 100ms → packets arrived in a burst (network catch-up).
- **Lockout**: 3 anomalies → suppress signals for 5 minutes. Counter decays by 0.1 per clean tick.

### Changes

**`src/lib/deriv/derivClient.ts`**
- In `onTick` handler, compute `slippageMs` (using `arrivalMs` vs `tick.epoch*1000`, corrected by existing `driftMs`) and `bunchingMs` (delta vs previous tick arrival).
- Pass both to a new event `onNetGuard?(slippageMs, bunchingMs)` alongside the existing `onTick`.

**`src/lib/deriv/netGuard.ts`** (new)
- Pure state machine: `evaluate({slippageMs, bunchingMs}) → { anomaly, reason, counter, lockedUntil, safe }`.
- Thresholds as constants: `SLIPPAGE_MS=1200`, `BUNCH_MS=100`, `LOCKOUT_MS=300_000`, `ANOMALY_LIMIT=3`, `DECAY=0.1`.

**`src/components/digits/DigitsApp.tsx`**
- Wire `onNetGuard` into a `netGuard` ref + state (`{safe, reason, lockedUntil, counter}`).
- **Signal blocking only**: when `!safe`, skip `evaluateRules` / trigger alerts / audio. Charts, digit grid, Markov, ensemble math all keep updating.
- Pass guard state to `NetworkBadge`.

**`src/components/digits/NetworkBadge.tsx`**
- When locked out: show red `UNSAFE · Xs` chip with reason (`SLIPPAGE` / `BUNCHING`).
- When anomaly counter > 0 but not locked: show amber `⚠ N/3` chip.
- Otherwise unchanged.

### Not changed

- Python script (out of scope per your choice).
- Prediction math, Markov, Poisson filter, UI layout.
- Tick ingestion — every tick still feeds stats.

### Technical notes

- Slippage uses `Date.now()/1000 - tick.epoch - driftMs/1000` so an out-of-sync local clock doesn't cause false blocks.
- First tick after (re)connect has no `bunchingMs` baseline → skipped for bunching check.
- Lockout timer is wall-clock (`Date.now()`), rendered via a 1s interval already used by the badge.
