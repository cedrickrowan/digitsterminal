import { createServerFn } from "@tanstack/react-start";
import { useSession } from "@tanstack/react-start/server";
import { z } from "zod";

type SessionData = { authed?: true; user?: string };

function getSessionConfig() {
  const password =
    process.env.SESSION_SECRET ??
    "dev-only-session-secret-change-me-please-32chars";
  if (password.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters");
  }
  return {
    password,
    name: "digits-session",
    cookie: {
      httpOnly: true,
      secure: true,
      sameSite: "strict" as const,
      path: "/",
    },
  };
}

export const loginFn = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        username: z.string().min(1).max(128),
        password: z.string().min(1).max(256),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const expectedUser = process.env.AUTH_USERNAME ?? "CEDRICK";
    const expectedPass = process.env.AUTH_PASSWORD ?? "6216720";

    const userOk = data.username.trim() === expectedUser;
    const passOk = data.password === expectedPass;
    if (!userOk || !passOk) {
      return { ok: false as const };
    }
    const session = await useSession<SessionData>(getSessionConfig());
    await session.update({ authed: true, user: expectedUser });
    return { ok: true as const };
  });

export const logoutFn = createServerFn({ method: "POST" }).handler(async () => {
  const session = await useSession<SessionData>(getSessionConfig());
  await session.clear();
  return { ok: true as const };
});

export const checkAuthFn = createServerFn({ method: "GET" }).handler(
  async () => {
    const session = await useSession<SessionData>(getSessionConfig());
    return { authed: session.data.authed === true };
  },
);
