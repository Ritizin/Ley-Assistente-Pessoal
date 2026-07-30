// Guarda o id da conversa do painel usada mais recentemente. A Ley é um app
// single-user local (um dono só, um painel só aberto por vez, na prática) —
// então isso serve pra saber "em qual chat avisar o dono" quando uma
// notificação de WhatsApp precisa aparecer (ver whatsapp-notify.ts), sem
// precisar de login/sessão de verdade.
let activeConversationId: string | null = null;

export function setActiveConversationId(id: string): void {
  activeConversationId = id;
}

export function getActiveConversationId(): string | null {
  return activeConversationId;
}
