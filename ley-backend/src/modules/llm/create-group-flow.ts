import { whatsappService } from "../whatsapp/index.js";
import { withAction } from "./action-marker.js";

// dispara em "cria/criar ... grupo ..."
const TRIGGER_RE = /\bcria(r)?\b[\s\S]*\bgrupo\b/i;

/**
 * Trata "cria um grupo chamado Viagem com João e Maria" (ou variações com o
 * nome entre aspas). Precisa do nome do grupo E de pelo menos um participante
 * já conhecido (contato visto/salvo, ou número direto).
 */
export async function handleCreateGroupFlow(message: string): Promise<string | null> {
  if (!TRIGGER_RE.test(message)) return null;

  const quoted = message.match(/["“](.+?)["”]/);
  const namedAfter = message.match(/\bchamado\s+(.+?)(?:\s+com\b|$)/i);
  const subject = (quoted?.[1] ?? namedAfter?.[1] ?? "").trim().replace(/[?.!]+$/, "");

  if (!subject) {
    return `Beleza, qual o nome do grupo? Ex: "cria um grupo chamado Viagem com João e Maria".`;
  }

  const withMatch = message.match(/\bcom\s+(.+)$/i);
  if (!withMatch) {
    return `Falta quem entra no grupo — me diz os nomes. Ex: "com João e Maria".`;
  }

  const names = withMatch[1]
    .replace(/[?.!]+$/, "")
    .split(/,|\se\s/i)
    .map((n) => n.trim())
    .filter(Boolean);

  if (names.length === 0) {
    return `Não entendi quem entra no grupo — me diz pelo menos um nome ou número.`;
  }

  const jids: string[] = [];
  const notFound: string[] = [];

  for (const name of names) {
    const contact = whatsappService.resolveContact(name);
    if (contact) jids.push(contact.jid);
    else notFound.push(name);
  }

  if (notFound.length > 0) {
    return `Não achei ${notFound.join(", ")} nos seus contatos. Salva o número primeiro (ex: "salva o contato Fulano, 11999998888") e chama de novo.`;
  }

  try {
    const created = await whatsappService.createGroup(subject, jids);
    return withAction(
      `Grupo criado: ${created.subject}`,
      `Grupo "${created.subject}" criado com ${jids.length} pessoa${jids.length > 1 ? "s" : ""}.`
    );
  } catch (err) {
    return `Deu ruim pra criar o grupo: ${err instanceof Error ? err.message : "erro desconhecido"}`;
  }
}
