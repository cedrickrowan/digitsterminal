// Pure statistical helpers. Operate over a number[] window of digits 0-9.

export function frequencies(window: number[]): number[] {
  const f = new Array(10).fill(0);
  for (let i = 0; i < window.length; i++) f[window[i]]++;
  return f;
}

export function chiSquaredUniform(freq: number[], n: number): number {
  if (n === 0) return 0;
  const expected = n / 10;
  let chi = 0;
  for (let i = 0; i < 10; i++) {
    const d = freq[i] - expected;
    chi += (d * d) / expected;
  }
  return chi;
}

export function shannonEntropy(freq: number[], n: number): number {
  if (n === 0) return 0;
  let h = 0;
  for (let i = 0; i < 10; i++) {
    if (freq[i] === 0) continue;
    const p = freq[i] / n;
    h -= p * Math.log2(p);
  }
  return h;
}

// Probability that a digit with p=0.1 does NOT appear in `gap` ticks.
// Geometric tail: (0.9)^gap. Lower = more anomalous.
export function coldProb(gap: number): number {
  return Math.pow(0.9, gap);
}

// Gaps since last occurrence for each digit.
export function gapsSinceLast(window: number[]): number[] {
  const gaps = new Array(10).fill(window.length);
  for (let i = window.length - 1, g = 0; i >= 0; i--, g++) {
    const d = window[i];
    if (gaps[d] === window.length) gaps[d] = g;
  }
  return gaps;
}

// 1-step Markov transition probabilities. Returns 10x10 probs (rows sum to 1 or 0).
export function markov1(window: number[]): number[][] {
  const m: number[][] = Array.from({ length: 10 }, () => new Array(10).fill(0));
  const rowTotals = new Array(10).fill(0);
  for (let i = 0; i < window.length - 1; i++) {
    const a = window[i];
    const b = window[i + 1];
    m[a][b]++;
    rowTotals[a]++;
  }
  for (let a = 0; a < 10; a++) {
    if (rowTotals[a] === 0) continue;
    for (let b = 0; b < 10; b++) m[a][b] /= rowTotals[a];
  }
  return m;
}

// Distribution of digits appearing immediately after a [a,b] prefix.
export function twoTickFollowups(
  window: number[],
  a: number,
  b: number,
): { counts: number[]; total: number; probs: number[] } {
  const counts = new Array(10).fill(0);
  let total = 0;
  for (let i = 0; i < window.length - 2; i++) {
    if (window[i] === a && window[i + 1] === b) {
      counts[window[i + 2]]++;
      total++;
    }
  }
  const probs = counts.map((c) => (total ? c / total : 0));
  return { counts, total, probs };
}

// Current streak (consecutive identical digits at tail).
export function tailStreak(window: number[]): { digit: number; len: number } {
  if (window.length === 0) return { digit: -1, len: 0 };
  const d = window[window.length - 1];
  let len = 1;
  for (let i = window.length - 2; i >= 0 && window[i] === d; i--) len++;
  return { digit: d, len };
}
