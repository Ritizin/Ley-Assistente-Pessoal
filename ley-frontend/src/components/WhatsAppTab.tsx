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
  Phone,
  Video,
  MoreVertical,
  Pin,
  Eraser,
  Trash2,
  Plus,
  X,
  Pause,
  Play,
  Send,
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
  pinned?: number
}

interface WaStatusItem {
  id: string
  jid: string
  sender_name: string | null
  type: 'image' | 'video' | 'text'
  text: string | null
  bg_color: string | null
  media_path: string | null
  media_mimetype: string | null
  seen: number
  created_at: number
  expires_at: number
}

interface WaStatusGroup {
  jid: string
  name: string | null
  items: WaStatusItem[]
  hasUnseen: boolean
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

  // menu de ações da conversa aberta (fixar / limpar / excluir)
  const [chatMenuOpen, setChatMenuOpen] = useState(false)

  // Status/Stories: tirinha de círculos no topo da lista + visualizador em
  // tela cheia (estilo WhatsApp/Instagram) quando um deles é aberto
  const [statusGroups, setStatusGroups] = useState<WaStatusGroup[]>([])
  const [statusViewer, setStatusViewer] = useState<{ groupIdx: number; itemIdx: number } | null>(null)
  const [statusPaused, setStatusPaused] = useState(false)
  const [statusReplyText, setStatusReplyText] = useState('')
  const [statusReplySending, setStatusReplySending] = useState(false)
  const [statusReplyError, setStatusReplyError] = useState<string | null>(null)
  const [statusReplySent, setStatusReplySent] = useState(false)

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
    setChatMenuOpen(false)
  }, [])

  const isOpenedPinned = contacts.find((c) => c.jid === openedJid)?.pinned === 1

  const handleTogglePin = useCallback(async () => {
    if (!openedJid) return
    const jid = openedJid
    const next = !isOpenedPinned
    setChatMenuOpen(false)
    setContacts((prev) => prev.map((c) => (c.jid === jid ? { ...c, pinned: next ? 1 : 0 } : c)))
    try {
      await fetch(`${API_BASE}/api/whatsapp/chat/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jid, pinned: next }),
      })
    } catch {
      // se falhar, o próximo carregamento de contatos corrige o estado sozinho
    }
  }, [openedJid, isOpenedPinned])

  const handleClearChat = useCallback(async () => {
    if (!openedJid) return
    const jid = openedJid
    if (!window.confirm('Apagar todo o histórico dessa conversa aqui no painel da Ley?')) return
    setChatMenuOpen(false)
    setOpenedMessages([])
    try {
      await fetch(`${API_BASE}/api/whatsapp/chat/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jid }),
      })
    } catch {}
  }, [openedJid])

  const handleDeleteChat = useCallback(async () => {
    if (!openedJid) return
    const jid = openedJid
    if (!window.confirm('Excluir essa conversa inteira do painel da Ley? Não dá pra desfazer.')) return
    setChatMenuOpen(false)
    closeConversation()
    setContacts((prev) => prev.filter((c) => c.jid !== jid))
    try {
      await fetch(`${API_BASE}/api/whatsapp/chat/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jid }),
      })
    } catch {}
  }, [openedJid, closeConversation])

  // agrupa o feed de mensagens recentes por conversa (jid) — antes a view
  // "messages" listava tudo junto (todo mundo misturado, ordem só por
  // horário), o que ficava confuso com várias conversas ativas. Agora só a
  // última mensagem de cada contato/grupo aparece, tipo lista de conversas
  // de verdade (estilo WhatsApp), ordenada pela mais recente primeiro.
  const conversations = useMemo(() => {
    const contactNameByJid = new Map(contacts.map((c) => [c.jid, c.name]))
    const pinnedByJid = new Map(contacts.map((c) => [c.jid, c.pinned === 1]))
    const map = new Map<
      string,
      { jid: string; name: string | null; isGroup: boolean; last: WaMessage; unread: number; pinned: boolean }
    >()

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
          pinned: pinnedByJid.get(m.jid) ?? false,
        })
        continue
      }

      if (isUnread) existing.unread += 1
      if (!existing.name && !m.from_me && m.sender_name && !existing.isGroup) existing.name = m.sender_name
      if (m.created_at > existing.last.created_at) existing.last = m
    }

    return Array.from(map.values()).sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return b.last.created_at - a.last.created_at
    })
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

  const loadStatuses = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/whatsapp/statuses`)
      if (!res.ok) return
      const data: WaStatusGroup[] = await res.json()
      setStatusGroups(data)
    } catch {
      // backend fora do ar — mantém a tirinha como estava
    }
  }, [])

  useEffect(() => {
    if (status === 'connected') loadContacts()
  }, [status, loadContacts])

  useEffect(() => {
    if (status === 'connected') loadStatuses()
  }, [status, loadStatuses])

  const markStatusSeenRemote = useCallback((id: string) => {
    fetch(`${API_BASE}/api/whatsapp/statuses/${id}/seen`, { method: 'POST' }).catch(() => {})
  }, [])

  const openStatus = useCallback(
    (groupIdx: number, itemIdx = 0) => {
      setStatusPaused(false)
      setStatusViewer({ groupIdx, itemIdx })
      const item = statusGroups[groupIdx]?.items[itemIdx]
      if (item && !item.seen) {
        setStatusGroups((prev) => {
          const next = prev.slice()
          const g = next[groupIdx]
          if (!g) return prev
          const items = g.items.slice()
          items[itemIdx] = { ...items[itemIdx], seen: 1 }
          next[groupIdx] = { ...g, items, hasUnseen: items.some((i) => !i.seen) }
          return next
        })
        markStatusSeenRemote(item.id)
      }
    },
    [statusGroups, markStatusSeenRemote]
  )

  const closeStatus = useCallback(() => setStatusViewer(null), [])

  // limpa o campo de resposta sempre que o item exibido muda (troca de
  // status ou fecha o visualizador) — senão o texto digitado pra alguém
  // vazava pro próximo status ao navegar
  useEffect(() => {
    setStatusReplyText('')
    setStatusReplyError(null)
    setStatusReplySent(false)
  }, [statusViewer?.groupIdx, statusViewer?.itemIdx])

  const sendStatusReply = useCallback(async () => {
    const item = statusViewer != null ? statusGroups[statusViewer.groupIdx]?.items[statusViewer.itemIdx] : null
    const text = statusReplyText.trim()
    if (!item || !text || statusReplySending) return

    setStatusReplySending(true)
    setStatusReplyError(null)
    try {
      const res = await fetch(`${API_BASE}/api/whatsapp/statuses/${item.id}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? 'falha ao responder o status')
      }
      setStatusReplyText('')
      setStatusReplySent(true)
      setTimeout(() => setStatusReplySent(false), 2500)
    } catch (err) {
      setStatusReplyError(err instanceof Error ? err.message : 'Falha ao responder o status.')
    } finally {
      setStatusReplySending(false)
    }
  }, [statusViewer, statusGroups, statusReplyText, statusReplySending])

  // avança pro próximo item do mesmo contato; se acabou, pula pro próximo
  // contato (começando do primeiro item dele); se também acabou, fecha
  const goToNextStatus = useCallback(() => {
    setStatusViewer((current) => {
      if (!current) return current
      const group = statusGroups[current.groupIdx]
      if (group && current.itemIdx + 1 < group.items.length) {
        const nextIdx = current.itemIdx + 1
        const item = group.items[nextIdx]
        if (item && !item.seen) markStatusSeenRemote(item.id)
        return { groupIdx: current.groupIdx, itemIdx: nextIdx }
      }
      const nextGroupIdx = current.groupIdx + 1
      if (nextGroupIdx < statusGroups.length) {
        const item = statusGroups[nextGroupIdx]?.items[0]
        if (item && !item.seen) markStatusSeenRemote(item.id)
        return { groupIdx: nextGroupIdx, itemIdx: 0 }
      }
      return null
    })
  }, [statusGroups, markStatusSeenRemote])

  const goToPrevStatus = useCallback(() => {
    setStatusViewer((current) => {
      if (!current) return current
      if (current.itemIdx > 0) return { groupIdx: current.groupIdx, itemIdx: current.itemIdx - 1 }
      const prevGroupIdx = current.groupIdx - 1
      if (prevGroupIdx < 0) return current
      const prevGroup = statusGroups[prevGroupIdx]
      return { groupIdx: prevGroupIdx, itemIdx: Math.max(0, (prevGroup?.items.length ?? 1) - 1) }
    })
  }, [statusGroups])

  // marca visto/avança sozinho o item atual quando ele muda (efeito, não a
  // função de navegação) — cobre também a abertura do primeiro item
  useEffect(() => {
    if (!statusViewer) return
    const item = statusGroups[statusViewer.groupIdx]?.items[statusViewer.itemIdx]
    if (item && !item.seen) markStatusSeenRemote(item.id)
  }, [statusViewer, statusGroups, markStatusSeenRemote])

  const currentStatusItem =
    statusViewer != null ? statusGroups[statusViewer.groupIdx]?.items[statusViewer.itemIdx] ?? null : null

  // avança automaticamente status de imagem/texto depois de 5s (vídeo avança
  // sozinho pelo onEnded do <video>, não por esse timer)
  useEffect(() => {
    if (!statusViewer || !currentStatusItem || statusPaused || statusReplyText) return
    if (currentStatusItem.type === 'video') return
    const timer = setTimeout(() => goToNextStatus(), 5000)
    return () => clearTimeout(timer)
  }, [statusViewer, currentStatusItem, statusPaused, statusReplyText, goToNextStatus])

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
      } else if (event === 'wa_status') {
        const incoming = data as WaStatusItem
        setStatusGroups((prev) => {
          const idx = prev.findIndex((g) => g.jid === incoming.jid)
          if (idx === -1) {
            return [
              { jid: incoming.jid, name: incoming.sender_name, items: [incoming], hasUnseen: true },
              ...prev,
            ]
          }
          const next = prev.slice()
          next[idx] = { ...next[idx], items: [...next[idx].items, incoming], hasUnseen: true }
          return next
        })
      } else if (event === 'wa_status_expired') {
        const ids = new Set((data as { ids: string[] })?.ids ?? [])
        setStatusGroups((prev) =>
          prev
            .map((g) => ({ ...g, items: g.items.filter((i) => !ids.has(i.id)) }))
            .filter((g) => g.items.length > 0)
        )
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
    // mas não é áudio — imagem e vídeo tocam/mostram inline (igual Status do
    // WhatsApp), o resto vira um "chip" clicável com o nome do arquivo.
    if (m.type === 'other' && m.media_path) {
      const isImage = m.media_mimetype?.startsWith('image/')
      const isVideo = m.media_mimetype?.startsWith('video/')

      if (isImage) {
        return (
          <a href={`${API_BASE}/api/whatsapp/media/${m.id}`} target="_blank" rel="noreferrer" className="block">
            <img
              src={`${API_BASE}/api/whatsapp/media/${m.id}`}
              alt={m.text ?? 'imagem'}
              className="max-h-64 w-auto rounded-lg object-cover"
            />
            {m.text && m.text !== 'Foto' && <p className="mt-1 text-xs text-slate-300">{m.text}</p>}
          </a>
        )
      }

      if (isVideo) {
        return (
          <div className="flex flex-col gap-1.5">
            <video controls src={`${API_BASE}/api/whatsapp/media/${m.id}`} className="max-h-64 w-auto rounded-lg" />
            {m.text && m.text !== 'Vídeo' && <p className="text-xs text-slate-300">{m.text}</p>}
          </div>
        )
      }

      return (
        <a
          href={`${API_BASE}/api/whatsapp/media/${m.id}`}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 rounded-lg bg-midnight-900/60 px-3 py-2 text-xs text-slate-200 ring-1 ring-white/10 transition hover:bg-midnight-900"
        >
          <FileText size={16} className="text-electric-400" />
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
        <>
          {statusGroups.length > 0 && (
            <div className="border-b border-white/5 px-4 py-3">
              <div className="mx-auto flex max-w-2xl gap-3 overflow-x-auto pb-1">
                {statusGroups.map((g, idx) => {
                  const label = g.name ?? `+${g.jid.split('@')[0]}`
                  const initials = label.replace(/^\+/, '').slice(0, 2).toUpperCase()
                  return (
                    <button
                      key={g.jid}
                      onClick={() => openStatus(idx)}
                      className="flex w-16 shrink-0 cursor-pointer flex-col items-center gap-1"
                    >
                      <div
                        className={`flex h-14 w-14 items-center justify-center rounded-full p-0.5 ring-2 transition ${
                          g.hasUnseen ? 'ring-electric-400' : 'ring-white/10'
                        }`}
                      >
                        <div className="flex h-full w-full items-center justify-center overflow-hidden rounded-full bg-slate-700/50 text-sm font-semibold text-slate-200">
                          {initials}
                        </div>
                      </div>
                      <span className="max-w-full truncate text-[10px] text-slate-400">{label}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
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
                          <p className="flex min-w-0 items-center gap-1 truncate text-sm font-medium text-slate-100">
                            {c.pinned && <Pin size={11} className="shrink-0 text-electric-400" fill="currentColor" />}
                            <span className="truncate">{displayName}</span>
                          </p>
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
        </>
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
                <h2 className="flex items-center gap-1.5 font-display text-lg font-semibold text-white">
                  {openedName ?? openedJid.split('@')[0]}
                  {isOpenedPinned && <Pin size={13} className="text-electric-400" fill="currentColor" />}
                </h2>
                <p className="text-xs text-slate-500">{openedJid.endsWith('@g.us') ? 'grupo' : `+${openedJid.split('@')[0]}`}</p>
              </div>
            </div>

            <div className="flex items-center gap-1">
              {/* Chamada de voz/vídeo: a integração (Baileys) não carrega áudio/vídeo
                  de verdade, só mensagens — então em vez de fingir uma chamada que
                  toca sem som, isso abre o WhatsApp de verdade nessa conversa pra
                  você apertar o botão de ligar por lá. Não existe pra grupo porque
                  o wa.me só abre conversa individual. */}
              {!openedJid.endsWith('@g.us') && (
                <>
                  <a
                    href={`https://wa.me/${openedJid.split('@')[0]}`}
                    target="_blank"
                    rel="noreferrer"
                    title="Ligar (abre o WhatsApp de verdade — a Ley não transmite áudio/vídeo de chamada)"
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-white/5 hover:text-slate-200 cursor-pointer"
                  >
                    <Phone size={16} />
                  </a>
                  <a
                    href={`https://wa.me/${openedJid.split('@')[0]}`}
                    target="_blank"
                    rel="noreferrer"
                    title="Chamada de vídeo (abre o WhatsApp de verdade)"
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-white/5 hover:text-slate-200 cursor-pointer"
                  >
                    <Video size={16} />
                  </a>
                </>
              )}

              <div className="relative">
                <button
                  onClick={() => setChatMenuOpen((v) => !v)}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-white/5 hover:text-slate-200 cursor-pointer"
                >
                  <MoreVertical size={16} />
                </button>
                {chatMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setChatMenuOpen(false)} />
                    <div className="absolute right-0 z-20 mt-2 w-52 rounded-xl border border-white/10 bg-midnight-800 p-1.5 shadow-xl">
                      <button
                        onClick={handleTogglePin}
                        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs text-slate-200 transition hover:bg-white/5 cursor-pointer"
                      >
                        <Pin size={14} className="text-electric-400" />
                        {isOpenedPinned ? 'Desafixar conversa' : 'Fixar conversa'}
                      </button>
                      <button
                        onClick={handleClearChat}
                        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs text-slate-200 transition hover:bg-white/5 cursor-pointer"
                      >
                        <Eraser size={14} className="text-amber-400" />
                        Limpar conversa
                      </button>
                      <button
                        onClick={handleDeleteChat}
                        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs text-rose-400 transition hover:bg-rose-500/10 cursor-pointer"
                      >
                        <Trash2 size={14} />
                        Excluir conversa
                      </button>
                    </div>
                  </>
                )}
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

      {statusViewer && currentStatusItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/95">
          <div className="absolute inset-x-0 top-0 z-10 flex gap-1 p-3">
            {statusGroups[statusViewer.groupIdx]?.items.map((item, i) => (
              <div key={item.id} className="h-0.5 flex-1 overflow-hidden rounded-full bg-white/25">
                <div
                  className={
                    i < statusViewer.itemIdx
                      ? 'h-full w-full bg-white'
                      : i === statusViewer.itemIdx
                      ? 'h-full bg-white animate-statusProgress'
                      : 'h-full w-0 bg-white'
                  }
                  style={i === statusViewer.itemIdx ? { animationPlayState: statusPaused ? 'paused' : 'running' } : undefined}
                />
              </div>
            ))}
          </div>

          <div className="absolute inset-x-0 top-6 z-10 flex items-center justify-between px-4">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-700/70 text-xs font-semibold text-slate-100">
                {(
                  statusGroups[statusViewer.groupIdx]?.name ??
                  statusGroups[statusViewer.groupIdx]?.jid.split('@')[0] ??
                  '?'
                )
                  .slice(0, 2)
                  .toUpperCase()}
              </div>
              <div>
                <p className="text-sm font-medium text-white">
                  {statusGroups[statusViewer.groupIdx]?.name ??
                    `+${statusGroups[statusViewer.groupIdx]?.jid.split('@')[0]}`}
                </p>
                <p className="text-[11px] text-slate-300">
                  {new Date(currentStatusItem.created_at).toLocaleTimeString('pt-BR', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setStatusPaused((p) => !p)}
                className="rounded-full p-2 text-white/80 transition hover:bg-white/10 cursor-pointer"
                title={statusPaused ? 'Continuar' : 'Pausar'}
              >
                {statusPaused ? <Play size={16} /> : <Pause size={16} />}
              </button>
              <button
                onClick={closeStatus}
                className="rounded-full p-2 text-white/80 transition hover:bg-white/10 cursor-pointer"
                title="Fechar"
              >
                <X size={18} />
              </button>
            </div>
          </div>

          <button
            onClick={goToPrevStatus}
            className="absolute inset-y-0 left-0 z-[5] w-1/3 cursor-pointer"
            aria-label="Status anterior"
          />
          <button
            onClick={goToNextStatus}
            className="absolute inset-y-0 right-0 z-[5] w-1/3 cursor-pointer"
            aria-label="Próximo status"
          />

          <div className="relative flex h-full max-h-[90vh] w-full max-w-md items-center justify-center px-4">
            {currentStatusItem.type === 'image' && (
              <img
                src={`${API_BASE}/api/whatsapp/status-media/${currentStatusItem.id}`}
                alt="Status"
                className="max-h-full max-w-full rounded-lg object-contain"
              />
            )}
            {currentStatusItem.type === 'video' && (
              <video
                key={currentStatusItem.id}
                src={`${API_BASE}/api/whatsapp/status-media/${currentStatusItem.id}`}
                autoPlay
                playsInline
                className="max-h-full max-w-full rounded-lg object-contain"
                onEnded={goToNextStatus}
              />
            )}
            {currentStatusItem.type === 'text' && (
              <div
                className="flex h-full max-h-[70vh] w-full items-center justify-center rounded-2xl p-8 text-center"
                style={{ backgroundColor: currentStatusItem.bg_color ?? '#111827' }}
              >
                <p className="text-xl font-medium leading-relaxed text-white">{currentStatusItem.text}</p>
              </div>
            )}
            {currentStatusItem.type !== 'text' && currentStatusItem.text && (
              <p className="absolute bottom-6 left-0 right-0 px-6 text-center text-sm text-white/90">
                {currentStatusItem.text}
              </p>
            )}
          </div>

          <div className="absolute inset-x-0 bottom-0 z-20 flex flex-col gap-2 bg-gradient-to-t from-black/85 to-transparent px-4 pb-4 pt-10">
            {statusReplyError && <p className="text-center text-xs text-red-400">{statusReplyError}</p>}
            {statusReplySent && !statusReplyError && (
              <p className="text-center text-xs text-electric-300">Resposta enviada por mensagem direta.</p>
            )}
            <div className="mx-auto flex w-full max-w-md items-center gap-2">
              <input
                value={statusReplyText}
                onChange={(e) => setStatusReplyText(e.target.value)}
                onFocus={() => setStatusPaused(true)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') sendStatusReply()
                }}
                placeholder={`Responder pra ${
                  statusGroups[statusViewer.groupIdx]?.name ??
                  `+${statusGroups[statusViewer.groupIdx]?.jid.split('@')[0]}`
                }...`}
                className="flex-1 rounded-full border border-white/20 bg-black/40 px-4 py-2.5 text-sm text-white placeholder:text-white/50 focus:border-white/40 focus:outline-none"
              />
              <button
                onClick={sendStatusReply}
                disabled={!statusReplyText.trim() || statusReplySending}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-electric-500 text-white transition hover:bg-electric-600 disabled:opacity-40 cursor-pointer"
                title="Responder (mensagem direta pro dono do status)"
              >
                {statusReplySending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
