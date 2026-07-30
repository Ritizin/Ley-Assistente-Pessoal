import { db } from "../llm/db.js";
import { encrypt, decrypt } from "../gmail/crypto.js";

// painel é single-user: guarda no máximo uma conta conectada (id fixo = 1)
db.exec(`
  CREATE TABLE IF NOT EXISTS spotify_tokens (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    refresh_token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

export function saveRefreshToken(refreshToken: string): void {
  const now = Date.now();
  const secret = encrypt(refreshToken);
  db.prepare(
    `
    INSERT INTO spotify_tokens (id, refresh_token, created_at, updated_at)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      refresh_token = excluded.refresh_token,
      updated_at = excluded.updated_at
  `
  ).run(secret, now, now);
}

export function getRefreshToken(): string | null {
  const row = db.prepare(`SELECT refresh_token FROM spotify_tokens WHERE id = 1`).get() as
    | { refresh_token: string }
    | undefined;

  if (!row) return null;
  return decrypt(row.refresh_token);
}

export function deleteRefreshToken(): void {
  db.prepare(`DELETE FROM spotify_tokens WHERE id = 1`).run();
}
