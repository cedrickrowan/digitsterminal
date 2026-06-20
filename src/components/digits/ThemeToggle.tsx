import { useEffect, useState } from "react";

const KEY = "cdt-theme";
type Theme = "dark" | "light";

function apply(t: Theme) {
  const root = document.documentElement;
  root.classList.toggle("light", t === "light");
  root.classList.toggle("dark", t === "dark");
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const saved = (typeof localStorage !== "undefined" && (localStorage.getItem(KEY) as Theme)) || "dark";
    setTheme(saved);
    apply(saved);
  }, []);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    apply(next);
    try { localStorage.setItem(KEY, next); } catch { /* ignore */ }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle theme"
      className="rounded border border-input px-2 py-0.5 text-[10px] font-mono text-muted-foreground hover:text-foreground"
    >
      {theme === "dark" ? "☀ LIGHT" : "🌙 DARK"}
    </button>
  );
}
