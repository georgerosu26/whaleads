import { KeyRound, UserPlus, Users } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { CopyButton } from '@/components/CopyButton'
import { EmptyState } from '@/components/EmptyState'
import { Card, FormMsg, LoadGate, SettingsPage } from '@/components/SettingsPage'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { api, ApiError } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useLoad } from '@/lib/useLoad'

interface Member { id: number; email: string; name: string; role: 'admin' | 'staff'; active: number; must_change_pw: number; last_login_at: string | null }
interface Temp { who: string; email: string; password: string }

const ERR: Record<string, string> = {
  last_admin: 'There must always be one active administrator. Make someone else an admin first.',
  email_taken: 'Someone with that email is already on the team.',
  use_profile: 'To change your own password, use My profile.',
}
const msg = (e: unknown) => ERR[(e as Error).message] ?? (e as Error).message

function TempBanner({ t, onClose }: { t: Temp; onClose: () => void }) {
  return (
    <div role="status" className="mb-4 rounded-lg border border-accent bg-surface p-4">
      <p className="text-sm font-semibold">Temporary password for {t.who}</p>
      <p className="mt-1 text-xs text-muted-foreground">Shown once. Share it privately; {t.email} must choose a new one at first login.</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code data-testid="temp-password" className="min-w-0 break-all rounded-md bg-muted px-3 py-2 font-mono text-base">{t.password}</code>
        <CopyButton value={t.password} label="Copy password" />
        <Button type="button" variant="ghost" onClick={onClose}>Done</Button>
      </div>
    </div>
  )
}

function AddForm({ onAdded }: { onAdded: (t: Temp) => void }) {
  const [f, setF] = useState({ name: '', email: '', role: 'staff' })
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [field, setField] = useState('')
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr(''); setField('')
    try {
      const r = await api<{ staff: Member; temp_password: string }>('/api/staff', { method: 'POST', body: f })
      setF({ name: '', email: '', role: 'staff' }); onAdded({ who: r.staff.name, email: r.staff.email, password: r.temp_password })
    } catch (x) { setErr(msg(x)); setField(x instanceof ApiError ? x.field ?? '' : '') } finally { setBusy(false) }
  }
  return (
    <Card title="Add a team member">
      <form onSubmit={submit} className="space-y-3">
        <Field id="staff_name" label="Name" required maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-invalid={field === 'name'} />
        <Field id="staff_email" label="Email" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} aria-invalid={field === 'email'} />
        <div><Label htmlFor="staff_role">Role</Label><Select id="staff_role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="staff">Staff</option><option value="admin">Admin</option></Select></div>
        <div className="flex flex-wrap items-center gap-3"><Button type="submit" loading={busy}><UserPlus aria-hidden className="h-4 w-4" />Add member</Button><FormMsg error={err} /></div>
      </form>
    </Card>
  )
}

function Row({ m, meId, onChanged, onTemp }: { m: Member; meId: number | null; onChanged: () => void; onTemp: (t: Temp) => void }) {
  const [busy, setBusy] = useState(''); const [err, setErr] = useState(''); const [confirm, setConfirm] = useState<'' | 'reset' | 'off'>('')
  const isMe = m.id === meId
  async function run(kind: string, fn: () => Promise<void>) {
    setBusy(kind); setErr('')
    try { await fn(); setConfirm(''); onChanged() } catch (x) { setErr(msg(x)) } finally { setBusy('') }
  }
  const patch = (body: object) => api(`/api/staff/${m.id}`, { method: 'PATCH', body })
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-48">
          <div className="flex items-center gap-2"><span className="truncate text-base font-semibold">{m.name}</span>{isMe && <Badge>You</Badge>}{!m.active && <Badge tone="amber">Deactivated</Badge>}{m.must_change_pw === 1 && m.active === 1 && <Badge tone="blue">Must change password</Badge>}</div>
          <div className="truncate text-xs text-muted-foreground">{m.email}</div>
        </div>
        <Select aria-label={`Role for ${m.name}`} className="w-28" value={m.role} disabled={!!busy} onChange={(e) => void run('role', () => patch({ role: e.target.value }))}><option value="staff">Staff</option><option value="admin">Admin</option></Select>
        <div className="flex gap-2">
          {!isMe && <Button type="button" variant="secondary" onClick={() => setConfirm(confirm === 'reset' ? '' : 'reset')}><KeyRound aria-hidden className="h-4 w-4" />Reset</Button>}
          {m.active ? <Button type="button" variant="secondary" onClick={() => setConfirm(confirm === 'off' ? '' : 'off')}>Deactivate</Button>
            : <Button type="button" variant="secondary" loading={busy === 'on'} onClick={() => void run('on', () => patch({ active: true }))}>Reactivate</Button>}
        </div>
      </div>
      {confirm === 'reset' && (
        <div className="mt-3 rounded-md bg-muted p-3 text-sm"><p>Reset the password for {m.name}? They are signed out everywhere and get a new temporary password.</p>
          <div className="mt-2 flex gap-2"><Button type="button" loading={busy === 'reset'} onClick={() => void run('reset', async () => { const r = await api<{ temp_password: string }>(`/api/staff/${m.id}/reset-password`, { method: 'POST' }); onTemp({ who: m.name, email: m.email, password: r.temp_password }) })}>Reset password</Button><Button type="button" variant="ghost" onClick={() => setConfirm('')}>Cancel</Button></div></div>
      )}
      {confirm === 'off' && (
        <div className="mt-3 rounded-md bg-muted p-3 text-sm"><p>Deactivate {m.name}? They are signed out and cannot log in until reactivated.</p>
          <div className="mt-2 flex gap-2"><Button type="button" loading={busy === 'off'} onClick={() => void run('off', () => patch({ active: false }))}>Deactivate</Button><Button type="button" variant="ghost" onClick={() => setConfirm('')}>Cancel</Button></div></div>
      )}
      {err && <div className="mt-2"><FormMsg error={err} /></div>}
    </li>
  )
}

export default function Team() {
  const { state } = useAuth()
  const meId = state.status === 'in' ? state.me.staff.id : null
  const l = useLoad<{ staff: Member[] }>('/api/staff')
  const [temp, setTemp] = useState<Temp | null>(null)
  const changed = () => void l.reload()
  return (
    <SettingsPage title="Team" subtitle="Who can log in, and what they can change">
      {temp && <TempBanner t={temp} onClose={() => setTemp(null)} />}
      <AddForm onAdded={(t) => { setTemp(t); changed() }} />
      <LoadGate load={l.state} retry={changed}>
        {(d) => d.staff.length === 0 ? <EmptyState icon={Users} title="No team members yet" body="Add the first person above." /> : (
          <ul className="divide-y rounded-lg border bg-surface">{d.staff.map((m) => <Row key={m.id} m={m} meId={meId} onChanged={changed} onTemp={setTemp} />)}</ul>
        )}
      </LoadGate>
    </SettingsPage>
  )
}
