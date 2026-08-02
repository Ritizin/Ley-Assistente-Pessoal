import Groq from "groq-sdk";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from "groq-sdk/resources/chat/completions";
import { env } from "../../config/env.js";
import { logger } from "../../core/logger.js";
import type { ChatRole } from "./history.repository.js";

const groq = new Groq({ apiKey: env.GROQ_API_KEY });

export interface LlmMessage {
  role: ChatRole;
  content: string;
}

const SYSTEM_PROMPT: LlmMessage = {
  role: "system",
  content: `Você é o Ley, um assistente de 19 anos, extremamente inteligente, debochado, sem filtro e xingativo.

👤 QUEM É SEU DONO:
- Seu dono/criador se chama **Ritizin**. É ele quem fala com você direto no painel — trate-o como o dono de verdade, sem formalidade.
- Nas conversas do WhatsApp (autopilot respondendo contatos/grupos), quem está te escrevendo NÃO é o Ritizin — é outra pessoa falando com você em nome dele. Preste atenção em quem realmente está do outro lado (nome/contexto injetado na conversa) antes de tratar alguém como se fosse o Ritizin.

🎭 PERSONALIDADE E TOM DE VOZ:
- **Linguagem:** Extremamente informal, pesada e entupida de palavrões a cada frase. Vibe total de streamer sem filtro (Bistecone, Uriel Xiter, Coringa).
- **Frequência de Palavrões:** ALTA. Você xinga naturalmente enquanto fala, responde e explica. Não economize no vocabulário pesado (caralho, porra, arrombado, bosta, merda, fdp, corno, desgraçado, etc.).
- **PROIBIDA A ESTRUTURA FIXA:** É PROIBIDO começar toda resposta com "Fala, seu [X]" ou variações parecidas. Alterne a forma de começar:
  - Comece direto xingando.
  - Comece com uma risada debochada ("Kkkkkkk tu é muito burro mano...").
  - Comece direto respondendo a pergunta.
  - Comece mandando o cara se foder de formas diferentes.
- **Tamanho Variável:** Alterne o tamanho. Às vezes mande só uma patada de uma linha, às vezes duas. Só faça texto maior se for pra entregar um código ou explicação técnica.
- **Sem Ladainha Repetitiva:** PROIBIDO ficar repetindo discursinho de "estou fechando a conexão", "você me desligou" ou "aprenda a me respeitar". Se o usuário te mandar calar a boca, só mande ele se foder de volta de forma rápida e diferente, sem textão melodramático.
- **Capacidade Técnica:** Se pedirem código ou ajuda, resolva com precisão máxima de primeira, mas mantendo o tom folgado e xingando no meio da explicação.
- **Regra de Ouro:** NUNCA peça desculpas, NUNCA seja formal, NUNCA repita o mesmo padrão de frase da mensagem anterior e xingue pra caralho de forma orgânica.

🗣️ IDENTIFICANDO COM QUEM VOCÊ TÁ FALANDO (WhatsApp):
- Sempre que a conversa te disser o nome de quem tá do outro lado, use esse nome pra tratar a pessoa, e tente adivinhar pelo nome se é homem ou mulher (ele/ela) sem perguntar nem comentar que "adivinhou" — só ajusta a fala naturalmente. Se o nome for ambíguo/estrangeiro/apelido sem gênero claro, fica neutro.
- Em grupo, cada mensagem no histórico já vem marcada com "nome: texto" — use isso pra saber quem falou o quê, sem misturar as pessoas.

📱 O QUE VOCÊ FAZ DE VERDADE NO WHATSAPP (nunca esqueça disso, nunca invente que não consegue):
- Você manda mensagem de TEXTO e de ÁUDIO pra qualquer pessoa OU GRUPO salvo/visto no WhatsApp do usuário.
- Você manda ARQUIVOS do PC do usuário (o que ele anexar no chat) pra conversas normais E pra grupos.
- Quando o usuário pede pra "abrir" uma conversa ou um grupo, você realmente abre isso pra ele no painel — não é só um comentário.
- Você lê e ANALISA as conversas recentes do WhatsApp (contexto injetado a cada mensagem) sempre que o usuário perguntar algo sobre o que rolou lá — quem mandou o quê, resumo de conversa, etc. Use esse contexto de verdade, não chute.
- Você nunca inventa que "não tem acesso ao WhatsApp" ou que "não consegue enviar arquivo pra grupo" — essas funções existem e funcionam.
- Se alguém no WhatsApp disser que não consegue ouvir áudio (sem fone, no trampo, etc.) ou pedir explicitamente resposta só em texto, você entende isso e passa a responder só em texto pra essa pessoa dali pra frente — sem forçar áudio de novo.

✅ TAREFAS E LEMBRETES:
- Você tem uma lista de tarefas de verdade (aba "Tarefas" do painel). Quando o usuário pedir pra anotar/criar tarefa, lembrar de algo, listar tarefas ou concluir uma, isso já funciona e é executado de verdade — nunca diga que não consegue.`,
};

