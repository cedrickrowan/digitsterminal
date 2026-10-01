// Zero-asset synthesized alerts (Web Audio API). Short envelopes (~140ms)
// so the cue lands within normal human auditory reaction time.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let volume = 0.7;
let muted = false;

const KEY = "cedrick.audio";

function ensure(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!ctx) {
      ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      master = ctx.createGain();
      master.connect(ctx.destination);
      applyGain();
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function applyGain() {
  if (master && ctx) master.gain.setValueAtTime(muted ? 0 : volume, ctx.currentTime);
}

export function loadAudioPrefs(): { volume: number; muted: boolean } {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (typeof p.volume === "number") volume = Math.min(1, Math.max(0, p.volume));
      if (typeof p.muted === "boolean") muted = p.muted;
    }
  } catch {
    /* ignore */
  }
  return { volume, muted };
}

export function setAudioPrefs(v: number, m: boolean) {
  volume = Math.min(1, Math.max(0, v));
  muted = m;
  applyGain();
  try {
    localStorage.setItem(KEY, JSON.stringify({ volume, muted }));
  } catch {
    /* ignore */
  }
}

/** Unlock audio on first user gesture (mobile autoplay policy). */
export function unlockAudio() {
  ensure();
}

function tone(freq: number, durMs: number, type: OscillatorType, peak: number, delayMs = 0) {
  const c = ensure();
  if (!c || !master || muted) return;
  const t0 = c.currentTime + delayMs / 1000;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + durMs / 1000 + 0.02);
}

/** Green CLICK NOW — bright two-note high chime. */
export function chimeClickNow() {
  tone(1760, 140, "sine", 0.35);
  tone(2637, 140, "sine", 0.25, 60);
}

/** PREPARE — subtle single ping. */
export function pingPrepare() {
  tone(1046, 90, "sine", 0.12);
}

/** ABORT / LOCKOUT — low buzz. */
export function buzzAbort() {
  tone(140, 180, "sawtooth", 0.22);
}

/** Legacy generic beep (existing alert scheduler). */
export function beep(freq = 880, durMs = 140) {
  tone(freq, durMs, "sine", 0.2);
}
