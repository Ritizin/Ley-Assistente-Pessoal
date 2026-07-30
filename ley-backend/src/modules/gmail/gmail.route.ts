import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { gmailService } from "./gmail.service.js";

const connectSchema = z.object({
  email: z.string().email("e-mail inválido"),
  appPassword: z.string().min(1, "senha de app obrigatória"),
});

const sendSchema = z.object({
  to: z.string().email("destinatário inválido"),
  subject: z.string().min(1, "assunto obrigatório"),
  text: z.string().min(1, "corpo do e-mail obrigatório"),
});

export async function gmailRoutes(app: FastifyInstance): Promise<void> {
  // Conectar conta (e-mail + senha de app do Gmail)
  app.post("/api/gmail/connect", async (request, reply) => {
    const parsed = connectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Payload inválido", details: parsed.error.flatten() });
    }

    try {
      await gmailService.connect(parsed.data.email, parsed.data.appPassword);
      return reply.send(gmailService.getSnapshot());
    } catch {
      return reply
        .status(401)
        .send({ error: "Não foi possível conectar. Confira o e-mail e a senha de app." });
    }
  });

  // Desconectar e esquecer a conta salva
  app.post("/api/gmail/disconnect", async (_request, reply) => {
    await gmailService.disconnect(true);
    return reply.send({ message: "Gmail desconectado com sucesso" });
  });

  // Status atual da conexão
  app.get("/api/gmail/status", async (_request, reply) => {
    return reply.send(gmailService.getSnapshot());
  });

  // Enviar e-mail usando a conta conectada
  app.post("/api/gmail/send", async (request, reply) => {
    const parsed = sendSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Payload inválido", details: parsed.error.flatten() });
    }

    try {
      await gmailService.sendEmail(parsed.data.to, parsed.data.subject, parsed.data.text);
      return reply.send({ message: "E-mail enviado com sucesso!" });
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message || "falha ao enviar e-mail" });
    }
  });
}
