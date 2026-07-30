import { env } from "../../config/env.js";
import { logger } from "../../core/logger.js";
import { wsHub } from "../../ws/hub.js";
import {
  saveInstagramAccount,
  getInstagramAccount,
  deleteInstagramAccount,
} from "./instagram.repository.js";

export type InstagramStatus = "disconnected" | "connected";

export interface InstagramMediaItem {
  id: string;
  caption: string | null;
  mediaType: string;
  mediaUrl: string | null;
  permalink: string;
  timestamp: string;
  likeCount: number;
  commentsCount: number;
}

export interface InstagramProfile {
  igUserId: string;
  username: string;
}

const SCOPES = [
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_comments",
  "instagram_manage_insights",
  "pages_show_list",
  "pages_read_engagement",
  "business_management",
].join(",");

const POLL_INTERVAL_MS = 5 * 60_000; // Graph API tem rate limit generoso mas não precisa de tempo real

class InstagramService {
  private status: InstagramStatus = "disconnected";
  private accessToken: string | null = null;
  private igUserId: string | null = null;
  private profile: InstagramProfile | null = null;
  private lastMedia: InstagramMediaItem[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  private get baseUrl(): string {
    return `https://graph.facebook.com/${env.INSTAGRAM_GRAPH_VERSION}`;
  }

  getStatus(): InstagramStatus {
    return this.status;
  }

  getSnapshot(): { status: InstagramStatus; profile: InstagramProfile | null; media: InstagramMediaItem[] } {
    return { status: this.status, profile: this.profile, media: this.lastMedia };
  }

  // monta a URL de login do Facebook (é assim que se autentica no Instagram
  // Profissional via Graph API) — o painel abre isso numa aba nova
  getAuthUrl(): string {
    if (!env.INSTAGRAM_APP_ID) {
      throw new Error("INSTAGRAM_APP_ID não configurado no .env");
    }

    const params = new URLSearchParams({
      client_id: env.INSTAGRAM_APP_ID,
      redirect_uri: env.INSTAGRAM_REDIRECT_URI,
      response_type: "code",
      scope: SCOPES,
    });

    return `https://www.facebook.com/${env.INSTAGRAM_GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
  }

  // troca o "code" do callback OAuth por um token de página de longa duração
  // já vinculado à conta profissional do Instagram, e deixa tudo conectado
  async handleAuthCallback(code: string): Promise<void> {
    const shortLivedToken = await this.exchangeCodeForToken(code);
    const longLivedUserToken = await this.exchangeForLongLivedToken(shortLivedToken);

    const pages = await this.fetchGraph<{ data: { id: string; access_token: string; name: string }[] }>(
      "/me/accounts",
      longLivedUserToken
    );

    if (!pages.data?.length) {
      throw new Error(
        "Nenhuma Página do Facebook encontrada nessa conta. É preciso ter uma Página vinculada à conta profissional do Instagram."
      );
    }

    for (const page of pages.data) {
      const pageInfo = await this.fetchGraph<{ instagram_business_account?: { id: string } }>(
        `/${page.id}?fields=instagram_business_account`,
        page.access_token
      );

      const igUserId = pageInfo.instagram_business_account?.id;
      if (!igUserId) continue;

      const igProfile = await this.fetchGraph<{ username: string }>(
        `/${igUserId}?fields=username`,
        page.access_token
      );

      saveInstagramAccount({
        accessToken: page.access_token,
        igUserId,
        pageId: page.id,
        username: igProfile.username,
        // tokens de página derivados de um token de usuário de longa duração
        // não expiram na prática — guardamos ~60 dias só como referência
        expiresAt: Date.now() + 60 * 24 * 60 * 60 * 1000,
      });

      this.accessToken = page.access_token;
      this.igUserId = igUserId;
      this.profile = { igUserId, username: igProfile.username };
      this.setStatus("connected");
      this.startPolling();
      return;
    }

    throw new Error(
      "Nenhuma das Páginas encontradas tem uma conta profissional do Instagram vinculada."
    );
  }

  // tenta reconectar sozinho no boot se já tiver uma conta salva
  async restoreFromStorage(): Promise<void> {
    const account = getInstagramAccount();
    if (!account) return;

    this.accessToken = account.accessToken;
    this.igUserId = account.igUserId;
    this.profile = { igUserId: account.igUserId, username: account.username ?? "" };
    this.setStatus("connected");
    this.startPolling();
  }

  disconnect(): void {
    deleteInstagramAccount();
    this.accessToken = null;
    this.igUserId = null;
    this.profile = null;
    this.lastMedia = [];
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.setStatus("disconnected");
  }

  // --- ações usadas tanto pelas rotas HTTP quanto pelo fluxo de voz/chat ---

  async listMedia(limit = 12): Promise<InstagramMediaItem[]> {
    const igUserId = this.ensureConnected();
    const data = await this.fetchGraph<{
      data: {
        id: string;
        caption?: string;
        media_type: string;
        media_url?: string;
        permalink: string;
        timestamp: string;
        like_count?: number;
        comments_count?: number;
      }[];
    }>(
      `/${igUserId}/media?fields=id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count&limit=${limit}`,
      this.accessToken!
    );

    return data.data.map((item) => ({
      id: item.id,
      caption: item.caption ?? null,
      mediaType: item.media_type,
      mediaUrl: item.media_url ?? null,
      permalink: item.permalink,
      timestamp: item.timestamp,
      likeCount: item.like_count ?? 0,
      commentsCount: item.comments_count ?? 0,
    }));
  }

  // publica uma foto a partir de uma URL pública de imagem (é assim que a
  // Graph API do Instagram funciona — não aceita upload direto de arquivo)
  async publishPhoto(imageUrl: string, caption: string): Promise<{ id: string; permalink: string | null }> {
    const igUserId = this.ensureConnected();

    const container = await this.postGraph<{ id: string }>(`/${igUserId}/media`, {
      image_url: imageUrl,
      caption,
    });

    const published = await this.postGraph<{ id: string }>(`/${igUserId}/media_publish`, {
      creation_id: container.id,
    });

    let permalink: string | null = null;
    try {
      const info = await this.fetchGraph<{ permalink: string }>(
        `/${published.id}?fields=permalink`,
        this.accessToken!
      );
      permalink = info.permalink;
    } catch {
      // não é crítico — a publicação já aconteceu, só não conseguimos o link
    }

    wsHub.broadcast("instagram", "published", { id: published.id, permalink });
    void this.pollMedia();

    return { id: published.id, permalink };
  }

  // publica um vídeo curto (Reels) a partir de uma URL pública de vídeo
  async publishReel(videoUrl: string, caption: string): Promise<{ id: string }> {
    const igUserId = this.ensureConnected();

    const container = await this.postGraph<{ id: string }>(`/${igUserId}/media`, {
      media_type: "REELS",
      video_url: videoUrl,
      caption,
    });

    // vídeos precisam de tempo de processamento antes de publicar — tenta
    // por até ~2 minutos, checando o status do container
    await this.waitUntilReady(container.id);

    const published = await this.postGraph<{ id: string }>(`/${igUserId}/media_publish`, {
      creation_id: container.id,
    });

    wsHub.broadcast("instagram", "published", { id: published.id });
    void this.pollMedia();

    return { id: published.id };
  }

  async replyToComment(commentId: string, message: string): Promise<void> {
    this.ensureConnected();
    await this.postGraph(`/${commentId}/replies`, { message });
  }

  // --- internals ---

  private ensureConnected(): string {
    if (this.status !== "connected" || !this.igUserId || !this.accessToken) {
      throw new Error("Instagram não está conectado");
    }
    return this.igUserId;
  }

  private async waitUntilReady(containerId: string): Promise<void> {
    for (let i = 0; i < 12; i++) {
      const status = await this.fetchGraph<{ status_code: string }>(
        `/${containerId}?fields=status_code`,
        this.accessToken!
      );
      if (status.status_code === "FINISHED") return;
      if (status.status_code === "ERROR") {
        throw new Error("O Instagram falhou ao processar o vídeo enviado");
      }
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    throw new Error("Tempo esgotado esperando o Instagram processar o vídeo");
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      this.pollMedia().catch((err) => logger.error({ err }, "falha ao consultar mídia do Instagram"));
    }, POLL_INTERVAL_MS);
    this.pollTimer.unref();
    void this.pollMedia();
  }

  private async pollMedia(): Promise<void> {
    if (this.status !== "connected") return;
    try {
      this.lastMedia = await this.listMedia(12);
      wsHub.broadcast("instagram", "media", { media: this.lastMedia });
    } catch (err) {
      logger.error({ err }, "falha ao atualizar mídia recente do Instagram");
    }
  }

  private async exchangeCodeForToken(code: string): Promise<string> {
    if (!env.INSTAGRAM_APP_ID || !env.INSTAGRAM_APP_SECRET) {
      throw new Error("INSTAGRAM_APP_ID/INSTAGRAM_APP_SECRET não configurados no .env");
    }

    const params = new URLSearchParams({
      client_id: env.INSTAGRAM_APP_ID,
      client_secret: env.INSTAGRAM_APP_SECRET,
      redirect_uri: env.INSTAGRAM_REDIRECT_URI,
      code,
    });

    const data = await this.fetchGraph<{ access_token: string }>(
      `/oauth/access_token?${params.toString()}`,
      null
    );
    return data.access_token;
  }

  private async exchangeForLongLivedToken(shortLivedToken: string): Promise<string> {
    const params = new URLSearchParams({
      grant_type: "fb_exchange_token",
      client_id: env.INSTAGRAM_APP_ID!,
      client_secret: env.INSTAGRAM_APP_SECRET!,
      fb_exchange_token: shortLivedToken,
    });

    const data = await this.fetchGraph<{ access_token: string }>(
      `/oauth/access_token?${params.toString()}`,
      null
    );
    return data.access_token;
  }

  private async fetchGraph<T = unknown>(path: string, token: string | null): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (token) url.searchParams.set("access_token", token);

    const res = await fetch(url.toString());
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Instagram/Graph API respondeu ${res.status}: ${detail}`);
    }
    return res.json() as Promise<T>;
  }

  private async postGraph<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set("access_token", this.accessToken!);

    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Instagram/Graph API respondeu ${res.status}: ${detail}`);
    }
    return res.json() as Promise<T>;
  }

  private setStatus(status: InstagramStatus): void {
    this.status = status;
    wsHub.broadcast("instagram", "status", { status, profile: this.profile });
  }
}

export const instagramService = new InstagramService();
