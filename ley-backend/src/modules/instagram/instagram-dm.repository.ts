import { db } from "../llm/db.js";
import "./instagram-dm.db.js"; // garante que as tabelas existem antes de preparar os statements

export type IgDmMessageType = "text" | "media" | "other";

export interface IgDmMessageRow {
  id: string;
  thread_id: string;
  from_me: number;
  sender_name: string | null;
  type: IgDmMessageType;
  text: string | null;
  media_url: string | null;
  seen: number;
  created_at: number;
}

export interface IgDmContactRow {
  thread_id: string;
  name: string | null;
  username: string | null;
  is_group: number;
  pinned: number;
  autopilot: number | null;
  updated_at: number;
}

const stmts = {
  upsertContact: db.prepare(`
    INSERT INTO ig_dm_contacts (thread_id, name, username, is_group, updated_at)
    VALUES (@thread_id, @name, @username, @is_group, @updated_at)
    ON CONFLICT(thread_id) DO UPDATE SET
      name = excluded.name,
      username = excluded.username,
      is_group = excluded.is_group,
      updated_at = excluded.updated_at
  `),
  insertBareContact: db.prepare(`
    INSERT INTO ig_dm_contacts (thread_id, name, username, is_group, updated_at)
    VALUES (@thread_id, NULL, NULL, @is_group, @updated_at)
  `),
  // mesmo cuidado do wa_messages: idempotente por id + COALESCE nos campos,
  // pra nunca deixar um evento incompleto sobrescrever um valor já bom
  insertMessage: db.prepare(`
    INSERT INTO ig_dm_messages
      (id, thread_id, from_me, sender_name, type, text, media_url, seen, created_at)
    VALUES
      (@id, @thread_id, @from_me, @sender_name, @type, @text, @media_url, @seen, @created_at)
    ON CONFLICT(id) DO UPDATE SET
      text = COALESCE(ig_dm_messages.text, excluded.text),
      media_url = COALESCE(ig_dm_messages.media_url, excluded.media_url)
  `),
  listRecent: db.prepare(`SELECT * FROM ig_dm_messages ORDER BY created_at DESC LIMIT ?`),
  listUnread: db.prepare(`SELECT * FROM ig_dm_messages WHERE seen = 0 AND from_me = 0 ORDER BY created_at ASC`),
  listByThread: db.prepare(`SELECT * FROM ig_dm_messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?`),
  markSeen: db.prepare(`UPDATE ig_dm_messages SET seen = 1 WHERE id = ?`),
  markAllSeen: db.prepare(`UPDATE ig_dm_messages SET seen = 1 WHERE seen = 0`),
  markSeenByThread: db.prepare(`UPDATE ig_dm_messages SET seen = 1 WHERE thread_id = ? AND seen = 0`),
  listContacts: db.prepare(`SELECT * FROM ig_dm_contacts ORDER BY pinned DESC, updated_at DESC`),
  getContactByThread: db.prepare(`SELECT * FROM ig_dm_contacts WHERE thread_id = ?`),
  setContactAutopilot: db.prepare(`UPDATE ig_dm_contacts SET autopilot = @autopilot WHERE thread_id = @thread_id`),
  setContactPinned: db.prepare(`UPDATE ig_dm_contacts SET pinned = ? WHERE thread_id = ?`),
  getSetting: db.prepare(`SELECT value FROM ig_dm_settings WHERE key = ?`),
  upsertSetting: db.prepare(`
    INSERT INTO ig_dm_settings (key, value) VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `),
};

export function upsertContact(threadId: string, name: string | null, username: string | null, isGroup: boolean): void {
  if (!name && !username) return;
  stmts.upsertContact.run({
    thread_id: threadId,
    name,
    username,
    is_group: isGroup ? 1 : 0,
    updated_at: Date.now(),
  });
}

export function saveMessage(row: Omit<IgDmMessageRow, "seen"> & { seen?: number }): void {
  stmts.insertMessage.run({ ...row, seen: row.seen ?? (row.from_me ? 1 : 0) });
}

export function listRecentMessages(limit = 100): IgDmMessageRow[] {
  return stmts.listRecent.all(limit) as IgDmMessageRow[];
}

export function listUnreadMessages(): IgDmMessageRow[] {
  return stmts.listUnread.all() as IgDmMessageRow[];
}

export function listMessagesByThread(threadId: string, limit = 100): IgDmMessageRow[] {
  // mesma inversão de listMessagesByJid: a query vem DESC por causa do
  // LIMIT, aqui devolve em ordem cronológica normal
  return (stmts.listByThread.all(threadId, limit) as IgDmMessageRow[]).reverse();
}

export function markMessageSeen(id: string): boolean {
  return stmts.markSeen.run(id).changes > 0;
}

export function markAllSeen(): number {
  return stmts.markAllSeen.run().changes;
}

export function markSeenByThread(threadId: string): number {
  return stmts.markSeenByThread.run(threadId).changes;
}

export function listContacts(): IgDmContactRow[] {
  return stmts.listContacts.all() as IgDmContactRow[];
}

export function getContactByThread(threadId: string): IgDmContactRow | undefined {
  return stmts.getContactByThread.get(threadId) as IgDmContactRow | undefined;
}

export function getIgDmSetting(key: string): string | null {
  const row = stmts.getSetting.get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setIgDmSetting(key: string, value: string): void {
  stmts.upsertSetting.run({ key, value });
}

// override de autopilot por thread: null = segue o padrão global, 1 = força
// ligado, 0 = força desligado (mute) — mesmo esquema de wa_contacts.autopilot
export function getContactAutopilot(threadId: string): 0 | 1 | null {
  const row = stmts.getContactByThread.get(threadId) as IgDmContactRow | undefined;
  return (row?.autopilot ?? null) as 0 | 1 | null;
}

export function setContactAutopilot(threadId: string, value: 0 | 1 | null): void {
  const exists = stmts.getContactByThread.get(threadId);
  if (!exists) {
    stmts.insertBareContact.run({ thread_id: threadId, is_group: 0, updated_at: Date.now() });
  }
  stmts.setContactAutopilot.run({ thread_id: threadId, autopilot: value });
}

export function setContactPinned(threadId: string, pinned: boolean): void {
  const exists = stmts.getContactByThread.get(threadId);
  if (!exists) {
    stmts.insertBareContact.run({ thread_id: threadId, is_group: 0, updated_at: Date.now() });
  }
  stmts.setContactPinned.run(pinned ? 1 : 0, threadId);
}
