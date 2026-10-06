
## Goal
Build a lightweight, mobile-optimized single-page tool that connects to Deriv's WebSocket API, ingests tick digits for a selected Volatility Index, runs a statistical engine (Markov, chi-squared, Poisson, Shannon entropy, 2-tick sequence matching), and surfaces "Matches" signals with network-safety guardrails. Targeted at Samsung A16 / high-latency networks.

## Scope (single mobile screen, one route)
Implement on `src/routes/index.tsx` as one compact app — no auth, no multi-page nav, no Lovable Cloud (Deriv API token is user-supplied at runtime and stored in LocalStorage only).

## UI layout (mobile-first, minimal DOM)
```
[ Network: ● 142ms  | Server drift: 38ms | Ticks: 1.2k ]
[ Symbol ▼ R_100 ] [ Token ____ Save ] [ Connect / Disc ]
[ Pred digit: 5 ] [ Ticks: 1 ] [ Stake: 1.00 ]
[ Lookback: 25/50/100 ] [ Lat offset: 1000ms ]
[ Trigger: digit=5, streak≥3 OR p<8% ]
[ Mode: Alert | Simulated | Live ]   [ Arm ]

DIGIT GRID 0–9  (freq% + color intensity)
[0 9%][1 11%][2 8%]…  (3-col grid, plain divs, bg via inline alpha)

Recent ticks (last 20):  3 7 1 0 5 …
Stats: χ²=12.4 (p=.19) | H₂₀=3.21 | H₅₀=3.29
2-tick follow-up for "3→7": {0:12%,1:8%,…}
Cold digits: 4 (gap 27, P=5.8%)
Signals log (last 8): timestamp · reason · sim WIN/LOSS
```
All semantic-token Tailwind, no charts, no animation libs, no shadcn beyond Button/Input/Select already in repo.

## Architecture

### Files
- `src/routes/index.tsx` — route shell + head meta, mounts `<DigitsApp/>`
- `src/components/digits/DigitsApp.tsx` — top-level state container
- `src/components/digits/DigitGrid.tsx` — 10-cell freq grid (memoized)
- `src/components/digits/RecentTicks.tsx` — last 20 digits row
- `src/components/digits/Controls.tsx` — inputs (symbol, token, predict, duration, stake, lookback, latency offset, mode, trigger rules)
- `src/components/digits/StatsPanel.tsx` — χ², entropy, cold digits, 2-tick follow-up
- `src/components/digits/SignalsLog.tsx` — last 8 signals
- `src/components/digits/NetworkBadge.tsx` — green/yellow/red pill
- `src/lib/deriv/derivClient.ts` — WS connection, ticks_history + ticks subscribe, time sync (`time` call every 30s), buy/proposal calls, reconnect w/ backoff
- `src/lib/deriv/stats.ts` — pure functions: frequencies, χ² vs uniform, Shannon entropy, Poisson tail prob, Markov 1-step + 2-step matrices, 2-tick sequence followups
- `src/lib/deriv/triggers.ts` — evaluate user trigger rules → decision
- `src/lib/deriv/storage.ts` — LocalStorage get/set for config (NOT token by default; offer "remember token" checkbox)
- `src/lib/deriv/audio.ts` — tiny WebAudio beep (no asset)
- `src/lib/deriv/types.ts`

### Data flow
1. Connect WS to `wss://ws.derivws.com/websockets/v3?app_id=1089` (public app_id; user token only needed for auth/buy).
2. On open → send `{time:1}` then `{ticks_history, end:'latest', count:100, subscribe:1, ticks_history:<symbol>}`.
3. Re-sync server time every 30s; compute drift = serverTime − clientTime.
4. For each tick: digit = last char of `quote.toFixed(pip)`; compute `arrivalGap = now − prevArrival`; if >800ms → mark stale, skip stat update for that tick (still store digit but flag).
5. Throttle UI re-renders to ≤10 fps via `requestAnimationFrame` batching; stats computed in O(window) over rolling ring buffer (cap 500).
6. Network health: rolling median of last-10 round-trip pings using periodic `{ping:1}` every 5s.
7. On every committed tick → run trigger engine → if armed:
   - Alert mode: WebAudio beep + 1-frame red flash class
   - Simulated: log "would buy" + after `duration` ticks evaluate WIN/LOSS vs prediction
   - Live: gate on `pingMs ≤ 500`; send `{buy, price:stake, parameters:{contract_type:'DIGITMATCH', symbol, duration, duration_unit:'t', basis:'stake', amount:stake, currency:'USD', barrier:predDigit}}`; needs prior `{authorize:token}`.

### Stats engine (pure, tested mentally)
- `frequencies(window)` → number[10]
- `chiSquaredUniform(freq, n)` → χ²
- `shannonEntropy(freq, n)` → bits
- `poissonGapProb(gap, n)` → P(no occurrence in `gap` ticks given p=0.1)
- `markov1(window)` → 10×10 transition counts/probs
- `markov2(window)` → followup map keyed by 2-tick prefix → number[10]
- `twoTickFollowups(window, prefix)` → number[10] %

### Mobile/perf rules
- `React.memo` on grid cells; pass primitive props only.
- Ring buffer = preallocated `Uint8Array(500)` + head index, no array growth.
- Stats recompute on demand from buffer in a single pass per render frame; debounce render to 100ms.
- No chart libs. Color intensity = `style={{ backgroundColor: \`hsl(var(--primary-h) var(--primary-s) var(--primary-l) / ${alpha})\` }}` via CSS vars.
- Avoid Date objects in hot path — use `performance.now()`.

### Security / safety
- Token stored only if user opts in; warn it's local-only.
- Live trades disabled by default; require explicit "Arm Live" with confirm.
- Network filter aborts buys when median ping >500ms or last gap >800ms.

## Design system tweaks (`src/styles.css`)
- Add `--primary-h/s/l` channel vars for the digit-cell alpha trick.
- Add `--success`, `--warning`, `--danger` semantic tokens for the network badge.
- Dark, high-contrast palette (OLED-friendly, low repaint cost).

## Non-goals
- No backend, no Lovable Cloud, no edge functions.
- No persistent trade history beyond in-memory + last session in LocalStorage.
- No charts/graphs library.
- No SSR data fetching (WS is client-only; route loader stays empty).

## Verification
After implementation: run dev build implicitly via harness; mentally walk through WS lifecycle and stat functions. No live Deriv testing in sandbox.

If you approve, I'll implement all files in one batch.
