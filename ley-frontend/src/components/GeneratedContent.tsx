import { useEffect, useState, type ReactNode } from 'react'
import { API_BASE_URL } from '../config/api'
import JSZip from 'jszip'
import { Download, Copy, Check, FileCode, PackageCheck, Volume2, ChevronRight, CheckCircle2 } from 'lucide-react'

// mesma base usada pelo ChatTab pra falar com o backend — precisa bater com
// o caminho que o whatsapp-inbox-flow.ts devolve (/api/whatsapp/media/:id)
const API_BASE = API_BASE_URL

// Convenção usada pelo backend (ver src/modules/llm/file-mode.ts): quando o
// usuário manda "/criar" ou "/gerar", a Ley formata cada arquivo assim:
//
// ```linguagem path="pasta/arquivo.ext"
// conteúdo...
// ```
//
// e comandos de terminal assim (sem o atributo path):
//
// ```bash
// comando...
// ```
//
// Esse parser separa a mensagem em texto normal + blocos de arquivo + blocos
// de comando pra cada um virar um card diferente na tela.

type Segment =
  | { type: 'text'; value: string }
  | { type: 'file'; lang: string; path: string; content: string }
  | { type: 'command'; lang: string; content: string }
  // bloco especial do whatsapp-inbox-flow.ts (mensagens não lidas): o
  // conteúdo é um JSON (ver InboxPayload mais abaixo), não texto/código pra
  // mostrar cru — vira o menu de pessoas/grupos com mensagens dentro
  | { type: 'inbox'; content: string }

const CODE_BLOCK_REGEX = /```(\w+)?(?:[ \t]+path="([^"]+)")?\r?\n([\s\S]*?)```/g

export function parseMessageContent(content: string): Segment[] {
  const segments: Segment[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  CODE_BLOCK_REGEX.lastIndex = 0
  while ((match = CODE_BLOCK_REGEX.exec(content)) !== null) {
    const [full, lang = 'txt', path, code] = match

    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: content.slice(lastIndex, match.index) })
    }

    if (lang === 'inbox') {
      segments.push({ type: 'inbox', content: code.replace(/\n$/, '') })
    } else if (path) {
      segments.push({ type: 'file', lang, path, content: code.replace(/\n$/, '') })
    } else {
      segments.push({ type: 'command', lang, content: code.replace(/\n$/, '') })
    }

    lastIndex = match.index + full.length
  }

  if (lastIndex < content.length) {
    segments.push({ type: 'text', value: content.slice(lastIndex) })
  }

  return segments
}

function extensionOf(path: string): string {
  const parts = path.split('.')
  return parts.length > 1 ? parts[parts.length - 1].toUpperCase() : 'FILE'
}

function baseNameOf(path: string): string {
  return path.split('/').pop() ?? path
}

function downloadBlob(filename: string, content: string, mime = 'text/plain') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function FileCard({ path, content }: { path: string; content: string }) {
  const sizeKb = (new Blob([content]).size / 1024).toFixed(1)

  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-midnight-900/60 px-3.5 py-2.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-electric-500/15 text-electric-400">
          <FileCode size={15} />
        </div>
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-slate-100">{baseNameOf(path)}</p>
          <p className="text-[10px] text-slate-500">
            {extensionOf(path)} · {sizeKb} KB
          </p>
        </div>
      </div>
      <button
        onClick={() => downloadBlob(baseNameOf(path), content)}
        className="flex shrink-0 items-center gap-1.5 rounded-lg bg-electric-500 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-electric-600 cursor-pointer"
      >
        <Download size={13} />
        Baixar
      </button>
    </div>
  )
}

// bloco especial pra mensagens de voz recebidas no WhatsApp (ver
// whatsapp-inbox-flow.ts no backend): mesma convenção de code fence com
// "path", mas com lang="audio" — em vez de oferecer download, toca o áudio
// direto servido pelo backend, com a transcrição (se houver) logo abaixo.
function AudioCard({ path, content }: { path: string; content: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-white/10 bg-midnight-900/60 px-3.5 py-2.5">
      <div className="flex items-center gap-2 text-xs font-medium text-slate-100">
        <Volume2 size={15} className="text-electric-400" />
        Mensagem de voz recebida
      </div>
      <audio controls src={`${API_BASE}${path}`} className="w-full" />
      {content.trim() && <p className="text-xs italic text-slate-400">"{content.trim()}"</p>}
    </div>
  )
}

