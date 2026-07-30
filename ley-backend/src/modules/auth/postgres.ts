import { Pool } from "pg";
import { env } from "../../config/env.js";
import { logger } from "../../core/logger.js";

export async function createPostgresAuthDatabase() {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL não configurada");
  }

  // BUG encontrado: usava um único `Client` do pg. Um Client só aceita UMA
  // query por vez na mesma conexão — sob duas requisições HTTP concorrentes
  // (ex: dois logins acontecendo ao mesmo tempo), as queries competem pela
  // mesma conexão e o resultado de uma pode "vazar" pra outra, ou uma delas
  // trava esperando a anterior liberar. Além disso, `Client` não tem listener
  // de erro: se a conexão cair (rede, timeout do Postgres), o evento 'error'
  // não tratado derruba o processo Node inteiro. `Pool` resolve os dois
  // problemas: dá uma conexão livre pra cada query e reconecta sozinho.
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  pool.on("error", (err: Error) => {
    logger.error({ err }, "erro de conexão no pool do Postgres (auth)");
  });

  const client = pool;

  await client.query(`
    CREATE TABLE IF NOT EXISTS auth_users (
      id SERIAL PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'google',
      google_id TEXT,
      email TEXT NOT NULL UNIQUE,
      name TEXT,
      picture TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_auth_users_google_id ON auth_users(google_id);
    CREATE INDEX IF NOT EXISTS idx_auth_users_email ON auth_users(email);
  `);

  return {
    client,
    async createOrUpdateUser(input: { provider: "google"; googleId?: string; email: string; name?: string; picture?: string }) {
      const now = Date.now();
      const existing = await client.query<{ id: number; provider: string; google_id: string | null; email: string; name: string | null; picture: string | null; created_at: number; updated_at: number }>(
        "SELECT * FROM auth_users WHERE email = $1",
        [input.email],
      );

      if (existing.rows[0]) {
        await client.query(
          `UPDATE auth_users
           SET provider = $1, google_id = $2, name = $3, picture = $4, updated_at = $5
           WHERE email = $6`,
          [input.provider, input.googleId ?? null, input.name ?? null, input.picture ?? null, now, input.email],
        );
        const updated = await client.query<{ id: number; provider: string; google_id: string | null; email: string; name: string | null; picture: string | null; created_at: number; updated_at: number }>(
          "SELECT * FROM auth_users WHERE email = $1",
          [input.email],
        );
        return updated.rows[0];
      }

      const inserted = await client.query<{ id: number }>(
        `INSERT INTO auth_users (provider, google_id, email, name, picture, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [input.provider, input.googleId ?? null, input.email, input.name ?? null, input.picture ?? null, now, now],
      );

      return {
        id: inserted.rows[0]?.id,
        provider: input.provider,
        google_id: input.googleId ?? null,
        email: input.email,
        name: input.name ?? null,
        picture: input.picture ?? null,
        created_at: now,
        updated_at: now,
      };
    },
    async findUserByEmail(email: string) {
      const res = await client.query<{ id: number; provider: string; google_id: string | null; email: string; name: string | null; picture: string | null; created_at: number; updated_at: number }>(
        "SELECT * FROM auth_users WHERE email = $1",
        [email],
      );
      return res.rows[0] ?? null;
    },
    async findUserByGoogleId(googleId: string) {
      const res = await client.query<{ id: number; provider: string; google_id: string | null; email: string; name: string | null; picture: string | null; created_at: number; updated_at: number }>(
        "SELECT * FROM auth_users WHERE google_id = $1",
        [googleId],
      );
      return res.rows[0] ?? null;
    },
  };
}
