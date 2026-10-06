// Deriv WebSocket client tuned for mobile/high-latency networks.
// Public app_id 1089 for ticks. Optional API token enables authorize + buy.
//
// Hardening notes:
//  - Every stream is keyed to a monotonically increasing subscription
//    "generation". Messages from a previous symbol can never contaminate the
//    analysis of the currently selected symbol.
//  - Errors that are consumed by a request callback are never surfaced as
//    fatal; the stream falls back to history polling and keeps retrying the
//    live subscription, so a transient "InvalidSymbol" cannot kill the feed.
//  - A tick watchdog soft-resubscribes before escalating to a socket reset.

type Listener = (msg: any) => void;

export type ConnState = "connecting" | "live" | "reconnecting" | "offline";

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
  onStatus?: (state: ConnState, attempt: number, detail?: string) => void;
  onTick?: (
    digit: number,
    quote: number,
    epoch: number,
    arrivalMs: number,
    symbol: string,
    generation: number,
  ) => void;
  onHistory?: (digits: number[], lastPrice: number, symbol: string, generation: number) => void;
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
  barrier?: number;
  currency?: string;
}

export class DerivClient {
  private ws: WebSocket | null = null;
  private reqId = 1;
  private pending = new Map<number, Listener>();
  private subId: string | null = null;
  private balSubId: string | null = null;
  private symbol = "R_100";
  private historyCount = 100;
  private generation = 0;
  private pipSize = 2;
  private timeTimer: number | null = null;
  private pingTimer: number | null = null;
  private watchdog: number | null = null;
  private streamRetry: number | null = null;
  private lastMsgAt = 0;
  private lastTickAt = 0;
  private tickIntervalMs = 2000;
  private softResubscribes = 0;
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private token: string | null = null;
  private authInfo: AuthInfo | null = null;
  private state: ConnState = "offline";
  private pingEma = 0;
  private driftEma = 0;
  private pollTimer: number | null = null;
  private pollReqIds = new Set<number>();
  private lastEpoch = 0;
  private streaming = false;
  private static readonly PING_ALPHA = 0.25;
  private static readonly DRIFT_ALPHA = 0.2;

  constructor(private events: DerivEvents) {}

  getState(): ConnState {
    return this.state;
  }

  private setState(s: ConnState, detail?: string) {
    this.state = s;
    this.events.onStatus?.(s, this.reconnectAttempt, detail);
  }

  connect() {
    this.closed = false;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    this.setState(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");
    const url = "wss://api.derivws.com/trading/v1/options/ws/public";
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
      this.softResubscribes = 0;
      this.lastMsgAt = performance.now();
      this.lastTickAt = performance.now();
      this.setState("live");
      this.events.onOpen?.();
      // Re-arm the current symbol on every (re)connect so the feed resumes
      // exactly where it left off.
      this.subscribeTicks(this.symbol, this.historyCount);
      this.syncTime();
      this.ping();
      if (this.token) this.authorizeInternal();
      this.timeTimer = window.setInterval(() => this.syncTime(), 5_000);
      this.pingTimer = window.setInterval(() => this.ping(), 5_000);
      this.watchdog = window.setInterval(() => this.checkHealth(), 3_000);
    };

    ws.onclose = () => {
      this.clearTimers();
      this.pending.clear();
      this.subId = null;
      this.balSubId = null;
      this.streaming = false;
      this.events.onClose?.();
      if (!this.closed) this.scheduleReconnect();
      else this.setState("offline");
    };

    ws.onerror = () => {
      // Non-fatal: onclose drives the reconnect. Surface as status only.
      this.setState(this.state === "live" ? "reconnecting" : this.state, "socket error");
    };

    ws.onmessage = (e) => {
      this.lastMsgAt = performance.now();
      this.handle(e.data);
    };
  }

  /** Health loop: soft-resubscribe on a silent stream, hard reset if it persists. */
  private checkHealth() {
    if (!this.ws || this.ws.readyState !== 1) return;
    const now = performance.now();
    const tickBudget = Math.max(8_000, this.tickIntervalMs * 4);
    if (now - this.lastTickAt > tickBudget) {
      this.softResubscribes++;
      if (this.softResubscribes <= 2) {
        this.setState("reconnecting", "stream silent · resubscribing");
        this.subscribeTicks(this.symbol, this.historyCount);
        this.lastTickAt = now;
      } else {
        this.softResubscribes = 0;
        try { this.ws.close(); } catch { /* ignore */ }
      }
      return;
    }
    if (now - this.lastMsgAt > 20_000) {
      try { this.ws.close(); } catch { /* ignore */ }
    }
  }