// --- Menu de mensagens não lidas (ver whatsapp-inbox-flow.ts no backend) ---
// bloco ```inbox com um JSON: { scope: 'individual'|'grupo', contacts: [...] }.
// Cada contato vira uma linha clicável que abre a conversa INTEIRA (os dois
// lados, com hora) — não só o resumo de mensagens não lidas que veio no bloco.

interface InboxMessage {
  type: 'text' | 'audio'
  content?: string
  path?: string
  transcript?: string | null
}

interface InboxContact {
  name: string | null
  digits: string
  jid: string
  messages: InboxMessage[]
}

interface InboxPayload {
  scope: 'individual' | 'grupo'
  contacts: InboxContact[]
}

// formato bruto que vem de GET /api/whatsapp/conversation/:jid (mesmo
// WaMessageRow do backend) — inclui os dois lados da conversa e created_at,
// que o resumo do bloco "inbox" não tinha.
interface ConversationMessage {
  id: string
  from_me: 0 | 1
  type: 'text' | 'audio' | 'other'
  text: string | null
  transcript: string | null
  media_path: string | null
  created_at: number
}

function formatMessageTime(ms: number): string {
  const d = new Date(ms)
  const today = new Date()
  const isToday = d.toDateString() === today.toDateString()
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  if (isToday) return time
  return `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${time}`
}

