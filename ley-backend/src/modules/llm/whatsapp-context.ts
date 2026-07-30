import { env } from "../../config/env.js";
import { whatsappService } from "../whatsapp/index.js";
import { getContactByJid, getWaSetting, listRecentMessages, listUnreadMessages } from "../whatsapp/whatsapp.repository.js";

function isAutopilotGloballyEnabled(): boolean {
  const stored = getWaSetting("autopilot_global");
  if (stored === "1") return true;
  if (stored === "0") return false;
  return env.WHATSAPP_AUTOPILOT_ENABLED;
}

const GROUP_JID_SUFFIX = "@g.us";
function isGroupJid(jid: string): boolean {
  return jid.endsWith(GROUP_JID_SUFFIX);
}

function displayName(jid: string, fallback: string | null): string {
  return getContactByJid(jid)?.name ?? fallback ?? jid.split("@")[0];
}

function previewOf(text: string | null, transcript: string | null): string {
  const raw = (text ?? transcript ?? "(mídia sem texto)").replace(/\s+/g, " ").trim();
  return raw.length > 80 ? `${raw.slice(0, 80)}...` : raw;
}

// Monta um resumo curto e sempre atualizado do estado do WhatsApp (status da
// conexão, quantas mensagens não lidas de pessoas/grupos e as últimas
// trocadas) pra injetar como CONTEXTO SILENCIOSO em toda mensagem do chat —
// mesmo princípio do taskContext em chat.service.ts. Isso é o que faz a Ley
// "lembrar" o que ela pode fazer no WhatsApp e sempre ter as conversas
// recentes à mão pra analisar quando o usuário perguntar algo sobre elas,
// sem precisar bater num fluxo regex específico pra cada pergunta.
export function buildWhatsAppSilentContext(): string {
  const status = whatsappService.getStatus();

  if (status !== "connected") {
    return `\n\n[SISTEMA - WHATSAPP]: desconectado no momento (status: ${status}). Se o usuário pedir algo do WhatsApp, avise que precisa reconectar (escanear o QR Code no painel) antes.`;
  }

  const unread = listUnreadMessages();
  const unreadIndividual = unread.filter((m) => !isGroupJid(m.jid));
  const unreadGroup = unread.filter((m) => isGroupJid(m.jid));

  const recent = listRecentMessages(8)
    .slice()
    .reverse()
    .map((m) => {
      const who = m.from_me ? "você" : displayName(m.jid, m.sender_name);
      const where = isGroupJid(m.jid) ? " (grupo)" : "";
      return `- ${who}${where}: ${previewOf(m.text, m.transcript)}`;
    })
    .join("\n");

  return (
    `\n\n[SISTEMA - CONTEXTO SILENCIOSO DO WHATSAPP]:\n` +
    `Conectado. ${unreadIndividual.length} mensagem(ns) não lida(s) em conversas normais, ${unreadGroup.length} em grupos.\n` +
    (recent ? `Últimas mensagens trocadas (mais recente por último):\n${recent}\n` : "") +
    `SUAS CAPACIDADES REAIS NO WHATSAPP (você realmente executa essas ações, não é papo furado):\n` +
    `- Mandar texto e áudio (com sua voz ou a do usuário) pra pessoas E grupos.\n` +
    `- Mandar arquivos do PC do usuário (que ele anexar no chat) pra pessoas E grupos.\n` +
    `- Abrir uma conversa ou grupo específico no painel quando pedido.\n` +
    `- Ler/checar mensagens não lidas, tocar áudios recebidos, achar número de contato, salvar contato novo.\n` +
    `- Criar grupo novo com participantes já salvos/vistos.\n` +
    `- Bloquear e desbloquear contato.\n` +
    `- Autopilot: ${isAutopilotGloballyEnabled() ? "LIGADO" : "DESLIGADO"} no momento — quando ligado, você mesma responde sozinha (com outra personalidade, mais neutra) quem te manda mensagem direta, e em grupo só quando alguém te chama pelo nome. Se o usuário perguntar se está respondendo sozinho no zap, responda com esse status real.\n` +
    `- Analisar o conteúdo das conversas recentes (acima) quando o usuário perguntar sobre elas.\n` +
    `INSTRUÇÃO: use esse contexto pra responder com precisão sobre o que rolou no WhatsApp quando perguntado, mas NUNCA fique comentando isso por conta própria sem o usuário pedir.`
  );
}
