import { useEffect, useState } from 'react'
import { API_BASE_URL } from '../config/api'
import { Mail, CheckCircle2, Loader2, AlertTriangle, LogOut, Send } from 'lucide-react'

type GmailStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

interface GmailTabProps {
  onGmailEvent: (fn: (event: string, data: any) => void) => () => void
}

interface EmailNotice {
  id: string
  from: string
  subject: string
  date: string
}

const API_URL = `${API_BASE_URL}/api/gmail`

export default function GmailTab({ onGmailEvent }: GmailTabProps) {
  const [status, setStatus] = useState<GmailStatus>('disconnected')
  const [email, setEmail] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [notices, setNotices] = useState<EmailNotice[]>([])

  const [formEmail, setFormEmail] = useState('')
  const [formPassword, setFormPassword] = useState('')
  const [connecting, setConnecting] = useState(false)

  const [sendTo, setSendTo] = useState('')
  const [sendSubject, setSendSubject] = useState('')
  const [sendText, setSendText] = useState('')
  const [sending, setSending] = useState(false)
  const [sendFeedback, setSendFeedback] = useState<string | null>(null)

  useEffect(() => {
    // sincroniza estado atual assim que a aba monta, sem depender só de eventos futuros
    fetch(`${API_URL}/status`)
      .then((res) => res.json())
      .then((data) => {
        if (data?.status) setStatus(data.status)
        if (data?.email) setEmail(data.email)
      })
      .catch(() => {})

    const unsubscribe = onGmailEvent((event, data) => {
      if (event === 'status') {
        setStatus(data?.status ?? 'disconnected')
        setEmail(data?.email ?? null)
        if (data?.status !== 'error') setErrorMessage(null)
      } else if (event === 'connected') {
        setStatus('connected')
        setEmail(data?.email ?? null)
        setErrorMessage(null)
      } else if (event === 'disconnected') {
        setStatus('disconnected')
        setEmail(null)
        setNotices([])
      } else if (event === 'error') {
        setStatus('error')
        setErrorMessage(data?.message ?? 'Ocorreu um erro na conexão com o Gmail.')
      } else if (event === 'new_email') {
        setNotices((prev) => [
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            from: data?.from ?? 'desconhecido',
            subject: data?.subject ?? '(sem assunto)',
            date: data?.date ?? new Date().toISOString(),
          },
          ...prev.slice(0, 19),
        ])
      }
    })
    return unsubscribe
  }, [onGmailEvent])

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault()
    setConnecting(true)
    setErrorMessage(null)
    try {
      const res = await fetch(`${API_URL}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: formEmail, appPassword: formPassword }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? 'Não foi possível conectar')
      }
      setFormPassword('')
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Não foi possível conectar')
    } finally {
      setConnecting(false)
    }
  }

  const handleDisconnect = async () => {
    await fetch(`${API_URL}/disconnect`, { method: 'POST' }).catch(() => {})
  }

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault()
    setSending(true)
    setSendFeedback(null)
    try {
      const res = await fetch(`${API_URL}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: sendTo, subject: sendSubject, text: sendText }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.error ?? 'Falha ao enviar e-mail')
      setSendFeedback('E-mail enviado com sucesso!')
      setSendTo('')
      setSendSubject('')
      setSendText('')
    } catch (err) {
      setSendFeedback(err instanceof Error ? err.message : 'Falha ao enviar e-mail')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="border-b border-white/5 px-6 py-4">
        <h1 className="font-display text-xl font-semibold text-white">Gmail</h1>
        <p className="text-sm text-slate-400">Conecte a conta que a Ley vai usar pra ler e enviar e-mails</p>
      </header>

      <div className="flex flex-1 flex-col gap-6 px-6 py-6">
        {status === 'connected' && (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-white/5 bg-midnight-800/40 py-6 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/10 ring-1 ring-emerald-500/30">
              <CheckCircle2 size={32} className="text-emerald-400" />
            </div>
            <p className="text-lg font-medium text-white">Gmail conectado</p>
            {email && <p className="text-sm text-slate-400">{email}</p>}
            <button
              onClick={handleDisconnect}
              className="mt-2 flex items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5"
            >
              <LogOut size={14} />
              Desconectar
            </button>
          </div>
        )}

        {status === 'connecting' && (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-white/5 bg-midnight-800/40 py-6 text-center">
            <Loader2 size={32} className="animate-spin text-electric-400" />
            <p className="text-sm text-slate-400">Conectando ao Gmail...</p>
          </div>
        )}

        {(status === 'disconnected' || status === 'error') && (
          <form
            onSubmit={handleConnect}
            className="flex flex-col gap-3 rounded-2xl border border-white/5 bg-midnight-800/40 p-6"
          >
            <div className="flex items-center gap-2">
              <Mail size={18} className="text-electric-400" />
              <p className="font-medium text-white">Conectar conta do Gmail</p>
            </div>

            {status === 'error' && errorMessage && (
              <div className="flex items-center gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300 ring-1 ring-red-500/30">
                <AlertTriangle size={14} />
                {errorMessage}
              </div>
            )}

            <label className="text-xs text-slate-400">
              E-mail
              <input
                type="email"
                required
                value={formEmail}
                onChange={(e) => setFormEmail(e.target.value)}
                placeholder="voce@gmail.com"
                className="mt-1 w-full rounded-lg border border-white/10 bg-midnight-900 px-3 py-2 text-sm text-white outline-none focus:border-electric-400"
              />
            </label>

            <label className="text-xs text-slate-400">
              Senha de app
              <input
                type="password"
                required
                value={formPassword}
                onChange={(e) => setFormPassword(e.target.value)}
                placeholder="xxxx xxxx xxxx xxxx"
                className="mt-1 w-full rounded-lg border border-white/10 bg-midnight-900 px-3 py-2 text-sm text-white outline-none focus:border-electric-400"
              />
            </label>

            <p className="text-[11px] text-slate-500">
              Precisa ter a verificação em duas etapas ativa na conta Google e gerar uma "senha de app" em
              myaccount.google.com/apppasswords — a senha normal da conta não funciona.
            </p>

            <button
              type="submit"
              disabled={connecting}
              className="mt-1 flex items-center justify-center gap-2 rounded-lg bg-electric-500 px-4 py-2 text-sm font-medium text-white hover:bg-electric-400 disabled:opacity-50"
            >
              {connecting ? <Loader2 size={16} className="animate-spin" /> : <Mail size={16} />}
              Conectar
            </button>
          </form>
        )}

        {status === 'connected' && (
          <>
            <form
              onSubmit={handleSend}
              className="flex flex-col gap-3 rounded-2xl border border-white/5 bg-midnight-800/40 p-6"
            >
              <div className="flex items-center gap-2">
                <Send size={16} className="text-electric-400" />
                <p className="font-medium text-white">Enviar e-mail</p>
              </div>

              <input
                type="email"
                required
                value={sendTo}
                onChange={(e) => setSendTo(e.target.value)}
                placeholder="destinatário@exemplo.com"
                className="w-full rounded-lg border border-white/10 bg-midnight-900 px-3 py-2 text-sm text-white outline-none focus:border-electric-400"
              />
              <input
                type="text"
                required
                value={sendSubject}
                onChange={(e) => setSendSubject(e.target.value)}
                placeholder="Assunto"
                className="w-full rounded-lg border border-white/10 bg-midnight-900 px-3 py-2 text-sm text-white outline-none focus:border-electric-400"
              />
              <textarea
                required
                value={sendText}
                onChange={(e) => setSendText(e.target.value)}
                placeholder="Mensagem"
                rows={4}
                className="w-full resize-none rounded-lg border border-white/10 bg-midnight-900 px-3 py-2 text-sm text-white outline-none focus:border-electric-400"
              />

              {sendFeedback && <p className="text-xs text-slate-400">{sendFeedback}</p>}

              <button
                type="submit"
                disabled={sending}
                className="flex items-center justify-center gap-2 rounded-lg bg-electric-500 px-4 py-2 text-sm font-medium text-white hover:bg-electric-400 disabled:opacity-50"
              >
                {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                Enviar
              </button>
            </form>

            <div className="rounded-2xl border border-white/5 bg-midnight-800/40 p-6">
              <p className="mb-3 font-medium text-white">E-mails recebidos</p>
              {notices.length === 0 && (
                <p className="text-sm text-slate-500">Nenhum e-mail novo por enquanto.</p>
              )}
              <ul className="flex flex-col gap-2">
                {notices.map((n) => (
                  <li key={n.id} className="rounded-lg border border-white/5 px-3 py-2 text-sm">
                    <p className="text-white">{n.subject}</p>
                    <p className="text-xs text-slate-500">{n.from}</p>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
