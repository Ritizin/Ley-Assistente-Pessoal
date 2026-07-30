import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../../config/env.js";
import { synthesizeSpeech, TtsUpstreamError } from "./tts.service.js";
import { synthesizeSpeechPiper, PiperError } from "./piper.service.js";
import { synthesizeSpeechClone, CloneTtsError } from "./clone.service.js";

const bodySchema = z.object({
  text: z.string().min(1).max(2000),
  sessionId: z.string().optional(), // mantém rastreio da conversa, não altera a síntese
});

export async function ttsRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/tts", async (req, reply) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "payload inválido", details: parsed.error.flatten() });
    }

    const { text } = parsed.data;

    // 1ª camada: voz clonada própria (seu servidor local via ngrok) —
    // só entra se CLONE_TTS_URL estiver configurada no .env
    try {
      const { audio, contentType } = await synthesizeSpeechClone(text);
      reply.header("Content-Type", contentType);
      return reply.send(audio);
    } catch (err) {
      if (err instanceof CloneTtsError && err.status === 0) {
        // não configurada — segue pro próximo provedor sem logar erro
      } else if (err instanceof CloneTtsError) {
        req.log.warn({ status: err.status }, "voz clonada indisponível, tentando ElevenLabs");
      } else {
        req.log.error(err, "erro inesperado na voz clonada");
      }
    }

    // 2ª camada: ElevenLabs (melhor qualidade, mas paga/com cota) — pulada
    // inteiramente quando TTS_SKIP_ELEVENLABS=true no .env
    if (!env.TTS_SKIP_ELEVENLABS) {
      try {
        const { audio, contentType } = await synthesizeSpeech(text);
        reply.header("Content-Type", contentType);
        return reply.send(audio);
      } catch (err) {
        if (!(err instanceof TtsUpstreamError)) {
          req.log.error(err, "erro inesperado no ElevenLabs");
        } else {
          req.log.warn({ status: err.status }, "ElevenLabs indisponível, tentando Piper (local/grátis)");
        }
      }
    }

    // 3ª camada: Piper local (grátis, offline, voz masculina) — não depende de crédito nenhum
    try {
      const audio = await synthesizeSpeechPiper(text);
      reply.header("Content-Type", "audio/wav");
      return reply.send(audio);
    } catch (err) {
      if (err instanceof PiperError) {
        req.log.warn({ msg: err.message }, "Piper indisponível, frontend cai pro navegador");
      } else {
        req.log.error(err, "erro inesperado no Piper");
      }
    }

    // 4ª camada: nenhum TTS de servidor disponível — o frontend já sabe cair
    // pro speechSynthesis do navegador quando recebe erro aqui
    return reply.code(503).send({ error: "tts_unavailable" });
  });
}
