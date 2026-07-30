import type { FastifyInstance } from "fastify";
import { logger } from "../../core/logger.js";
import { whatsappService } from "./whatsapp.service.js";
import { whatsappRoutes } from "./whatsapp.route.js";

export { whatsappService } from "./whatsapp.service.js";

export async function initWhatsApp(): Promise<void> {
  try {
    await whatsappService.start();
  } catch (err) {
    logger.error({ err }, "falha ao iniciar módulo WhatsApp");
  }
}

export async function registerWhatsAppModule(app: FastifyInstance): Promise<void> {
  await app.register(whatsappRoutes);
}
