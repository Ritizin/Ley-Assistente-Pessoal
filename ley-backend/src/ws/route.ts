import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { WsChannel } from "./hub.js";
import { wsHub } from "./hub.js";
import { processChatMessage } from "../modules/llm/index.js";
import { whatsappService } from "../modules/whatsapp/index.js";
import { gmailService } from "../modules/gmail/index.js";
import { spotifyService } from "../modules/spotify/index.js";
import { instagramService } from "../modules/instagram/index.js";
import { googleHomeService } from "../modules/google-home/index.js";

// BUG encontrado: essa lista estava sem "spotify", "instagram" e "google-home"
// mesmo esses fazendo parte do tipo WsChannel. Resultado: nenhum socket nunca
// se inscrevia nesses 3 canais (nem o painel-geral "assina tudo", nem uma
// conexão dedicada com ?channel=spotify) — então wsHub.broadcast("spotify", ...)
// e os equivalentes de instagram/google-home simplesmente não tinham nenhum
// socket ouvindo e a mensagem se perdia. As abas correspondentes no painel
// nunca recebiam atualização em tempo real (status, faixa tocando, dispositivos).
const VALID_CHANNELS: WsChannel[] = [
  "logs",
  "whatsapp",
  "chat",
  "gmail",
  "system",
  "spotify",
  "instagram",
  "google-home",
];

export async function wsRoutes(app: FastifyInstance): Promise<void> {
  // conexão simples (usada pelo painel): ws://host/ws — recebe TODOS os canais
  // conexão dedicada (opcional): ws://host/ws?channel=whatsapp — recebe só um
  app.get("/ws", { websocket: true }, (socket, req) => {
    const channelParam = (req.query as Record<string, string>)?.channel;
    const channels: WsChannel[] = VALID_CHANNELS.includes(channelParam as WsChannel)
      ? [channelParam as WsChannel]
      : VALID_CHANNELS; // sem parâmetro -> assina tudo (painel é single-user)

    for (const channel of channels) wsHub.subscribe(channel, socket);
    socket.send(JSON.stringify({ channel: "system", event: "connected", payload: null, ts: Date.now() }));

    // broadcast() só alcança quem já está inscrito no momento do evento; sem isso,
    // um cliente que conecta DEPOIS do WhatsApp/Gmail já terem mudado de estado
    // nunca recebe status/qr e a aba correspondente fica presa em "carregando" pra sempre.
    // então sincronizamos o estado atual assim que o cliente se inscreve em cada canal.
    if (channels.includes("whatsapp")) sendWhatsAppSnapshot(socket);
    if (channels.includes("gmail")) sendGmailSnapshot(socket);
    if (channels.includes("spotify")) sendSpotifySnapshot(socket);
    if (channels.includes("instagram")) sendInstagramSnapshot(socket);
    if (channels.includes("google-home")) sendGoogleHomeSnapshot(socket);

    socket.on("message", (raw) => {
      handleChatSocketMessage(app, socket, raw.toString());
    });
  });
}

function sendWhatsAppSnapshot(socket: WebSocket): void {
  const snapshot = whatsappService.getSnapshot();
  const send = (event: string, payload: unknown) =>
    socket.send(JSON.stringify({ channel: "whatsapp", event, payload, ts: Date.now() }));

  send("status", { status: snapshot.status });
  if (snapshot.status === "qr_pending" && snapshot.qr) send("qr", { qr: snapshot.qr });
  if (snapshot.status === "connected") send("connected", { number: snapshot.number });
}

function sendGmailSnapshot(socket: WebSocket): void {
  const snapshot = gmailService.getSnapshot();
  socket.send(
    JSON.stringify({ channel: "gmail", event: "status", payload: snapshot, ts: Date.now() })
  );
}

function sendSpotifySnapshot(socket: WebSocket): void {
  const snapshot = spotifyService.getSnapshot();
  const send = (event: string, payload: unknown) =>
    socket.send(JSON.stringify({ channel: "spotify", event, payload, ts: Date.now() }));

  send("status", { status: snapshot.status });
  if (snapshot.track) send("track", { track: snapshot.track });
}

function sendInstagramSnapshot(socket: WebSocket): void {
  const snapshot = instagramService.getSnapshot();
  socket.send(
    JSON.stringify({ channel: "instagram", event: "status", payload: snapshot, ts: Date.now() })
  );
}

function sendGoogleHomeSnapshot(socket: WebSocket): void {
  const snapshot = googleHomeService.getSnapshot();
  socket.send(
    JSON.stringify({ channel: "google-home", event: "status", payload: snapshot, ts: Date.now() })
  );
}

// mensagens recebidas via WS no canal 'chat': { conversationId?, message }
// a resposta do modelo chega pelo próprio broadcast do canal 'chat' (evento 'message')
async function handleChatSocketMessage(
  app: FastifyInstance,
  socket: WebSocket,
  raw: string
): Promise<void> {
  try {
    const parsed = JSON.parse(raw) as { conversationId?: string; message?: string };

    if (!parsed.message || typeof parsed.message !== "string") {
      socket.send(JSON.stringify({ channel: "chat", event: "error", payload: "message obrigatória", ts: Date.now() }));
      return;
    }

    await processChatMessage({ conversationId: parsed.conversationId, message: parsed.message });
  } catch (err) {
    app.log.error({ err }, "erro ao processar mensagem WS no canal chat");
    socket.send(JSON.stringify({ channel: "chat", event: "error", payload: "falha ao processar mensagem", ts: Date.now() }));
  }
}
