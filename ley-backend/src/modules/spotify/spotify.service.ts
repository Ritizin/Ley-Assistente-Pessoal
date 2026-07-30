import { env } from "../../config/env.js";
import { logger } from "../../core/logger.js";
import { wsHub } from "../../ws/hub.js";
import { saveRefreshToken, getRefreshToken, deleteRefreshToken } from "./spotify.repository.js";

export type SpotifyStatus = "disconnected" | "connected";

export interface SpotifyTrack {
  name: string;
  artists: string;
  albumArt: string | null;
  isPlaying: boolean;
  progressMs: number;
  durationMs: number;
  uri: string;
}

const SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
].join(" ");

const POLL_INTERVAL_MS = 5_000;

class SpotifyService {
  private status: SpotifyStatus = "disconnected";
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastTrack: SpotifyTrack | null = null;

  getStatus(): SpotifyStatus {
    return this.status;
  }

  getSnapshot(): { status: SpotifyStatus; track: SpotifyTrack | null } {
    return { status: this.status, track: this.lastTrack };
  }

  // monta a URL de login do Spotify — o painel abre isso numa aba nova
  getAuthUrl(): string {
    if (!env.SPOTIFY_CLIENT_ID) {
      throw new Error("SPOTIFY_CLIENT_ID não configurado no .env");
    }

    const params = new URLSearchParams({
      client_id: env.SPOTIFY_CLIENT_ID,
      response_type: "code",
      redirect_uri: env.SPOTIFY_REDIRECT_URI,
      scope: SCOPES,
    });

    return `https://accounts.spotify.com/authorize?${params.toString()}`;
  }

  // troca o "code" do callback OAuth pelos tokens e já deixa conectado
  async handleAuthCallback(code: string): Promise<void> {
    const tokens = await this.exchangeCodeForTokens(code);
    saveRefreshToken(tokens.refresh_token);
    this.accessToken = tokens.access_token;
    this.accessTokenExpiresAt = Date.now() + tokens.expires_in * 1000;
    this.setStatus("connected");
    this.startPolling();
  }

  // tenta reconectar sozinho no boot se já tiver um refresh token salvo
  async restoreFromStorage(): Promise<void> {
    const refreshToken = getRefreshToken();
    if (!refreshToken) return;

    await this.refreshAccessToken(refreshToken);
    this.setStatus("connected");
    this.startPolling();
  }

  disconnect(): void {
    deleteRefreshToken();
    this.accessToken = null;
    this.lastTrack = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.setStatus("disconnected");
  }

  // --- controles usados tanto pelas rotas HTTP quanto pelo fluxo de voz/chat ---

  async play(): Promise<void> {
    await this.apiRequest("PUT", "/me/player/play");
  }

  async pause(): Promise<void> {
    await this.apiRequest("PUT", "/me/player/pause");
  }

  async next(): Promise<void> {
    await this.apiRequest("POST", "/me/player/next");
  }

  async previous(): Promise<void> {
    await this.apiRequest("POST", "/me/player/previous");
  }

  // busca uma música pelo nome (e opcionalmente artista) e já toca no
  // dispositivo ativo do Spotify
  async searchAndPlay(query: string): Promise<string> {
    const params = new URLSearchParams({ q: query, type: "track", limit: "1" });
    const data = await this.apiRequest<{
      tracks: { items: { name: string; uri: string; artists: { name: string }[] }[] };
    }>("GET", `/search?${params.toString()}`);

    const track = data?.tracks?.items?.[0];
    if (!track) {
      throw new Error(`Não achei nenhuma música pra "${query}" no Spotify`);
    }

    await this.apiRequest("PUT", "/me/player/play", { uris: [track.uri] });
    return `${track.name} - ${track.artists.map((a) => a.name).join(", ")}`;
  }

  // --- internals ---

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      this.pollNowPlaying().catch((err) => logger.error({ err }, "falha ao consultar o Spotify"));
    }, POLL_INTERVAL_MS);
    this.pollTimer.unref();
    void this.pollNowPlaying();
  }

  private async pollNowPlaying(): Promise<void> {
    if (this.status !== "connected") return;

    const data = await this.apiRequest<{
      item: { name: string; uri: string; artists: { name: string }[]; album: { images: { url: string }[] }; duration_ms: number } | null;
      is_playing: boolean;
      progress_ms: number;
    } | null>("GET", "/me/player");

    if (!data || !data.item) {
      if (this.lastTrack !== null) {
        this.lastTrack = null;
        wsHub.broadcast("spotify", "track", { track: null });
      }
      return;
    }

    const track: SpotifyTrack = {
      name: data.item.name,
      artists: data.item.artists.map((a) => a.name).join(", "),
      albumArt: data.item.album.images[0]?.url ?? null,
      isPlaying: data.is_playing,
      progressMs: data.progress_ms,
      durationMs: data.item.duration_ms,
      uri: data.item.uri,
    };

    // só notifica o painel quando algo relevante muda — evita spam de broadcast
    // a cada 5s só por causa do progresso do relógio
    const changed =
      !this.lastTrack ||
      this.lastTrack.uri !== track.uri ||
      this.lastTrack.isPlaying !== track.isPlaying;

    this.lastTrack = track;
    if (changed) wsHub.broadcast("spotify", "track", { track });
  }

  private async ensureValidAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 10_000) {
      return this.accessToken;
    }

    const refreshToken = getRefreshToken();
    if (!refreshToken) throw new Error("Spotify não está conectado");

    await this.refreshAccessToken(refreshToken);
    return this.accessToken!;
  }

  private async refreshAccessToken(refreshToken: string): Promise<void> {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${this.basicAuthHeader()}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`falha ao renovar token do Spotify (${res.status}): ${detail}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };

    this.accessToken = data.access_token;
    this.accessTokenExpiresAt = Date.now() + data.expires_in * 1000;

    // o Spotify às vezes manda um refresh_token novo (rotação) — se vier, atualiza
    if (data.refresh_token) saveRefreshToken(data.refresh_token);
  }

  private async exchangeCodeForTokens(
    code: string
  ): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${this.basicAuthHeader()}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: env.SPOTIFY_REDIRECT_URI,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`falha ao trocar code por token do Spotify (${res.status}): ${detail}`);
    }

    return res.json() as Promise<{ access_token: string; refresh_token: string; expires_in: number }>;
  }

  private basicAuthHeader(): string {
    if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) {
      throw new Error("SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET não configurados no .env");
    }
    return Buffer.from(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`).toString("base64");
  }

  // wrapper genérico pra chamar a Web API do Spotify já com o token válido
  private async apiRequest<T = unknown>(
    method: "GET" | "PUT" | "POST",
    path: string,
    body?: unknown
  ): Promise<T> {
    const token = await this.ensureValidAccessToken();

    const res = await fetch(`https://api.spotify.com/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    // 204 = sucesso sem conteúdo (comum em play/pause/next) e 202 = "sem
    // dispositivo ativo" às vezes — nenhum dos dois tem corpo JSON pra ler
    if (res.status === 204 || res.status === 202) return null as T;

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      if (res.status === 404) {
        throw new Error("Nenhum dispositivo do Spotify ativo agora — abre o Spotify em algum aparelho primeiro");
      }
      throw new Error(`Spotify API respondeu ${res.status}: ${detail}`);
    }

    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  private setStatus(status: SpotifyStatus): void {
    this.status = status;
    wsHub.broadcast("spotify", "status", { status });
  }
}

export const spotifyService = new SpotifyService();
