import { Globe, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { CopyButton } from '@/components/CopyButton'
import { EmptyState } from '@/components/EmptyState'
import { Card, FormMsg, LoadGate, SettingsPage } from '@/components/SettingsPage'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { useLoad } from '@/lib/useLoad'

interface Resp { settings: { allowed_origins: string[] }; sources: Record<string, string> }

function Body({ data, set }: { data: Resp; set: (d: Resp) => void }) {
  const [v, setV] = useState(''); const [busy, setBusy] = useState(''); const [err, setErr] = useState('')
  const origins = data.settings.allowed_origins
  const usingDefault = data.sources.allowed_origins !== 'setting'
  const endpoint = `${location.origin}/api/leads`
  async function save(next: string[] | null, kind: string) {
    setBusy(kind); setErr('')
    try { set(await api<Resp>('/api/settings', { method: 'PATCH', body: { allowed_origins: next } })); setV('') } catch (x) { setErr((x as Error).message) } finally { setBusy('') }
  }
  const add = (e: FormEvent) => { e.preventDefault(); if (v.trim()) void save([...origins, v.trim()], 'add') }
  return (
    <>
      <Card title="Intake endpoint">
        <p className="mb-2 text-sm text-muted-foreground">POST JSON from your website forms to this address.</p>
        <div className="flex flex-wrap items-center gap-2"><code data-testid="intake-url" className="min-w-0 flex-1 basis-56 break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">{endpoint}</code><CopyButton value={endpoint} /></div>
      </Card>
      <Card title="Allowed websites">
        <p className="mb-3 text-sm text-muted-foreground">Only forms on these websites can send leads from a browser. Use the address without a path, like https://www.example.com.{usingDefault && ' Currently using the deployment default.'}</p>
        {origins.length === 0 ? <EmptyState icon={Globe} title="No websites allowed" body="Browser forms are blocked until you add one." /> : (
          <ul className="divide-y rounded-lg border">
            {origins.map((o) => (
              <li key={o} className="flex min-h-[48px] items-center gap-2 px-3"><span className="min-w-0 flex-1 break-all text-sm">{o}</span>
                <Button type="button" variant="ghost" className="px-2" aria-label={`Remove ${o}`} disabled={!!busy} onClick={() => void save(origins.filter((x) => x !== o), 'rm')}><Trash2 aria-hidden className="h-4 w-4" /></Button></li>
            ))}
          </ul>
        )}
        <form onSubmit={add} className="mt-3 flex flex-wrap gap-2">
          <Input aria-label="Website address" className="min-w-0 flex-1 basis-48" type="url" inputMode="url" placeholder="https://www.example.com" value={v} onChange={(e) => setV(e.target.value)} />
          <Button type="submit" loading={busy === 'add'}>Add website</Button>
        </form>
        {!usingDefault && <div className="mt-3"><Button type="button" variant="secondary" loading={busy === 'reset'} onClick={() => void save(null, 'reset')}>Use deployment default</Button></div>}
        <div className="mt-2"><FormMsg error={err} /></div>
      </Card>
    </>
  )
}

export default function Forms() {
  const l = useLoad<Resp>('/api/settings')
  return (
    <SettingsPage title="Lead forms" subtitle="Where leads from your website come in">
      <LoadGate load={l.state} retry={() => void l.reload()}>{(d) => <Body data={d} set={l.set} />}</LoadGate>
    </SettingsPage>
  )
}
