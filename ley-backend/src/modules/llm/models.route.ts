import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getActiveModel, listChatModels, setActiveModel } from "./groq.service.js";

const setModelBodySchema = z.object({
  model: z.string().min(1, "model é obrigatório"),
});

export async function modelsRoutes(app: FastifyInstance): Promise<void> {
  // lista os modelos de texto disponíveis na conta Groq + qual está ativo agora
  app.get("/api/models", async (_request, reply) => {
    try {
      const models = await listChatModels();
      return reply.send({ active: getActiveModel(), models });
    } catch (err) {
      app.log.error({ err }, "erro ao listar modelos");
      return reply.status(502).send({ error: "falha ao listar modelos da Groq" });
    }
  });

  // troca o modelo ativo do chat (o que é tentado primeiro em cada mensagem)
  app.post("/api/models", async (request, reply) => {
    const parsed = setModelBodySchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({ error: "payload inválido", details: parsed.error.flatten() });
    }

    try {
      await setActiveModel(parsed.data.model);
      return reply.send({ active: getActiveModel() });
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });
}
