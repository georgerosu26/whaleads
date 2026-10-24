import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ErrorState } from '@/components/ErrorState'
import { PageHeader } from '@/components/PageHeader'
import { NextActionPicker } from '@/components/leads/NextActionPicker'
import { OwnerSelect } from '@/components/leads/OwnerSelect'
import { TagPicker } from '@/components/leads/TagPicker'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { api, ApiError } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useMeta } from '@/lib/crm'
import { phoneError, toWaDigits } from '../../../src/phone'

export default function NewLead() {
  const { state } = useAuth()
  const me = state.status === 'in' ? state.me : null
  const tz = me?.timezone ?? 'UTC'
  const nav = useNavigate()
  const { state: meta, reload } = useMeta()
  const [f, setF] = useState({ name: '', phone: '', email: '', message: '', source: 'manual', owner: '' })
  const [tags, setTags] = useState<number[]>([])
  const [next, setNext] = useState<number | null>(null)
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [dup, setDup] = useState<number | null>(null)
  const [fail, setFail] = useState<string | null>(null)
  const up = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }))

  if (meta.status === 'error') return <ErrorState message={meta.message} onRetry={reload} />
  if (meta.status === 'loading') return <div aria-busy="true" aria-label="Loading form" className="max-w-lg space-y-4"><Skeleton className="h-7 w-40" /><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
  const m = meta.data

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setFail(null); setDup(null)
    const local: Record<string, string> = {}
    if (!toWaDigits(f.phone, me?.default_country)) local.phone = phoneError(f.phone, me?.default_country)
    if (Object.keys(local).length) { setErrs(local); return }
    setErrs({}); setBusy(true)
    try {
      const r = await api<{ id: number }>('/api/leads/manual', { method: 'POST', body: {
        phone: f.phone, name: f.name, email: f.email, message: f.message, source: f.source,
        assigned_to: f.owner ? Number(f.owner) : null, next_action_at: next, tag_ids: tags,
      } })
      nav(`/leads/${r.id}`)
    } catch (x) {
      if (x instanceof ApiError && x.status === 409 && typeof x.data?.lead_id === 'number') setDup(x.data.lead_id)
      else if (x instanceof ApiError && x.field) setErrs({ [x.field]: x.message })
      else setFail((x as Error).message)
    } finally { setBusy(false) }
  }

  return (
    <form onSubmit={submit} noValidate className="max-w-lg">
      <PageHeader title="New lead" subtitle="Add someone you spoke to outside WhatsApp" />
      <div className="space-y-4">
        <div>
          <Field id="nl-phone" label="Phone" type="tel" inputMode="tel" autoComplete="off" placeholder="+1 555 010 0100" value={f.phone} onChange={up('phone')} aria-invalid={!!errs.phone} aria-describedby={errs.phone ? 'nl-phone-err' : undefined} required />
          {errs.phone && <p id="nl-phone-err" role="alert" className="mt-1 text-sm text-danger">{errs.phone}</p>}
        </div>
        <Field id="nl-name" label="Name" value={f.name} onChange={up('name')} maxLength={120} autoComplete="off" />
        <div>
          <Field id="nl-email" label="Email" type="email" value={f.email} onChange={up('email')} autoComplete="off" />
          {errs.email && <p role="alert" className="mt-1 text-sm text-danger">{errs.email}</p>}
        </div>
        <div>
          <Label htmlFor="nl-msg">What they want</Label>
          <textarea id="nl-msg" rows={3} maxLength={2000} value={f.message} onChange={up('message')} className="w-full rounded-md border bg-surface px-3 py-2 text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" />
        </div>
        <div>
          <Label htmlFor="nl-source">Source</Label>
          <Select id="nl-source" value={f.source} onChange={up('source')}>{m.sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</Select>
        </div>
        <div><Label htmlFor="nl-owner">Owner</Label><OwnerSelect id="nl-owner" owners={m.owners} value={f.owner ? Number(f.owner) : null} onChange={(v) => setF((p) => ({ ...p, owner: v ? String(v) : '' }))} /></div>
        {m.tags.length > 0 && <div><Label>Tags</Label><TagPicker all={m.tags} selected={tags} onChange={setTags} /></div>}
        <div><Label>Next action</Label><NextActionPicker value={next} tz={tz} onChange={setNext} /></div>
        {dup && <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm">This contact already has an open lead. <Link className="font-semibold underline" to={`/leads/${dup}`}>Open it</Link></p>}
        {errs.source && <p role="alert" className="text-sm text-danger">{errs.source}</p>}
        {fail && <p role="alert" className="text-sm text-danger">{fail}</p>}
        <div className="flex gap-2">
          <Button type="submit" loading={busy}>Create lead</Button>
          <Link to="/leads"><Button type="button" variant="ghost">Cancel</Button></Link>
        </div>
      </div>
    </form>
  )
}
