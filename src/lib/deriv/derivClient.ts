// Deriv WebSocket client tuned for mobile/high-latency networks.
// Public app_id 1089 for ticks. Optional API token enables authorize + buy.

type Listener = (msg: any) => void;

export interface AuthInfo {
  loginid: string;
  isVirtual: boolean;
  currency: string;
  balance: number;
  fullname?: string;
}

export interface BuyResult {
  ok: boolean;
  contractId?: number;
  buyPrice?: number;
  payout?: number;
  longcode?: string;
  error?: string;
}

export interface DerivEvents {
  onOpen?: () => void;
  onClose?: () => void;
  onTick?: (digit: number, quote: number, epoch: number, arrivalMs: number) => void;
  onHistory?: (digits: number[], lastPrice: number) => void;
  onPing?: (rttMs: number) => void;
  onTimeSync?: (driftMs: number) => void;
  onError?: (err: string) => void;
  onAuth?: (info: AuthInfo | null) => void;
  onBalance?: (balance: number, currency: string) => void;
}

export type ContractType =
  | "DIGITMATCH"
  | "DIGITDIFF"
  | "DIGITOVER"
  | "DIGITUNDER"
  | "DIGITEVEN"
  | "DIGITODD"
  | "CALL"
  | "PUT";

export interface BuyParams {
  contractType: ContractType;
  symbol: string;
  stake: number;
  durationTicks: number;
  barrier?: number; // digit barrier 0-9 (for OVER/UNDER) or 0-9 (MATCH/DIFF)
  currency?: string;
}

