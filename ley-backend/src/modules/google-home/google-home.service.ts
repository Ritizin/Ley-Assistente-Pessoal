import { env } from "../../config/env.js";
import { logger } from "../../core/logger.js";
import { wsHub } from "../../ws/hub.js";
import {
  saveGoogleHomeRefreshToken,
  getGoogleHomeRefreshToken,
  deleteGoogleHomeRefreshToken,
} from "./google-home.repository.js";

export type GoogleHomeStatus = "disconnected" | "connected";

export type GoogleHomeDeviceType =
  | "THERMOSTAT"
  | "CAMERA"
  | "DOORBELL"
  | "DISPLAY"
  | "LOCK"
  | "OTHER";

export interface GoogleHomeDevice {
  id: string; // nome completo retornado pela API: enterprises/{p}/devices/{d}
  name: string; // apelido dado pelo usuário no app Google Home
  type: GoogleHomeDeviceType;
  room: string | null;
  online: boolean;
  // campos só preenchidos quando o dispositivo tiver o trait correspondente
  thermostatMode?: string;
  thermostatSetpointCelsius?: number;
  ambientTemperatureCelsius?: number;
  ambientHumidityPercent?: number;
}

// escopo único necessário pra ler e controlar dispositivos Nest via SDM
const SCOPE = "https://www.googleapis.com/auth/sdm.service";
const TOKEN_URL = "https://www.googleapis.com/oauth2/v4/token";
const POLL_INTERVAL_MS = 60_000;

const DEVICE_TYPE_MAP: Record<string, GoogleHomeDeviceType> = {
  "sdm.devices.types.THERMOSTAT": "THERMOSTAT",
  "sdm.devices.types.CAMERA": "CAMERA",
  "sdm.devices.types.DOORBELL": "DOORBELL",
  "sdm.devices.types.DISPLAY": "DISPLAY",
};

class GoogleHomeService {
  private status: GoogleHomeStatus = "disconnected";
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private devices: GoogleHomeDevice[] = [];

  getStatus(): GoogleHomeStatus {
    return this.status;
  }

  getSnapshot(): { status: GoogleHomeStatus; devices: GoogleHomeDevice[] } {
    return { status: this.status, devices: this.devices };
  }

  // monta a URL de autorização do Nest Device Access — o painel abre isso
  // numa aba nova. Note que é um domínio diferente do OAuth "normal" do
  // Google, específico do programa Device Access.
  getAuthUrl(): string {
    if (!env.GOOGLE_HOME_CLIENT_ID || !env.GOOGLE_HOME_PROJECT_ID) {
      throw new Error("GOOGLE_HOME_CLIENT_ID/GOOGLE_HOME_PROJECT_ID não configurados no .env");
    }

    const params = new URLSearchParams({
      client_id: env.GOOGLE_HOME_CLIENT_ID,
      redirect_uri: env.GOOGLE_HOME_REDIRECT_URI,
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
    });

    return `https://nestservices.google.com/partnerconnections/${env.GOOGLE_HOME_PROJECT_ID}/auth?${params.toString()}`;
  }

  async handleAuthCallback(code: string): Promise<void> {
    const tokens = await this.exchangeCodeForTokens(code);
    saveGoogleHomeRefreshToken(tokens.refresh_token);
    this.accessToken = tokens.access_token;
    this.accessTokenExpiresAt = Date.now() + tokens.expires_in * 1000;
    this.setStatus("connected");
    this.startPolling();
  }

  async restoreFromStorage(): Promise<void> {
    const refreshToken = getGoogleHomeRefreshToken();
    if (!refreshToken) return;

    await this.refreshAccessToken(refreshToken);
    this.setStatus("connected");
    this.startPolling();
  }

  disconnect(): void {
    deleteGoogleHomeRefreshToken();
    this.accessToken = null;
    this.devices = [];
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.setStatus("disconnected");
  }

  // --- ações usadas tanto pelas rotas HTTP quanto pelo fluxo de voz/chat ---

  async listDevices(): Promise<GoogleHomeDevice[]> {
    if (!env.GOOGLE_HOME_PROJECT_ID) {
      throw new Error("GOOGLE_HOME_PROJECT_ID não configurado no .env");
    }
    const data = await this.apiRequest<{
      devices?: {
        name: string;
        type: string;
        traits?: Record<string, any>;
        parentRelations?: { displayName?: string }[];
      }[];
    }>("GET", `enterprises/${env.GOOGLE_HOME_PROJECT_ID}/devices`);

    this.devices = (data.devices ?? []).map((d) => this.mapDevice(d));
    return this.devices;
  }

  findDevice(query: string): GoogleHomeDevice | null {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return this.devices[0] ?? null;

    return (
      this.devices.find(
        (d) =>
          d.name.toLowerCase().includes(normalized) ||
          (d.room && d.room.toLowerCase().includes(normalized))
      ) ?? null
    );
  }

  async setThermostatMode(deviceId: string, mode: "HEAT" | "COOL" | "HEATCOOL" | "OFF"): Promise<void> {
    await this.executeCommand(deviceId, "sdm.devices.commands.ThermostatMode.SetMode", { mode });
    void this.pollDevices();
  }

