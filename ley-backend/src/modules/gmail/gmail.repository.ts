import { db } from "../llm/db.js";
import { encrypt, decrypt } from "./crypto.js";

// painel é single-user: guarda no máximo uma conta conectada (id fixo = 1)
db.exec(`
  CREATE TABLE IF NOT EXISTS gmail_accounts (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    email TEXT NOT NULL,
    secret TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

export interface GmailAccount {
  email: string;
  appPassword: string;
}

export function saveAccount(email: string, appPassword: string): void {
  const now = Date.now();
  const secret = encrypt(appPassword);
  db.prepare(
    `
    INSERT INTO gmail_accounts (id, email, secret, created_at, updated_at)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      email = excluded.email,
      secret = excluded.secret,
      updated_at = excluded.updated_at
  `
  ).run(email, secret, now, now);
}

export function getAccount(): GmailAccount | null {
  const row = db.prepare(`SELECT email, secret FROM gmail_accounts WHERE id = 1`).get() as
    | { email: string; secret: string }
    | undefined;

  if (!row) return null;
  return { email: row.email, appPassword: decrypt(row.secret) };
}

export function deleteAccount(): void {
  db.prepare(`DELETE FROM gmail_accounts WHERE id = 1`).run();
}
