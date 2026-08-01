import { logger } from "../../core/logger.js";
import { wsHub } from "../../ws/hub.js";
import { generateReply, generateVisionReply } from "./groq.service.js";
import {
  addMessage,
  getContext,
  getOrCreateConversation,
  touchConversation,
} from "./history.repository.js";
import { listTasks, createTask } from "./task.repository.js";
import { getPending, handleSendAudioFlow } from "./send-audio-flow.js";
import { handleSendTextFlow } from "./send-text-flow.js";
import { handleSendFileFlow } from "./send-file-flow.js";
import { handleSaveContactFlow } from "./save-contact-flow.js";
import { handleCreateGroupFlow } from "./create-group-flow.js";
import { handleBlockContactFlow } from "./block-contact-flow.js";
import { handleTaskFlow } from "./task-flow.js";
import { stripActionMarker } from "./action-marker.js";
import { handleWhatsAppInboxFlow } from "./whatsapp-inbox-flow.js";
import { handleOpenConversationFlow } from "./open-conversation-flow.js";
import { handleSpotifyFlow } from "./spotify-flow.js";
import { handleInstagramFlow } from "./instagram-flow.js";
import { handleGoogleHomeFlow } from "./google-home-flow.js";
import { detectFileCommand, FILE_MODE_INSTRUCTION } from "./file-mode.js";
import { buildWhatsAppSilentContext } from "./whatsapp-context.js";
import { setActiveConversationId } from "./active-conversation.js";

export interface ChatRequest {
  conversationId?: string;
  message: string;
  // frame da tela compartilhada (voz), quando o usuário está no modo de compartilhamento
  imageBase64?: string;
  // resumo/conteúdo de arquivo(s) anexados nessa mensagem (upload no chat).
  // Só entra no que é mandado pro modelo nessa chamada — não é salvo no
  // histórico, pra não inflar o contexto de conversas futuras com o conteúdo
  // inteiro de um arquivo.
  fileContext?: string;
}

export interface ChatResult {
  conversationId: string;
  reply: string;
  // true quando a Ley está esperando o usuário gravar um áudio (fluxo de
  // "manda um áudio pra fulano" com "com a minha voz") — o frontend usa isso
  // pra mostrar o botão de gravação.
  awaitingVoiceRecording?: boolean;
}

