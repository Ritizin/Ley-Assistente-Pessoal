import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createTask, listTasks, completeTask } from "./task.repository.js";

const createTaskSchema = z.object({
  title: z.string().min(1, "O título não pode ser vazio"),
});

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  // Criar tarefa
  app.post("/api/tasks", async (request, reply) => {
    const parsed = createTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Payload inválido", details: parsed.error.flatten() });
    }
    const task = createTask(parsed.data.title);
    return reply.status(201).send(task);
  });

  // Listar tarefas
  app.get("/api/tasks", async (request, reply) => {
    const { status } = request.query as { status?: 'pending' | 'completed' };
    const tasks = listTasks(status);
    return reply.send({ tasks });
  });

  // Concluir tarefa
  app.patch("/api/tasks/:id/complete", async (request, reply) => {
    const { id } = request.params as { id: string };
    const taskId = Number(id);
    if (isNaN(taskId)) {
      return reply.status(400).send({ error: "ID inválido" });
    }
    const success = completeTask(taskId);
    if (!success) {
      return reply.status(404).send({ error: "Tarefa não encontrada" });
    }
    return reply.send({ message: "Tarefa concluída com sucesso!" });
  });
}
