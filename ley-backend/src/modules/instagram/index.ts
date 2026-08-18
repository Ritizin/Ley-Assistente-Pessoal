import type { FastifyInstance } from "fastify";
import { logger } from "../../core/logger.js";
import { instagramRoutes } from "./instagram.route.js";
import { instagramService } from "./instagram.service.js";
import { instagramDmRoutes } from "./instagram-dm.route.js";
import { instagramDmService } from "./instagram-dm.service.js";

export { instagramService } from "./instagram.service.js";
export { instagramDmService } from "./instagram-dm.service.js";

export async function registerInstagramModule(app: FastifyInstance): Promise<void> {
  await app.register(instagramRoutes);
  await app.register(instagramDmRoutes);
}

export async function initInstagram(): Promise<void> {
  try {
    await instagramService.restoreFromStorage();
  } catch (err) {
    logger.error({ err }, "falha ao iniciar módulo Instagram (Graph API)");
  }

  try {
    await instagramDmService.start();
  } catch (err) {
    logger.error({ err }, "falha ao iniciar módulo Instagram DM (API privada)");
  }
}
