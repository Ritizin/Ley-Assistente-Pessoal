import { whatsappService } from "../whatsapp/index.js";
import { withAction } from "./action-marker.js";

const BLOCK_RE = /\b(bloqueia|bloquear)\b/i;
const UNBLOCK_RE = /\b(desbloqueia|desbloquear)\b/i;

// remove os verbos-gatilho e palavras de conexão pra sobrar só o nome/número
function extractTarget(message: string): string {
  return message
    .replace(/\b(bloqueia|bloquear|desbloqueia|desbloquear)\b/gi, "")
    .replace(/\b(o|a)\s+contato\b/gi, "")
    .replace(/\bcontato\b/gi, "")
    .replace(/\bn[uú]mero\b/gi, "")
    .replace(/\b(do|da|de)\b/gi, "")
    .trim()
    .replace(/[?.!]+$/, "")
    .trim();
}

/**
 * Trata "bloqueia o contato Fulano" / "bloqueia o número 119999..." /
 * "desbloqueia Fulano". BLOCK_RE e UNBLOCK_RE são mutuamente exclusivos na
 * prática (uma frase não tem os dois verbos), então testar os dois já
 * resolve a ambiguidade sem precisar de mais contexto.
 */
export async function handleBlockContactFlow(message: string): Promise<string | null> {
  const isUnblock = UNBLOCK_RE.test(message);
  const isBlock = BLOCK_RE.test(message);
  if (!isBlock && !isUnblock) return null;

  const target = extractTarget(message);
  if (!target) {
    return `Quem eu ${isUnblock ? "desbloqueio" : "bloqueio"}? Me diz o nome ou o número.`;
  }

  const contact = whatsappService.resolveContact(target);
  if (!contact) {
    return `Não achei "${target}" nos seus contatos nem como número válido.`;
  }

  try {
    await whatsappService.setBlockStatus(contact.jid, !isUnblock);
    const name = contact.name ?? target;
    return isUnblock
      ? withAction(`Contato desbloqueado: ${name}`, `Desbloqueei ${name}.`)
      : withAction(
          `Contato bloqueado: ${name}`,
          `Bloqueei ${name} — ele(a) não te manda mensagem nem áudio até você desbloquear.`
        );
  } catch (err) {
    return `Deu ruim: ${err instanceof Error ? err.message : "erro desconhecido"}`;
  }
}
