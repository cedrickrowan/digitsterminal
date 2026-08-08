// Zero-allocation circular buffers. These live inside useRef so incoming
// high-frequency metrics never participate in React render cycles.

export class DigitRing {
  private buf: Uint8Array;
  private head = 0; // next write index
  private count = 0;

  constructor(public readonly capacity: number) {
    this.buf = new Uint8Array(capacity);
  }

  get length(): number {
    return this.count;
  }

  reset(): void {
    this.head = 0;
    this.count = 0;
    this.buf.fill(0);
  }

  push(d: number): void {
    if (!Number.isInteger(d) || d < 0 || d > 9) return;
    this.buf[this.head] = d;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  pushMany(list: ArrayLike<number>): void {
    for (let i = 0; i < list.length; i++) this.push(list[i]);
  }

  /** Oldest → newest index access. */
  at(i: number): number {
    const start = (this.head - this.count + this.capacity) % this.capacity;
    return this.buf[(start + i) % this.capacity];
  }

  /** Newest value, or -1 when empty. */
  last(): number {
    return this.count === 0 ? -1 : this.at(this.count - 1);
  }

  toArray(): number[] {
    const out = new Array<number>(this.count);
    for (let i = 0; i < this.count; i++) out[i] = this.at(i);
    return out;
  }

  /** Last n values in chronological order. */
  lastN(n: number): number[] {
    const take = Math.min(n, this.count);
    const out = new Array<number>(take);
    const offset = this.count - take;
    for (let i = 0; i < take; i++) out[i] = this.at(offset + i);
    return out;
  }
}

export class FloatRing {
  private buf: Float32Array;
  private head = 0;
  private count = 0;

  constructor(public readonly capacity: number) {
    this.buf = new Float32Array(capacity);
  }

  get length(): number {
    return this.count;
  }

  reset(): void {
    this.head = 0;
    this.count = 0;
    this.buf.fill(0);
  }

  push(v: number): void {
    if (!Number.isFinite(v)) return;
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  at(i: number): number {
    const start = (this.head - this.count + this.capacity) % this.capacity;
    return this.buf[(start + i) % this.capacity];
  }

  last(): number {
    return this.count === 0 ? 0 : this.at(this.count - 1);
  }

  toArray(): number[] {
    const out = new Array<number>(this.count);
    for (let i = 0; i < this.count; i++) out[i] = this.at(i);
    return out;
  }

  median(): number {
    if (this.count === 0) return 0;
    const s = this.toArray().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
}