export class DerivClient {
  private ws: WebSocket | null = null;
  private reqId = 1;
  private pending = new Map<number, Listener>();
  private subId: string | null = null;
  private balSubId: string | null = null;
  private symbol = "R_100";
  private pipSize = 2;
  private timeTimer: number | null = null;
  private pingTimer: number | null = null;
  private watchdog: number | null = null;
  private lastMsgAt = 0;
  private closed = false;
  private reconnectAttempt = 0;
  private token: string | null = null;
  private authInfo: AuthInfo | null = null;
  // EMA-smoothed ping/drift — dampens mobile-network latency spikes so the
  // execution scheduler doesn't chase every jitter blip.
  private pingEma = 0;
  private driftEma = 0;
  // Streaming fallback: some regions/app_ids reject `subscribe:1` with
  // "Symbol X is invalid" while plain ticks_history still works. In that case
  // we poll history instead of streaming, so the terminal never goes blank.
  private pollTimer: number | null = null;
  private lastEpoch = 0;
  private static readonly PING_ALPHA = 0.25;
  private static readonly DRIFT_ALPHA = 0.2;

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
      if (this.token) this.authorizeInternal();
      // 5s cadence for both clock-drift and ping heartbeats keeps the
      // execution-time formula (nextTick − ping − drift − lag) always fresh.
      this.timeTimer = window.setInterval(() => this.syncTime(), 5_000);
      this.pingTimer = window.setInterval(() => this.ping(), 5_000);
      this.watchdog = window.setInterval(() => {
        if (performance.now() - this.lastMsgAt > 20_000) {
          try { this.ws?.close(); } catch { /* ignore */ }
        }
      }, 5_000);
    };
    ws.onclose = () => {
      this.events.onClose?.();
      this.clearTimers();
      this.balSubId = null;
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
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.timeTimer = null;
    this.pingTimer = null;
    this.watchdog = null;
    this.pollTimer = null;
  }

  private send(payload: any, cb?: Listener): number {
    if (!this.ws || this.ws.readyState !== 1) return -1;
    const id = this.reqId++;
    if (cb) this.pending.set(id, cb);
    this.ws.send(JSON.stringify({ ...payload, req_id: id }));
    return id;
  }

  private pollReqIds = new Set<number>();

  private handle(raw: string) {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    const isPoll = msg.req_id ? this.pollReqIds.delete(msg.req_id) : false;
    if (msg.req_id && this.pending.has(msg.req_id)) {
      const cb = this.pending.get(msg.req_id)!;
      this.pending.delete(msg.req_id);
      cb(msg);
    }
    if (msg.error) {
      // Subscription rejections are handled by the fallback path, not surfaced.
      if (!isPoll) this.events.onError?.(msg.error.message || "deriv error");
      return;
    }
    if (msg.msg_type === "tick" && msg.tick) {
      const quote: number = msg.tick.quote;
      const pip = msg.tick.pip_size ?? this.pipSize;
      this.pipSize = pip;
      const sym = msg.tick.symbol ?? this.symbol;
      const digit = lastDigit(quote, pip, sym);
      this.subId = msg.tick.id ?? this.subId;
      this.lastEpoch = Math.max(this.lastEpoch, msg.tick.epoch ?? 0);
      this.events.onTick?.(digit, quote, msg.tick.epoch, performance.now());
    } else if (msg.msg_type === "history" && msg.history) {
      const prices: number[] = msg.history.prices;
      const times: number[] = msg.history.times ?? [];
      const pip = msg.pip_size ?? this.pipSize;
      this.pipSize = pip;
      const sym = msg.echo_req?.ticks_history ?? this.symbol;
      if (isPoll) {
        // Polled refresh — emit only ticks newer than the last one seen.
        for (let i = 0; i < prices.length; i++) {
          const epoch = times[i] ?? 0;
          if (epoch <= this.lastEpoch) continue;
          this.lastEpoch = epoch;
          this.events.onTick?.(lastDigit(prices[i], pip, sym), prices[i], epoch, performance.now());
        }
        return;
      }
      this.lastEpoch = times.length ? times[times.length - 1] : this.lastEpoch;
      const digits = prices.map((p) => lastDigit(p, pip, sym));
      this.events.onHistory?.(digits, prices[prices.length - 1] ?? 0);
    } else if (msg.msg_type === "balance" && msg.balance) {
      const b = Number(msg.balance.balance);
      const c = msg.balance.currency;
      if (this.authInfo) {
        this.authInfo = { ...this.authInfo, balance: b, currency: c };
        this.events.onAuth?.(this.authInfo);
      }
      this.events.onBalance?.(b, c);
    }
  }

  subscribeTicks(symbol: string, count = 100) {
    this.symbol = symbol;
    // Reset to the per-symbol fallback until Deriv reports pip_size for it.
    this.pipSize = decimalsForSymbol(symbol);
    this.lastEpoch = 0;
    this.stopPolling();
    if (this.subId) {
      this.send({ forget: this.subId });
      this.subId = null;
    }
    // 1) Seed history WITHOUT `subscribe` — always accepted.
    this.send({ ticks_history: symbol, end: "latest", count, style: "ticks" });
    // 2) Try the live stream. If Deriv rejects the subscription (region /
    //    app_id restrictions return "Symbol X is invalid"), poll instead.
    this.send({ ticks: symbol, subscribe: 1 }, (msg) => {
      if (msg?.error) this.startPolling(symbol);
    });
  }

  private stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.pollReqIds.clear();
  }

  private startPolling(symbol: string) {
    this.stopPolling();
    const tick = () => {
      if (this.symbol !== symbol) return;
      const id = this.send({ ticks_history: symbol, end: "latest", count: 5, style: "ticks" });
      if (id > 0) this.pollReqIds.add(id);
    };
    tick();
    this.pollTimer = window.setInterval(tick, 900);
  }

  syncTime() {
    const t0 = performance.now();
    const wall0 = Date.now();
    this.send({ time: 1 }, (msg) => {
      const t1 = performance.now();
      const rtt = t1 - t0;
      const serverMs = msg.time * 1000;
      const drift = serverMs - (wall0 + rtt / 2);
      this.driftEma = this.driftEma === 0 ? drift : this.driftEma + DerivClient.DRIFT_ALPHA * (drift - this.driftEma);
      this.events.onTimeSync?.(this.driftEma);
    });
  }

  ping() {
    const t0 = performance.now();
    this.send({ ping: 1 }, () => {
      const rtt = performance.now() - t0;
      this.pingEma = this.pingEma === 0 ? rtt : this.pingEma + DerivClient.PING_ALPHA * (rtt - this.pingEma);
      this.events.onPing?.(this.pingEma);
    });
  }

  setToken(token: string | null) {
    this.token = token && token.trim() ? token.trim() : null;
    if (!this.token) {
      this.authInfo = null;
      this.events.onAuth?.(null);
      return;
    }
    if (this.ws?.readyState === 1) this.authorizeInternal();
  }

  private authorizeInternal() {
    if (!this.token) return;
    this.send({ authorize: this.token }, (msg) => {
      if (msg.error || !msg.authorize) {
        this.authInfo = null;
        this.events.onAuth?.(null);
        return;
      }
      const a = msg.authorize;
      this.authInfo = {
        loginid: a.loginid,
        isVirtual: !!a.is_virtual,
        currency: a.currency,
        balance: Number(a.balance ?? 0),
        fullname: a.fullname,
      };
      this.events.onAuth?.(this.authInfo);
      // subscribe to live balance
      this.send({ balance: 1, subscribe: 1 }, (m) => {
        if (m.balance?.id) this.balSubId = m.balance.id;
      });
    });
  }

  getAuth(): AuthInfo | null {
    return this.authInfo;
  }

  buy(params: BuyParams): Promise<BuyResult> {
    return new Promise((resolve) => {
      if (!this.authInfo) return resolve({ ok: false, error: "Not authorized" });
      if (!this.ws || this.ws.readyState !== 1) return resolve({ ok: false, error: "Disconnected" });
      const proposal: any = {
        amount: Number(params.stake.toFixed(2)),
        basis: "stake",
        contract_type: params.contractType,
        currency: params.currency ?? this.authInfo.currency,
        duration: params.durationTicks,
        duration_unit: "t",
        symbol: params.symbol,
      };
      if (params.barrier !== undefined) proposal.barrier = String(params.barrier);
      this.send({ proposal: 1, ...proposal }, (pMsg) => {
        if (pMsg.error || !pMsg.proposal) {
          return resolve({ ok: false, error: pMsg.error?.message || "proposal failed" });
        }
        const id = pMsg.proposal.id;
        const price = Number(pMsg.proposal.ask_price);
        this.send({ buy: id, price }, (bMsg) => {
          if (bMsg.error || !bMsg.buy) {
            return resolve({ ok: false, error: bMsg.error?.message || "buy failed" });
          }
          resolve({
            ok: true,
            contractId: bMsg.buy.contract_id,
            buyPrice: Number(bMsg.buy.buy_price),
            payout: Number(bMsg.buy.payout),
            longcode: bMsg.buy.longcode,
          });
        });
      });
    });
  }
}

