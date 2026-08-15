import { MessageSquare, ListChecks, Circle, MessageCircle, Bell, Plug, LogOut, FolderKanban, Laptop, Cloud } from 'lucide-react'
import LeyAvatar from './LeyAvatar'
import { getBackendMode, setBackendMode } from '../config/api'

export type TabId = 'chat' | 'tasks' | 'whatsapp' | 'connections' | 'notifications' | 'projects'

interface SidebarProps {
  active: TabId
  onChange: (tab: TabId) => void
  wsConnected: boolean
  // quantidade de avisos não lidos (mensagens novas no WhatsApp) — mostrado
  // como uma bolinha no item "Notificações" do menu
  notificationCount?: number
  // nome/e-mail de quem tá logado + ação de sair — antes ficava um selo
  // fixo no canto superior direito por cima do conteúdo; agora mora aqui
  // embaixo, junto do resto do rodapé do menu.
  userLabel?: string | null
  onLogout?: () => void
}

const NAV_ITEMS: { id: TabId; label: string; icon: typeof MessageSquare }[] = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'projects', label: 'Projetos', icon: FolderKanban },
  { id: 'notifications', label: 'Notificações', icon: Bell },
  { id: 'whatsapp', label: 'WhatsApp', icon: MessageCircle },
  { id: 'connections', label: 'Conexões', icon: Plug },
  { id: 'tasks', label: 'Tarefas', icon: ListChecks },
]

export default function Sidebar({
  active,
  onChange,
  wsConnected,
  notificationCount = 0,
  userLabel,
  onLogout,
}: SidebarProps) {
  return (
    <>
      {/* ===== Desktop: menu lateral completo (>= md) ===== */}
      <aside className="hidden h-full w-64 flex-col justify-between border-r border-electric-500/10 bg-midnight-900/80 px-4 py-6 backdrop-blur-xl md:flex">
        <div>
          <div className="mb-8 flex items-center gap-2 px-2">
            <LeyAvatar size={36} />
            <div>
              <p className="font-display text-lg font-semibold leading-none text-white">Ley</p>
              <p className="text-[11px] leading-none text-slate-400 mt-1">Assistente Pessoal</p>
            </div>
          </div>

          <nav className="flex flex-col gap-1">
            {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
              const isActive = active === id
              const showBadge = id === 'notifications' && notificationCount > 0
              return (
                <button
                  key={id}
                  onClick={() => onChange(id)}
                  className={`group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-150 ${
                    isActive
                      ? 'bg-electric-500/10 text-electric-400 shadow-glow-sm ring-1 ring-electric-500/30'
                      : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
                  }`}
                >
                  <Icon
                    size={18}
                    className={isActive ? 'text-electric-400' : 'text-slate-500 group-hover:text-slate-300'}
                  />
                  <span className="flex-1 text-left">{label}</span>
                  {showBadge && (
                    <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-rose-500 px-1.5 text-[11px] font-semibold text-white">
                      {notificationCount > 99 ? '99+' : notificationCount}
                    </span>
                  )}
                </button>
              )
            })}
          </nav>
        </div>

        <div className="flex flex-col gap-2">
          <div
            className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-xs ${
              wsConnected ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-rose-500/20 bg-rose-500/5'
            }`}
          >
            <Circle
              size={8}
              fill={wsConnected ? '#10b981' : '#f43f5e'}
              className={wsConnected ? 'text-emerald-500 animate-pulseDot' : 'text-rose-500 animate-pulseDot'}
            />
            <span className={`flex-1 ${wsConnected ? 'text-emerald-400' : 'text-rose-400'}`}>
              {wsConnected ? 'Servidor Online' : 'Servidor Off'}
            </span>
            <button
              onClick={() => setBackendMode(getBackendMode() === 'local' ? 'production' : 'local')}
              title={
                getBackendMode() === 'local'
                  ? 'Falando com localhost:3000 — clica pra voltar pro backend atual'
                  : 'Falando com o backend atual — clica pra usar localhost:3000'
              }
              className="flex items-center gap-1 rounded-md border border-white/5 px-1.5 py-1 text-[10px] text-slate-500 transition hover:bg-white/5 hover:text-slate-300"
            >
              {getBackendMode() === 'local' ? <Laptop size={11} /> : <Cloud size={11} />}
              {getBackendMode() === 'local' ? 'Local' : 'Atual'}
            </button>
          </div>

          {userLabel && (
            <div className="flex items-center gap-2 rounded-lg border border-white/5 bg-midnight-800/60 px-3 py-2.5 text-xs">
              <span className="flex-1 truncate text-slate-400">{userLabel}</span>
              <button
                onClick={onLogout}
                title="Sair"
                className="flex items-center gap-1 rounded-md px-1.5 py-1 text-slate-500 transition hover:bg-white/5 hover:text-rose-400"
              >
                <LogOut size={13} />
                Sair
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* ===== Mobile: barra superior compacta (< md) ===== */}
      <header className="flex shrink-0 items-center justify-between border-b border-electric-500/10 bg-midnight-900/80 px-4 py-2.5 backdrop-blur-xl md:hidden">
        <div className="flex items-center gap-2">
          <LeyAvatar size={26} />
          <p className="font-display text-sm font-semibold leading-none text-white">Ley</p>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
          <Circle
            size={7}
            fill={wsConnected ? '#2f8fff' : '#475569'}
            className={wsConnected ? 'text-electric-500 animate-pulseDot' : 'text-slate-600'}
          />
          {wsConnected ? 'Online' : 'Conectando...'}
        </div>
      </header>

      {/* ===== Mobile: navegação inferior fixa (< md) ===== */}
      <nav
        className="fixed inset-x-0 bottom-0 z-30 flex items-stretch justify-around border-t border-electric-500/10 bg-midnight-900/95 px-1 backdrop-blur-xl md:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
          const isActive = active === id
          const showBadge = id === 'notifications' && notificationCount > 0
          return (
            <button
              key={id}
              onClick={() => onChange(id)}
              className={`relative flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium transition-colors ${
                isActive ? 'text-electric-400' : 'text-slate-500'
              }`}
            >
              <span className="relative">
                <Icon size={20} className={isActive ? 'text-electric-400' : 'text-slate-500'} />
                {showBadge && (
                  <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-semibold text-white">
                    {notificationCount > 99 ? '99+' : notificationCount}
                  </span>
                )}
              </span>
              {label}
            </button>
          )
        })}
      </nav>
    </>
  )
}
