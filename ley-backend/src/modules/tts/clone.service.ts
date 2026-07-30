import { env } from "../../config/env.js";

export class CloneTtsError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "CloneTtsError";
  }
}

export interface CloneTtsResult {
  audio: Buffer;
  contentType: string;
}

// Chama o servidor de TTS com a voz clonada (ex: exposto via ngrok, rodando
// localmente na sua máquina). Fica como 1ª camada do pipeline quando
// CLONE_TTS_URL está configurada; não altera texto, prompt ou personalidade —
// só troca QUEM fala o texto que o LLM já decidiu.
export async function synthesizeSpeechClone(text: string): Promise<CloneTtsResult> {
  if (!env.CLONE_TTS_URL) {
    throw new CloneTtsError(0, "CLONE_TTS_URL não configurada");
  }

  const res = await fetch(env.CLONE_TTS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      language: env.CLONE_TTS_LANGUAGE,
    }),
    // mesmo motivo do timeout na ElevenLabs: evita travar aqui indefinidamente
    signal: AbortSignal.timeout(6_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new CloneTtsError(res.status, detail || `voz clonada respondeu ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  // o endpoint devolve .wav (como no seu teste via curl)
  return { audio: Buffer.from(arrayBuffer), contentType: "audio/wav" };
}