// Decimal places come from Deriv's live `pip_size` per symbol (authoritative).
// This static map is only a fallback before the first message arrives.
const FALLBACK_DECIMALS: Record<string, number> = {
  R_10: 3, R_25: 3, R_50: 4, R_75: 4, R_100: 2,
  "1HZ10V": 2, "1HZ15V": 3, "1HZ25V": 2, "1HZ30V": 3, "1HZ50V": 2,
  "1HZ75V": 2, "1HZ90V": 3, "1HZ100V": 2, "1HZ150V": 2, "1HZ250V": 5,
};

export function decimalsForSymbol(symbol: string): number {
  return FALLBACK_DECIMALS[symbol] ?? 2;
}

function lastDigit(price: number, pip: number, symbol?: string): number {
  // Prefer the pip_size reported by Deriv for this exact symbol.
  const decimals =
    Number.isInteger(pip) && pip >= 0 && pip <= 8
      ? pip
      : decimalsForSymbol(symbol ?? "");
  // toFixed preserves trailing zeros so "1245.30" stays "1245.30" → last char "0"
  const s = price.toFixed(decimals);
  const ch = s.charAt(s.length - 1);
  const d = parseInt(ch, 10);
  // Strict validation: 0 is a fully valid digit. Only flag truly invalid parses.
  if (!Number.isInteger(d) || d < 0 || d > 9) {
    // eslint-disable-next-line no-console
    console.warn("[lastDigit] invalid parse", { price, decimals, formatted: s, ch });
    return -1;
  }
  return d;
}
