import { Copy, FileText, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { EmptyState } from '@/components/EmptyState'
import { Modal } from '@/components/leads/Modal'
import { FormMsg, LoadGate, SettingsPage } from '@/components/SettingsPage'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { ApiError, api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { ago, HEADER_LABEL, QUALITY_LABEL, QUALITY_TONE, REJECT_HINT, STATE_NOTE, STATUS_LABEL, STATUS_TONE, type Tpl, type TplList } from '@/lib/templates'
import { useLoad } from '@/lib/useLoad'

const RUNBOOK = 'https://github.com/WhaBuzz/whaleads/blob/main/docs/RUNBOOK.md#templates'
const link = 'inline-flex min-h-[40px] items-center gap-2 rounded-md bg-accent px-4 text-sm font-semibold text-accent-foreground hover:bg-accent/90'

export default function Templates() {
  const { state: auth } = useAuth()
  const nav = useNavigate()
  const isAdmin = auth.status === 'in' && auth.me.staff.role === 'admin'
  const { state, reload, set } = useLoad<TplList>('/api/templates')
  const [syncing, setSyncing] = useState(false)
  const [msg, setMsg] = useState<{ error?: string; ok?: string }>({})
  const [category, setCategory] = useState('')
  const [status, setStatus] = useState('')
  const [language, setLanguage] = useState('')
  const [confirm, setConfirm] = useState<Tpl | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [delErr, setDelErr] = useState<string | null>(null)

  const sync = async () => {
    setSyncing(true); setMsg({})
    try {
      const r = await api<TplList & { count?: number; changed?: number }>('/api/templates/sync', { method: 'POST' })
      await reload()
      setMsg({ ok: r.changed ? `Synced. ${r.changed} updated.` : 'Synced. Nothing changed.' })
    } catch (e) { setMsg({ error: (e as Error).message }) } finally { setSyncing(false) }
  }
  const remove = async () => {
    if (!confirm) return
    setDeleting(true); setDelErr(null)
    try {
      await api(`/api/templates/${encodeURIComponent(confirm.id)}`, { method: 'DELETE' })
      if (state.status === 'ready') set({ ...state.data, templates: state.data.templates.filter((x) => x.id !== confirm.id) })
      setMsg({ ok: `Deleted ${confirm.name}.` }); setConfirm(null)
    } catch (e) { setDelErr((e as ApiError).message) } finally { setDeleting(false) }
  }
  // "Fix and resubmit" and "Duplicate" both open Create pre-filled under a new name (Meta will not take the old one back right away).
  const reuse = (t: Tpl, mode: 'fix' | 'duplicate') => nav('/settings/templates/new', { state: { prefill: t, mode } })

  const languages = useMemo(() => (state.status === 'ready' ? [...new Set(state.data.templates.map((t) => t.language))].sort() : []), [state])

  return (
    <SettingsPage
      title="Templates" subtitle="Approved templates are the only way to message outside the 24 hour window."
      actions={<>
        <Button variant="secondary" loading={syncing} onClick={() => void sync()}>{!syncing && <RefreshCw aria-hidden className="h-4 w-4" />}Sync</Button>
        {isAdmin && <Link to="/settings/templates/new" className={link}><Plus aria-hidden className="h-4 w-4" />New</Link>}
      </>}
    >
      <FormMsg error={msg.error} ok={msg.ok} />
      <LoadGate load={state} retry={() => void reload()} rows={4}>
        {(d) => {
          if (d.templates.length === 0) {
            return <EmptyState icon={FileText} title="No templates yet" body={isAdmin ? 'Create one, or sync to pull in the ones already approved at Meta.' : 'Ask an admin to create one, or sync to pull in existing ones.'} action={isAdmin ? <Link to="/settings/templates/new" className={link}>Create the first one</Link> : undefined} />
          }
          const shown = d.templates.filter((t) => (!category || t.category === category) && (!status || t.status === status) && (!language || t.language === language))
          return (
            <>
              <div className="mb-3 grid grid-cols-3 gap-2" role="group" aria-label="Filter templates">
                <Select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)}><option value="">Category</option><option value="UTILITY">Utility</option><option value="MARKETING">Marketing</option><option value="AUTHENTICATION">Authentication</option></Select>
                <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Status</option>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
                <Select aria-label="Language" value={language} onChange={(e) => setLanguage(e.target.value)}><option value="">Language</option>{languages.map((l) => <option key={l} value={l}>{l}</option>)}</Select>
              </div>
              {shown.length === 0
                ? <EmptyState icon={FileText} title="Nothing matches" body="No template fits these filters." action={<Button variant="secondary" onClick={() => { setCategory(''); setStatus(''); setLanguage('') }}>Clear filters</Button>} />
                : (
                  <ul className="divide-y rounded-lg border bg-surface" aria-label="Templates">
                    {shown.map((t) => (
                      <li key={t.id} className={`px-4 py-3 ${t.sendable === false && t.category !== 'AUTHENTICATION' ? 'opacity-60' : ''}`} data-testid={`tpl-${t.name}`}>
                        <div className="flex items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-bold" title={t.name}>{t.name}</p>
                            <p className="mt-0.5 line-clamp-2 break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">{t.category === 'AUTHENTICATION' ? 'One-time code. Meta writes the message.' : t.body}</p>
                          </div>
                          <span className="flex shrink-0 flex-col items-end gap-1">
                            <span data-testid="tpl-status"><Badge tone={STATUS_TONE[t.status]}>{STATUS_LABEL[t.status] ?? t.status}</Badge></span>
                            {t.status === 'APPROVED' && t.quality && <span data-testid="tpl-quality"><Badge tone={QUALITY_TONE[t.quality]}>{QUALITY_LABEL[t.quality]}</Badge></span>}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">{t.language} · {t.category.toLowerCase()} · {HEADER_LABEL[t.header_format] ?? t.header_format} · synced {ago(t.synced_at)}</p>
                        {t.category === 'AUTHENTICATION'
                          ? <p role="note" className="mt-2 break-words text-xs text-muted-foreground">Sent by API only. It never appears in the inbox, flows or broadcasts. <a className="underline" href={RUNBOOK} target="_blank" rel="noreferrer">How to send a code</a></p>
                          : t.sendable === false && <p role="note" className="mt-2 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">Not sendable from WhaLeads. {t.unsendable_reason}</p>}
                        {STATE_NOTE[t.status] && <p role="note" className="mt-2 break-words rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">{STATE_NOTE[t.status]}</p>}
                        {t.status === 'REJECTED' && (
                          <p role="note" title={t.rejected_reason ?? undefined} className="mt-2 break-words rounded-md bg-danger/10 px-3 py-2 text-xs text-danger [overflow-wrap:anywhere]">
                            <strong>Rejected by Meta.</strong> {t.rejected_reason || 'No reason given.'}
                            {t.rejected_reason && REJECT_HINT[t.rejected_reason.toUpperCase()] && <span className="mt-1 block">{REJECT_HINT[t.rejected_reason.toUpperCase()]}</span>}
                          </p>
                        )}
                        {isAdmin && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {t.status === 'REJECTED' && <Button variant="secondary" className="min-h-[36px] px-3 text-xs" onClick={() => reuse(t, 'fix')}><Pencil aria-hidden className="h-3.5 w-3.5" />Fix and resubmit</Button>}
                            <Button variant="ghost" className="min-h-[36px] px-3 text-xs" onClick={() => reuse(t, 'duplicate')}><Copy aria-hidden className="h-3.5 w-3.5" />Duplicate</Button>
                            <Button variant="ghost" aria-label={`Delete ${t.name}`} className="min-h-[36px] px-3 text-xs" onClick={() => { setDelErr(null); setConfirm(t) }}><Trash2 aria-hidden className="h-3.5 w-3.5" />Delete</Button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              <p className="mt-3 text-xs text-muted-foreground">Last synced {ago(d.synced_at)}.{d.pending > 0 ? ` ${d.pending} pending, checked hourly.` : ''}</p>
            </>
          )
        }}
      </LoadGate>
      {confirm && (
        <Modal title="Delete template" onClose={() => { if (!deleting) setConfirm(null) }}>
          <p className="break-words text-sm [overflow-wrap:anywhere]">Delete <strong>{confirm.name}</strong> ({confirm.language})? This also deletes it at Meta, and Meta will not let you reuse the name for a while.</p>
          {delErr && <p role="alert" className="mt-3 break-words rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{delErr}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" disabled={deleting} onClick={() => setConfirm(null)}>Cancel</Button>
            <Button loading={deleting} onClick={() => void remove()}>Delete</Button>
          </div>
        </Modal>
      )}
    </SettingsPage>
  )
}
