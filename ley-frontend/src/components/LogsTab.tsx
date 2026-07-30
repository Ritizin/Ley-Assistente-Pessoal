import { useEffect, useRef } from 'react'
import { Terminal, Trash2, Circle } from 'lucide-react'
import type { LogEntry } from '../hooks/useLeyWebSocket'

interface LogsTabProps {
  logs: LogEntry[]
  connected: boolean
  onClear: () => void
}

const LEVEL_COLOR: Record<string, string> = {
  info: 'text-electric-400',
  warn: 'text-amber-400',
  error: 'text-red-400',
  debug: 'text-slate-500',
  chat: 'text-cobalt-400',
}

export default function LogsTab({ logs, connected, onClear }: LogsTabProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-white/5 px-6 py-4">
        <div>
          <h1 className="font-display text-xl font-semibold text-white">Logs do Servidor</h1>
          <p className="text-sm text-slate-400">Stream em tempo real via WebSocket</p>
        </div>
        <button
          onClick={onClear}
          className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-400 transition hover:border-red-500/30 hover:text-red-300"
        >
          <Trash2 size={13} />
          Limpar
        </button>
      </header>

      <div className="flex-1 overflow-hidden px-6 py-6">
        <div className="mx-auto flex h-full max-w-4xl flex-col overflow-hidden rounded-xl border border-electric-500/15 bg-black/40 shadow-glow-sm">
          <div className="flex items-center gap-2 border-b border-white/5 bg-midnight-900/80 px-4 py-2.5">
            <span className="h-2.5 w-2.5 rounded-full bg-red-500/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-500/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-green-500/70" />
            <span className="ml-2 flex items-center gap-1.5 text-xs text-slate-500">
              <Terminal size={12} />
              ley@server:~
            </span>
            <span className="ml-auto flex items-center gap-1.5 text-[11px] text-slate-500">
              <Circle
                size={7}
                fill={connected ? '#2f8fff' : '#475569'}
                className={connected ? 'text-electric-500' : 'text-slate-600'}
              />
              {connected ? 'live' : 'offline'}
            </span>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-3 font-mono text-[13px] leading-relaxed">
            {logs.length === 0 ? (
              <p className="text-slate-600">
                Aguardando eventos do servidor
                <span className="animate-blink">_</span>
              </p>
            ) : (
              logs.map((log) => (
                <div key={log.id} className="flex gap-2">
                  <span className="shrink-0 text-slate-600">{log.timestamp}</span>
                  <span className={`shrink-0 uppercase ${LEVEL_COLOR[log.level] ?? 'text-slate-400'}`}>
                    [{log.level}]
                  </span>
                  <span className="text-slate-300 break-all">{log.message}</span>
                </div>
              ))
            )}
            <div ref={bottomRef} />
          </div>
        </div>
      </div>
    </div>
  )
}
