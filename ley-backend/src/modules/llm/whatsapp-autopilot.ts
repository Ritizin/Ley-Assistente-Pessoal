import { logger } from "../../core/logger.js";
import { whatsappService } from "../whatsapp/index.js";
import {
  getContactAutopilot,
  getContactByJid,
  getAudioOptOut,
  getWaSetting,
  listMessagesByJid,
  setAudioOptOut,
  setContactAutopilot,
  type WaMessageRow,
} from "../whatsapp/whatsapp.repository.js";
import { generateAutopilotReply, type LlmMessage } from "./groq.service.js";
import { synthesizeSpeech } from "../tts/tts.service.js";
import { synthesizeSpeechPiper } from "../tts/piper.service.js";
import { convertToOggOpus } from "../tts/audio-convert.js";

// espera juntar mensagens que chegam em rajada (várias bolhas seguidas da
// mesma pessoa) antes de responder — sem isso a Ley respondia cada bolha
// separadamente, o que não é como gente de verdade conversa no zap.
const DEBOUNCE_MS = 4_000;

// em grupo só responde por padrão se alguém chamar a Ley explicitamente pelo
// nome — sem essa trava, ela ficaria respondendo toda mensagem de todo grupo.
// Mas assim que alguém chama ("ley"), a gente MEMORIZA isso pro jid (grava
// override=1) — depois disso ela passa a responder normal, sem precisar
// escrever "ley" de novo em toda mensagem seguinte.
const MENTION_RE = /\bley\b/i;

// pedido de áudio dentro da conversa normal do WhatsApp (não é o fluxo do
// painel — aqui quem pediu foi um contato/grupo de fora, então a Ley sintetiza
// a própria resposta em voz em vez de só mandar texto).
// BUG corrigido aqui: \b (limite de palavra) do JS não reconhece "á" como
// letra — então "\b(audio|áudio)\b" nunca batia com "áudio" acentuado
// (só com "audio" sem acento), fazendo pedidos de áudio como "me manda um
// áudio" ou "manda um áudio aí" passarem batido. Removido o \b colado no
// acento; o \b nas palavras-gatilho (manda/mandar/...) já é suficiente.
const AUDIO_REQUEST_RE = /\b(manda|mandar|envia|enviar|solta)\b[\s\S]*(audio|áudio)|(audio|áudio)[\s\S]*\b(manda|mandar|envia|enviar)\b/i;

// detecta quando a pessoa avisa que NÃO consegue/quer ouvir áudio ("não
// consigo ouvir áudio", "sem fone agora", "manda por texto", "só texto pfv")
// — quando isso bate, a Ley entende e para de mandar áudio automático pra
// esse jid dali pra frente (ver setAudioOptOut em generateAndSend).
const NO_AUDIO_RE =
  /n[aã]o\s+(consigo|posso|d[aá])\s+(ouvir|escutar)|sem\s+(fone|audio|áudio)|s[oó]\s+(texto|escrito)|manda(r)?\s+(por\s+)?(escrito|texto)|prefiro\s+(texto|escrito)|n[aã]o\s+t[oô]\s+podendo\s+ouvir/i;

const pendingTimers = new Map<string, NodeJS.Timeout>();
const inFlight = new Set<string>();

