import { db } from "../llm/db.js";

// tabelas próprias do módulo WhatsApp — reaproveita o mesmo arquivo/instância
// sqlite do resto do app (storage/ley.db), só isola o schema aqui
db.exec(`
  CREATE TABLE IF NOT EXISTS wa_contacts (
    jid TEXT PRIMARY KEY,
    name TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS wa_messages (
    id TEXT PRIMARY KEY,
    jid TEXT NOT NULL,
    from_me INTEGER NOT NULL DEFAULT 0,
    sender_name TEXT,
    type TEXT NOT NULL DEFAULT 'other' CHECK (type IN ('text', 'audio', 'other')),
    text TEXT,
    transcript TEXT,
    media_path TEXT,
    media_mimetype TEXT,
    seen INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_wa_messages_jid ON wa_messages(jid, created_at);
  CREATE INDEX IF NOT EXISTS idx_wa_messages_seen ON wa_messages(seen, from_me);
`);

// migração leve: bancos criados antes de existir a memorização manual de
// contatos não têm a coluna "source" — adiciona se faltar, sem apagar nada.
// 'seen' = contato só visto em mensagens recebidas; 'saved' = memorizado
// explicitamente pelo usuário (via "salva o contato ...").
const contactCols = db.prepare(`PRAGMA table_info(wa_contacts)`).all() as { name: string }[];
if (!contactCols.some((c) => c.name === "source")) {
  db.exec(`ALTER TABLE wa_contacts ADD COLUMN source TEXT NOT NULL DEFAULT 'seen'`);
}

// migração leve: marca quais contatos são GRUPOS (jid termina em "@g.us").
// Sem isso, um grupo que chega numa mensagem era salvo em wa_contacts com o
// pushName de quem mandou (nome de uma PESSOA) em vez do nome do grupo — daí
// buscar por nome de grupo nunca achava nada e mandar msg/áudio/arquivo pra
// um grupo só funcionava colando o jid na mão.
if (!contactCols.some((c) => c.name === "is_group")) {
  db.exec(`ALTER TABLE wa_contacts ADD COLUMN is_group INTEGER NOT NULL DEFAULT 0`);
  db.exec(`UPDATE wa_contacts SET is_group = 1 WHERE jid LIKE '%@g.us'`);
}

// migração leve: override de autopilot por contato/grupo. NULL = segue o
// padrão global (wa_settings/env), 1 = força ligado, 0 = força desligado
// (mute) independente do padrão global.
if (!contactCols.some((c) => c.name === "autopilot")) {
  db.exec(`ALTER TABLE wa_contacts ADD COLUMN autopilot INTEGER`);
}

// migração leve: memoriza quando um contato/grupo já pediu explicitamente
// pra não receber áudio (ex: "não consigo ouvir áudio", "manda por texto").
// 0 = comportamento normal (só manda áudio se pedirem no momento), 1 = nunca
// mais manda áudio automático pra esse jid, mesmo que peçam de novo — só
// texto — até alguém desligar isso manualmente pelo painel.
if (!contactCols.some((c) => c.name === "audio_opt_out")) {
  db.exec(`ALTER TABLE wa_contacts ADD COLUMN audio_opt_out INTEGER NOT NULL DEFAULT 0`);
}

// migração leve: fixar conversa/grupo no topo da lista (menu de "Fixar
// conversa" no WhatsAppTab). 0 = normal, 1 = fixado.
if (!contactCols.some((c) => c.name === "pinned")) {
  db.exec(`ALTER TABLE wa_contacts ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
}

// tabela genérica key/value pro módulo de WhatsApp — hoje só guarda o toggle
// global do autopilot ("autopilot_global": "1" | "0"), mas fica pronta pra
// outras configs futuras sem precisar de migração nova
db.exec(`
  CREATE TABLE IF NOT EXISTS wa_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Status/Stories do WhatsApp (as postagens de 24h que aparecem em
// "status@broadcast"). Cada linha é UMA atualização de status de UM
// contato. "seen" é local ao painel da Ley (não sincroniza com o app
// oficial) — só controla o anel de "já vi" na tirinha de status.
// "expires_at" é sempre created_at + 24h; a limpeza (linha + arquivo de
// mídia) roda periodicamente em whatsapp.service.ts.
db.exec(`
  CREATE TABLE IF NOT EXISTS wa_statuses (
    id TEXT PRIMARY KEY,
    jid TEXT NOT NULL,
    sender_name TEXT,
    type TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('image', 'video', 'text')),
    text TEXT,
    bg_color TEXT,
    media_path TEXT,
    media_mimetype TEXT,
    seen INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_wa_statuses_jid ON wa_statuses(jid, created_at);
  CREATE INDEX IF NOT EXISTS idx_wa_statuses_expires ON wa_statuses(expires_at);
`);
