import { useEffect, useRef, useState, useCallback } from 'react'
import { API_BASE_URL } from '../config/api'
import { Mic, Send, User, Square, Trash2, Paperclip, Camera, X, ChevronDown, Cpu, FileText, Copy, Check } from 'lucide-react'
import VoiceModal from './VoiceModal'
import { MessageContent, parseMessageContent } from './GeneratedContent'
import LeyAvatar from './LeyAvatar'

interface ChatMessage {
  id: string
  role: 'user' | 'ley'
  content: string
}

interface ModelInfo {
  id: string
  ownedBy?: string
}

const STORAGE_KEY_CONVO = 'ley:conversationId'
const STORAGE_KEY_HISTORY = 'ley:chatHistory'
const API_BASE = API_BASE_URL
const API_URL = `${API_BASE}/api/chat`

// nome mais curto/legível pra mostrar no seletor, sem mexer no id real usado na API
function formatModelLabel(id: string): string {
  return id.split('/').pop()?.replace(/-/g, ' ') ?? id
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

interface ChatTabProps {
  // registra um listener pro canal "chat" do WebSocket (ver useLeyWebSocket) —
  // usado aqui pra receber avisos que o backend manda sozinho (ex: "fulano te
  // mandou mensagem no zap"), sem precisar o usuário mandar nada primeiro.
  onChatEvent?: (fn: (data: any) => void) => () => void
  // dispara toda vez que uma resposta da Ley traz um ou mais blocos de
  // arquivo (```linguagem path="..."), pro App.tsx decidir se entra no
  // projeto ativo e abrir o painel lateral
  onFilesGenerated?: (files: { path: string; content: string }[]) => void
}

export default function ChatTab({ onChatEvent, onFilesGenerated }: ChatTabProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    const saved = localStorage.getItem(STORAGE_KEY_HISTORY)
    return saved ? JSON.parse(saved) : []
  })
  const [input, setInput] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const copyMessage = useCallback((id: string, content: string) => {
    navigator.clipboard.writeText(content).then(() => {
      setCopiedId(id)
      setTimeout(() => setCopiedId((current) => (current === id ? null : current)), 1500)
    }).catch(() => {})
  }, [])
  const [error, setError] = useState<string | null>(null)
  const [voiceOpen, setVoiceOpen] = useState(false)

  // fluxo "manda um áudio pra fulano com a minha voz": quando a Ley pede pra
  // gravar, mostramos o botão de gravação até o áudio ser enviado
  const [awaitingVoiceRecording, setAwaitingVoiceRecording] = useState(false)
  const [recording, setRecording] = useState(false)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordedChunksRef = useRef<Blob[]>([])

  // seletor de modelo (com fallback automático no backend em caso de rate limit)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [activeModel, setActiveModel] = useState<string | null>(null)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [modelError, setModelError] = useState<string | null>(null)

  // arquivos anexados (upload comum ou foto tirada na hora), ainda não enviados
  const [attachedFiles, setAttachedFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)

  const conversationId = useRef<string | null>(localStorage.getItem(STORAGE_KEY_CONVO))
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetch(`${API_BASE}/api/models`)
      .then((res) => res.json())
      .then((data) => {
        setModels(data.models ?? [])
        setActiveModel(data.active ?? null)
      })
      .catch(() => setModelError('Não deu pra carregar a lista de modelos.'))
  }, [])

  const selectModel = useCallback(async (modelId: string) => {
    setModelError(null)
    try {
      const res = await fetch(`${API_BASE}/api/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'falha ao trocar de modelo')
      setActiveModel(data.active)
      setModelMenuOpen(false)
    } catch (err) {
      setModelError(err instanceof Error ? err.message : 'falha ao trocar de modelo')
    }
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isTyping])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(messages))
  }, [messages])

  // Aviso que o backend manda sozinho (whatsapp-notify.ts), sem o usuário ter
  // mandado nada — ex: "fulano te mandou mensagem no zap". Só entra na lista
  // se: (1) for marcado como notification (pra não duplicar o eco normal da
  // própria mensagem do usuário/resposta, que já chegam pelo fetch acima) e
  // (2) for da conversa que tá aberta aqui (evita mostrar aviso de uma sessão
  // antiga/outro dispositivo).
  useEffect(() => {
    if (!onChatEvent) return

    const unsubscribe = onChatEvent((data) => {
      if (!data || !data.notification) return
      if (conversationId.current && data.conversationId && data.conversationId !== conversationId.current) return

      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: 'ley', content: data.content },
      ])
    })

    return unsubscribe
  }, [onChatEvent])

  // Função estabilizada com useCallback para não disparar re-render no VoiceModal
  const handleSendMessage = useCallback(async (textToSend: string, imageBase64?: string): Promise<string | void> => {
    const text = textToSend.trim()
    if (!text) return

    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: text }
    setMessages((prev) => [...prev, userMsg])
    setIsTyping(true)
    setError(null)

    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          conversationId: conversationId.current ?? undefined,
          imageBase64,
        }),
      })

      if (!res.ok) {
        const errBody = await res.json().catch(() => null)
        throw new Error(errBody?.detail ?? errBody?.error ?? `Erro ${res.status}`)
      }

      const data = await res.json()

      if (data.conversationId) {
        conversationId.current = data.conversationId
        localStorage.setItem(STORAGE_KEY_CONVO, data.conversationId)
      }

      const replyText = data.reply ?? '(sem resposta)'

      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: 'ley', content: replyText },
      ])
      setAwaitingVoiceRecording(!!data.awaitingVoiceRecording)

      // se a resposta veio com bloco(s) de arquivo, avisa o App (que decide
      // se entra no projeto ativo) e abre o painel lateral, igual ao Claude
      // quando termina de gerar um código/arquivo
      if (onFilesGenerated) {
        const fileSegs = parseMessageContent(replyText).filter(
          (s): s is Extract<typeof s, { type: 'file' }> => s.type === 'file' && s.lang !== 'audio'
        )
        if (fileSegs.length > 0) {
          onFilesGenerated(fileSegs.map((f) => ({ path: f.path, content: f.content })))
        }
      }

      return replyText
    } catch (err) {
      // TypeError = fetch nem conseguiu conectar (backend fora do ar de verdade).
      // Qualquer outro erro (ex: "Erro 502") é o backend respondendo normalmente,
      // só que com falha — geralmente rate limit da Groq, não o servidor caído.
      if (err instanceof TypeError) {
        setError('Não foi possível falar com a Ley. Verifique se o backend está rodando.')
      } else {
        const reason = err instanceof Error ? err.message : ''
        const looksLikeQuota = /rate limit|rate_limit|quota|overloaded|429/i.test(reason)
        setError(
          looksLikeQuota
            ? 'A Ley teve um problema ao responder agora (cota da Groq esgotada). O backend está rodando normalmente — tenta de novo em alguns minutos.'
            : `A Ley teve um problema ao responder agora${reason ? `: ${reason}` : ''}. O backend está rodando normalmente.`
        )
      }
      throw err
    } finally {
      setIsTyping(false)
    }
  }, [])

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      recordedChunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunksRef.current.push(e.data)
      }

      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop())
        const blob = new Blob(recordedChunksRef.current, { type: 'audio/webm' })
        await sendRecordedAudio(blob)
      }

      mediaRecorderRef.current = recorder
      recorder.start()
      setRecording(true)
    } catch (err) {
      console.error('Erro ao acessar microfone:', err)
      setError('Não foi possível acessar o microfone.')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const stopRecording = useCallback(() => {
    mediaRecorderRef.current?.stop()
    setRecording(false)
  }, [])

  const sendRecordedAudio = useCallback(async (blob: Blob) => {
    if (!conversationId.current) return

    setIsTyping(true)
    try {
      const form = new FormData()
      form.append('conversationId', conversationId.current)
      form.append('audio', blob, 'gravacao.webm')

      const res = await fetch(`${API_BASE}/api/chat/send-my-voice`, {
        method: 'POST',
        body: form,
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'falha ao enviar áudio')

      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: 'ley', content: data.reply ?? 'Áudio enviado.' },
      ])
    } catch (err) {
      console.error('Erro ao enviar áudio gravado:', err)
      setError('Não consegui enviar o áudio gravado pro WhatsApp.')
    } finally {
      setAwaitingVoiceRecording(false)
      setIsTyping(false)
    }
  }, [])

  const closeVoiceModal = useCallback(() => {
    setVoiceOpen(false)
  }, [])

  function handleFilesPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    if (files.length > 0) setAttachedFiles((prev) => [...prev, ...files])
    e.target.value = '' // permite selecionar o mesmo arquivo de novo depois
  }

  function removeAttachedFile(index: number) {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index))
  }

  // envia a mensagem junto com os arquivos anexados (upload comum ou foto da câmera)
  const sendMessageWithFiles = useCallback(async (text: string, files: File[]) => {
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text.trim() || `📎 ${files.map((f) => f.name).join(', ')}`,
    }
    setMessages((prev) => [...prev, userMsg])
    setIsTyping(true)
    setUploading(true)
    setError(null)

    try {
      const form = new FormData()
      if (conversationId.current) form.append('conversationId', conversationId.current)
      form.append('message', text.trim())
      files.forEach((file) => form.append('files', file, file.name))

      const res = await fetch(`${API_BASE}/api/chat/upload`, { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? `Erro ${res.status}`)

      if (data.conversationId) {
        conversationId.current = data.conversationId
        localStorage.setItem(STORAGE_KEY_CONVO, data.conversationId)
      }

      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: 'ley', content: data.reply ?? '(sem resposta)' },
      ])
      setAwaitingVoiceRecording(!!data.awaitingVoiceRecording)
    } catch (err) {
      setError(
        err instanceof TypeError
          ? 'Não foi possível falar com a Ley. Verifique se o backend está rodando.'
          : 'Não consegui enviar o(s) arquivo(s) agora. Tenta de novo em alguns instantes.'
      )
    } finally {
      setIsTyping(false)
      setUploading(false)
    }
  }, [])

  // Limpa só o que aparece na tela. NÃO mexe no conversationId nem em nada no
  // backend — o histórico real (o que a Ley usa como contexto) continua
  // intacto no SQLite. É só uma "tela em branco" pra você, a memória dela
  // não é afetada.
  const clearVisibleHistory = useCallback(() => {
    if (!window.confirm('Limpar a conversa da tela? A Ley continua lembrando de tudo — isso só limpa o que aparece aqui.')) {
      return
    }
    setMessages([])
    localStorage.removeItem(STORAGE_KEY_HISTORY)
  }, [])

  function sendMessageFromInput() {
    if (isTyping || uploading) return
    if (attachedFiles.length === 0 && !input.trim()) return

    const text = input
    const files = attachedFiles
    setInput('')
    setAttachedFiles([])

    if (files.length > 0) {
      sendMessageWithFiles(text, files).catch(() => {})
      return
    }

    // handleSendMessage já seta o estado de erro pra mostrar na tela; o catch
    // aqui é só pra não sobrar unhandled rejection no console do navegador
    handleSendMessage(text).catch(() => {})
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') sendMessageFromInput()
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-white/5 px-6 py-4">
        <div>
          <h1 className="font-display text-xl font-semibold text-white">Chat</h1>
          <p className="text-sm text-slate-400">
            Converse com a Ley em tempo real · use <span className="text-electric-400">/criar</span> ou{' '}
            <span className="text-electric-400">/gerar</span> pra pedir um arquivo pra baixar
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <button
              onClick={() => setModelMenuOpen((v) => !v)}
              title="Escolher o modelo usado pela Ley (se um bater rate limit, ela tenta outro sozinha)"
              className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-400 hover:bg-white/5 hover:text-slate-200 transition cursor-pointer"
            >
              <Cpu size={14} />
              {activeModel ? formatModelLabel(activeModel) : 'Modelo'}
              <ChevronDown size={12} />
            </button>

            {modelMenuOpen && (
              <div className="absolute right-0 z-10 mt-2 w-64 rounded-xl border border-white/10 bg-midnight-800 p-1.5 shadow-xl">
                {modelError && (
                  <p className="px-2 py-1.5 text-[11px] text-red-300">{modelError}</p>
                )}
                {models.length === 0 && !modelError && (
                  <p className="px-2 py-1.5 text-[11px] text-slate-500">Carregando modelos...</p>
                )}
                <div className="max-h-72 overflow-y-auto">
                  {models.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => selectModel(m.id)}
                      className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs transition cursor-pointer ${
                        m.id === activeModel
                          ? 'bg-electric-500/15 text-electric-300'
                          : 'text-slate-300 hover:bg-white/5'
                      }`}
                    >
                      <span className="capitalize">{formatModelLabel(m.id)}</span>
                      {m.id === activeModel && <span className="text-[10px]">ativo</span>}
                    </button>
                  ))}
                </div>
                <p className="mt-1 border-t border-white/5 px-2.5 pt-1.5 text-[10px] text-slate-500">
                  Se o modelo escolhido bater rate limit, a Ley tenta outro sozinha nessa mesma mensagem.
                </p>
              </div>
            )}
          </div>

          <button
            onClick={clearVisibleHistory}
            title="Limpar histórico da tela (a Ley continua lembrando de tudo)"
            className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-400 hover:bg-white/5 hover:text-slate-200 transition cursor-pointer"
          >
            <Trash2 size={14} />
            Limpar tela
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-center text-slate-500">
            <div className="mb-4 flex h-14 w-14 items-center justify-center">
              <LeyAvatar size={56} />
            </div>
            <p className="text-sm">Envie uma mensagem para começar a conversar com a Ley.</p>
          </div>
        )}

        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {messages.map((m) => (
            <div
              key={m.id}
              className={`group flex items-start gap-3 ${m.role === 'user' ? 'flex-row-reverse' : ''}`}
            >
              <div
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                  m.role === 'user' ? 'bg-cobalt-500/20 text-cobalt-400' : ''
                }`}
              >
                {m.role === 'user' ? <User size={16} /> : <LeyAvatar size={30} />}
              </div>
              <div
                className={`flex flex-col gap-1 ${
                  m.role === 'user' ? 'max-w-[75%] items-end' : 'w-full max-w-full items-start'
                }`}
              >
                {m.role === 'user' ? (
                  <div className="rounded-2xl rounded-tr-sm border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm leading-relaxed text-slate-100 shadow-md backdrop-blur-xl">
                    {m.content}
                  </div>
                ) : (
                  // sem bolha/borda/fundo aqui de propósito — texto solto,
                  // igual ao jeito que o Claude renderiza as próprias respostas
                  <div className="w-full px-0.5 py-1 text-sm leading-relaxed text-slate-200">
                    <MessageContent content={m.content} />
                  </div>
                )}

                {m.role === 'ley' && (
                  <button
                    onClick={() => copyMessage(m.id, m.content)}
                    className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-slate-500 opacity-0 transition hover:text-slate-300 group-hover:opacity-100"
                    title="Copiar resposta"
                  >
                    {copiedId === m.id ? (
                      <>
                        <Check size={12} className="text-emerald-400" /> Copiado
                      </>
                    ) : (
                      <>
                        <Copy size={12} /> Copiar
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          ))}

          {isTyping && (
            <div className="flex items-start gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
                <LeyAvatar size={30} active />
              </div>
              <div className="flex items-center gap-1 rounded-2xl rounded-tl-sm border border-white/10 bg-white/[0.03] px-4 py-3 backdrop-blur-xl">
                <span className="text-xs text-slate-400 mr-1">Ley digitando</span>
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-electric-400" />
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-electric-400" />
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-electric-400" />
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {error && (
        <div className="mx-6 mb-2 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {awaitingVoiceRecording && (
        <div className="mx-6 mb-2 flex items-center justify-between rounded-lg border border-electric-500/30 bg-electric-500/10 px-4 py-2.5 text-xs text-electric-300">
          <span>
            {recording ? 'Gravando... aperta de novo pra parar e enviar.' : 'A Ley tá esperando você gravar o áudio.'}
          </span>
          <button
            onClick={recording ? stopRecording : startRecording}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium transition cursor-pointer ${
              recording
                ? 'bg-red-500/20 text-red-300 ring-1 ring-red-500/40 animate-pulse'
                : 'bg-electric-500 text-white hover:bg-electric-600'
            }`}
          >
            {recording ? <Square size={14} /> : <Mic size={14} />}
            {recording ? 'Parar e enviar' : 'Gravar áudio'}
          </button>
        </div>
      )}

      <div className="border-t border-white/5 px-6 py-4">
        <div className="mx-auto max-w-3xl">
          {attachedFiles.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {attachedFiles.map((file, i) => (
                <div
                  key={`${file.name}-${i}`}
                  className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-midnight-800 px-2.5 py-1.5 text-xs text-slate-300"
                >
                  <FileText size={13} className="text-electric-400" />
                  <span className="max-w-[160px] truncate">{file.name}</span>
                  <span className="text-slate-500">{formatFileSize(file.size)}</span>
                  <button
                    onClick={() => removeAttachedFile(i)}
                    title="Remover anexo"
                    className="ml-0.5 text-slate-500 hover:text-red-300 cursor-pointer"
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 shadow-inner backdrop-blur-xl">
            {/* input escondido: anexar qualquer tipo de arquivo */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="*/*"
              onChange={handleFilesPicked}
              className="hidden"
            />
            {/* input escondido: tirar foto na hora (abre a câmera no celular) */}
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handleFilesPicked}
              className="hidden"
            />

            <button
              onClick={() => fileInputRef.current?.click()}
              title="Anexar arquivo"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-midnight-700 text-slate-300 hover:bg-midnight-600 transition cursor-pointer"
            >
              <Paperclip size={16} />
            </button>
            <button
              onClick={() => cameraInputRef.current?.click()}
              title="Tirar foto"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-midnight-700 text-slate-300 hover:bg-midnight-600 transition cursor-pointer"
            >
              <Camera size={16} />
            </button>

            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Digite sua mensagem para a Ley..."
              className="flex-1 bg-transparent py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none"
            />
            <button
              onClick={() => setVoiceOpen(true)}
              title="Conversar por voz"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-midnight-700 text-electric-400 hover:bg-midnight-600 transition cursor-pointer"
            >
              <Mic size={16} />
            </button>
            <button
              onClick={sendMessageFromInput}
              disabled={(!input.trim() && attachedFiles.length === 0) || isTyping || uploading}
              className="flex h-9 w-9 items-center justify-center rounded-lg bg-electric-500 text-white hover:bg-electric-600 disabled:opacity-30 transition cursor-pointer"
            >
              <Send size={16} />
            </button>
          </div>
        </div>
      </div>

      <VoiceModal
        isOpen={voiceOpen}
        onClose={closeVoiceModal}
        onSendMessage={handleSendMessage}
        sessionId={conversationId.current ?? undefined}
      />
    </div>
  )
}
