import { createServerFn } from "@tanstack/react-start";
import { useSession } from "@tanstack/react-start/server";
import { z } from "zod";

type SessionData = { authed?: boolean; user?: string };

function getSessionConfig() {
  const password = process.env.SESSION_SECRET;
  if (!password || password.length < 32) {
    throw new Error("SESSION_SECRET must be set (>=32 chars)");
  }
  return {
    password,
    name: "cdt-session",
    cookie: {
      httpOnly: true,
      sameSite: "lax" as const,
      secure: true,
      path: "/",
    },
  };
}

export const checkAuth = createServerFn({ method: "GET" }).handler(async () => {
  const session = await useSession<SessionData>(getSessionConfig());
  return { authed: session.data.authed === true };
});

export const login = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        username: z.string().min(1).max(128),
        password: z.string().min(1).max(256),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const expectedUser = process.env.AUTH_USERNAME;
    const expectedPass = process.env.AUTH_PASSWORD;
    if (!expectedUser || !expectedPass) {
      return { ok: false as const, error: "Server not configured" };
    }
    // small constant-ish delay; not timing-safe but creds are short
    await new Promise((r) => setTimeout(r, 150));
    if (data.username.trim() !== expectedUser || data.password !== expectedPass) {
      return { ok: false as const, error: "invalid" };
    }
    const session = await useSession<SessionData>(getSessionConfig());
    await session.update({ authed: true, user: expectedUser });
    return { ok: true as const };
  });

export const logout = createServerFn({ method: "POST" }).handler(async () => {
  const session = await useSession<SessionData>(getSessionConfig());
  await session.clear();
  return { ok: true };
});
