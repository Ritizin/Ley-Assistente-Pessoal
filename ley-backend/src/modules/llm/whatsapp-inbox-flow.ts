import { whatsappService } from "../whatsapp/index.js";
import {
  getContactByJid,
  listMessagesByJid,
  listRecentMessages,
  listUnreadMessages,
  markMessageSeen,
  type WaMessageRow,
} from "../whatsapp/whatsapp.repository.js";

// guarda, por conversa, o último jid "em foco" (de quem a Ley acabou de falar
// — seja porque relatou mensagens não lidas dessa pessoa, seja porque tocou
// um áudio dela). Permite responder "e o número dela?" ou "toca de novo"
// sem precisar repetir o nome.
const lastMentionedJid = new Map<string, string>();

const UNREAD_RE =
  /\b(mensage(?:m|ns)|zap|whats(?:app)?)\b[\s\S]*\b(n[ãa]o\s*lid[ao]s?|pendente|pendentes|nova|novas)\b|\b(n[ãa]o\s*lid[ao]s?)\b[\s\S]*\b(mensage(?:m|ns)|zap|whats(?:app)?)\b|\bquem\s+(?:[ée]\s+que\s+)?me\s+mandou\b|\balgu[ée]m\s+me\s+mandou\b/i;

const NUMBER_RE = /\bn[uú]mero\b/i;

const PLAY_AUDIO_RE = /\b(toca|tocar|reproduz|reproduzir|escuta|escutar|ouv(?:e|ir))\b[\s\S]*\b(audio|áudio)\b/i;

// jid de grupo no WhatsApp/Baileys sempre termina em "@g.us" (contato normal
// termina em "@s.whatsapp.net"). Usamos isso pra separar "mensagem de gente"
// de "mensagem de grupo" sem precisar de coluna nova no banco.
const GROUP_JID_SUFFIX = "@g.us";
function isGroupJid(jid: string): boolean {
  return jid.endsWith(GROUP_JID_SUFFIX);
}

// só entra no escopo "grupo" se a pergunta mencionar "grupo(s)" explicitamente
// — por padrão (sem essa palavra) o pedido é sempre sobre conversas normais,
// mesmo que a pessoa pergunte de forma genérica ("alguém me mandou mensagem?").
const GROUP_SCOPE_RE = /\bgrupo(s)?\b/i;

function digitsOf(jid: string): string {
  return jid.split("@")[0];
}

function displayNameOf(jid: string, fallbackFromRow?: string | null): string | null {
  return getContactByJid(jid)?.name ?? fallbackFromRow ?? null;
}

// formato de mensagem dentro do bloco "inbox" que o frontend consome pra
// montar o menu (GeneratedContent.tsx) — texto vira uma linha simples, áudio
// vira um player já com o caminho pro arquivo baixado (sem precisar buscar
// nada de novo quando o usuário abrir o menu).
type InboxMessagePayload =
  | { type: "text"; content: string }
  | { type: "audio"; path: string; transcript: string | null };

interface InboxContactPayload {
  name: string | null;
  digits: string;
  jid: string;
  messages: InboxMessagePayload[];
}

function toInboxMessage(m: WaMessageRow): InboxMessagePayload {
  if (m.type === "audio" && m.media_path) {
    return { type: "audio", path: `/api/whatsapp/media/${m.id}`, transcript: m.transcript ?? null };
  }
  return { type: "text", content: m.text ?? "(mensagem de um tipo que ainda não sei ler)" };
}

function buildInboxBlock(scope: "individual" | "grupo", contacts: InboxContactPayload[]): string {
  return "```inbox\n" + JSON.stringify({ scope, contacts }) + "\n```";
}

/**
 * Fluxo de "tem mensagem não lida?" / "alguém me mandou mensagem?". Por
 * padrão só considera conversas normais (sem grupo) — só olha grupos quando
 * a pergunta menciona "grupo(s)" explicitamente. Em vez de um texto corrido,
 * devolve um bloco estruturado (```inbox) que o frontend renderiza como um
 * menu: um item por pessoa/grupo, que expande pra mostrar as mensagens —
 * texto lido direto, áudio já com o player pronto pra tocar sem delay.
 */
function handleUnreadCheck(conversationId: string, message: string): string | null {
  if (!UNREAD_RE.test(message)) return null;

  const wantsGroups = GROUP_SCOPE_RE.test(message);
  const scope: "individual" | "grupo" = wantsGroups ? "grupo" : "individual";

  const unread = listUnreadMessages().filter((m) => isGroupJid(m.jid) === wantsGroups);

  if (unread.length === 0) {
    return wantsGroups
      ? "Não tem nenhuma mensagem não lida em grupo agora."
      : "Não tem nenhuma mensagem não lida agora (contando só conversas normais, sem grupo).";
  }

  const byJid = new Map<string, WaMessageRow[]>();
  for (const m of unread) {
    if (!byJid.has(m.jid)) byJid.set(m.jid, []);
    byJid.get(m.jid)!.push(m);
  }

  const contacts: InboxContactPayload[] = [];
  let onlyJid: string | null = null;

  for (const [jid, msgs] of byJid) {
    onlyJid = byJid.size === 1 ? jid : null;
    contacts.push({
      name: displayNameOf(jid, msgs[msgs.length - 1]?.sender_name),
      digits: digitsOf(jid),
      jid,
      messages: msgs.map(toInboxMessage),
    });
  }

  if (onlyJid) lastMentionedJid.set(conversationId, onlyJid);

  // BUG corrigido aqui: essa função só LIA as mensagens não lidas, nunca
  // marcava elas como vistas — então a mesma leva de mensagens antigas
  // reaparecia pra sempre toda vez que o usuário perguntasse de novo, em vez
  // de mostrar só o que chegou de novo desde a última checagem.
  for (const m of unread) markMessageSeen(m.id);

  const totalMsgs = unread.length;
  const noun = wantsGroups ? "grupo" : "pessoa";
  const header =
    `Você tem ${totalMsgs} mensage${totalMsgs > 1 ? "ns" : "m"} não lida${totalMsgs > 1 ? "s" : ""}` +
    ` de ${contacts.length} ${noun}${contacts.length > 1 ? "s" : ""}. Clica pra abrir:`;

  return `${header}\n\n${buildInboxBlock(scope, contacts)}`;
}

