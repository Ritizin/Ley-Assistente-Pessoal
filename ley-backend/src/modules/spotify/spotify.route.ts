import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { spotifyService } from "./spotify.service.js";

const playBodySchema = z.object({ query: z.string().min(1).optional() });

export async function spotifyRoutes(app: FastifyInstance): Promise<void> {
  // abre o navegador direto na tela de login do Spotify
  app.get("/api/spotify/login", async (_req, reply) => {
    try {
      return reply.redirect(spotifyService.getAuthUrl());
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // o Spotify chama essa URL de volta depois do login, com o "code"
  app.get("/api/spotify/callback", async (req, reply) => {
    const { code, error } = req.query as { code?: string; error?: string };

    if (error || !code) {
      return reply.type("text/html").send(
        `<html><body style="font-family:sans-serif;background:#0a0e1a;color:#fff;text-align:center;padding-top:60px">
          <h2>Falha ao conectar o Spotify</h2><p>${error ?? "code ausente"}</p>
          <p>Pode fechar essa aba e tentar de novo pelo painel.</p>
        </body></html>`
      );
    }

    try {
      await spotifyService.handleAuthCallback(code);
      return reply.type("text/html").send(
        `<html><body style="font-family:sans-serif;background:#0a0e1a;color:#fff;text-align:center;padding-top:60px">
          <h2>Spotify conectado! 🎧</h2><p>Pode fechar essa aba e voltar pro painel da Ley.</p>
        </body></html>`
      );
    } catch (err) {
      app.log.error({ err }, "falha ao trocar code do Spotify");
      return reply.type("text/html").send(
        `<html><body style="font-family:sans-serif;background:#0a0e1a;color:#fff;text-align:center;padding-top:60px">
          <h2>Erro ao conectar</h2><p>${(err as Error).message}</p>
        </body></html>`
      );
    }
  });

  app.get("/api/spotify/status", async () => spotifyService.getSnapshot());

  app.post("/api/spotify/disconnect", async () => {
    spotifyService.disconnect();
    return { ok: true };
  });

  app.post("/api/spotify/play", async (req, reply) => {
    const parsed = playBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "payload inválido" });

    try {
      if (parsed.data.query) {
        const played = await spotifyService.searchAndPlay(parsed.data.query);
        return { ok: true, played };
      }
      await spotifyService.play();
      return { ok: true };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.post("/api/spotify/pause", async (_req, reply) => {
    try {
      await spotifyService.pause();
      return { ok: true };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.post("/api/spotify/next", async (_req, reply) => {
    try {
      await spotifyService.next();
      return { ok: true };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.post("/api/spotify/previous", async (_req, reply) => {
    try {
      await spotifyService.previous();
      return { ok: true };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });
}
