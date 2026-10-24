import { CheckCircle2, ChevronDown, Link2, PlugZap, XCircle } from 'lucide-react'
import { Fragment, useState, type FormEvent } from 'react'
import { CopyButton } from '@/components/CopyButton'
import { Card, FormMsg, LoadGate, SettingsPage } from '@/components/SettingsPage'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { api, ApiError } from '@/lib/api'
import { useLoad } from '@/lib/useLoad'

type Kind = 'whabuzz' | 'cloud_api'
interface NumberStatus { ok: boolean; connected: boolean; display_number: string | null; verified_name: string | null; quality: string | null; tier: string | null; detail: string | null }
interface Adaptor { kind: Kind | null; source: 'd1' | 'env' | null; onboarding?: 'connect_button' | 'manual_form'; connect_available?: boolean; sandbox?: boolean; connect_info?: { display_phone_number: string; tenant_id: string } | null; config: Record<string, string> | null; status: NumberStatus | null }

const FIELDS: Record<Kind, { key: string; label: string; secret?: boolean; hint?: string }[]> = {
  whabuzz: [
    { key: 'api_key', label: 'API key', secret: true, hint: 'From your WhaBuzz console.' },
    { key: 'phone_number_id', label: 'Phone number ID' },
    { key: 'waba_id', label: 'WhatsApp Business Account ID' },
    { key: 'webhook_secret', label: 'Webhook secret', secret: true, hint: 'The signing secret WhaBuzz uses when it calls the webhook URL below.' },
  ],
  cloud_api: [
    { key: 'system_token', label: 'System user token', secret: true },
    { key: 'app_secret', label: 'App secret', secret: true },
    { key: 'phone_number_id', label: 'Phone number ID' },
    { key: 'waba_id', label: 'WhatsApp Business Account ID' },
    { key: 'app_id', label: 'App ID (optional)' },
    { key: 'verify_token', label: 'Webhook verify token (optional)', secret: true },
  ],
}
// Where an upstream rejection (422) is shown: next to the credential that was most likely wrong.
const REJECT_FIELD: Record<Kind, string> = { whabuzz: 'api_key', cloud_api: 'system_token' }

function ConnectForm({ kind, onSaved, onCancel }: { kind: Kind; onSaved: () => void; onCancel?: () => void }) {
  const fields = FIELDS[kind]
  const [v, setV] = useState<Record<string, string>>({})
  const [errs, setErrs] = useState<Record<string, string>>({}); const [general, setGeneral] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErrs({}); setGeneral('')
    try {
      await api('/api/admin/adaptor', { method: 'PUT', body: { kind, config: v } })
      setV({}); onSaved()
    } catch (x) {
      const m = (x as Error).message
      const named = /^config\.(\w+)/.exec(m)?.[1]
      if (x instanceof ApiError && x.status === 400 && named) {
        const label = fields.find((f) => f.key === named)?.label ?? named
        const rest = m.replace(/^config\.\w+\s*/, '')
        setErrs({ [named]: rest === 'required' ? `${label} is required.` : `${label} ${rest}.` })
      }
      else if (x instanceof ApiError && x.status === 422) {
        const st = x.data?.status as { detail?: string; error?: { message?: string } } | undefined
        setErrs({ [REJECT_FIELD[kind]]: `Rejected: ${st?.error?.message ?? st?.detail ?? 'the connection check failed'}. Nothing was saved.` })
      } else setGeneral(m)
    } finally { setBusy(false) }
  }
  const input = (f: (typeof fields)[number]) => (
    <div key={f.key}>
      <Field id={`${kind}_${f.key}`} label={f.label} hint={errs[f.key] ? undefined : f.hint} autoComplete="off" spellCheck={false}
        type={f.secret ? 'password' : 'text'} required={!/optional/.test(f.label)} value={v[f.key] ?? ''} onChange={(e) => setV({ ...v, [f.key]: e.target.value })}
        aria-invalid={!!errs[f.key]} aria-describedby={errs[f.key] ? `${kind}_${f.key}_err` : undefined} />
      {errs[f.key] && <p id={`${kind}_${f.key}_err`} role="alert" className="mt-1 break-words text-xs text-danger">{errs[f.key]}</p>}
    </div>
  )
  return (
    <form onSubmit={submit} className="space-y-3" noValidate={false}>
      {fields.map(input)}
      <div className="flex flex-wrap items-center gap-2"><Button type="submit" loading={busy}>Check and save</Button>{onCancel && <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>}</div>
      <FormMsg error={general} />
    </form>
  )
}

