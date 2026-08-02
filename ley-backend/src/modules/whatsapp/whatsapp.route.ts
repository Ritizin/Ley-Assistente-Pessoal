import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getContactAutopilot,
  getContactByJid,
  getMessageById,
  getStatusById,
  getWaSetting,
  listActiveStatuses,
  listContacts,
  listMessagesByJid,
  listRecentMessages,
  listUnreadMessages,
  markAllSeen,
  markSeenByJid,
  markMessageSeen,
  markStatusSeen,
  setContactAutopilot,
  setWaSetting,
} from "./whatsapp.repository.js";
import { whatsappService } from "./whatsapp.service.js";

const groupCreateBodySchema = z.object({
  subject: z.string().min(1),
  participants: z.array(z.string().min(1)).min(1),
});

const blockBodySchema = z
  .object({
    jid: z.string().min(1).optional(),
    contact: z.string().min(1).optional(),
    block: z.boolean(),
  })
  .refine((data) => data.jid || data.contact, { message: "informe jid ou contact" });

const autopilotGlobalBodySchema = z.object({ enabled: z.boolean() });

const chatJidBodySchema = z.object({ jid: z.string().min(1) });

const statusReplyBodySchema = z.object({ text: z.string().min(1) });

const autopilotContactBodySchema = z
  .object({
    jid: z.string().min(1).optional(),
    contact: z.string().min(1).optional(),
    // null = volta a seguir o padrão global
    enabled: z.boolean().nullable(),
  })
  .refine((data) => data.jid || data.contact, { message: "informe jid ou contact" });

const sendBodySchema = z
  .object({
    jid: z.string().min(1).optional(),
    contact: z.string().min(1).optional(),
    text: z.string().min(1),
  })
  .refine((data) => data.jid || data.contact, { message: "informe jid ou contact" });

const openBodySchema = z
  .object({
    jid: z.string().min(1).optional(),
    contact: z.string().min(1).optional(),
  })
  .refine((data) => data.jid || data.contact, { message: "informe jid ou contact" });

