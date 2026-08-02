import { useEffect, useRef, useState } from 'react'
import JSZip from 'jszip'
import { X, FileCode, Download, Check, Loader2, FolderPlus, PackageCheck } from 'lucide-react'
import type { ProjectFile } from '../types/projects'

interface FilesPanelProps {
  open: boolean
  onClose: () => void
  files: ProjectFile[]
  // muda a cada leva nova de arquivos gerados — dispara a animação de
  // "criando... -> criado" mesmo que os paths se repitam (ex: editou de novo)
  genId: number
  projectName: string | null
  onSaveAsProject?: () => void
}

function extensionOf(path: string): string {
  const parts = path.split('.')
  return parts.length > 1 ? parts[parts.length - 1].toUpperCase() : 'ARQ'
}

function baseNameOf(path: string): string {
  return path.split('/').pop() ?? path
}

function downloadBlob(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export default function FilesPanel({ open, onClose, files, genId, projectName, onSaveAsProject }: FilesPanelProps) {
  // quantos arquivos já "terminaram de ser escritos" na animação — o resto
  // ainda aparece com o spinner de "Ley está criando/editando..."
  const [revealed, setRevealed] = useState(0)
  const [selected, setSelected] = useState(0)
  const [zipping, setZipping] = useState(false)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!open || files.length === 0) return

    setRevealed(0)
    setSelected(0)
    let i = 0

    function tick() {
      i += 1
      setRevealed(i)
      if (i < files.length) {
        timerRef.current = window.setTimeout(tick, 420 + Math.random() * 260)
      }
    }
    timerRef.current = window.setTimeout(tick, 320)

    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genId, open])

  async function handleDownloadAll() {
    setZipping(true)
    try {
      const zip = new JSZip()
      files.forEach((f) => zip.file(f.path, f.content))
      const blob = await zip.generateAsync({ type: 'blob' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${projectName ? projectName.replace(/\s+/g, '-').toLowerCase() : 'arquivos-ley'}.zip`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } finally {
      setZipping(false)
    }
  }

  if (!open) return null

  const allDone = revealed >= files.length
  const current = files[selected]

  return (
    <>
      {/* Fundo escurecido no mobile (no desktop o painel só ocupa a lateral) */}
      <div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm md:hidden" onClick={onClose} />

      <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-white/10 bg-midnight-950/80 backdrop-blur-2xl shadow-2xl md:w-[420px]">
        {/* Cabeçalho */}
        <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3.5">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-100">
              <FileCode size={15} className="text-electric-400" />
              {projectName ?? 'Arquivos da conversa'}
            </p>
            <p className="text-[11px] text-slate-500">
              {allDone ? `${files.length} arquivo${files.length === 1 ? '' : 's'}` : 'Ley está programando...'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-white/5 hover:text-slate-200 cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        {/* Lista de arquivos com status ao vivo */}
        <div className="flex flex-col gap-1 border-b border-white/10 px-2.5 py-2.5 max-h-[38%] overflow-y-auto">
          {files.map((f, i) => {
            const isRevealed = i < revealed
            const isActive = i === selected
            return (
              <button
                key={f.path + i}
                onClick={() => isRevealed && setSelected(i)}
                disabled={!isRevealed}
                className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs transition ${
                  isActive ? 'bg-electric-500/10 ring-1 ring-electric-500/30' : 'hover:bg-white/5'
                } ${!isRevealed ? 'opacity-60' : 'cursor-pointer'}`}
              >
                {isRevealed ? (
                  <Check size={13} className="shrink-0 text-emerald-400" />
                ) : (
                  <Loader2 size={13} className="shrink-0 animate-spin text-electric-400" />
                )}
                <span className="min-w-0 flex-1 truncate font-medium text-slate-200">{baseNameOf(f.path)}</span>
                <span className="shrink-0 text-[10px] text-slate-500">
                  {isRevealed ? (f.status === 'updated' ? 'editado' : 'criado') : f.status === 'updated' ? 'editando' : 'criando'}
                </span>
              </button>
            )
          })}
        </div>

        {/* Preview do arquivo selecionado */}
        <div className="flex-1 overflow-auto px-4 py-3.5">
          {current && selected < revealed ? (
            <>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
                  {extensionOf(current.path)}
                </span>
                <button
                  onClick={() => downloadBlob(baseNameOf(current.path), current.content)}
                  className="flex items-center gap-1.5 rounded-md bg-white/5 px-2.5 py-1 text-[11px] font-medium text-slate-300 transition hover:bg-white/10 cursor-pointer"
                >
                  <Download size={12} />
                  Baixar
                </button>
              </div>
              <pre className="whitespace-pre-wrap break-words rounded-xl border border-white/10 bg-midnight-900/60 p-3.5 font-mono text-[11.5px] leading-relaxed text-slate-300">
                {current.content}
              </pre>
            </>
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-slate-500">
              Ley está escrevendo esse arquivo...
            </div>
          )}
        </div>

        {/* Rodapé de ações */}
        <div className="flex items-center gap-2 border-t border-white/10 px-4 py-3">
          {onSaveAsProject && (
            <button
              onClick={onSaveAsProject}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs font-medium text-slate-300 transition hover:bg-white/5 cursor-pointer"
            >
              <FolderPlus size={13} />
              Salvar como projeto
            </button>
          )}
          <button
            onClick={handleDownloadAll}
            disabled={zipping || !allDone}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-electric-500 px-3 py-2 text-xs font-medium text-white transition hover:bg-electric-600 disabled:opacity-50 cursor-pointer"
          >
            <PackageCheck size={13} />
            {zipping ? 'Zipando...' : 'Baixar tudo (.zip)'}
          </button>
        </div>
      </aside>
    </>
  )
}
