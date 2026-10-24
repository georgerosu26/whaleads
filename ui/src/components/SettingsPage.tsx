import { ChevronLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { PageHeader } from './PageHeader'
import { ErrorState } from './ErrorState'
import { Skeleton } from './ui/skeleton'
import type { Load } from '@/lib/useLoad'

export function SettingsPage({ title, subtitle, children, actions }: { title: string; subtitle?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl">
      <Link to="/settings" className="mb-2 inline-flex min-h-[40px] items-center gap-1 text-sm font-semibold text-muted-foreground hover:text-foreground"><ChevronLeft aria-hidden className="h-4 w-4" />Settings</Link>
      <PageHeader title={title} subtitle={subtitle} actions={actions} />
      {children}
    </div>
  )
}

export function Card({ title, children, className }: { title?: string; children: ReactNode; className?: string }) {
  return <section className={`mb-4 rounded-lg border bg-surface p-4 ${className ?? ''}`}>{title && <h2 className="mb-3 text-base font-semibold">{title}</h2>}{children}</section>
}

export function LoadGate<T>({ load, retry, children, rows = 3 }: { load: Load<T>; retry: () => void; children: (d: T) => ReactNode; rows?: number }) {
  if (load.status === 'loading') return <div aria-busy="true" aria-label="Loading" className="space-y-3">{Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-14" />)}</div>
  if (load.status === 'error') return <ErrorState message={load.message} onRetry={retry} />
  return <>{children(load.data)}</>
}

export function FormMsg({ error, ok }: { error?: string; ok?: string }) {
  if (error) return <p role="alert" className="break-words text-sm text-danger">{error}</p>
  if (ok) return <p role="status" className="text-sm text-muted-foreground">{ok}</p>
  return null
}
