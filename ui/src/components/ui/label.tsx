import type { LabelHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export const Label = ({ className, ...p }: LabelHTMLAttributes<HTMLLabelElement>) => <label className={cn('mb-1 block text-xs font-semibold text-muted-foreground', className)} {...p} />