function ConversationMessageRow({ msg }: { msg: ConversationMessage }) {
  const fromMe = msg.from_me === 1
  const time = formatMessageTime(msg.created_at)

  return (
    <div className={`flex ${fromMe ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`flex max-w-[80%] flex-col gap-1.5 rounded-lg px-3 py-2 ${
          fromMe ? 'bg-electric-500/15' : 'bg-midnight-900/70'
        }`}
      >
        {msg.type === 'audio' && msg.media_path ? (
          <>
            <audio controls preload="auto" src={`${API_BASE}/api/whatsapp/media/${msg.id}`} className="w-full" />
            {msg.transcript && <p className="text-xs italic text-slate-400">"{msg.transcript}"</p>}
          </>
        ) : (
          <p className="text-xs text-slate-200 whitespace-pre-wrap">
            {msg.text ?? '(mensagem de um tipo que ainda não sei ler)'}
          </p>
        )}
        <span className="self-end text-[10px] text-slate-500">{time}</span>
      </div>
    </div>
  )
}

// Linha clicável na lista — abre a conversa como uma página separada por
// cima de tudo (ver ContactConversationOverlay abaixo), em vez de expandir
// inline.
function InboxContactRow({ contact, onOpen }: { contact: InboxContact; onOpen: (c: InboxContact) => void }) {
  const label = contact.name ?? `Número ${contact.digits}`

  return (
    <button
      onClick={() => onOpen(contact)}
      className="flex w-full items-center justify-between rounded-xl border border-white/10 bg-midnight-900/40 px-3.5 py-2.5 text-left text-sm font-medium text-slate-100 transition hover:bg-white/5 cursor-pointer"
    >
      <span className="flex items-center gap-2.5 min-w-0">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-electric-500/20 text-[10px] font-semibold text-electric-300">
          {contact.messages.length}
        </span>
        <span className="truncate">{label}</span>
      </span>
      <ChevronRight size={16} className="shrink-0 text-slate-500" />
    </button>
  )
}

// Painel em tela cheia que abre por cima de todo o chat quando um contato é
// clicado — visualmente é "outra página", com botão de voltar no topo.
//
// BUG corrigido aqui: antes esse painel só mostrava os campos que já vinham
// prontos no bloco "inbox" (só mensagens NÃO LIDAS, só do outro lado, sem
// hora). Agora ele busca a conversa inteira em /api/whatsapp/conversation/:jid
// assim que abre — os dois lados (inclusive o que você mandou) e com horário.
function ContactConversationOverlay({ contact, onClose }: { contact: InboxContact; onClose: () => void }) {
  const label = contact.name ?? `Número ${contact.digits}`
  const [messages, setMessages] = useState<ConversationMessage[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setMessages(null)
    setError(null)

    fetch(`${API_BASE}/api/whatsapp/conversation/${encodeURIComponent(contact.jid)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Erro ${res.status}`)
        return res.json()
      })
      .then((data: ConversationMessage[]) => {
        if (!cancelled) setMessages(data)
      })
      .catch(() => {
        if (!cancelled) setError('Não consegui carregar essa conversa agora.')
      })

    return () => {
      cancelled = true
    }
  }, [contact.jid])

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-midnight-950">
      <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3 shadow-md">
        <button
          onClick={onClose}
          title="Voltar"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-300 transition hover:bg-white/5 cursor-pointer"
        >
          <ChevronRight size={18} className="rotate-180" />
        </button>
        <span className="truncate text-sm font-semibold text-slate-100">{label}</span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex max-w-2xl flex-col gap-2">
          {error && <p className="text-center text-xs text-red-300">{error}</p>}
          {!error && messages === null && (
            <p className="text-center text-xs text-slate-500">Carregando conversa...</p>
          )}
          {messages?.map((m) => (
            <ConversationMessageRow key={m.id} msg={m} />
          ))}
        </div>
      </div>
    </div>
  )
}

function InboxBlock({ content }: { content: string }) {
  let payload: InboxPayload | null = null
  try {
    payload = JSON.parse(content)
  } catch {
    payload = null
  }

  const [selected, setSelected] = useState<InboxContact | null>(null)

  if (!payload || !Array.isArray(payload.contacts) || payload.contacts.length === 0) return null

  return (
    <>
      <div className="flex flex-col gap-2">
        {payload.contacts.map((c, i) => (
          <InboxContactRow key={i} contact={c} onOpen={setSelected} />
        ))}
      </div>

      {selected && (
        <ContactConversationOverlay contact={selected} onClose={() => setSelected(null)} />
      )}
    </>
  )
}

function CommandBlock({ lang, content }: { lang: string; content: string }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    await navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-midnight-900/80">
      <div className="flex items-center justify-between border-b border-white/5 px-3 py-1.5">
        <span className="text-[10px] uppercase tracking-wide text-slate-500">{lang}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-slate-400 transition hover:bg-white/5 hover:text-slate-200 cursor-pointer"
        >
          {copied ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
          {copied ? 'Copiado' : 'Copiar'}
        </button>
      </div>
      <pre className="overflow-x-auto px-3.5 py-2.5 text-xs text-slate-300">
        <code>{content}</code>
      </pre>
    </div>
  )
}

function DownloadAllButton({ files }: { files: { path: string; content: string }[] }) {
  const [zipping, setZipping] = useState(false)

  async function handleDownloadAll() {
    setZipping(true)
    try {
      const zip = new JSZip()
      files.forEach((f) => zip.file(f.path, f.content))
      const blob = await zip.generateAsync({ type: 'blob' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'arquivos-ley.zip'
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } finally {
      setZipping(false)
    }
  }

  return (
    <button
      onClick={handleDownloadAll}
      disabled={zipping}
      className="flex items-center gap-1.5 self-start rounded-lg border border-electric-500/30 bg-electric-500/10 px-3 py-1.5 text-xs font-medium text-electric-300 transition hover:bg-electric-500/20 disabled:opacity-50 cursor-pointer"
    >
      <PackageCheck size={13} />
      {zipping ? 'Compactando...' : 'Baixar tudo (.zip)'}
    </button>
  )
}

// --- Markdown leve (o que a Ley costuma usar: **negrito**, *itálico*,
// ~~riscado~~, `código`, [link](url), ## títulos, > citação, listas
// numeradas "1. " e com marcador "- "/"* ", linha horizontal "---") -------

function parseInline(text: string): ReactNode[] {
  const parts: ReactNode[] = []
  // ordem importa: bold (**) e link ([...]( )) precisam vir antes do
  // itálico de asterisco único, senão o itálico "come" metade do token bold
  const regex = /(\*\*[^*]+\*\*|~~[^~]+~~|\[[^[\]]+\]\([^()\s]+\)|`[^`]+`|\*[^*\n]+\*|(?<!\w)_[^_\n]+_(?!\w))/g
  let lastIndex = 0
  let m: RegExpExecArray | null
  let key = 0

  while ((m = regex.exec(text)) !== null) {
    if (m.index > lastIndex) parts.push(text.slice(lastIndex, m.index))
    const token = m[0]

    if (token.startsWith('**')) {
      parts.push(
        <strong key={key++} className="font-semibold text-slate-100">
          {token.slice(2, -2)}
        </strong>
      )
    } else if (token.startsWith('~~')) {
      parts.push(
        <del key={key++} className="text-slate-500">
          {token.slice(2, -2)}
        </del>
      )
    } else if (token.startsWith('[')) {
      const linkMatch = token.match(/^\[([^[\]]+)\]\(([^()\s]+)\)$/)
      if (linkMatch) {
        parts.push(
          <a
            key={key++}
            href={linkMatch[2]}
            target="_blank"
            rel="noopener noreferrer"
            className="text-electric-400 underline underline-offset-2 hover:text-electric-300"
          >
            {linkMatch[1]}
          </a>
        )
      } else {
        parts.push(token)
      }
    } else if (token.startsWith('`')) {
      parts.push(
        <code key={key++} className="rounded bg-white/10 px-1 py-0.5 text-[0.85em]">
          {token.slice(1, -1)}
        </code>
      )
    } else {
      // *itálico* ou _itálico_
      parts.push(
        <em key={key++} className="text-slate-200">
          {token.slice(1, -1)}
        </em>
      )
    }
    lastIndex = m.index + token.length
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex))
  return parts
}

function headerClass(level: number): string {
  if (level === 1) return 'text-base font-bold text-slate-100'
  if (level === 2) return 'text-sm font-bold text-electric-400'
  return 'text-sm font-semibold text-slate-200'
}

function renderTextBlock(text: string): ReactNode[] {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let key = 0

  const isHeader = (l: string) => /^#{1,4}\s+/.test(l)
  const isNumbered = (l: string) => /^\d+[.)]\s+/.test(l)
  const isBullet = (l: string) => /^[-*]\s+/.test(l)
  const isQuote = (l: string) => /^>\s?/.test(l)
  const isHr = (l: string) => /^(-{3,}|\*{3,}|_{3,})$/.test(l.trim())

  while (i < lines.length) {
    const line = lines[i]

    if (!line.trim()) {
      i++
      continue
    }

    if (isHr(line)) {
      blocks.push(<hr key={key++} className="my-1 border-white/10" />)
      i++
      continue
    }

    if (isQuote(line)) {
      const items: string[] = []
      while (i < lines.length && isQuote(lines[i])) {
        items.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      blocks.push(
        <blockquote key={key++} className="border-l-2 border-electric-400/40 pl-3 text-slate-400 italic">
          {parseInline(items.join('\n'))}
        </blockquote>
      )
      continue
    }

    const headerMatch = line.match(/^(#{1,4})\s+(.*)$/)
    if (headerMatch) {
      blocks.push(
        <p key={key++} className={headerClass(headerMatch[1].length)}>
          {parseInline(headerMatch[2])}
        </p>
      )
      i++
      continue
    }

    if (isNumbered(line)) {
      const items: string[] = []
      while (i < lines.length && isNumbered(lines[i])) {
        items.push(lines[i].replace(/^\d+[.)]\s+/, ''))
        i++
      }
      blocks.push(
        <ol key={key++} className="list-decimal space-y-1 pl-5">
          {items.map((it, idx) => (
            <li key={idx}>{parseInline(it)}</li>
          ))}
        </ol>
      )
      continue
    }

    if (isBullet(line)) {
      const items: string[] = []
      while (i < lines.length && isBullet(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ''))
        i++
      }
      blocks.push(
        <ul key={key++} className="list-disc space-y-1 pl-5">
          {items.map((it, idx) => (
            <li key={idx}>{parseInline(it)}</li>
          ))}
        </ul>
      )
      continue
    }

    const paraLines: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !isHeader(lines[i]) &&
      !isNumbered(lines[i]) &&
      !isBullet(lines[i]) &&
      !isQuote(lines[i]) &&
      !isHr(lines[i])
    ) {
      paraLines.push(lines[i])
      i++
    }
    blocks.push(
      <p key={key++} className="whitespace-pre-wrap leading-relaxed">
        {parseInline(paraLines.join('\n'))}
      </p>
    )
  }

  return blocks
}

// Mesma convenção do backend (ver src/modules/llm/action-marker.ts): quando
// uma resposta é resultado de uma ação de verdade (criou tarefa, bloqueou
// contato, criou grupo etc — não só conversa), ela vem prefixada com
// ⟦ACTION:rótulo⟧. Extraímos o rótulo e mostramos um selinho antes do texto,
// igual ao "Editou 2 arquivos" que aparece nas respostas do Claude.
function extractAction(content: string): { label: string | null; rest: string } {
  const match = content.match(/^\u27e6ACTION:([^\u27e7]+)\u27e7([\s\S]*)$/)
  if (!match) return { label: null, rest: content }
  return { label: match[1], rest: match[2] }
}

function ActionBadge({ label }: { label: string }) {
  return (
    <div className="mb-1 inline-flex w-fit items-center gap-1.5 rounded-md bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-400 ring-1 ring-emerald-500/20">
      <CheckCircle2 size={12} />
      {label}
    </div>
  )
}

export function MessageContent({ content }: { content: string }) {
  const { label: actionLabel, rest: contentWithoutAction } = extractAction(content)
  const segments = parseMessageContent(contentWithoutAction)

  // arquivos ficam separados do resumo em texto — sempre num bloco próprio
  // no final da mensagem, nunca misturados entre os parágrafos. Blocos de
  // áudio (mensagens de voz recebidas no WhatsApp) são um caso à parte:
  // tocam em vez de baixar, e não entram no "baixar tudo" nem na contagem
  // de arquivos gerados. Blocos "inbox" (menu de mensagens não lidas) também
  // são renderizados à parte, como um segmento próprio.
  const allFileSegs = segments.filter((s): s is Extract<Segment, { type: 'file' }> => s.type === 'file')
  const audios = allFileSegs.filter((f) => f.lang === 'audio')
  const files = allFileSegs.filter((f) => f.lang !== 'audio')
  const inboxBlocks = segments.filter((s): s is Extract<Segment, { type: 'inbox' }> => s.type === 'inbox')
  const rest = segments.filter(
    (s): s is Exclude<Segment, { type: 'file' } | { type: 'inbox' }> => s.type !== 'file' && s.type !== 'inbox'
  )

  return (
    <div className="flex flex-col gap-2.5">
      {actionLabel && <ActionBadge label={actionLabel} />}
      {rest.map((seg, i) => {
        if (seg.type === 'text') {
          if (!seg.value.trim()) return null
          return <div key={i}>{renderTextBlock(seg.value.trim())}</div>
        }
        return <CommandBlock key={i} lang={seg.lang} content={seg.content} />
      })}

      {inboxBlocks.map((b, i) => (
        <InboxBlock key={i} content={b.content} />
      ))}

      {audios.map((a, i) => (
        <AudioCard key={i} path={a.path} content={a.content} />
      ))}

      {files.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-white/10 pt-2.5">
          <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
            {files.length > 1 ? 'Arquivos gerados' : 'Arquivo gerado'}
          </span>
          {files.map((f, i) => (
            <FileCard key={i} path={f.path} content={f.content} />
          ))}
          {files.length >= 2 && <DownloadAllButton files={files} />}
        </div>
      )}
    </div>
  )
}
