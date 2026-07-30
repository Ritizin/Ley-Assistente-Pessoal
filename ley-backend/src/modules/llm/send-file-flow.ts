import { logger } from "../../core/logger.js";
import { whatsappService } from "../whatsapp/index.js";
import { getLastUploadedFile, clearLastUploadedFile } from "./uploaded-files.js";

type FlowStep = "aguardando_contato";

export interface PendingSendFile {
  step: FlowStep;
}

// estado em memória por conversa — mesmo princípio dos outros fluxos de envio.
const pending = new Map<string, PendingSendFile>();

// dispara com "manda/envia esse arquivo/documento/pdf/foto/imagem/vídeo pra
// fulano" — exige uma das palavras de arquivo pra não conflitar com o fluxo
// de texto (mensagem/msg/texto) nem o de áudio.
const START_RE =
  /\b(manda|mandar|envia|enviar)\b.*\b(arquivo|documento|pdf|foto|imagem|v[íi]deo|anexo)\b.*\b(pra|para|pro)\s+(.+)/i;

// fallback sem contato definido ainda ("manda esse arquivo") — entra no
// fluxo e pergunta pra quem, igual os outros fluxos de envio fazem
const START_NO_CONTACT_RE = /\b(manda|mandar|envia|enviar)\b.*\b(arquivo|documento|pdf|anexo)\b/i;

const CANCEL_RE = /^(cancela|cancelar|deixa pra l[áa]|esquece(?:\s+isso)?)\b/i;

export function getPendingFile(conversationId: string): PendingSendFile | undefined {
  return pending.get(conversationId);
}

export function clearPendingFile(conversationId: string): void {
  pending.delete(conversationId);
}

/**
 * Trata o fluxo de "manda esse arquivo pra fulano". Sempre usa o ÚLTIMO
 * arquivo anexado pelo usuário no chat dessa conversa (guardado em
 * uploaded-files.ts quando o /api/chat/upload salva o arquivo). Retorna a
 * resposta da Ley quando a mensagem pertence a esse fluxo, ou `null` pra
 * seguir o caminho normal.
 */
export async function handleSendFileFlow(
  conversationId: string,
  message: string
): Promise<string | null> {
  const current = pending.get(conversationId);

  if (current && CANCEL_RE.test(message)) {
    pending.delete(conversationId);
    return "Beleza, cancelei o envio do arquivo.";
  }

  if (!current) {
    const match = message.match(START_RE);

    if (match) {
      const contactQuery = match[4].trim().replace(/[?.!]+$/, "");
      return resolveAndSend(conversationId, contactQuery);
    }

    if (START_NO_CONTACT_RE.test(message)) {
      if (!getLastUploadedFile(conversationId)) {
        return "Você ainda não anexou nenhum arquivo nessa conversa. Anexa o arquivo primeiro e me fala pra quem mandar.";
      }
      pending.set(conversationId, { step: "aguardando_contato" });
      return "Beleza, esse arquivo vai pra quem? Me fala o nome (como tá salvo no zap) ou o número/nome do grupo.";
    }

    return null;
  }

  if (current.step === "aguardando_contato") {
    return resolveAndSend(conversationId, message.trim());
  }

  return null;
}

async function resolveAndSend(conversationId: string, contactQuery: string): Promise<string> {
  const file = getLastUploadedFile(conversationId);

  if (!file) {
    pending.delete(conversationId);
    return "Não achei nenhum arquivo anexado nessa conversa pra mandar. Anexa o arquivo aqui no chat e pede de novo.";
  }

  const contact = whatsappService.resolveContact(contactQuery);

  if (!contact) {
    pending.set(conversationId, { step: "aguardando_contato" });
    return `Não achei "${contactQuery}" nas suas conversas do WhatsApp nem como contato/grupo memorizado. Confere o nome (ou o número com DDD) e tenta de novo.`;
  }

  try {
    await whatsappService.sendFile(contact.jid, await readFile(file.path), file.filename, file.mimetype);
    pending.delete(conversationId);
    clearLastUploadedFile(conversationId);
    return `Prontinho, mandei "${file.filename}" pra ${contact.name ?? "esse número"}.`;
  } catch (err) {
    logger.error({ err }, "falha ao enviar arquivo pro WhatsApp");
    pending.delete(conversationId);
    return "Deu ruim pra mandar o arquivo agora — confere se o WhatsApp tá conectado e tenta de novo.";
  }
}

async function readFile(filePath: string): Promise<Buffer> {
  const { promises: fs } = await import("node:fs");
  return fs.readFile(filePath);
}
