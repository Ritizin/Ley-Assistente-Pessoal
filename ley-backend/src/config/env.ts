import { z } from "zod";
import "dotenv/config";

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  NODE_ENV: z.enum(["development", "production"]).default("development"),

  GROQ_API_KEY: z.string().min(1, "GROQ_API_KEY obrigatória"),
  GROQ_LLM_MODEL: z.string().default("openai/gpt-oss-120b"),
  GROQ_STT_MODEL: z.string().default("whisper-large-v3-turbo"),
  GROQ_VISION_MODEL: z.string().default("qwen/qwen3.6-27b"),

  ELEVENLABS_API_KEY: z.string().min(1, "ELEVENLABS_API_KEY obrigatória"),
  ELEVENLABS_VOICE_ID: z.string().min(1),
  ELEVENLABS_MODEL_ID: z.string().default("eleven_multilingual_v2"),
  // quando true, a rota /api/tts nem tenta a ElevenLabs — pula direto pro
  // Piper (ou clone, se configurada). Sem isso, toda fala paga o round-trip
  // de rede da ElevenLabs (sem timeout) antes de cair pro Piper, mesmo que
  // você só use Piper mesmo — é a causa mais comum de demora pra falar.
  TTS_SKIP_ELEVENLABS: z.coerce.boolean().default(false),

  // Voz clonada própria, servida localmente (ex: via ngrok apontando pro
  // servidor de TTS na sua máquina). Vira a 1ª camada quando configurada;
  // ElevenLabs e Piper continuam como fallback se essa cair.
  CLONE_TTS_URL: z.string().optional(),
  CLONE_TTS_LANGUAGE: z.string().default("pt"),

  WHATSAPP_SESSION_DIR: z.string().default("./storage/whatsapp-session"),
  // padrão global do autopilot (Ley responde sozinha no WhatsApp) quando não
  // existe override salvo no painel (wa_settings.autopilot_global) — default
  // false de propósito: exige 1 clique explícito no painel (ou POST em
  // /api/whatsapp/autopilot) antes de a Ley começar a falar sozinha com
  // pessoas de verdade.
  WHATSAPP_AUTOPILOT_ENABLED: z.coerce.boolean().default(false),
  GMAIL_ENCRYPTION_KEY: z.string().min(32, "precisa ter >= 32 chars"),
  WEBHOOK_SECRET: z.string().min(1),

  // Piper (TTS local, grátis, offline) — reintroduzido: tinha sumido desse
  // schema, então mesmo com o .env certo o env.PIPER_BIN_PATH virava undefined
  // (zod descarta chave não declarada no schema)
  PIPER_BIN_PATH: z.string().optional(),
  PIPER_VOICE_MODEL_PATH: z.string().optional(),

  // Spotify (OAuth Authorization Code) — painel + controle por voz/chat
  SPOTIFY_CLIENT_ID: z.string().optional(),
  SPOTIFY_CLIENT_SECRET: z.string().optional(),
  SPOTIFY_REDIRECT_URI: z.string().default("http://127.0.0.1:3000/api/spotify/callback"),

  // Instagram (Login do Facebook para Contas Profissionais/Criador) — painel +
  // publicação/leitura via voz/chat. Precisa de um App no Meta for Developers
  // com o produto "Instagram" configurado e uma Página do Facebook vinculada
  // à conta profissional do Instagram.
  INSTAGRAM_APP_ID: z.string().optional(),
  INSTAGRAM_APP_SECRET: z.string().optional(),
  INSTAGRAM_REDIRECT_URI: z.string().default("http://127.0.0.1:3000/api/instagram/callback"),
  INSTAGRAM_GRAPH_VERSION: z.string().default("v21.0"),
  // valor arbitrário que você define e usa também ao configurar o webhook no
  // painel do Meta — confirma que a chamada de verificação é legítima
  INSTAGRAM_WEBHOOK_VERIFY_TOKEN: z.string().optional(),

  // Instagram DM (API privada não-oficial, via instagram-private-api) — essa
  // é uma conta NORMAL da Ley (login usuário/senha, tipo o app de verdade),
  // separada da conta profissional acima que usa a Graph API oficial. Dá pra
  // ler/mandar DM e rodar autopilot com a mesma persona do WhatsApp. Como não
  // é API oficial, o Instagram pode bloquear/desafiar login incomum — por
  // isso a sessão fica persistida em disco (evita logar de novo a cada boot).
  INSTAGRAM_DM_USERNAME: z.string().optional(),
  INSTAGRAM_DM_PASSWORD: z.string().optional(),
  INSTAGRAM_DM_SESSION_DIR: z.string().default("./storage/instagram-dm-session"),
  // mesmo espírito do WHATSAPP_AUTOPILOT_ENABLED: default false de propósito
  // — exige 1 clique explícito no painel antes da Ley falar sozinha por DM.
  INSTAGRAM_DM_AUTOPILOT_ENABLED: z.coerce.boolean().default(false),

  // Google Home (Smart Device Management API — dispositivos Nest dentro de
  // estruturas do Google Home: termostatos, câmeras, campainhas, fechaduras).
  // Precisa de um projeto no Device Access Console (Google) além do OAuth no
  // Google Cloud Console.
  GOOGLE_HOME_CLIENT_ID: z.string().optional(),
  GOOGLE_HOME_CLIENT_SECRET: z.string().optional(),
  GOOGLE_HOME_REDIRECT_URI: z.string().default("http://127.0.0.1:3000/api/google-home/callback"),
  GOOGLE_HOME_PROJECT_ID: z.string().optional(),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().default("http://127.0.0.1:3000/auth/google/callback"),
  FRONTEND_URL: z.string().default("http://127.0.0.1:5173"),
  DATABASE_URL: z.string().optional(),
  // BUG encontrado: tinha um default público ("ley-dev-secret") — se
  // esquecesse de configurar em produção, o servidor subia normalmente,
  // MAS qualquer pessoa que soubesse desse valor (ex: lendo esse mesmo
  // arquivo no GitHub) conseguia forjar um JWT válido pra QUALQUER usuário
  // e se autenticar sem senha nenhuma. Agora só tem default fora de
  // produção; em produção é obrigatório e o boot falha sem ele.
  JWT_SECRET: z.string().min(16, "JWT_SECRET precisa ter >= 16 caracteres").optional(),
});

const rawEnv = schema.parse(process.env);

if (rawEnv.NODE_ENV === "production" && !rawEnv.JWT_SECRET) {
  throw new Error(
    "JWT_SECRET obrigatória em produção (defina uma string aleatória forte no .env — nunca use um valor padrão)"
  );
}

export const env = {
  ...rawEnv,
  JWT_SECRET: rawEnv.JWT_SECRET ?? "ley-dev-secret",
};
export type Env = z.infer<typeof schema>;
