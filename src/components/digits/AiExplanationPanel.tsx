import { memo, useCallback, useRef, useState } from "react";
import { BrainCircuit, RefreshCw, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Market, NetHealth } from "@/lib/deriv/types";

export interface PredictionExplanationSnapshot {
  symbol: string;
  market: Market;
  planned: string;
  targetDigit: number;
  confidence: number;
  runProbability: number;
  consecutiveProbability: number;
  horizon: 2 | 3;
  markovSteps: number[][];
  recentTail: number[];
  order2: number[];
  order3: number[];
  passedRules: string[];
  failedRules: string[];
  layer1: number;
  layer2: number;
  breakerMultiplier: number;
  blocked: boolean;
  blockReason: string;
  network: NetHealth;
  pingMs: number;
}

function AiExplanationPanelImpl({ snapshot }: { snapshot: PredictionExplanationSnapshot }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const explain = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setText("");
    setError("");
    setLoading(true);
    try {
      const response = await fetch("/api/explain-prediction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snapshot),
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error || `Explanation failed (${response.status})`);
      }
      if (!response.body) throw new Error("The explanation stream was empty.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        setText((current) => current + decoder.decode(chunk.value, { stream: true }));
      }
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "AI explanation failed");
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setLoading(false);
      }
    }
  }, [snapshot]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  return (
    <section className="rounded-lg border border-cyan/40 bg-card px-3 py-3 text-xs">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <BrainCircuit className="h-4 w-4 shrink-0 text-cyan" aria-hidden="true" />
          <div>
            <h2 className="text-[11px] font-bold uppercase tracking-widest text-cyan">AI prediction explanation</h2>
            <p className="mt-0.5 text-[10px] text-muted-foreground">Current snapshot · requested only</p>
          </div>
        </div>
        {loading ? (
          <Button type="button" size="sm" variant="outline" onClick={stop} aria-label="Stop explanation">
            <Square className="h-3.5 w-3.5" /> Stop
          </Button>
        ) : (
          <Button type="button" size="sm" onClick={explain}>
            <RefreshCw className="h-3.5 w-3.5" /> {text ? "Refresh" : "Explain"}
          </Button>
        )}
      </div>

      {loading && !text && (
        <div className="mt-3 font-mono text-[11px] text-cyan" aria-live="polite">Analyzing Markov paths and rules…</div>
      )}
      {error && (
        <div className="mt-3 rounded border border-danger/60 bg-danger/10 px-2 py-2 text-danger" role="alert">
          {error}
        </div>
      )}
      {text && (
        <div className="mt-3 whitespace-pre-wrap rounded border border-border bg-background/50 px-2 py-2 leading-relaxed text-foreground" aria-live="polite">
          {text}
        </div>
      )}
      {!loading && !text && !error && (
        <p className="mt-3 leading-relaxed text-muted-foreground">
          Explain the top P¹/P²/P³ path, passed rules, blockers, and current execution decision.
        </p>
      )}
    </section>
  );
}

export const AiExplanationPanel = memo(AiExplanationPanelImpl);