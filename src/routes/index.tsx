import { createFileRoute } from "@tanstack/react-router";
import DigitsApp from "@/components/digits/DigitsApp";
import { AuthGate } from "@/components/digits/LoginScreen";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Deriv Digits Matches · Mobile Analysis" },
      {
        name: "description",
        content:
          "Lightweight mobile tool for Deriv Digits Matches: real-time stats, Markov, entropy, Poisson cold-digit analysis, and network-safe execution.",
      },
      { property: "og:title", content: "Deriv Digits Matches · Mobile Analysis" },
      {
        property: "og:description",
        content: "Mobile-first analysis & trading tool for Deriv Volatility digits.",
      },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <AuthGate>
      <DigitsApp />
    </AuthGate>
  );
}
