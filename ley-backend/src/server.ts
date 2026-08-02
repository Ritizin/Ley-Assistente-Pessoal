import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { env } from "./config/env.js";
import { logger } from "./core/logger.js";
import { healthRoutes } from "./routes/health.js";
import { wsRoutes } from "./ws/route.js";
import { wsHub } from "./ws/hub.js";
import { registerLlmModule } from "./modules/llm/index.js";
import { registerTtsModule } from "./modules/tts/index.js";
import { initWhatsApp, registerWhatsAppModule } from "./modules/whatsapp/index.js";
import { registerGmailModule, initGmail } from "./modules/gmail/index.js";
import { registerSpotifyModule, initSpotify } from "./modules/spotify/index.js";
import { registerInstagramModule, initInstagram } from "./modules/instagram/index.js";
import { registerGoogleHomeModule, initGoogleHome } from "./modules/google-home/index.js";
import { registerCalendarModule } from "./modules/calendar/index.js";
import { backupStorageToRemote } from "./core/storage-sync.js";
import { registerAuthModule } from "./modules/auth/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// SEM ISSO, qualquer erro não tratado em background (WhatsApp, Gmail, WS,
// timers) derruba o processo Node inteiro sem log nenhum — é exatamente
// o "o servidor parou do nada" que você viu. Loga e segue rodando.
//
// Um caso específico é esperado e inofensivo: durante uma reconexão do
// Baileys (ex: logo depois de um "conflict/replaced", quando duas conexões
// se sobrepõem por um instante num redeploy), a própria lib deixa escapar
// uma promise rejeitada internamente com Boom 428 "Connection Closed" — o
// socket.service.ts já tem retry automático (scheduleReconnect) cuidando
// disso, então isso NÃO é uma falha real. Sem essa distinção, aparecia como
// "error" no log toda vez que o servidor reiniciava, parecendo um bug.
// Continua aparecendo (pra não esconder de verdade), só que como aviso.
function isBenignBaileysReconnectRejection(reason: unknown): boolean {
  const boom = reason as { output?: { statusCode?: number; payload?: { message?: string } } } | null;
  return boom?.output?.statusCode === 428 && boom.output?.payload?.message === "Connection Closed";
}

process.on("unhandledRejection", (reason) => {
  if (isBenignBaileysReconnectRejection(reason)) {
    logger.warn(
      { reason },
      "reconexão do WhatsApp em andamento (socket anterior fechado) — sem ação necessária, o retry automático cuida disso"
    );
    return;
  }
  logger.error({ reason }, "Promise rejeitada sem tratamento — servidor segue rodando");
});
process.on("uncaughtException", (err) => {
  logger.error({ err }, "Exceção não tratada — servidor segue rodando");
});

async function bootstrap() {
  const app = Fastify({
    loggerInstance: logger,
    // baixo overhead: desliga request logging verboso em produção
    disableRequestLogging: env.NODE_ENV === "production",
    // O padrão do Fastify é 1MB pro corpo da requisição (JSON). O modo de voz
    // manda o frame da tela compartilhada em base64 dentro do JSON de
    // /api/chat — uma captura de tela em JPEG facilmente passa de 1MB depois
    // de virar base64 (~33% maior que o binário). Sem esse limite maior, toda
    // vez que a Ley tenta enviar o frame junto com a fala, o Fastify rejeita a
    // requisição com 413 ANTES de chegar na rota — é exatamente o "buga
    // quando compartilho tela e falo" que você via: o chat de voz continua
    // "funcionando" (por isso parecia um bug esquisito e não uma queda total),
    // só que toda mensagem falhava silenciosamente e caía no fallback de erro.
    bodyLimit: 15 * 1024 * 1024, // 15MB
  });

  await app.register(cors, { origin: true });
  await app.register(websocket, { options: { maxPayload: 5 * 1024 * 1024 } }); // 5MB (áudio)
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB (upload de áudio + anexos de arquivo no chat)
  await app.register(fastifyStatic, {
    root: path.join(__dirname, "..", "public"),
    prefix: "/",
  });

  await app.register(healthRoutes);
  await app.register(wsRoutes);
  await app.register(registerLlmModule);
  await app.register(registerTtsModule);
  await app.register(registerWhatsAppModule);
  await app.register(registerGmailModule);
  await app.register(registerSpotifyModule);
  await app.register(registerInstagramModule);
  await app.register(registerGoogleHomeModule);
  await app.register(registerCalendarModule);
  await app.register(registerAuthModule);

  // encaminha logs do fastify/pino para o canal "logs" do painel web
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    wsHub.broadcast("logs", "line", chunk.toString());
    return originalWrite(chunk, ...args);
  }) as typeof process.stdout.write;

  // watchdog de memória — meta: manter RSS < 300MB
  setInterval(() => {
    const rssMB = process.memoryUsage().rss / 1024 / 1024;
    if (rssMB > 300) app.log.warn({ rssMB: Math.round(rssMB) }, "RSS acima do limite alvo (300MB)");
  }, 30_000).unref();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "encerrando servidor...");

    // último backup antes de morrer — é a chance de não perder o que mudou
    // desde o backup periódico anterior (até 2min de intervalo). Timeout de
    // segurança pra não travar o shutdown pra sempre se o Postgres estiver
    // fora do ar nesse momento.
    await Promise.race([
      backupStorageToRemote(),
      new Promise((resolve) => setTimeout(resolve, 8_000)),
    ]).catch((err) => app.log.error({ err }, "falha no backup final de storage/ no shutdown"));

    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`Ley API rodando em http://${env.HOST}:${env.PORT}`);

    // não bloqueia o boot do servidor: WhatsApp conecta/gera QR em background
    void initWhatsApp();
    // idem para o Gmail: se já houver conta salva, reconecta sozinho
    void initGmail();
    // idem pro Spotify: reconecta sozinho se já tiver refresh token salvo
    void initSpotify();
    // idem pro Instagram: reconecta sozinho se já tiver conta salva
    void initInstagram();
    // idem pro Google Home: reconecta sozinho se já tiver refresh token salvo
    void initGoogleHome();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

bootstrap();
