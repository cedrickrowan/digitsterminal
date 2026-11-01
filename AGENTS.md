# Project Architecture Rules

- Digits Navigator engine (exact DP multi-hit/run probabilities, M^D landing, fatigue filter, runs/KL/KS/AMI/LZW/CUSUM) lives in `src/lib/deriv/navigator.ts` and runs ONLY inside the analysis Web Worker (`analysisWorker.ts`, message types `navSeed` / per-tick nav result). Never run it on the main thread — the worker keeps the mobile UI thread free and its preallocated DP scratch arrays avoid GC jitter.
- The navigator is analysis-only: it never purchases contracts. Alerts are manual ("READY / MANUAL ALERT") with a 700 ms human-response countdown; dual ping gates (<350 ms 1HZ, <500 ms plain) fail closed when RTT is missing.
- The navigator requires a full exact 100-digit buffer before output; it is seeded from history via the `navSeed` worker message and resets with the standard analysis reset on symbol switch.
