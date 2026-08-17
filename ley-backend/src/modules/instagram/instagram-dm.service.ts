import fs from "node:fs";
import path from "node:path";
import {
  IgApiClient,
  IgCheckpointError,
  IgLoginTwoFactorRequiredError,
  IgLoginBadPasswordError,
} from "instagram-private-api";

import { env } from "../../config/env.js";
import { logger } from "../../core/logger.js";
import { wsHub } from "../../ws/hub.js";
import {
  saveMessage,
  upsertContact,
  listMessagesByThread,
  getContactByThread,
  type IgDmMessageRow,
} from "./instagram-dm.repository.js"; // ✅ VOLTEI COM .js

export type InstagramDmStatus =
  | "disconnected"
  | "connecting"
  | "checkpoint_required"
  | "connected";

const SESSION_FILE_NAME = "session.json";
const POLL_INTERVAL_MS = 12_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const BASE_RECONNECT_DELAY_MS = 3_000;

class InstagramDmService {
  private ig: IgApiClient | null = null;
  private status: InstagramDmStatus = "disconnected";
  private reconnectAttempts = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private username: string | null = null;
  private lastSeenItemTs = new Map<string, string>();
  private lastError: string | null = null;

  getStatus(): InstagramDmStatus {
    return this.status;
  }

  getSnapshot(): { status: InstagramDmStatus; username: string | null; error: string | null } {
    return { status: this.status, username: this.username, error: this.lastError };
  }

  private get sessionPath(): string {
    return path.join(path.resolve(env.INSTAGRAM_DM_SESSION_DIR), SESSION_FILE_NAME);
  }