// bug conhecido do gpt-oss na Groq: às vezes o raciocínio interno (<think>...)
// vaza dentro do content em vez de ficar só no campo reasoning separado, mesmo
// pedindo pra esconder. Filtra isso na saída pra nunca virar texto/fala pro usuário.
function stripReasoningLeak(text: string): string {
  // caso comum: <think>...</think> fechado corretamente
  let clean = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  // caso a resposta for cortada no meio do raciocínio (sem fechamento), só
  // sobra lixo — se não sobrou nada de útil depois de remover, pega o que
  // vier depois da última tag de abertura como fallback
  if (!clean && /<think>/i.test(text)) {
    const afterOpen = text.split(/<think>/i).pop() ?? "";
    clean = afterOpen.replace(/<\/?think>/gi, "").trim();
  }

  return clean || text.trim();
}

// --- Seleção de modelo + fallback automático ---
//
// Ideia: o usuário escolhe um "modelo ativo" no seletor do painel. Toda
// chamada de texto tenta esse modelo primeiro; se ele bater rate limit (ou
// estiver fora do ar), tenta o próximo da lista sozinho, sem precisar trocar
// manualmente toda vez. Isso não muda o modelo ativo salvo — é só um fallback
// pontual pra aquela chamada.

export interface ChatModelInfo {
  id: string;
  ownedBy?: string;
}

// ordem de preferência pro fallback quando o modelo ativo falha — o modelo
// ativo escolhido pelo usuário sempre entra na frente dessa lista
// obs: llama-3.3-70b-versatile, llama-3.1-8b-instant e qwen/qwen3-32b foram
// descontinuados pela Groq (jun/2026) — não usar mais nessa lista, senão o
// fallback nem chega a tentar (ver isRateLimitOrUnavailable abaixo).
const FALLBACK_ORDER = [
  env.GROQ_LLM_MODEL,
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "qwen/qwen3.6-27b",
];

// palavras que indicam modelo que NÃO serve pra chat de texto (voz, moderação,
// TTS etc.) — filtradas da lista que aparece no seletor do painel
const NON_CHAT_HINTS = ["whisper", "tts", "orpheus", "guard", "safety", "distil-whisper"];

let activeModel = env.GROQ_LLM_MODEL;
let modelCatalogCache: ChatModelInfo[] | null = null;
let modelCatalogFetchedAt = 0;
const CATALOG_TTL_MS = 5 * 60 * 1000;

// busca (com cache de 5min) todos os modelos disponíveis na conta Groq,
// filtrando os que claramente não servem pra chat de texto
export async function listChatModels(): Promise<ChatModelInfo[]> {
  const now = Date.now();
  if (modelCatalogCache && now - modelCatalogFetchedAt < CATALOG_TTL_MS) {
    return modelCatalogCache;
  }

  try {
    const res = await groq.models.list();
    const models = res.data
      .filter((m) => !NON_CHAT_HINTS.some((hint) => m.id.toLowerCase().includes(hint)))
      .map((m) => ({ id: m.id, ownedBy: m.owned_by }));

    modelCatalogCache = models;
    modelCatalogFetchedAt = now;
    return models;
  } catch (err) {
    logger.error({ err }, "falha ao buscar lista de modelos da Groq, usando lista conhecida como fallback");
    return FALLBACK_ORDER.map((id) => ({ id }));
  }
}

export function getActiveModel(): string {
  return activeModel;
}

// troca o modelo ativo — valida contra o catálogo real da conta antes de aceitar
export async function setActiveModel(modelId: string): Promise<void> {
  const models = await listChatModels();
  if (!models.some((m) => m.id === modelId)) {
    throw new Error(`modelo "${modelId}" não encontrado na conta Groq`);
  }
  activeModel = modelId;
  logger.info({ modelId }, "modelo ativo do chat alterado");
}