function Status({ a }: { a: Adaptor }) {
  const s = a.status
  if (!a.kind) return <p className="text-sm text-muted-foreground">No WhatsApp number is connected yet. Connect one below to send and receive messages.</p>
  const good = !!s?.ok && s.connected
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {good ? <CheckCircle2 aria-hidden className="h-5 w-5 text-green-600" /> : <XCircle aria-hidden className="h-5 w-5 text-danger" />}
        <span className="text-base font-semibold">{good ? 'Connected' : 'Not connected'}</span>
        <Badge>{a.kind === 'whabuzz' ? 'WhaBuzz' : 'Cloud API'}</Badge>{a.sandbox && <Badge tone="amber">Sandbox</Badge>}{a.source === 'env' && <Badge tone="amber">From deployment settings</Badge>}
      </div>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        {(s?.display_number || a.connect_info?.display_phone_number) && <><dt className="text-muted-foreground">Number</dt><dd className="break-all">{s?.display_number || a.connect_info?.display_phone_number}</dd></>}
        {s?.verified_name && <><dt className="text-muted-foreground">Name</dt><dd className="break-words">{s.verified_name}</dd></>}
        {s?.quality && <><dt className="text-muted-foreground">Quality</dt><dd>{s.quality}</dd></>}
        {s?.tier && <><dt className="text-muted-foreground">Limit</dt><dd>{s.tier}</dd></>}
        {s && !good && s.detail && <><dt className="text-muted-foreground">Detail</dt><dd className="break-words">{s.detail}</dd></>}
        {a.config && Object.entries(a.config).filter(([k]) => FIELDS[a.kind!].some((f) => f.key === k)).map(([k, val]) => (
          <Fragment key={k}><dt className="text-muted-foreground">{FIELDS[a.kind!].find((f) => f.key === k)?.label}</dt><dd className="break-all font-mono text-xs">{val}</dd></Fragment>
        ))}
      </dl>
    </div>
  )
}

// what the callback redirect tells the admin. Wording is fixed here; the URL only carries a code.
const CONNECT_ERRORS: Record<string, string> = {
  access_denied: 'Connection cancelled.',
  invalid_code: 'That link expired or was already used, connect again.',
  state_mismatch: 'That link expired or was already used, connect again.',
  code_used: 'That code was used twice; WhaBuzz revoked the connection for safety, connect again.',
  code_expired: 'That code expired, connect again.',
  connection_gone: 'The connection was revoked in WhaBuzz before it finished, connect again.',
  connection_unavailable: 'The number is no longer available in WhaBuzz.',
  rate_limited: 'Too many attempts, wait a minute.',
  too_many_attempts: 'Too many attempts, wait a minute.',
  unknown_app: 'WhaLeads is not registered with this WhaBuzz.',
  forbidden: 'Only an admin can connect WhatsApp.',
  exchange_failed: 'WhaBuzz did not complete the connection. Try again.',
  server_error: 'WhaBuzz had a problem. Try again.',
}

function ConnectResult({ ok, warn, error }: { ok: boolean; warn: string; error: string }) {
  if (ok) return <div role="status" data-testid="connect-ok" className="mb-4 rounded-lg border border-green-600/30 bg-green-600/10 p-3 text-sm"><p>WhaBuzz is connected. Messages to your number will now arrive here.</p>{warn === 'status_failed' && <p data-testid="connect-warn" className="mt-1 text-muted-foreground">Connected. The status check failed, retry from the Status panel.</p>}</div>
  if (!error) return null
  const text = CONNECT_ERRORS[error] ?? 'The connection did not complete. Try again.'
  return (
    <div role="alert" data-testid="connect-error" className="mb-4 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm">
      <p className="break-words">{text}</p>
    </div>
  )
}

