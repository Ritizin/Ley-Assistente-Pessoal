import { whatsappService } from "../whatsapp/index.js";

// cobre "abre a conversa com fulano", "abre o grupo da família", "abre o
// zap do João", "mostra a conversa com fulano", "abre o papo com fulano"
const OPEN_RE =
  /\b(abre|abrir|abra|mostra|mostrar|mostre)\b.*\b(conversa|grupo|papo|chat|zap)\b\s*(?:com|do|da|de)?\s+(.+)/i;

export function handleOpenConversationFlow(message: string): string | null {
  const match = message.match(OPEN_RE);
  if (!match) return null;

  const query = match[3].trim().replace(/[?.!]+$/, "");
  if (!query) return null;

  const contact = whatsappService.resolveContact(query);

  if (!contact) {
    return `Não achei "${query}" nas suas conversas do WhatsApp nem como contato/grupo memorizado.`;
  }

  whatsappService.broadcastOpenConversation(contact.jid, contact.name ?? null);

  const label = contact.name ?? "essa conversa";
  return `Abrindo ${label} pra você.`;
}
