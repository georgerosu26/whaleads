// Per-type forms. The form holds strings the inputs can hold; formToData (inspector-map.ts) turns it into the exact
// `data` the engine reads. Every change is pushed up as soon as it is made (the editor autosaves).
import { AlertTriangle, Info, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ErrorState } from '@/components/ErrorState'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import type { Meta } from '@/lib/crm'
import type { FlowNode } from '@/lib/flows'
import type { TplList } from '@/lib/templates'
import { useLoad } from '@/lib/useLoad'
import { Area, Chips, F, RowList, VarArea, VarInput } from './Fields'
import { NODE_META } from './flow-types'
import {
  ACTIONS, HTTP_METHODS, OPERATORS, TRIGGER_LABEL, UNITS, VAR_OPS, dataToForm, formToData, headerIssue, httpUrlIssue, regexIssue, unknownTokens,
  type ActionForm, type AiForm, type ConditionForm, type DelayForm, type Form, type HttpForm, type MessageForm, type TemplateForm, type TriggerForm, type VariableForm, type WaitForm, type WritebackForm,
} from './inspector-map'

export interface InspectorProps {
  node: FlowNode
  readOnly: boolean
  flowReentry?: string
  errors: string[]
  warnings: string[]
  onData: (data: Record<string, unknown>, key: string) => void
  onLabel: (label: string) => void
  onDelete: () => void
  meta: Meta | null
  /** null while unknown (non-admin) */
  aiConfigured: boolean | null
  /** Names a later node can read: variables set earlier plus `node_id.field`s. */
  upstream: string[]
  /** Roots a `{{token}}` may start with. */
  knownRoots: Set<string>
}

type Patch<T> = (p: Partial<T>) => void

export function NodeInspector(p: InspectorProps) {
  const { node, readOnly } = p
  const [form, setForm] = useState<Form>(() => dataToForm(node.type, node.data, p.flowReentry))
  const last = useRef(JSON.stringify(node.data))
  const owner = useRef(node.id)
  useEffect(() => {
    // The node changed under us (another node picked, or undo/redo): reload the form. Our own edits come back equal and are skipped.
    if (owner.current !== node.id || JSON.stringify(node.data) !== last.current) {
      owner.current = node.id; last.current = JSON.stringify(node.data); setForm(dataToForm(node.type, node.data, p.flowReentry))
    }
  }, [node.id, node.type, node.data])
  const set = <T extends Form>(patch: Partial<T>) => {
    const next = { ...form, ...patch } as Form
    setForm(next)
    const data = formToData(node.type, next)
    last.current = JSON.stringify(data)
    p.onData(data, `data:${node.id}:${Object.keys(patch)[0]}`)
  }
  const meta = NODE_META[node.type]
  return (
    <div data-testid="inspector" data-node-type={node.type} className="space-y-4">
      <div>
        <div className="flex items-center gap-2"><Badge tone={meta.tone}>{meta.label}</Badge><span className="truncate font-mono text-xs text-muted-foreground">{node.id}</span></div>
        <p className="mt-1 text-xs text-muted-foreground">{meta.hint}</p>
      </div>
      {p.errors.length > 0 && <Issues tone="error" items={p.errors} />}
      {p.warnings.length > 0 && <Issues tone="warn" items={p.warnings} />}
      <F id="node-label" label="Name on the card">
        <Input id="node-label" value={node.label} maxLength={60} disabled={readOnly} onChange={(e) => p.onLabel(e.target.value)} />
      </F>
      <fieldset disabled={readOnly} className="space-y-4 disabled:opacity-90">
        {node.type === 'trigger' && <TriggerFields f={form as TriggerForm} set={set} meta={p.meta} />}
        {node.type === 'message' && <MessageFields f={form as MessageForm} set={set} upstream={p.upstream} known={p.knownRoots} readOnly={readOnly} />}
        {node.type === 'template' && <TemplateFields f={form as TemplateForm} set={set} upstream={p.upstream} readOnly={readOnly} />}
        {node.type === 'condition' && <ConditionFields f={form as ConditionForm} set={set} upstream={p.upstream} readOnly={readOnly} />}
        {node.type === 'action' && <ActionFields f={form as ActionForm} set={set} meta={p.meta} upstream={p.upstream} readOnly={readOnly} />}
        {node.type === 'delay' && <DelayFields f={form as DelayForm} set={set} />}
        {node.type === 'wait_event' && <WaitFields f={form as WaitForm} set={set} />}
        {node.type === 'variable' && <VariableFields f={form as VariableForm} set={set} upstream={p.upstream} readOnly={readOnly} />}
        {node.type === 'lead_writeback' && <WritebackFields f={form as WritebackForm} set={set} meta={p.meta} readOnly={readOnly} />}
        {node.type === 'ai' && <AiFields f={form as AiForm} set={set} upstream={p.upstream} configured={p.aiConfigured} readOnly={readOnly} />}
        {node.type === 'http_request' && <HttpFields f={form as HttpForm} set={set} upstream={p.upstream} readOnly={readOnly} />}
      </fieldset>
      {!readOnly && node.type !== 'trigger' && <Button variant="secondary" className="w-full text-danger" onClick={p.onDelete}><Trash2 aria-hidden className="h-4 w-4" />Delete this step</Button>}
    </div>
  )
}

