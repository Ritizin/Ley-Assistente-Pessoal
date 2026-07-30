import { env } from "../../config/env.js";

// "Adam" — voz masculina grave, uma das mais usadas pra tom estilo Jarvis/assistente
export const JARVIS_DEFAULT_VOICE_ID = "pNInz6obpgDQGcFmaJgB";

export interface TtsResult {
  audio: Buffer;
  contentType: string;
}

export class TtsUpstreamError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "TtsUpstreamError";
  }
}

// gera o áudio via ElevenLabs. Lança TtsUpstreamError com o status original
// (401 chave inválida / 402 cota esgotada / etc) pra rota decidir o que devolver.
export async function synthesizeSpeech(text: string): Promise<TtsResult> {
  const voiceId = env.ELEVENLABS_VOICE_ID || JARVIS_DEFAULT_VOICE_ID;

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
      "xi-api-key": env.ELEVENLABS_API_KEY,
    },
    body: JSON.stringify({
      text,
      model_id: env.ELEVENLABS_MODEL_ID,
      voice_settings: {
        stability: 0.55,       // grave/estável, menos "tremido"
        similarity_boost: 0.8,
        style: 0.15,
        use_speaker_boost: true,
      },
    }),
    // sem isso, uma instabilidade de rede/API trava aqui por muito tempo
    // (fetch do Node não tem timeout próprio) antes de cair pro Piper
    signal: AbortSignal.timeout(6_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new TtsUpstreamError(res.status, detail || `ElevenLabs respondeu ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return { audio: Buffer.from(arrayBuffer), contentType: "audio/mpeg" };
}
