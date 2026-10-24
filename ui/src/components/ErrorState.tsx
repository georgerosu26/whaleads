import { AlertTriangle } from 'lucide-react'
import { Button } from './ui/button'

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center rounded-lg border bg-surface px-6 py-12 text-center">
      <AlertTriangle aria-hidden className="mb-3 h-6 w-6 text-danger" />
      <h2 className="text-base font-semibold">Something went wrong</h2>
      <p className="mt-1 max-w-sm break-words text-sm text-muted-foreground">{message}</p>
      <Button variant="secondary" className="mt-4" onClick={onRetry}>Retry</Button>
    </div>
  )
}