function Issues({ tone, items }: { tone: 'error' | 'warn'; items: string[] }) {
  return (
    <ul role={tone === 'error' ? 'alert' : 'status'} data-testid={`issues-${tone}`} className={`space-y-1 rounded-md border p-2 text-xs ${tone === 'error' ? 'border-danger/40 bg-danger/10 text-danger' : 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200'}`}>
      {items.map((m, i) => <li key={i} className="flex gap-1.5"><AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span className="min-w-0 break-words">{m}</span></li>)}
    </ul>
  )
}
const Note = ({ children }: { children: React.ReactNode }) => <p className="flex gap-1.5 rounded-md bg-muted p-2 text-xs text-muted-foreground"><Info aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span className="min-w-0">{children}</span></p>
const unitOptions = UNITS.map((u) => <option key={u} value={u}>{u}</option>)

// ---- trigger ----------------------------------------------------------------------------------------------------

function TriggerFields({ f, set, meta }: { f: TriggerForm; set: Patch<TriggerForm>; meta: Meta | null }) {
  const stages = (meta?.stages ?? []).filter((s) => !s.archived).map((s) => ({ value: s.key, label: s.label }))
  const sources = (meta?.sources ?? []).filter((s) => !s.archived).map((s) => ({ value: s.key, label: s.label }))
  const kws = f.keywords.split(/[\n,]/).map((x) => x.trim()).filter(Boolean)
  const rx = f.match === 'regex' ? regexIssue(f.regexPattern) : null
  return (
    <>
      <F id="t-kind" label="Starts when">
        <Select id="t-kind" value={f.kind} onChange={(e) => set({ kind: e.target.value })}>
          <option value="">Choose...</option>
          {Object.entries(TRIGGER_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </Select>
      </F>
      <F id="t-reentry" label="Can the same lead start it again?" hint={f.reentry === 'once' ? 'A lead goes through this flow once.' : 'Every matching event starts a new run.'}>
        <Select id="t-reentry" value={f.reentry} onChange={(e) => set({ reentry: e.target.value as 'once' | 'each_event' })}>
          <option value="once">No, once per lead</option><option value="each_event">Yes, every time</option>
        </Select>
      </F>
      {f.kind === 'lead_created' && (
        <>
          <F id="t-src" label="Only these sources" hint="Leave empty for all sources."><Chips label="Sources" options={sources} value={f.sources} onChange={(v) => set({ sources: v })} /></F>
        </>
      )}
      {f.kind === 'stage_changed' && (
        <>
          <F id="t-from" label="Moves from" hint="Leave empty for any stage."><Chips label="From stages" options={stages} value={f.from} onChange={(v) => set({ from: v })} /></F>
          <F id="t-to" label="Moves to" hint="Leave empty for any stage."><Chips label="To stages" options={stages} value={f.to} onChange={(v) => set({ to: v })} /></F>
        </>
      )}
      {f.kind === 'message_received' && (
        <>
          <F id="t-match" label="Message text">
            <Select id="t-match" value={f.match} onChange={(e) => set({ match: e.target.value as TriggerForm['match'] })}>
              <option value="any">Any message</option><option value="keyword">Contains a keyword</option><option value="regex">Matches a pattern</option>
            </Select>
          </F>
          {f.match === 'keyword' && (
            <F id="t-kw" label="Keywords" hint={kws.length ? `${kws.length} keyword${kws.length === 1 ? '' : 's'}. Case does not matter; one per line or comma separated.` : undefined} error={kws.length ? null : 'Add at least one keyword.'}>
              <Area id="t-kw" rows={3} value={f.keywords} placeholder={'hi\nprice'} onChange={(e) => set({ keywords: e.target.value })} />
            </F>
          )}
          {f.match === 'regex' && (
            <F id="t-rx" label="Pattern" error={rx} hint={rx ? undefined : 'Accepted. Patterns are checked for runaway matching.'}>
              <Input id="t-rx" className="font-mono" value={f.regexPattern} placeholder="^(hi|hello)" onChange={(e) => set({ regexPattern: e.target.value })} />
            </F>
          )}
        </>
      )}
    </>
  )
}

// ---- message / template -----------------------------------------------------------------------------------------

function MessageFields({ f, set, upstream, known, readOnly }: { f: MessageForm; set: Patch<MessageForm>; upstream: string[]; known: Set<string>; readOnly: boolean }) {
  const unknown = unknownTokens(f.text, known)
  return (
    <>
      <F id="m-text" label="Message" error={unknown.length ? `Not a known variable: ${unknown.map((u) => `{{${u}}}`).join(', ')}` : null} hint={`${f.text.length} / 4096`}>
        <VarArea id="m-text" value={f.text} onChange={(v) => set({ text: v })} extra={upstream} rows={5} disabled={readOnly} placeholder="Hi {{lead.name}}, thanks for writing in." />
      </F>
      <Note>Free text only goes out inside the 24 hour window. If the window is closed the flow leaves by the <b>Window closed</b> port: connect it to a template step.</Note>
    </>
  )
}

function TemplateFields({ f, set, upstream, readOnly }: { f: TemplateForm; set: Patch<TemplateForm>; upstream: string[]; readOnly: boolean }) {
  const { state, reload } = useLoad<TplList>('/api/templates')
  if (state.status === 'loading') return <div aria-busy="true" aria-label="Loading templates" className="space-y-2"><Skeleton className="h-10" /><Skeleton className="h-16" /></div>
  if (state.status === 'error') return <ErrorState message={state.message} onRetry={() => void reload()} />
  const usable = state.data.templates.filter((t) => t.status === 'APPROVED' && t.sendable)
  const cur = state.data.templates.find((t) => t.id === f.templateId)
  const pick = (id: string) => {
    const t = usable.find((x) => x.id === id)
    if (!t) { set({ templateId: '', templateName: '', bodyParams: [], headerParams: [] }); return }
    const fit = (a: string[], n: number) => Array.from({ length: n }, (_, i) => a[i] ?? '')
    set({ templateId: t.id, templateName: t.name, bodyParams: fit(f.bodyParams, t.body_params_count), headerParams: fit(f.headerParams, t.header_params_count) })
  }
  const stale = f.templateId && (!cur || !usable.some((t) => t.id === cur.id))
  return (
    <>
      <F id="tp-pick" label="Template" hint={usable.length ? undefined : 'No approved template yet. Create or sync one under Settings, Templates.'} error={stale ? `${f.templateName || 'This template'} is ${cur ? 'not approved or sendable' : 'no longer in your list'}. Pick another.` : null}>
        <Select id="tp-pick" value={usable.some((t) => t.id === f.templateId) ? f.templateId : ''} disabled={readOnly} onChange={(e) => pick(e.target.value)}>
          <option value="">{f.templateName && stale ? `${f.templateName} (unavailable)` : 'Choose...'}</option>
          {usable.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.language})</option>)}
        </Select>
      </F>
      {cur && usable.some((t) => t.id === cur.id) && (
        <>
          <p className="whitespace-pre-wrap break-words rounded-md border bg-background p-2 text-xs">{cur.header_text ? `${cur.header_text}\n\n` : ''}{cur.body}</p>
          {cur.header_params_count > 0 && f.headerParams.map((v, i) => (
            <F key={`h${i}`} id={`tp-h${i}`} label={`Header value ${i + 1}`}><VarInput id={`tp-h${i}`} value={v} extra={upstream} disabled={readOnly} onChange={(x) => set({ headerParams: f.headerParams.map((y, j) => (j === i ? x : y)) })} /></F>
          ))}
          {f.bodyParams.map((v, i) => (
            <F key={`b${i}`} id={`tp-b${i}`} label={`Body value {{${i + 1}}}`} error={v.trim() ? null : 'A value is required.'}><VarInput id={`tp-b${i}`} value={v} extra={upstream} disabled={readOnly} onChange={(x) => set({ bodyParams: f.bodyParams.map((y, j) => (j === i ? x : y)) })} /></F>
          ))}
        </>
      )}
    </>
  )
}

