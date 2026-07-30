import { logger } from "../../core/logger.js";
import { instagramService } from "../instagram/index.js";

// "posta essa foto <url> no instagram com a legenda <texto>"
const PUBLISH_PHOTO_RE =
  /\bposta(?:r)?\s+(?:essa\s+)?(?:foto|imagem)\s+(https?:\/\/\S+)\s+no\s+instagram(?:\s+com\s+(?:a\s+)?legenda\s+(.+))?/i;

const LAST_POSTS_RE = /\b(quais? (?:foram|s[ãa]o) (?:os|as)?\s*(?:[uú]ltim[oa]s)? posts?|meus posts|posts? do instagram)\b/i;

const FOLLOWERS_RE = /\bquantos seguidores (?:eu\s+)?tenho no instagram\b/i;

const REQUIRES_CONTEXT_RE = /\binstagram\b/i;

/**
 * Trata comandos de Instagram no chat/voz. Retorna a resposta da Ley quando a
 * mensagem é um comando reconhecido, ou `null` pra seguir o caminho normal (LLM).
 */
export async function handleInstagramFlow(message: string): Promise<string | null> {
  const publishMatch = message.match(PUBLISH_PHOTO_RE);
  if (publishMatch) {
    const [, imageUrl, caption] = publishMatch;
    try {
      const result = await instagramService.publishPhoto(imageUrl, (caption ?? "").trim());
      return result.permalink
        ? `Postei no Instagram! Link: ${result.permalink}`
        : "Postei no Instagram!";
    } catch (err) {
      logger.error({ err }, "falha ao publicar no Instagram");
      return `Não consegui publicar no Instagram agora: ${(err as Error).message}`;
    }
  }

  if (!REQUIRES_CONTEXT_RE.test(message)) return null;

  if (LAST_POSTS_RE.test(message)) {
    try {
      const media = await instagramService.listMedia(5);
      if (!media.length) return "Você ainda não tem posts no Instagram.";
      const list = media
        .map((m) => `- ${m.caption?.slice(0, 60) || "(sem legenda)"} (${m.likeCount} curtidas)`)
        .join("\n");
      return `Seus últimos posts no Instagram:\n${list}`;
    } catch (err) {
      return `Não consegui buscar seus posts: ${(err as Error).message}`;
    }
  }

  if (FOLLOWERS_RE.test(message)) {
    const { profile } = instagramService.getSnapshot();
    if (!profile) return "O Instagram não está conectado ainda.";
    return `Conectado como @${profile.username} no Instagram.`;
  }

  return null;
}
