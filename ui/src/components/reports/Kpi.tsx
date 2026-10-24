import { Skeleton } from '@/components/ui/skeleton'

export function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-lg border bg-surface p-4">
      <div className="truncate text-xs font-semibold text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-2xl font-bold">{value}</div>
      {hint && <div className="line-clamp-2 text-xs text-muted-foreground">{hint}</div>}
    </div>
  )
}
export const KpiSkeleton = () => <div className="rounded-lg border bg-surface p-4"><Skeleton className="h-3 w-20" /><Skeleton className="mt-3 h-7 w-16" /></div>
