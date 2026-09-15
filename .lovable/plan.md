# Floating-window reliability and AI prediction explanation

## Goal
Keep the live terminal updating continuously in Android floating-window mode, without requiring screen touches, and add an on-demand AI panel explaining the current prediction.

## Changes
- Replace visibility-only pausing with a floating-window-safe activity model: continue tick processing and lightweight screen commits whenever the page remains active, even if Android reports it as hidden.
- Remove timer-dependent tick coalescing from the critical prediction path; process each newest WebSocket tick immediately while retaining burst dropping and bounded screen refreshes.
- Move the remaining heavy per-tick prediction/context calculations into the existing Web Worker so the phone’s screen thread stays responsive.
- Add a self-healing feed monitor driven by both Deriv message timestamps and page focus/resume events, with one guarded resubscribe instead of duplicate reconnect loops.
- Preserve every existing formula, coefficient, execution gate, and safety threshold.
- Add an “AI Prediction Explanation” panel with an **Explain current prediction** action. It will send a compact snapshot containing the predicted digit/market, P¹/P²/P³ path probabilities, weighted layers, passed and failed trigger rules, circuit-breaker status, and network state.
- Use Lovable AI with `openai/gpt-6-astra` on the server, stream the response, show a thinking/loading state, and surface exact gateway errors. AI runs only when requested, so it cannot slow live calculations or consume credits continuously.

## Verification
- Run type checks and lint/build checks.
- Exercise the app at the current 327×540 floating-window size and a standard phone size.
- Verify live tick count, predicted values, and countdown continue changing without input for at least 45 seconds.
- Verify no duplicate subscriptions, runtime errors, long UI stalls, or prediction-state corruption.
- Invoke the AI explanation through the real server route and confirm it describes the displayed Markov path and rule results.
