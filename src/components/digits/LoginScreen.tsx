import { useEffect, useState, type ReactNode } from "react";
import { checkAuthFn, loginFn, logoutFn } from "@/lib/auth.functions";

export async function signOut() {
  try {
    await logoutFn();
  } catch {
    /* ignore */
  }
  if (typeof window !== "undefined") window.location.reload();
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    checkAuthFn()
      .then((r) => {
        if (cancelled) return;
        setAuthed(r.authed);
        setReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!ready) return null;
  if (!authed) return <LoginScreen onSuccess={() => setAuthed(true)} />;
  return <>{children}</>;
}

function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await loginFn({ data: { username: u.trim(), password: p } });
      if (res.ok) {
        setErr(null);
        onSuccess();
      } else {
        setErr("Access Denied: Invalid credentials. Please contact the administrator.");
      }
    } catch {
      setErr("Access Denied: Invalid credentials. Please contact the administrator.");
    } finally {
      setBusy(false);
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
          disabled={busy}
          className="w-full rounded border border-cyan bg-cyan/15 px-3 py-2 font-semibold text-cyan shadow-[0_0_12px_-2px_var(--color-cyan)] disabled:opacity-60"
        >
          {busy ? "Verifying…" : "Enter Terminal"}
        </button>
      </form>
    </div>
  );
}