// ---- condition / action / delay / wait / variable ---------------------------------------------------------------

function ConditionFields({ f, set, upstream, readOnly }: { f: ConditionForm; set: Patch<ConditionForm>; upstream: string[]; readOnly: boolean }) {
  const op = OPERATORS.find((o) => o.value === f.operator)
  return (
    <>
      <F id="c-left" label="Check this value" hint="Latest message text is user_response."><VarInput id="c-left" value={f.left} extra={upstream.map((u) => u)} disabled={readOnly} onChange={(v) => set({ left: v.replace(/[{}]/g, '') })} /></F>
      <F id="c-op" label="Condition"><Select id="c-op" value={f.operator} onChange={(e) => set({ operator: e.target.value })}>{OPERATORS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></F>
      {op?.needsValue !== false && <F id="c-val" label="Value" hint={f.operator === 'regex' ? undefined : 'Variables allowed.'} error={f.operator === 'regex' ? regexIssue(f.value) : null}><VarInput id="c-val" value={f.value} extra={upstream} disabled={readOnly} onChange={(v) => set({ value: v })} /></F>}
      <Note>Leaves by <b>Yes</b> when true, <b>No</b> otherwise.</Note>
    </>
  )
}

function ActionFields({ f, set, meta, upstream, readOnly }: { f: ActionForm; set: Patch<ActionForm>; meta: Meta | null; upstream: string[]; readOnly: boolean }) {
  return (
    <>
      <F id="a-type" label="What to do"><Select id="a-type" value={f.actionType} onChange={(e) => set({ actionType: e.target.value })}>{ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}</Select></F>
      {f.actionType === 'set_stage' && (
        <F id="a-stage" label="Stage" error={f.stage ? null : 'Choose a stage.'}>
          <Select id="a-stage" value={f.stage} onChange={(e) => set({ stage: e.target.value })}><option value="">Choose...</option>{(meta?.stages ?? []).filter((s) => !s.archived).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</Select>
        </F>
      )}
      {(f.actionType === 'add_tag' || f.actionType === 'remove_tag') && (
        <F id="a-tag" label="Tag" error={f.tag.trim() ? null : 'Enter a tag.'} hint="Pick an existing tag or type a new one.">
          <Input id="a-tag" list="a-tags" value={f.tag} onChange={(e) => set({ tag: e.target.value })} />
          <datalist id="a-tags">{(meta?.tags ?? []).map((t) => <option key={t.id} value={t.label} />)}</datalist>
        </F>
      )}
      {f.actionType === 'assign' && (
        <F id="a-owner" label="Teammate"><Select id="a-owner" value={f.staffId} onChange={(e) => set({ staffId: e.target.value })}><option value="">Unassign</option>{(meta?.owners ?? []).map((o) => <option key={o.id} value={String(o.id)}>{o.name}</option>)}</Select></F>
      )}
      {f.actionType === 'note' && <F id="a-note" label="Note" error={f.text.trim() ? null : 'Write the note.'}><VarArea id="a-note" value={f.text} extra={upstream} rows={3} disabled={readOnly} onChange={(v) => set({ text: v })} /></F>}
      {f.actionType === 'set_next_action' && (
        <div className="grid grid-cols-2 gap-2">
          <F id="a-dur" label="In"><Input id="a-dur" type="number" min={1} inputMode="numeric" value={f.duration} onChange={(e) => set({ duration: e.target.value })} /></F>
          <F id="a-unit" label="Unit"><Select id="a-unit" value={f.unit} onChange={(e) => set({ unit: e.target.value })}>{unitOptions}</Select></F>
        </div>
      )}
    </>
  )
}

const durationHint = 'Between 1 second and 30 days.'
function DelayFields({ f, set }: { f: DelayForm; set: Patch<DelayForm> }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <F id="d-dur" label="Wait" error={f.duration.trim() && Number(f.duration) > 0 ? null : 'Enter a number above 0.'}><Input id="d-dur" type="number" min={1} inputMode="numeric" value={f.duration} onChange={(e) => set({ duration: e.target.value })} /></F>
        <F id="d-unit" label="Unit"><Select id="d-unit" value={f.unit} onChange={(e) => set({ unit: e.target.value })}>{unitOptions}</Select></F>
      </div>
      <Note>{durationHint}</Note>
    </>
  )
}
function WaitFields({ f, set }: { f: WaitForm; set: Patch<WaitForm> }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <F id="w-dur" label="Give up after" error={f.timeout.trim() && Number(f.timeout) > 0 ? null : 'Enter a number above 0.'}><Input id="w-dur" type="number" min={1} inputMode="numeric" value={f.timeout} onChange={(e) => set({ timeout: e.target.value })} /></F>
        <F id="w-unit" label="Unit"><Select id="w-unit" value={f.timeoutUnit} onChange={(e) => set({ timeoutUnit: e.target.value })}>{unitOptions}</Select></F>
      </div>
      <Note>Leaves by <b>Replied</b> when the lead answers, and by <b>No reply</b> after this time. {durationHint}</Note>
    </>
  )
}
function VariableFields({ f, set, upstream, readOnly }: { f: VariableForm; set: Patch<VariableForm>; upstream: string[]; readOnly: boolean }) {
  return (
    <>
      <F id="v-name" label="Variable name" error={/^[A-Za-z_][\w]*$/.test(f.variableName.trim()) ? null : 'Letters, digits and _, starting with a letter.'} hint="Later steps read it as {{name}}."><Input id="v-name" value={f.variableName} onChange={(e) => set({ variableName: e.target.value })} /></F>
      <F id="v-op" label="Operation"><Select id="v-op" value={f.operation} onChange={(e) => set({ operation: e.target.value })}>{VAR_OPS.map((o) => <option key={o} value={o}>{o}</option>)}</Select></F>
      {f.operation !== 'clear' && <F id="v-val" label="Value"><VarInput id="v-val" value={f.value} extra={upstream} disabled={readOnly} onChange={(v) => set({ value: v })} /></F>}
    </>
  )
}

