import { Pool } from "pg";
import fs from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

// O que rastreamos: o SQLite compartilhado (storage/ley.db — WhatsApp
// contatos/mensagens, Gmail, Instagram, Spotify, Google Home, Tarefas), a
// sessão do WhatsApp (storage/whatsapp-session/, vários arquivos pequenos do
// Baileys) e a mídia do WhatsApp (storage/whatsapp-media/ — fotos/vídeos de
// Status recebidos e áudios enviados). O storage/auth.db NÃO entra aqui de
// propósito: quando DATABASE_URL está setada, auth.db.ts já migra sozinho
// pra Postgres (tem adapter dual desde sempre) — não precisa de
// backup/restore de arquivo.
//
// BUG corrigido aqui: storage/whatsapp-media/ não entrava nessa lista. O
// ley.db (com a linha do status em wa_statuses) era restaurado certinho a
// cada boot/hibernação do Render, mas o arquivo de mídia que aquela linha
// aponta (media_path) nunca tinha sido salvo no Postgres — sumia do disco
// no primeiro reciclo do container. Resultado: o status aparecia na tirinha
// e abria o visualizador, mas a foto/vídeo vinha 404 (o painel mostrava só
// o alt="Status" no lugar da imagem quebrada).
const TRACKED_DB_FILE = "storage/ley.db";
const TRACKED_SESSION_DIR = "storage/whatsapp-session";
const TRACKED_MEDIA_DIR = "storage/whatsapp-media";
const TRACKED_DIRS = [TRACKED_SESSION_DIR, TRACKED_MEDIA_DIR];

let pool: Pool | null = null;

function getPool(): Pool | null {
  if (!env.DATABASE_URL) return null; // sem Postgres configurada = dev local, não faz nada
  if (!pool) {
    pool = new Pool({ connectionString: env.DATABASE_URL });
    pool.on("error", (err: Error) => {
      logger.error({ err }, "erro de conexão no pool do Postgres (storage-sync)");
    });
  }
  return pool;
}

async function ensureTable(p: Pool): Promise<void> {
  await p.query(`
    CREATE TABLE IF NOT EXISTS storage_backups (
      path TEXT PRIMARY KEY,
      data BYTEA NOT NULL,
      updated_at BIGINT NOT NULL
    );
  `);
}

function listFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

/**
 * Restaura storage/ley.db, storage/whatsapp-session/ e storage/whatsapp-media/
 * do Postgres pro disco local. PRECISA rodar antes de qualquer outro módulo
 * do app (é por isso que existe o bootstrap.ts — o llm/db.ts abre o ley.db
 * assim que é importado, então restaurar depois seria tarde demais). Sem
 * DATABASE_URL, não faz nada (comportamento local idêntico a antes dessa
 * feature existir).
 */
export async function restoreStorageFromRemote(): Promise<void> {
  const p = getPool();
  if (!p) return;

  try {
    await ensureTable(p);
    const { rows } = await p.query<{ path: string; data: Buffer }>(
      "SELECT path, data FROM storage_backups"
    );

    if (rows.length === 0) {
      logger.info("[storage-sync] nenhum backup remoto encontrado ainda — subindo do zero");
      return;
    }

    for (const row of rows) {
      const localPath = path.resolve(row.path);
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, row.data);
    }

    logger.info({ files: rows.length }, "[storage-sync] storage/ restaurado do Postgres");
  } catch (err) {
    logger.error({ err }, "[storage-sync] falha ao restaurar storage/ do Postgres — subindo com disco local vazio");
  }
}

/**
 * Sobe pro Postgres o estado atual de storage/ley.db, storage/whatsapp-session/
 * e storage/whatsapp-media/.
 * Chamado periodicamente e no encerramento do processo (SIGTERM, que o
 * Render manda antes de derrubar o container num redeploy).
 */
export async function backupStorageToRemote(): Promise<void> {
  const p = getPool();
  if (!p) return;

  // força o WAL do ley.db a ser gravado no arquivo principal antes de ler os
  // bytes — sem isso, escritas recentes podem não estar no .db ainda e o
  // backup fica desatualizado mesmo rodando "agora"
  try {
    const { db } = await import("../modules/llm/db.js");
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch (err) {
    logger.error({ err }, "[storage-sync] falha ao fazer checkpoint do WAL antes do backup (segue mesmo assim)");
  }

  const dbFile = path.resolve(TRACKED_DB_FILE);
  const filesToBackup = [
    ...(fs.existsSync(dbFile) ? [dbFile] : []),
    ...TRACKED_DIRS.flatMap((dir) => listFilesRecursive(path.resolve(dir))),
  ];

  if (filesToBackup.length === 0) return;

  try {
    await ensureTable(p);
    const localRelPaths = new Set<string>();

    for (const absPath of filesToBackup) {
      const relPath = path.relative(process.cwd(), absPath);
      localRelPaths.add(relPath);
      const data = fs.readFileSync(absPath);
      await p.query(
        `INSERT INTO storage_backups (path, data, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
        [relPath, data, Date.now()]
      );
    }

    // sem isso, mídia apagada localmente (ex: foto de status vencido depois
    // de 24h, ver cleanupExpiredStatuses) ficava órfã no Postgres pra
    // sempre — o arquivo nunca mais existe local, mas o backup remoto
    // continuava guardando (e restaurando) o blob antigo a cada boot,
    // crescendo sem limite.
    for (const dir of TRACKED_DIRS) {
      const { rows } = await p.query<{ path: string }>(
        "SELECT path FROM storage_backups WHERE path LIKE $1",
        [`${dir}%`]
      );
      const toDelete = rows.map((r) => r.path).filter((remotePath) => !localRelPaths.has(remotePath));
      if (toDelete.length > 0) {
        await p.query("DELETE FROM storage_backups WHERE path = ANY($1)", [toDelete]);
      }
    }

    logger.info({ files: filesToBackup.length }, "[storage-sync] backup de storage/ salvo no Postgres");
  } catch (err) {
    logger.error({ err }, "[storage-sync] falha ao salvar backup de storage/ no Postgres");
  }
}

let backupInterval: NodeJS.Timeout | null = null;

/**
 * Liga o backup periódico. Sem DATABASE_URL, não faz nada. O backup FINAL
 * (no encerramento do processo) não é feito aqui de propósito — fica
 * integrado no shutdown() do próprio server.ts, pra não competir com o
 * `process.exit(0)` que ele já chama (dois listeners de SIGTERM
 * independentes correndo em paralelo podiam matar o processo antes do
 * backup terminar de subir pro Postgres).
 */
export function startPeriodicBackup(intervalMs = 2 * 60 * 1000): void {
  if (!env.DATABASE_URL) return;
  if (backupInterval) return;

  backupInterval = setInterval(() => {
    void backupStorageToRemote();
  }, intervalMs);
  backupInterval.unref(); // não impede o processo de encerrar sozinho quando precisar
}
