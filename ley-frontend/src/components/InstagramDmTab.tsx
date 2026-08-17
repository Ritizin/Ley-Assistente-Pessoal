import { useCallback, useEffect, useState, useRef } from 'react'
import { API_BASE_URL } from '../config/api'
import {
  Loader2,
  WifiOff,
  ShieldAlert,
  Instagram,
  ArrowLeft,
  Bot,
  Pin,
  Send,
  RefreshCcw,
  Power,
} from 'lucide-react'

type IgDmStatus = 'disconnected' | 'connecting' | 'checkpoint_required' | 'connected'

interface IgDmMessage {
  id: string
  thread_id: string
  from_me: number
  sender_name: string | null
  type: 'text' | 'media' | 'other'
  text: string | null
  media_url: string | null
  seen: number
  created_at: number
}

interface IgDmContact {
  thread_id: string
  name: string | null
  username: string | null
  is_group: number
  pinned: number
  autopilot: number | null
  updated_at: number
}

interface InstagramDmTabProps {
  onInstagramDmEvent: (fn: (event: string, data: any) => void) => () => void
}

const API_BASE = API_BASE_URL

function displayName(c: IgDmContact): string {
  return c.name || (c.username ? `@${c.username}` : c.thread_id)
}

export default function InstagramDmTab({ onInstagramDmEvent }: InstagramDmTabProps) {
  const [status, setStatus] = useState<IgDmStatus>('connecting')
  const [username, setUsername] = useState<string | null>(null)
  const [connError, setConnError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)

  const [threads, setThreads] = useState<IgDmContact[]>([])
  const [threadsLoading, setThreadsLoading] = useState(false)

  const [openedThread, setOpenedThread] = useState<IgDmContact | null>(null)
  const [openedMessages, setOpenedMessages] = useState<IgDmMessage[]>([])
  const [openedLoading, setOpenedLoading] = useState(false)

  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  const [autopilotGlobal, setAutopilotGlobal] = useState<boolean | null>(null)
  const [autopilotBusy, setAutopilotBusy] = useState(false)

  const messagesEndRef = useRef<HTMLDivElement>(null)

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/instagram-dm/status`)
      const data = await res.json()
      setStatus(data.status)
      setUsername(data.username ?? null)
      setConnError(data.error ?? null)
    } catch {
      // servidor pode estar reiniciando — o WS reconecta e re-sincroniza sozinho
    }
  }, [])

  const loadThreads = useCallback(async () => {
    setThreadsLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/instagram-dm/threads`)
      const data: IgDmContact[] = await res.json()
      setThreads(data)
    } catch {
      // tenta de novo no próximo evento/poll
    } finally {
      setThreadsLoading(false)
    }
  }, [])

  const loadAutopilotGlobal = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/instagram-dm/autopilot`)
      const data = await res.json()
      setAutopilotGlobal(!!data.enabled)
    } catch {
      // mantém o valor anterior
    }
  }, [])

  const openThread = useCallback(async (thread: IgDmContact) => {
    setOpenedThread(thread)
    setOpenedLoading(true)
    setSendError(null)
    try {
      const res = await fetch(`${API_BASE}/api/instagram-dm/messages?threadId=${encodeURIComponent(thread.thread_id)}`)
      const data: IgDmMessage[] = await res.json()
      setOpenedMessages(data)
      await fetch(`${API_BASE}/api/instagram-dm/mark-seen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: thread.thread_id }),
      })
    } catch {
      setOpenedMessages([])
    } finally {
      setOpenedLoading(false)
    }
  }, [])

  useEffect(() => {
    loadStatus()
    loadThreads()
    loadAutopilotGlobal()
  }, [loadStatus, loadThreads, loadAutopilotGlobal])

  useEffect(() => {
    const unsubscribe = onInstagramDmEvent((event, data) => {
      if (event === 'status') {
        setStatus(data.status)
        setUsername(data.username ?? null)
        setConnError(data.error ?? null)
      } else if (event === 'message') {
        loadThreads()
        if (openedThread && data.threadId === openedThread.thread_id) {
          setOpenedMessages((prev) => [
            ...prev,
            {
              id: String(data.id),
              thread_id: data.threadId,
              from_me: data.fromMe ? 1 : 0,
              sender_name: data.senderName ?? null,
              type: data.type ?? 'text',
              text: data.text ?? null,
              media_url: null,
              seen: 1,
              created_at: data.createdAt,
            },
          ])
        }
      }
    })
    return unsubscribe
  }, [onInstagramDmEvent, loadThreads, openedThread])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [openedMessages])

  const handleConnect = useCallback(async () => {
    setConnecting(true)
    try {
      await fetch(`${API_BASE}/api/instagram-dm/connect`, { method: 'POST' })
      setTimeout(loadStatus, 1500)
    } finally {
      setConnecting(false)
    }
  }, [loadStatus])

  const handleSend = useCallback(async () => {
    if (!openedThread || !draft.trim()) return
    setSending(true)
    setSendError(null)
    try {
      const res = await fetch(`${API_BASE}/api/instagram-dm/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: openedThread.thread_id, text: draft.trim() }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err?.error ?? 'falha ao enviar')
      }
      setDraft('')
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'falha ao enviar mensagem')
    } finally {
      setSending(false)
    }
  }, [openedThread, draft])

  const toggleAutopilotGlobal = useCallback(async () => {
    if (autopilotGlobal === null) return
    setAutopilotBusy(true)
    try {
      const next = !autopilotGlobal
      await fetch(`${API_BASE}/api/instagram-dm/autopilot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      setAutopilotGlobal(next)
    } finally {
      setAutopilotBusy(false)
    }
  }, [autopilotGlobal])

  // ciclo padrão -> ligado -> desligado -> padrão, pra cada thread
  const cycleThreadAutopilot = useCallback(async (thread: IgDmContact) => {
    const next = thread.autopilot === null ? 1 : thread.autopilot === 1 ? 0 : null
    await fetch(`${API_BASE}/api/instagram-dm/autopilot/thread`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: thread.thread_id, enabled: next }),
    })
    setThreads((prev) => prev.map((t) => (t.thread_id === thread.thread_id ? { ...t, autopilot: next } : t)))
    if (openedThread?.thread_id === thread.thread_id) {
      setOpenedThread((prev) => (prev ? { ...prev, autopilot: next } : prev))
    }
  }, [openedThread])

  const togglePin = useCallback(async (thread: IgDmContact) => {
    const next = !thread.pinned
    await fetch(`${API_BASE}/api/instagram-dm/pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: thread.thread_id, pinned: next }),
    })
    loadThreads()
  }, [loadThreads])

  // ---- estado "não conectado" ----
  if (status !== 'connected') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
        <Instagram size={40} className="text-electric-400" />
        <div>
          <p className="font-display text-lg font-semibold text-white">
            {status === 'connecting' && 'Conectando ao Instagram...'}
            {status === 'disconnected' && 'Instagram desconectado'}
            {status === 'checkpoint_required' && 'O Instagram precisa de ação manual'}
          </p>
          <p className="mt-1 max-w-sm text-sm text-slate-400">
            {status === 'connecting' && 'Fazendo login na conta @leysatan...'}
            {status === 'disconnected' && 'Clique em conectar pra a Ley entrar na conta @leysatan.'}
            {status === 'checkpoint_required' &&
              (connError ??
                'Entre manualmente no app/site do Instagram com a conta uma vez pra confirmar o login, depois clique em tentar de novo.')}
          </p>
        </div>
        {status === 'connecting' ? (
          <Loader2 className="animate-spin text-electric-400" size={22} />
        ) : (
          <button
            onClick={handleConnect}
            disabled={connecting}
            className="flex items-center gap-2 rounded-lg bg-electric-500/10 px-4 py-2 text-sm font-medium text-electric-400 ring-1 ring-electric-500/30 transition hover:bg-electric-500/20 disabled:opacity-50"
          >
            {connecting ? <Loader2 size={16} className="animate-spin" /> : <Power size={16} />}
            {status === 'checkpoint_required' ? 'Tentar de novo' : 'Conectar'}
          </button>
        )}
        {status === 'checkpoint_required' && <ShieldAlert size={18} className="text-amber-400" />}
      </div>
    )
  }

  // ---- conversa aberta ----
  if (openedThread) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-3 border-b border-electric-500/10 bg-midnight-900/80 px-4 py-3">
          <button onClick={() => setOpenedThread(null)} className="text-slate-400 hover:text-white">
            <ArrowLeft size={20} />
          </button>
          <div className="flex-1">
            <p className="font-medium text-white">{displayName(openedThread)}</p>
            {openedThread.username && <p className="text-xs text-slate-500">@{openedThread.username}</p>}
          </div>
          <button
            onClick={() => cycleThreadAutopilot(openedThread)}
            title="Autopilot desta conversa: padrão / ligado / desligado"
            className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs ring-1 ${
              openedThread.autopilot === 1
                ? 'bg-electric-500/10 text-electric-400 ring-electric-500/30'
                : openedThread.autopilot === 0
                ? 'bg-rose-500/10 text-rose-400 ring-rose-500/30'
                : 'text-slate-500 ring-white/10'
            }`}
          >
            <Bot size={13} />
            {openedThread.autopilot === 1 ? 'Ligado' : openedThread.autopilot === 0 ? 'Mudo' : 'Padrão'}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {openedLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="animate-spin text-electric-400" size={22} />
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {openedMessages.map((m) => (
                <div key={m.id} className={`flex ${m.from_me ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm ${
                      m.from_me
                        ? 'bg-electric-500/20 text-white'
                        : 'bg-midnight-800 text-slate-200'
                    }`}
                  >
                    {!m.from_me && m.sender_name && (
                      <p className="mb-0.5 text-[11px] font-medium text-electric-400">{m.sender_name}</p>
                    )}
                    {m.text ?? <span className="italic text-slate-500">[mídia]</span>}
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        <div className="border-t border-electric-500/10 bg-midnight-900/80 p-3">
          {sendError && <p className="mb-2 text-xs text-rose-400">{sendError}</p>}
          <div className="flex items-center gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !sending && handleSend()}
              placeholder="Escreva uma mensagem..."
              className="flex-1 rounded-lg border border-white/10 bg-midnight-800 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-electric-500/50 focus:outline-none"
            />
            <button
              onClick={handleSend}
              disabled={sending || !draft.trim()}
              className="flex h-9 w-9 items-center justify-center rounded-lg bg-electric-500/20 text-electric-400 transition hover:bg-electric-500/30 disabled:opacity-40"
            >
              {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ---- lista de conversas ----
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-electric-500/10 bg-midnight-900/80 px-4 py-3">
        <div className="flex items-center gap-2">
          <Instagram size={18} className="text-electric-400" />
          <div>
            <p className="text-sm font-medium text-white">Instagram</p>
            <p className="text-[11px] text-slate-500">@{username ?? 'leysatan'} · conectado</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={toggleAutopilotGlobal}
            disabled={autopilotBusy || autopilotGlobal === null}
            title="Autopilot global (a Ley responde sozinha por DM)"
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium ring-1 transition ${
              autopilotGlobal
                ? 'bg-electric-500/10 text-electric-400 ring-electric-500/30'
                : 'text-slate-400 ring-white/10 hover:bg-white/5'
            }`}
          >
            <Bot size={14} />
            AutoPilot {autopilotGlobal ? 'ligado' : 'desligado'}
          </button>
          <button onClick={() => loadThreads()} className="text-slate-400 hover:text-white">
            <RefreshCcw size={16} className={threadsLoading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {threads.length === 0 && !threadsLoading && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-500">
            <WifiOff size={22} />
            <p className="text-sm">Nenhuma conversa ainda</p>
          </div>
        )}
        {threads.map((t) => (
          <button
            key={t.thread_id}
            onClick={() => openThread(t)}
            className="flex w-full items-center gap-3 border-b border-white/5 px-4 py-3 text-left transition hover:bg-white/5"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-electric-500/10 text-sm font-semibold text-electric-400">
              {displayName(t).slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-white">{displayName(t)}</p>
              {t.username && <p className="truncate text-xs text-slate-500">@{t.username}</p>}
            </div>
            {t.autopilot === 1 && <Bot size={14} className="text-electric-400" />}
            <span
              role="button"
              onClick={(e) => {
                e.stopPropagation()
                togglePin(t)
              }}
              className={t.pinned ? 'text-electric-400' : 'text-slate-600 hover:text-slate-300'}
            >
              <Pin size={14} fill={t.pinned ? 'currentColor' : 'none'} />
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
