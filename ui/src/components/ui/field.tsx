import type { InputHTMLAttributes } from 'react'
import { Input } from './input'
import { Label } from './label'

export function Field({ label, hint, ...p }: { label: string; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <Label htmlFor={p.id}>{label}</Label>
      <Input {...p} />
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
