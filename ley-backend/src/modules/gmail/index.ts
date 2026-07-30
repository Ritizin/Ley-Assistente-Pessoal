import type { FastifyInstance } from "fastify";
import { logger } from "../../core/logger.js";
import { gmailRoutes } from "./gmail.route.js";
import { gmailService } from "./gmail.service.js";

export { gmailService } from "./gmail.service.js";

export async function registerGmailModule(app: FastifyInstance): Promise<void> {
  await app.register(gmailRoutes);
}

export async function initGmail(): Promise<void> {
  try {
    await gmailService.restoreFromStorage();
  } catch (err) {
    logger.error({ err }, "falha ao iniciar módulo Gmail");
  }
}