// ---- lead_writeback / ai / http_request -------------------------------------------------------------------------

function WritebackFields({ f, set, meta, readOnly }: { f: WritebackForm; set: Patch<WritebackForm>; meta: Meta | null; readOnly: boolean }) {
  const stages = (meta?.stages ?? []).filter((s) => !s.archived)
  return (
    <>
      <Note>Sets a verdict and score from fixed values or from rules over the run, and can move the lead. The rating is written to the lead timeline.</Note>
      <F id="w-verdict" label="Verdict" hint="Leave empty to let the rules decide."><Input id="w-verdict" value={f.verdict} onChange={(e) => set({ verdict: e.target.value })} /></F>
      <F id="w-score" label="Score" hint="Leave empty to use the signals below."><Input id="w-score" type="number" inputMode="numeric" value={f.score} onChange={(e) => set({ score: e.target.value })} /></F>
      <F id="w-stage" label="Move to stage" hint="Leave empty to use the matching rule's stage, or none."><Select id="w-stage" value={f.stage} onChange={(e) => set({ stage: e.target.value })}><option value="">Do not move</option>{stages.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</Select></F>
      <F id="w-sig" label="Signals" hint="Each signal adds its weight when its value is present and not empty.">
        <RowList disabled={readOnly} rows={f.signals} blank={{ path: '', weight: '1' }} addLabel="Add signal" onChange={(r) => set({ signals: r })}
          render={(r, up, i) => (<div className="grid grid-cols-[1fr_72px] gap-2"><Input aria-label={`Signal ${i + 1} path`} placeholder="vars.budget" value={r.path} onChange={(e) => up({ path: e.target.value })} /><Input aria-label={`Signal ${i + 1} weight`} type="number" value={r.weight} onChange={(e) => up({ weight: e.target.value })} /></div>)} />
      </F>
      <F id="w-thr" label="Thresholds" hint="The highest minimum the score reaches decides the verdict.">
        <RowList disabled={readOnly} rows={f.thresholds} blank={{ min: '0', verdict: '', stage: '' }} addLabel="Add threshold" onChange={(r) => set({ thresholds: r })}
          render={(r, up, i) => (
            <div className="space-y-2">
              <div className="grid grid-cols-[72px_1fr] gap-2"><Input aria-label={`Threshold ${i + 1} minimum`} type="number" value={r.min} onChange={(e) => up({ min: e.target.value })} /><Input aria-label={`Threshold ${i + 1} verdict`} placeholder="hot" value={r.verdict} onChange={(e) => up({ verdict: e.target.value })} /></div>
              <Select aria-label={`Threshold ${i + 1} stage`} value={r.stage} onChange={(e) => up({ stage: e.target.value })}><option value="">No stage change</option>{stages.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</Select>
            </div>)} />
      </F>
    </>
  )
}

function AiFields({ f, set, upstream, configured, readOnly }: { f: AiForm; set: Patch<AiForm>; upstream: string[]; configured: boolean | null; readOnly: boolean }) {
  return (
    <>
      {configured === false && <Note><b>AI is not configured.</b> Add an Anthropic key under Settings, AI. Until then this step takes its <b>On error</b> port.</Note>}
      <F id="ai-sys" label="Instructions" hint="Optional. Tell the model its role."><VarArea id="ai-sys" value={f.systemPrompt} extra={upstream} rows={3} disabled={readOnly} onChange={(v) => set({ systemPrompt: v })} /></F>
      <F id="ai-prompt" label="Prompt" error={f.prompt.trim() ? null : 'Write the prompt.'}><VarArea id="ai-prompt" value={f.prompt} extra={upstream} rows={4} disabled={readOnly} onChange={(v) => set({ prompt: v })} /></F>
      <F id="ai-out" label="Keep the answer in variable" hint="Optional. Later steps read {{name}}."><Input id="ai-out" value={f.outputVariable} onChange={(e) => set({ outputVariable: e.target.value })} /></F>
      <F id="ai-max" label="Max answer length (tokens)" hint="Default 300, at most 1024."><Input id="ai-max" type="number" min={1} max={1024} inputMode="numeric" value={f.maxTokens} onChange={(e) => set({ maxTokens: e.target.value })} /></F>
    </>
  )
}

function HttpFields({ f, set, upstream, readOnly }: { f: HttpForm; set: Patch<HttpForm>; upstream: string[]; readOnly: boolean }) {
  const urlIssue = httpUrlIssue(f.url)
  return (
    <>
      <div className="grid grid-cols-[104px_1fr] gap-2">
        <F id="h-method" label="Method"><Select id="h-method" value={f.method} onChange={(e) => set({ method: e.target.value })}>{HTTP_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}</Select></F>
        <F id="h-url" label="URL" error={urlIssue} hint="https only for public addresses. Variables allowed."><VarInput id="h-url" value={f.url} extra={upstream} disabled={readOnly} onChange={(v) => set({ url: v })} /></F>
      </div>
      <F id="h-headers" label="Headers" hint="Content-Type, Accept, User-Agent, Authorization and custom X- headers are sent.">
        <RowList disabled={readOnly} rows={f.headers} blank={{ name: '', value: '' }} addLabel="Add header" max={10} onChange={(r) => set({ headers: r })}
          render={(r, up, i) => (
            <div className="space-y-1">
              <div className="grid grid-cols-2 gap-2"><Input aria-label={`Header ${i + 1} name`} placeholder="X-Api-Key" value={r.name} onChange={(e) => up({ name: e.target.value })} /><Input aria-label={`Header ${i + 1} value`} value={r.value} onChange={(e) => up({ value: e.target.value })} /></div>
              {headerIssue(r.name) && <p role="alert" className="text-xs text-danger">{headerIssue(r.name)}</p>}
            </div>)} />
      </F>
      {f.method !== 'GET' && <F id="h-body" label="Body"><VarArea id="h-body" value={f.body} extra={upstream} rows={4} disabled={readOnly} onChange={(v) => set({ body: v })} /></F>}
      <F id="h-out" label="Keep the response in variable" hint="Optional. Later steps read {{name}}."><Input id="h-out" value={f.outputVariable} onChange={(e) => set({ outputVariable: e.target.value })} /></F>
      <Note>Leaves by <b>Success</b> on a 2xx answer and by <b>Error</b> otherwise. Private and internal addresses are always refused.</Note>
    </>
  )
}
