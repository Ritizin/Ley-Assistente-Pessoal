import type { FastifyInstance } from "fastify";
import { logger } from "../../core/logger.js";
import { googleHomeRoutes } from "./google-home.route.js";
import { googleHomeService } from "./google-home.service.js";

export { googleHomeService } from "./google-home.service.js";

export async function registerGoogleHomeModule(app: FastifyInstance): Promise<void> {
  await app.register(googleHomeRoutes);
}

export async function initGoogleHome(): Promise<void> {
  try {
    await googleHomeService.restoreFromStorage();
  } catch (err) {
    logger.error({ err }, "falha ao iniciar módulo Google Home");
  }
}
