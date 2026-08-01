import { useCallback, useEffect, useState, useRef, useMemo } from 'react'
import { API_BASE_URL } from '../config/api'
import {
  Loader2,
  WifiOff,
  CheckCheck,
  Users,
  MessageSquareText,
  ArrowLeft,
  Paperclip,
  FileText,
  Bot,
} from 'lucide-react'

type WaStatus = 'disconnected' | 'connecting' | 'qr_pending' | 'connected'

interface WaMessage {
  id: string
  jid: string
  from_me: number
  sender_name: string | null
  type: 'text' | 'audio' | 'other'
  text: string | null
  transcript: string | null
  media_path: string | null
  media_mimetype: string | null
  seen: number
  created_at: number
}

interface WaContact {
  jid: string
  name: string | null
  updated_at: number
  source?: 'seen' | 'saved'
  is_group?: number
}

type WaSubView = 'messages' | 'contacts'

interface WhatsAppTabProps {
  onWhatsAppEvent: (fn: (event: string, data: any) => void) => () => void
  // jid de uma conversa/grupo específico que o Ley pediu pra abrir (via chat/voz)
  focusJid?: string | null
  focusName?: string | null
  // chamado assim que o foco pedido pelo Ley já foi aberto na tela
  onFocusHandled?: () => void
}

const API_BASE = API_BASE_URL

