import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'
import { Spinner } from './spinner'

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost'; loading?: boolean }

export const Button = forwardRef<HTMLButtonElement, Props>(({ className, variant = 'primary', loading, disabled, children, ...p }, ref) => (
  <button
    ref={ref}
    disabled={disabled || loading}
    className={cn(
      'inline-flex min-h-[40px] items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60',
      variant === 'primary' && 'bg-accent text-accent-foreground hover:bg-accent/90',
      variant === 'secondary' && 'border bg-surface text-foreground hover:bg-muted',
      variant === 'ghost' && 'text-foreground hover:bg-muted',
      className,
    )}
    {...p}
  >
    {loading && <Spinner />}
    {children}
  </button>
))
Button.displayName = 'Button'
