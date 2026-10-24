import { Pencil, Trash2, Zap } from 'lucide-react'
import { useState } from 'react'
import { EmptyState } from '@/components/EmptyState'
import { Card, FormMsg, LoadGate, SettingsPage } from '@/components/SettingsPage'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { useLoad } from '@/lib/useLoad'

interface QR { id: number; shortcut: string; body: string }

export default function QuickReplies() {
  const { state, reload } = useLoad<{ quick_replies: QR[] }>('/api/quick-replies')
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [shortcut, setShortcut] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const open = (r?: QR) => { setEditing(r ? r.id : 'new'); setShortcut(r?.shortcut ?? ''); setBody(r?.body ?? ''); setErr('') }
  const save = async () => {
    setBusy(true); setErr('')
    try {
      if (editing === 'new') await api('/api/quick-replies', { method: 'POST', body: { shortcut, body } })
      else await api(`/api/quick-replies/${editing}`, { method: 'PATCH', body: { shortcut, body } })
      setEditing(null); await reload()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  const remove = async (r: QR) => {
    if (!window.confirm(`Delete /${r.shortcut}?`)) return
    try { await api(`/api/quick-replies/${r.id}`, { method: 'DELETE' }); await reload() } catch (e) { setErr((e as Error).message) }
  }

  return (
    <SettingsPage title="Quick replies" subtitle="Type / in the composer to insert one. {name} becomes the contact's first name." actions={<Button onClick={() => open()}>Add</Button>}>
      {editing !== null && (
        <Card title={editing === 'new' ? 'New quick reply' : 'Edit quick reply'}>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void save() }}>
            <label className="block text-sm font-semibold">Shortcut
              <Input className="mt-1" value={shortcut} onChange={(e) => setShortcut(e.target.value)} maxLength={33} placeholder="hours" autoFocus />
            </label>
            <label className="block text-sm font-semibold">Message
              <textarea className="mt-1 min-h-[96px] w-full rounded-md border bg-surface px-3 py-2 text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" value={body} onChange={(e) => setBody(e.target.value)} maxLength={4096} placeholder="Hi {name}, we are open 9 to 6." />
            </label>
            <FormMsg error={err} />
            <div className="flex gap-2">
              <Button type="submit" loading={busy} disabled={!shortcut.trim() || !body.trim()}>Save</Button>
              <Button type="button" variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
            </div>
          </form>
        </Card>
      )}
      <LoadGate load={state} retry={() => void reload()}>
        {(d) => d.quick_replies.length === 0
          ? <EmptyState icon={Zap} title="No quick replies yet" body="Save the answers you type most, then insert them from the composer." action={editing === null ? <Button onClick={() => open()}>Add the first one</Button> : undefined} />
          : (
            <ul className="divide-y rounded-lg border bg-surface">
              {d.quick_replies.map((r) => (
                <li key={r.id} className="flex items-start gap-2 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold">/{r.shortcut}</p>
                    <p className="line-clamp-2 break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">{r.body}</p>
                  </div>
                  <Button variant="ghost" aria-label={`Edit ${r.shortcut}`} className="w-11 px-0" onClick={() => open(r)}><Pencil aria-hidden className="h-4 w-4" /></Button>
                  <Button variant="ghost" aria-label={`Delete ${r.shortcut}`} className="w-11 px-0" onClick={() => void remove(r)}><Trash2 aria-hidden className="h-4 w-4" /></Button>
                </li>
              ))}
            </ul>
          )}
      </LoadGate>
      {editing === null && err && <FormMsg error={err} />}
    </SettingsPage>
  )
}
