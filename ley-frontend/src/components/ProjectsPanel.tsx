import { useState } from 'react'
import { Plus, FolderKanban, FileCode, X } from 'lucide-react'
import type { Project } from '../types/projects'

interface ProjectsPanelProps {
  projects: Project[]
  activeProjectId: string | null
  onCreate: (name: string) => void
  onOpen: (id: string) => void
}

function formatRelativeDate(ms: number): string {
  const diff = Date.now() - ms
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'agora'
  if (mins < 60) return `há ${mins} min`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `há ${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `há ${days}d`
  return new Date(ms).toLocaleDateString('pt-BR')
}

function NewProjectModal({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string) => void }) {
  const [name, setName] = useState('')

  function handleSubmit() {
    const trimmed = name.trim()
    if (!trimmed) return
    onCreate(trimmed)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm px-4">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-midnight-900/90 p-5 shadow-2xl backdrop-blur-xl">
        <div className="mb-4 flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-100">Novo projeto</p>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 cursor-pointer">
            <X size={16} />
          </button>
        </div>
        <label className="mb-1.5 block text-[11px] font-medium text-slate-400">Nome do projeto</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          placeholder="Ex: Portfólio Ritizin"
          className="w-full rounded-lg border border-white/10 bg-midnight-950/60 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 outline-none focus:border-electric-500/50 focus:ring-1 focus:ring-electric-500/30"
        />
        <div className="mt-4 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 rounded-lg border border-white/10 px-3 py-2 text-xs font-medium text-slate-300 hover:bg-white/5 cursor-pointer"
          >
            Cancelar
          </button>
          <button
            onClick={handleSubmit}
            disabled={!name.trim()}
            className="flex-1 rounded-lg bg-electric-500 px-3 py-2 text-xs font-medium text-white hover:bg-electric-600 disabled:opacity-40 cursor-pointer"
          >
            Criar
          </button>
        </div>
      </div>
    </div>
  )
}

export default function ProjectsPanel({ projects, activeProjectId, onCreate, onOpen }: ProjectsPanelProps) {
  const [modalOpen, setModalOpen] = useState(false)
  const sorted = [...projects].sort((a, b) => b.updatedAt - a.updatedAt)

  return (
    <div className="flex h-full flex-col overflow-hidden bg-midnight-950">
      <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
        <div>
          <h1 className="font-display text-lg font-semibold text-white">Projetos</h1>
          <p className="text-xs text-slate-500">Cada arquivo que a Ley criar ou editar fica salvo aqui.</p>
        </div>
        <button
          onClick={() => setModalOpen(true)}
          className="flex items-center gap-1.5 rounded-lg bg-electric-500 px-3.5 py-2 text-xs font-semibold text-white shadow-glow-sm transition hover:bg-electric-600 cursor-pointer"
        >
          <Plus size={15} />
          Novo
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {sorted.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-slate-500">
            <FolderKanban size={32} className="text-slate-700" />
            <p className="text-sm">Nenhum projeto ainda.</p>
            <p className="max-w-xs text-xs text-slate-600">
              Crie um projeto e peça pra Ley programar algo no chat — os arquivos gerados entram aqui automaticamente.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {sorted.map((p) => (
              <button
                key={p.id}
                onClick={() => onOpen(p.id)}
                className={`flex flex-col gap-2.5 rounded-xl border px-4 py-3.5 text-left transition cursor-pointer ${
                  p.id === activeProjectId
                    ? 'border-electric-500/40 bg-electric-500/5 shadow-glow-sm'
                    : 'border-white/10 bg-midnight-900/60 hover:bg-white/5'
                }`}
              >
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-electric-500/15 text-electric-400">
                    <FileCode size={15} />
                  </div>
                  <p className="truncate text-sm font-semibold text-slate-100">{p.name}</p>
                </div>
                <div className="flex items-center justify-between text-[11px] text-slate-500">
                  <span>{p.files.length} arquivo{p.files.length === 1 ? '' : 's'}</span>
                  <span>{formatRelativeDate(p.updatedAt)}</span>
                </div>
                {p.id === activeProjectId && (
                  <span className="w-fit rounded-full bg-electric-500/15 px-2 py-0.5 text-[10px] font-medium text-electric-400">
                    Ativo
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {modalOpen && <NewProjectModal onClose={() => setModalOpen(false)} onCreate={onCreate} />}
    </div>
  )
}
