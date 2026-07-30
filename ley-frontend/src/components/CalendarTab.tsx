import { useEffect, useState } from 'react'
import { API_BASE_URL } from '../config/api'
import { Calendar, Loader2, AlertTriangle, MapPin, RefreshCw } from 'lucide-react'

const API_URL = `${API_BASE_URL}/api/calendar`

interface CalendarEvent {
  id: string
  summary: string
  start: string | null
  end: string | null
  allDay: boolean
  location: string | null
}

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('ley_auth_token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function formatWhen(ev: CalendarEvent): string {
  if (!ev.start) return ''
  if (ev.allDay) {
    return new Date(ev.start).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' })
  }
  const start = new Date(ev.start)
  const datePart = start.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' })
  const timePart = start.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  return `${datePart} · ${timePart}`
}

export default function CalendarTab() {
  const [connected, setConnected] = useState<boolean | null>(null)
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    setLoading(true)
    setError(null)

    fetch(`${API_URL}/status`, { headers: authHeaders() })
      .then((r) => r.json())
      .then((data) => {
        setConnected(!!data.connected)
        if (!data.connected) {
          setLoading(false)
          return null
        }
        return fetch(`${API_URL}/events`, { headers: authHeaders() }).then((r) => r.json())
      })
      .then((data) => {
        if (data?.events) setEvents(data.events)
        else if (data?.error) setError(data.error)
      })
      .catch(() => setError('Não consegui falar com o servidor.'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex h-full flex-col gap-5 p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-electric-500/10 text-electric-400 ring-1 ring-electric-500/20">
            <Calendar size={20} />
          </div>
          <div>
            <h2 className="font-display text-lg font-semibold text-white">Google Agenda</h2>
            <p className="text-xs text-slate-400">Próximos compromissos da sua agenda principal</p>
          </div>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-1.5 rounded-lg border border-white/5 bg-midnight-800/60 px-3 py-1.5 text-xs text-slate-300 hover:text-white"
        >
          <RefreshCw size={13} /> Atualizar
        </button>
      </div>

      {loading && (
        <div className="flex flex-1 items-center justify-center text-slate-500">
          <Loader2 size={20} className="animate-spin" />
        </div>
      )}

      {!loading && connected === false && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-slate-400">
          <AlertTriangle size={22} className="text-amber-400" />
          <p className="max-w-sm text-sm">
            Sua conta Google ainda não autorizou o acesso à agenda. Saia e entre de novo com o Google — a nova tela de
            login já pede essa permissão.
          </p>
        </div>
      )}

      {!loading && connected && error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div>
      )}

      {!loading && connected && !error && (
        <div className="flex flex-col gap-2 overflow-y-auto">
          {events.length === 0 && (
            <p className="py-8 text-center text-sm text-slate-500">Nenhum compromisso próximo. Tá livre!</p>
          )}
          {events.map((ev) => (
            <div
              key={ev.id}
              className="flex items-start gap-3 rounded-xl border border-white/5 bg-midnight-800/60 px-4 py-3"
            >
              <div className="mt-0.5 w-24 shrink-0 text-xs font-medium text-electric-400">{formatWhen(ev)}</div>
              <div className="flex-1">
                <p className="text-sm text-slate-100">{ev.summary}</p>
                {ev.location && (
                  <p className="mt-1 flex items-center gap-1 text-xs text-slate-500">
                    <MapPin size={11} /> {ev.location}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
