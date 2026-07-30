import crypto from "node:crypto";
import { env } from "../../config/env.js";

const ALGO = "aes-256-gcm";

// deriva uma chave de 32 bytes (AES-256) a partir da GMAIL_ENCRYPTION_KEY,
// que pode ter qualquer tamanho >= 32 chars — scrypt normaliza isso
const KEY = crypto.scryptSync(env.GMAIL_ENCRYPTION_KEY, "ley-gmail-salt", 32);

// criptografa a senha de app antes de gravar no sqlite (nunca guardamos em texto puro)
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, data].map((buf) => buf.toString("base64")).join(".");
}

export function decrypt(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("payload criptografado inválido");
  }
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
