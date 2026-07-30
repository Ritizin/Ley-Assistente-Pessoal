import type { FastifyInstance } from "fastify";
import { createAuthDatabase } from "./auth.db.js";
import { registerAuthRoutes } from "./routes.js";

export const authDatabasePromise = createAuthDatabase();

export async function registerAuthModule(app: FastifyInstance): Promise<void> {
  const authDatabase = await authDatabasePromise;
  await authDatabase.initialize();
  await app.register(registerAuthRoutes, { authDatabase });
}
