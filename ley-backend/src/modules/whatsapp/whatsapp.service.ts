import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Boom } from "@hapi/boom";
import QRCode from "qrcode";
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";

import { env } from "../../config/env.js";
import { logger } from "../../core/logger.js";
import { wsHub } from "../../ws/hub.js";
import { transcribeAudioFile } from "../stt/index.js";
import {
  findContactByName,
  saveContact as saveContactRow,
  saveMessage,
  upsertContact,
  upsertGroupContact,
  setContactPinned,
  clearMessagesByJid,
  deleteContactAndMessages,
  listMessagesByJid,
  saveStatus,
  deleteExpiredStatuses,
  getStatusById,
  type WaContactRow,
  type WaStatusType,
  type WaStatusRow,
} from "./whatsapp.repository.js";

export type WhatsAppStatus = "disconnected" | "connecting" | "qr_pending" | "connected";

const MAX_RECONNECT_DELAY_MS = 30_000;
const BASE_RECONNECT_DELAY_MS = 2_000;
const MEDIA_DIR = path.resolve("storage/whatsapp-media");
// Status/Stories somem depois de 24h no WhatsApp de verdade — a gente segue
// a mesma janela aqui pra decidir o que ainda mostrar na tirinha do painel.
const STATUS_TTL_MS = 24 * 60 * 60 * 1000;
// de quanto em quanto tempo varre wa_statuses procurando status vencido pra
// apagar (linha + arquivo de mídia no disco). Não precisa ser preciso ao
// segundo — só não pode deixar acumular mídia velha indefinidamente.
const STATUS_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

class WhatsAppService {
  private socket: WASocket | null = null;
  private status: WhatsAppStatus = "disconnected";
  private reconnectAttempts = 0;
  // guarda o último QR/número pra poder reenviar o estado atual a quem conectar depois do evento original
  private lastQr: string | null = null;
  private lastNumber: string | null = null;
  // cache em memória do nome (subject) de cada grupo já visto/sincronizado —
  // evita bater no groupMetadata do WhatsApp toda hora só pra exibir/gravar
  // o nome de um grupo que a gente já sabe
  private groupNameCache = new Map<string, string>();
  // evita agendar o setInterval de limpeza de status mais de uma vez —
  // start() pode rodar de novo em cada reconexão (queda de rede, logout etc.)
  private statusCleanupScheduled = false;

  getStatus(): WhatsAppStatus {
    return this.status;
  }

  // snapshot do estado atual — usado pra sincronizar clientes que se inscrevem
  // no canal "whatsapp" depois que o evento original já foi disparado
  getSnapshot(): { status: WhatsAppStatus; qr: string | null; number: string | null } {
    return { status: this.status, qr: this.lastQr, number: this.lastNumber };
  }

