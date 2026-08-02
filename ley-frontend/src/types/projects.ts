// Modelo de dados dos "Projetos" (menu lateral) — cada projeto é uma pasta
// de arquivos que a Ley foi gerando/editando ao longo da conversa, igual ao
// conceito de "Projects" do Claude. Persistido no localStorage por enquanto
// (ver App.tsx); dá pra trocar por uma tabela no backend depois sem mexer
// no resto dos componentes, já que eles só dependem desses dois tipos.

export interface ProjectFile {
  path: string
  content: string
  // 'created' | 'updated' controla o selinho mostrado no painel/mensagem —
  // 'updated' quando a Ley reescreveu um arquivo que já existia no projeto.
  status: 'created' | 'updated'
}

export interface Project {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  files: ProjectFile[]
}

const STORAGE_KEY = 'ley:projects'
const ACTIVE_KEY = 'ley:activeProjectId'

export function loadProjects(): Project[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Project[]) : []
  } catch {
    return []
  }
}

export function saveProjects(projects: Project[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(projects))
}

export function loadActiveProjectId(): string | null {
  return localStorage.getItem(ACTIVE_KEY)
}

export function saveActiveProjectId(id: string | null) {
  if (id) localStorage.setItem(ACTIVE_KEY, id)
  else localStorage.removeItem(ACTIVE_KEY)
}

// Chaves de localStorage do histórico de chat de um projeto — cada projeto
// tem sua própria conversa (conversationId + mensagens na tela), separada do
// chat geral. Exportado aqui pra ChatTab.tsx e App.tsx usarem exatamente a
// mesma convenção de nome, sem duplicar a string em dois lugares.
export function projectChatKeys(id: string): { convo: string; history: string } {
  return { convo: `ley:conversationId:${id}`, history: `ley:chatHistory:${id}` }
}

// chamado ao excluir um projeto: apaga o histórico de chat dele do
// localStorage (o conversationId/mensagens no backend continuam existindo,
// só não aparecem mais em lugar nenhum do painel)
export function clearProjectChatStorage(id: string): void {
  const { convo, history } = projectChatKeys(id)
  localStorage.removeItem(convo)
  localStorage.removeItem(history)
}

// Junta arquivos recém-gerados num projeto existente: mesmo "path" sobrescreve
// (marcado como 'updated'), path novo entra como 'created'.
export function mergeFilesIntoProject(project: Project, incoming: { path: string; content: string }[]): Project {
  const files = [...project.files]

  for (const inc of incoming) {
    const idx = files.findIndex((f) => f.path === inc.path)
    if (idx >= 0) {
      files[idx] = { path: inc.path, content: inc.content, status: 'updated' }
    } else {
      files.push({ path: inc.path, content: inc.content, status: 'created' })
    }
  }

  return { ...project, files, updatedAt: Date.now() }
}
