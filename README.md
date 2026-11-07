# Digits Navigator

Build a mobile-first, highly optimized Deriv Digits "Matches" analysis and trading tool. The tool must be explicitly architected to run smoothly on a low-spec budget mobile device (Samsung A16 4G LTE) and handle a high-latency mobile network connection (16 Mbps download, 7.7 Mbps upload, with loaded latency spikes up to 900ms+).

Please implement the system using the following strict requirements:

1. Lightweight UI/UX for Mobile Hardware:

- Optimize the entire frontend for budget mobile screens, keeping DOM elements to an absolute minimum.

- Use simple, utility-based CSS/Tailwind layouts; disable heavy visual renders, transitions, or complex animations.

- Restrict real-time data visualization charts or digit feeds to a maximum of 15–20 recent data points at a time to prevent CPU throttling on the mobile processor.

- Display a clean grid for digits 0-9 showing their current frequency percentages using basic color intensity (e.g., fading shades of color) instead of heavy canvas-based graphing libraries.

2. Latency Compensation & Server-Time Sync:

- Immediately fetch and continuously sync with the official Deriv Server Time upon connection to accurately timestamp incoming tick data.

- Calculate the precise time gap between the Deriv server tick timestamp and the actual client arrival time on the device.

- Provide a clear on-screen visual network health indicator (Green = Safe, Yellow = Delayed, Red = High Risk) based on this time gap.

- If the arrival gap between two consecutive ticks exceeds 800ms, immediately flag the data as "Stale" and skip analysis for that cycle to prevent false pattern matching caused by network drops.

3. Data Throttling & Buffer Management:

- Implement client-side data throttling or debouncing to ensure the browser thread never freezes during rapid market movements.

- Track a configurable "Lookback Buffer" (e.g., last 25, 50, or 100 digits) to calculate statistical probabilities.

- Use highly efficient local state management to avoid memory leaks during extended mobile browser trading sessions. Cache basic user configurations locally using lightweight browser LocalStorage.

4. Digit Matches Strategy Logic & Filters:

- Build an analytical engine specifically designed for the Digits "Matches" contract type.

- Include an adjustable "Execution Latency Offset" timer input in the UI (defaulted to 1000ms) to offset technical calculations and simulate realistic entry times.

- Implement a network safety filter: if the measured network ping/latency is higher than 500ms, automatically restrict the tool from sending a purchase request to prevent landing on a completely different tick.

- Create a "Simulated Entry" toggle allowing me to test if the tool's theoretical trade matches would win or lose against my real network latency before using live capital.

5. Dynamic Strategy & Input Fields:

- Provide input fields for: Target Asset (Volatility Index selection), Prediction Digit, Duration (in ticks), Stake amount, and Deriv API Token.

- Include a "Trigger Condition" rules engine where I can input exact pattern requirements (e.g., trigger an alert/execution when a target digit appears a specific number of times consecutively, or when a digit's appearance probability falls below a set percentage).

- Allow the tool to toggle between two modes: "Alert Only" (triggering a crisp audio tone and visual screen flash) or "Automated Execution" (directly interacting with the Deriv WebSocket API using the user's API token).

6. Advanced Statistical Engine & Micro-Analysis:

Please implement a mathematical analysis engine that processes incoming tick digits using the following statistical methodologies:

A. Markov Chain Transition Matrices:

- Build a client-side 10x10 matrix mapping the transition probabilities from the current digit to the next two ticks (e.g., probability of digit X moving to digit Y in 1 tick, and then to Z in 2 ticks).

- Calculate real-time chi-squared (χ²) goodness-of-fit tests against a uniform distribution (where each digit has a theoretical 10% probability) across a rolling 100-tick window to isolate short-term distribution skewing or clustering anomalies.

B. Uniform Distribution Variance & Entropy Tracking:

- Track "Cold Digits" using a Poisson distribution model to calculate the exact mathematical probability of a digit failing to appear over a specific streak length (e.g., if digit 4 has not appeared in 30 ticks, calculate the anomaly variance threshold).

- Implement Shannon Entropy calculations on rolling windows of 20, 50, and 100 ticks. Lower entropy values indicate temporary pattern predictability or structural clustering, which should act as a strategy multiplier.

C. Two-Tick Sequential Pattern Matching:

- Store digit history in a strict chronological array buffer.

- Map and compare the current 2-tick sequence against the lookback historical window to identify identical sequential matches (e.g., if the current sequence is 3 -> 7, scan the lookback window to find how many times 3 -> 7 occurred and chart the percentage distribution of the digits that followed immediately after).

D. Dynamic Probability Filtering:

- If a target digit's real-time calculated statistical probability across the lookback window deviates from the standard 10% uniform expectation by a user-defined threshold margin, flag it as an analytical "Match".

- Combine this statistical flag with the previously established network safety filter: if the Markov or Poisson probability peaks but network execution lag exceeds 500ms, abort the simulated or live trigger to prevent entry on an expired tick state.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://digitsterminal.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/3d8af711-c829-4101-b3d7-ed0ee65800c7).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
