import path from "node:path";
import { spawn } from "node:child_process";
import { env } from "../../config/env.js";

export class PiperError extends Error {}

// PIPER_BIN_PATH/PIPER_VOICE_MODEL_PATH no .env aceitam caminho absoluto OU
// relativo. path.resolve() com um único argumento já devolve o absoluto sem
// mexer (se já for absoluto) ou resolve relativo ao cwd do processo (a pasta
// de onde "npm run dev"/"node dist/server.js" é executado — normalmente
// ley-backend/). Isso evita ter que hardcodar o home de uma máquina
// específica: o ley-tts pode morar em qualquer lugar (ex: "../ley-tts/...",
// como sibling de ley-backend), só o .env precisa apontar pro lugar certo.
function requireConfiguredPath(value: string | undefined, name: string): string {
  if (!value) {
    throw new PiperError(`Piper não configurado (${name} ausente)`);
  }
  return path.resolve(value);
}

// Roda o binário do Piper localmente, sem internet e sem custo.
// Envia o texto via stdin e recebe o WAV pronto via stdout.
export async function synthesizeSpeechPiper(text: string): Promise<Buffer> {
  const piperPath = requireConfiguredPath(env.PIPER_BIN_PATH, "PIPER_BIN_PATH");
  const modelPath = requireConfiguredPath(env.PIPER_VOICE_MODEL_PATH, "PIPER_VOICE_MODEL_PATH");

  return new Promise<Buffer>((resolve, reject) => {
    const piper = spawn(piperPath, [
      "--model", modelPath,
      "--output_file", "-", // stdout
    ]);

    const chunks: Buffer[] = [];
    let stderr = "";

    if (!piper.stdout || !piper.stderr || !piper.stdin) {
      reject(new PiperError("Piper não retornou streams válidos"));
      return;
    }

    piper.stdout.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    piper.stderr.on("data", (chunk: Buffer | string) => { stderr += Buffer.isBuffer(chunk) ? chunk.toString() : chunk; });

    piper.on("error", (err: Error) => reject(new PiperError(`Falha ao executar Piper: ${err.message}`)));

    piper.on("close", (code: number | null) => {
      if (code !== 0) {
        reject(new PiperError(`Piper saiu com código ${code}: ${stderr}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });

    piper.stdin.write(text);
    piper.stdin.end();
  });
}
