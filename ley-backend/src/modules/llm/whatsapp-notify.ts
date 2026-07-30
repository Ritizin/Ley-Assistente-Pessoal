import { wsHub } from "../../ws/hub.js";
import { addMessage, touchConversation } from "./history.repository.js";
import { getContactByJid } from "../whatsapp/whatsapp.repository.js";
import { getActiveConversationId } from "./active-conversation.js";

// Avisa o dono, dentro do próprio chat da Ley no painel, sempre que alguém
// manda mensagem pra ele no WhatsApp (grupo ou conversa normal). A Ley é
// single-user local, então "avisar o dono" = jogar um aviso na conversa mais
// recentemente usada no painel (ver active-conversation.ts) — se o painel
// tiver aberto, o aviso aparece na hora via WebSocket; se não tiver, ele já
// fica salvo no histórico pra aparecer quando o dono abrir de novo.
export async function notifyOwner(
  jid: string,
  isGroup: boolean,
  senderName: string | null,
  preview: string | null
): Promise<void> {
  try {
    const conversationId = getActiveConversationId();
    if (!conversationId) return; // painel nunca foi aberto ainda — nada pra avisar

    const contact = getContactByJid(jid);
    const displayName = contact?.name ?? senderName ?? jid.split("@")[0];
    const where = isGroup ? ` (no grupo${contact?.name ? ` "${contact.name}"` : ""})` : "";
    const shortPreview = (preview ?? "").replace(/\s+/g, " ").trim().slice(0, 140);

    const content = shortPreview
      ? `📩 ${displayName}${where} te mandou: "${shortPreview}"`
      : `📩 ${displayName}${where} te mandou uma mensagem.`;

    addMessage(conversationId, "assistant", content);
    touchConversation(conversationId);

    wsHub.broadcast("chat", "message", {
      conversationId,
      role: "assistant",
      content,
      notification: true,
    });
  } catch {
    // aviso é best-effort — nunca deve derrubar o autopilot por causa disso
  }
}
