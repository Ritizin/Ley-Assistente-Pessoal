import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getIgDmSetting,
  listContacts,
  listMessagesByThread,
  listRecentMessages,
  listUnreadMessages,
  markAllSeen,
  markSeenByThread,
  setContactAutopilot,
  setContactPinned,
  setIgDmSetting,
} from "./instagram-dm.repository.js";
import { instagramDmService } from "./instagram-dm.service.js";

const sendBodySchema = z.object({
  threadId: z.string().min(1),
  text: z.string().min(1),
});

const autopilotGlobalBodySchema = z.object({ enabled: z.boolean() });

const autopilotThreadBodySchema = z.object({
  threadId: z.string().min(1),
  // null = volta a seguir o padrão global
  enabled: z.boolean().nullable(),
});

const pinBodySchema = z.object({
  threadId: z.string().min(1),
  pinned: z.boolean(),
});

const threadIdBodySchema = z.object({ threadId: z.string().min(1) });

export async function instagramDmRoutes(app: FastifyInstance): Promise<void> {
  // status da conexão (conectado/conectando/checkpoint) — o painel também
  // recebe isso via WS (canal "instagram-dm"), essa rota é só pra sincronizar
  // quem abriu a aba depois do evento original
  app.get("/api/instagram-dm/status", async () => instagramDmService.getSnapshot());

  // reconecta manualmente (útil depois de resolver um checkpoint no
  // app/site oficial, ou depois de configurar as credenciais no .env)
  app.post("/api/instagram-dm/connect", async () => {
    void instagramDmService.start();
    return { ok: true };
  });

  app.post("/api/instagram-dm/disconnect", async () => {
    instagramDmService.stop();
    return { ok: true };
  });

  app.get("/api/instagram-dm/threads", async () => listContacts());

  app.get("/api/instagram-dm/messages", async (req) => {
    const { unread, threadId } = req.query as { unread?: string; threadId?: string };
    if (threadId) return listMessagesByThread(threadId, 200);
    return unread === "true" ? listUnreadMessages() : listRecentMessages(100);
  });

  app.post("/api/instagram-dm/send", async (req, reply) => {
    const parsed = sendBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    try {
      await instagramDmService.sendText(parsed.data.threadId, parsed.data.text);
      return { ok: true };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/instagram-dm/mark-seen", async (req, reply) => {
    const parsed = threadIdBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return { count: markSeenByThread(parsed.data.threadId) };
  });

  app.post("/api/instagram-dm/mark-all-seen", async () => ({ count: markAllSeen() }));

  app.post("/api/instagram-dm/pin", async (req, reply) => {
    const parsed = pinBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    setContactPinned(parsed.data.threadId, parsed.data.pinned);
    return { ok: true };
  });

  // toggle global do autopilot (igual /api/whatsapp/autopilot)
  app.get("/api/instagram-dm/autopilot", async () => ({
    enabled: getIgDmSetting("autopilot_global") !== "0",
  }));

  app.post("/api/instagram-dm/autopilot", async (req, reply) => {
    const parsed = autopilotGlobalBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    setIgDmSetting("autopilot_global", parsed.data.enabled ? "1" : "0");
    return { ok: true };
  });

  // override de autopilot por thread específica
  app.post("/api/instagram-dm/autopilot/thread", async (req, reply) => {
    const parsed = autopilotThreadBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const value = parsed.data.enabled === null ? null : parsed.data.enabled ? 1 : 0;
    setContactAutopilot(parsed.data.threadId, value);
    return { ok: true };
  });
}
