import { logger } from "../../core/logger.js";
import { instagramDmService } from "../instagram/instagram-dm.service.js";
import {
  getContactAutopilot,
  getContactByThread,
  getIgDmSetting,
  listMessagesByThread,
  setContactAutopilot,
  type IgDmMessageRow,
} from "../instagram/instagram-dm.repository.js";
import { generateAutopilotReply, type LlmMessage } from "./groq.service.js";

// mesmo espírito do whatsapp-autopilot.ts: espera juntar mensagens que
// chegam em rajada antes de responder
const DEBOUNCE_MS = 4_000;

// em thread de grupo só responde por padrão se alguém chamar a Ley pelo
// nome — igual ao comportamento em grupo do WhatsApp
const MENTION_RE = /\bley\b/i;

const pendingTimers = new Map<string, NodeJS.Timeout>();
const inFlight = new Set<string>();

function isAutopilotKilledGlobally(): boolean {
  // kill switch manual do painel (ig_dm_settings.autopilot_global = "0").
  // Se nunca foi setado, cai no default do .env (mesmo padrão do WhatsApp).
  const stored = getIgDmSetting("autopilot_global");
  if (stored !== null) return stored === "0";
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- mantido por clareza (grupo x DM 1:1), mesmo padrão do whatsapp-autopilot.ts
function shouldRespond(threadId: string, _isGroup: boolean, triggerText: string | null): boolean {
  const override = getContactAutopilot(threadId); // 1 | 0 | null

  if (override === 0) {
    logger.info({ threadId }, "[ig-autopilot] ignorado — thread silenciada explicitamente (override=0)");
    return false;
  }
  if (override === 1) {
    logger.info({ threadId }, "[ig-autopilot] respondendo — override=1 já ativado nessa thread");
    return true;
  }

  if (isAutopilotKilledGlobally()) {
    logger.info({ threadId }, "[ig-autopilot] ignorado — kill switch global ligado e essa thread nunca foi decidida");
    return false;
  }

  const mentioned = MENTION_RE.test(triggerText ?? "");
  logger.info({ threadId, triggerText, mentioned }, "[ig-autopilot] checando gatilho 'ley'");
  if (mentioned) {
    setContactAutopilot(threadId, 1);
    logger.info({ threadId }, "[ig-autopilot] ativado agora — 'ley' detectado, override=1 salvo");
    return true;
  }
  return false;
}

function rowToHistoryEntry(row: IgDmMessageRow, isGroup: boolean): LlmMessage | null {
  if (!row.text) return null;
  const prefix = isGroup && !row.from_me ? `${row.sender_name ?? "alguém"}: ` : "";
  return { role: row.from_me ? "assistant" : "user", content: `${prefix}${row.text}` };
}

function buildContextNote(threadId: string, isGroup: boolean, lastRow: IgDmMessageRow): string {
  if (isGroup) {
    const groupName = getContactByThread(threadId)?.name ?? "esse grupo";
    return `Contexto desta conversa: você está respondendo em um GRUPO de DM do Instagram chamado "${groupName}". Quem mandou a última mensagem foi "${lastRow.sender_name ?? "alguém"}" — o histórico já marca "nome: texto" pra cada pessoa do grupo, use isso pra não misturar quem falou o quê.`;
  }

  const contact = getContactByThread(threadId);
  const name = contact?.name ?? contact?.username ?? lastRow.sender_name ?? null;
  if (!name) {
    return "Contexto desta conversa: DM PRIVADA do Instagram com alguém que ainda não tem nome salvo — trate a pessoa de forma neutra até ela se apresentar.";
  }
  return `Contexto desta conversa: você está numa DM PRIVADA do Instagram (não é WhatsApp) com "${name}". Baseado no nome, tente perceber se é homem ou mulher e fale com ele/ela de acordo, sem comentar isso.`;
}

async function generateAndSend(threadId: string): Promise<void> {
  if (inFlight.has(threadId)) {
    logger.info({ threadId }, "[ig-autopilot] geração já em andamento pra essa thread — ignorando duplicada");
    return;
  }
  inFlight.add(threadId);

  try {
    const isGroup = (getContactByThread(threadId)?.is_group ?? 0) === 1;
    const rows = listMessagesByThread(threadId, 20);
    if (rows.length === 0) {
      logger.info({ threadId }, "[ig-autopilot] abortado — nenhuma mensagem encontrada nessa thread");
      return;
    }

    const lastRow = rows[rows.length - 1];
    if (lastRow.from_me) {
      logger.info({ threadId }, "[ig-autopilot] abortado — a última mensagem já é nossa (alguém respondeu manualmente)");
      return;
    }

    const history = rows
      .map((row) => rowToHistoryEntry(row, isGroup))
      .filter((m): m is LlmMessage => m !== null);

    if (history.length === 0 || history[history.length - 1].role !== "user") {
      logger.info({ threadId, historyLen: history.length }, "[ig-autopilot] abortado — histórico vazio ou última entrada não é do usuário");
      return;
    }

    logger.info({ threadId, isGroup }, "[ig-autopilot] gerando resposta...");
    const contextNote = buildContextNote(threadId, isGroup, lastRow);

    let reply: string;
    try {
      reply = (await generateAutopilotReply(history, contextNote)).trim();
    } catch (err) {
      logger.error({ err, threadId }, "falha ao gerar resposta do autopilot — mandando fallback pra não ficar em silêncio");
      await instagramDmService.sendText(threadId, "opa, deu ruim aqui do meu lado agora, manda de novo daqui a pouco kk").catch(() => undefined);
      return;
    }

    if (!reply) {
      logger.info({ threadId }, "[ig-autopilot] abortado — o modelo devolveu resposta vazia");
      return;
    }

    await instagramDmService.sendText(threadId, reply);
    logger.info({ threadId }, "[ig-autopilot] texto enviado com sucesso");
  } catch (err) {
    logger.error({ err, threadId }, "falha no autopilot de DM do Instagram");
  } finally {
    inFlight.delete(threadId);
  }
}

function queue(threadId: string): void {
  const existing = pendingTimers.get(threadId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pendingTimers.delete(threadId);
    void generateAndSend(threadId);
  }, DEBOUNCE_MS);
  timer.unref();

  pendingTimers.set(threadId, timer);
}

/**
 * Ponto de entrada chamado pelo instagram-dm.service.ts a cada mensagem
 * recebida por DM (não enviada por nós). Decide se a Ley deve responder
 * sozinha e, se sim, agenda a geração (com debounce pra juntar rajada).
 */
export function handleIncomingAutopilot(threadId: string, isGroup: boolean, triggerText: string | null): void {
  logger.info({ threadId, isGroup, triggerText }, "[ig-autopilot] avaliando mensagem recebida");
  if (!shouldRespond(threadId, isGroup, triggerText)) return;
  logger.info({ threadId }, "[ig-autopilot] agendado pra responder (debounce de 4s)");
  queue(threadId);
}
