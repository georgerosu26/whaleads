import { ArrowLeft, Check, Megaphone } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { EmptyState } from '@/components/EmptyState'
import { ErrorState } from '@/components/ErrorState'
import { PageHeader } from '@/components/PageHeader'
import { TagPicker } from '@/components/leads/TagPicker'
import { WaCard } from '@/components/templates/WaCard'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { api, ApiError } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import {
  FIELDS, FIELD_LABEL, audienceTooLarge, blankParams, broadcastErrorText, broadcastable, broadcastsApi, confirmMatches, emptyFilter, excludedLine, filterIssue,
  fitParams, hasOptOutHint, paceLabel, paramProblems, paramsPayload, paramsValid, placeholderParams, renderBody, sampleValues, setKind, specSample, tierWarning,
  type Broadcast, type BroadcastFilter, type FieldName, type ParamSpec, type ParamsSpec, type Preview,
} from '@/lib/broadcasts'
import { useMeta } from '@/lib/crm'
import { useLoad } from '@/lib/useLoad'
import type { Tpl, TplList } from '@/lib/templates'
import { cn } from '@/lib/utils'

type DraftState = { status: 'idle' } | { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: { broadcast: Broadcast } }
function useDraft(id: string | undefined) {
  const [state, setState] = useState<DraftState>(id ? { status: 'loading' } : { status: 'idle' })
  const reload = useCallback(async () => {
    if (!id) return
    try { setState({ status: 'ready', data: await broadcastsApi.get(id) }) } catch (e) { setState({ status: 'error', message: broadcastErrorText(e) }) }
  }, [id])
  useEffect(() => { void reload() }, [reload])
  return { state, reload }
}

const STEPS = ['Audience', 'Template', 'Values', 'Review'] as const
const DEFAULT_PACE = 20