  async setThermostatTemperature(
    deviceId: string,
    celsius: number,
    mode: "heat" | "cool" = "heat"
  ): Promise<void> {
    const command =
      mode === "heat"
        ? "sdm.devices.commands.ThermostatTemperatureSetpoint.SetHeat"
        : "sdm.devices.commands.ThermostatTemperatureSetpoint.SetCool";
    const paramKey = mode === "heat" ? "heatCelsius" : "coolCelsius";

    await this.executeCommand(deviceId, command, { [paramKey]: celsius });
    void this.pollDevices();
  }

  async executeCommand(deviceId: string, command: string, params: Record<string, unknown>): Promise<void> {
    // deviceId já vem como o "name" completo retornado pela API
    // (enterprises/{projeto}/devices/{id}) — não precisa prefixar de novo
    await this.apiRequest("POST", `${deviceId}:executeCommand`, { command, params });
  }

  // --- internals ---

  private mapDevice(raw: {
    name: string;
    type: string;
    traits?: Record<string, any>;
    parentRelations?: { displayName?: string }[];
  }): GoogleHomeDevice {
    const traits = raw.traits ?? {};
    const info = traits["sdm.devices.traits.Info"];
    const connectivity = traits["sdm.devices.traits.Connectivity"];
    const thermostatMode = traits["sdm.devices.traits.ThermostatMode"];
    const thermostatSetpoint = traits["sdm.devices.traits.ThermostatTemperatureSetpoint"];
    const temperature = traits["sdm.devices.traits.Temperature"];
    const humidity = traits["sdm.devices.traits.Humidity"];

    return {
      id: raw.name,
      name: info?.customName || raw.parentRelations?.[0]?.displayName || raw.name.split("/").pop()!,
      type: DEVICE_TYPE_MAP[raw.type] ?? "OTHER",
      room: raw.parentRelations?.[0]?.displayName ?? null,
      online: connectivity?.status === "ONLINE",
      thermostatMode: thermostatMode?.mode,
      thermostatSetpointCelsius: thermostatSetpoint?.heatCelsius ?? thermostatSetpoint?.coolCelsius,
      ambientTemperatureCelsius: temperature?.ambientTemperatureCelsius,
      ambientHumidityPercent: humidity?.ambientHumidityPercent,
    };
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      this.pollDevices().catch((err) => logger.error({ err }, "falha ao consultar dispositivos do Google Home"));
    }, POLL_INTERVAL_MS);
    this.pollTimer.unref();
    void this.pollDevices();
  }

  private async pollDevices(): Promise<void> {
    if (this.status !== "connected") return;
    const devices = await this.listDevices();
    wsHub.broadcast("google-home", "devices", { devices });
  }

  private async ensureValidAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 10_000) {
      return this.accessToken;
    }

    const refreshToken = getGoogleHomeRefreshToken();
    if (!refreshToken) throw new Error("Google Home não está conectado");

    await this.refreshAccessToken(refreshToken);
    return this.accessToken!;
  }

  private async refreshAccessToken(refreshToken: string): Promise<void> {
    if (!env.GOOGLE_HOME_CLIENT_ID || !env.GOOGLE_HOME_CLIENT_SECRET) {
      throw new Error("GOOGLE_HOME_CLIENT_ID/GOOGLE_HOME_CLIENT_SECRET não configurados no .env");
    }

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.GOOGLE_HOME_CLIENT_ID,
        client_secret: env.GOOGLE_HOME_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`falha ao renovar token do Google Home (${res.status}): ${detail}`);
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.accessTokenExpiresAt = Date.now() + data.expires_in * 1000;
  }

  private async exchangeCodeForTokens(
    code: string
  ): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
    if (!env.GOOGLE_HOME_CLIENT_ID || !env.GOOGLE_HOME_CLIENT_SECRET) {
      throw new Error("GOOGLE_HOME_CLIENT_ID/GOOGLE_HOME_CLIENT_SECRET não configurados no .env");
    }

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.GOOGLE_HOME_CLIENT_ID,
        client_secret: env.GOOGLE_HOME_CLIENT_SECRET,
        redirect_uri: env.GOOGLE_HOME_REDIRECT_URI,
        code,
        grant_type: "authorization_code",
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`falha ao trocar code por token do Google Home (${res.status}): ${detail}`);
    }

    return res.json() as Promise<{ access_token: string; refresh_token: string; expires_in: number }>;
  }

  // wrapper genérico pra chamar a Smart Device Management API já com o token
  // válido. `resourcePath` é relativo a https://smartdevicemanagement.googleapis.com/v1/
  // (ex: "enterprises/{projeto}/devices" ou "enterprises/{p}/devices/{d}:executeCommand")
  private async apiRequest<T = unknown>(
    method: "GET" | "POST",
    resourcePath: string,
    body?: unknown
  ): Promise<T> {
    const token = await this.ensureValidAccessToken();
    const url = `https://smartdevicemanagement.googleapis.com/v1/${resourcePath}`;

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Smart Device Management API respondeu ${res.status}: ${detail}`);
    }

    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  private setStatus(status: GoogleHomeStatus): void {
    this.status = status;
    wsHub.broadcast("google-home", "status", { status });
  }
}

export const googleHomeService = new GoogleHomeService();
