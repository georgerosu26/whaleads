import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AuthCard } from '@/components/AuthCard'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { api, ApiError } from '@/lib/api'
import { useAuth, type Me } from '@/lib/auth'

// D26: the owner resets their own password with the setup key (SESSION_SECRET). Team members ask an administrator.
export default function Recover() {
  const { signedIn } = useAuth()
  const nav = useNavigate()
  const [f, setF] = useState({ setup_key: '', email: '', password: '', confirm: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (f.password !== f.confirm) { setError('The two passwords do not match.'); return }
    setBusy(true); setError('')
    try {
      const me = await api<Me>('/api/auth/recover', { method: 'POST', body: { setup_key: f.setup_key, email: f.email, new_password: f.password } })
      nav('/', { replace: true })
      signedIn(me)
    } catch (err) {
      const s = err instanceof ApiError ? err.status : 0
      setError(s === 403 ? 'That key or email is not right.' : s === 429 ? 'Too many attempts. Wait a few minutes and try again.' : (err as Error).message)
    } finally { setBusy(false) }
  }

  return (
    <AuthCard title="Reset your password" subtitle="For the workspace owner. Use the setup key from when you deployed.">
      <form onSubmit={submit} className="space-y-4">
        <Field id="setup_key" label="Setup key" type="password" autoComplete="off" required value={f.setup_key} onChange={set('setup_key')} hint="The SESSION_SECRET you set when you deployed." />
        <Field id="email" label="Email" type="email" autoComplete="username" required value={f.email} onChange={set('email')} placeholder="name@company.com" />
        <Field id="password" label="New password" type="password" autoComplete="new-password" required minLength={10} value={f.password} onChange={set('password')} hint="At least 10 characters." />
        <Field id="confirm" label="Confirm new password" type="password" autoComplete="new-password" required minLength={10} value={f.confirm} onChange={set('confirm')} />
        {error && <p role="alert" className="break-words text-sm text-danger">{error}</p>}
        <Button type="submit" loading={busy} className="w-full">Reset password and log in</Button>
      </form>
      <p className="mt-4 text-sm text-muted-foreground"><Link to="/login" className="font-semibold text-accent underline-offset-2 hover:underline">Back to log in</Link></p>
    </AuthCard>
  )
}