  private scheduleReconnect() {
    if (this.closed) return;
    if (this.reconnectTimer !== null) return;
    const attempt = this.reconnectAttempt++;
    // Exponential backoff with full jitter, capped at 15s.
    const base = Math.min(15_000, 500 * Math.pow(2, attempt));
    const delay = Math.round(base / 2 + Math.random() * (base / 2));
    this.setState("reconnecting", `retry in ${Math.round(delay / 100) / 10}s`);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  disconnect() {
    this.closed = true;
    this.clearTimers();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    this.setState("offline");
  }

  private clearTimers() {
    for (const t of [this.timeTimer, this.pingTimer, this.watchdog, this.pollTimer, this.streamRetry]) {
      if (t !== null) clearInterval(t as number);
    }
    if (this.streamRetry !== null) clearTimeout(this.streamRetry);
    this.timeTimer = null;
    this.pingTimer = null;
    this.watchdog = null;
    this.pollTimer = null;
    this.streamRetry = null;
    this.pollReqIds.clear();
  }

  private send(payload: any, cb?: Listener): number {
    if (!this.ws || this.ws.readyState !== 1) return -1;
    const id = this.reqId++;
    if (cb) this.pending.set(id, cb);
    try {
      this.ws.send(JSON.stringify({ ...payload, req_id: id }));
    } catch {
      this.pending.delete(id);
      return -1;
    }
    return id;
  }

  private handle(raw: string) {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }

    const isPoll = msg.req_id ? this.pollReqIds.delete(msg.req_id) : false;
    let handled = false;
    if (msg.req_id && this.pending.has(msg.req_id)) {
      const cb = this.pending.get(msg.req_id)!;
      this.pending.delete(msg.req_id);
      handled = true;
      cb(msg);
    }

    if (msg.error) {
      // Consumed by a request callback (subscription fallback, proposal, …) →
      // never treated as a feed failure.
      if (!handled && !isPoll) this.events.onError?.(msg.error.message || "deriv error");
      return;
    }

    if (msg.msg_type === "tick" && msg.tick) {
      const sym = msg.tick.symbol ?? this.symbol;
      // Late packet from a previously selected symbol → discard entirely.
      if (sym !== this.symbol) {
        if (msg.tick.id) this.send({ forget: msg.tick.id });
        return;
      }
      const quote: number = msg.tick.quote;
      const pip = msg.tick.pip_size ?? this.pipSize;
      this.pipSize = pip;
      const digit = lastDigit(quote, pip, sym);
      this.subId = msg.tick.id ?? this.subId;
      const epoch = msg.tick.epoch ?? 0;
      if (epoch && epoch <= this.lastEpoch) return; // duplicate / out of order
      this.lastEpoch = Math.max(this.lastEpoch, epoch);
      const now = performance.now();
      if (this.lastTickAt) {
        const gap = now - this.lastTickAt;
        if (gap > 200 && gap < 30_000) {
          this.tickIntervalMs = this.tickIntervalMs * 0.8 + gap * 0.2;
        }
      }
      this.lastTickAt = now;
      this.softResubscribes = 0;
      if (this.state !== "live") this.setState("live");
      this.events.onTick?.(digit, quote, epoch, now, sym, this.generation);
      return;
    }

    if (msg.msg_type === "history" && msg.history) {
      const sym = msg.echo_req?.ticks_history ?? this.symbol;
      if (sym !== this.symbol) return;
      const prices: number[] = msg.history.prices ?? [];
      const times: number[] = msg.history.times ?? [];
      const pip = msg.pip_size ?? this.pipSize;
      this.pipSize = pip;
      if (isPoll) {
        for (let i = 0; i < prices.length; i++) {
          const epoch = times[i] ?? 0;
          if (epoch <= this.lastEpoch) continue;
          this.lastEpoch = epoch;
          this.lastTickAt = performance.now();
          this.events.onTick?.(
            lastDigit(prices[i], pip, sym),
            prices[i],
            epoch,
            this.lastTickAt,
            sym,
            this.generation,
          );
        }
        return;
      }
      this.lastEpoch = times.length ? times[times.length - 1] : this.lastEpoch;
      this.lastTickAt = performance.now();
      const digits = prices.map((p) => lastDigit(p, pip, sym));
      this.events.onHistory?.(digits, prices[prices.length - 1] ?? 0, sym, this.generation);
      return;
    }

    if (msg.msg_type === "balance" && msg.balance) {
      const b = Number(msg.balance.balance);
      const c = msg.balance.currency;
      if (this.authInfo) {
        this.authInfo = { ...this.authInfo, balance: b, currency: c };
        this.events.onAuth?.(this.authInfo);
      }
      this.events.onBalance?.(b, c);
    }
  }

