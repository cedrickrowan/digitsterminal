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
      this.timeTimer = window.setInterval(() => this.syncTime(), 30_000);
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
      const sym = msg.tick.symbol ?? this.symbol;
      const digit = lastDigit(quote, pip, sym);
      this.subId = msg.tick.id ?? this.subId;
      this.events.onTick?.(digit, quote, msg.tick.epoch, performance.now());
    } else if (msg.msg_type === "history" && msg.history) {
      const prices: number[] = msg.history.prices;
      const pip = msg.pip_size ?? 2;
      this.pipSize = pip;
      const sym = msg.echo_req?.ticks_history ?? this.symbol;
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

// Strict per-symbol decimal places. Prevents JS from dropping trailing zeros
// on prices like 1245.30 (which would otherwise parse as 1245.3).
// 4 decimals: R_50, R_75
// 3 decimals: R_10, R_25
// 2 decimals: R_100 and ALL 1s indices (1HZ*V)
export function decimalsForSymbol(symbol: string): number {
  switch (symbol) {
    case "R_50":
    case "R_75":
      return 4;
    case "R_10":
    case "R_25":
      return 3;
    case "R_100":
      return 2;
    default:
      // All 1HZ*V (1s) indices use 2 decimals
      if (/^1HZ\d+V$/.test(symbol)) return 2;
      return 2;
  }
}

function lastDigit(price: number, pip: number, symbol?: string): number {
  const decimals = symbol ? decimalsForSymbol(symbol) : pip;
  // toFixed preserves trailing zeros so "1245.30" stays "1245.30" → last char "0"
  const s = price.toFixed(decimals);
  const ch = s.charAt(s.length - 1);
  const d = parseInt(ch, 10);
  // Strict validation: 0 is a fully valid digit. Only flag truly invalid parses (NaN, out of 0-9).
  // Use Number.isInteger + range check rather than truthy `if (d)` which would wrongly skip 0.
  if (!Number.isInteger(d) || d < 0 || d > 9) {
    // eslint-disable-next-line no-console
    console.warn("[lastDigit] invalid parse", { price, decimals, formatted: s, ch });
    return -1;
  }
  return d;
}
