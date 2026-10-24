import { X } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'

/** Bottom sheet on phones, centred card on desktop. Esc and the backdrop close it; focus moves into it. */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose // a fresh inline onClose must not re-run the effect (it would steal focus on every render)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLElement>('input,select,textarea,button')?.focus()
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close.current() }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); prev?.focus?.() }
  }, [])
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 md:items-center" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className="max-h-[90dvh] w-full overflow-y-auto rounded-t-xl border bg-surface p-4 shadow-xl md:max-w-md md:rounded-xl">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="truncate text-base font-bold">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"><X aria-hidden className="h-5 w-5" /></button>
        </div>
        {children}
      </div>
    </div>
  )
}
