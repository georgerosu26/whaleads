import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { AuthCard } from '@/components/AuthCard'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { CountrySelect, timezoneList } from '@/components/CountrySelect'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { api, ApiError } from '@/lib/api'
import { useAuth, type Me } from '@/lib/auth'

const MESSAGES: Record<string, string> = {
  invalid_setup_key: 'That setup key is not correct.',
  setup_locked: 'This workspace is already set up. Log in instead.',
  session_secret_missing: 'SESSION_SECRET is not configured on this Worker.',
}

export default function Setup() {
  const { signedIn, reload } = useAuth()
  const navigate = useNavigate()
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const zones = useMemo(() => timezoneList(browserTz), [browserTz])
  const [f, setF] = useState({ setup_key: '', business_name: '', default_country: 'IN', timezone: browserTz, name: '', email: '', password: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // The deployment can name its own default country (DEFAULT_COUNTRY); otherwise India.
  useEffect(() => {
    let live = true
    api<{ default_country?: string | null }>('/api/setup/status').then((r) => { if (live && r.default_country) setF((p) => ({ ...p, default_country: r.default_country! })) }).catch(() => undefined)
    return () => { live = false }
  }, [])
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const body = {
        setup_key: f.setup_key, business_name: f.business_name, timezone: f.timezone,
        ...(f.default_country ? { default_country: f.default_country } : {}),
        admin: { name: f.name, email: f.email, password: f.password },
      }
      signedIn(await api<Me>('/api/setup', { method: 'POST', body }))
      navigate('/settings/whatsapp', { replace: true }) // a fresh workspace has no number yet: go straight to connecting one
    } catch (err) {
      const msg = (err as Error).message
      setError(MESSAGES[msg] ?? (err instanceof ApiError && err.status === 429 ? 'Too many attempts. Wait a few minutes and try again.' : msg))
      if (err instanceof ApiError && err.status === 409) reload()
    } finally { setBusy(false) }
  }

  return (
    <AuthCard title="Set up your workspace" subtitle="Create the first administrator. This page locks as soon as it succeeds.">
      <form onSubmit={submit} className="space-y-4">
        <Field id="setup_key" label="Setup key" type="password" autoComplete="off" required value={f.setup_key} onChange={set('setup_key')} hint="The SESSION_SECRET value set on this Worker." />
        <Field id="business_name" label="Business name" required maxLength={80} value={f.business_name} onChange={set('business_name')} placeholder="As your team knows it" />
        <div className="grid gap-3 sm:grid-cols-2">
          <div><Label htmlFor="default_country">Country</Label><CountrySelect id="default_country" value={f.default_country} onChange={(v) => setF({ ...f, default_country: v })} /></div>
          <div>
            <Label htmlFor="timezone">Timezone</Label>
            <Select id="timezone" value={f.timezone} onChange={set('timezone')}>{zones.map((z) => <option key={z} value={z}>{z}</option>)}</Select>
          </div>
        </div>
        <Field id="name" label="Your name" autoComplete="name" required maxLength={80} value={f.name} onChange={set('name')} />
        <Field id="email" label="Email" type="email" autoComplete="username" required value={f.email} onChange={set('email')} placeholder="name@company.com" />
        <Field id="password" label="Password" type="password" autoComplete="new-password" required minLength={10} value={f.password} onChange={set('password')} hint="At least 10 characters." />
        {error && <p role="alert" className="break-words text-sm text-danger">{error}</p>}
        <Button type="submit" loading={busy} className="w-full">Create workspace</Button>
      </form>
    </AuthCard>
  )
}
