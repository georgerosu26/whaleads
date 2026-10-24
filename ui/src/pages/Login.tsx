import { safeNext } from '../lib/safeNext'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { AuthCard } from '@/components/AuthCard'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { api, ApiError } from '@/lib/api'
import { useAuth, type Me } from '@/lib/auth'

export default function Login() {
  const { signedIn } = useAuth()
  const nav = useNavigate()
  const [params] = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const me = await api<Me>('/api/auth/login', { method: 'POST', body: { email, password } })
      // a callback that arrived signed-out comes back here with ?next=; same-origin paths only, never an absolute or protocol-relative URL.
      const target = safeNext(params.get('next'), window.location.origin)
      if (target) {
        if (target.startsWith('/api/')) { window.location.assign(target); return } // server-handled route: needs a real navigation
        nav(target, { replace: true })
      }
      signedIn(me)
    } catch (err) {
      const s = err instanceof ApiError ? err.status : 0
      setError(s === 401 ? 'Email or password is incorrect.' : s === 429 ? 'Too many attempts. Wait a few minutes and try again.' : (err as Error).message)
    } finally { setBusy(false) }
  }

  return (
    <AuthCard title="Log in" subtitle="Use the account your administrator created.">
      <form onSubmit={submit} className="space-y-4">
        <Field id="email" label="Email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
        <Field id="password" label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <p role="alert" className="break-words text-sm text-danger">{error}</p>}
        <Button type="submit" loading={busy} className="w-full">Log in</Button>
      </form>
      <p className="mt-4 text-sm text-muted-foreground">
        <Link to="/recover" className="font-semibold text-accent underline-offset-2 hover:underline">Forgot your password?</Link>{' '}
        Team members: ask an administrator to reset it from Settings → Team.
      </p>
    </AuthCard>
  )
}
