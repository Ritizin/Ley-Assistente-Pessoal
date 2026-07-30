import type { FastifyInstance } from "fastify";
import { logger } from "../../core/logger.js";
import { spotifyRoutes } from "./spotify.route.js";
import { spotifyService } from "./spotify.service.js";

export { spotifyService } from "./spotify.service.js";

export async function registerSpotifyModule(app: FastifyInstance): Promise<void> {
  await app.register(spotifyRoutes);
}

export async function initSpotify(): Promise<void> {
  try {
    await spotifyService.restoreFromStorage();
  } catch (err) {
    logger.error({ err }, "falha ao iniciar módulo Spotify");
  }
}
