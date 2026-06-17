import { DEFAULT_CONFIG, type AppConfig } from "./types";

const KEY = "deriv-digits-config-v2";

export function loadConfig(): AppConfig {
  if (typeof window === "undefined") return DEFAULT_CONFIG;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_CONFIG;
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      rules: { ...DEFAULT_CONFIG.rules, ...(parsed.rules ?? {}) },
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
