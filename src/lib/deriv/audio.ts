let ctx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (AudioCtx) ctx = new AudioCtx();
  }
  return ctx;
}

export function unlockAudio() {
  const c = getAudioContext();
  if (!c) return;
  if (c.state === "suspended") {
    c.resume().catch(() => {});
  }
}

export function beep(freq = 880, durMs = 140) {
  const c = getAudioContext();
  if (!c) return;
  const playTone = () => {
    try {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, c.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.2, c.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + durMs / 1000);
      osc.connect(gain).connect(c.destination);
      osc.start();
      osc.stop(c.currentTime + durMs / 1000 + 0.02);
    } catch {
      /* ignore */
    }
  };

  if (c.state === "suspended") {
    c.resume().then(playTone).catch(() => {});
  } else {
    playTone();
  }
}