  async start(): Promise<void> {
    if (!env.INSTAGRAM_DM_USERNAME || !env.INSTAGRAM_DM_PASSWORD) {
      logger.warn("INSTAGRAM_DM_USERNAME/INSTAGRAM_DM_PASSWORD não configurados — módulo de DM do Instagram fica parado até isso ser preenchido no .env");
      this.setStatus("disconnected");
      return;
    }

    this.setStatus("connecting");
    this.username = env.INSTAGRAM_DM_USERNAME;

    try {
      const ig = new IgApiClient();
      ig.state.generateDevice(env.INSTAGRAM_DM_USERNAME);

      const restored = await this.tryRestoreSession(ig);

      if (!restored) {
        await ig.simulate.preLoginFlow();
        await ig.account.login(env.INSTAGRAM_DM_USERNAME, env.INSTAGRAM_DM_PASSWORD);
        process.nextTick(async () => {
          try {
            await ig.simulate.postLoginFlow();
          } catch (err) {
            logger.warn({ err }, "postLoginFlow do Instagram falhou (não crítico)");
          }
        });
      } else {
        await ig.account.currentUser();
      }

      this.persistSession(ig);
      this.ig = ig;
      this.lastError = null;
      this.reconnectAttempts = 0;
      this.setStatus("connected");
      this.startPolling();
    } catch (err) {
      if (err instanceof IgCheckpointError || err instanceof IgLoginTwoFactorRequiredError) {
        this.lastError =
          "O Instagram pediu verificação (checkpoint/2FA) pra essa conta. Entre manualmente no app/site com leysatan uma vez pra confirmar, depois reinicie o módulo.";
        logger.error({ err }, "[instagram-dm] checkpoint/2FA exigido pelo Instagram");
        this.setStatus("checkpoint_required");
        return;
      }

      if (err instanceof IgLoginBadPasswordError) {
        this.lastError =
          "O Instagram recusou a senha da conta @leysatan (usuário/senha incorretos). Confirme a senha atual entrando manualmente no app/site, atualize INSTAGRAM_DM_PASSWORD no .env e clique em conectar de novo.";
        logger.error({ err }, "[instagram-dm] usuário/senha incorretos");
        this.setStatus("checkpoint_required");
        return;
      }

      this.lastError = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "[instagram-dm] falha ao conectar — tentando de novo em breve");
      this.setStatus("disconnected");
      this.scheduleReconnect();
    }
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.ig = null;
    this.setStatus("disconnected");
  }

  private async tryRestoreSession(ig: IgApiClient): Promise<boolean> {
    try {
      if (!fs.existsSync(this.sessionPath)) return false;
      const raw = fs.readFileSync(this.sessionPath, "utf-8");
      const serialized = JSON.parse(raw);
      await ig.state.deserialize(serialized);
      return true;
    } catch (err) {
      logger.warn({ err }, "[instagram-dm] não deu pra restaurar sessão salva — vai logar do zero");
      return false;
    }
  }

  private persistSession(ig: IgApiClient): void {
    void (async () => {
      try {
        const dir = path.resolve(env.INSTAGRAM_DM_SESSION_DIR);
        fs.mkdirSync(dir, { recursive: true });
        const serialized = await ig.state.serialize();
        delete (serialized as { constants?: unknown }).constants;
        fs.writeFileSync(this.sessionPath, JSON.stringify(serialized), "utf-8");
      } catch (err) {
        logger.error({ err }, "[instagram-dm] falha ao salvar sessão em disco");
      }
    })();
  }

  private startPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollInbox();
    this.pollTimer = setInterval(() => this.pollInbox(), POLL_INTERVAL_MS);
    this.pollTimer.unref();
  }

  private async pollInbox(): Promise<void> {
    if (!this.ig || this.status !== "connected") return;

    try {
      const inboxFeed = this.ig.feed.directInbox();
      const threads = await inboxFeed.items();

      for (const thread of threads) {
        const threadId = thread.thread_id;
        const isGroup = (thread.users?.length ?? 0) > 1;

        const otherUser = thread.users?.[0];
        const name = thread.thread_title || otherUser?.full_name || otherUser?.username || null;
        const username = otherUser?.username ?? null;
        upsertContact(threadId, name, username, isGroup);

        const items = [...(thread.items ?? [])].reverse();
        const lastProcessedTs = this.lastSeenItemTs.get(threadId) ?? "0";
        let newestTs = lastProcessedTs;

        for (const item of items) {
          if (Number(item.timestamp) <= Number(lastProcessedTs)) continue;

          const fromMe = String(item.user_id) === String(this.ig.state.cookieUserId);
          const senderUser = thread.users?.find((u) => u.pk?.toString() === item.user_id?.toString());
          const senderName = fromMe ? null : senderUser?.username ?? senderUser?.full_name ?? null;

          let text: string | null = null;
          let mediaUrl: string | null = null;
          let type: IgDmMessageRow["type"] = "other";

          if (item.item_type === "text" && item.text) {
            type = "text";
            text = item.text;
          } else if (item.item_type === "media_share" || item.item_type === "media" || item.item_type === "clip") {
            type = "media";
            text = item.text ?? null;
          } else if (item.item_type === "like") {
            type = "text";
            text = "❤️";
          } else {
            continue;
          }

          saveMessage({
            id: item.item_id,
            thread_id: threadId,
            from_me: fromMe ? 1 : 0,
            sender_name: senderName,
            type,
            text,
            media_url: mediaUrl,
            created_at: Math.floor(Number(item.timestamp) / 1000),
          });

          if (!fromMe) {
            wsHub.broadcast("instagram-dm", "message", {
              id: item.item_id,
              threadId,
              fromMe: false,
              senderName,
              type,
              text,
              createdAt: Math.floor(Number(item.timestamp) / 1000),
            });

            // ✅ VOLTEI COM .js
            void import("../llm/instagram-dm-autopilot.js")
              .then(({ handleIncomingAutopilot }) => handleIncomingAutopilot(threadId, isGroup, text))
              .catch((err) => logger.error({ err }, "[instagram-dm] falha ao acionar autopilot"));
          }

          if (item.timestamp > newestTs) newestTs = item.timestamp;
        }

        this.lastSeenItemTs.set(threadId, newestTs);
      }
    } catch (err) {
      logger.error({ err }, "[instagram-dm] falha ao verificar caixa de entrada — tentando de novo no próximo ciclo");
    }
  }

  async sendText(threadId: string, text: string): Promise<void> {
    if (!this.ig || this.status !== "connected") {
      throw new Error("Instagram (DM) não está conectado");
    }

    const thread = this.ig.entity.directThread(threadId);
    const sent = await thread.broadcastText(text);
    const itemId = InstagramDmService.extractBroadcastItemId(sent) ?? `local-${Date.now()}`;

    saveMessage({
      id: itemId,
      thread_id: threadId,
      from_me: 1,
      sender_name: null,
      type: "text",
      text,
      media_url: null,
      created_at: Date.now(),
    });

    wsHub.broadcast("instagram-dm", "message", {
      id: itemId,
      threadId,
      fromMe: true,
      senderName: null,
      type: "text",
      text,
      createdAt: Date.now(),
    });
  }

  private static extractBroadcastItemId(sent: unknown): string | null {
    if (!sent || typeof sent !== "object") return null;
    const obj = sent as Record<string, unknown>;

    if (typeof obj.item_id === "string") return obj.item_id;

    const payload = obj.payload;
    if (payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).item_id === "string") {
      return (payload as Record<string, unknown>).item_id as string;
    }

    return null;
  }

  private scheduleReconnect(): void {
    const delayMs = Math.min(MAX_RECONNECT_DELAY_MS, BASE_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;

    logger.warn({ delayMs, attempt: this.reconnectAttempts }, "[instagram-dm] tentando reconectar em breve");
    setTimeout(() => {
      this.start().catch((err) => logger.error({ err }, "[instagram-dm] falha ao reconectar"));
    }, delayMs).unref();
  }

  private setStatus(status: InstagramDmStatus): void {
    this.status = status;
    wsHub.broadcast("instagram-dm", "status", { status, username: this.username, error: this.lastError });
  }
}

export const instagramDmService = new InstagramDmService();

export { listMessagesByThread, getContactByThread };
