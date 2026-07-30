import { logger } from "../../core/logger.js";
import { spotifyService } from "../spotify/index.js";

// ordem importa: do mais específico (com música) pro mais genérico (comandos soltos)
const PLAY_QUERY_RE =
  /\b(toca|tocar|coloca|colocar|p[oõ]e|põe|bota)\b(?:\s+(?:a|essa|uma)?\s*m[uú]sica)?\s+(.+)/i;

const RESUME_RE = /\b(continua|continuar|despausa|despausar|volta a tocar|retoma|retomar)\b/i;
const PAUSE_RE = /\b(pausa|pausar|para a m[uú]sica|para o spotify|p[aá]ra a m[uú]sica|silencia)\b/i;
const NEXT_RE = /\b(pr[oó]xima|pula|pular|passa essa|next)\b/i;
const PREVIOUS_RE = /\b(anterior|volta a m[uú]sica|m[uú]sica anterior|voltar m[uú]sica)\b/i;
const WHATS_PLAYING_RE = /\b(que m[uú]sica [ée] essa|o que t[aá] tocando|qual m[uú]sica [ée] essa)\b/i;

// exige "spotify" ou "música" na frase pra não disparar à toa em conversas
// comuns que usem palavras parecidas (ex: "pula essa parte da explicação")
const REQUIRES_CONTEXT_RE = /\b(spotify|m[uú]sica|som|zoeira)\b/i;

/**
 * Trata comandos de Spotify no chat/voz. Retorna a resposta da Ley quando a
 * mensagem é um comando de música, ou `null` pra seguir o caminho normal (LLM).
 */
export async function handleSpotifyFlow(message: string): Promise<string | null> {
  const playMatch = message.match(PLAY_QUERY_RE);
  if (playMatch) {
    const query = playMatch[2].trim().replace(/[?.!]+$/, "");
    if (!query) return null;

    try {
      const played = await spotifyService.searchAndPlay(query);
      return `Tocando "${played}" no Spotify.`;
    } catch (err) {
      logger.error({ err }, "falha ao tocar música no Spotify");
      return `Não consegui tocar isso agora: ${(err as Error).message}`;
    }
  }

  if (!REQUIRES_CONTEXT_RE.test(message)) return null;

  if (WHATS_PLAYING_RE.test(message)) {
    const { track } = spotifyService.getSnapshot();
    if (!track) return "Não tem nada tocando no Spotify agora.";
    return `Tá tocando "${track.name}" de ${track.artists}.`;
  }

  if (PAUSE_RE.test(message)) {
    try {
      await spotifyService.pause();
      return "Pausei a música.";
    } catch (err) {
      return `Não consegui pausar: ${(err as Error).message}`;
    }
  }

  if (RESUME_RE.test(message)) {
    try {
      await spotifyService.play();
      return "Voltei a tocar.";
    } catch (err) {
      return `Não consegui continuar tocando: ${(err as Error).message}`;
    }
  }

  if (NEXT_RE.test(message)) {
    try {
      await spotifyService.next();
      return "Pulei pra próxima música.";
    } catch (err) {
      return `Não consegui pular: ${(err as Error).message}`;
    }
  }

  if (PREVIOUS_RE.test(message)) {
    try {
      await spotifyService.previous();
      return "Voltei pra música anterior.";
    } catch (err) {
      return `Não consegui voltar: ${(err as Error).message}`;
    }
  }

  return null;
}