/**
 * Fluxo de "qual o número de fulano?" / "me manda o número dela". Resolve
 * por nome explícito na frase ou, se não achar nenhum, cai pro último jid
 * mencionado na conversa (ex: logo depois de relatar quem mandou mensagem).
 */
function handleNumberRequest(conversationId: string, message: string): string | null {
  if (!NUMBER_RE.test(message)) return null;

  const afterKeyword = message.match(/\bn[uú]mero\b\s*(?:d[ae]s?|do)?\s*(.*)/i);
  const rawQuery = (afterKeyword?.[1] ?? "").trim().replace(/[?.!]+$/, "");

  // pronomes/expressões que remetem a quem já foi mencionado, não a um novo nome
  const refersToLastMentioned =
    rawQuery.length === 0 || /^(dela|dele|dessa pessoa|desse contato|desse n[uú]mero|quem\s+mandou|de\s+quem\s+mandou)$/i.test(rawQuery);

  let jid: string | null = null;
  let name: string | null = null;

  if (!refersToLastMentioned) {
    const contact = whatsappService.resolveContact(rawQuery);
    if (contact) {
      jid = contact.jid;
      name = contact.name;
    } else {
      return `Não achei "${rawQuery}" nas suas conversas nem como contato memorizado.`;
    }
  }

  if (!jid) {
    jid = lastMentionedJid.get(conversationId) ?? null;
    if (jid) name = displayNameOf(jid);
  }

  if (!jid) {
    return "Não sei de quem você tá falando — me diz o nome, ou pergunta depois que eu contar quem te mandou mensagem.";
  }

  lastMentionedJid.set(conversationId, jid);
  const digits = digitsOf(jid);
  return name ? `O número de ${name} é ${digits}.` : `O número é ${digits}.`;
}

/**
 * Fluxo de "toca o áudio de fulano" / "toca o áudio que chegou". Devolve um
 * bloco especial (mesma convenção do file-mode: code fence com atributo
 * "path") que o frontend reconhece e renderiza como um player de áudio,
 * apontando pro arquivo já baixado do WhatsApp — não só o texto transcrito.
 */
function handlePlayAudio(conversationId: string, message: string): string | null {
  if (!PLAY_AUDIO_RE.test(message)) return null;

  const nameMatch = message.match(/\b(?:de|da|do)\s+(.+)$/i);
  let jid: string | null = null;
  let name: string | null = null;

  if (nameMatch) {
    const nameQuery = nameMatch[1].trim().replace(/[?.!]+$/, "");
    const contact = whatsappService.resolveContact(nameQuery);
    if (contact) {
      jid = contact.jid;
      name = contact.name ?? nameQuery;
    }
  }

  if (!jid) jid = lastMentionedJid.get(conversationId) ?? null;

  let audioMsg: WaMessageRow | undefined;

  if (jid) {
    const msgs = listMessagesByJid(jid, 200);
    audioMsg = [...msgs].reverse().find((m) => m.type === "audio" && m.media_path);
    if (!name) name = displayNameOf(jid);
  } else {
    // sem contato identificado — pega o áudio recebido mais recente entre
    // todas as conversas
    const recent = listRecentMessages(200).filter((m) => !m.from_me);
    audioMsg = recent.find((m) => m.type === "audio" && m.media_path);
    if (audioMsg) {
      jid = audioMsg.jid;
      name = displayNameOf(jid, audioMsg.sender_name);
    }
  }

  if (!audioMsg) {
    return name ? `Não achei nenhum áudio de ${name} pra tocar.` : "Não achei nenhum áudio recebido pra tocar.";
  }

  if (jid) lastMentionedJid.set(conversationId, jid);

  const transcript = (audioMsg.transcript ?? "").replace(/\n/g, " ").trim();
  const heading = name ? `Aqui está o áudio de ${name}:` : "Aqui está o áudio:";

  return `${heading}\n\n\`\`\`audio path="/api/whatsapp/media/${audioMsg.id}"\n${transcript}\n\`\`\``;
}

/**
 * Ponto de entrada único desse módulo — tenta cada sub-fluxo em ordem e
 * retorna a primeira resposta não nula. `null` significa "não é sobre isso,
 * segue o fluxo normal" (mesmo contrato dos outros arquivos *-flow.ts).
 */
export function handleWhatsAppInboxFlow(conversationId: string, message: string): string | null {
  return (
    handleUnreadCheck(conversationId, message) ??
    handlePlayAudio(conversationId, message) ??
    handleNumberRequest(conversationId, message)
  );
}
