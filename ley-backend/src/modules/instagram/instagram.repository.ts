import { db } from "../llm/db.js";
import { encrypt, decrypt } from "../gmail/crypto.js";

// painel é single-user: guarda no máximo uma conta conectada (id fixo = 1)
db.exec(`
  CREATE TABLE IF NOT EXISTS instagram_accounts (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    access_token TEXT NOT NULL,
    ig_user_id TEXT NOT NULL,
    page_id TEXT NOT NULL,
    username TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

export interface InstagramAccountRow {
  accessToken: string;
  igUserId: string;
  pageId: string;
  username: string | null;
  expiresAt: number;
}

export function saveInstagramAccount(data: {
  accessToken: string;
  igUserId: string;
  pageId: string;
  username: string | null;
  expiresAt: number;
}): void {
  const now = Date.now();
  const secret = encrypt(data.accessToken);
  db.prepare(
    `
    INSERT INTO instagram_accounts (id, access_token, ig_user_id, page_id, username, expires_at, created_at, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      access_token = excluded.access_token,
      ig_user_id = excluded.ig_user_id,
      page_id = excluded.page_id,
      username = excluded.username,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
  `
  ).run(secret, data.igUserId, data.pageId, data.username, data.expiresAt, now, now);
}

export function getInstagramAccount(): InstagramAccountRow | null {
  const row = db.prepare(`SELECT * FROM instagram_accounts WHERE id = 1`).get() as
    | {
        access_token: string;
        ig_user_id: string;
        page_id: string;
        username: string | null;
        expires_at: number;
      }
    | undefined;

  if (!row) return null;
  return {
    accessToken: decrypt(row.access_token),
    igUserId: row.ig_user_id,
    pageId: row.page_id,
    username: row.username,
    expiresAt: row.expires_at,
  };
}

export function deleteInstagramAccount(): void {
  db.prepare(`DELETE FROM instagram_accounts WHERE id = 1`).run();
}