export async function processChatMessage(input: ChatRequest): Promise<ChatResult> {
  const conversationId = getOrCreateConversation(input.conversationId);
  setActiveConversationId(conversationId);

  // Lógica simples para criar/concluir tarefa via chat antes de enviar pro modelo
  const lowerMsg = input.message.toLowerCase();
  
  if (lowerMsg.startsWith("anota aí:") || lowerMsg.startsWith("lembra de:")) {
    const taskTitle = input.message.replace(/^(anota aí:|lembra de:)/i, "").trim();
    if (taskTitle) {
      createTask(taskTitle);
    }
  }

  addMessage(conversationId, "user", input.message);
  wsHub.broadcast("chat", "message", {
    conversationId,
    role: "user",
    content: input.message,
  });

  // Se veio um frame da tela compartilhada, a intenção é clara: analisar a
  // tela. Vai direto pro modelo de visão, sem passar pelos fluxos de
  // WhatsApp/Spotify/tarefas — evita confundir um comando de voz com o
  // conteúdo da tela.
  if (input.imageBase64) {
    const history = getContext(conversationId).map((m) => ({ role: m.role, content: stripActionMarker(m.content) }));

    if (input.fileContext && history.length > 0 && history[history.length - 1].role === "user") {
      history[history.length - 1].content += input.fileContext;
    }

    const reply = await generateVisionReply(history, input.imageBase64);

    addMessage(conversationId, "assistant", reply);
    touchConversation(conversationId);

    wsHub.broadcast("chat", "message", { conversationId, role: "assistant", content: reply });
    logger.debug({ conversationId }, "mensagem processada com visão (tela compartilhada)");

    return { conversationId, reply };
  }

  // BUG corrigido aqui: handleSendAudioFlow/handleSendTextFlow/handleSendFileFlow
  // mantêm estado pendente por conversa (ex: "aguardando o nome pra salvar o
  // contato depois de mandar mensagem pra um número novo"). Antes, esses 3
  // fluxos rodavam DEPOIS dos fluxos sem estado (save-contact, create-group,
  // block-contact, task, whatsapp-inbox, open-conversation) — então se a
  // PRÓXIMA mensagem do usuário batesse com a regex de um fluxo sem estado
  // (ex: perguntar "e mensagem nos grupos?" logo depois de "quer que eu
  // salve esse contato?"), o fluxo sem estado respondia primeiro e o estado
  // pendente ficava "preso", sendo consumido erroneamente só na mensagem
  // seguinte (a Ley "salvava um contato" com o texto de uma pergunta sem
  // relação nenhuma). Agora os 3 fluxos com estado são checados PRIMEIRO,
  // garantindo que uma conversa em andamento sempre tem prioridade.

  // Fluxo de "manda um áudio pra fulano": se a mensagem pertence a esse fluxo
  // (iniciando ou continuando uma conversa já em andamento), responde direto
  // sem passar pelo modelo.
  const flowReply = await handleSendAudioFlow(conversationId, input.message);

  if (flowReply !== null) {
    addMessage(conversationId, "assistant", flowReply);
    touchConversation(conversationId);

    wsHub.broadcast("chat", "message", {
      conversationId,
      role: "assistant",
      content: flowReply,
    });

    logger.debug({ conversationId }, "mensagem tratada pelo fluxo de envio de áudio");

    return {
      conversationId,
      reply: flowReply,
      awaitingVoiceRecording: getPending(conversationId)?.step === "aguardando_gravacao",
    };
  }

  // Fluxo de "manda uma mensagem/msg pra fulano": mesma ideia do fluxo de
  // áudio acima, mas envia texto puro pelo WhatsApp sem precisar de TTS/gravação.
  const textFlowReply = await handleSendTextFlow(conversationId, input.message);

  if (textFlowReply !== null) {
    addMessage(conversationId, "assistant", textFlowReply);
    touchConversation(conversationId);

    wsHub.broadcast("chat", "message", {
      conversationId,
      role: "assistant",
      content: textFlowReply,
    });

    logger.debug({ conversationId }, "mensagem tratada pelo fluxo de envio de texto");

    return { conversationId, reply: textFlowReply };
  }

  // Fluxo de "manda esse arquivo pra fulano": manda o último arquivo anexado
  // no chat pro WhatsApp (pessoa ou grupo) — mesma ideia dos fluxos de texto
  // e áudio acima.
  const fileFlowReply = await handleSendFileFlow(conversationId, input.message);

  if (fileFlowReply !== null) {
    addMessage(conversationId, "assistant", fileFlowReply);
    touchConversation(conversationId);

    wsHub.broadcast("chat", "message", {
      conversationId,
      role: "assistant",
      content: fileFlowReply,
    });

    logger.debug({ conversationId }, "mensagem tratada pelo fluxo de envio de arquivo");

    return { conversationId, reply: fileFlowReply };
  }

  // Fluxo de "salva/memoriza o contato fulano com o número X": trata antes dos
  // fluxos de envio pra poder gravar o contato e já deixar disponível pros dois.
  const saveContactReply = await handleSaveContactFlow(input.message);

  if (saveContactReply !== null) {
    addMessage(conversationId, "assistant", saveContactReply);
    touchConversation(conversationId);

    wsHub.broadcast("chat", "message", {
      conversationId,
      role: "assistant",
      content: saveContactReply,
    });

    logger.debug({ conversationId }, "mensagem tratada pelo fluxo de memorizar contato");

    return { conversationId, reply: saveContactReply };
  }

  // Fluxo de "cria um grupo chamado X com fulano e beltrano"
  const createGroupReply = await handleCreateGroupFlow(input.message);

  if (createGroupReply !== null) {
    addMessage(conversationId, "assistant", createGroupReply);
    touchConversation(conversationId);

    wsHub.broadcast("chat", "message", {
      conversationId,
      role: "assistant",
      content: createGroupReply,
    });

    logger.debug({ conversationId }, "mensagem tratada pelo fluxo de criar grupo");

    return { conversationId, reply: createGroupReply };
  }

  // Fluxo de "bloqueia/desbloqueia o contato X"
  const blockContactReply = await handleBlockContactFlow(input.message);

  if (blockContactReply !== null) {
    addMessage(conversationId, "assistant", blockContactReply);
    touchConversation(conversationId);

    wsHub.broadcast("chat", "message", {
      conversationId,
      role: "assistant",
      content: blockContactReply,
    });

    logger.debug({ conversationId }, "mensagem tratada pelo fluxo de bloquear/desbloquear contato");

    return { conversationId, reply: blockContactReply };
  }

  // Fluxo de tarefas/lembretes: "adiciona uma tarefa: X", "minhas tarefas",
  // "concluir tarefa X", "lembra de X"
  const taskReply = await handleTaskFlow(input.message);

  if (taskReply !== null) {
    addMessage(conversationId, "assistant", taskReply);
    touchConversation(conversationId);

    wsHub.broadcast("chat", "message", {
      conversationId,
      role: "assistant",
      content: taskReply,
    });

    logger.debug({ conversationId }, "mensagem tratada pelo fluxo de tarefas");

    return { conversationId, reply: taskReply };
  }

  // Fluxo de "tem mensagem não lida?" / "quem me mandou mensagem?" / "toca o
  // áudio de fulano" / "qual o número de fulano": tudo que é sobre CONSULTAR
  // o que já chegou no WhatsApp (nunca sobre enviar) — responde direto do
  // banco local, sem inventar remetente/número/áudio via LLM.
  const inboxReply = handleWhatsAppInboxFlow(conversationId, input.message);

  if (inboxReply !== null) {
    addMessage(conversationId, "assistant", inboxReply);
    touchConversation(conversationId);

    wsHub.broadcast("chat", "message", {
      conversationId,
      role: "assistant",
      content: inboxReply,
    });

    logger.debug({ conversationId }, "mensagem tratada pelo fluxo de consulta de mensagens do WhatsApp");

    return { conversationId, reply: inboxReply };
  }

  // Fluxo de "abre a conversa/o grupo com fulano": pede pro painel abrir
  // aquela conversa específica.
  const openConversationReply = handleOpenConversationFlow(input.message);

  if (openConversationReply !== null) {
    addMessage(conversationId, "assistant", openConversationReply);
    touchConversation(conversationId);

    wsHub.broadcast("chat", "message", {
      conversationId,
      role: "assistant",
      content: openConversationReply,
    });

    logger.debug({ conversationId }, "mensagem tratada pelo fluxo de abrir conversa do WhatsApp");

    return { conversationId, reply: openConversationReply };
  }

  // Fluxo de comandos do Spotify ("toca X", "pausa", "próxima música"...)
  const spotifyReply = await handleSpotifyFlow(input.message);

  if (spotifyReply !== null) {
    addMessage(conversationId, "assistant", spotifyReply);
    touchConversation(conversationId);

    wsHub.broadcast("chat", "message", {
      conversationId,
      role: "assistant",
      content: spotifyReply,
    });

    logger.debug({ conversationId }, "mensagem tratada pelo fluxo do Spotify");

    return { conversationId, reply: spotifyReply };
  }

  // Fluxo de comandos do Instagram ("posta essa foto...", "meus posts"...)
  const instagramReply = await handleInstagramFlow(input.message);

  if (instagramReply !== null) {
    addMessage(conversationId, "assistant", instagramReply);
    touchConversation(conversationId);

    wsHub.broadcast("chat", "message", {
      conversationId,
      role: "assistant",
      content: instagramReply,
    });

    logger.debug({ conversationId }, "mensagem tratada pelo fluxo do Instagram");

    return { conversationId, reply: instagramReply };
  }

  // Fluxo de comandos do Google Home ("liga o aquecimento", "qual a temperatura"...)
  const googleHomeReply = await handleGoogleHomeFlow(input.message);

  if (googleHomeReply !== null) {
    addMessage(conversationId, "assistant", googleHomeReply);
    touchConversation(conversationId);

    wsHub.broadcast("chat", "message", {
      conversationId,
      role: "assistant",
      content: googleHomeReply,
    });

    logger.debug({ conversationId }, "mensagem tratada pelo fluxo do Google Home");

    return { conversationId, reply: googleHomeReply };
  }

  // Busca tarefas pendentes para injetar como CONTEXTO SILENCIOSO
  const pendingTasks = listTasks("pending");
  const taskContext = pendingTasks.length > 0
    ? `\n\n[SISTEMA - CONTEXTO SILENCIOSO DE TAREFAS PENDENTES]:\n` + 
      pendingTasks.map(t => `- ID ${t.id}: ${t.title}`).join("\n") +
      `\nINSTRUÇÃO CRÍTICA: Não fique cobrando, lembrando ou mencionando essas tarefas espontaneamente. Responda APENAS ao que o usuário perguntou na mensagem atual. Só fale de tarefas se ele expressamente pedir.`
    : `\n\n[SISTEMA: Não há tarefas pendentes]`;

  const context = getContext(conversationId);
  const formattedHistory = context.map((m) => ({ role: m.role, content: stripActionMarker(m.content) }));

  // Modo de geração de arquivos: só ativa quando o usuário manda o comando
  // explícito (/criar, /gerar, /arquivo) — nunca por decisão espontânea da IA.
  const fileCommand = detectFileCommand(input.message);

  // Injeta o contexto instruído (tarefas pendentes + arquivos anexados +
  // modo de geração de arquivos, se algum estiver ativo) na última mensagem
  // enviada pelo usuário
  // Contexto silencioso do WhatsApp: status da conexão + não lidas + últimas
  // mensagens trocadas. Mesmo princípio do taskContext — a Ley não comenta
  // isso por conta própria, mas usa pra responder com precisão quando o
  // usuário perguntar algo sobre as conversas do WhatsApp.
  const whatsappContext = buildWhatsAppSilentContext();

  if (formattedHistory.length > 0 && formattedHistory[formattedHistory.length - 1].role === "user") {
    formattedHistory[formattedHistory.length - 1].content +=
      taskContext +
      whatsappContext +
      (input.fileContext ?? "") +
      (fileCommand.isFileCommand ? FILE_MODE_INSTRUCTION : "");
  }

  const reply = await generateReply(formattedHistory);

  addMessage(conversationId, "assistant", reply);
  touchConversation(conversationId);

  wsHub.broadcast("chat", "message", {
    conversationId,
    role: "assistant",
    content: reply,
  });

  logger.debug({ conversationId }, "mensagem de chat processada");

  return { conversationId, reply };
}
