import { useEffect, useRef, useState, useCallback } from 'react'
import { WS_BASE_URL } from '../config/api'

export interface LogEntry {
  id: string
  timestamp: string
  level: 'info' | 'warn' | 'error' | 'debug' | 'chat'
  message: string
}

const WS_URL = WS_BASE_URL

/**
 * Mantém uma única conexão WebSocket com o backend da Ley.
 * Distribui eventos de log e mensagens de chat para quem estiver escutando.
 */
export function useLeyWebSocket() {
  const [connected, setConnected] = useState(false)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const chatListeners = useRef<Set<(data: any) => void>>(new Set())
  const whatsappListeners = useRef<Set<(event: string, data: any) => void>>(new Set())
  const gmailListeners = useRef<Set<(event: string, data: any) => void>>(new Set())
  const spotifyListeners = useRef<Set<(event: string, data: any) => void>>(new Set())
  const instagramListeners = useRef<Set<(event: string, data: any) => void>>(new Set())
  const googleHomeListeners = useRef<Set<(event: string, data: any) => void>>(new Set())

  const pushLog = useCallback((entry: Omit<LogEntry, 'id' | 'timestamp'>) => {
    setLogs((prev) => [
      ...prev.slice(-499),
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toLocaleTimeString('pt-BR'),
        ...entry,
      },
    ])
  }, [])

  useEffect(() => {
    let cancelled = false

    const connect = () => {
      if (cancelled) return
      const ws = new WebSocket(WS_URL)
      wsRef.current = ws

      ws.onopen = () => {
        setConnected(true)
        pushLog({ level: 'info', message: 'Conexão WebSocket estabelecida com o servidor.' })
      }

      ws.onclose = () => {
        setConnected(false)
        pushLog({ level: 'warn', message: 'Conexão perdida. Tentando reconectar em 3s...' })
        reconnectTimer.current = setTimeout(connect, 3000)
      }

      ws.onerror = () => {
        pushLog({ level: 'error', message: 'Erro na conexão WebSocket.' })
      }

      ws.onmessage = (event) => {
        try {
          const envelope = JSON.parse(event.data)

          // O backend (wsHub) envia no formato: { channel, event, payload, ts }
          const { channel, event: evt, payload: eventData } = envelope

          if (channel === 'chat') {
            // Notifica os componentes de chat
            chatListeners.current.forEach((fn) => fn(eventData))

            const content = typeof eventData === 'object' ? eventData?.content : eventData
            if (content) {
              pushLog({ level: 'chat', message: `[chat] ${eventData?.role || 'msg'}: ${content}` })
            }
          } else if (channel === 'whatsapp') {
            whatsappListeners.current.forEach((fn) => fn(evt, eventData))
          } else if (channel === 'gmail') {
            gmailListeners.current.forEach((fn) => fn(evt, eventData))
          } else if (channel === 'spotify') {
            spotifyListeners.current.forEach((fn) => fn(evt, eventData))
          } else if (channel === 'instagram') {
            instagramListeners.current.forEach((fn) => fn(evt, eventData))
          } else if (channel === 'google-home') {
            googleHomeListeners.current.forEach((fn) => fn(evt, eventData))
          } else if (channel === 'logs') {
            const rawMessage = typeof eventData === 'string' ? eventData : JSON.stringify(eventData)

            // Detecta se a linha de log do Pino/Fastify contém erro/warn
            let level: LogEntry['level'] = 'info'
            if (rawMessage.toLowerCase().includes('error')) level = 'error'
            else if (rawMessage.toLowerCase().includes('warn')) level = 'warn'

            pushLog({ level, message: rawMessage.trim() })
          } else {
            pushLog({ level: 'debug', message: event.data })
          }
        } catch {
          pushLog({ level: 'debug', message: event.data })
        }
      }
    }

    connect()

    return () => {
      cancelled = true
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      wsRef.current?.close()
    }
  }, [pushLog])

  const onChatEvent = useCallback((fn: (data: any) => void) => {
    chatListeners.current.add(fn)
    return () => { chatListeners.current.delete(fn) }
  }, [])

  const onWhatsAppEvent = useCallback((fn: (event: string, data: any) => void) => {
    whatsappListeners.current.add(fn)
    return () => { whatsappListeners.current.delete(fn) }
  }, [])

  const onGmailEvent = useCallback((fn: (event: string, data: any) => void) => {
    gmailListeners.current.add(fn)
    return () => { gmailListeners.current.delete(fn) }
  }, [])

  const onSpotifyEvent = useCallback((fn: (event: string, data: any) => void) => {
    spotifyListeners.current.add(fn)
    return () => { spotifyListeners.current.delete(fn) }
  }, [])

  const onInstagramEvent = useCallback((fn: (event: string, data: any) => void) => {
    instagramListeners.current.add(fn)
    return () => { instagramListeners.current.delete(fn) }
  }, [])

  const onGoogleHomeEvent = useCallback((fn: (event: string, data: any) => void) => {
    googleHomeListeners.current.add(fn)
    return () => { googleHomeListeners.current.delete(fn) }
  }, [])

  const clearLogs = useCallback(() => setLogs([]), [])

  return {
    connected,
    logs,
    clearLogs,
    onChatEvent,
    onWhatsAppEvent,
    onGmailEvent,
    onSpotifyEvent,
    onInstagramEvent,
    onGoogleHomeEvent,
  }
}
