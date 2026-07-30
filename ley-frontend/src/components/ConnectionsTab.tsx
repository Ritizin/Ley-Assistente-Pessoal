import { useState } from 'react'
import { Mail, Music2, Instagram, Home, Calendar, ChevronLeft, ChevronRight } from 'lucide-react'
import GmailTab from './GmailTab'
import SpotifyTab from './SpotifyTab'
import InstagramTab from './InstagramTab'
import GoogleHomeTab from './GoogleHomeTab'
import CalendarTab from './CalendarTab'

type ConnectionId = 'gmail' | 'spotify' | 'instagram' | 'google-home' | 'calendar'

interface ConnectionsTabProps {
  onGmailEvent: (fn: (event: string, data: any) => void) => () => void
  onSpotifyEvent: (fn: (event: string, data: any) => void) => () => void
  onInstagramEvent: (fn: (event: string, data: any) => void) => () => void
  onGoogleHomeEvent: (fn: (event: string, data: any) => void) => () => void
}

const CONNECTIONS: { id: ConnectionId; label: string; description: string; icon: typeof Mail; color: string }[] = [
  { id: 'gmail', label: 'Gmail', description: 'Receber avisos e mandar e-mail', icon: Mail, color: 'text-red-400 bg-red-500/10 ring-red-500/20' },
  { id: 'spotify', label: 'Spotify', description: 'Controlar sua música', icon: Music2, color: 'text-emerald-400 bg-emerald-500/10 ring-emerald-500/20' },
  { id: 'google-home', label: 'Google Home', description: 'Controlar seus dispositivos', icon: Home, color: 'text-sky-400 bg-sky-500/10 ring-sky-500/20' },
  { id: 'instagram', label: 'Instagram', description: 'Notificações e mensagens', icon: Instagram, color: 'text-pink-400 bg-pink-500/10 ring-pink-500/20' },
  { id: 'calendar', label: 'Google Agenda', description: 'Ver seus próximos compromissos', icon: Calendar, color: 'text-electric-400 bg-electric-500/10 ring-electric-500/20' },
]

export default function ConnectionsTab({
  onGmailEvent,
  onSpotifyEvent,
  onInstagramEvent,
  onGoogleHomeEvent,
}: ConnectionsTabProps) {
  const [selected, setSelected] = useState<ConnectionId | null>(null)

  if (selected) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
          <button
            onClick={() => setSelected(null)}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-slate-400 hover:bg-white/5 hover:text-white"
          >
            <ChevronLeft size={16} /> Conexões
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {selected === 'gmail' && <GmailTab onGmailEvent={onGmailEvent} />}
          {selected === 'spotify' && <SpotifyTab onSpotifyEvent={onSpotifyEvent} />}
          {selected === 'instagram' && <InstagramTab onInstagramEvent={onInstagramEvent} />}
          {selected === 'google-home' && <GoogleHomeTab onGoogleHomeEvent={onGoogleHomeEvent} />}
          {selected === 'calendar' && <CalendarTab />}
        </div>
      </div>
    )
  }

  return (
    <div className="p-6">
      <h2 className="font-display text-lg font-semibold text-white">Conexões</h2>
      <p className="mb-6 mt-1 text-sm text-slate-400">Apps conectados à Ley (o WhatsApp tem aba própria).</p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {CONNECTIONS.map(({ id, label, description, icon: Icon, color }) => (
          <button
            key={id}
            onClick={() => setSelected(id)}
            className="group flex items-center gap-3 rounded-xl border border-white/5 bg-midnight-800/60 px-4 py-3.5 text-left transition hover:border-electric-500/20 hover:bg-midnight-800"
          >
            <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ring-1 ${color}`}>
              <Icon size={19} />
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium text-slate-100">{label}</p>
              <p className="text-xs text-slate-500">{description}</p>
            </div>
            <ChevronRight size={16} className="text-slate-600 transition group-hover:text-slate-400" />
          </button>
        ))}
      </div>
    </div>
  )
}