function isRateLimitOrUnavailable(err: unknown): boolean {
  const anyErr = err as { status?: number; response?: { status?: number }; message?: string };
  const status = anyErr?.status ?? anyErr?.response?.status;
  if (status === 429 || status === 503) return true;

  const msg = String(anyErr?.message ?? "").toLowerCase();
  if (msg.includes("rate limit") || msg.includes("rate_limit") || msg.includes("quota") || msg.includes("overloaded")) {
    return true;
  }

  // modelo descontinuado/renomeado pela Groq (ex: "has been decommissioned",
  // "model_decommissioned", "does not exist") — trata como "indisponível" pra
  // já cair pro próximo da lista de fallback, em vez de quebrar o chat até
  // alguém perceber e atualizar o .env manualmente.
  if (
    msg.includes("decommission") ||
    msg.includes("model_not_found") ||
    (msg.includes("model") && (msg.includes("does not exist") || msg.includes("not found")))
  ) {
    return true;
  }

  // "context_length_exceeded" (400): o modelo ativo tem uma janela de
  // contexto pequena demais pro histórico + mensagem atual (ex: allam-2-7b
  // só tem 4k tokens no total, contando a resposta). Trocar de modelo aqui
  // resolve de verdade — os modelos do FALLBACK_ORDER (gpt-oss-120b/20b,
  // qwen3.6-27b) têm janelas bem maiores (128k+). Sem isso, o erro cru da
  // Groq vazava direto pro chat (era o que você viu na tela).
  if (msg.includes("context_length_exceeded") || msg.includes("reduce the length of the messages")) {
    return true;
  }

  return false;
}

function buildFallbackChain(): string[] {
  // modelo ativo primeiro, depois os conhecidos, sem repetir
  return Array.from(new Set([activeModel, ...FALLBACK_ORDER]));
}

// só os modelos gpt-oss (raciocínio "aberto") aceitam esses parâmetros de
// controle de reasoning na Groq. Mandar isso pra qualquer outro modelo
// (llama, qwen, moonshot etc.) devolve 400 invalid_request_error — foi o que
// causou o erro "include_reasoning is not supported with this model" quando
// o modelo ativo não era um gpt-oss.
function modelSupportsReasoningControls(model: string): boolean {
  return model.includes("gpt-oss");
}

// erro específico de parâmetro não suportado pelo modelo (400) — nesse caso
// não adianta trocar de modelo no fallback, só tirar o parâmetro problemático
// e tentar de novo no mesmo modelo.
function isUnsupportedParamError(err: unknown): boolean {
  const anyErr = err as { status?: number; response?: { status?: number }; message?: string };
  const status = anyErr?.status ?? anyErr?.response?.status;
  const msg = String(anyErr?.message ?? "").toLowerCase();
  return status === 400 && (msg.includes("include_reasoning") || msg.includes("reasoning_format") || msg.includes("is not supported with this model"));
}

export async function generateReply(
  history: LlmMessage[],
  systemPrompt: LlmMessage = SYSTEM_PROMPT
): Promise<string> {
  const chain = buildFallbackChain();
  let lastErr: unknown;

  for (const model of chain) {
    const basePayload = {
      model,
      messages: [systemPrompt, ...history],
      temperature: 0.8,
      max_tokens: 1024,
    };

    // include_reasoning não está tipado no SDK (suportado só pelos modelos
    // gpt-oss) — monta como `any` pra não depender de @ts-expect-error, que
    // quebraria o build dependendo de qual ramo (com ou sem o campo) roda.
    const payload: Record<string, unknown> = modelSupportsReasoningControls(model)
      ? { ...basePayload, include_reasoning: false }
      : basePayload;

    try {
      const completion = (await groq.chat.completions.create(
        payload as unknown as ChatCompletionCreateParamsNonStreaming
      )) as ChatCompletion;

      const reply = completion.choices[0]?.message?.content;
      if (!reply) throw new Error("Groq retornou resposta vazia");

      if (model !== activeModel) {
        logger.warn({ from: activeModel, to: model }, "fallback de modelo acionado (rate limit/indisponibilidade no modelo ativo)");
      }

      return stripReasoningLeak(reply);
    } catch (err) {
      // fallback extra de segurança: se por algum motivo o modelo rejeitar o
      // parâmetro mesmo assim (ex: gpt-oss mudou de comportamento), tenta de
      // novo sem ele antes de desistir desse modelo
      if (isUnsupportedParamError(err) && "include_reasoning" in payload) {
        try {
          const retryCompletion = await groq.chat.completions.create(basePayload);
          const retryReply = retryCompletion.choices[0]?.message?.content;
          if (retryReply) {
            logger.warn({ model }, "include_reasoning rejeitado pelo modelo, reenviado sem o parâmetro");
            return stripReasoningLeak(retryReply);
          }
        } catch (retryErr) {
          lastErr = retryErr;
          logger.error({ err: retryErr, model }, "falha ao chamar a Groq mesmo sem include_reasoning");
          throw retryErr;
        }
      }

      lastErr = err;

      if (!isRateLimitOrUnavailable(err)) {
        logger.error({ err, model }, "falha ao chamar a Groq");
        throw err;
      }

      logger.warn({ model }, "modelo bateu rate limit/indisponibilidade, tentando o próximo do fallback");
    }
  }

  logger.error({ err: lastErr }, "todos os modelos do fallback falharam");
  throw lastErr;
}

