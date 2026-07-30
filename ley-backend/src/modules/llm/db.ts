import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { logger } from "../../core/logger.js";

const DB_PATH = path.resolve("storage/ley.db");

// garante que a pasta storage/ existe antes do better-sqlite3 tentar criar o arquivo
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// Detecta banco corrompido (ex: processo morto no meio de uma escrita em WAL,
// queda de energia, disco cheio) ANTES de tentar usar — sem isso, toda
// chamada de chat quebra com "database disk image is malformed" pra sempre,
// já que o arquivo corrompido nunca se conserta sozinho. Em vez de derrubar
// o chat, isola o arquivo ruim (fica guardado, dá pra tentar recuperar depois
// com `sqlite3 storage/ley.db.corrompido-<timestamp> ".recover"`) e recria
// um banco novo do zero.
function openDatabaseWithCorruptionGuard(dbPath: string): Database.Database {
  try {
    const probe = new Database(dbPath);
    probe.pragma("quick_check");
    return probe;
  } catch (err) {
    const msg = String((err as Error)?.message ?? "").toLowerCase();
    const looksCorrupted = msg.includes("malformed") || msg.includes("not a database") || msg.includes("file is not a database");

    if (!looksCorrupted || !fs.existsSync(dbPath)) {
      throw err;
    }

    const quarantinePath = `${dbPath}.corrompido-${Date.now()}`;
    logger.error({ err, dbPath, quarantinePath }, "banco de dados corrompido detectado na inicialização — isolando arquivo e recriando um novo");

    fs.renameSync(dbPath, quarantinePath);
    for (const ext of ["-wal", "-shm"]) {
      const sidecar = `${dbPath}${ext}`;
      if (fs.existsSync(sidecar)) fs.rmSync(sidecar);
    }

    return new Database(dbPath);
  }
}

export const db = openDatabaseWithCorruptionGuard(DB_PATH);

// WAL = melhor throughput com pouca RAM, evita locks em escrita concorrente (HTTP + WS)
db.pragma("journal_mode = WAL");

// BUG encontrado: a tabela "messages" declara FOREIGN KEY (conversation_id)
// REFERENCES conversations(id), mas o SQLite ignora silenciosamente essa
// constraint se "PRAGMA foreign_keys" não estiver ligado NA CONEXÃO (não é
// global, é por conexão aberta). Sem isso, dava pra inserir mensagem com
// conversation_id que não existe, ou apagar uma conversa e deixar mensagens
// órfãs no banco pra sempre. Precisa vir logo após abrir a conexão.
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conversation
    ON messages(conversation_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_tasks_status
    ON tasks(status);
`);
