import { useEffect, useState } from 'react'
import { API_BASE_URL } from '../config/api'
import { Instagram, ExternalLink, LogOut, Heart, MessageCircle, Send, Loader2 } from 'lucide-react'

type InstagramStatus = 'disconnected' | 'connected'

interface InstagramProfile {
  igUserId: string
  username: string
}

interface InstagramMediaItem {
  id: string
  caption: string | null
  mediaType: string
  mediaUrl: string | null
  permalink: string
  timestamp: string
  likeCount: number
  commentsCount: number
}

interface InstagramTabProps {
  onInstagramEvent: (fn: (event: string, data: any) => void) => () => void
}

const API_URL = `${API_BASE_URL}/api/instagram`

export default function InstagramTab({ onInstagramEvent }: InstagramTabProps) {
  const [status, setStatus] = useState<InstagramStatus>('disconnected')
  const [profile, setProfile] = useState<InstagramProfile | null>(null)
  const [media, setMedia] = useState<InstagramMediaItem[]>([])

  const [imageUrl, setImageUrl] = useState('')
  const [caption, setCaption] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)

  useEffect(() => {
    fetch(`${API_URL}/status`)
      .then((res) => res.json())
      .then((data) => {
        if (data?.status) setStatus(data.status)
        if (data?.profile) setProfile(data.profile)
        if (data?.media) setMedia(data.media)
      })
      .catch(() => {})

    const unsubscribe = onInstagramEvent((event, data) => {
      if (event === 'status') {
        setStatus(data?.status ?? 'disconnected')
        setProfile(data?.profile ?? null)
        if (data?.status === 'disconnected') setMedia([])
      } else if (event === 'media') {
        setMedia(data?.media ?? [])
      } else if (event === 'published') {
        setFeedback('Publicado com sucesso!')
      }
    })
    return unsubscribe
  }, [onInstagramEvent])

  const handleConnect = () => {
    window.open(`${API_URL}/login`, '_blank')
  }

  const handleDisconnect = async () => {
    await fetch(`${API_URL}/disconnect`, { method: 'POST' }).catch(() => {})
    setStatus('disconnected')
    setProfile(null)
    setMedia([])
  }

  const handlePublish = async () => {
    if (!imageUrl.trim()) return
    setPublishing(true)
    setFeedback(null)
    try {
      const res = await fetch(`${API_URL}/publish/photo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageUrl: imageUrl.trim(), caption: caption.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'falha ao publicar')
      setFeedback('Publicado com sucesso!')
      setImageUrl('')
      setCaption('')
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Não consegui publicar agora.')
    } finally {
      setPublishing(false)
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="border-b border-white/5 px-6 py-4">
        <h1 className="font-display text-xl font-semibold text-white">Instagram</h1>
        <p className="text-sm text-slate-400">Publique fotos, acompanhe posts e responda comentários</p>
      </header>

      <div className="flex flex-1 flex-col gap-6 px-6 py-6">
        {status === 'disconnected' && (
          <div className="flex flex-col items-center gap-4 rounded-2xl border border-white/5 bg-midnight-800/40 py-10 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-pink-500/10 ring-1 ring-pink-500/30">
              <Instagram size={32} className="text-pink-400" />
            </div>
            <p className="font-medium text-white">Conectar o Instagram</p>
            <p className="max-w-xs text-sm text-slate-400">
              Abre uma aba pra você fazer login com o Facebook e autorizar a conta profissional do Instagram.
            </p>
            <button
              onClick={handleConnect}
              className="mt-2 flex items-center gap-2 rounded-lg bg-pink-500 px-4 py-2 text-sm font-medium text-white hover:bg-pink-400"
            >
              <ExternalLink size={16} />
              Conectar Instagram
            </button>
          </div>
        )}

        {status === 'connected' && (
          <div className="flex flex-col gap-6">
            <div className="flex items-center justify-between rounded-2xl border border-white/5 bg-midnight-800/40 p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-pink-500/10 ring-1 ring-pink-500/30">
                  <Instagram size={18} className="text-pink-400" />
                </div>
                <p className="text-sm text-white">@{profile?.username ?? '...'}</p>
              </div>
              <button
                onClick={handleDisconnect}
                className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-400 hover:bg-white/5"
              >
                <LogOut size={14} />
                Desconectar
              </button>
            </div>

            <div className="rounded-2xl border border-white/5 bg-midnight-800/40 p-5">
              <p className="mb-3 font-medium text-white">Publicar nova foto</p>
              <div className="flex flex-col gap-3">
                <input
                  value={imageUrl}
                  onChange={(e) => setImageUrl(e.target.value)}
                  placeholder="URL pública da imagem (https://...)"
                  className="rounded-lg border border-white/10 bg-midnight-900/60 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-pink-500/50 focus:outline-none"
                />
                <textarea
                  value={caption}
                  onChange={(e) => setCaption(e.target.value)}
                  placeholder="Legenda (opcional)"
                  rows={2}
                  className="rounded-lg border border-white/10 bg-midnight-900/60 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-pink-500/50 focus:outline-none"
                />
                <button
                  onClick={handlePublish}
                  disabled={publishing || !imageUrl.trim()}
                  className="flex items-center justify-center gap-2 rounded-lg bg-pink-500 px-4 py-2 text-sm font-medium text-white hover:bg-pink-400 disabled:opacity-50"
                >
                  {publishing ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                  Publicar
                </button>
                {feedback && <p className="text-xs text-slate-400">{feedback}</p>}
              </div>
            </div>

            <div>
              <p className="mb-3 font-medium text-white">Posts recentes</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {media.map((item) => (
                  <a
                    key={item.id}
                    href={item.permalink}
                    target="_blank"
                    rel="noreferrer"
                    className="group relative overflow-hidden rounded-xl border border-white/5 bg-midnight-800/40"
                  >
                    {item.mediaUrl ? (
                      <img src={item.mediaUrl} alt="" className="aspect-square w-full object-cover" />
                    ) : (
                      <div className="flex aspect-square w-full items-center justify-center bg-midnight-900">
                        <Instagram size={24} className="text-slate-600" />
                      </div>
                    )}
                    <div className="absolute inset-x-0 bottom-0 flex items-center gap-3 bg-black/60 px-2 py-1 text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100">
                      <span className="flex items-center gap-1">
                        <Heart size={12} /> {item.likeCount}
                      </span>
                      <span className="flex items-center gap-1">
                        <MessageCircle size={12} /> {item.commentsCount}
                      </span>
                    </div>
                  </a>
                ))}
                {media.length === 0 && (
                  <p className="col-span-full text-sm text-slate-500">Nenhum post encontrado ainda.</p>
                )}
              </div>
            </div>

            <p className="text-center text-[11px] text-slate-500">
              Também dá pra falar com a Ley: "posta essa foto [url] no instagram com a legenda ...", "meus posts"...
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
