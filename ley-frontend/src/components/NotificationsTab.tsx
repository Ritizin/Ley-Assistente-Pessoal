import { useCallback, useEffect, useState } from 'react'
import { API_BASE_URL } from '../config/api'
import { Bell, MessageCircle, Users } from 'lucide-react'

const API_BASE = API_BASE_URL

interface WaMessage {
  id: string
  jid: string
  from_me: number
  sender_name: string | null
  type: string
  text: string | null
  transcript: string | null
  seen: number
  created_at: number
}

// um aviso por contato/grupo (não por mensagem) — se chegarem 3 mensagens
// seguidas de alguém, aparece uma linha só, com a contagem
export interface NotificationGroup {
  jid: string
  isGroup: boolean
  // nome do contato/grupo se a Ley já conhece, senão o próprio número
  displayName: string
  count: number
  lastPreview: string | null
  lastCreatedAt: number
}

interface NotificationsTabProps {
  groups: NotificationGroup[]
  onOpen: (jid: string, name: string | null) => void
}

export default function NotificationsTab({ groups, onOpen }: NotificationsTabProps) {
  const sorted = [...groups].sort((a, b) => b.lastCreatedAt - a.lastCreatedAt)

  return (
    <div className="flex h-full flex-col overflow-hidden bg-midnight-950">
      <div className="flex items-center gap-2 border-b border-electric-500/10 px-6 py-4">
        <Bell size={18} className="text-electric-400" />
        <h1 className="font-display text-lg font-semibold text-white">Notificações</h1>
        {sorted.length > 0 && (
          <span className="ml-1 rounded-full bg-electric-500/10 px-2 py-0.5 text-xs text-electric-400">
            {sorted.length}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {sorted.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-500">
            <Bell size={32} className="opacity-30" />
            <p className="text-sm">Nenhuma mensagem nova.</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {sorted.map((n) => (
              <li key={n.jid}>
                <button
                  onClick={() => onOpen(n.jid, n.isGroup ? null : n.displayName)}
                  className="flex w-full items-center gap-3 rounded-xl border border-white/5 bg-midnight-900/60 px-4 py-3 text-left transition hover:border-electric-500/30 hover:bg-midnight-800/80"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-electric-500/10 text-electric-400">
                    {n.isGroup ? <Users size={16} /> : <MessageCircle size={16} />}
                  </div>

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-100">
                      {n.isGroup ? `Grupo${n.displayName ? ` ${n.displayName}` : ''}` : n.displayName}
                      <span className="font-normal text-slate-400">: Nova Mensagem</span>
                    </p>
                    {n.lastPreview && (
                      <p className="truncate text-xs text-slate-500">{n.lastPreview}</p>
                    )}
                  </div>

                  {n.count > 1 && (
                    <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-rose-500 px-1.5 text-[11px] font-semibold text-white">
                      {n.count > 99 ? '99+' : n.count}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// Monta os grupos de notificação a partir da lista de mensagens não lidas
// (GET /api/whatsapp/messages?unread=true). Usado tanto na carga inicial
// quanto sempre que uma mensagem nova chega pelo WebSocket.
export function groupUnreadMessages(
  messages: WaMessage[],
  contactNames: Map<string, string | null>
): NotificationGroup[] {
  const byJid = new Map<string, NotificationGroup>()

  for (const m of messages) {
    if (m.from_me || m.seen) continue

    const isGroup = m.jid.endsWith('@g.us')
    const existing = byJid.get(m.jid)
    const preview = (m.type === 'audio' ? m.transcript : m.text) ?? null

    if (existing) {
      existing.count += 1
      if (m.created_at >= existing.lastCreatedAt) {
        existing.lastPreview = preview
        existing.lastCreatedAt = m.created_at
      }
      continue
    }

    const knownName = contactNames.get(m.jid) ?? null
    const displayName = knownName ?? (isGroup ? '' : `+${m.jid.split('@')[0]}`)

    byJid.set(m.jid, {
      jid: m.jid,
      isGroup,
      displayName,
      count: 1,
      lastPreview: preview,
      lastCreatedAt: m.created_at,
    })
  }

  return Array.from(byJid.values())
}

export async function fetchUnreadNotifications(): Promise<WaMessage[]> {
  const res = await fetch(`${API_BASE}/api/whatsapp/messages?unread=true`)
  if (!res.ok) throw new Error('falha ao buscar mensagens não lidas')
  return res.json()
}

export async function fetchContactNames(): Promise<Map<string, string | null>> {
  const res = await fetch(`${API_BASE}/api/whatsapp/contacts`)
  if (!res.ok) return new Map()
  const contacts: { jid: string; name: string | null }[] = await res.json()
  return new Map(contacts.map((c) => [c.jid, c.name]))
}

export async function markJidSeen(jid: string): Promise<void> {
  await fetch(`${API_BASE}/api/whatsapp/messages/seen-by-jid`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jid }),
  }).catch(() => {
    // best-effort — se falhar, a próxima carga da lista corrige o estado
  })
}
