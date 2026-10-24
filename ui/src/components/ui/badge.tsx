import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export const TAG_STYLES: Record<string, string> = {
  neutral: 'bg-muted text-foreground', coral: 'bg-accent/15 text-accent', amber: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  green: 'bg-green-500/15 text-green-700 dark:text-green-300', teal: 'bg-teal-500/15 text-teal-700 dark:text-teal-300',
  blue: 'bg-blue-500/15 text-blue-700 dark:text-blue-300', violet: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  pink: 'bg-pink-500/15 text-pink-700 dark:text-pink-300',
}
export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: string; className?: string }) {
  return <span className={cn('inline-flex max-w-full items-center truncate rounded-full px-2 py-0.5 text-xs font-semibold', TAG_STYLES[tone] ?? TAG_STYLES.neutral, className)}>{children}</span>
}