// "Kill switch" manual: só bloqueia tudo se alguém explicitamente desligou o
// autopilot inteiro pelo painel (wa_settings.autopilot_global = "0"). Não
// serve mais como pré-requisito pra "ley" funcionar (ver bug abaixo).
function isAutopilotKilledGlobally(): boolean {
  return getWaSetting("autopilot_global") === "0";
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- mantido na assinatura por clareza (grupo x privado), mesmo não sendo mais usado aqui já que o gatilho "ley" agora vale igual pros dois
function shouldRespond(jid: string, _isGroup: boolean, triggerText: string | null): boolean {
  // BUG corrigido aqui: antes, pra qualquer contato/grupo que ainda não
  // tinha override salvo, a função checava um "portão" global
  // (env.WHATSAPP_AUTOPILOT_ENABLED, que vem `false` por padrão) ANTES de
  // sequer olhar se a mensagem continha "ley" — ou seja, o gatilho "ley"
  // nunca tinha chance de rodar em conversa nova nenhuma (grupo ou privada).
  // Só "funcionava" em grupos que já tinham ficado com override=1 salvo de
  // antes. Agora "ley" É o próprio mecanismo de ativação, tanto em grupo
  // quanto em conversa privada; o toggle global vira só um "desliga tudo"
  // manual, se for setado explicitamente.
  // BUG 2 corrigido aqui (esse ainda estava presente): o kill switch global
  // era checado ANTES do override do contato/grupo. Isso fazia
  // autopilot_global = "0" bloquear TUDO, inclusive contatos/grupos que já
  // tinham override = 1 salvo explicitamente — não é a intenção (override
  // explícito deve sempre vencer o kill switch, que só deve valer pra quem
  // nunca foi decidido ainda). Agora o override é checado primeiro.
  const override = getContactAutopilot(jid); // 1 | 0 | null

  if (override === 0) {
    logger.info({ jid }, "[autopilot] ignorado — contato/grupo silenciado explicitamente (override=0)");
    return false;
  }
  if (override === 1) {
    logger.info({ jid }, "[autopilot] respondendo — override=1 já ativado nesse contato/grupo");
    return true; // já ativado nesse contato/grupo, responde direto — vence o kill switch
  }

  // override === null: nunca foi ativado nesse jid. O kill switch global só
  // entra em jogo aqui, pra quem ainda não foi decidido.
  if (isAutopilotKilledGlobally()) {
    logger.info({ jid }, "[autopilot] ignorado — kill switch global ligado (autopilot_global=0) e esse jid nunca foi decidido");
    return false;
  }

  // Só ativa quando a pessoa chama "ley" — vale igual pra grupo e pra
  // conversa privada — e a partir daí fica memorizado (setContactAutopilot),
  // sem precisar chamar "ley" de novo nas próximas mensagens.
  const mentioned = MENTION_RE.test(triggerText ?? "");
  logger.info({ jid, triggerText, mentioned }, "[autopilot] checando gatilho 'ley' (jid nunca decidido antes)");
  if (mentioned) {
    setContactAutopilot(jid, 1);
    logger.info({ jid }, "[autopilot] ativado agora — 'ley' detectado, override=1 salvo");
    return true;
  }
  return false;
}

function rowToHistoryEntry(row: WaMessageRow, isGroup: boolean): LlmMessage | null {
  const content = row.type === "audio" ? row.transcript : row.text;
  if (!content) return null;

  const prefix = isGroup && !row.from_me ? `${row.sender_name ?? "alguém"}: ` : "";
  return { role: row.from_me ? "assistant" : "user", content: `${prefix}${content}` };
}

// monta a "identificação" de quem a Ley está falando nessa conversa
// específica do WhatsApp — nome salvo/visto (ou o pushName da última
// mensagem, como fallback) — pra injetar como contextNote na persona
// (ver generateAutopilotReply em groq.service.ts). É isso que permite a Ley
// tratar a pessoa pelo nome certo e tentar adivinhar o gênero por ele, em vez
// de responder igual pra todo mundo.
function buildContextNote(jid: string, isGroup: boolean, lastRow: WaMessageRow): string {
  if (isGroup) {
    const groupName = getContactByJid(jid)?.name ?? "esse grupo";
    return `Contexto desta conversa: você está respondendo em um GRUPO do WhatsApp chamado "${groupName}". Quem mandou a última mensagem foi "${lastRow.sender_name ?? "alguém"}" — o histórico já marca "nome: texto" pra cada pessoa do grupo, use isso pra não misturar quem falou o quê.`;
  }

  const name = getContactByJid(jid)?.name ?? lastRow.sender_name ?? null;
  if (!name) {
    return "Contexto desta conversa: conversa privada do WhatsApp com alguém que ainda não tem nome salvo — trate a pessoa de forma neutra até ela se apresentar.";
  }
  return `Contexto desta conversa: você está numa conversa PRIVADA do WhatsApp com "${name}". Baseado no nome, tente perceber se é homem ou mulher e fale com ele/ela de acordo, sem comentar isso.`;
}

// mesma cascata do painel (send-audio-flow.ts): ElevenLabs/clone primeiro,
// Piper local como fallback — sempre convertendo pra OGG/Opus, senão o
// WhatsApp recebe o arquivo mas mostra "áudio não disponível".
async function synthesizeAutopilotAudio(text: string): Promise<Buffer> {
  let raw: Buffer;
  let format: "mp3" | "wav";

  try {
    const { audio } = await synthesizeSpeech(text);
    raw = audio;
    format = "mp3";
  } catch {
    raw = await synthesizeSpeechPiper(text);
    format = "wav";
  }

  return convertToOggOpus(raw, format);
}

async function generateAndSend(jid: string): Promise<void> {
  if (inFlight.has(jid)) {
    logger.info({ jid }, "[autopilot] geração já em andamento pra esse jid — ignorando chamada duplicada");
    return;
  }
  inFlight.add(jid);

  try {
    const isGroup = jid.endsWith("@g.us");
    const rows = listMessagesByJid(jid, 20);
    if (rows.length === 0) {
      logger.info({ jid }, "[autopilot] abortado — nenhuma mensagem encontrada nesse jid");
      return;
    }

    // se a última mensagem já é nossa, alguém (o próprio dono, manualmente)
    // já respondeu nesse meio tempo — não atropela respondendo de novo.
    const lastRow = rows[rows.length - 1];
    if (lastRow.from_me) {
      logger.info({ jid }, "[autopilot] abortado — a última mensagem já é nossa (alguém respondeu manualmente)");
      return;
    }

    const history = rows
      .map((row) => rowToHistoryEntry(row, isGroup))
      .filter((m): m is LlmMessage => m !== null);

    if (history.length === 0 || history[history.length - 1].role !== "user") {
      logger.info(
        { jid, historyLen: history.length },
        "[autopilot] abortado — histórico vazio ou última entrada não é do usuário"
      );
      return;
    }

    logger.info({ jid, isGroup }, "[autopilot] gerando resposta...");

    const lastText = (lastRow.type === "audio" ? lastRow.transcript : lastRow.text) ?? "";

    // se a pessoa avisou que não consegue/quer ouvir áudio, memoriza isso pra
    // esse jid — dali pra frente a Ley nunca mais manda áudio automático,
    // mesmo que o AUDIO_REQUEST_RE bata em alguma mensagem futura por engano.
    if (NO_AUDIO_RE.test(lastText) && !getAudioOptOut(jid)) {
      setAudioOptOut(jid, true);
      logger.info({ jid }, "[autopilot] pessoa avisou que não ouve áudio — desativando áudio automático pra esse jid");
    }

    // aviso de "chegou mensagem nova" agora é feito pela aba de Notificações
    // do painel (baseada nas mensagens não lidas do próprio WhatsApp), não
    // mais como bolha dentro do chat da Ley — ver NotificationsTab.tsx.
    const wantsAudio = !getAudioOptOut(jid) && AUDIO_REQUEST_RE.test(lastText);

    const contextNote = buildContextNote(jid, isGroup, lastRow);

    await whatsappService.setPresence(jid, "composing").catch(() => undefined);

    let reply: string;
    try {
      reply = (await generateAutopilotReply(history, contextNote)).trim();
    } catch (err) {
      logger.error({ err, jid }, "falha ao gerar resposta do autopilot — mandando fallback pra não ficar em silêncio");
      await whatsappService.setPresence(jid, "paused").catch(() => undefined);
      await whatsappService.sendText(jid, "opa, deu ruim aqui do meu lado agora, manda de novo daqui a pouco kk").catch(() => undefined);
      return;
    }

    await whatsappService.setPresence(jid, "paused").catch(() => undefined);
    if (!reply) {
      logger.info({ jid }, "[autopilot] abortado — o modelo devolveu resposta vazia");
      return;
    }

    if (wantsAudio) {
      try {
        const audio = await synthesizeAutopilotAudio(reply);
        await whatsappService.sendAudio(jid, audio);
        logger.info({ jid }, "[autopilot] áudio enviado com sucesso");
        return;
      } catch (err) {
        logger.error({ err, jid }, "falha ao gerar/enviar áudio do autopilot — caindo pra texto");
        // não deixa o pedido de áudio morrer em silêncio: manda pelo menos o texto
      }
    }

    await whatsappService.sendText(jid, reply);
    logger.info({ jid }, "[autopilot] texto enviado com sucesso");
  } catch (err) {
    logger.error({ err, jid }, "falha no autopilot de WhatsApp");
  } finally {
    inFlight.delete(jid);
  }
}

function queue(jid: string): void {
  const existing = pendingTimers.get(jid);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pendingTimers.delete(jid);
    void generateAndSend(jid);
  }, DEBOUNCE_MS);
  timer.unref();

  pendingTimers.set(jid, timer);
}

/**
 * Ponto de entrada chamado pelo whatsapp.service.ts a cada mensagem recebida
 * (não enviada por nós). Decide se a Ley deve responder sozinha e, se sim,
 * agenda a geração (com debounce pra juntar rajada de mensagens).
 */
export function handleIncomingAutopilot(jid: string, isGroup: boolean, triggerText: string | null): void {
  logger.info({ jid, isGroup, triggerText }, "[autopilot] avaliando mensagem recebida");
  if (!shouldRespond(jid, isGroup, triggerText)) return;
  logger.info({ jid }, "[autopilot] agendado pra responder (debounce de 4s)");
  queue(jid);
}