  /** Current subscription generation — consumers use it to drop stale data. */
  getGeneration(): number {
    return this.generation;
  }

  subscribeTicks(symbol: string, count = 100) {
    const symbolChanged = symbol !== this.symbol;
    this.symbol = symbol;
    this.historyCount = count;
    this.generation++;
    this.pipSize = decimalsForSymbol(symbol);
    this.lastEpoch = 0;
    this.tickIntervalMs = /^1HZ\d+V$/.test(symbol) ? 1000 : 2000;
    this.lastTickAt = performance.now();
    this.stopPolling();
    if (this.streamRetry !== null) {
      clearTimeout(this.streamRetry);
      this.streamRetry = null;
    }
    if (this.subId) {
      this.send({ forget: this.subId });
      this.subId = null;
    }
    if (symbolChanged) this.send({ forget_all: "ticks" });
    if (!this.ws || this.ws.readyState !== 1) return;

    // 1) Seed history WITHOUT `subscribe` — always accepted by every region.
    this.send({ ticks_history: symbol, end: "latest", count, style: "ticks" });
    // 2) Try the live stream. Rejections (region/app_id restrictions surface as
    //    "Symbol X is invalid") switch to polling and keep retrying quietly.
    this.streaming = false;
    const gen = this.generation;
    this.send({ ticks: symbol, subscribe: 1 }, (msg) => {
      if (this.generation !== gen) return;
      if (msg?.error) {
        this.startPolling(symbol, gen);
        this.streamRetry = window.setTimeout(() => {
          if (this.generation === gen && !this.streaming) this.retryStream(symbol, gen);
        }, 20_000);
      } else {
        this.streaming = true;
        this.stopPolling();
      }
    });
  }

  private retryStream(symbol: string, gen: number) {
    if (this.generation !== gen || !this.ws || this.ws.readyState !== 1) return;
    this.send({ ticks: symbol, subscribe: 1 }, (msg) => {
      if (this.generation !== gen) return;
      if (msg?.error) {
        this.streamRetry = window.setTimeout(() => this.retryStream(symbol, gen), 30_000);
      } else {
        this.streaming = true;
        this.stopPolling();
      }
    });
  }

  private stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.pollReqIds.clear();
  }

  private startPolling(symbol: string, gen: number) {
    this.stopPolling();
    const poll = () => {
      if (this.symbol !== symbol || this.generation !== gen) return;
      const id = this.send({ ticks_history: symbol, end: "latest", count: 5, style: "ticks" });
      if (id > 0) this.pollReqIds.add(id);
    };
    poll();
    this.pollTimer = window.setInterval(poll, /^1HZ\d+V$/.test(symbol) ? 600 : 900);
  }

  syncTime() {
    const t0 = performance.now();
    const wall0 = Date.now();
    this.send({ time: 1 }, (msg) => {
      if (!msg?.time) return;
      const t1 = performance.now();
      const rtt = t1 - t0;
      const serverMs = msg.time * 1000;
      const drift = serverMs - (wall0 + rtt / 2);
      this.driftEma =
        this.driftEma === 0 ? drift : this.driftEma + DerivClient.DRIFT_ALPHA * (drift - this.driftEma);
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
      this.send({ balance: 1, subscribe: 1 }, (m) => {
        if (m.balance?.id) this.balSubId = m.balance.id;
      });
    });
  }

  getPipSize(): number {
    return this.pipSize;
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
  const decimals =
    Number.isInteger(pip) && pip >= 0 && pip <= 8 ? pip : decimalsForSymbol(symbol ?? "");
  // toFixed preserves trailing zeros so "1245.30" stays "1245.30" → last char "0"
  const s = price.toFixed(decimals);
  const ch = s.charAt(s.length - 1);
  const d = parseInt(ch, 10);
  if (!Number.isInteger(d) || d < 0 || d > 9) return -1;
  return d;
}
