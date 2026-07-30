import { logger } from "../../core/logger.js";
import { whatsappService } from "../whatsapp/index.js";

type FlowStep = "aguardando_contato" | "aguardando_conteudo" | "aguardando_nome_para_salvar";

export interface PendingSendText {
  step: FlowStep;
  jid?: string;
  contactName?: string;
  pendingContent?: string; // conteúdo já dado enquanto ainda faltava resolver o contato
}

// estado em memória por conversa — mesmo princípio do fluxo de envio de áudio:
// app single-user local, não precisa persistir em disco.
const pending = new Map<string, PendingSendText>();

// dispara tanto pra "manda uma mensagem/msg/texto pra fulano" quanto pra
// "manda pra fulano dizendo/falando ..." — sempre exigindo uma das palavras-chave
// de mensagem de texto pra não conflitar com o fluxo de áudio nem disparar à toa
// em conversas comuns.
const START_RE =
  /\b(manda|mandar|envia|enviar|escreve|escrever)\b.*\b(mensagem|msg|texto|zap|whats(?:app)?)\b.*\b(pra|para|pro)\s+(.+)/i;

// fallback sem a palavra-chave: cobre "manda pro João: chegando em 10 min",
// um padrão bem comum. Só dispara quando há ":" (dois-pontos) logo depois do
// nome, já que isso deixa a intenção inequívoca mesmo sem dizer "mensagem".
const START_COLON_RE = /\b(manda|mandar|envia|enviar)\b.*\b(pra|para|pro)\s+([^:]+):\s*(.+)/i;

// dispara mesmo sem contato definido ainda, ex: "quero mandar uma mensagem" —
// entra no fluxo e pergunta pra quem, em vez de deixar cair no papo comum
const START_NO_CONTACT_RE = /\b(manda|mandar|envia|enviar|escreve|escrever)\b.*\b(mensagem|msg|texto)\b/i;

const CANCEL_RE = /^(cancela|cancelar|deixa pra l[áa]|esquece(?:\s+isso)?)\b/i;
const SKIP_SAVE_RE = /^(n[ãa]o|n[ãa]o precisa|deixa|pode deixar|dispensa)\b/i;

// separa "nome do contato" de "conteúdo da mensagem" quando vêm na mesma frase,
// ex: "manda uma mensagem pra Maria dizendo bom dia" ou "manda pro João: chegando em 10"
const CONTENT_SPLIT_RE = /^(.*?)\s*(?::|,|\bdizendo\b|\bfalando\b|\bavisando\b)\s*(.+)$/i;

// BUG corrigido aqui: o START_RE/START_COLON_RE são propositalmente genéricos
// (qualquer coisa depois de "pra/para/pro" vira "contato"), então uma frase
// como "manda uma mensagem no instagram dizendo bom dia" ou "manda uma
// mensagem pro spotify tocar" era capturada por ESTE fluxo antes de chegar
// nos fluxos de Instagram/Spotify/Google Home no chat.service.ts (que rodam
// depois, na ordem dos handlers). O resultado era a Ley tentar resolver
// "instagram"/"spotify" como se fosse um contato do WhatsApp e perguntar
// "não achei esse contato, me manda o número...". Esses nomes reservados
// interrompem o fluxo (retornando null) e deixam o próximo handler do
// chat.service.ts tratar a intenção certa.
const RESERVED_TARGETS = [
  "instagram",
  "spotify",
  "alexa",
  "google home",
  "casa",
  "ar condicionado",
  "aquecimento",
  "termostato",
  "luz",
  "luzes",
];

function isReservedTarget(name: string): boolean {
  const n = name.trim().toLowerCase();
  return RESERVED_TARGETS.some((r) => n === r || n.includes(r));
}

export function getPendingText(conversationId: string): PendingSendText | undefined {
  return pending.get(conversationId);
}

export function clearPendingText(conversationId: string): void {
  pending.delete(conversationId);
}

/**
 * Trata o fluxo de "manda uma mensagem pra fulano". Retorna a resposta da Ley
 * quando a mensagem pertence a esse fluxo, ou `null` quando deve seguir o
 * caminho normal (ir pro LLM, ou pro próximo fluxo específico, ex:
 * Instagram/Spotify/Google Home). Importante: uma vez dentro do fluxo
 * (pending setado), a próxima mensagem SEMPRE é tratada aqui — nunca cai no
 * LLM genérico, que não tem como realmente enviar nada e podia inventar que
 * já mandou.
 */
