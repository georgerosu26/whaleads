import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { Button } from './ui/button'

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false)
  async function copy() {
    try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500) } catch { /* clipboard blocked; the value is visible for manual copy */ }
  }
  return <Button type="button" variant="secondary" onClick={() => void copy()} aria-label={label}>{done ? <Check aria-hidden className="h-4 w-4" /> : <Copy aria-hidden className="h-4 w-4" />}{done ? 'Copied' : label}</Button>
}