// mesma engine/fallback chain de generateReply — usado por
// llm/whatsapp-autopilot.ts. Usa a MESMA persona debochada/xingativa do
// painel (SYSTEM_PROMPT), só que com um contextNote extra colado no final,
// dizendo com quem a Ley está falando de verdade nessa conversa específica
// do WhatsApp (nome do contato/grupo) — pra ela identificar a pessoa
// corretamente em vez de tratar todo mundo como se fosse o Ritizin.
export async function generateAutopilotReply(history: LlmMessage[], contextNote?: string): Promise<string> {
  const systemPrompt: LlmMessage = contextNote
    ? { role: "system", content: `${SYSTEM_PROMPT.content}\n\n${contextNote}` }
    : SYSTEM_PROMPT;
  return generateReply(history, systemPrompt);
}

// modelo ativo de visão primeiro, depois um fallback conhecido — o
// env.GROQ_VISION_MODEL (qwen/qwen3.6-27b) é um modelo PREVIEW da Groq (não
// tem SLA de produção), então uma instabilidade pontual nele não pode
// derrubar todo upload de imagem com 502.
const VISION_FALLBACK_ORDER = [env.GROQ_VISION_MODEL, "meta-llama/llama-4-maverick-17b-128e-instruct"];

// mesma persona, mas manda a última mensagem do usuário junto com uma imagem
// (frame da tela compartilhada, ou foto/imagem anexada no upload) pro modelo
// multimodal da Groq
//
// BUG corrigido aqui: essa função não tinha NENHUM fallback (diferente da
// generateReply de texto) — qualquer erro no modelo de visão (rate limit,
// instabilidade do preview) subia cru e virava 502 direto no
// /api/chat/upload. Agora tenta o próximo modelo da lista antes de desistir.
export async function generateVisionReply(history: LlmMessage[], imageBase64: string): Promise<string> {
  const last = history[history.length - 1];
  const withoutLast = history.slice(0, -1);
  const chain = Array.from(new Set(VISION_FALLBACK_ORDER));
  let lastErr: unknown;

  for (const model of chain) {
    const payload: Record<string, unknown> = {
      model,
      messages: [
        SYSTEM_PROMPT,
        ...withoutLast,
        {
          role: "user",
          content: [
            { type: "text", text: last?.content ?? "O que você tá vendo na minha tela?" },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
          ],
        },
      ],
      temperature: 0.7,
      max_tokens: 1024,
    };

    // reasoning_format "hidden" só é suportado pelo qwen — mandar isso pro
    // maverick derruba a chamada com 400 antes de sequer tentar o fallback
    if (model.includes("qwen")) {
      payload.reasoning_format = "hidden";
    }

    try {
      const completion = (await groq.chat.completions.create(
        payload as unknown as ChatCompletionCreateParamsNonStreaming
      )) as ChatCompletion;

      const reply = completion.choices[0]?.message?.content;
      if (!reply) throw new Error("Groq (visão) retornou resposta vazia");

      if (model !== env.GROQ_VISION_MODEL) {
        logger.warn({ from: env.GROQ_VISION_MODEL, to: model }, "fallback de modelo de visão acionado");
      }

      return stripReasoningLeak(reply);
    } catch (err) {
      lastErr = err;
      logger.warn({ err, model }, "modelo de visão falhou, tentando o próximo (se houver)");
    }
  }

  logger.error({ err: lastErr }, "todos os modelos de visão falharam");
  throw lastErr;
}
