// Multi-market scanner network layer.
// Opens a short-lived public WebSocket to Deriv, fetches the requested
// tick-history snapshot for every synthetic index sequentially in small
// batches (gentle on high-latency mobile networks), and returns digits +
// raw prices + per-request round-trip time. The mathematical evaluation of
// each snapshot happens inside the analysis Web Worker (navigator is
// worker-only), never here.

import { decimalsForSymbol } from "./derivClient";

const WS_URL = "wss://api.derivws.com/trading/v1/options/ws/public";
const REQUEST_TIMEOUT_MS = 8_000;
const TOTAL_TIMEOUT_MS = 45_000;
const CHUNK = 3; // concurrent history requests per batch

/** Trailing-zero-safe last-digit extraction — identical to the live feed's. */
function lastDigit(price: number, pip: number, symbol: string): number {
  const decimals = Number.isInteger(pip) && pip >= 0 && pip <= 8 ? pip : decimalsForSymbol(symbol);
  const s = price.toFixed(decimals);
  const d = parseInt(s.charAt(s.length - 1), 10);
  return Number.isInteger(d) && d >= 0 && d <= 9 ? d : -1;
}

export interface ScanFetch {
  symbol: string;
  ok: boolean;
  error?: string;
  /** Oldest → newest digits 0-9. */
  digits: number[];
  /** Oldest → newest raw prices (for the Rise/Fall engine). */
  prices: number[];
  pip: number;
  /** Round-trip time of the history request (ms) — the scan's latency probe. */
  rttMs: number;
}

export async function fetchScanHistories(symbols: string[], count: number): Promise<ScanFetch[]> {
  const results = new Map<string, ScanFetch>();
  for (const s of symbols) {
    results.set(s, { symbol: s, ok: false, error: "not fetched", digits: [], prices: [], pip: decimalsForSymbol(s), rttMs: 0 });
  }

  await new Promise<void>((resolveMain) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(WS_URL);
    } catch {
      resolveMain();
      return;
    }
    let done = false;
    let reqId = 1;
    const pending = new Map<number, (msg: any) => void>();

    const finish = () => {
      if (done) return;
      done = true;
      try { ws.close(); } catch { /* ignore */ }
      resolveMain();
    };
    const totalTimer = window.setTimeout(finish, TOTAL_TIMEOUT_MS);

    ws.onmessage = (e) => {
      let msg: any;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg?.req_id && pending.has(msg.req_id)) {
        const cb = pending.get(msg.req_id)!;
        pending.delete(msg.req_id);
        cb(msg);
      }
    };
    ws.onclose = () => finish();
    ws.onerror = () => finish();

    ws.onopen = () => {
      const req = (payload: any) =>
        new Promise<any>((resolve, reject) => {
          const id = reqId++;
          const t = window.setTimeout(() => {
            pending.delete(id);
            reject(new Error("timeout"));
          }, REQUEST_TIMEOUT_MS);
          pending.set(id, (msg) => {
            window.clearTimeout(t);
            resolve(msg);
          });
          try {
            ws.send(JSON.stringify({ ...payload, req_id: id }));
          } catch (err) {
            pending.delete(id);
            reject(err);
          }
        });

      void (async () => {
        for (let i = 0; i < symbols.length; i += CHUNK) {
          if (done) return;
          const chunk = symbols.slice(i, i + CHUNK);
          await Promise.all(
            chunk.map(async (symbol) => {
              const t0 = performance.now();
              try {
                const msg = await req({ ticks_history: symbol, end: "latest", count, style: "ticks" });
                const rttMs = performance.now() - t0;
                if (msg?.error) {
                  results.set(symbol, { symbol, ok: false, error: msg.error.message || "deriv error", digits: [], prices: [], pip: decimalsForSymbol(symbol), rttMs });
                  return;
                }
                const prices: number[] = msg?.history?.prices ?? [];
                const pip = Number.isInteger(msg?.pip_size) ? msg.pip_size : decimalsForSymbol(symbol);
                if (prices.length < count) {
                  results.set(symbol, { symbol, ok: false, error: "insufficient history", digits: [], prices, pip, rttMs });
                  return;
                }
                const digits = prices.map((p: number) => lastDigit(p, pip, symbol));
                if (digits.some((d: number) => d < 0)) {
                  results.set(symbol, { symbol, ok: false, error: "digit parse failed", digits: [], prices, pip, rttMs });
                  return;
                }
                results.set(symbol, { symbol, ok: true, digits, prices, pip, rttMs });
              } catch (err) {
                results.set(symbol, {
                  symbol,
                  ok: false,
                  error: err instanceof Error ? err.message : String(err),
                  digits: [],
                  prices: [],
                  pip: decimalsForSymbol(symbol),
                  rttMs: performance.now() - t0,
                });
              }
            }),
          );
        }
        window.clearTimeout(totalTimer);
        finish();
      })();
    };
  });

  return symbols.map((s) => results.get(s)!);
}
