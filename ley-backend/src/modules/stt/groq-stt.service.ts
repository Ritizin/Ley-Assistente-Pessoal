import fs from "node:fs";
import Groq from "groq-sdk";
import { env } from "../../config/env.js";
import { logger } from "../../core/logger.js";

const groq = new Groq({ apiKey: env.GROQ_API_KEY });

// transcreve um arquivo de áudio local (ogg/opus, mp3, wav...) usando o Whisper
// hospedado na Groq. Retorna null (em vez de lançar) em caso de falha — a
// mensagem/áudio já foi salvo, então preferimos guardar sem transcrição a
// perder a mensagem inteira por causa de um erro na STT.
export async function transcribeAudioFile(filePath: string): Promise<string | null> {
  try {
    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: env.GROQ_STT_MODEL,
      language: "pt",
      response_format: "text",
    });

    // com response_format "text" o SDK retorna string; mantemos o fallback
    // pro formato { text } caso o modelo/response_format mude no futuro
    const text =
      typeof transcription === "string" ? transcription : (transcription as { text?: string })?.text;

    return text?.trim() || null;
  } catch (err) {
    logger.error({ err }, "falha ao transcrever áudio com Groq Whisper");
    return null;
  }
}
