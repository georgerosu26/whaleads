import { useState, type FormEvent } from 'react'
import { Card, FormMsg, LoadGate, SettingsPage } from '@/components/SettingsPage'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { api } from '@/lib/api'
import { useLoad } from '@/lib/useLoad'

interface Resp { settings: { ai?: { configured: boolean; last4: string | null; readable: boolean } } }

function Body({ data, set }: { data: Resp; set: (d: Resp) => void }) {
  const ai = data.settings.ai
  const [key, setKey] = useState(''); const [busy, setBusy] = useState(''); const [err, setErr] = useState(''); const [ok, setOk] = useState('')
  async function send(value: string | null, kind: string) {
    setBusy(kind); setErr(''); setOk('')
    try { set(await api<Resp>('/api/settings', { method: 'PATCH', body: { anthropic_key: value } })); setKey(''); setOk(value ? 'Key saved.' : 'Key removed.') } catch (x) { setErr((x as Error).message) } finally { setBusy('') }
  }
  return (
    <Card title="Anthropic API key">
      <p className="mb-3 text-sm text-muted-foreground">Optional. Used by the AI node in automations. The key is stored encrypted and can never be read back.</p>
      {ai?.configured && (
        <p className="mb-3 text-sm" data-testid="ai-state">{ai.readable ? <>A key ending in <span className="font-mono font-semibold">{ai.last4}</span> is saved.</> : 'A key is saved but cannot be decrypted with the current SESSION_SECRET. Save it again.'}</p>
      )}
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (key.trim()) void send(key.trim(), 'save') }} className="space-y-3">
        <Field id="anthropic_key" label={ai?.configured ? 'Replace key' : 'API key'} type="password" autoComplete="off" spellCheck={false} placeholder="sk-ant-..." value={key} onChange={(e) => setKey(e.target.value)} />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" loading={busy === 'save'}>Save key</Button>
          {ai?.configured && <Button type="button" variant="secondary" loading={busy === 'rm'} onClick={() => void send(null, 'rm')}>Remove key</Button>}
          <FormMsg error={err} ok={ok} />
        </div>
      </form>
    </Card>
  )
}

export default function AI() {
  const l = useLoad<Resp>('/api/settings')
  return (
    <SettingsPage title="AI" subtitle="Optional assistant features">
      <LoadGate load={l.state} retry={() => void l.reload()} rows={2}>{(d) => <Body data={d} set={l.set} />}</LoadGate>
    </SettingsPage>
  )
}
