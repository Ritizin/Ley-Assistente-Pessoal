import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { googleHomeService } from "./google-home.service.js";

const setModeSchema = z.object({
  deviceId: z.string().min(1),
  mode: z.enum(["HEAT", "COOL", "HEATCOOL", "OFF"]),
});

const setTempSchema = z.object({
  deviceId: z.string().min(1),
  celsius: z.number(),
  mode: z.enum(["heat", "cool"]).default("heat"),
});

export async function googleHomeRoutes(app: FastifyInstance): Promise<void> {
  // abre o navegador direto na tela de autorização do Nest Device Access
  app.get("/api/google-home/login", async (_req, reply) => {
    try {
      return reply.redirect(googleHomeService.getAuthUrl());
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // o Google chama essa URL de volta depois do login, com o "code"
  app.get("/api/google-home/callback", async (req, reply) => {
    const { code, error } = req.query as { code?: string; error?: string };

    if (error || !code) {
      return reply.type("text/html").send(
        `<html><body style="font-family:sans-serif;background:#0a0e1a;color:#fff;text-align:center;padding-top:60px">
          <h2>Falha ao conectar o Google Home</h2><p>${error ?? "code ausente"}</p>
          <p>Pode fechar essa aba e tentar de novo pelo painel.</p>
        </body></html>`
      );
    }

    try {
      await googleHomeService.handleAuthCallback(code);
      return reply.type("text/html").send(
        `<html><body style="font-family:sans-serif;background:#0a0e1a;color:#fff;text-align:center;padding-top:60px">
          <h2>Google Home conectado! 🏠</h2><p>Pode fechar essa aba e voltar pro painel da Ley.</p>
        </body></html>`
      );
    } catch (err) {
      app.log.error({ err }, "falha ao trocar code do Google Home");
      return reply.type("text/html").send(
        `<html><body style="font-family:sans-serif;background:#0a0e1a;color:#fff;text-align:center;padding-top:60px">
          <h2>Erro ao conectar</h2><p>${(err as Error).message}</p>
        </body></html>`
      );
    }
  });

  app.get("/api/google-home/status", async () => googleHomeService.getSnapshot());

  app.post("/api/google-home/disconnect", async () => {
    googleHomeService.disconnect();
    return { ok: true };
  });

  app.get("/api/google-home/devices", async (_req, reply) => {
    try {
      const devices = await googleHomeService.listDevices();
      return { devices };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.post("/api/google-home/thermostat/mode", async (req, reply) => {
    const parsed = setModeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "payload inválido" });

    try {
      await googleHomeService.setThermostatMode(parsed.data.deviceId, parsed.data.mode);
      return { ok: true };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.post("/api/google-home/thermostat/temperature", async (req, reply) => {
    const parsed = setTempSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "payload inválido" });

    try {
      await googleHomeService.setThermostatTemperature(
        parsed.data.deviceId,
        parsed.data.celsius,
        parsed.data.mode
      );
      return { ok: true };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });
}
