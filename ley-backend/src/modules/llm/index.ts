import type { FastifyInstance } from "fastify";
import { chatRoutes } from "./chat.route.js";
import { taskRoutes } from "./task.route.js";
import { modelsRoutes } from "./models.route.js";

export { processChatMessage } from "./chat.service.js";

export async function registerLlmModule(app: FastifyInstance): Promise<void> {
  await app.register(chatRoutes);
  await app.register(taskRoutes);
  await app.register(modelsRoutes);
}
