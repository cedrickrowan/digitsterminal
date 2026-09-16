import { createFileRoute } from "@tanstack/react-router";
import { streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import {
  createLovableAiGatewayRunIdFetch,
  getLovableAiGatewayRunId,
  withLovableAiGatewayRunIdHeader,
} from "@/lib/ai-gateway.server";

const probability = z.number().finite().min(0).max(1);
const ExplainInput = z.object({
  symbol: z.string().max(32),
  market: z.enum(["matches", "overunder", "evenodd", "risefall"]),
  planned: z.string().max(40),
  targetDigit: z.number().int().min(0).max(9),
  confidence: probability,
  runProbability: probability,
  consecutiveProbability: probability,
  horizon: z.union([z.literal(2), z.literal(3)]),
  markovSteps: z.array(z.array(probability).length(10)).min(2).max(3),
  recentTail: z.array(z.number().int().min(0).max(9)).max(6),
  order2: z.array(probability).length(10),
  order3: z.array(probability).length(10),
  passedRules: z.array(z.string().max(160)).max(7),
  failedRules: z.array(z.string().max(80)).max(7),
  layer1: probability,
  layer2: probability,
  breakerMultiplier: probability,
  blocked: z.boolean(),
  blockReason: z.string().max(160),
  network: z.enum(["green", "yellow", "red"]),
  pingMs: z.number().finite().min(0).max(60_000),
});

function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

export const Route = createFileRoute("/api/explain-prediction")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let parsed: z.infer<typeof ExplainInput>;
        try {
          parsed = ExplainInput.parse(await request.json());
        } catch (error) {
          const message = error instanceof Error ? error.message : "Invalid prediction snapshot";
          return Response.json({ error: message }, { status: 400 });
        }

        const lovableApiKey = process.env["LOVABLE_API_KEY"];
        if (!lovableApiKey) {
          return Response.json({ error: "Lovable AI is not configured for this app." }, { status: 401 });
        }

        const initialRunId = getLovableAiGatewayRunId(request);
        const runIdFetch = createLovableAiGatewayRunIdFetch(initialRunId);
        const lovable = createOpenAI({
          baseURL: "https://ai.gateway.lovable.dev/v1",
          apiKey: lovableApiKey,
          headers: {
            "Lovable-API-Key": lovableApiKey,
            "X-Lovable-AIG-SDK": "vercel-ai-sdk",
          },
          fetch: runIdFetch.fetch,
        });

        const markovPath = parsed.markovSteps
          .map((row, index) => {
            const ranked = row
              .map((p, digit) => ({ digit, p }))
              .sort((a, b) => b.p - a.p)
              .slice(0, 3)
              .map(({ digit, p }) => `${digit} ${percent(p)}`)
              .join(", ");
            return `t+${index + 1}: ${ranked}`;
          })
          .join(" | ");

        const prompt = [
          `Explain this live statistical prediction snapshot in plain, concise language.`,
          `Symbol: ${parsed.symbol}; market: ${parsed.market}; planned contract: ${parsed.planned}.`,
          `Target digit: ${parsed.targetDigit}; horizon: t+${parsed.horizon}.`,
          `Weighted confidence: ${percent(parsed.confidence)}; repeat >=2 probability: ${percent(parsed.runProbability)}; consecutive repeat: ${percent(parsed.consecutiveProbability)}.`,
          `Top Markov candidates by step: ${markovPath}.`,
          `Recent path: ${parsed.recentTail.join(" → ") || "not available"}.`,
          `Second-order target probability: ${percent(parsed.order2[parsed.targetDigit] ?? 0)}; third-order target probability: ${percent(parsed.order3[parsed.targetDigit] ?? 0)}.`,
          `Layer 1: ${percent(parsed.layer1)}; Layer 2: ${percent(parsed.layer2)}; breaker multiplier: ${percent(parsed.breakerMultiplier)}.`,
          `Passed trigger rules: ${parsed.passedRules.join("; ") || "none"}.`,
          `Enabled rules not passed: ${parsed.failedRules.join("; ") || "none"}.`,
          `Circuit breaker: ${parsed.blocked ? `BLOCKED — ${parsed.blockReason}` : "clear"}. Network: ${parsed.network}, ping ${parsed.pingMs.toFixed(0)}ms.`,
          `Write exactly three short sections: "Markov path", "Trigger rules", and "Decision".`,
          `Do not claim certainty, guaranteed wins, future knowledge, or financial advice. Explicitly state that probabilities can fail and explain the strongest blocker when execution is not ready.`,
        ].join("\n");

        try {
          const result = streamText({
            model: lovable.responses("openai/gpt-6-astra"),
            system:
              "You explain a digit-market statistical terminal. Be factual, compact, and risk-aware. Never alter values or imply deterministic prediction.",
            prompt,
            abortSignal: request.signal,
            providerOptions: {
              openai: {
                forceReasoning: true,
                reasoningEffort: "low",
                reasoningSummary: "auto",
                store: false,
                include: ["reasoning.encrypted_content"],
              },
            },
          });
          return withLovableAiGatewayRunIdHeader(result.toTextStreamResponse(), runIdFetch);
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            return new Response(null, { status: 499 });
          }
          const message = error instanceof Error ? error.message : "AI explanation failed";
          return Response.json({ error: message }, { status: 500 });
        }
      },
    },
  },
});