import { DEFAULT_CONFIG, type AppConfig } from "./types";

const KEY = "deriv-digits-config-v2";

/** Lookback is always a multiple of 3 in [3, 900] — snap anything else. */
export function snapLookback(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_CONFIG.lookback;
  return Math.min(900, Math.max(3, Math.round(v / 3) * 3));
}

export function loadConfig(): AppConfig {
  if (typeof window === "undefined") return DEFAULT_CONFIG;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_CONFIG;
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      lookback: snapLookback(Number(parsed.lookback ?? DEFAULT_CONFIG.lookback)),
      rules: { ...DEFAULT_CONFIG.rules, ...(parsed.rules ?? {}) },
      navRules: { ...DEFAULT_CONFIG.navRules, ...(parsed.navRules ?? {}) },
      navThresholds: { ...DEFAULT_CONFIG.navThresholds, ...(parsed.navThresholds ?? {}) },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(cfg: AppConfig) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(KEY, JSON.stringify(cfg));
  } catch {
    /* ignore */
  }
}

const TOKEN_KEY = "deriv-api-token";
export function loadToken(): string {
  if (typeof window === "undefined") return "";
  try { return localStorage.getItem(TOKEN_KEY) ?? ""; } catch { return ""; }
}
export function saveToken(t: string) {
  if (typeof window === "undefined") return;
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* ignore */ }
}
