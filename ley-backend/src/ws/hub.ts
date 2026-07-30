import type { WebSocket } from "ws";

export type WsChannel =
  | "logs"
  | "whatsapp"
  | "chat"
  | "gmail"
  | "system"
  | "spotify"
  | "instagram"
  | "google-home";

export interface WsEnvelope<T = unknown> {
  channel: WsChannel;
  event: string;
  payload: T;
  ts: number;
}

class WsHub {
  // um Set por canal evita broadcast desnecessário para clientes não-inscritos
  private clients = new Map<WsChannel, Set<WebSocket>>();

  subscribe(channel: WsChannel, socket: WebSocket): void {
    if (!this.clients.has(channel)) this.clients.set(channel, new Set());
    this.clients.get(channel)!.add(socket);

    socket.once("close", () => this.clients.get(channel)?.delete(socket));
  }

  broadcast<T>(channel: WsChannel, event: string, payload: T): void {
    const envelope: WsEnvelope<T> = { channel, event, payload, ts: Date.now() };
    const data = JSON.stringify(envelope);

    for (const socket of this.clients.get(channel) ?? []) {
      if (socket.readyState === socket.OPEN) socket.send(data);
    }
  }

  clientCount(channel: WsChannel): number {
    return this.clients.get(channel)?.size ?? 0;
  }
}

// singleton — módulos de LLM/WhatsApp/Gmail importam isso para emitir eventos
export const wsHub = new WsHub();
