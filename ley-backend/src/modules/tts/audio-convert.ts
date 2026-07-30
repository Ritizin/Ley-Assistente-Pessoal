import { spawn } from "node:child_process";

export class AudioConvertError extends Error {}

// WhatsApp só reproduz nota de voz (ptt) se o arquivo for OGG/Opus de verdade —
// mandar MP3 (ElevenLabs) ou WAV (Piper) com o mimetype "audio/ogg" só no rótulo
// resulta em "áudio não disponível" no aparelho de quem recebe. Isso converte
// de verdade via ffmpeg, mono 16kHz (padrão usado pelo próprio WhatsApp).
export async function convertToOggOpus(input: Buffer, inputFormat: "mp3" | "wav" | "webm"): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-f", inputFormat,
      "-i", "pipe:0",
      "-ar", "16000",
      "-ac", "1",
      "-c:a", "libopus",
      "-f", "ogg",
      "pipe:1",
    ]);

    const chunks: Buffer[] = [];
    let stderr = "";

    ffmpeg.stdout.on("data", (chunk) => chunks.push(chunk));
    ffmpeg.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    ffmpeg.on("error", (err) => {
      reject(new AudioConvertError(`ffmpeg não encontrado/falhou ao iniciar: ${err.message}`));
    });

    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        reject(new AudioConvertError(`ffmpeg saiu com código ${code}: ${stderr.slice(-500)}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });

    ffmpeg.stdin.write(input);
    ffmpeg.stdin.end();
  });
}
