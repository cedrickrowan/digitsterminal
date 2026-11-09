import { useEffect, useState, type ReactNode } from "react";

const AUTH_KEY = "digits-auth-v1";
const USER = "CEDRICK";
const PASS = "6216720";

export function isAuthed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(AUTH_KEY) === "1";
  } catch {
    return false;
  }
}

export function signOut() {
  try {
    localStorage.removeItem(AUTH_KEY);
  } catch {
    /* ignore */
  }
  if (typeof window !== "undefined") window.location.reload();
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setAuthed(isAuthed());
    setReady(true);
  }, []);
  if (!ready) return null;
  if (!authed) return <LoginScreen onSuccess={() => setAuthed(true)} />;
  return <>{children}</>;
}

function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (u.trim() === USER && p === PASS) {
      try { localStorage.setItem(AUTH_KEY, "1"); } catch { /* ignore */ }
      setErr(null);
      onSuccess();
    } else {
      setErr("Access Denied: Invalid credentials. Please contact the administrator +254710596268.");
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-lg border border-cyan/40 bg-card p-5 shadow-[0_0_30px_-8px_var(--color-cyan)]"
      >
        <div className="text-center">
          <h1 className="text-lg font-bold tracking-wide">
            <span className="text-cyan">DERIV</span> · DIGITS TERMINAL
          </h1>
          <p className="mt-1 text-[10px] uppercase tracking-widest text-muted-foreground">
            Restricted access
          </p>
        </div>
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">Username</span>
          <input
            value={u}
            onChange={(e) => setU(e.target.value)}
            autoComplete="username"
            autoCapitalize="characters"
            className="w-full rounded border border-input bg-background px-3 py-2 font-mono text-sm"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">Password</span>
          <input
            type="password"
            value={p}
            onChange={(e) => setP(e.target.value)}
            autoComplete="current-password"
            className="w-full rounded border border-input bg-background px-3 py-2 font-mono text-sm"
          />
        </label>
        {err && (
          <div
            role="alert"
            className="rounded border border-danger/60 bg-danger/10 px-3 py-2 text-xs text-danger"
          >
            {err}
          </div>
        )}
        <button
          type="submit"
          className="w-full rounded border border-cyan bg-cyan/15 px-3 py-2 font-semibold text-cyan shadow-[0_0_12px_-2px_var(--color-cyan)]"
        >
          Enter Terminal
        </button>
      </form>
    </div>
  );
}