export default function WhatsAppTab({ onWhatsAppEvent, focusJid, focusName, onFocusHandled }: WhatsAppTabProps) {
  const [status, setStatus] = useState<WaStatus>('connecting')
  const [qr, setQr] = useState<string | null>(null)
  const [number, setNumber] = useState<string | null>(null)
  const [messages, setMessages] = useState<WaMessage[]>([])
  const [view, setView] = useState<WaSubView>('messages')
  const [contacts, setContacts] = useState<WaContact[]>([])
  const [contactsLoading, setContactsLoading] = useState(false)
  const [contactsError, setContactsError] = useState<string | null>(null)

  // conversa/grupo em foco (aberta explicitamente, seja por clique num
  // contato ou porque o Ley pediu pra abrir via chat/voz)
  const [openedJid, setOpenedJid] = useState<string | null>(null)
  const [openedName, setOpenedName] = useState<string | null>(null)
  const [openedMessages, setOpenedMessages] = useState<WaMessage[]>([])
  const [openedLoading, setOpenedLoading] = useState(false)
  const [sendingFile, setSendingFile] = useState(false)
  const [sendFileError, setSendFileError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // toggle global do autopilot (a Ley responde sozinha no WhatsApp) — a API
  // já existia (/api/whatsapp/autopilot), mas não tinha nenhum botão no
  // painel pra controlar ela; só dava pra mudar via curl direto.
  const [autopilotEnabled, setAutopilotEnabled] = useState<boolean | null>(null)
  const [autopilotBusy, setAutopilotBusy] = useState(false)

  const loadConversation = useCallback(async (jid: string, name: string | null) => {
    setOpenedJid(jid)
    setOpenedName(name)
    setOpenedLoading(true)
    setSendFileError(null)
    try {
      const res = await fetch(`${API_BASE}/api/whatsapp/conversation/${encodeURIComponent(jid)}`)
      if (!res.ok) throw new Error('resposta não-ok')
      const data: WaMessage[] = await res.json()
      setOpenedMessages(data)
    } catch {
      setOpenedMessages([])
    } finally {
      setOpenedLoading(false)
    }

    // marca tudo dessa conversa como lido — some o selo na lista sem
    // precisar esperar um evento do WS de volta
    fetch(`${API_BASE}/api/whatsapp/messages/seen-by-jid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jid }),
    }).catch(() => {})
    setMessages((prev) => prev.map((m) => (m.jid === jid ? { ...m, seen: 1 } : m)))
  }, [])

  const closeConversation = useCallback(() => {
    setOpenedJid(null)
    setOpenedName(null)
    setOpenedMessages([])
    setSendFileError(null)
  }, [])

  // agrupa o feed de mensagens recentes por conversa (jid) — antes a view
  // "messages" listava tudo junto (todo mundo misturado, ordem só por
  // horário), o que ficava confuso com várias conversas ativas. Agora só a
  // última mensagem de cada contato/grupo aparece, tipo lista de conversas
  // de verdade (estilo WhatsApp), ordenada pela mais recente primeiro.
  const conversations = useMemo(() => {
    const contactNameByJid = new Map(contacts.map((c) => [c.jid, c.name]))
    const map = new Map<string, { jid: string; name: string | null; isGroup: boolean; last: WaMessage; unread: number }>()

    for (const m of messages) {
      const isUnread = !m.from_me && !m.seen
      const existing = map.get(m.jid)

      if (!existing) {
        map.set(m.jid, {
          jid: m.jid,
          name: contactNameByJid.get(m.jid) ?? (!m.from_me ? m.sender_name : null),
          isGroup: m.jid.endsWith('@g.us'),
          last: m,
          unread: isUnread ? 1 : 0,
        })
        continue
      }

      if (isUnread) existing.unread += 1
      if (!existing.name && !m.from_me && m.sender_name && !existing.isGroup) existing.name = m.sender_name
      if (m.created_at > existing.last.created_at) existing.last = m
    }

    return Array.from(map.values()).sort((a, b) => b.last.created_at - a.last.created_at)
  }, [messages, contacts])

  // quando o Ley pede pra abrir uma conversa/grupo (evento vindo do App), abre
  // direto na tela e avisa o App que já foi tratado
  useEffect(() => {
    if (focusJid) {
      loadConversation(focusJid, focusName ?? null)
      onFocusHandled?.()
    }
  }, [focusJid, focusName, loadConversation, onFocusHandled])

  const sendFile = useCallback(
    async (file: File) => {
      if (!openedJid) return
      setSendingFile(true)
      setSendFileError(null)
      try {
        const form = new FormData()
        form.append('jid', openedJid)
        form.append('file', file)
        const res = await fetch(`${API_BASE}/api/whatsapp/send-file`, { method: 'POST', body: form })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body?.error ?? 'falha ao enviar arquivo')
        }
      } catch (err) {
        setSendFileError(err instanceof Error ? err.message : 'Falha ao enviar o arquivo.')
      } finally {
        setSendingFile(false)
        if (fileInputRef.current) fileInputRef.current.value = ''
      }
    },
    [openedJid]
  )
  const loadAutopilot = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/whatsapp/autopilot`)
      if (!res.ok) return
      const data: { enabled: boolean } = await res.json()
      setAutopilotEnabled(data.enabled)
    } catch {
      // backend fora do ar — deixa o estado como estava (null = "?" na tela)
    }
  }, [])

  // carrega assim que o painel abre — não depende do status da conexão do
  // WhatsApp, porque essa configuração é do backend, não da sessão do Baileys.
  useEffect(() => {
    loadAutopilot()
  }, [loadAutopilot])

  const toggleAutopilot = useCallback(async () => {
    if (autopilotEnabled === null || autopilotBusy) return
    const next = !autopilotEnabled
    setAutopilotBusy(true)
    setAutopilotEnabled(next) // otimista
    try {
      const res = await fetch(`${API_BASE}/api/whatsapp/autopilot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      if (!res.ok) throw new Error('resposta não-ok')
    } catch {
      setAutopilotEnabled(!next) // desfaz se o backend recusou/falhou
    } finally {
      setAutopilotBusy(false)
    }
  }, [autopilotEnabled, autopilotBusy])

  const loadMessages = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/whatsapp/messages`)
      if (!res.ok) return
      const data: WaMessage[] = await res.json()
      // a API devolve da mais recente pra mais antiga; exibimos em ordem cronológica
      setMessages(data.slice().reverse())
    } catch {
      // backend fora do ar — mantém a lista atual
    }
  }, [])

  const loadContacts = useCallback(async () => {
    setContactsLoading(true)
    setContactsError(null)
    try {
      const res = await fetch(`${API_BASE}/api/whatsapp/contacts`)
      if (!res.ok) throw new Error('resposta não-ok')
      const data: WaContact[] = await res.json()
      setContacts(data)
    } catch {
      setContactsError('Não consegui carregar os contatos agora.')
    } finally {
      setContactsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (status === 'connected') loadContacts()
  }, [status, loadContacts])

  // busca o status atual assim que a aba monta — o snapshot do WS só chega
  // UMA VEZ quando o socket abre (que pode ter sido antes dessa aba existir),
  // então sem isso o painel podia ficar preso em "Iniciando conexão..." pra
  // sempre mesmo já conectado.
  useEffect(() => {
    fetch(`${API_BASE}/api/whatsapp/status`)
      .then((r) => r.json())
      .then((data) => {
        if (data?.status) {
          setStatus(data.status)
          if (data.status === 'qr_pending' && data.qr) setQr(data.qr)
          if (data.status === 'connected' && data.number) setNumber(data.number)
        }
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    const unsubscribe = onWhatsAppEvent((event, data) => {
      if (event === 'status' && data?.status) {
        setStatus(data.status)
        if (data.status !== 'qr_pending') setQr(null)
      } else if (event === 'qr' && data?.qr) {
        setStatus('qr_pending')
        setQr(data.qr)
      } else if (event === 'connected') {
        setStatus('connected')
        setQr(null)
        setNumber(data?.number ?? null)
        loadMessages()
      } else if (event === 'logged_out') {
        setStatus('disconnected')
        setQr(null)
        setNumber(null)
      } else if (event === 'message') {
        // BUG corrigido aqui: quando chegava um segundo evento pro mesmo id
        // (ex: o eco do Baileys sem áudio ainda, seguido do save de
        // verdade já com o media_path certo — ou vice-versa, dependendo de
        // qual dos dois vence a corrida), o código antes descartava o
        // segundo e podia ficar com a versão incompleta na tela — a
        // mensagem aparecia sem o player de áudio até dar refresh na
        // página. Agora funde os dois campo a campo: um valor null/undefined
        // no evento novo nunca apaga um valor de verdade que já tinha, não
        // importa a ordem de chegada.
        const merge = (prev: WaMessage[]) => {
          const incoming = data as WaMessage
          const idx = prev.findIndex((m) => m.id === incoming.id)
          if (idx === -1) return [...prev, incoming]

          const current = prev[idx]
          const merged: WaMessage = { ...current }
          for (const key of Object.keys(incoming) as (keyof WaMessage)[]) {
            const value = incoming[key]
            if (value !== null && value !== undefined) {
              ;(merged[key] as unknown) = value
            }
          }

          const next = prev.slice()
          next[idx] = merged
          return next
        }

        setMessages(merge)
        setOpenedMessages((prev) => {
          const incoming = data as WaMessage
          if (!openedJid || incoming.jid !== openedJid) return prev
          return merge(prev)
        })
      }
    })
    return unsubscribe
  }, [onWhatsAppEvent, loadMessages, openedJid])

  useEffect(() => {
    if (status === 'connected') loadMessages()
  }, [status, loadMessages])

  const markSeen = useCallback((id: string) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, seen: 1 } : m)))
    fetch(`${API_BASE}/api/whatsapp/messages/${id}/seen`, { method: 'POST' }).catch(() => {
      // se falhar, a próxima carga da lista corrige o estado
    })
  }, [])

  const markAllSeen = useCallback(() => {
    setMessages((prev) => prev.map((m) => ({ ...m, seen: 1 })))
    fetch(`${API_BASE}/api/whatsapp/messages/seen-all`, { method: 'POST' }).catch(() => {})
  }, [])

  const unreadCount = messages.filter((m) => !m.from_me && !m.seen).length

  // conteúdo de UMA mensagem (texto, áudio ou arquivo) — reaproveitado tanto
  // na lista geral quanto na conversa em foco
  const renderMessageBody = (m: WaMessage) => {
    if (m.type === 'audio') {
      return (
        <div className="flex flex-col gap-1.5">
          <audio controls src={`${API_BASE}/api/whatsapp/media/${m.id}`} className="h-9 w-64" />
          {m.transcript && <p className="text-xs italic text-slate-400">"{m.transcript}"</p>}
        </div>
      )
    }

    // arquivo (documento/imagem/vídeo enviado ou recebido): tem media_path
    // mas não é áudio — mostra como um "chip" clicável em vez de tentar
    // renderizar o texto (que aqui guarda só o nome do arquivo)
    if (m.type === 'other' && m.media_path) {
      const isImage = m.media_mimetype?.startsWith('image/')
      return (
        <a
          href={`${API_BASE}/api/whatsapp/media/${m.id}`}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 rounded-lg bg-midnight-900/60 px-3 py-2 text-xs text-slate-200 ring-1 ring-white/10 transition hover:bg-midnight-900"
        >
          {isImage ? (
            <img
              src={`${API_BASE}/api/whatsapp/media/${m.id}`}
              alt={m.text ?? 'imagem'}
              className="h-10 w-10 rounded object-cover"
            />
          ) : (
            <FileText size={16} className="text-electric-400" />
          )}
          <span className="truncate">{m.text ?? 'arquivo'}</span>
        </a>
      )
    }

    return <p>{m.text ?? '(mensagem sem conteúdo suportado ainda)'}</p>
  }

  return (
    <div className="relative flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-white/5 px-6 py-4">
        <div>
          <h1 className="font-display text-xl font-semibold text-white">WhatsApp</h1>
          <p className="text-sm text-slate-400">
            {status === 'connected'
              ? number
                ? `Conectado com +${number}`
                : 'Mensagens recebidas pela Ley'
              : 'Conecte o número que a Ley vai usar'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={toggleAutopilot}
            disabled={autopilotEnabled === null || autopilotBusy}
            title={
              autopilotEnabled === null
                ? 'Carregando estado do autopilot...'
                : autopilotEnabled
                ? 'Autopilot ligado — clique pra desligar'
                : 'Autopilot desligado — clique pra ligar'
            }
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium ring-1 transition cursor-pointer disabled:cursor-wait disabled:opacity-60 ${
              autopilotEnabled
                ? 'bg-electric-500/15 text-electric-400 ring-electric-500/30 hover:bg-electric-500/20'
                : 'bg-midnight-800/60 text-slate-400 ring-white/10 hover:bg-midnight-800'
            }`}
          >
            {autopilotBusy ? <Loader2 size={14} className="animate-spin" /> : <Bot size={14} />}
            Autopilot: {autopilotEnabled === null ? '...' : autopilotEnabled ? 'ligado' : 'desligado'}
          </button>
          {status === 'connected' && (
            <div className="flex items-center gap-1 rounded-lg border border-white/5 bg-midnight-800/60 p-1">
              <button
                onClick={() => setView('messages')}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition cursor-pointer ${
                  view === 'messages' ? 'bg-electric-500/15 text-electric-400' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <MessageSquareText size={14} />
                Contatos
              </button>
              <button
                onClick={() => setView('contacts')}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition cursor-pointer ${
                  view === 'contacts' ? 'bg-electric-500/15 text-electric-400' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Users size={14} />
                Grupos
              </button>
            </div>
          )}
          {status === 'connected' && view === 'messages' && unreadCount > 0 && (
            <button
              onClick={markAllSeen}
              className="flex items-center gap-1.5 rounded-lg bg-electric-500/10 px-3 py-1.5 text-xs font-medium text-electric-400 ring-1 ring-electric-500/30 transition hover:bg-electric-500/20 cursor-pointer"
            >
              <CheckCheck size={14} />
              Marcar {unreadCount} como lida{unreadCount > 1 ? 's' : ''}
            </button>
          )}
        </div>
      </header>

      {status === 'connected' && view === 'contacts' && (
        <div className="flex-1 overflow-y-auto px-6 py-6">
          {contactsLoading && contacts.length === 0 ? (
            <div className="flex items-center justify-center gap-2 pt-10 text-sm text-slate-500">
              <Loader2 size={16} className="animate-spin" />
              Carregando grupos...
            </div>
          ) : contactsError ? (
            <p className="text-center text-sm text-red-400">{contactsError}</p>
          ) : contacts.filter((c) => c.is_group).length === 0 ? (
            <p className="text-center text-sm text-slate-500">
              Nenhum grupo ainda. Grupos aparecem aqui quando alguém te manda mensagem neles, ou quando você pede pra
              Ley criar um.
            </p>
          ) : (
            <div className="mx-auto flex max-w-2xl flex-col gap-2">
              {contacts
                .filter((c) => c.is_group)
                .map((c) => (
                <button
                  key={c.jid}
                  onClick={() => loadConversation(c.jid, c.name)}
                  className="flex w-full items-center justify-between rounded-xl bg-midnight-800 px-4 py-3 text-left text-sm ring-1 ring-white/5 transition hover:bg-midnight-800/70 cursor-pointer"
                >
                  <div>
                    <p className="font-medium text-slate-100">{c.name ?? c.jid.split('@')[0]}</p>
                    <p className="text-xs text-slate-500">grupo</p>
                  </div>
                  <span className="flex items-center gap-1 rounded-full bg-slate-700/40 px-2 py-1 text-[10px] font-medium text-slate-400 ring-1 ring-white/5">
                    <Users size={11} />
                    grupo
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {status === 'connected' && view === 'messages' && (
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {conversations.filter((c) => !c.isGroup).length === 0 ? (
            <p className="pt-10 text-center text-sm text-slate-500">Nenhuma conversa individual ainda.</p>
          ) : (
            <div className="mx-auto flex max-w-2xl flex-col gap-1">
              {conversations
                .filter((c) => !c.isGroup)
                .map((c) => {
                const displayName = c.name ?? `+${c.jid.split('@')[0]}`
                const preview =
                  c.last.type === 'audio'
                    ? `🎤 ${c.last.transcript ? c.last.transcript.slice(0, 60) : 'Mensagem de voz'}`
                    : c.last.type === 'text'
                    ? c.last.text ?? ''
                    : '📎 Anexo'

                return (
                  <button
                    key={c.jid}
                    onClick={() => loadConversation(c.jid, c.name)}
                    className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-white/5"
                  >
                    <div
                      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${
                        c.isGroup ? 'bg-slate-700/40 text-slate-300' : 'bg-electric-500/15 text-electric-400'
                      }`}
                    >
                      {c.isGroup ? <Users size={18} /> : <MessageSquareText size={18} />}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-medium text-slate-100">{displayName}</p>
                        <p className="shrink-0 text-[10px] text-slate-500">
                          {new Date(c.last.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                        </p>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-xs text-slate-500">
                          {c.last.from_me && <span className="text-slate-600">Você: </span>}
                          {preview}
                        </p>
                        {c.unread > 0 && (
                          <span className="flex h-5 min-w-[20px] shrink-0 items-center justify-center rounded-full bg-electric-500 px-1.5 text-[10px] font-semibold text-white">
                            {c.unread}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}

      {status !== 'connected' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6">
          {status === 'qr_pending' && qr && (
            <div className="flex flex-col items-center gap-4 text-center">
              <div className="rounded-2xl bg-white p-4 shadow-glow">
                <img src={qr} alt="QR Code do WhatsApp" className="h-64 w-64" />
              </div>
              <p className="max-w-xs text-sm text-slate-400">
                Abre o WhatsApp no celular → Aparelhos conectados → Conectar um aparelho → aponta a câmera pra esse QR Code
              </p>
            </div>
          )}

          {status === 'connecting' && !qr && (
            <div className="flex flex-col items-center gap-3 text-center">
              <Loader2 size={32} className="animate-spin text-electric-400" />
              <p className="text-sm text-slate-400">Iniciando conexão com o WhatsApp...</p>
            </div>
          )}

          {status === 'disconnected' && (
            <div className="flex flex-col items-center gap-3 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-red-500/10 ring-1 ring-red-500/30">
                <WifiOff size={32} className="text-red-400" />
              </div>
              <p className="text-sm text-slate-400">
                Sessão encerrada. Reinicie o servidor da Ley pra gerar um novo QR Code.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Conversa/grupo em foco — aberta clicando num contato ou porque o Ley
          pediu pra abrir via chat/voz ("abre a conversa/o grupo com fulano") */}
      {openedJid && (
        <div className="absolute inset-0 z-10 flex flex-col bg-midnight-950">
          <header className="flex items-center justify-between border-b border-white/5 px-6 py-4">
            <div className="flex items-center gap-3">
              <button
                onClick={closeConversation}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-white/5 hover:text-slate-200 cursor-pointer"
              >
                <ArrowLeft size={18} />
              </button>
              <div>
                <h2 className="font-display text-lg font-semibold text-white">
                  {openedName ?? openedJid.split('@')[0]}
                </h2>
                <p className="text-xs text-slate-500">{openedJid.endsWith('@g.us') ? 'grupo' : `+${openedJid.split('@')[0]}`}</p>
              </div>
            </div>
          </header>

          <div className="flex-1 overflow-y-auto px-6 py-6">
            {openedLoading ? (
              <div className="flex items-center justify-center gap-2 pt-10 text-sm text-slate-500">
                <Loader2 size={16} className="animate-spin" />
                Carregando conversa...
              </div>
            ) : openedMessages.length === 0 ? (
              <p className="text-center text-sm text-slate-500">Nenhuma mensagem nessa conversa ainda.</p>
            ) : (
              <div className="mx-auto flex max-w-2xl flex-col gap-3">
                {openedMessages.map((m) => (
                  <div
                    key={m.id}
                    className={`rounded-xl px-4 py-3 text-sm ring-1 ${
                      m.from_me
                        ? 'ml-auto max-w-[75%] bg-electric-500/10 text-slate-100 ring-electric-500/20'
                        : 'max-w-[75%] bg-midnight-800 text-slate-200 ring-white/5'
                    }`}
                  >
                    {!m.from_me && openedJid.endsWith('@g.us') && (
                      <p className="mb-1 text-xs font-medium text-electric-400">
                        {m.sender_name ?? m.jid.split('@')[0]}
                      </p>
                    )}
                    {renderMessageBody(m)}
                    <p className="mt-1 text-[10px] text-slate-500">
                      {new Date(m.created_at).toLocaleString('pt-BR')}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <footer className="border-t border-white/5 px-6 py-4">
            {sendFileError && <p className="mb-2 text-xs text-red-400">{sendFileError}</p>}
            <div className="mx-auto flex max-w-2xl items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) sendFile(file)
                }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={sendingFile}
                className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-midnight-800/60 px-3 py-2 text-xs font-medium text-slate-300 transition hover:bg-midnight-800 disabled:opacity-50 cursor-pointer"
              >
                {sendingFile ? <Loader2 size={14} className="animate-spin" /> : <Paperclip size={14} />}
                {sendingFile ? 'Enviando...' : 'Mandar arquivo do PC'}
              </button>
              <p className="text-xs text-slate-500">
                Manda um arquivo do seu computador direto pra{' '}
                {openedJid.endsWith('@g.us') ? 'esse grupo' : 'essa conversa'}.
              </p>
            </div>
          </footer>
        </div>
      )}
    </div>
  )
}