export async function handleSendTextFlow(
  conversationId: string,
  message: string
): Promise<string | null> {
  const current = pending.get(conversationId);

  if (current && CANCEL_RE.test(message)) {
    pending.delete(conversationId);
    return "Beleza, cancelei.";
  }

  if (!current) {
    const match = message.match(START_RE);
    const colonMatch = !match ? message.match(START_COLON_RE) : null;

    if (match || colonMatch) {
      let contactQuery: string;
      let inlineContent: string | null;

      if (match) {
        const rest = match[4].trim().replace(/[?.!]+$/, "");
        const split = rest.match(CONTENT_SPLIT_RE);
        contactQuery = (split ? split[1] : rest).trim();
        inlineContent = split ? split[2].trim() : null;
      } else {
        contactQuery = colonMatch![3].trim().replace(/[?.!]+$/, "");
        inlineContent = colonMatch![4].trim();
      }

      // alvo bate com outro domínio (Instagram/Spotify/Google Home/etc) —
      // não é um contato do WhatsApp, deixa o próximo fluxo do
      // chat.service.ts cuidar disso.
      if (isReservedTarget(contactQuery)) return null;

      return resolveAndProceed(conversationId, contactQuery, inlineContent);
    }

    // não veio contato junto (ex: "quero mandar uma mensagem") — entra no
    // fluxo mesmo assim e pergunta pra quem, em vez de deixar isso pro LLM
    if (START_NO_CONTACT_RE.test(message)) {
      pending.set(conversationId, { step: "aguardando_contato" });
      return "Beleza, pra quem eu mando? Me fala o nome (como tá salvo no zap) ou o número com DDD.";
    }

    return null;
  }

  if (current.step === "aguardando_contato") {
    const contactQuery = message.trim();

    if (isReservedTarget(contactQuery)) {
      // usuário respondeu algo que não é contato (ex: mudou de ideia e
      // pediu pro Instagram/Spotify) — sai do fluxo em vez de tentar
      // resolver isso como número/nome de contato
      pending.delete(conversationId);
      return null;
    }

    return resolveAndProceed(conversationId, contactQuery, current.pendingContent ?? null);
  }

  if (current.step === "aguardando_conteudo") {
    return sendNow(conversationId, current.jid!, current.contactName ?? null, message.trim());
  }

  if (current.step === "aguardando_nome_para_salvar") {
    if (SKIP_SAVE_RE.test(message)) {
      pending.delete(conversationId);
      return "Beleza, não salvei.";
    }

    const name = message.trim();
    if (name.length < 2 || name.length > 80) {
      return "Esse nome não parece válido. Manda de novo com o nome completo.";
    }

    // mesmo princípio do save-contact-flow: só confirma "salvei" depois que
    // o banco de fato confirmou a escrita, com try/catch e log detalhado —
    // evita o mesmo falso positivo aqui.
    try {
      await whatsappService.saveContact(name, current.jid!);
    } catch (err) {
      logger.error({ err, name, jid: current.jid }, "handleSendTextFlow: falha ao salvar contato");
      pending.delete(conversationId);
      return "A mensagem foi enviada, mas não consegui confirmar o salvamento do contato. Tenta salvar de novo depois.";
    }

    pending.delete(conversationId);
    return `Show, salvei ${name}! Da próxima já mando só chamando pelo nome.`;
  }

  return null;
}

// tenta achar o contato (por nome, memorizado ou número) e decide o próximo
// passo: pedir conteúdo, mandar direto (se já tiver conteúdo) ou pedir o
// contato de novo (sem cair no LLM) quando não encontra ninguém.
async function resolveAndProceed(
  conversationId: string,
  contactQuery: string,
  inlineContent: string | null
): Promise<string> {
  const contact = whatsappService.resolveContact(contactQuery);

  if (!contact) {
    pending.set(conversationId, {
      step: "aguardando_contato",
      pendingContent: inlineContent ?? undefined,
    });
    return `Não achei "${contactQuery}" nas suas conversas do WhatsApp nem como contato memorizado. Me manda o número com DDD (ex: 11999998888) que eu mando por lá, ou confere o nome e tenta de novo.`;
  }

  if (inlineContent) {
    return sendNow(conversationId, contact.jid, contact.name, inlineContent);
  }

  pending.set(conversationId, {
    step: "aguardando_conteudo",
    jid: contact.jid,
    contactName: contact.name ?? undefined,
  });

  return `Beleza, vou mandar uma mensagem pra ${contact.name ?? "esse número"}. O que você quer que eu mande?`;
}

async function sendNow(
  conversationId: string,
  jid: string,
  contactName: string | null,
  content: string
): Promise<string> {
  try {
    await whatsappService.sendText(jid, content);

    if (!contactName) {
      // mandou pra um número que a Ley não tinha nome salvo — oferece
      // memorizar o contato pra próxima vez o usuário poder chamar pelo nome
      const digits = jid.split("@")[0];
      pending.set(conversationId, { step: "aguardando_nome_para_salvar", jid });
      return `Prontinho, mandei "${content}" pro número ${digits}. Quer que eu salve esse contato? Me diz o nome (ou fala "não precisa").`;
    }

    pending.delete(conversationId);
    return `Prontinho, mandei "${content}" pra ${contactName}.`;
  } catch (err) {
    logger.error({ err }, "falha ao enviar mensagem de texto pro WhatsApp");
    pending.delete(conversationId);
    return `Deu ruim pra mandar a mensagem agora — confere se o WhatsApp tá conectado e tenta de novo.`;
  }
}
