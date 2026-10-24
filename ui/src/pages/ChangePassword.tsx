import { useState, type FormEvent } from 'react'
import { AuthCard } from '@/components/AuthCard'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'

/** Shown instead of the app while staff.must_change_pw is set. */
export default function ChangePassword() {
  const { reload, logout } = useAuth()
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try { await api('/api/auth/password', { method: 'POST', body: { current_password: cur, new_password: next } }); reload() }
    catch (err) { setError((err as Error).message) }
    finally { setBusy(false) }
  }

  return (
    <AuthCard title="Choose a new password" subtitle="Your administrator asked you to replace the temporary password.">
      <form onSubmit={submit} className="space-y-4">
        <Field id="cur" label="Current password" type="password" autoComplete="current-password" required value={cur} onChange={(e) => setCur(e.target.value)} />
        <Field id="next" label="New password" type="password" autoComplete="new-password" required minLength={10} value={next} onChange={(e) => setNext(e.target.value)} hint="At least 10 characters." />
        {error && <p role="alert" className="break-words text-sm text-danger">{error}</p>}
        <Button type="submit" loading={busy} className="w-full">Save password</Button>
        <Button type="button" variant="ghost" className="w-full" onClick={() => void logout()}>Log out</Button>
      </form>
    </AuthCard>
  )
}
