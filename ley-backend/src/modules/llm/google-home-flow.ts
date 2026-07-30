import { logger } from "../../core/logger.js";
import { googleHomeService } from "../google-home/index.js";

// "coloca o termostato/a temperatura da sala em 22 graus"
const SET_TEMP_RE =
  /\b(?:coloca|ajusta|deixa)\s+(?:o\s+termostato|a\s+temperatura)(?:\s+d[aeo]\s+([a-zà-ú\s]+?))?\s+em\s+(\d{1,2})\s*graus/i;

const HEAT_ON_RE = /\b(liga|ativa)\s+(?:o\s+)?(aquecimento|aquecedor|calefação)/i;
const COOL_ON_RE = /\b(liga|ativa)\s+(?:o\s+)?(ar[\s-]?condicionado|refrigera[çc][ãa]o)/i;
const OFF_RE = /\b(desliga|desativa)\s+(?:o\s+)?(termostato|aquecimento|aquecedor|ar[\s-]?condicionado)/i;
const STATUS_RE = /\bqual\s+(?:a\s+)?temperatura(?:\s+d[aeo]\s+([a-zà-ú\s]+))?\b/i;

const REQUIRES_CONTEXT_RE = /\b(termostato|temperatura|aquecimento|ar[\s-]?condicionado|casa inteligente|google home)\b/i;

/**
 * Trata comandos de Google Home (dispositivos Nest) no chat/voz. Retorna a
 * resposta da Ley quando reconhecido, ou `null` pra seguir o caminho normal (LLM).
 */
export async function handleGoogleHomeFlow(message: string): Promise<string | null> {
  if (!REQUIRES_CONTEXT_RE.test(message)) return null;

  const tempMatch = message.match(SET_TEMP_RE);
  if (tempMatch) {
    const [, room, degrees] = tempMatch;
    const device = googleHomeService.findDevice(room ?? "");
    if (!device) return "Não achei nenhum termostato conectado no Google Home.";

    try {
      await googleHomeService.setThermostatTemperature(device.id, Number(degrees), "heat");
      return `Ajustei o termostato "${device.name}" pra ${degrees}°C.`;
    } catch (err) {
      logger.error({ err }, "falha ao ajustar temperatura do Google Home");
      return `Não consegui ajustar a temperatura: ${(err as Error).message}`;
    }
  }

  if (HEAT_ON_RE.test(message)) {
    const device = googleHomeService.findDevice("");
    if (!device) return "Não achei nenhum termostato conectado no Google Home.";
    try {
      await googleHomeService.setThermostatMode(device.id, "HEAT");
      return `Liguei o aquecimento no "${device.name}".`;
    } catch (err) {
      return `Não consegui ligar o aquecimento: ${(err as Error).message}`;
    }
  }

  if (COOL_ON_RE.test(message)) {
    const device = googleHomeService.findDevice("");
    if (!device) return "Não achei nenhum termostato conectado no Google Home.";
    try {
      await googleHomeService.setThermostatMode(device.id, "COOL");
      return `Liguei o ar-condicionado no "${device.name}".`;
    } catch (err) {
      return `Não consegui ligar o ar-condicionado: ${(err as Error).message}`;
    }
  }

  if (OFF_RE.test(message)) {
    const device = googleHomeService.findDevice("");
    if (!device) return "Não achei nenhum termostato conectado no Google Home.";
    try {
      await googleHomeService.setThermostatMode(device.id, "OFF");
      return `Desliguei o "${device.name}".`;
    } catch (err) {
      return `Não consegui desligar: ${(err as Error).message}`;
    }
  }

  const statusMatch = message.match(STATUS_RE);
  if (statusMatch) {
    const device = googleHomeService.findDevice(statusMatch[1] ?? "");
    if (!device) return "Não achei nenhum termostato conectado no Google Home.";
    if (device.ambientTemperatureCelsius == null) {
      return `Não tenho leitura de temperatura pro "${device.name}" agora.`;
    }
    return `A temperatura no "${device.name}" tá em ${device.ambientTemperatureCelsius.toFixed(1)}°C.`;
  }

  return null;
}
