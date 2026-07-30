import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";

export interface JwtPayload {
  sub?: number;
  email?: string;
  jti?: string;
  [key: string]: unknown;
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function buildSigningInput(header: string, body: string): string {
  return `${header}.${body}`;
}

export function createJwt(payload: JwtPayload): string {
  const header = encodeBase64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = encodeBase64Url(JSON.stringify(payload));
  const signature = createHmac("sha256", env.JWT_SECRET)
    .update(buildSigningInput(header, body))
    .digest("base64url");

  return `${header}.${body}.${signature}`;
}

export function verifyJwt(token: string): JwtPayload {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("invalid_token");
  }

  const [header, body, signature] = parts;
  const expectedSignature = createHmac("sha256", env.JWT_SECRET)
    .update(buildSigningInput(header, body))
    .digest("base64url");

  const expectedBuffer = Buffer.from(expectedSignature, "base64url");
  const actualBuffer = Buffer.from(signature, "base64url");

  if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) {
    throw new Error("invalid_token");
  }

  return JSON.parse(decodeBase64Url(body)) as JwtPayload;
}
