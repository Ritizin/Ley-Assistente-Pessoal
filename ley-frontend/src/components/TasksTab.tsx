import { useEffect, useState } from 'react'
import { API_BASE_URL } from '../config/api'
import { Plus, Check, ListChecks, Loader2, CircleAlert } from 'lucide-react'

interface Task {
  id: string
  title: string
  status: 'pending' | 'completed' | string
  created_at: string
}

const API_URL = `${API_BASE_URL}/api/tasks`

export default function TasksTab() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [newTitle, setNewTitle] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function loadTasks() {
    try {
      setLoading(true)
      const res = await fetch(API_URL)
      if (!res.ok) throw new Error()
      const data = await res.json()
      setTasks(data.tasks ?? [])
      setError(null)
    } catch {
      setError('Não foi possível carregar as tarefas. Verifique o backend na porta 3000.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadTasks()
  }, [])

  async function addTask() {
    const title = newTitle.trim()
    if (!title || submitting) return
    setSubmitting(true)
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      })
      if (!res.ok) throw new Error()
      setNewTitle('')
      await loadTasks()
    } catch {
      setError('Não foi possível criar a tarefa.')
    } finally {
      setSubmitting(false)
    }
  }

  async function completeTask(id: string) {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, status: 'completed' } : t)))
    try {
      const res = await fetch(`${API_URL}/${id}/complete`, { method: 'PATCH' })
      if (!res.ok) throw new Error()
    } catch {
      setError('Não foi possível concluir a tarefa.')
      loadTasks()
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') addTask()
  }

  const pending = tasks.filter((t) => t.status !== 'completed')
  const completed = tasks.filter((t) => t.status === 'completed')

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-white/5 px-6 py-4">
        <h1 className="font-display text-xl font-semibold text-white">Tarefas</h1>
        <p className="text-sm text-slate-400">
          {pending.length} pendente{pending.length !== 1 ? 's' : ''} · {completed.length} concluída
          {completed.length !== 1 ? 's' : ''}
        </p>
      </header>

      <div className="border-b border-white/5 px-6 py-4">
        <div className="mx-auto flex max-w-2xl items-center gap-3 rounded-xl border border-electric-500/20 bg-midnight-800 px-3 py-2 focus-within:border-electric-500/50 focus-within:shadow-glow-sm transition-all">
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Adicionar nova tarefa..."
            className="flex-1 bg-transparent py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none"
          />
          <button
            onClick={addTask}
            disabled={!newTitle.trim() || submitting}
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-electric-500 text-white transition hover:bg-electric-600 disabled:cursor-not-allowed disabled:opacity-30"
          >
            {submitting ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-2xl">
          {error && (
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-2 text-xs text-red-300">
              <CircleAlert size={14} />
              {error}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-slate-500">
              <Loader2 size={18} className="animate-spin" />
              <span className="text-sm">Carregando tarefas...</span>
            </div>
          ) : tasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-center text-slate-500">
              <ListChecks size={28} className="text-slate-600" />
              <p className="text-sm">Nenhuma tarefa ainda. Adicione a primeira acima.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              {pending.length > 0 && (
                <section>
                  <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Pendentes
                  </h2>
                  <div className="flex flex-col gap-2">
                    {pending.map((task) => (
                      <TaskCard key={task.id} task={task} onComplete={completeTask} />
                    ))}
                  </div>
                </section>
              )}

              {completed.length > 0 && (
                <section>
                  <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Concluídas
                  </h2>
                  <div className="flex flex-col gap-2">
                    {completed.map((task) => (
                      <TaskCard key={task.id} task={task} onComplete={completeTask} />
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function TaskCard({ task, onComplete }: { task: Task; onComplete: (id: string) => void }) {
  const isDone = task.status === 'completed'
  return (
    <div
      className={`group flex items-center gap-3 rounded-xl border px-4 py-3 transition-all ${
        isDone
          ? 'border-white/5 bg-midnight-900/60 opacity-60'
          : 'border-electric-500/10 bg-midnight-800 hover:border-electric-500/30 hover:shadow-glow-sm'
      }`}
    >
      <button
        onClick={() => !isDone && onComplete(task.id)}
        disabled={isDone}
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition-all ${
          isDone
            ? 'border-electric-500 bg-electric-500 text-white'
            : 'border-slate-600 text-transparent hover:border-electric-400'
        }`}
      >
        <Check size={13} strokeWidth={3} />
      </button>
      <div className="flex-1 min-w-0">
        <p className={`truncate text-sm ${isDone ? 'text-slate-500 line-through' : 'text-slate-100'}`}>
          {task.title}
        </p>
      </div>
      {task.created_at && (
        <span className="shrink-0 text-[11px] text-slate-600">
          {new Date(task.created_at).toLocaleDateString('pt-BR')}
        </span>
      )}
    </div>
  )
}
