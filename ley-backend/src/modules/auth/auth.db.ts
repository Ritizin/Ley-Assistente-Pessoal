import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { env } from "../../config/env.js";
import { createPostgresAuthDatabase } from "./postgres.js";
import { logger } from "../../core/logger.js";

export type AuthProvider = "google";

export interface AuthUserRecord {
  id: number;
  provider: AuthProvider;
  googleId?: string | null;
  email: string;
  name?: string | null;
  picture?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateOrUpdateUserInput {
  provider: AuthProvider;
  googleId?: string;
  email: string;
  name?: string;
  picture?: string;
}

export interface GoogleTokens {
  refreshToken: string;
  accessToken: string | null;
  expiresAt: number | null;
}

export interface AuthDatabaseAdapter {
  initialize(): Promise<void>;
  createOrUpdateUser(input: CreateOrUpdateUserInput): Promise<AuthUserRecord>;
  findUserByEmail(email: string): Promise<AuthUserRecord | null>;
  findUserByGoogleId(googleId: string): Promise<AuthUserRecord | null>;
  // opcionais: só implementados no adapter SQLite por enquanto (ver
  // calendar/calendar.service.ts). Se DATABASE_URL estiver setado (Postgres),
  // a Google Agenda fica indisponível até isso ser implementado lá também —
  // não é o caso de uso real hoje (essa var está vazia no .env).
  saveGoogleTokens?(email: string, tokens: GoogleTokens): Promise<void>;
  getGoogleTokens?(email: string): Promise<GoogleTokens | null>;
}

export interface AuthDatabaseOptions {
  sqliteFilePath?: string;
}

const DEFAULT_SQLITE_PATH = path.resolve("storage", "auth.db");

export async function createAuthDatabase(options: AuthDatabaseOptions = {}): Promise<AuthDatabaseAdapter> {
  if (env.DATABASE_URL) {
    // BUG corrigido aqui: se o Postgres estiver indisponível (fora do ar,
    // cota de transferência de dados estourada, etc.), createPostgresAuthDatabase()
    // rejeitava e isso derrubava o bootstrap() inteiro do server.ts ANTES do
    // app.listen() — o processo ficava de pé (o handler global de
    // unhandledRejection só loga) mas nunca abria a porta, e o Render
    // marcava a instância como falha depois de algumas tentativas. Agora
    // isso é pego aqui: se o Postgres não responder, cai pro adapter SQLite
    // local (mesmo comportamento de quando DATABASE_URL não está setada).
    // Login com Google continua funcionando; só não fica sincronizado entre
    // reciclos do container até o Postgres voltar.
    try {
      const postgres = await createPostgresAuthDatabase();
      return buildPostgresAdapter(postgres);
    } catch (err) {
      logger.error(
        { err },
        "[auth] não foi possível usar Postgres para autenticação — usando SQLite local como fallback"
      );
    }
  }

  return buildSqliteAdapter(options.sqliteFilePath ?? DEFAULT_SQLITE_PATH);
}

function buildPostgresAdapter(
  postgres: Awaited<ReturnType<typeof createPostgresAuthDatabase>>
): AuthDatabaseAdapter {
  return {
    async initialize() {
      // noop
    },
    async createOrUpdateUser(input) {
      const row = await postgres.createOrUpdateUser(input);
      return {
        id: row.id,
        provider: input.provider,
        googleId: row.google_id ?? null,
        email: row.email,
        name: row.name ?? null,
        picture: row.picture ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    },
    async findUserByEmail(email) {
      const row = await postgres.findUserByEmail(email);
      return row
        ? {
            id: row.id,
            provider: row.provider as AuthProvider,
            googleId: row.google_id ?? null,
            email: row.email,
            name: row.name ?? null,
            picture: row.picture ?? null,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          }
        : null;
    },
    async findUserByGoogleId(googleId) {
      const row = await postgres.findUserByGoogleId(googleId);
      return row
        ? {
            id: row.id,
            provider: row.provider as AuthProvider,
            googleId: row.google_id ?? null,
            email: row.email,
            name: row.name ?? null,
            picture: row.picture ?? null,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          }
        : null;
    },
  };
}

function buildSqliteAdapter(sqliteFilePath: string): AuthDatabaseAdapter {
  const db = openDb(sqliteFilePath);
  const prepare = (sql: string) => db.prepare(sql);

  return {
    async initialize() {
      // noop: garante compatibilidade com o fluxo de bootstrap.
    },
    async createOrUpdateUser(input) {
      const now = Date.now();
      const existing = prepare("SELECT * FROM auth_users WHERE email = ?").get(input.email) as
        | AuthUserRecord
        | undefined;

      if (existing) {
        const updated = prepare(`
          UPDATE auth_users
          SET provider = ?, google_id = ?, name = ?, picture = ?, updated_at = ?
          WHERE email = ?
        `).run(input.provider, input.googleId ?? null, input.name ?? null, input.picture ?? null, now, input.email);
        if (updated.changes === 0) {
          throw new Error("Falha ao atualizar usuário de autenticação");
        }
        return prepare("SELECT * FROM auth_users WHERE email = ?").get(input.email) as AuthUserRecord;
      }

      const inserted = prepare(`
        INSERT INTO auth_users (provider, google_id, email, name, picture, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(input.provider, input.googleId ?? null, input.email, input.name ?? null, input.picture ?? null, now, now);

      return {
        id: Number(inserted.lastInsertRowid),
        provider: input.provider,
        googleId: input.googleId ?? null,
        email: input.email,
        name: input.name ?? null,
        picture: input.picture ?? null,
        createdAt: now,
        updatedAt: now,
      };
    },
    async findUserByEmail(email) {
      const row = prepare("SELECT * FROM auth_users WHERE email = ?").get(email) as
        | AuthUserRecord
        | undefined;
      return row ?? null;
    },
    async findUserByGoogleId(googleId) {
      const row = prepare("SELECT * FROM auth_users WHERE google_id = ?").get(googleId) as
        | AuthUserRecord
        | undefined;
      return row ?? null;
    },
    async saveGoogleTokens(email, tokens) {
      prepare(`
        INSERT INTO google_tokens (email, refresh_token, access_token, expires_at, updated_at)
        VALUES (@email, @refresh_token, @access_token, @expires_at, @updated_at)
        ON CONFLICT(email) DO UPDATE SET
          refresh_token = excluded.refresh_token,
          access_token = excluded.access_token,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
      `).run({
        email,
        refresh_token: tokens.refreshToken,
        access_token: tokens.accessToken,
        expires_at: tokens.expiresAt,
        updated_at: Date.now(),
      });
    },
    async getGoogleTokens(email) {
      const row = prepare("SELECT * FROM google_tokens WHERE email = ?").get(email) as
        | { refresh_token: string; access_token: string | null; expires_at: number | null }
        | undefined;
      if (!row) return null;
      return { refreshToken: row.refresh_token, accessToken: row.access_token, expiresAt: row.expires_at };
    },
  };
}

function openDb(sqliteFilePath: string): Database.Database {
  // ":memory:" é um valor especial do better-sqlite3/SQLite — não é um
  // caminho de arquivo. Bug encontrado: path.resolve(":memory:") virava um
  // arquivo literal chamado ":memory:" na raiz do projeto (persistindo no
  // disco à toa) em vez de abrir um banco temporário em RAM.
  const resolvedPath = sqliteFilePath === ":memory:" ? sqliteFilePath : path.resolve(sqliteFilePath);

  if (resolvedPath !== ":memory:") {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  }

  const db = new Database(resolvedPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL DEFAULT 'google',
      google_id TEXT,
      email TEXT NOT NULL UNIQUE,
      name TEXT,
      picture TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_auth_users_google_id ON auth_users(google_id);
    CREATE INDEX IF NOT EXISTS idx_auth_users_email ON auth_users(email);

    CREATE TABLE IF NOT EXISTS google_tokens (
      email TEXT PRIMARY KEY,
      refresh_token TEXT NOT NULL,
      access_token TEXT,
      expires_at INTEGER,
      updated_at INTEGER NOT NULL
    );
  `);

  return db;
}
