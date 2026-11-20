import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: unknown; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  const errorDetails =
    error instanceof Error
      ? `${error.name}: ${error.message}\n${error.stack ?? ""}`
      : typeof error === "object" && error !== null
        ? JSON.stringify(error, null, 2)
        : String(error);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-6">
      <div className="max-w-xl w-full text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page encountered an error
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The runtime caught an unhandled exception during live analysis:
        </p>

        {/* Live Diagnostics Card */}
        <pre className="mt-4 max-h-60 overflow-auto rounded border border-border bg-card p-3 text-left font-mono text-[11px] text-destructive">
          {errorDetails}
        </pre>

        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <button
            onClick={() => {
              navigator.clipboard?.writeText(errorDetails);
            }}
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Copy error
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Digit Matches" },
      { name: "description", content: "Deriv Digits analysis and trading tool for mobile, optimizing for low-spec devices and high-latency networks." },
      { name: "author", content: "Lovable" },
      { property: "og:title", content: "Digit Matches" },
      { property: "og:description", content: "Deriv Digits analysis and trading tool for mobile, optimizing for low-spec devices and high-latency networks." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:site", content: "@Lovable" },
      { name: "twitter:title", content: "Digit Matches" },
      { name: "twitter:description", content: "Deriv Digits analysis and trading tool for mobile, optimizing for low-spec devices and high-latency networks." },
      { property: "og:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/b07caaaf-cb19-4606-946a-f93a58c8c8de/id-preview-912e05db--3d8af711-c829-4101-b3d7-ed0ee65800c7.lovable.app-1781685614045.png" },
      { name: "twitter:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/b07caaaf-cb19-4606-946a-f93a58c8c8de/id-preview-912e05db--3d8af711-c829-4101-b3d7-ed0ee65800c7.lovable.app-1781685614045.png" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap",
      },
    ],

  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
      <Outlet />
    </QueryClientProvider>
  );
}