function Body({ a, reload }: { a: Adaptor; reload: () => void }) {
  const [open, setOpen] = useState<'' | 'whabuzz'>('')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('')
  // The callback redirect lands here with ?connected=1 or ?connect_error=<code>.
  const [res] = useState(() => {
    const q = new URLSearchParams(location.search)
    return { ok: q.get('connected') === '1', warn: q.get('warn') ?? '', error: q.get('connect_error') ?? '', detail: (q.get('detail') ?? '').slice(0, 120) }
  })
  const hookPath = a.kind === 'cloud_api' ? '/webhooks/meta' : '/webhooks/whabuzz'
  const hook = `${location.origin}${hookPath}`
  const canConnect = a.connect_available === true
  const saved = () => { setOpen(''); reload() }
  async function connect() {
    setBusy(true); setErr('')
    try {
      const r = await api<{ url: string }>('/api/connect/whabuzz/start', { method: 'POST' })
      window.location.assign(r.url) // leaves the app: WhaBuzz sends the browser back to /api/whabuzz/callback
    } catch (x) { setErr((x as Error).message); setBusy(false) }
  }
  return (
    <>
      <ConnectResult ok={res.ok} warn={res.warn} error={res.error} />
      <Card title="Connection"><Status a={a} /></Card>
      <Card title="Connect to WhaBuzz">
        {open === 'whabuzz' ? <ConnectForm kind="whabuzz" onSaved={saved} onCancel={() => setOpen('')} /> : (
          <div>
            <p className="mb-3 text-sm text-muted-foreground">{!canConnect ? 'Paste the API key and webhook secret from your WhaBuzz account.' : a.kind === 'whabuzz' ? 'Connect a different number, or reconnect this one. You sign in to WhaBuzz and come straight back; no keys to copy.' : 'Sign in to WhaBuzz, verify your number, and come straight back. No keys to copy.'}</p>
            {confirm ? (
              <div className="space-y-2 rounded-lg border bg-muted/40 p-3 text-sm">
                <p>Your number is connected through the Meta Cloud API. Connecting WhaBuzz replaces it.</p>
                <div className="flex flex-wrap gap-2"><Button type="button" loading={busy} onClick={() => void connect()}>Replace and connect</Button><Button type="button" variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button></div>
              </div>
            ) : canConnect ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" loading={busy} onClick={() => (a.kind === 'cloud_api' ? setConfirm(true) : void connect())}><PlugZap aria-hidden className="h-4 w-4" />Connect with WhaBuzz</Button>
                <Button type="button" variant="ghost" onClick={() => setOpen('whabuzz')}>Enter keys manually</Button>
              </div>
            ) : (
              <Button type="button" onClick={() => setOpen('whabuzz')}>Enter keys manually</Button>
            )}
            <FormMsg error={err} />
          </div>
        )}
      </Card>
      <Card title="Webhook URL">
        <p className="mb-2 text-sm text-muted-foreground">Paste this into {a.kind === 'cloud_api' ? 'your Meta app webhook settings' : 'WhaBuzz as the webhook for incoming messages'}.</p>
        <div className="flex flex-wrap items-center gap-2"><code data-testid="webhook-url" className="min-w-0 flex-1 basis-56 break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">{hook}</code><CopyButton value={hook} /></div>
      </Card>
      <details className="mb-4 rounded-lg border bg-surface p-4 [&_summary::-webkit-details-marker]:hidden">
        <summary className="flex min-h-[32px] cursor-pointer items-center justify-between text-base font-semibold"><span className="flex items-center gap-2"><Link2 aria-hidden className="h-4 w-4" />Use the Meta Cloud API directly</span><ChevronDown aria-hidden className="h-4 w-4" /></summary>
        <p className="mb-3 mt-2 text-sm text-muted-foreground">For numbers you manage in your own Meta app. Replaces the saved connection.</p>
        <ConnectForm kind="cloud_api" onSaved={reload} />
      </details>
    </>
  )
}

export default function WhatsApp() {
  const l = useLoad<Adaptor>('/api/admin/adaptor')
  return (
    <SettingsPage title="WhatsApp" subtitle="The number your team sends and receives on">
      <LoadGate load={l.state} retry={() => void l.reload()} rows={3}>{(a) => <Body a={a} reload={() => void l.reload()} />}</LoadGate>
    </SettingsPage>
  )
}
