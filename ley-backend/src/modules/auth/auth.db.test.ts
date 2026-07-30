import test from "node:test";
import assert from "node:assert/strict";

import { createAuthDatabase } from "./auth.db.js";
import { createJwt, verifyJwt } from "./routes.js";

test("createAuthDatabase persiste usuário Google no fallback SQLite", async () => {
  const db = await createAuthDatabase({ sqliteFilePath: ":memory:" });
  await db.initialize();

  const user = await db.createOrUpdateUser({
    provider: "google",
    googleId: "google-123",
    email: "ley@example.com",
    name: "Ley",
    picture: "https://example.com/avatar.png",
  });

  assert.equal(user.email, "ley@example.com");
  assert.equal(user.googleId, "google-123");

  const found = await db.findUserByEmail("ley@example.com");
  assert.ok(found);
  assert.equal(found?.name, "Ley");
});

test("createJwt/verifyJwt mantém sessão válida para desktop e mobile", () => {
  const token = createJwt({ sub: 42, email: "ley@example.com" });
  const payload = verifyJwt(token);

  assert.equal(payload.sub, 42);
  assert.equal(payload.email, "ley@example.com");
});
