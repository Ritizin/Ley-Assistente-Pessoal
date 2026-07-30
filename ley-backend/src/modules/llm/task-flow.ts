import { completeTask, createTask, listTasks, type Task } from "./task.repository.js";
import { withAction } from "./action-marker.js";

// "adiciona uma tarefa: comprar pão" / "cria tarefa ligar pro dentista" /
// "anota tarefa pagar o boleto"
const CREATE_TASK_RE = /\b(adiciona|adicionar|cria|criar|anota|anotar|bota)\b[\s\S]*?\btarefa[s]?\b[:\s]+(.+)/i;

// "lembra de tomar remédio" / "lembrete: levar o carro no mecânico" — mesma
// tabela de tasks (não tem horário/agendamento ainda, é só uma lista de
// pendências) — se quiser lembrete com horário certo no futuro, dá pra
// evoluir isso pra um scheduler de verdade.
const CREATE_REMINDER_RE = /\blembr(?:a|e|ete)\b(?:\s+de)?[:\s]+(.+)/i;

const LIST_RE =
  /\b(minhas tarefas|lista de tarefas|o que (?:eu )?tenho (?:pra|para) fazer|quais? (?:s[ãa]o )?(?:as )?minhas tarefas)\b/i;

// "concluir tarefa comprar pão" / "marca como feita a tarefa do dentista" /
// "termina a tarefa boleto" / "já fiz a tarefa X"
const COMPLETE_TASK_RE =
  /\b(conclu[ií]|finaliza|termina|marca(?:\s+como\s+feita?)?|completa|j[aá]\s+fiz)\b[\s\S]*\btarefa[s]?\b[:\s]*(.+)?/i;

function formatTaskList(tasks: Task[]): string {
  if (tasks.length === 0) return "Nenhuma tarefa pendente — tá tudo em dia.";
  return tasks.map((t, i) => `${i + 1}. ${t.title}`).join("\n");
}

/**
 * Trata comandos de tarefas/lembretes no chat do painel: criar, listar e
 * concluir. Sem agendamento por horário de propósito (fica simples, tipo
 * lista de afazeres) — se precisar de lembrete com hora marcada, é outra
 * feature (precisa de scheduler).
 */
export async function handleTaskFlow(message: string): Promise<string | null> {
  if (LIST_RE.test(message)) {
    const pending = listTasks("pending");
    return `Suas tarefas pendentes:\n${formatTaskList(pending)}`;
  }

  const completeMatch = message.match(COMPLETE_TASK_RE);
  if (completeMatch) {
    const query = (completeMatch[2] ?? "").trim().replace(/[?.!]+$/, "");
    const pending = listTasks("pending");

    if (!query) {
      return pending.length === 0
        ? "Não tem tarefa pendente pra concluir."
        : `Qual tarefa? Suas pendentes:\n${formatTaskList(pending)}`;
    }

    const found = pending.find((t) => t.title.toLowerCase().includes(query.toLowerCase()));
    if (!found) {
      return `Não achei nenhuma tarefa pendente parecida com "${query}".`;
    }

    completeTask(found.id);
    return withAction(`Tarefa concluída: ${found.title}`, `Beleza, marquei "${found.title}" como concluída.`);
  }

  const createMatch = message.match(CREATE_TASK_RE) ?? message.match(CREATE_REMINDER_RE);
  if (createMatch) {
    const title = createMatch[createMatch.length - 1].trim().replace(/[?.!]+$/, "");
    if (!title) return "Beleza, mas o que eu anoto? Me diz o que é a tarefa.";

    const task = createTask(title);
    return withAction(
      `Tarefa criada: ${task.title}`,
      `Anotado: "${task.title}". Quando quiser ver, é só perguntar "minhas tarefas".`
    );
  }

  return null;
}
