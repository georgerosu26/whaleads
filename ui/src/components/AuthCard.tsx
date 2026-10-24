import type { ReactNode } from 'react'

export function AuthCard({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-full items-start justify-center px-4 py-10 md:items-center">
      <div className="w-full max-w-md rounded-lg border bg-surface p-6">
        <div className="mb-1 text-xs font-bold uppercase tracking-wide text-accent">WhaLeads</div>
        <h1 className="text-xl font-bold">{title}</h1>
        {subtitle && <p className="mb-5 mt-1 text-sm text-muted-foreground">{subtitle}</p>}
        <div className={subtitle ? '' : 'mt-5'}>{children}</div>
      </div>
    </div>
  )
}
