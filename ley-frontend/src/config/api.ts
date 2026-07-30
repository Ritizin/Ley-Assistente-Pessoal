// URL do backend (API + WebSocket), lida de uma variável de ambiente do
// Vite em tempo de BUILD. Sem isso, o painel funcionava só localmente
// (localhost:3000) e travava tudo (WhatsApp, Chat, Conexões etc.) parado
// em "carregando" ao publicar em produção, porque o navegador de quem
// acessa tentava falar com o "localhost" da PRÓPRIA máquina dele, não com
// o servidor de verdade rodando no Render.
//
// Como configurar:
// - Local (dev): não precisa fazer nada — cai no fallback http://localhost:3000
// - Render (produção): defina VITE_API_URL nas env vars do serviço de
//   FRONTEND, apontando pra URL pública do serviço de BACKEND, ex:
//   VITE_API_URL=https://ley-backend.onrender.com
//   (sem barra no final)

const rawApiUrl = (import.meta.env.VITE_API_URL as string | undefined)?.trim()

export const API_BASE_URL =
  rawApiUrl && rawApiUrl.length > 0 ? rawApiUrl.replace(/\/+$/, '') : 'http://localhost:3000'

// deriva o endereço do WebSocket a partir da mesma URL: http -> ws, https -> wss
export const WS_BASE_URL = `${API_BASE_URL.replace(/^http/, 'ws')}/ws`
