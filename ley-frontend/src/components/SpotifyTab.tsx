import { useEffect, useState } from 'react'
import { API_BASE_URL } from '../config/api'
import { Music2, ExternalLink, Play, Pause, SkipBack, SkipForward, LogOut } from 'lucide-react'

type SpotifyStatus = 'disconnected' | 'connected'

interface SpotifyTrack {
  name: string
  artists: string
  albumArt: string | null
  isPlaying: boolean
  progressMs: number
  durationMs: number
  uri: string
}

interface SpotifyTabProps {
  onSpotifyEvent: (fn: (event: string, data: any) => void) => () => void
}

const API_URL = `${API_BASE_URL}/api/spotify`

function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}:${sec.toString().padStart(2, '0')}`
}

export default function SpotifyTab({ onSpotifyEvent }: SpotifyTabProps) {
  const [status, setStatus] = useState<SpotifyStatus>('disconnected')
  const [track, setTrack] = useState<SpotifyTrack | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch(`${API_URL}/status`)
      .then((res) => res.json())
      .then((data) => {
        if (data?.status) setStatus(data.status)
        if (data?.track) setTrack(data.track)
      })
      .catch(() => {})

    const unsubscribe = onSpotifyEvent((event, data) => {
      if (event === 'status') {
        setStatus(data?.status ?? 'disconnected')
        if (data?.status === 'disconnected') setTrack(null)
      } else if (event === 'track') {
        setTrack(data?.track ?? null)
      }
    })
    return unsubscribe
  }, [onSpotifyEvent])

  const handleConnect = () => {
    window.open(`${API_URL}/login`, '_blank')
  }

  const handleDisconnect = async () => {
    await fetch(`${API_URL}/disconnect`, { method: 'POST' }).catch(() => {})
    setStatus('disconnected')
    setTrack(null)
  }

  const control = async (action: 'play' | 'pause' | 'next' | 'previous') => {
    setBusy(true)
    try {
      await fetch(`${API_URL}/${action}`, { method: 'POST' })
    } catch {
      // silencioso — se falhar (ex: sem dispositivo ativo), o próximo poll já corrige o estado
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="border-b border-white/5 px-6 py-4">
        <h1 className="font-display text-xl font-semibold text-white">Spotify</h1>
        <p className="text-sm text-slate-400">Veja o que tá tocando e controle por aqui ou pela voz</p>
      </header>

      <div className="flex flex-1 flex-col gap-6 px-6 py-6">
        {status === 'disconnected' && (
          <div className="flex flex-col items-center gap-4 rounded-2xl border border-white/5 bg-midnight-800/40 py-10 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/10 ring-1 ring-emerald-500/30">
              <Music2 size={32} className="text-emerald-400" />
            </div>
            <p className="font-medium text-white">Conectar o Spotify</p>
            <p className="max-w-xs text-sm text-slate-400">
              Abre uma aba pra você fazer login na sua conta Spotify e autorizar a Ley.
            </p>
            <button
              onClick={handleConnect}
              className="mt-2 flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-400"
            >
              <ExternalLink size={16} />
              Conectar Spotify
            </button>
          </div>
        )}

        {status === 'connected' && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between rounded-2xl border border-white/5 bg-midnight-800/40 p-6">
              {track ? (
                <div className="flex w-full items-center gap-4">
                  {track.albumArt ? (
                    <img src={track.albumArt} alt="" className="h-20 w-20 rounded-xl object-cover shadow-glow" />
                  ) : (
                    <div className="flex h-20 w-20 items-center justify-center rounded-xl bg-midnight-900">
                      <Music2 size={28} className="text-slate-600" />
                    </div>
                  )}
                  <div className="flex-1">
                    <p className="font-medium text-white">{track.name}</p>
                    <p className="text-sm text-slate-400">{track.artists}</p>
                    <div className="mt-3 h-1 w-full rounded-full bg-white/10">
                      <div
                        className="h-1 rounded-full bg-emerald-400"
                        style={{ width: `${Math.min(100, (track.progressMs / track.durationMs) * 100)}%` }}
                      />
                    </div>
                    <div className="mt-1 flex justify-between text-[11px] text-slate-500">
                      <span>{formatMs(track.progressMs)}</span>
                      <span>{formatMs(track.durationMs)}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-slate-500">Nada tocando agora. Dá o play em algum dispositivo do Spotify.</p>
              )}
            </div>

            <div className="flex items-center justify-center gap-4">
              <button
                onClick={() => control('previous')}
                disabled={busy}
                className="rounded-full border border-white/10 p-3 text-slate-300 hover:bg-white/5 disabled:opacity-50"
              >
                <SkipBack size={18} />
              </button>
              <button
                onClick={() => control(track?.isPlaying ? 'pause' : 'play')}
                disabled={busy}
                className="rounded-full bg-emerald-500 p-4 text-white hover:bg-emerald-400 disabled:opacity-50"
              >
                {track?.isPlaying ? <Pause size={20} /> : <Play size={20} />}
              </button>
              <button
                onClick={() => control('next')}
                disabled={busy}
                className="rounded-full border border-white/10 p-3 text-slate-300 hover:bg-white/5 disabled:opacity-50"
              >
                <SkipForward size={18} />
              </button>
            </div>

            <p className="text-center text-[11px] text-slate-500">
              Também dá pra falar com a Ley: "toca [música]", "pausa", "próxima música"...
            </p>

            <button
              onClick={handleDisconnect}
              className="mx-auto flex items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-400 hover:bg-white/5"
            >
              <LogOut size={14} />
              Desconectar
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
