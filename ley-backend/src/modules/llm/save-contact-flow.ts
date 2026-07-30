import { whatsappService } from "../whatsapp/index.js";
import { phoneQueryToJid } from "../whatsapp/whatsapp.service.js";
import { withAction } from "./action-marker.js";

// dispara em "salva/memoriza/guarda/adiciona ... contato ..."
const TRIGGER_RE = /\b(salva|salvar|memoriza|memorizar|guarda|guardar|adiciona|adicionar)\b.*\bcontato\b/i;

// pega um número de telefone em qualquer lugar da frase (com DDD/DDI, com ou
// sem espaços/traços/parênteses)
const NUMBER_RE = /(\+?\d[\d\s().-]{6,}\d)/;

// palavras de ligação descartadas na hora de isolar o nome. Comparamos token a
// token (não com regex \b na frase inteira) porque \b no JS só reconhece
// letras ASCII como "de palavra" — em nomes com acento (João, José) ele
// cortava letras no meio do nome.
const STOPWORDS = new Set([
  "salva", "salvar", "memoriza", "memorizar", "guarda", "guardar",
  "adiciona", "adicionar", "contato", "o", "a", "do", "da", "de", "com",
  "numero", "número", "chamado", "como",
]);

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Trata "salva o contato Fulano com o número 11999998888". Retorna a resposta
 * quando a mensagem é esse comando, ou `null` pra seguir o fluxo normal.
 */
export function handleSaveContactFlow(message: string): string | null {
  if (!TRIGGER_RE.test(message)) return null;

  const numberMatch = message.match(NUMBER_RE);
  if (!numberMatch) {
    return `Beleza, só falta o número — me manda de novo com o DDD (ex: "salva o contato Fulano, 11999998888").`;
  }

  const digits = numberMatch[1].replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) {
    return `Esse número não parece completo. Confere com o DDD e manda de novo.`;
  }

  const withoutNumber = message.replace(numberMatch[1], " ");

  const name = withoutNumber
    .split(/\s+/)
    .map((token) => token.replace(/^[.,:;!?()]+|[.,:;!?()]+$/g, ""))
    .filter((token) => {
      if (!token) return false;
      const clean = stripAccents(token).toLowerCase();
      return !STOPWORDS.has(clean);
    })
    .join(" ")
    .trim();

  if (!name) {
    return `Beleza, qual nome eu salvo pro número ${digits}?`;
  }

  const jid = phoneQueryToJid(digits);
  if (!jid) {
    return `Esse número não parece completo. Confere com o DDD e manda de novo.`;
  }
  whatsappService.saveContact(name, jid);

  return withAction(
    `Contato salvo: ${name}`,
    `Prontinho, salvei ${name} com o número ${digits}. Já posso mandar mensagem ou áudio pra ele(a) só chamando pelo nome.`
  );
}
