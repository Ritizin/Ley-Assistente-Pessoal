import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { processChatMessage } from "./chat.service.js";
import { addMessage, touchConversation } from "./history.repository.js";
import { clearPending, getPending } from "./send-audio-flow.js";
import { setLastUploadedFile } from "./uploaded-files.js";
import { wsHub } from "../../ws/hub.js";
import { whatsappService } from "../whatsapp/index.js";
import { convertToOggOpus } from "../tts/audio-convert.js";

const UPLOAD_DIR = path.resolve("storage/uploads");

// extensões/mimetypes cujo conteúdo dá pra ler como texto puro e mandar direto
// pro contexto do modelo (arquivos binários pesados tipo pdf/docx só ficam
// salvos + com um resumo de nome/tamanho, sem leitura de conteúdo por enquanto)
const TEXT_LIKE_EXT = new Set([
  ".txt", ".md", ".csv", ".json", ".log", ".yml", ".yaml", ".xml", ".html", ".css",
  ".js", ".ts", ".tsx", ".jsx", ".py", ".java", ".c", ".cpp", ".sh", ".sql", ".ini", ".env",
]);

function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

function isTextLike(mime: string, filename: string): boolean {
  if (mime.startsWith("text/")) return true;
  const ext = path.extname(filename).toLowerCase();
  return TEXT_LIKE_EXT.has(ext);
}

// limite de quanto conteúdo de arquivo de texto entra no contexto — evita
// estourar a janela de contexto do modelo com um arquivo gigante
const MAX_TEXT_CONTEXT_CHARS = 6000;

const chatBodySchema = z.object({
  conversationId: z.string().optional(),
  message: z.string().min(1, "message não pode ser vazia"),
  // frame da tela compartilhada no modo de voz, em base64 (JPEG) sem o prefixo data:
  imageBase64: z.string().optional(),
});

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/chat", async (request, reply) => {
    const parsed = chatBodySchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({ error: "payload inválido", details: parsed.error.flatten() });
    }

    try {
      const result = await processChatMessage(parsed.data);
      return reply.send(result);
    } catch (err) {
      app.log.error({ err }, "erro ao processar /api/chat");
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({ error: "falha ao consultar o modelo", detail: message });
    }
  });

  // completa o fluxo de "manda um áudio pra fulano" quando o usuário escolheu
  // mandar "com a minha voz": recebe o áudio gravado no painel (multipart) e
  // repassa pro WhatsApp como mensagem de voz.
  app.post("/api/chat/send-my-voice", async (request, reply) => {
    const data = await request.file();
    if (!data) {
      return reply.code(400).send({ error: "arquivo de áudio obrigatório" });
    }

    const conversationId = (data.fields as Record<string, { value?: string }>)?.conversationId?.value;
    if (!conversationId) {
      return reply.code(400).send({ error: "conversationId obrigatório" });
    }

    const pending = getPending(conversationId);
    if (!pending || pending.step !== "aguardando_gravacao") {
      return reply.code(409).send({ error: "nenhum envio de áudio pendente pra essa conversa" });
    }

    try {
      const buffer = await data.toBuffer();
      // o MediaRecorder do navegador grava em container WebM — o WhatsApp só
      // reproduz nota de voz em OGG/Opus de verdade, precisa converter
      const oggBuffer = await convertToOggOpus(buffer, "webm");
      await whatsappService.sendAudio(pending.jid!, oggBuffer);
      clearPending(conversationId);

      const confirmMsg = `Prontinho, mandei seu áudio pra ${pending.contactName}.`;
      addMessage(conversationId, "assistant", confirmMsg);
      touchConversation(conversationId);
      wsHub.broadcast("chat", "message", { conversationId, role: "assistant", content: confirmMsg });

      return reply.send({ ok: true, reply: confirmMsg });
    } catch (err) {
      request.log.error({ err }, "falha ao enviar áudio gravado pelo usuário pro WhatsApp");
      return reply.code(502).send({ error: "falha ao enviar áudio pro WhatsApp" });
    }
  });

  // recebe arquivo(s) anexados no chat (upload comum ou foto tirada na hora
  // pela câmera) junto com uma legenda opcional. Imagem -> vai pro modelo de
  // visão. Arquivo de texto reconhecido -> conteúdo entra no contexto enviado
  // ao modelo. Qualquer outro tipo -> fica salvo em disco e o modelo só recebe
  // o nome/tipo/tamanho (ainda não lemos PDF/DOCX/etc. por dentro).
  app.post("/api/chat/upload", async (request, reply) => {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });

    let conversationId: string | undefined;
    let caption = "";
    let imageBase64: string | undefined;
    let textContext = "";
    const savedFiles: { name: string; mime: string; size: number; path: string }[] = [];

    try {
      const parts = request.parts();

      for await (const part of parts) {
        if (part.type === "file") {
          const buffer = await part.toBuffer();
          if (buffer.length === 0) continue;

          const filename = part.filename || "arquivo-sem-nome";
          const mime = part.mimetype || "application/octet-stream";

          const safeName = `${Date.now()}-${randomUUID()}-${filename}`.replace(/[/\\]/g, "_");
          const savedPath = path.join(UPLOAD_DIR, safeName);
          await fs.writeFile(savedPath, buffer);

          savedFiles.push({ name: filename, mime, size: buffer.length, path: savedPath });

          if (!imageBase64 && isImageMime(mime)) {
            imageBase64 = buffer.toString("base64");
          } else if (isTextLike(mime, filename)) {
            const text = buffer.toString("utf-8").slice(0, MAX_TEXT_CONTEXT_CHARS);
            textContext += `\n\n[ARQUIVO ANEXADO: ${filename}]\n${text}`;
          }
        } else if (part.fieldname === "conversationId") {
          conversationId = String(part.value ?? "") || undefined;
        } else if (part.fieldname === "message") {
          caption = String(part.value ?? "");
        }
      }
    } catch (err) {
      request.log.error({ err }, "falha ao processar upload de arquivo(s)");
      return reply.code(400).send({ error: "falha ao processar o(s) arquivo(s) enviado(s)" });
    }

    if (savedFiles.length === 0) {
      return reply.code(400).send({ error: "nenhum arquivo enviado" });
    }

    const fileSummary = savedFiles
      .map((f) => `- ${f.name} (${f.mime}, ${(f.size / 1024).toFixed(1)} KB)`)
      .join("\n");

    const message = caption.trim() || `Enviei ${savedFiles.length} arquivo(s): ${savedFiles.map((f) => f.name).join(", ")}`;

    const fileContext = `\n\n[ARQUIVOS ANEXADOS PELO USUÁRIO NESSA MENSAGEM]\n${fileSummary}${textContext}`;

    try {
      const result = await processChatMessage({ conversationId, message, imageBase64, fileContext });

      // guarda o arquivo mais recente anexado nessa mensagem como "último
      // anexado" da conversa (já resolvida/criada por processChatMessage) —
      // se o usuário pedir em seguida "manda esse arquivo pra fulano", o
      // send-file-flow sabe qual arquivo pegar do disco pra enviar
      const lastFile = savedFiles[savedFiles.length - 1];
      if (lastFile) {
        setLastUploadedFile(result.conversationId, {
          path: lastFile.path,
          filename: lastFile.name,
          mimetype: lastFile.mime,
        });
      }

      return reply.send({ ...result, files: savedFiles.map(({ path: _p, ...f }) => f) });
    } catch (err) {
      app.log.error({ err }, "erro ao processar /api/chat/upload");
      return reply.status(502).send({ error: "falha ao consultar o modelo" });
    }
  });
}