export default function BroadcastWizard() {
  const { id: editId } = useParams()
  const { state: auth } = useAuth()
  const nav = useNavigate()
  const isAdmin = auth.status === 'in' && auth.me.staff.role === 'admin'
  const meta = useMeta()
  const tpls = useLoad<TplList>('/api/templates')
  const existing = useDraft(editId)

  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [filter, setFilter] = useState<BroadcastFilter>(emptyFilter())
  const [tplId, setTplId] = useState<string | null>(null)
  const [params, setParams] = useState<ParamsSpec>({ body: [], header: [] })
  const [draftId, setDraftId] = useState<string | null>(editId ?? null)
  const [prefilled, setPrefilled] = useState(!editId)

  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [previewErr, setPreviewErr] = useState('')
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState<'save' | 'start' | null>(null)
  const [err, setErr] = useState('')
  const [changed, setChanged] = useState<string>('')
  const [tier, setTier] = useState<string | null>(null)
  const [pace, setPace] = useState(DEFAULT_PACE)
  const [triedNext, setTriedNext] = useState(false)

  const eligible = useMemo(() => (tpls.state.status === 'ready' ? tpls.state.data.templates.filter(broadcastable) : []), [tpls.state])
  const tpl: Tpl | null = eligible.find((t) => t.id === tplId) ?? null

  // Edit: prefill once the draft and the template list are both here.
  useEffect(() => {
    if (prefilled || existing.state.status !== 'ready' || tpls.state.status !== 'ready') return
    const b = existing.state.data.broadcast
    if (b.status !== 'draft') { nav(`/broadcasts/${b.id}`, { replace: true }); return }
    const t = tpls.state.data.templates.find((x) => x.id === b.template_id)
    setName(b.name)
    setFilter({ ...emptyFilter(), ...b.filter })
    if (t && broadcastable(t)) { setTplId(t.id); setParams(fitParams(b.params, t.body_params_count, t.header_params_count)) }
    setPrefilled(true)
  }, [prefilled, existing.state, tpls.state, nav])

  // Admin extras, fail-soft: the pace and the number's messaging tier.
  useEffect(() => {
    if (!isAdmin) return
    void api<{ settings: { broadcast_per_minute?: number } }>('/api/settings').then((r) => { if (r.settings?.broadcast_per_minute) setPace(r.settings.broadcast_per_minute) }).catch(() => {})
    void api<{ status?: { tier?: string | null } }>('/api/admin/adaptor').then((r) => setTier(r.status?.tier ?? null)).catch(() => {})
  }, [isAdmin])

  // Live counts. Before a template is chosen the preview is counts-only (no template_id); once one is chosen, placeholder
  // values stand in until the parameters are valid (the audience does not depend on the values).
  const useReal = !!tpl && paramsValid(params)
  const previewKey = JSON.stringify([filter, tpl?.id ?? null, useReal ? paramsPayload(params) : null])
  const reqN = useRef(0)
  useEffect(() => {
    if (!isAdmin || filterIssue(filter) || !prefilled) { setPreview(null); setPreviewErr(''); setPreviewing(false); return }
    const n = ++reqN.current
    setPreviewing(true)
    const t = setTimeout(() => {
      const body = tpl ? { filter, template_id: tpl.id, params: useReal ? paramsPayload(params) : placeholderParams(tpl.body_params_count, tpl.header_params_count) } : { filter }
      broadcastsApi.preview(body)
        .then((r) => { if (n === reqN.current) { setPreview(r); setPreviewErr('') } })
        .catch((e) => { if (n === reqN.current) { setPreview(null); setPreviewErr(broadcastErrorText(e)) } })
        .finally(() => { if (n === reqN.current) setPreviewing(false) })
    }, 300)
    return () => clearTimeout(t)
  }, [previewKey, isAdmin, prefilled])

  if (!isAdmin) return <div className="mx-auto max-w-3xl p-4 md:p-6"><EmptyState icon={Megaphone} title="Admins only" body="Only an admin can create or edit a broadcast." action={<Link to="/broadcasts"><Button variant="secondary">Back to broadcasts</Button></Link>} /></div>
  if (tpls.state.status === 'error') return <div className="mx-auto max-w-3xl p-4 md:p-6"><ErrorState message={tpls.state.message} onRetry={() => void tpls.reload()} /></div>
  if (existing.state.status === 'error' && editId) return <div className="mx-auto max-w-3xl p-4 md:p-6"><ErrorState message={existing.state.message} onRetry={() => void existing.reload()} /></div>
  if (tpls.state.status === 'loading' || meta.state.status === 'loading' || !prefilled) {
    return <div className="mx-auto max-w-3xl space-y-3 p-4 md:p-6" aria-busy="true" aria-label="Loading"><Skeleton className="h-7 w-48" /><Skeleton className="h-10" /><Skeleton className="h-40" /></div>
  }
  if (meta.state.status === 'error') return <div className="mx-auto max-w-3xl p-4 md:p-6"><ErrorState message={meta.state.message} onRetry={() => void meta.reload()} /></div>
  if (!eligible.length) {
    return (
      <div className="mx-auto max-w-3xl p-4 md:p-6">
        <PageHeader title="New broadcast" />
        <EmptyState icon={Megaphone} title="No template to send yet" body="A broadcast needs an approved marketing or utility template. Create one or sync your templates first." action={<Link to="/settings/templates"><Button>Open templates</Button></Link>} />
      </div>
    )
  }

  const { stages, tags } = meta.state.data
  const nameIssue = !name.trim() ? 'Give the broadcast a name.' : name.trim().length > 120 ? 'Keep the name under 120 characters.' : null
  const audIssue = filterIssue(filter)
  const problems = paramProblems(params)
  const tplIssue = tpl ? null : 'Choose a template.'
  const total = preview?.total ?? 0
  const confirmOk = confirmMatches(filter.all, typed, total)
  const empty = !!preview && total === 0
  const tooBig = !!preview && audienceTooLarge(total)

  function nextIssue(): string | null {
    if (step === 0) return nameIssue ?? audIssue ?? (previewErr || null) ?? (empty ? 'Nobody in this audience can be messaged.' : null) ?? (tooBig ? 'This audience is too large for one broadcast. Narrow it.' : null)
    if (step === 1) return tplIssue
    if (step === 2) return [...problems.body, ...problems.header].find(Boolean) ?? null
    return null
  }

  function pick(t: Tpl) {
    setTplId(t.id)
    if (t.id !== tplId) setParams(blankParams(t.body_params_count, t.header_params_count))
  }

  async function save(): Promise<string | null> {
    if (!tpl || !paramsValid(params) || nameIssue || audIssue) return draftId
    const body = { name: name.trim(), template_id: tpl.id, params: paramsPayload(params), filter }
    const r = draftId ? await broadcastsApi.patch(draftId, body) : await broadcastsApi.create(body)
    setDraftId(r.broadcast.id)
    return r.broadcast.id
  }

  async function next() {
    setTriedNext(true)
    const issue = nextIssue()
    if (issue) { setErr(''); return }
    setTriedNext(false); setErr('')
    // Save the draft whenever it is complete enough: after the values step, or on the template step when it has none.
    if ((step === 1 && tpl && tpl.body_params_count + tpl.header_params_count === 0) || step === 2) {
      setBusy('save')
      try { await save() } catch (e) { setErr(broadcastErrorText(e)); setBusy(null); return }
      setBusy(null)
    }
    setStep((s) => Math.min(3, s + 1))
  }

  async function saveDraft() {
    setBusy('save'); setErr('')
    try { const id = await save(); if (id) nav('/broadcasts') } catch (e) { setErr(broadcastErrorText(e)) } finally { setBusy(null) }
  }

  async function start() {
    if (!preview) return
    setBusy('start'); setErr(''); setChanged('')
    try {
      const id = await save()
      if (!id) { setErr('Finish the earlier steps first.'); return }
      await broadcastsApi.start(id, preview.total)
      nav(`/broadcasts/${id}`)
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.data?.error === 'audience_changed') {
        const nt = Number(e.data.total ?? 0)
        setChanged(`The audience changed while you were reviewing: it is now ${nt.toLocaleString('en')} ${nt === 1 ? 'person' : 'people'}. Check the numbers and confirm again.`)
        setTyped('')
        setPreview((p) => (p ? { ...p, total: nt, excluded: e.data?.excluded ?? p.excluded } : p))
      } else setErr(broadcastErrorText(e))
    } finally { setBusy(null) }
  }

  const issue = triedNext ? nextIssue() : null
  const warn = tierWarning(total, tier)
  return (
    <div className="mx-auto max-w-3xl p-4 md:p-6">
      <PageHeader title={editId ? 'Edit broadcast' : 'New broadcast'} subtitle={`Step ${step + 1} of 4 · ${STEPS[step]}`}
        actions={<Link to="/broadcasts"><Button variant="ghost"><ArrowLeft aria-hidden className="h-4 w-4" />Back</Button></Link>} />
      <ol className="mb-4 flex gap-1.5" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={i === step ? 'step' : undefined} className={cn('flex-1 truncate rounded-md border px-2 py-1.5 text-center text-xs', i === step ? 'border-accent bg-accent/10 font-semibold text-accent' : i < step ? 'bg-surface text-foreground' : 'bg-surface text-muted-foreground')}>
            {i < step && <Check aria-hidden className="mr-1 inline h-3 w-3" />}{s}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <section className="space-y-4" data-testid="step-audience">
          <div>
            <Label htmlFor="bc-name">Name</Label>
            <Input id="bc-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Diwali offer" data-testid="bc-name" />
            <p className="mt-1 text-xs text-muted-foreground">Only your team sees this.</p>
          </div>
          <label className="flex min-h-[44px] items-center gap-2 rounded-lg border bg-surface p-3 text-sm">
            <input type="checkbox" checked={filter.all} onChange={(e) => { setFilter(e.target.checked ? { ...emptyFilter(), all: true } : emptyFilter()); setTyped('') }} data-testid="bc-all" />
            <span><span className="font-semibold">Everyone</span> <span className="text-muted-foreground">(every contact with a phone number)</span></span>
          </label>
          {!filter.all && (
            <>
              <div>
                <Label>Tags</Label>
                <TagPicker all={tags} selected={filter.tags} onChange={(ids) => setFilter((f) => ({ ...f, tags: ids.slice(0, 25) }))} />
                {filter.tags.length > 1 && (
                  <div className="mt-2 inline-flex rounded-md border" role="group" aria-label="Tag match">
                    {(['any', 'all'] as const).map((m) => (
                      <button key={m} type="button" aria-pressed={filter.tag_mode === m} onClick={() => setFilter((f) => ({ ...f, tag_mode: m }))}
                        className={cn('min-h-[40px] px-3 text-sm', filter.tag_mode === m ? 'bg-accent/10 font-semibold text-accent' : 'bg-surface')}>
                        {m === 'any' ? 'Has any of these' : 'Has all of these'}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <Label htmlFor="bc-stage">Stage (optional)</Label>
                <Select id="bc-stage" value={filter.stage ?? ''} onChange={(e) => setFilter((f) => ({ ...f, stage: e.target.value || null }))}>
                  <option value="">Any stage</option>
                  {stages.filter((s) => !s.archived).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </Select>
              </div>
            </>
          )}
          <Counts preview={preview} loading={previewing} error={previewErr} idle={!!audIssue} />
        </section>
      )}

      {step === 1 && (
        <section className="space-y-2" data-testid="step-template">
          <p className="text-sm text-muted-foreground">Only approved marketing and utility templates can be broadcast.</p>
          <ul className="space-y-2">
            {eligible.map((t) => (
              <li key={t.id}>
                <button type="button" onClick={() => pick(t)} aria-pressed={t.id === tplId} data-testid="tpl-option"
                  className={cn('block w-full rounded-lg border bg-surface p-3 text-left', t.id === tplId && 'border-accent ring-1 ring-accent')}>
                  <span className="flex flex-wrap items-center gap-2"><span className="truncate font-bold">{t.name}</span><Badge tone={t.category === 'MARKETING' ? 'violet' : 'blue'}>{t.category === 'MARKETING' ? 'Marketing' : 'Utility'}</Badge><span className="text-xs text-muted-foreground">{t.language}</span></span>
                  <span className="mt-1 line-clamp-2 block whitespace-pre-wrap text-sm text-muted-foreground [overflow-wrap:anywhere]">{t.body}</span>
                </button>
              </li>
            ))}
          </ul>
          {tpl && tpl.category === 'MARKETING' && !hasOptOutHint(tpl) && (
            <p role="note" className="rounded-md bg-amber-500/10 p-2 text-sm text-amber-800 dark:text-amber-200" data-testid="optout-hint">Add &quot;Reply STOP to opt out&quot; to the footer. Marketing messages without a way to stop get blocked and reported more often.</p>
          )}
        </section>
      )}

      {step === 2 && tpl && (
        <section className="space-y-4" data-testid="step-values">
          {params.body.length + params.header.length === 0 && <p className="text-sm text-muted-foreground">This template has no variables. Nothing to fill in.</p>}
          {params.header.map((p, i) => <ParamRow key={`h${i}`} label={`Header value ${i + 1}`} p={p} err={triedNext ? problems.header[i] : null} onChange={(v) => setParams((s) => ({ ...s, header: s.header.map((x, j) => (j === i ? v : x)) }))} />)}
          {params.body.map((p, i) => <ParamRow key={`b${i}`} label={`{{${i + 1}}} in the message`} p={p} err={triedNext ? problems.body[i] : null} onChange={(v) => setParams((s) => ({ ...s, body: s.body.map((x, j) => (j === i ? v : x)) }))} />)}
          <div>
            <h2 className="mb-1 text-sm font-bold">Preview</h2>
            <WaCard header={tpl.header_format} headerText={tpl.header_text} headerImageUrl={tpl.has_header_sample && tpl.header_format === 'IMAGE' ? `/api/templates/${tpl.id}/media` : null} body={tpl.body} footer={tpl.footer}
              samples={params.body.map(specSample)} headerSamples={params.header.map(specSample)} />
            <p className="mt-1 text-xs text-muted-foreground">Fields show their fallback here. Real values are filled in per person.</p>
          </div>
          <Samples preview={preview} tpl={tpl} params={params} loading={previewing} />
        </section>
      )}

      {step === 3 && tpl && preview && (
        <section className="space-y-4" data-testid="step-review">
          <dl className="space-y-2 rounded-lg border bg-surface p-3 text-sm">
            <Row k="Name" v={name.trim()} />
            <Row k="Template" v={`${tpl.name} · ${tpl.language} · ${tpl.category === 'MARKETING' ? 'Marketing' : 'Utility'}`} />
            <Row k="Audience" v={filter.all ? 'Everyone' : [filter.tags.length ? `${filter.tags.length} tag${filter.tags.length === 1 ? '' : 's'} (${filter.tag_mode === 'all' ? 'all' : 'any'})` : '', filter.stage ? `stage ${stages.find((s) => s.key === filter.stage)?.label ?? filter.stage}` : ''].filter(Boolean).join(', ')} />
            <Row k="Will receive" v={`${total.toLocaleString('en')} ${total === 1 ? 'person' : 'people'}`} strong />
            {preview.excluded_total > 0 && <Row k="Skipped" v={excludedLine(preview.excluded)} />}
            <Row k="Pace" v={paceLabel(total, pace)} />
          </dl>
          {warn && <p role="alert" className="rounded-md bg-amber-500/10 p-2 text-sm text-amber-800 dark:text-amber-200" data-testid="tier-warning">{warn}</p>}
          {tpl.category === 'MARKETING' && !hasOptOutHint(tpl) && <p role="note" className="rounded-md bg-amber-500/10 p-2 text-sm text-amber-800 dark:text-amber-200">Add &quot;Reply STOP to opt out&quot; to the footer.</p>}
          {filter.all && (
            <div className="rounded-lg border border-danger/40 p-3" data-testid="all-confirm">
              <Label htmlFor="bc-confirm">This sends to every contact. Type {total.toLocaleString('en')} to confirm.</Label>
              <Input id="bc-confirm" inputMode="numeric" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} data-testid="bc-confirm" />
            </div>
          )}
          {changed && <p role="alert" className="rounded-md bg-amber-500/10 p-2 text-sm text-amber-800 dark:text-amber-200" data-testid="audience-changed">{changed}</p>}
        </section>
      )}

      {issue && <p role="alert" className="mt-3 text-sm text-danger" data-testid="step-issue">{issue}</p>}
      {err && <p role="alert" className="mt-3 text-sm text-danger" data-testid="wizard-error">{err}</p>}
      <div className="mt-5 flex flex-wrap justify-between gap-2">
        <Button variant="secondary" disabled={step === 0 || !!busy} onClick={() => { setStep((s) => Math.max(0, s - 1)); setErr(''); setTriedNext(false) }}>Back</Button>
        <div className="flex gap-2">
          {step === 3 && <Button variant="secondary" loading={busy === 'save'} disabled={busy === 'start'} onClick={() => void saveDraft()} data-testid="save-draft">Save draft</Button>}
          {step < 3
            ? <Button onClick={() => void next()} loading={busy === 'save'} data-testid="next">Next</Button>
            : <Button onClick={() => void start()} loading={busy === 'start'} disabled={!preview || empty || tooBig || !confirmOk || busy === 'save'} data-testid="start">Start broadcast</Button>}
        </div>
      </div>
    </div>
  )
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return <div className="flex gap-3"><dt className="w-24 shrink-0 text-muted-foreground">{k}</dt><dd className={cn('min-w-0 [overflow-wrap:anywhere]', strong && 'font-bold')}>{v || 'None'}</dd></div>
}

function Counts({ preview, loading, error, idle }: { preview: Preview | null; loading: boolean; error: string; idle: boolean }) {
  if (idle) return <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground" data-testid="counts-idle">Pick a tag or a stage, or choose everyone, to see who it reaches.</p>
  if (error) return <p role="alert" className="rounded-lg border border-danger/40 p-3 text-sm text-danger" data-testid="counts-error">{error}</p>
  if (!preview) return <div aria-busy="true" aria-label="Counting audience"><Skeleton className="h-20" /></div>
  return (
    <div className={cn('rounded-lg border bg-surface p-3', loading && 'opacity-60')} aria-live="polite" data-testid="counts">
      <p className="text-2xl font-bold" data-testid="counts-total">{preview.total.toLocaleString('en')} <span className="text-base font-normal text-muted-foreground">{preview.total === 1 ? 'person will receive it' : 'people will receive it'}</span></p>
      {preview.excluded_total > 0 && <p className="mt-1 text-sm text-muted-foreground" data-testid="counts-excluded">{preview.excluded_total.toLocaleString('en')} left out: {excludedLine(preview.excluded)}</p>}
      {preview.total === 0 && <p className="mt-1 text-sm text-danger">Nobody here can be messaged.</p>}
      {audienceTooLarge(preview.total) && <p className="mt-1 text-sm text-danger">Too many for one broadcast (50,000 at most). Narrow the audience.</p>}
    </div>
  )
}

function ParamRow({ label, p, err, onChange }: { label: string; p: ParamSpec; err: string | null; onChange: (p: ParamSpec) => void }) {
  return (
    <div className="space-y-2 rounded-lg border bg-surface p-3" data-testid="param-row">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-bold">{label}</span>
        <div className="inline-flex rounded-md border" role="group" aria-label="Value source">
          {(['fixed', 'field'] as const).map((k) => (
            <button key={k} type="button" aria-pressed={p.kind === k} onClick={() => onChange(setKind(p, k))} className={cn('min-h-[36px] px-3 text-sm', p.kind === k ? 'bg-accent/10 font-semibold text-accent' : 'bg-surface')}>{k === 'fixed' ? 'Same text' : 'From the lead'}</button>
          ))}
        </div>
      </div>
      {p.kind === 'fixed'
        ? <Input aria-label={`${label} text`} value={p.value} maxLength={1024} onChange={(e) => onChange({ kind: 'fixed', value: e.target.value })} placeholder="Text for everyone" />
        : (
          <div className="grid gap-2 sm:grid-cols-2">
            <div><Label>Field</Label><Select aria-label={`${label} field`} value={p.field} onChange={(e) => onChange({ ...p, field: e.target.value as FieldName })}>{FIELDS.map((f) => <option key={f} value={f}>{FIELD_LABEL[f]}</option>)}</Select></div>
            <div><Label>If empty, use</Label><Input aria-label={`${label} fallback`} value={p.fallback} maxLength={1024} onChange={(e) => onChange({ ...p, fallback: e.target.value })} placeholder="there" /></div>
          </div>
        )}
      {err && <p role="alert" className="text-sm text-danger">{err}</p>}
    </div>
  )
}

function Samples({ preview, tpl, params, loading }: { preview: Preview | null; tpl: Tpl; params: ParamsSpec; loading: boolean }) {
  if (!preview) return loading ? <div aria-busy="true" aria-label="Loading samples"><Skeleton className="h-24" /></div> : null
  if (!preview.sample.length) return <p className="text-sm text-muted-foreground">No sample recipients to show.</p>
  return (
    <div data-testid="samples">
      <h2 className="mb-1 text-sm font-bold">Samples from your audience</h2>
      <ul className="space-y-2">
        {preview.sample.slice(0, 5).map((r) => {
          const v = sampleValues(r, params)
          return (
            <li key={r.contact_id} className="rounded-lg border bg-surface p-3 text-sm" data-testid="sample-row">
              <p className="mb-1 truncate text-xs text-muted-foreground">{r.name || r.phone || 'Unnamed contact'}</p>
              <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{renderBody(tpl.body, v.body)}</p>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
