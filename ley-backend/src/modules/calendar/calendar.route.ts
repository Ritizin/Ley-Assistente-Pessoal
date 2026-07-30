import type { FastifyInstance, FastifyRequest } from "fastify";
import { verifyJwt } from "../auth/routes.js";
import { calendarService } from "./calendar.service.js";

// mesmo padrão de autenticação do /auth/me — pega o e-mail a partir do JWT
// do painel pra saber de quem é a agenda (é o mesmo e-mail usado pra achar
// o refresh_token salvo em google_tokens)
function getEmailFromRequest(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return null;

  try {
    const payload = verifyJwt(authorization.slice("Bearer ".length));
    return payload.email ?? null;
  } catch {
    return null;
  }
}

export async function calendarRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/calendar/status", async (request, reply) => {
    const email = getEmailFromRequest(request);
    if (!email) return reply.code(401).send({ error: "não autenticado" });

    const connected = await calendarService.isConnected(email);
    return { connected };
  });

  app.get("/api/calendar/events", async (request, reply) => {
    const email = getEmailFromRequest(request);
    if (!email) return reply.code(401).send({ error: "não autenticado" });

    try {
      const events = await calendarService.listUpcomingEvents(email, 15);
      return { events };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : "falha ao buscar agenda" });
    }
  });
}
