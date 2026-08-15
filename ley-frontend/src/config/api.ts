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

const LOCAL_BACKEND_URL = 'http://localhost:3000'
const STORAGE_KEY = 'ley_backend_mode' // 'local' | ausente (= produção/atual)

const rawApiUrl = (import.meta.env.VITE_API_URL as string | undefined)?.trim()
const productionUrl =
  rawApiUrl && rawApiUrl.length > 0 ? rawApiUrl.replace(/\/+$/, '') : LOCAL_BACKEND_URL

// permite trocar em runtime pro backend local sem precisar rebuildar o
// front — útil pra usar o painel publicado (leyy.onrender.com) apontando
// pro seu próprio backend rodando em localhost:3000 durante testes. Fica
// salvo no navegador (localStorage), então persiste entre sessões até você
// trocar de volta.
const backendModeOverride = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null

export const API_BASE_URL = backendModeOverride === 'local' ? LOCAL_BACKEND_URL : productionUrl

// deriva o endereço do WebSocket a partir da mesma URL: http -> ws, https -> wss
export const WS_BASE_URL = `${API_BASE_URL.replace(/^http/, 'ws')}/ws`

export type BackendMode = 'production' | 'local'

export function getBackendMode(): BackendMode {
  return backendModeOverride === 'local' ? 'local' : 'production'
}

// troca o modo e recarrega a página — precisa recarregar porque API_BASE_URL/
// WS_BASE_URL são constantes fixadas na primeira leitura do módulo, usadas
// por vários componentes; não dá pra torná-las reativas sem reescrever tudo
// que já importa esses valores direto.
export function setBackendMode(mode: BackendMode): void {
  if (mode === 'local') window.localStorage.setItem(STORAGE_KEY, 'local')
  else window.localStorage.removeItem(STORAGE_KEY)
  window.location.reload()
}
