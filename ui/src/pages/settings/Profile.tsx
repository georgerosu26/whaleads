import { Bell, BellOff, Moon, Sun } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Card, FormMsg, SettingsPage } from '@/components/SettingsPage'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { api } from '@/lib/api'
import { useAuth, type Me } from '@/lib/auth'
import { getTheme, setTheme, type Theme } from '@/lib/theme'
import { isIos, isStandalone, useInstallPrompt, usePush } from '@/lib/push'
import { Skeleton } from '@/components/ui/skeleton'

export default function Profile() {
  const { state } = useAuth()
  return state.status === 'in' ? <ProfileForm me={state.me} /> : null
}

function ProfileForm({ me }: { me: Me }) {
  const { refresh } = useAuth()
  const [name, setName] = useState(me.staff.name)
  const [nameBusy, setNameBusy] = useState(false); const [nameErr, setNameErr] = useState(''); const [nameOk, setNameOk] = useState('')
  const [pw, setPw] = useState({ current_password: '', new_password: '' })
  const [pwBusy, setPwBusy] = useState(false); const [pwErr, setPwErr] = useState(''); const [pwOk, setPwOk] = useState('')
  const [theme, setT] = useState<Theme>(getTheme())

  async function saveName(e: FormEvent) {
    e.preventDefault(); setNameBusy(true); setNameErr(''); setNameOk('')
    try { await api('/api/auth/me', { method: 'PATCH', body: { name } }); setNameOk('Saved.'); await refresh() } catch (x) { setNameErr((x as Error).message) } finally { setNameBusy(false) }
  }
  async function savePw(e: FormEvent) {
    e.preventDefault(); setPwBusy(true); setPwErr(''); setPwOk('')
    try {
      await api('/api/auth/password', { method: 'POST', body: pw })
      setPw({ current_password: '', new_password: '' }); setPwOk('Password changed. Other devices were signed out.')
      await refresh()
    } catch (x) { setPwErr((x as Error).message) } finally { setPwBusy(false) }
  }
  const pick = (t: Theme) => { setTheme(t); setT(t) }

  return (
    <SettingsPage title="My profile" subtitle={me.staff.email}>
      <NotificationsCard />
      <Card title="Name">
        <form onSubmit={saveName} className="space-y-3">
          <Field id="profile_name" label="Your name" required maxLength={80} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
          <div className="flex items-center gap-3"><Button type="submit" loading={nameBusy}>Save name</Button><FormMsg error={nameErr} ok={nameOk} /></div>
        </form>
      </Card>
      <Card title="Change password">
        <form onSubmit={savePw} className="space-y-3">
          <Field id="current_password" label="Current password" type="password" autoComplete="current-password" required value={pw.current_password} onChange={(e) => setPw({ ...pw, current_password: e.target.value })} />
          <Field id="new_password" label="New password" type="password" autoComplete="new-password" required minLength={10} value={pw.new_password} onChange={(e) => setPw({ ...pw, new_password: e.target.value })} hint="At least 10 characters." />
          <div className="flex items-center gap-3"><Button type="submit" loading={pwBusy}>Change password</Button><FormMsg error={pwErr} ok={pwOk} /></div>
        </form>
      </Card>
      <Card title="Theme">
        <div role="group" aria-label="Theme" className="flex gap-2">
          <Button type="button" variant={theme === 'light' ? 'primary' : 'secondary'} aria-pressed={theme === 'light'} onClick={() => pick('light')}><Sun aria-hidden className="h-4 w-4" />Light</Button>
          <Button type="button" variant={theme === 'dark' ? 'primary' : 'secondary'} aria-pressed={theme === 'dark'} onClick={() => pick('dark')}><Moon aria-hidden className="h-4 w-4" />Dark</Button>
        </div>
      </Card>
    </SettingsPage>
  )
}

// web push is the only way staff are told about new leads and messages (no WhatsApp alerts).
function NotificationsCard() {
  const { state, enable, disable, test } = usePush()
  const { canPrompt, prompt } = useInstallPrompt()
  const [busy, setBusy] = useState<'' | 'enable' | 'disable' | 'test'>('')
  const [err, setErr] = useState(''); const [ok, setOk] = useState('')
  const run = (what: 'enable' | 'disable' | 'test', fn: () => Promise<void>) => async () => {
    setBusy(what); setErr(''); setOk('')
    try { await fn() } catch (x) { setErr((x as Error).message) } finally { setBusy('') }
  }
  return (
    <Card title="Notifications">
      <div data-testid="notifications-card">
        {state.kind === 'checking' && <div aria-busy="true" aria-label="Checking notifications" className="space-y-2"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-10 w-40" /></div>}
        {state.kind === 'unsupported' && (
          <p className="text-sm text-muted-foreground">
            {state.reason === 'ios_needs_install'
              ? 'On iPhone, notifications only work from the installed app. Tap Share, then Add to Home Screen, open WhaLeads from your Home Screen and come back here.'
              : 'This browser cannot receive notifications. Try Chrome, Edge, Firefox or Safari on a recent version.'}
          </p>
        )}
        {state.kind === 'denied' && <p role="status" className="text-sm text-muted-foreground">Notifications are blocked for this site. Allow them in your browser or phone settings for this site, then reload this page.</p>}
        {state.kind === 'off' && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Get a notification on this device for every new lead, and for new messages in chats assigned to you (or unassigned).{isIos() && !isStandalone() ? ' On iPhone, add WhaLeads to your Home Screen first.' : ''}</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" loading={busy === 'enable'} onClick={run('enable', enable)}><Bell aria-hidden className="h-4 w-4" />Turn on notifications</Button>
              {canPrompt && <Button type="button" variant="secondary" onClick={() => void prompt()}>Install app</Button>}
            </div>
          </div>
        )}
        {state.kind === 'on' && (
          <div className="space-y-3">
            <p className="text-sm"><span className="font-semibold">On for this device.</span> <span className="text-muted-foreground">Each person turns it on per device.</span></p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" loading={busy === 'test'} onClick={run('test', async () => { const r = await test(); if (r.sent > 0) setOk(`Sent to ${r.sent} device${r.sent === 1 ? '' : 's'}.`); else setErr('No device accepted the test. Turn notifications off and on again.') })}>Send a test</Button>
              <Button type="button" variant="ghost" loading={busy === 'disable'} onClick={run('disable', disable)}><BellOff aria-hidden className="h-4 w-4" />Turn off</Button>
            </div>
          </div>
        )}
        <div className="mt-2 min-h-[20px]"><FormMsg error={err} ok={ok} /></div>
      </div>
    </Card>
  )
}
