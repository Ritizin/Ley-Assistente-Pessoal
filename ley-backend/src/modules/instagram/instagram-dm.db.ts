import { db } from "../llm/db.js";

// tabelas do módulo Instagram DM (API privada, conta @leysatan) — reaproveita
// o mesmo arquivo/instância sqlite do resto do app (storage/ley.db), só
// isola o schema aqui. Espelha wa_contacts/wa_messages/wa_settings
// (whatsapp.db.ts), trocando "jid" por "thread_id" (é assim que o
// Instagram identifica uma conversa de DM).
db.exec(`
  CREATE TABLE IF NOT EXISTS ig_dm_contacts (
    thread_id TEXT PRIMARY KEY,
    name TEXT,
    username TEXT,
    is_group INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    autopilot INTEGER,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ig_dm_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    from_me INTEGER NOT NULL DEFAULT 0,
    sender_name TEXT,
    type TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text', 'media', 'other')),
    text TEXT,
    media_url TEXT,
    seen INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_ig_dm_messages_thread ON ig_dm_messages(thread_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_ig_dm_messages_seen ON ig_dm_messages(seen, from_me);

  -- config genérica do módulo (hoje só o toggle global do autopilot),
  -- mesmo padrão de wa_settings
  CREATE TABLE IF NOT EXISTS ig_dm_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);
