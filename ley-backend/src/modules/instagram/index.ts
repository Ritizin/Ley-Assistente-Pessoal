import type { FastifyInstance } from "fastify";
import { logger } from "../../core/logger.js";
import { instagramRoutes } from "./instagram.route.js";
import { instagramService } from "./instagram.service.js";

export { instagramService } from "./instagram.service.js";

export async function registerInstagramModule(app: FastifyInstance): Promise<void> {
  await app.register(instagramRoutes);
}

export async function initInstagram(): Promise<void> {
  try {
    await instagramService.restoreFromStorage();
  } catch (err) {
    logger.error({ err }, "falha ao iniciar módulo Instagram");
  }
}
