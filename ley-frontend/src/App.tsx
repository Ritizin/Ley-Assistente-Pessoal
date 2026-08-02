import { useEffect, useState } from 'react'
import { API_BASE_URL } from './config/api'
import Sidebar, { type TabId } from './components/Sidebar'
import ChatTab from './components/ChatTab'
import TasksTab from './components/TasksTab'
import WhatsAppTab from './components/WhatsAppTab'
import ConnectionsTab from './components/ConnectionsTab'
import NotificationsTab, {
  type NotificationGroup,
  groupUnreadMessages,
  fetchUnreadNotifications,
  fetchContactNames,
  markJidSeen,
} from './components/NotificationsTab'
import { useLeyWebSocket } from './hooks/useLeyWebSocket'
import { playNotificationSound } from './utils/notificationSound'
import ProjectsPanel from './components/ProjectsPanel'
import FilesPanel from './components/FilesPanel'
import {
  type Project,
  type ProjectFile,
  loadProjects,
  saveProjects,
  loadActiveProjectId,
  saveActiveProjectId,
  mergeFilesIntoProject,
  clearProjectChatStorage,
} from './types/projects'

interface AuthUser {
  id: number
  email: string
  name?: string | null
  picture?: string | null
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('chat')
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)
  const [focusJid, setFocusJid] = useState<string | null>(null)
  const [focusName, setFocusName] = useState<string | null>(null)
  // avisos de mensagem nova no WhatsApp, agrupados por contato/grupo — vira
  // a aba "Notificações" e a bolinha de contagem no menu lateral
  const [notifications, setNotifications] = useState<NotificationGroup[]>([])

  // ---- Projetos (arquivos que a Ley cria/edita no chat) ----
  const [projects, setProjects] = useState<Project[]>(() => loadProjects())
  const [activeProjectId, setActiveProjectId] = useState<string | null>(() => loadActiveProjectId())
  const [panelOpen, setPanelOpen] = useState(false)
  const [panelFiles, setPanelFiles] = useState<ProjectFile[]>([])
  const [panelGenId, setPanelGenId] = useState(0)

  useEffect(() => {
    saveProjects(projects)
  }, [projects])

  useEffect(() => {
    saveActiveProjectId(activeProjectId)
  }, [activeProjectId])

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null

  const handleCreateProject = (name: string) => {
    const project: Project = {
      id: crypto.randomUUID(),
      name,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      files: [],
    }
    setProjects((prev) => [...prev, project])
    setActiveProjectId(project.id)
    setActiveTab('chat')
  }

  const handleOpenProject = (id: string) => {
    const project = projects.find((p) => p.id === id)
    if (!project) return
    setActiveProjectId(id)
    // abre o projeto como se fosse um chat próprio, com histórico separado
    // do chat geral (ver ChatTab.tsx — a `key` diferente força remontar com
    // o conversationId/mensagens certos)
    setActiveTab('chat')
    if (project.files.length > 0) {
      setPanelFiles(project.files)
      setPanelGenId((g) => g + 1)
      setPanelOpen(true)
    }
  }

  const handleRenameProject = (id: string, name: string) => {
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, name, updatedAt: Date.now() } : p)))
  }

  const handleDeleteProject = (id: string) => {
    setProjects((prev) => prev.filter((p) => p.id !== id))
    clearProjectChatStorage(id)
    if (activeProjectId === id) {
      setActiveProjectId(null)
    }
  }

  // chamado pelo ChatTab toda vez que uma resposta da Ley traz arquivo(s)
  // (bloco ```linguagem path="..."). Se tiver um projeto ativo, os arquivos
  // entram nele (criados ou editados); senão ficam "soltos" no painel, com
  // opção de virar projeto depois.
  const handleFilesGenerated = (files: { path: string; content: string }[]) => {
    if (files.length === 0) return

    if (activeProject) {
      const updated = mergeFilesIntoProject(activeProject, files)
      setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
      setPanelFiles(updated.files.filter((f) => files.some((inc) => inc.path === f.path)))
    } else {
      setPanelFiles(files.map((f) => ({ ...f, status: 'created' as const })))
    }
    setPanelGenId((g) => g + 1)
    setPanelOpen(true)
  }

  const handleSaveUnsavedAsProject = () => {
    const name = window.prompt('Nome do projeto:')
    if (!name?.trim()) return
    const project: Project = {
      id: crypto.randomUUID(),
      name: name.trim(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      files: panelFiles,
    }
    setProjects((prev) => [...prev, project])
    setActiveProjectId(project.id)
  }
  const {
    connected,
    onChatEvent,
    onWhatsAppEvent,
    onGmailEvent,
    onSpotifyEvent,
    onInstagramEvent,
    onGoogleHomeEvent,
  } = useLeyWebSocket()

  // carga inicial: pega tudo que já está não lido no banco (ex: chegou
  // enquanto o painel estava fechado) assim que loga
  useEffect(() => {
    if (!authUser) return
    let cancelled = false

    Promise.all([fetchUnreadNotifications(), fetchContactNames()])
      .then(([messages, names]) => {
        if (!cancelled) setNotifications(groupUnreadMessages(messages, names))
      })
      .catch(() => {
        // se falhar, a lista fica vazia por ora — próximas mensagens em
        // tempo real (WebSocket) já populam normalmente
      })

    return () => {
      cancelled = true
    }
  }, [authUser])

  // tempo real: toda mensagem nova recebida (não enviada por nós) atualiza
  // o grupo daquele jid, sem precisar recarregar a lista inteira
  useEffect(() => {
    const unsubscribe = onWhatsAppEvent((event, data) => {
      if (event !== 'message' || !data || data.from_me) return

      const jid: string = data.jid
      const isGroup = jid.endsWith('@g.us')
      const preview: string | null = (data.type === 'audio' ? data.transcript : data.text) ?? null

      // toca o som de notificação sempre que chega mensagem de verdade
      // (já filtramos from_me lá em cima, então é só mensagem recebida)
      playNotificationSound()

      setNotifications((prev) => {
        const existing = prev.find((n) => n.jid === jid)
        if (existing) {
          return prev.map((n) =>
            n.jid === jid
              ? { ...n, count: n.count + 1, lastPreview: preview, lastCreatedAt: data.created_at ?? Date.now() }
              : n
          )
        }
        return [
          ...prev,
          {
            jid,
            isGroup,
            displayName: data.sender_name ?? (isGroup ? '' : `+${jid.split('@')[0]}`),
            count: 1,
            lastPreview: preview,
            lastCreatedAt: data.created_at ?? Date.now(),
          },
        ]
      })
    })
    return unsubscribe
  }, [onWhatsAppEvent])

  // abre a conversa a partir de um clique na aba de Notificações: reaproveita
  // o mesmo mecanismo de foco usado pelo fluxo de "abrir conversa" por voz,
  // marca como lido no backend e some da lista de avisos
  const openFromNotification = (jid: string, name: string | null) => {
    setFocusJid(jid)
    setFocusName(name)
    setActiveTab('whatsapp')
    setNotifications((prev) => prev.filter((n) => n.jid !== jid))
    void markJidSeen(jid)
  }

  const notificationCount = notifications.reduce((sum, n) => sum + n.count, 0)

  // escuta o evento "open_conversation" (disparado quando o usuário pede pra
  // Ley "abrir a conversa/o grupo com fulano" pelo chat/voz) e troca pra aba
  // do WhatsApp já focando na conversa certa
  useEffect(() => {
    const unsubscribe = onWhatsAppEvent((event, data) => {
      if (event === 'open_conversation' && data?.jid) {
        setFocusJid(data.jid)
        setFocusName(data.name ?? null)
        setActiveTab('whatsapp')
      }
    })
    return unsubscribe
  }, [onWhatsAppEvent])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const token = params.get('auth_token')
    const rawUser = params.get('auth_user')

    if (token && rawUser) {
      try {
        const parsedUser = JSON.parse(rawUser) as AuthUser
        localStorage.setItem('ley_auth_token', token)
        localStorage.setItem('ley_auth_user', JSON.stringify(parsedUser))
        setAuthUser(parsedUser)
        window.history.replaceState({}, '', window.location.pathname)
      } catch {
        console.error('Falha ao salvar sessão Ley')
      }
    } else {
      const storedUser = localStorage.getItem('ley_auth_user')
      if (storedUser) {
        try {
          setAuthUser(JSON.parse(storedUser) as AuthUser)
        } catch {
          localStorage.removeItem('ley_auth_user')
        }
      }
    }
  }, [])

  const handleGoogleLogin = () => {
    window.location.href = `${API_BASE_URL}/auth/google`
  }

  const handleLogout = () => {
    localStorage.removeItem('ley_auth_token')
    localStorage.removeItem('ley_auth_user')
    setAuthUser(null)
  }

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-midnight-950 text-slate-100 md:flex-row">
      <Sidebar
        active={activeTab}
        onChange={setActiveTab}
        wsConnected={connected}
        notificationCount={notificationCount}
        userLabel={authUser ? authUser.name ?? authUser.email : null}
        onLogout={handleLogout}
      />

      <main className="relative flex-1 overflow-hidden pb-14 md:pb-0">
        {!authUser ? (
          <div className="flex h-full items-center justify-center bg-midnight-950 px-6">
            <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/80 p-8 shadow-2xl">
              <p className="text-sm uppercase tracking-[0.3em] text-cyan-400">Ley Auth</p>
              <h1 className="mt-3 text-3xl font-semibold text-white">Entre no seu painel Ley</h1>
              <p className="mt-3 text-sm leading-6 text-slate-400">
                O login com Google já está preparado para o fluxo desktop/Android, com banco local e JWT para sessão.
              </p>
              <button
                type="button"
                onClick={handleGoogleLogin}
                className="mt-6 w-full rounded-xl bg-cyan-500 px-4 py-3 font-medium text-slate-950 transition hover:bg-cyan-400"
              >
                Entrar com Google
              </button>
            </div>
          </div>
        ) : (
          <>
            {activeTab === 'chat' && (
              <ChatTab
                key={activeProjectId ?? 'general'}
                onChatEvent={onChatEvent}
                onFilesGenerated={handleFilesGenerated}
                projectId={activeProjectId}
                projectName={activeProject?.name ?? null}
                onExitProject={() => setActiveProjectId(null)}
              />
            )}
            {activeTab === 'projects' && (
              <ProjectsPanel
                projects={projects}
                activeProjectId={activeProjectId}
                onCreate={handleCreateProject}
                onOpen={handleOpenProject}
                onRename={handleRenameProject}
                onDelete={handleDeleteProject}
              />
            )}
            {activeTab === 'notifications' && (
              <NotificationsTab groups={notifications} onOpen={openFromNotification} />
            )}
            {activeTab === 'whatsapp' && (
              <WhatsAppTab
                onWhatsAppEvent={onWhatsAppEvent}
                focusJid={focusJid}
                focusName={focusName}
                onFocusHandled={() => {
                  setFocusJid(null)
                  setFocusName(null)
                }}
              />
            )}
            {activeTab === 'connections' && (
              <ConnectionsTab
                onGmailEvent={onGmailEvent}
                onSpotifyEvent={onSpotifyEvent}
                onInstagramEvent={onInstagramEvent}
                onGoogleHomeEvent={onGoogleHomeEvent}
              />
            )}
            {activeTab === 'tasks' && <TasksTab />}
          </>
        )}
      </main>

      {authUser && (
        <FilesPanel
          open={panelOpen}
          onClose={() => setPanelOpen(false)}
          files={panelFiles}
          genId={panelGenId}
          projectName={activeProject?.name ?? null}
          onSaveAsProject={activeProject ? undefined : handleSaveUnsavedAsProject}
        />
      )}
    </div>
  )
}
