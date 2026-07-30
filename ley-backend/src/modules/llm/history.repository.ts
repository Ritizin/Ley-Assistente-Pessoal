import { randomUUID } from "node:crypto";
import { db } from "./db.js";

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessageRow {
  id: number;
  conversation_id: string;
  role: ChatRole;
  content: string;
  created_at: number;
}

// quantas mensagens de histórico entram no contexto enviado à Groq
const CONTEXT_WINDOW = 20;

const stmts = {
  insertConversation: db.prepare(
    `INSERT INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)`
  ),
  touchConversation: db.prepare(
    `UPDATE conversations SET updated_at = ? WHERE id = ?`
  ),
  findConversation: db.prepare(`SELECT id FROM conversations WHERE id = ?`),
  insertMessage: db.prepare(
    `INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)`
  ),
  lastMessages: db.prepare(
    `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`
  ),
};

export function getOrCreateConversation(conversationId?: string): string {
  const id = conversationId ?? randomUUID();
  const existing = stmts.findConversation.get(id);
  const now = Date.now();

  if (!existing) {
    stmts.insertConversation.run(id, now, now);
  }

  return id;
}

export function touchConversation(conversationId: string): void {
  stmts.touchConversation.run(Date.now(), conversationId);
}

export function addMessage(conversationId: string, role: ChatRole, content: string): void {
  stmts.insertMessage.run(conversationId, role, content, Date.now());
}

// retorna o histórico em ordem cronológica (mais antiga -> mais recente),
// pronto para virar `messages` da chamada à Groq
export function getContext(conversationId: string, limit = CONTEXT_WINDOW): ChatMessageRow[] {
  const rows = stmts.lastMessages.all(conversationId, limit) as ChatMessageRow[];
  return rows.reverse();
}
