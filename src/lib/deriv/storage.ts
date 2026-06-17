import { DEFAULT_CONFIG, type AppConfig } from "./types";

const KEY = "deriv-digits-config-v1";

export function loadConfig(): AppConfig {
  if (typeof window === "undefined") return DEFAULT_CONFIG;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_CONFIG;
    const parsed = JSON.parse(raw);
    const merged: AppConfig = { ...DEFAULT_CONFIG, ...parsed };
    if (!merged.rememberToken) merged.token = "";
    return merged;
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(cfg: AppConfig) {
  if (typeof window === "undefined") return;
  try {
    const toStore = { ...cfg, token: cfg.rememberToken ? cfg.token : "" };
    localStorage.setItem(KEY, JSON.stringify(toStore));
  } catch {
    /* ignore */
  }
}
