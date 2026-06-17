// Minimal Deriv WebSocket client tuned for mobile/high-latency networks.
// Public app_id 1089 is used for read-only tick streams. No buy/auth — analysis only.

type Listener = (msg: any) => void;

export interface DerivEvents {
  onOpen?: () => void;
  onClose?: () => void;
  onTick?: (digit: number, quote: number, epoch: number, arrivalMs: number) => void;
  onHistory?: (digits: number[], lastPrice: number) => void;
  onPing?: (rttMs: number) => void;
  onTimeSync?: (driftMs: number) => void;
  onError?: (err: string) => void;
}

export class DerivClient {
  private ws: WebSocket | null = null;
  private reqId = 1;
  private pending = new Map<number, Listener>();
  private subId: string | null = null;
  private symbol = "R_100";
  private pipSize = 2;
  private timeTimer: number | null = null;
  private pingTimer: number | null = null;
  private watchdog: number | null = null;
  private lastMsgAt = 0;
  private closed = false;
  private reconnectAttempt = 0;

  constructor(private events: DerivEvents) {}

  connect() {
    this.closed = false;
    const url = "wss://ws.derivws.com/websockets/v3?app_id=1089";
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.lastMsgAt = performance.now();
      this.events.onOpen?.();
      this.subscribeTicks(this.symbol);
      this.syncTime();
      this.timeTimer = window.setInterval(() => this.syncTime(), 30_000);
      this.pingTimer = window.setInterval(() => this.ping(), 5_000);
      // Watchdog: if no message for 20s, force reconnect (mobile networks drop silently).
      this.watchdog = window.setInterval(() => {
        if (performance.now() - this.lastMsgAt > 20_000) {
          try { this.ws?.close(); } catch { /* ignore */ }
        }
      }, 5_000);
    };
    ws.onclose = () => {
      this.events.onClose?.();
      this.clearTimers();
      if (!this.closed) this.scheduleReconnect();
    };
    ws.onerror = () => this.events.onError?.("ws error");
    ws.onmessage = (e) => {
      this.lastMsgAt = performance.now();
      this.handle(e.data);
    };
  }

  private scheduleReconnect() {
    if (this.closed) return;
    const delay = Math.min(15_000, 500 * Math.pow(2, this.reconnectAttempt++));
    setTimeout(() => this.connect(), delay);
  }

  disconnect() {
    this.closed = true;
    this.clearTimers();
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
  }

  private clearTimers() {
    if (this.timeTimer) clearInterval(this.timeTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.timeTimer = null;
    this.pingTimer = null;
    this.watchdog = null;
  }

  private send(payload: any, cb?: Listener) {
    if (!this.ws || this.ws.readyState !== 1) return;
    const id = this.reqId++;
    if (cb) this.pending.set(id, cb);
    this.ws.send(JSON.stringify({ ...payload, req_id: id }));
  }

  private handle(raw: string) {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.req_id && this.pending.has(msg.req_id)) {
      const cb = this.pending.get(msg.req_id)!;
      this.pending.delete(msg.req_id);
      cb(msg);
    }
    if (msg.error) {
      this.events.onError?.(msg.error.message || "deriv error");
      return;
    }
    if (msg.msg_type === "tick" && msg.tick) {
      const quote: number = msg.tick.quote;
      const pip = msg.tick.pip_size ?? this.pipSize;
      this.pipSize = pip;
      const digit = lastDigit(quote, pip);
      this.subId = msg.tick.id ?? this.subId;
      this.events.onTick?.(digit, quote, msg.tick.epoch, performance.now());
    } else if (msg.msg_type === "history" && msg.history) {
      const prices: number[] = msg.history.prices;
      const pip = msg.pip_size ?? 2;
      this.pipSize = pip;
      const digits = prices.map((p) => lastDigit(p, pip));
      this.events.onHistory?.(digits, prices[prices.length - 1] ?? 0);
    }
  }

  subscribeTicks(symbol: string, count = 100) {
    this.symbol = symbol;
    if (this.subId) {
      this.send({ forget: this.subId });
      this.subId = null;
    }
    this.send({
      ticks_history: symbol,
      end: "latest",
      count,
      style: "ticks",
      subscribe: 1,
    });
  }

  syncTime() {
    const t0 = Date.now();
    this.send({ time: 1 }, (msg) => {
      const t1 = Date.now();
      const rtt = t1 - t0;
      const serverMs = msg.time * 1000;
      const drift = serverMs - (t0 + rtt / 2);
      this.events.onTimeSync?.(drift);
    });
  }

  ping() {
    const t0 = performance.now();
    this.send({ ping: 1 }, () => {
      this.events.onPing?.(performance.now() - t0);
    });
  }
}

function lastDigit(price: number, pip: number): number {
  const s = price.toFixed(pip);
  return Number(s[s.length - 1]);
}
