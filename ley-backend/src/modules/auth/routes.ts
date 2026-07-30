import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { env } from "../../config/env.js";
import type { AuthDatabaseAdapter } from "./auth.db.js";
import { createJwt, verifyJwt } from "./jwt.js";

interface AuthRoutesOptions {
  authDatabase: AuthDatabaseAdapter;
}

interface GoogleCallbackQuery {
  code?: string;
  state?: string;
  error?: string;
}

interface GoogleOAuthProfile {
  sub: string;
  name?: string;
  email?: string;
  email_verified?: boolean;
  picture?: string;
}

function buildJwtPayload(user: { id: number; email: string }) {
  return {
    sub: user.id,
    email: user.email,
    jti: randomUUID(),
  };
}

export { createJwt, verifyJwt } from "./jwt.js";

export async function registerAuthRoutes(app: FastifyInstance, options: AuthRoutesOptions): Promise<void> {
  const { authDatabase } = options;

  app.get("/auth/google", async (_request, reply) => {
    const redirectUri = env.GOOGLE_OAUTH_REDIRECT_URI ?? "http://127.0.0.1:3000/auth/google/callback";
    const googleAuthUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    googleAuthUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID ?? "");
    googleAuthUrl.searchParams.set("redirect_uri", redirectUri);
    googleAuthUrl.searchParams.set("response_type", "code");
    // + calendar.readonly: dá pra Ley ler a Google Agenda (aba "Conexões" →
    // Google Agenda). "prompt=consent" já força a tela de consentimento toda
    // vez, então o refresh_token sempre volta — não precisa reconectar de
    // novo só por causa desse escopo novo.
    googleAuthUrl.searchParams.set(
      "scope",
      "openid email profile https://www.googleapis.com/auth/calendar.readonly"
    );
    googleAuthUrl.searchParams.set("access_type", "offline");
    googleAuthUrl.searchParams.set("prompt", "consent");
    googleAuthUrl.searchParams.set("state", randomUUID());
    return reply.redirect(googleAuthUrl.toString());
  });

  app.get("/auth/google/callback", async (request: FastifyRequest<{ Querystring: GoogleCallbackQuery }>, reply: FastifyReply) => {
    const { code, error } = request.query;
    if (error) {
      return reply.code(400).send({ ok: false, error: "google_auth_denied" });
    }
    if (!code) {
      return reply.code(400).send({ ok: false, error: "missing_code" });
    }

    const redirectUri = env.GOOGLE_OAUTH_REDIRECT_URI ?? "http://127.0.0.1:3000/auth/google/callback";
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID ?? "",
        client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenResponse.ok) {
      return reply.code(400).send({ ok: false, error: "token_exchange_failed" });
    }

    const tokenData = await tokenResponse.json() as {
      id_token?: string;
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    const profileResponse = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { authorization: `Bearer ${tokenData.access_token ?? ""}` },
    });

    if (!profileResponse.ok) {
      return reply.code(400).send({ ok: false, error: "profile_fetch_failed" });
    }

    const profile = await profileResponse.json() as GoogleOAuthProfile;
    const email = profile.email ?? "";
    if (!email) {
      return reply.code(400).send({ ok: false, error: "email_required" });
    }

    const user = await authDatabase.createOrUpdateUser({
      provider: "google",
      googleId: profile.sub,
      email,
      name: profile.name ?? email,
      picture: profile.picture,
    });

    // guarda o refresh_token pra Google Agenda conseguir buscar os eventos
    // depois, sem precisar o usuário logar de novo toda hora. saveGoogleTokens
    // é opcional no adapter (só implementado no SQLite hoje — ver auth.db.ts).
    if (tokenData.refresh_token) {
      await authDatabase.saveGoogleTokens?.(email, {
        refreshToken: tokenData.refresh_token,
        accessToken: tokenData.access_token ?? null,
        expiresAt: tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : null,
      });
    }

    const jwt = createJwt(buildJwtPayload(user));
    const frontendUrl = env.FRONTEND_URL ?? "http://127.0.0.1:5173";
    const redirectUrl = new URL(frontendUrl);
    redirectUrl.searchParams.set("auth_token", jwt);
    redirectUrl.searchParams.set("auth_user", JSON.stringify({ id: user.id, email: user.email, name: user.name, picture: user.picture }));

    return reply.redirect(redirectUrl.toString());
  });

  app.get("/auth/me", async (request: FastifyRequest, reply: FastifyReply) => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      return reply.code(401).send({ ok: false, error: "missing_token" });
    }

    try {
      const payload = verifyJwt(authorization.slice("Bearer ".length));
      const user = payload.email ? await authDatabase.findUserByEmail(payload.email) : null;
      if (!user) {
        return reply.code(401).send({ ok: false, error: "user_not_found" });
      }

      return reply.send({ ok: true, user: { id: user.id, email: user.email, name: user.name, picture: user.picture } });
    } catch {
      return reply.code(401).send({ ok: false, error: "invalid_token" });
    }
  });
}
