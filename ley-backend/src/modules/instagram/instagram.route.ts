import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../../config/env.js";
import { wsHub } from "../../ws/hub.js";
import { instagramService } from "./instagram.service.js";

const publishPhotoSchema = z.object({
  imageUrl: z.string().url(),
  caption: z.string().default(""),
});

const publishReelSchema = z.object({
  videoUrl: z.string().url(),
  caption: z.string().default(""),
});

const replyCommentSchema = z.object({
  commentId: z.string().min(1),
  message: z.string().min(1),
});

export async function instagramRoutes(app: FastifyInstance): Promise<void> {
  // abre o navegador direto na tela de login do Facebook/Instagram
  app.get("/api/instagram/login", async (_req, reply) => {
    try {
      return reply.redirect(instagramService.getAuthUrl());
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // o Facebook chama essa URL de volta depois do login, com o "code"
  app.get("/api/instagram/callback", async (req, reply) => {
    const { code, error } = req.query as { code?: string; error?: string };

    if (error || !code) {
      return reply.type("text/html").send(
        `<html><body style="font-family:sans-serif;background:#0a0e1a;color:#fff;text-align:center;padding-top:60px">
          <h2>Falha ao conectar o Instagram</h2><p>${error ?? "code ausente"}</p>
          <p>Pode fechar essa aba e tentar de novo pelo painel.</p>
        </body></html>`
      );
    }

    try {
      await instagramService.handleAuthCallback(code);
      return reply.type("text/html").send(
        `<html><body style="font-family:sans-serif;background:#0a0e1a;color:#fff;text-align:center;padding-top:60px">
          <h2>Instagram conectado! 📸</h2><p>Pode fechar essa aba e voltar pro painel da Ley.</p>
        </body></html>`
      );
    } catch (err) {
      app.log.error({ err }, "falha ao trocar code do Instagram");
      return reply.type("text/html").send(
        `<html><body style="font-family:sans-serif;background:#0a0e1a;color:#fff;text-align:center;padding-top:60px">
          <h2>Erro ao conectar</h2><p>${(err as Error).message}</p>
        </body></html>`
      );
    }
  });

  app.get("/api/instagram/status", async () => instagramService.getSnapshot());

  app.post("/api/instagram/disconnect", async () => {
    instagramService.disconnect();
    return { ok: true };
  });

  app.get("/api/instagram/media", async (req, reply) => {
    const { limit } = req.query as { limit?: string };
    try {
      const media = await instagramService.listMedia(limit ? Number(limit) : undefined);
      return { media };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.post("/api/instagram/publish/photo", async (req, reply) => {
    const parsed = publishPhotoSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "payload inválido" });

    try {
      const result = await instagramService.publishPhoto(parsed.data.imageUrl, parsed.data.caption);
      return { ok: true, ...result };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.post("/api/instagram/publish/reel", async (req, reply) => {
    const parsed = publishReelSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "payload inválido" });

    try {
      const result = await instagramService.publishReel(parsed.data.videoUrl, parsed.data.caption);
      return { ok: true, ...result };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.post("/api/instagram/comments/reply", async (req, reply) => {
    const parsed = replyCommentSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "payload inválido" });

    try {
      await instagramService.replyToComment(parsed.data.commentId, parsed.data.message);
      return { ok: true };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // --- Webhook em tempo real (comentários, menções, mensagens no Direct) ---
  // Configurado no painel do Meta for Developers apontando pra essa URL.

  app.get("/api/instagram/webhook", async (req, reply) => {
    const query = req.query as Record<string, string>;
    const mode = query["hub.mode"];
    const token = query["hub.verify_token"];
    const challenge = query["hub.challenge"];

    if (mode === "subscribe" && token && token === env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN) {
      return reply.send(challenge);
    }
    return reply.code(403).send({ error: "verify_token inválido" });
  });

  app.post("/api/instagram/webhook", async (req, reply) => {
    // notifica o painel em tempo real (comentário novo, menção, etc.) — quem
    // quiser reagir automaticamente pode escutar o canal "instagram"/"webhook"
    wsHub.broadcast("instagram", "webhook", req.body);
    return reply.code(200).send({ ok: true });
  });
}
