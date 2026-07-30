import type { FastifyInstance } from "fastify";
import { ttsRoutes } from "./tts.route.js";

export { synthesizeSpeech, JARVIS_DEFAULT_VOICE_ID } from "./tts.service.js";

export async function registerTtsModule(app: FastifyInstance): Promise<void> {
  await app.register(ttsRoutes);
}
