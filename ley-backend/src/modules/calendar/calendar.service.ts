import { env } from "../../config/env.js";
import { logger } from "../../core/logger.js";
import { authDatabasePromise } from "../auth/index.js";

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string | null; // ISO ou "YYYY-MM-DD" quando é evento de dia inteiro
  end: string | null;
  allDay: boolean;
  location: string | null;
}

interface GoogleCalendarApiEvent {
  id: string;
  summary?: string;
  location?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
}

class CalendarService {
  // access_token tem vida curta (~1h) — cacheia em memória por e-mail
  // enquanto for válido, só troca pelo refresh_token quando expira de
  // verdade. Evita bater no endpoint de refresh a cada mensagem/consulta.
  private accessTokenCache = new Map<string, { token: string; expiresAt: number }>();

  async isConnected(email: string): Promise<boolean> {
    const authDatabase = await authDatabasePromise;
    const tokens = await authDatabase.getGoogleTokens?.(email);
    return !!tokens?.refreshToken;
  }

  private async getFreshAccessToken(email: string): Promise<string> {
    const cached = this.accessTokenCache.get(email);
    if (cached && cached.expiresAt > Date.now() + 30_000) {
      return cached.token;
    }

    const authDatabase = await authDatabasePromise;
    const tokens = await authDatabase.getGoogleTokens?.(email);
    if (!tokens?.refreshToken) {
      throw new Error("Google Agenda não conectada — faça login com o Google de novo (autorizando o acesso à agenda).");
    }

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID ?? "",
        client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
        refresh_token: tokens.refreshToken,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.error({ status: res.status, body }, "falha ao renovar token da Google Agenda");
      throw new Error("Não consegui renovar o acesso à Google Agenda. Talvez precise reconectar.");
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.accessTokenCache.set(email, {
      token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    });

    return data.access_token;
  }

  // próximos eventos a partir de agora, já ordenados (a própria API do
  // Google Calendar já devolve nessa ordem com singleEvents+orderBy)
  async listUpcomingEvents(email: string, maxResults = 10): Promise<CalendarEvent[]> {
    const accessToken = await this.getFreshAccessToken(email);

    const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    url.searchParams.set("timeMin", new Date().toISOString());
    url.searchParams.set("maxResults", String(maxResults));
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");

    const res = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.error({ status: res.status, body }, "falha ao buscar eventos da Google Agenda");
      throw new Error("Não consegui buscar os eventos da agenda agora.");
    }

    const data = (await res.json()) as { items?: GoogleCalendarApiEvent[] };

    return (data.items ?? []).map((ev) => ({
      id: ev.id,
      summary: ev.summary ?? "(sem título)",
      start: ev.start?.dateTime ?? ev.start?.date ?? null,
      end: ev.end?.dateTime ?? ev.end?.date ?? null,
      allDay: !!ev.start?.date && !ev.start?.dateTime,
      location: ev.location ?? null,
    }));
  }
}

export const calendarService = new CalendarService();