export async function whatsappRoutes(app: FastifyInstance): Promise<void> {
  // BUG corrigido aqui: o painel só sabia o status da conexão pelo snapshot
  // que o WS manda UMA VEZ quando o socket abre. Se a aba WhatsApp fosse
  // montada DEPOIS desse snapshot (ex: usuário abriu o Chat primeiro e só
  // depois clicou em WhatsApp), o componente perdia esse evento único e
  // ficava preso em "Iniciando conexão..." pra sempre, mesmo já conectado.
  // Essa rota deixa o frontend perguntar o status atual a qualquer momento.
  app.get("/api/whatsapp/status", async () => whatsappService.getSnapshot());

  // lista as mensagens mais recentes (ou só as não vistas, com ?unread=true)
  app.get("/api/whatsapp/messages", async (req) => {
    const { unread } = req.query as { unread?: string };
    return unread === "true" ? listUnreadMessages() : listRecentMessages(100);
  });

  app.get("/api/whatsapp/contacts", async () => listContacts());

  // BUG corrigido aqui: o painel só tinha acesso às mensagens NÃO LIDAS
  // (recebidas), então o menu de conversa nunca mostrava o que o próprio
  // usuário mandou nem tinha data/hora. Esse endpoint devolve a conversa
  // inteira (os dois lados) com o WaMessageRow completo (from_me,
  // created_at etc.) pra o frontend montar a conversa de verdade.
  app.get("/api/whatsapp/conversation/:jid", async (req) => {
    const { jid } = req.params as { jid: string };
    return listMessagesByJid(jid, 200);
  });

  app.post("/api/whatsapp/messages/:id/seen", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = markMessageSeen(id);
    if (!ok) return reply.code(404).send({ error: "mensagem não encontrada" });
    return { ok: true };
  });

  app.post("/api/whatsapp/messages/seen-all", async () => ({ marked: markAllSeen() }));

  // marca como lido tudo de um contato/grupo específico — usado pela aba de
  // Notificações ao clicar num aviso, sem afetar as outras conversas.
  app.post("/api/whatsapp/messages/seen-by-jid", async (req) => {
    const { jid } = req.body as { jid: string };
    return { marked: markSeenByJid(jid) };
  });

  // serve o arquivo de áudio de uma mensagem pra tocar no painel
  //
  // BUG corrigido aqui: a resposta não mandava Content-Length nem
  // Accept-Ranges, e não respondia a requisições com header Range. O
  // elemento <audio> do navegador manda um Range request pra descobrir o
  // tamanho/duração do arquivo antes de tocar — sem esses headers ele fica
  // preso em "0:00 / 0:00" e nunca toca. Agora respondemos 206 Partial
  // Content quando vem Range (comportamento padrão de streaming de mídia) e
  // sempre mandamos o Content-Length certo.
  app.get("/api/whatsapp/media/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const message = getMessageById(id);

    if (!message?.media_path || !fs.existsSync(message.media_path)) {
      return reply.code(404).send({ error: "mídia não encontrada" });
    }

    const stat = fs.statSync(message.media_path);
    const mime = message.media_mimetype ?? "audio/ogg";
    const range = req.headers.range;

    reply.header("Content-Type", mime);
    reply.header("Accept-Ranges", "bytes");

    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      const start = match?.[1] ? parseInt(match[1], 10) : 0;
      const end = match?.[2] ? parseInt(match[2], 10) : stat.size - 1;
      const chunkSize = end - start + 1;

      reply.code(206);
      reply.header("Content-Range", `bytes ${start}-${end}/${stat.size}`);
      reply.header("Content-Length", chunkSize);
      return reply.send(fs.createReadStream(message.media_path, { start, end }));
    }

    reply.header("Content-Length", stat.size);
    return reply.send(fs.createReadStream(message.media_path));
  });

  // lista os status ainda dentro da janela de 24h, agrupados por quem
  // postou — é o formato que a tirinha de Status do painel consome direto
  // (um círculo por contato, com os itens em ordem cronológica dentro dele)
  app.get("/api/whatsapp/statuses", async () => {
    const statuses = listActiveStatuses();
    const groups = new Map<string, { jid: string; name: string | null; items: typeof statuses }>();

    for (const s of statuses) {
      const existing = groups.get(s.jid);
      if (existing) {
        existing.items.push(s);
        continue;
      }
      groups.set(s.jid, {
        jid: s.jid,
        name: getContactByJid(s.jid)?.name ?? s.sender_name ?? null,
        items: [s],
      });
    }

    // grupos com pelo menos um item não visto vêm primeiro; dentro de cada
    // grupo os itens já chegam mais recentes -> mais antigos (ordem da
    // query), então inverte pra exibir na ordem em que foram postados
    return Array.from(groups.values())
      .map((g) => ({ ...g, items: g.items.slice().reverse(), hasUnseen: g.items.some((i) => !i.seen) }))
      .sort((a, b) => Number(b.hasUnseen) - Number(a.hasUnseen));
  });

  // marca um status individual como visto (só local ao painel)
  app.post("/api/whatsapp/statuses/:id/seen", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = markStatusSeen(id);
    if (!ok) return reply.code(404).send({ error: "status não encontrado" });
    return { ok: true };
  });

  // responde a um status — vira mensagem direta pro dono, citando o status
  // (igual o WhatsApp de verdade faz; nunca é público)
  app.post("/api/whatsapp/statuses/:id/reply", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = statusReplyBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "payload inválido", details: parsed.error.flatten() });
    }

    try {
      await whatsappService.replyToStatus(id, parsed.data.text);
      return { ok: true };
    } catch (err) {
      req.log.error({ err, id }, "falha ao responder status");
      return reply.code(502).send({ error: err instanceof Error ? err.message : "falha ao responder status" });
    }
  });

  // serve a mídia (foto/vídeo) de um status — mesmo esquema de Range
  // request do /media/:id, senão vídeo de status também fica preso em
  // "0:00 / 0:00"
  app.get("/api/whatsapp/status-media/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const statusRow = getStatusById(id);

    if (!statusRow?.media_path || !fs.existsSync(statusRow.media_path)) {
      return reply.code(404).send({ error: "mídia não encontrada" });
    }

    const stat = fs.statSync(statusRow.media_path);
    const mime = statusRow.media_mimetype ?? "image/jpeg";
    const range = req.headers.range;

    reply.header("Content-Type", mime);
    reply.header("Accept-Ranges", "bytes");

    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      const start = match?.[1] ? parseInt(match[1], 10) : 0;
      const end = match?.[2] ? parseInt(match[2], 10) : stat.size - 1;
      const chunkSize = end - start + 1;

      reply.code(206);
      reply.header("Content-Range", `bytes ${start}-${end}/${stat.size}`);
      reply.header("Content-Length", chunkSize);
      return reply.send(fs.createReadStream(statusRow.media_path, { start, end }));
    }

    reply.header("Content-Length", stat.size);
    return reply.send(fs.createReadStream(statusRow.media_path));
  });

  // envio manual de texto pelo painel (fora do fluxo de chat da Ley)
  app.post("/api/whatsapp/send", async (req, reply) => {
    const parsed = sendBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "payload inválido", details: parsed.error.flatten() });
    }

    const { jid, contact, text } = parsed.data;
    const targetJid = jid ?? whatsappService.resolveContact(contact!)?.jid ?? null;

    if (!targetJid) {
      return reply.code(404).send({ error: "contato não encontrado" });
    }

    try {
      await whatsappService.sendText(targetJid, text);
      return { ok: true };
    } catch (err) {
      req.log.error({ err }, "falha ao enviar mensagem via WhatsApp");
      return reply.code(502).send({ error: "falha ao enviar mensagem" });
    }
  });

  // envio manual de arquivo do PC do usuário pelo painel — funciona tanto
  // pra conversas normais quanto pra grupos, já que o alvo é resolvido do
  // mesmo jeito (jid direto ou nome de contato/grupo memorizado/visto)
  app.post("/api/whatsapp/send-file", async (req, reply) => {
    let jid: string | undefined;
    let contact: string | undefined;
    let caption = "";
    let fileBuffer: Buffer | null = null;
    let filename = "arquivo";
    let mimetype = "application/octet-stream";

    try {
      const parts = req.parts();
      for await (const part of parts) {
        if (part.type === "file") {
          fileBuffer = await part.toBuffer();
          filename = part.filename || filename;
          mimetype = part.mimetype || mimetype;
        } else if (part.fieldname === "jid") {
          jid = String(part.value ?? "") || undefined;
        } else if (part.fieldname === "contact") {
          contact = String(part.value ?? "") || undefined;
        } else if (part.fieldname === "caption") {
          caption = String(part.value ?? "");
        }
      }
    } catch (err) {
      req.log.error({ err }, "falha ao processar upload de arquivo pro WhatsApp");
      return reply.code(400).send({ error: "falha ao processar o arquivo enviado" });
    }

    if (!fileBuffer || fileBuffer.length === 0) {
      return reply.code(400).send({ error: "nenhum arquivo enviado" });
    }

    const targetJid = jid ?? (contact ? whatsappService.resolveContact(contact)?.jid ?? null : null);
    if (!targetJid) {
      return reply.code(404).send({ error: "contato ou grupo não encontrado" });
    }

    try {
      await whatsappService.sendFile(targetJid, fileBuffer, filename, mimetype, caption || undefined);
      return { ok: true };
    } catch (err) {
      req.log.error({ err }, "falha ao enviar arquivo via WhatsApp");
      return reply.code(502).send({ error: "falha ao enviar arquivo" });
    }
  });

  // pede pro painel abrir uma conversa/grupo específico — usado pelo fluxo
  // de chat/voz quando o usuário pede "abre a conversa/o grupo com fulano"
  app.post("/api/whatsapp/open", async (req, reply) => {
    const parsed = openBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "payload inválido", details: parsed.error.flatten() });
    }

    const { jid, contact } = parsed.data;
    const resolved = jid ? { jid, name: null as string | null } : whatsappService.resolveContact(contact!);

    if (!resolved) {
      return reply.code(404).send({ error: "contato ou grupo não encontrado" });
    }

    whatsappService.broadcastOpenConversation(resolved.jid, resolved.name ?? null);
    return { ok: true, jid: resolved.jid, name: resolved.name ?? null };
  });

  // cria um grupo novo — participants aceita nomes memorizados/vistos OU
  // números diretos (mesma resolução usada em /send e /open)
  app.post("/api/whatsapp/group/create", async (req, reply) => {
    const parsed = groupCreateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "payload inválido", details: parsed.error.flatten() });
    }

    const { subject, participants } = parsed.data;
    const jids: string[] = [];
    const notFound: string[] = [];

    for (const p of participants) {
      const resolved = whatsappService.resolveContact(p);
      if (resolved) jids.push(resolved.jid);
      else notFound.push(p);
    }

    if (notFound.length > 0) {
      return reply.code(404).send({ error: "contato(s) não encontrado(s)", notFound });
    }

    try {
      const created = await whatsappService.createGroup(subject, jids);
      return { ok: true, ...created };
    } catch (err) {
      req.log.error({ err }, "falha ao criar grupo no WhatsApp");
      return reply.code(502).send({ error: "falha ao criar grupo" });
    }
  });

  // bloqueia/desbloqueia um contato
  app.post("/api/whatsapp/block", async (req, reply) => {
    const parsed = blockBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "payload inválido", details: parsed.error.flatten() });
    }

    const { jid, contact, block } = parsed.data;
    const targetJid = jid ?? whatsappService.resolveContact(contact!)?.jid ?? null;

    if (!targetJid) {
      return reply.code(404).send({ error: "contato não encontrado" });
    }

    try {
      await whatsappService.setBlockStatus(targetJid, block);
      return { ok: true, jid: targetJid, blocked: block };
    } catch (err) {
      req.log.error({ err }, "falha ao bloquear/desbloquear contato no WhatsApp");
      return reply.code(502).send({ error: "falha ao bloquear/desbloquear contato" });
    }
  });

  // fixa/desafixa uma conversa ou grupo (some no topo da lista)
  app.post("/api/whatsapp/chat/pin", async (req, reply) => {
    const parsed = chatJidBodySchema.extend({ pinned: z.boolean() }).safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "payload inválido", details: parsed.error.flatten() });
    }

    try {
      await whatsappService.pinChat(parsed.data.jid, parsed.data.pinned);
      return { ok: true, jid: parsed.data.jid, pinned: parsed.data.pinned };
    } catch (err) {
      req.log.error({ err }, "falha ao fixar/desafixar conversa");
      return reply.code(502).send({ error: "falha ao fixar/desafixar conversa" });
    }
  });

  // apaga o histórico de uma conversa/grupo, mantendo o contato
  app.post("/api/whatsapp/chat/clear", async (req, reply) => {
    const parsed = chatJidBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "payload inválido", details: parsed.error.flatten() });
    }

    try {
      await whatsappService.clearChat(parsed.data.jid);
      return { ok: true, jid: parsed.data.jid };
    } catch (err) {
      req.log.error({ err }, "falha ao limpar conversa");
      return reply.code(502).send({ error: "falha ao limpar conversa" });
    }
  });

  // remove a conversa/grupo inteiro (contato + mensagens)
  app.post("/api/whatsapp/chat/delete", async (req, reply) => {
    const parsed = chatJidBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "payload inválido", details: parsed.error.flatten() });
    }

    try {
      await whatsappService.deleteChat(parsed.data.jid);
      return { ok: true, jid: parsed.data.jid };
    } catch (err) {
      req.log.error({ err }, "falha ao excluir conversa");
      return reply.code(502).send({ error: "falha ao excluir conversa" });
    }
  });

  // liga/desliga o autopilot (Ley responde sozinha no WhatsApp) globalmente
  app.get("/api/whatsapp/autopilot", async () => ({
    enabled: getWaSetting("autopilot_global") === "1",
  }));

  app.post("/api/whatsapp/autopilot", async (req, reply) => {
    const parsed = autopilotGlobalBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "payload inválido", details: parsed.error.flatten() });
    }
    setWaSetting("autopilot_global", parsed.data.enabled ? "1" : "0");
    return { ok: true, enabled: parsed.data.enabled };
  });

  // override de autopilot pra um contato/grupo específico — útil pra silenciar
  // (mute) uma conversa mesmo com o autopilot global ligado, ou forçar ligado
  // num grupo específico sem precisar chamar "ley" toda vez
  app.post("/api/whatsapp/autopilot/contact", async (req, reply) => {
    const parsed = autopilotContactBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "payload inválido", details: parsed.error.flatten() });
    }

    const { jid, contact, enabled } = parsed.data;
    const targetJid = jid ?? whatsappService.resolveContact(contact!)?.jid ?? null;

    if (!targetJid) {
      return reply.code(404).send({ error: "contato não encontrado" });
    }

    setContactAutopilot(targetJid, enabled === null ? null : enabled ? 1 : 0);
    return { ok: true, jid: targetJid, autopilot: getContactAutopilot(targetJid) };
  });
}
