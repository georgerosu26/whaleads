import { forwardRef, type SelectHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...p }, ref) => (
  <select ref={ref} className={cn('min-h-[40px] w-full rounded-md border bg-surface px-2 text-base text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60', className)} {...p} />
))
Select.displayName = 'Select'
