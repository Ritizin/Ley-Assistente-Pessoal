import { logger } from "../../core/logger.js";
import { whatsappService } from "../whatsapp/index.js";
import { synthesizeSpeech } from "../tts/tts.service.js";
import { synthesizeSpeechPiper } from "../tts/piper.service.js";
import { convertToOggOpus } from "../tts/audio-convert.js";

type FlowStep = "aguardando_contato" | "aguardando_conteudo" | "aguardando_escolha_voz" | "aguardando_gravacao";

export interface PendingSendAudio {
  step: FlowStep;
  jid?: string;
  contactName?: string;
  content?: string;
  pendingContent?: string; // conteúdo já dado enquanto ainda faltava resolver o contato
}

// estado em memória por conversa — a Ley é um app single-user local, então não
// precisa persistir isso em disco; se o servidor reiniciar no meio do fluxo,
// o usuário só pede de novo.
const pending = new Map<string, PendingSendAudio>();

const START_RE = /\b(manda|mandar|envia|enviar)\b.*\b(audio|áudio)\b.*\b(pra|para|pro)\s+(.+)/i;

// fallback tolerante: se a transcrição de voz vier sem "pra fulano" bem
// formado (comum quando o número sai picotado pelo reconhecimento de fala),
// entra no fluxo mesmo assim e pergunta pra quem, em vez de deixar cair no
// LLM genérico — que não sabe que existe a função de mandar áudio.
const START_NO_CONTACT_RE = /\b(manda|mandar|envia|enviar)\b.*\b(audio|áudio)\b/i;
const CANCEL_RE = /^(cancela|cancelar|deixa pra l[áa]|esquece(?:\s+isso)?)\b/i;
const MY_VOICE_RE = /\b(minha|com a minha voz|com minha voz|meu)\b/i;
const LEY_VOICE_RE = /\b(sua|tua|com a sua voz|com sua voz|dela|voz da ley|voc[eê])\b/i;

export function getPending(conversationId: string): PendingSendAudio | undefined {
  return pending.get(conversationId);
}

export function clearPending(conversationId: string): void {
  pending.delete(conversationId);
}

/**
 * Trata o fluxo de "manda um áudio pra fulano". Retorna a resposta da Ley
 * quando a mensagem pertence a esse fluxo, ou `null` quando a mensagem deve
 * seguir o caminho normal (ir pro LLM).
 */
export async function handleSendAudioFlow(
  conversationId: string,
  message: string
): Promise<string | null> {
  const current = pending.get(conversationId);

  if (current && CANCEL_RE.test(message)) {
    pending.delete(conversationId);
    return "Beleza, cancelei o envio do áudio.";
  }

  if (!current) {
    const match = message.match(START_RE);

    if (match) {
      const contactQuery = match[4].trim().replace(/[?.!,]+$/, "");
      return resolveAndProceed(conversationId, contactQuery, null);
    }

    // não veio "pra fulano" bem formado (comum quando o número sai picotado
    // pela transcrição de voz) — entra no fluxo mesmo assim e pergunta pra
    // quem, em vez de deixar isso escapar pro LLM genérico
    if (START_NO_CONTACT_RE.test(message)) {
      pending.set(conversationId, { step: "aguardando_contato" });
      return "Beleza, áudio pra quem? Me fala o nome (como tá salvo no zap) ou o número com DDD.";
    }

    return null;
  }

  if (current.step === "aguardando_contato") {
    return resolveAndProceed(conversationId, message.trim(), current.pendingContent ?? null);
  }

  if (current.step === "aguardando_conteudo") {
    current.content = message.trim();
    current.step = "aguardando_escolha_voz";
    return `Show. Quer que eu mande com a sua voz ou com a minha?`;
  }

  if (current.step === "aguardando_escolha_voz") {
    if (MY_VOICE_RE.test(message)) {
      current.step = "aguardando_gravacao";
      return `Fechado, aperta o microfone e grava o áudio que eu mando pra ${current.contactName} do jeitinho que você falar.`;
    }

    if (LEY_VOICE_RE.test(message)) {
      const { jid, contactName, content } = current;
      try {
        const audio = await synthesizeAudioBuffer(content ?? "");
        await whatsappService.sendAudio(jid!, audio);
        pending.delete(conversationId);
        return `Prontinho, mandei o áudio com a minha voz pra ${contactName}.`;
      } catch (err) {
        logger.error({ err }, "falha ao gerar/enviar áudio com a voz da Ley");
        pending.delete(conversationId);
        return `Deu ruim pra gerar o áudio agora, tenta de novo daqui a pouco.`;
      }
    }

    return `Não entendi. É pra mandar com a sua voz ou com a minha?`;
  }

  if (current.step === "aguardando_gravacao") {
    return `Ainda tô esperando você gravar o áudio pelo microfone pra mandar pra ${current.contactName}.`;
  }

  return null;
}

// tenta achar o contato (por nome, memorizado ou número) e decide o próximo
// passo: pedir conteúdo ou pedir o contato de novo (sem cair no LLM) quando
// não encontra ninguém — igual o fluxo de texto faz.
function resolveAndProceed(
  conversationId: string,
  contactQuery: string,
  pendingContent: string | null
): string {
  const contact = whatsappService.resolveContact(contactQuery);

  if (!contact) {
    pending.set(conversationId, {
      step: "aguardando_contato",
      pendingContent: pendingContent ?? undefined,
    });
    return `Não achei "${contactQuery}" nas suas conversas do WhatsApp nem como contato memorizado. Me manda o número com DDD (ex: 11999998888) que eu mando por lá, ou confere o nome e tenta de novo.`;
  }

  pending.set(conversationId, {
    step: "aguardando_conteudo",
    jid: contact.jid,
    contactName: contact.name ?? contactQuery,
  });

  return `Beleza, vou mandar um áudio pra ${contact.name ?? contactQuery}. O que você quer que eu fale?`;
}

async function synthesizeAudioBuffer(text: string): Promise<Buffer> {
  // mesma cascata usada em /api/tts: ElevenLabs primeiro, Piper local como fallback
  let raw: Buffer;
  let format: "mp3" | "wav";

  try {
    const { audio } = await synthesizeSpeech(text);
    raw = audio;
    format = "mp3";
  } catch {
    raw = await synthesizeSpeechPiper(text);
    format = "wav";
  }

  // nenhuma das duas fontes gera OGG/Opus de verdade — sem essa conversão o
  // WhatsApp recebe o arquivo mas mostra "áudio não disponível" pra quem abre
  return convertToOggOpus(raw, format);
}
