import { useState } from 'react'
import { Plus, FolderKanban, FileCode, X, Pencil, Trash2 } from 'lucide-react'
import type { Project } from '../types/projects'

interface ProjectsPanelProps {
  projects: Project[]
  activeProjectId: string | null
  onCreate: (name: string) => void
  onOpen: (id: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
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

// Modal de nome, reaproveitado tanto pra criar um projeto novo quanto pra
// renomear um existente — só muda o título/label/texto do botão e se já
// chega com um `initialName` preenchido.
function ProjectNameModal({
  title,
  submitLabel,
  initialName = '',
  onClose,
  onSubmit,
}: {
  title: string
  submitLabel: string
  initialName?: string
  onClose: () => void
  onSubmit: (name: string) => void
}) {
  const [name, setName] = useState(initialName)

  function handleSubmit() {
    const trimmed = name.trim()
    if (!trimmed) return
    onSubmit(trimmed)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm px-4">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-midnight-900/90 p-5 shadow-2xl backdrop-blur-xl">
        <div className="mb-4 flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-100">{title}</p>
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
          onFocus={(e) => e.target.select()}
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
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function DeleteProjectModal({
  projectName,
  onClose,
  onConfirm,
}: {
  projectName: string
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm px-4">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-midnight-900/90 p-5 shadow-2xl backdrop-blur-xl">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-100">Excluir projeto</p>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 cursor-pointer">
            <X size={16} />
          </button>
        </div>
        <p className="text-xs leading-5 text-slate-400">
          Tem certeza que quer excluir <span className="font-medium text-slate-200">{projectName}</span>? Os
          arquivos e o histórico de chat desse projeto somem do painel e essa ação não pode ser desfeita.
        </p>
        <div className="mt-4 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 rounded-lg border border-white/10 px-3 py-2 text-xs font-medium text-slate-300 hover:bg-white/5 cursor-pointer"
          >
            Cancelar
          </button>
          <button
            onClick={() => {
              onConfirm()
              onClose()
            }}
            className="flex-1 rounded-lg bg-red-500/90 px-3 py-2 text-xs font-medium text-white hover:bg-red-500 cursor-pointer"
          >
            Excluir
          </button>
        </div>
      </div>
    </div>
  )
}

export default function ProjectsPanel({ projects, activeProjectId, onCreate, onOpen, onRename, onDelete }: ProjectsPanelProps) {
  const [modalOpen, setModalOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const sorted = [...projects].sort((a, b) => b.updatedAt - a.updatedAt)
  const renamingProject = sorted.find((p) => p.id === renamingId) ?? null
  const deletingProject = sorted.find((p) => p.id === deletingId) ?? null

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
              <div
                key={p.id}
                role="button"
                tabIndex={0}
                onClick={() => onOpen(p.id)}
                onKeyDown={(e) => e.key === 'Enter' && onOpen(p.id)}
                className={`group relative flex flex-col gap-2.5 rounded-xl border px-4 py-3.5 text-left transition cursor-pointer ${
                  p.id === activeProjectId
                    ? 'border-electric-500/40 bg-electric-500/5 shadow-glow-sm'
                    : 'border-white/10 bg-midnight-900/60 hover:bg-white/5'
                }`}
              >
                <div className="absolute right-2.5 top-2.5 flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setRenamingId(p.id)
                    }}
                    title="Renomear projeto"
                    className="rounded-md p-1.5 text-slate-500 hover:bg-white/10 hover:text-slate-200 cursor-pointer"
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setDeletingId(p.id)
                    }}
                    title="Excluir projeto"
                    className="rounded-md p-1.5 text-slate-500 hover:bg-red-500/15 hover:text-red-400 cursor-pointer"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>

                <div className="flex items-center gap-2 pr-12">
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
              </div>
            ))}
          </div>
        )}
      </div>

      {modalOpen && (
        <ProjectNameModal
          title="Novo projeto"
          submitLabel="Criar"
          onClose={() => setModalOpen(false)}
          onSubmit={onCreate}
        />
      )}

      {renamingProject && (
        <ProjectNameModal
          title="Renomear projeto"
          submitLabel="Salvar"
          initialName={renamingProject.name}
          onClose={() => setRenamingId(null)}
          onSubmit={(name) => onRename(renamingProject.id, name)}
        />
      )}

      {deletingProject && (
        <DeleteProjectModal
          projectName={deletingProject.name}
          onClose={() => setDeletingId(null)}
          onConfirm={() => onDelete(deletingProject.id)}
        />
      )}
    </div>
  )
}