  async start(): Promise<void> {
    this.setStatus("connecting");

    // BUG corrigido aqui: se qualquer passo abaixo (ler o auth state, buscar
    // a versão do Baileys, ou criar o socket) lançasse uma exceção, ela
    // subia direto pra quem chamou start() (initWhatsApp, que só loga o
    // erro) e o status ficava PRESO em "connecting" pra sempre — nenhum
    // evento "connection.update" chegava a disparar pra corrigir isso,
    // porque o socket nem chegava a existir. Resultado: o painel via só o
    // spinner infinito ("Iniciando conexão...") e nunca tinha chance de
    // mostrar o QR code, "desconectado" ou qualquer botão. Agora qualquer
    // falha nessa etapa volta o status pra "disconnected" e agenda uma nova
    // tentativa, em vez de deixar o cliente sem saída.
    try {
      const sessionDir = path.resolve(env.WHATSAPP_SESSION_DIR);
      const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
      const { version } = await fetchLatestBaileysVersion();

      this.socket = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          // SEM isso, toda leitura/escrita de pre-key/sessão vai direto pro disco
          // (useMultiFileAuthState = 1 arquivo JSON por chave). Sob concorrência
          // (mensagens chegando perto uma da outra, retries do Baileys, etc.)
          // isso causa corrida de leitura/escrita nas chaves do Signal Protocol,
          // dessincroniza a sessão de criptografia e o destinatário passa a ver
          // "mensagem indisponível". Com o cache em memória por cima do store em disco,
          // as leituras ficam consistentes durante o ciclo de vida da conexão.
          keys: makeCacheableSignalKeyStore(state.keys, logger.child({ module: "baileys-keys" }) as never),
        },
        // baileys tem logger próprio (pino-like); reaproveita o logger do app
        logger: logger.child({ module: "baileys" }) as never,
        printQRInTerminal: false,
        syncFullHistory: false,
      });

      this.socket.ev.on("creds.update", saveCreds);
      this.socket.ev.on("connection.update", (update) => this.handleConnectionUpdate(update));
      this.socket.ev.on("messages.upsert", (upsert) => {
        void this.handleIncomingMessages(upsert as { messages: WAMessage[]; type: string });
      });
      // "messaging-history.set" é o que o Baileys manda logo depois de
      // conectar, com o que foi perdido enquanto o servidor estava
      // desligado — sem isso, ligar o servidor de novo não recuperava
      // mensagens recebidas nesse intervalo (só as que chegassem DALI PRA
      // FRENTE, via messages.upsert).
      this.socket.ev.on("messaging-history.set", (payload) => {
        void this.handleHistorySync(payload as { messages?: WAMessage[] });
      });

      if (!this.statusCleanupScheduled) {
        this.statusCleanupScheduled = true;
        this.cleanupExpiredStatuses(); // já limpa uma vez ao subir, sem esperar o primeiro tick
        setInterval(() => this.cleanupExpiredStatuses(), STATUS_CLEANUP_INTERVAL_MS).unref();
      }
    } catch (err) {
      logger.error({ err }, "falha ao iniciar sessão do WhatsApp — tentando de novo em breve");
      this.setStatus("disconnected");
      this.scheduleReconnect();
    }
  }

  // envia uma mensagem de texto simples pro jid informado — valida antes que o
  // número realmente existe no WhatsApp (evita "enviei" falso positivo quando
  // o JID é inválido/mal formatado, ex: sem código do país)
  async sendText(jid: string, text: string): Promise<void> {
    if (!this.socket || this.status !== "connected") {
      throw new Error("WhatsApp não está conectado");
    }

    const resolvedJid = await this.verifyJidExists(jid);
    const sent = await this.socket.sendMessage(resolvedJid, { text });
    this.persistOutgoingMessage(resolvedJid, sent, { type: "text", text });
  }

  // confirma no próprio WhatsApp que o número existe antes de mandar — o
  // Baileys aceita sendMessage pra qualquer JID sem erro, mesmo que o número
  // não exista ou esteja sem o código do país, e a mensagem simplesmente
  // desaparece sem avisar ninguém.
  private async verifyJidExists(jid: string): Promise<string> {
    // JIDs @lid (Linked ID) não são números de telefone — são um identificador
    // interno que o próprio WhatsApp já validou ao entregar a mensagem original.
    // Rodar onWhatsApp() na parte numérica de um @lid sempre falha, porque essa
    // consulta só entende números de telefone reais. Como o jid já veio de uma
    // troca de mensagens de verdade, ele é confiável por definição — pula a
    // verificação e usa direto.
    if (jid.endsWith("@lid")) {
      return jid;
    }

    // grupos (@g.us) não são números de telefone — onWhatsApp() só entende
    // números individuais e sempre falharia aqui. Um jid de grupo só chega
    // até este método vindo de resolveContact/wa_contacts (grupo real, já
    // visto ou sincronizado), então é confiável por definição.
    if (jid.endsWith("@g.us")) {
      return jid;
    }

    const [number] = jid.split("@");
    const results = await this.socket!.onWhatsApp(number);
    const match = results?.find((r) => r.exists);

    if (!match) {
      throw new Error(`O número ${number} não tem WhatsApp ou está incorreto`);
    }

    return match.jid; // JID canônico devolvido pelo próprio WhatsApp
  }

  // envia um áudio como mensagem de voz (ptt) — usado tanto pro áudio gerado
  // por TTS (voz do Ley) quanto pro áudio gravado pelo usuário no painel
  async sendAudio(jid: string, audio: Buffer, mimetype = "audio/ogg; codecs=opus"): Promise<void> {
    if (!this.socket || this.status !== "connected") {
      throw new Error("WhatsApp não está conectado");
    }
    const resolvedJid = await this.verifyJidExists(jid);
    const sent = await this.socket.sendMessage(resolvedJid, { audio, mimetype, ptt: true });

    // salva uma cópia do próprio buffer que já temos em mãos — não depende
    // de baixar de volta do WhatsApp, então funciona mesmo quando o Baileys
    // não reemite o envio de mídia/ptt como evento de mensagem
    let mediaPath: string | null = null;
    try {
      fs.mkdirSync(MEDIA_DIR, { recursive: true });
      mediaPath = path.join(MEDIA_DIR, `${sent?.key?.id ?? randomUUID()}.ogg`);
      fs.writeFileSync(mediaPath, audio);
    } catch (err) {
      logger.error({ err }, "falha ao salvar cópia local do áudio enviado");
    }

    this.persistOutgoingMessage(resolvedJid, sent, {
      type: "audio",
      mediaPath,
      mediaMimetype: mimetype,
    });
  }

  // salva no banco a mensagem que a própria Ley acabou de mandar (texto ou
  // áudio) e avisa o painel em tempo real via websocket.
  //
  // BUG corrigido aqui: sendText/sendAudio só chamavam socket.sendMessage()
  // e confiavam que o Baileys ia reemitir esse envio como um evento
  // "messages.upsert" (que é o único lugar, em handleIncomingMessages, onde
  // saveMessage() era chamado). Isso não é garantido — principalmente pra
  // mídia/ptt — então a mensagem saía de verdade no WhatsApp (o contato
  // recebia e podia responder normal) mas nunca ficava salva no banco local,
  // e por isso nunca aparecia na conversa do painel. saveMessage já é
  // idempotente (ON CONFLICT(id) DO NOTHING), então não tem problema se o
  // Baileys também emitir esse mesmo id depois por conta própria.
  private persistOutgoingMessage(
    jid: string,
    sent: WAMessage | undefined,
    extra: {
      type: "text" | "audio" | "other";
      text?: string;
      mediaPath?: string | null;
      mediaMimetype?: string | null;
    }
  ): void {
    const id = sent?.key?.id;
    if (!id) {
      logger.warn(
        { jid },
        "envio sem key.id retornado pelo Baileys — mensagem não será salva na conversa do painel"
      );
      return;
    }

    const createdAt =
      typeof sent?.messageTimestamp === "number" ? sent.messageTimestamp * 1000 : Date.now();

    const row = {
      id,
      jid,
      from_me: 1,
      sender_name: null,
      type: extra.type,
      text: extra.text ?? null,
      transcript: null,
      media_path: extra.mediaPath ?? null,
      media_mimetype: extra.mediaMimetype ?? null,
      created_at: createdAt,
    };

    saveMessage(row);
    wsHub.broadcast("whatsapp", "message", { ...row, seen: 1 });
  }

  // busca tolerante por nome entre os contatos já vistos/memorizados. Se não
  // achar por nome e a query parecer um número de telefone (com DDD/DDI),
  // monta o JID direto — assim dá pra mandar mensagem pra alguém que o Ley
  // nunca viu conversar, só com o número.
  resolveContact(query: string): WaContactRow | null {
    const byName = findContactByName(query);
    if (byName) return byName;

    const jid = phoneQueryToJid(query);
    if (jid) return { jid, name: null, updated_at: Date.now() };

    return null;
  }

  // memoriza um contato (nome + número) pra próxima vez o usuário poder
  // chamar só pelo nome.
  //
  // Retorna a linha realmente persistida (confirmada por leitura pós-escrita
  // em saveContactRow) ou lança erro. Quem chama NUNCA deve avisar o usuário
  // que "salvou" antes de dar await aqui e confirmar que não caiu no catch.
  async saveContact(name: string, jid: string): Promise<WaContactRow> {
    try {
      const persisted = saveContactRow(name, jid);
      logger.info({ jid, name }, "contato salvo e confirmado no banco");
      return persisted;
    } catch (err) {
      logger.error({ err, jid, name }, "falha ao salvar contato — escrita não confirmada no banco");
      throw err;
    }
  }

  // busca (via Baileys) todos os grupos que a conta participa e grava o nome
  // de cada um em wa_contacts — chamado ao conectar e também usado como
  // fallback pontual quando chega mensagem de um grupo que ainda não tá no
  // cache/banco.
  async syncGroups(): Promise<void> {
    if (!this.socket) return;
    try {
      const groups = await this.socket.groupFetchAllParticipating();
      for (const jid of Object.keys(groups)) {
        const subject = groups[jid]?.subject ?? null;
        if (!subject) continue;
        this.groupNameCache.set(jid, subject);
        upsertGroupContact(jid, subject);
      }
      logger.info({ count: Object.keys(groups).length }, "grupos do WhatsApp sincronizados");
    } catch (err) {
      logger.error({ err }, "falha ao sincronizar lista de grupos do WhatsApp");
    }
  }

  // resolve o nome de um grupo específico (cache -> banco -> Baileys ao
  // vivo) — usado quando chega mensagem de um grupo que ainda não foi
  // sincronizado (ex: grupo novo, ou a Ley entrou nele depois do último sync)
  private async resolveGroupName(jid: string): Promise<string | null> {
    const cached = this.groupNameCache.get(jid);
    if (cached) return cached;

    if (!this.socket) return null;
    try {
      const metadata = await this.socket.groupMetadata(jid);
      const subject = metadata?.subject ?? null;
      if (subject) {
        this.groupNameCache.set(jid, subject);
        upsertGroupContact(jid, subject);
      }
      return subject;
    } catch (err) {
      logger.error({ err, jid }, "falha ao buscar nome do grupo no WhatsApp");
      return null;
    }
  }

  // envia um arquivo (documento, imagem ou vídeo) pro jid informado — usado
  // tanto pra conversas normais quanto pra grupos. Decide o tipo de mensagem
  // pelo mimetype: imagem/vídeo viram mídia "de verdade" (aparecem como foto/
  // vídeo no WhatsApp, com preview), qualquer outro tipo vira documento.
  async sendFile(
    jid: string,
    file: Buffer,
    filename: string,
    mimetype = "application/octet-stream",
    caption?: string
  ): Promise<void> {
    if (!this.socket || this.status !== "connected") {
      throw new Error("WhatsApp não está conectado");
    }

    const resolvedJid = await this.verifyJidExists(jid);

    const sent = mimetype.startsWith("image/")
      ? await this.socket.sendMessage(resolvedJid, { image: file, mimetype, caption })
      : mimetype.startsWith("video/")
        ? await this.socket.sendMessage(resolvedJid, { video: file, mimetype, caption })
        : await this.socket.sendMessage(resolvedJid, {
            document: file,
            fileName: filename,
            mimetype,
            caption,
          });

    // mesmo princípio do sendAudio: guarda uma cópia local do próprio buffer
    // que já temos em mãos, não depende de reemissão de evento pelo Baileys
    let mediaPath: string | null = null;
    try {
      fs.mkdirSync(MEDIA_DIR, { recursive: true });
      const ext = path.extname(filename) || "";
      mediaPath = path.join(MEDIA_DIR, `${sent?.key?.id ?? randomUUID()}${ext}`);
      fs.writeFileSync(mediaPath, file);
    } catch (err) {
      logger.error({ err }, "falha ao salvar cópia local do arquivo enviado");
    }

    this.persistOutgoingMessage(resolvedJid, sent, {
      type: "other",
      text: filename,
      mediaPath,
      mediaMimetype: mimetype,
    });
  }

  // avisa o painel (via websocket) que uma conversa/grupo específico deve ser
  // aberto na tela — usado quando o usuário pede pra Ley "abrir" uma conversa
  // ou grupo pelo chat/voz.
  broadcastOpenConversation(jid: string, name: string | null): void {
    wsHub.broadcast("whatsapp", "open_conversation", { jid, name });
  }

  // cria um grupo novo com o nome e os participantes informados (jids já
  // resolvidos por quem chama, via resolveContact). O jid do grupo criado
  // vem do próprio WhatsApp (result.id) — não dá pra prever antes de criar.
  async createGroup(subject: string, participantJids: string[]): Promise<{ jid: string; subject: string }> {
    if (!this.socket || this.status !== "connected") {
      throw new Error("WhatsApp não está conectado");
    }
    if (participantJids.length === 0) {
      throw new Error("informe pelo menos um participante pra criar o grupo");
    }

    const result = await this.socket.groupCreate(subject, participantJids);
    const jid = result.id;

    this.groupNameCache.set(jid, subject);
    upsertGroupContact(jid, subject);
    wsHub.broadcast("whatsapp", "group_created", { jid, subject });

    return { jid, subject };
  }

  // bloqueia/desbloqueia um contato — depois de bloqueado, o contato não
  // consegue mandar mensagem/áudio (o WhatsApp barra do lado dele).
  async setBlockStatus(jid: string, block: boolean): Promise<void> {
    if (!this.socket || this.status !== "connected") {
      throw new Error("WhatsApp não está conectado");
    }

    const resolvedJid = await this.verifyJidExists(jid);
    await this.socket.updateBlockStatus(resolvedJid, block ? "block" : "unblock");
    wsHub.broadcast("whatsapp", "block_status", { jid: resolvedJid, blocked: block });
  }

  // fixa/desafixa uma conversa ou grupo. O espelhamento no app oficial do
  // WhatsApp é best-effort (o Baileys não garante sincronizar isso em todo
  // dispositivo) — o que é garantido é o estado aqui no painel da Ley, que é
  // o que decide a ordem da lista (fixados primeiro).
  async pinChat(jid: string, pinned: boolean): Promise<void> {
    const resolvedJid = jid.includes("@") ? jid : (await this.verifyJidExists(jid));

    if (this.socket && this.status === "connected") {
      try {
        await this.socket.chatModify({ pin: pinned }, resolvedJid);
      } catch (err) {
        logger.error({ err, jid: resolvedJid }, "falha ao espelhar fixar/desafixar no WhatsApp (segue só localmente)");
      }
    }

    setContactPinned(resolvedJid, pinned);
    wsHub.broadcast("whatsapp", "chat_pinned", { jid: resolvedJid, pinned });
  }

  // apaga todo o histórico de uma conversa/grupo aqui no painel (mantém o
  // contato). O apagar "de verdade" no WhatsApp também é tentado, mas como
  // best-effort — sem o histórico completo sincronizado (o Baileys não
  // mantém isso por padrão), o WhatsApp pode ignorar o pedido do lado dele.
  async clearChat(jid: string): Promise<void> {
    const resolvedJid = jid.includes("@") ? jid : (await this.verifyJidExists(jid));

    if (this.socket && this.status === "connected") {
      try {
        await this.socket.chatModify({ clear: true, lastMessages: this.lastMessagesFor(resolvedJid) }, resolvedJid);
      } catch (err) {
        logger.error({ err, jid: resolvedJid }, "falha ao espelhar limpeza de conversa no WhatsApp (segue só localmente)");
      }
    }

    clearMessagesByJid(resolvedJid);
    wsHub.broadcast("whatsapp", "chat_cleared", { jid: resolvedJid });
  }

  // remove a conversa/grupo inteiro daqui (contato + mensagens). Igual ao
  // clearChat, o "excluir" espelhado no WhatsApp é best-effort.
  async deleteChat(jid: string): Promise<void> {
    const resolvedJid = jid.includes("@") ? jid : (await this.verifyJidExists(jid));

    if (this.socket && this.status === "connected") {
      try {
        await this.socket.chatModify({ delete: true, lastMessages: this.lastMessagesFor(resolvedJid) }, resolvedJid);
      } catch (err) {
        logger.error({ err, jid: resolvedJid }, "falha ao espelhar exclusão de conversa no WhatsApp (segue só localmente)");
      }
    }

    deleteContactAndMessages(resolvedJid);
    wsHub.broadcast("whatsapp", "chat_deleted", { jid: resolvedJid });
  }

  // monta o "lastMessages" que o Baileys pede pra clear/delete — só a última
  // mensagem que a gente já tem salva localmente da conversa (formato mínimo:
  // key + timestamp). Se não tiver nenhuma, manda vazio: a limpeza local
  // continua valendo, só o espelhamento no WhatsApp que pode não ter efeito.
  private lastMessagesFor(jid: string) {
    const [last] = listMessagesByJid(jid, 1);
    if (!last) return [];
    return [
      {
        key: { remoteJid: jid, id: last.id, fromMe: !!last.from_me },
        messageTimestamp: Math.floor(last.created_at / 1000),
      },
    ];
  }

  // liga/desliga o "digitando..." pra uma conversa — usado pelo autopilot
  // pra parecer mais natural antes de mandar a resposta gerada. Não crítico:
  // qualquer erro aqui é só logado, nunca deve travar o envio da mensagem.
  async setPresence(jid: string, state: "composing" | "paused"): Promise<void> {
    if (!this.socket || this.status !== "connected") return;
    try {
      await this.socket.sendPresenceUpdate(state, jid);
    } catch (err) {
      logger.error({ err, jid }, "falha ao atualizar presença (digitando) no WhatsApp");
    }
  }

  private async handleConnectionUpdate(
    update: Partial<{
      connection: "close" | "connecting" | "open";
      qr: string;
      lastDisconnect: { error: unknown };
    }>
  ): Promise<void> {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      this.setStatus("qr_pending");
      try {
        const qrDataUrl = await QRCode.toDataURL(qr);
        this.lastQr = qrDataUrl;
        wsHub.broadcast("whatsapp", "qr", { qr: qrDataUrl });
        logger.info("QR Code do WhatsApp gerado e enviado ao painel");
      } catch (err) {
        logger.error({ err }, "falha ao converter QR Code para base64");
      }
      return;
    }

    if (connection === "open") {
      this.reconnectAttempts = 0;
      this.lastQr = null;
      this.lastNumber = this.socket?.user?.id?.split(":")[0] ?? null;
      this.setStatus("connected");
      wsHub.broadcast("whatsapp", "connected", { number: this.lastNumber });
      logger.info("WhatsApp conectado com sucesso");

      // busca todos os grupos que o número participa e grava o nome (subject)
      // de cada um em wa_contacts — sem isso, a Ley só "conhece" o nome de um
      // grupo depois que chega mensagem nele, e mesmo assim gravava errado
      // (usava o pushName de quem mandou em vez do nome do grupo)
      void this.syncGroups();
      return;
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      this.setStatus("disconnected");

      if (loggedOut) {
        logger.warn("sessão do WhatsApp encerrada (logout) — apagando sessão local e gerando novo QR");
        this.reconnectAttempts = 0;
        this.lastQr = null;
        this.lastNumber = null;
        wsHub.broadcast("whatsapp", "logged_out", null);

        // a sessão salva ficou inválida (ex: dispositivo removido pelo WhatsApp) —
        // reusar esses arquivos só repete o mesmo erro em loop. Apaga e começa
        // do zero, o que força o Baileys a gerar um QR novo pra escanear.
        try {
          const sessionDir = path.resolve(env.WHATSAPP_SESSION_DIR);
          fs.rmSync(sessionDir, { recursive: true, force: true });
        } catch (err) {
          logger.error({ err }, "falha ao limpar sessão antiga do WhatsApp");
        }

        setTimeout(() => {
          this.start().catch((err) => logger.error({ err }, "falha ao reiniciar sessão do WhatsApp após logout"));
        }, 1_000).unref();
        return;
      }

      this.scheduleReconnect();
    }
  }

  // processa mensagens novas recebidas/enviadas em tempo real. "notify" é o
  // único tipo que representa mensagens realmente novas — outros tipos
  // (ex: "append") aparecem em sincronizações de histórico que não queremos processar aqui.
  private async handleIncomingMessages({
    messages,
    type,
  }: {
    messages: WAMessage[];
    type: string;
  }): Promise<void> {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        await this.processMessage(msg);
      } catch (err) {
        logger.error({ err }, "falha ao processar mensagem recebida do WhatsApp");
      }
    }
  }

  private async processMessage(msg: WAMessage): Promise<void> {
    const persisted = await this.persistIncomingMessage(msg);
    if (!persisted || persisted.fromMe) return;

    logger.info({ jid: persisted.jid, type: persisted.type }, "nova mensagem do WhatsApp recebida");

    // import dinâmico pra não criar dependência circular estática entre
    // whatsapp/ (esse arquivo) e llm/ (que já importa whatsappService) —
    // nesse ponto do fluxo os dois módulos já estão totalmente carregados,
    // então isso resolve na hora, sem custo perceptível.
    try {
      const { handleIncomingAutopilot } = await import("../llm/whatsapp-autopilot.js");
      handleIncomingAutopilot(persisted.jid, persisted.isGroup, persisted.textForGate);
    } catch (err) {
      logger.error({ err, jid: persisted.jid }, "falha ao acionar o autopilot de WhatsApp");
    }
  }

  // mesma lógica de processMessage, mas SEM NUNCA acionar o autopilot — usado
  // só pra "recuperar o atraso" de mensagens recebidas enquanto o servidor
  // estava desligado (ver handleHistorySync). Responder sozinha a uma
  // mensagem de horas atrás, fora de contexto, seria um comportamento bem
  // estranho — isso aqui só persiste no banco pra aparecer como não lida.
  private async processHistoryMessage(msg: WAMessage): Promise<void> {
    await this.persistIncomingMessage(msg);
  }

  // faz o trabalho de verdade: valida, baixa/transcreve áudio se for o caso,
  // e salva a linha em wa_messages. Devolve os dados que quem chamou precisa
  // pra decidir sobre autopilot (ou null quando a mensagem foi ignorada:
  // broadcast, mensagem de protocolo, tipo ainda não suportado).
  private async persistIncomingMessage(
    msg: WAMessage
  ): Promise<{ jid: string; isGroup: boolean; fromMe: boolean; type: "text" | "audio" | "other"; textForGate: string | null } | null> {
    const jid = msg.key.remoteJid;

    // status@broadcast é o "canal" especial que o Baileys usa pra atualizações
    // de Status (as postagens de 24h) — não é uma conversa de verdade, então
    // nunca deve virar uma linha em wa_messages. Antes isso era só ignorado
    // (return null); agora é desviado pro handler que salva em wa_statuses e
    // alimenta a tirinha de Status do painel.
    if (jid === "status@broadcast") {
      void this.persistStatusUpdate(msg);
      return null;
    }
    if (!jid) return null;
    if (!msg.message) return null; // mensagens de protocolo (reação, exclusão, recibo etc.)

    const fromMe = !!msg.key.fromMe;
    const id = msg.key.id ?? randomUUID();
    const senderName = msg.pushName ?? null;
    const isGroup = jid.endsWith("@g.us");

    // BUG corrigido aqui: pra mensagens de grupo, isso gravava o pushName de
    // QUEM MANDOU a mensagem como se fosse o nome do grupo (upsertContact
    // normal), então grupo nunca tinha nome de grupo salvo — buscar por nome
    // de grupo (pra mandar msg/áudio/arquivo ou abrir a conversa) nunca
    // achava nada. Agora grupo usa o subject real (via resolveGroupName,
    // com cache) e pessoa continua usando o pushName normalmente.
    if (isGroup) {
      void this.resolveGroupName(jid);
    } else if (!fromMe) {
      upsertContact(jid, senderName);
    }

    const content = msg.message;
    const audioMessage = content.audioMessage;
    const textBody =
      content.conversation ??
      content.extendedTextMessage?.text ??
      content.imageMessage?.caption ??
      content.videoMessage?.caption ??
      null;

    let type: "text" | "audio" | "other" = "other";
    let text: string | null = null;
    let transcript: string | null = null;
    let mediaPath: string | null = null;
    let mediaMimetype: string | null = null;

    if (audioMessage) {
      type = "audio";
      mediaMimetype = audioMessage.mimetype ?? "audio/ogg";

      try {
        const buffer = (await downloadMediaMessage(
          msg,
          "buffer",
          {},
          {
            logger: logger.child({ module: "baileys-media" }) as never,
            reuploadRequest: this.socket!.updateMediaMessage,
          }
        )) as Buffer;

        fs.mkdirSync(MEDIA_DIR, { recursive: true });
        const filePath = path.join(MEDIA_DIR, `${id}.ogg`);
        fs.writeFileSync(filePath, buffer);
        mediaPath = filePath;

        // não travamos o salvamento da mensagem esperando a transcrição —
        // se der erro, a mensagem ainda fica salva (só sem transcript)
        transcript = await transcribeAudioFile(filePath);
      } catch (err) {
        logger.error({ err }, "falha ao baixar/transcrever áudio recebido do WhatsApp");
      }
    } else if (content.imageMessage || content.videoMessage) {
      // Foto/vídeo recebido (de conversa ou de grupo). Antes disso, uma
      // imagem/vídeo COM legenda virava só uma mensagem de texto (a legenda)
      // e o arquivo em si nunca era baixado — "sumia". Agora baixa o arquivo
      // de verdade e guarda como 'other' + media_path, que é o mesmo formato
      // que o front-end (WhatsAppTab) já sabe renderizar como miniatura/
      // player (ver renderMessageBody), igual mídia enviada por nós.
      type = "other";
      const isVideo = !!content.videoMessage;
      mediaMimetype = (isVideo ? content.videoMessage?.mimetype : content.imageMessage?.mimetype) ?? (isVideo ? "video/mp4" : "image/jpeg");
      text = textBody ?? (isVideo ? "Vídeo" : "Foto");

      try {
        const buffer = (await downloadMediaMessage(
          msg,
          "buffer",
          {},
          {
            logger: logger.child({ module: "baileys-media" }) as never,
            reuploadRequest: this.socket!.updateMediaMessage,
          }
        )) as Buffer;

        const ext = mediaMimetype.split("/")[1]?.split(";")[0] ?? (isVideo ? "mp4" : "jpg");
        fs.mkdirSync(MEDIA_DIR, { recursive: true });
        const filePath = path.join(MEDIA_DIR, `${id}.${ext}`);
        fs.writeFileSync(filePath, buffer);
        mediaPath = filePath;
      } catch (err) {
        logger.error({ err }, "falha ao baixar imagem/vídeo recebido do WhatsApp");
      }
    } else if (textBody) {
      type = "text";
      text = textBody;
    } else {
      return null; // tipo de mensagem ainda não suportado (figurinha, documento etc.) — ignora por ora
    }

    const createdAt =
      typeof msg.messageTimestamp === "number" ? msg.messageTimestamp * 1000 : Date.now();

    const row = {
      id,
      jid,
      from_me: fromMe ? 1 : 0,
      sender_name: senderName,
      type,
      text,
      transcript,
      media_path: mediaPath,
      media_mimetype: mediaMimetype,
      created_at: createdAt,
    };

    saveMessage(row);

    wsHub.broadcast("whatsapp", "message", { ...row, seen: fromMe ? 1 : 0 });

    return { jid, isGroup, fromMe, type, textForGate: type === "audio" ? transcript : text };
  }

  // salva uma atualização de Status (foto, vídeo ou texto) chegada via
  // status@broadcast. "quem postou" vem de key.participant — em
  // status@broadcast o remoteJid é sempre o pseudo-jid do canal, nunca a
  // pessoa; participant é o jid real do contato dono do status.
  private async persistStatusUpdate(msg: WAMessage): Promise<void> {
    const posterJid = msg.key.participant ?? msg.key.remoteJid;
    if (!posterJid || !msg.message) return;

    const id = msg.key.id ?? randomUUID();
    const senderName = msg.pushName ?? null;
    const content = msg.message;

    // um status recebido de alguém que a Ley nunca tinha visto ainda salva o
    // contato aqui — sem isso o nome não aparece na tirinha, só o número.
    if (!posterJid.endsWith("@g.us")) upsertContact(posterJid, senderName);

    let type: WaStatusType = "text";
    let text: string | null = null;
    let bgColor: string | null = null;
    let mediaPath: string | null = null;
    let mediaMimetype: string | null = null;

    if (content.imageMessage || content.videoMessage) {
      const isVideo = !!content.videoMessage;
      type = isVideo ? "video" : "image";
      mediaMimetype =
        (isVideo ? content.videoMessage?.mimetype : content.imageMessage?.mimetype) ??
        (isVideo ? "video/mp4" : "image/jpeg");
      text = content.imageMessage?.caption ?? content.videoMessage?.caption ?? null;

      try {
        const buffer = (await downloadMediaMessage(
          msg,
          "buffer",
          {},
          {
            logger: logger.child({ module: "baileys-media" }) as never,
            reuploadRequest: this.socket!.updateMediaMessage,
          }
        )) as Buffer;

        const ext = mediaMimetype.split("/")[1]?.split(";")[0] ?? (isVideo ? "mp4" : "jpg");
        fs.mkdirSync(MEDIA_DIR, { recursive: true });
        // prefixo "status-" pra nunca colidir com o arquivo de uma mensagem
        // normal que por acaso tenha o mesmo id
        const filePath = path.join(MEDIA_DIR, `status-${id}.${ext}`);
        fs.writeFileSync(filePath, buffer);
        mediaPath = filePath;
      } catch (err) {
        logger.error({ err }, "falha ao baixar mídia de Status do WhatsApp");
        return; // sem a mídia baixada, não vale a pena salvar um status de foto/vídeo quebrado
      }
    } else if (content.extendedTextMessage?.text) {
      // status de "aa" (só texto com fundo colorido) — o Baileys expõe a cor
      // de fundo escolhida pela pessoa em backgroundColor (ARGB hex)
      type = "text";
      text = content.extendedTextMessage.text;
      // vem como int32 ARGB (ex: -12345678); os 6 dígitos hex de menor ordem
      // já são o RGB puro (o byte de alfa mais significativo é descartado),
      // que é exatamente o que o CSS "#rrggbb" do front-end espera.
      const argb = content.extendedTextMessage.backgroundArgb;
      bgColor = typeof argb === "number" ? `#${(argb >>> 0).toString(16).padStart(8, "0").slice(2)}` : null;
    } else {
      return; // tipo de status ainda não suportado (ex: enquete) — ignora por ora
    }

    const createdAt =
      typeof msg.messageTimestamp === "number" ? msg.messageTimestamp * 1000 : Date.now();

    const row = {
      id,
      jid: posterJid,
      sender_name: senderName,
      type,
      text,
      bg_color: bgColor,
      media_path: mediaPath,
      media_mimetype: mediaMimetype,
      created_at: createdAt,
      expires_at: createdAt + STATUS_TTL_MS,
    };

    saveStatus(row);
    wsHub.broadcast("whatsapp", "wa_status", { ...row, seen: 0 });
  }

  // responde a um status: no WhatsApp de verdade isso vira uma mensagem
  // DIRETA pro dono do status (nunca pública), citando o status como
  // contexto — é exatamente esse o comportamento que replicamos aqui.
  // Como o Baileys não guarda o WAMessage bruto do status (só processamos
  // ele pra salvar em wa_statuses e descartamos o original), reconstruímos
  // um "quoted" mínimo a partir do que temos salvo: é o suficiente pra
  // sendMessage anexar o stanzaId/participant certos na contextInfo, que é
  // o que faz o WhatsApp do outro lado mostrar "respondeu ao seu status".
  async replyToStatus(statusId: string, text: string): Promise<void> {
    if (!this.socket || this.status !== "connected") {
      throw new Error("WhatsApp não está conectado");
    }

    const status = getStatusById(statusId);
    if (!status) {
      throw new Error("status não encontrado (pode já ter expirado)");
    }

    const resolvedJid = await this.verifyJidExists(status.jid);

    const quoted = {
      key: {
        remoteJid: "status@broadcast",
        id: status.id,
        participant: status.jid,
        fromMe: false,
      },
      message: this.buildQuotedStatusMessage(status),
      messageTimestamp: Math.floor(status.created_at / 1000),
    } as unknown as WAMessage;

    const sent = await this.socket.sendMessage(resolvedJid, { text }, { quoted });
    this.persistOutgoingMessage(resolvedJid, sent, { type: "text", text });
  }

  // conteúdo mínimo do "quoted" pro reply de status, no formato de cada
  // tipo — só o suficiente pra contextInfo ficar coerente; não precisa dos
  // metadados completos de mídia (chave, sha256 etc.) porque não estamos
  // reenviando esse conteúdo, só referenciando o id original.
  private buildQuotedStatusMessage(status: WaStatusRow): Record<string, unknown> {
    if (status.type === "image") {
      return { imageMessage: { caption: status.text ?? undefined, mimetype: status.media_mimetype ?? "image/jpeg" } };
    }
    if (status.type === "video") {
      return { videoMessage: { caption: status.text ?? undefined, mimetype: status.media_mimetype ?? "video/mp4" } };
    }
    return { extendedTextMessage: { text: status.text ?? "" } };
  }

  // varre wa_statuses por status vencidos (>24h), apaga o arquivo de mídia
  // de cada um no disco (se houver) e depois a(s) linha(s) do banco.
  private cleanupExpiredStatuses(): void {
    try {
      const expired = deleteExpiredStatuses();
      for (const status of expired) {
        if (status.media_path) {
          fs.rm(status.media_path, { force: true }, (err) => {
            if (err) logger.error({ err, path: status.media_path }, "falha ao apagar mídia de status vencido");
          });
        }
      }
      if (expired.length > 0) {
        wsHub.broadcast("whatsapp", "wa_status_expired", { ids: expired.map((s) => s.id) });
      }
    } catch (err) {
      logger.error({ err }, "falha ao limpar status vencidos");
    }
  }

  // só processa mensagens de até 3 dias atrás — o suficiente pra cobrir "o
  // servidor ficou desligado o fim de semana todo", sem sair reprocessando
  // meses de histórico antigo toda vez que reconecta.
  private static readonly HISTORY_BACKFILL_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

  private async handleHistorySync({ messages }: { messages?: WAMessage[] }): Promise<void> {
    if (!messages || messages.length === 0) return;

    const cutoff = Date.now() - WhatsAppService.HISTORY_BACKFILL_MAX_AGE_MS;
    let recovered = 0;

    for (const msg of messages) {
      const ts = typeof msg.messageTimestamp === "number" ? msg.messageTimestamp * 1000 : 0;
      if (ts < cutoff) continue;

      try {
        await this.processHistoryMessage(msg);
        recovered++;
      } catch (err) {
        logger.error({ err }, "falha ao recuperar mensagem do histórico do WhatsApp");
      }
    }

    if (recovered > 0) {
      logger.info({ recovered }, "mensagens recuperadas do histórico após reconectar ao WhatsApp");
    }
  }

  private scheduleReconnect(): void {
    const delayMs = Math.min(
      MAX_RECONNECT_DELAY_MS,
      BASE_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempts
    );
    this.reconnectAttempts += 1;

    logger.warn(
      { delayMs, attempt: this.reconnectAttempts },
      "conexão com o WhatsApp caiu — tentando reconectar"
    );

    setTimeout(() => {
      this.start().catch((err) => logger.error({ err }, "falha ao reconectar ao WhatsApp"));
    }, delayMs).unref();
  }

  private setStatus(status: WhatsAppStatus): void {
    this.status = status;
    wsHub.broadcast("whatsapp", "status", { status });
  }
}

// reconhece se a query já é um número de telefone (com ou sem +, espaços,
// parênteses, traços) e monta o JID direto no formato que o WhatsApp usa.
// Exige que, tirando esses caracteres de formatação, sobrem só dígitos —
// isso evita casar nomes de pessoas por engano.
//
// Números brasileiros digitados sem DDI (ex: "11911323274", 10 ou 11 dígitos
// = DDD + número) recebem o prefixo 55 automaticamente — sem isso o Baileys
// aceita o envio pra um JID que não existe e a mensagem some sem erro nenhum.
export function phoneQueryToJid(query: string): string | null {
  const stripped = query.trim().replace(/^\+/, "").replace(/[\s().-]/g, "");
  if (!/^\d{8,15}$/.test(stripped)) return null;

  const withCountryCode =
    (stripped.length === 10 || stripped.length === 11) && !stripped.startsWith("55")
      ? `55${stripped}`
      : stripped;

  return `${withCountryCode}@s.whatsapp.net`;
}

export const whatsappService = new WhatsAppService();
