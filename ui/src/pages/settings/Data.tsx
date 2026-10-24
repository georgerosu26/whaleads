import { Download, FileUp } from 'lucide-react'
import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, FormMsg, LoadGate, SettingsPage } from '@/components/SettingsPage'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { api, ApiError } from '@/lib/api'
import { parseCsv } from '../../../../src/csv'
import { useLoad } from '@/lib/useLoad'
import { cn } from '@/lib/utils'

const FIELD_LABEL: Record<string, string> = {
  phone: 'Phone (required)', name: 'Name', email: 'Email', source: 'Source', stage: 'Stage', tags: 'Tags', notes: 'Notes',
  owner_email: 'Owner email', message: 'What they want', created_at: 'Created at', next_action_at: 'Next action at', lost_reason: 'Lost reason', external_id: 'Your own id for the row',
}
const FIELDS = Object.keys(FIELD_LABEL)
type Mapping = Record<string, number | undefined>
interface Inspect { headers: string[]; sample: string[][]; row_count: number; mapping: Mapping }
interface Counts { rows: number; to_create: number; new_contacts: number; existing_contacts: number; duplicates: number; duplicates_open_lead: number; duplicates_in_file: number; duplicates_imported: number; errors: number; new_tags: number; warnings: number }
interface Preview { counts: Counts; preview: { row: number; action: string; phone: string; name: string; source: string; stage: string; tags: string[]; warnings: string[] }[]; errors: { row: number; message: string; phone?: string }[]; errors_truncated: boolean; new_tags: string[]; result?: { contacts_created: number; leads_created: number; duplicates: number; errors: number; tags_created: number; batches: number } }
interface Totals { rows: number; leads_created: number; contacts_created: number; duplicates: number; errors: number; tags_created: number }
const CHUNK = 100
interface LogEvent { id: number; kind: string; at: number; format?: string; file?: string; rows?: number; leads_created?: number }
interface LogData { events: LogEvent[]; limits: { max_rows: number; max_bytes: number } }

const ACTION: Record<string, string> = { create_lead: 'New lead', duplicate_open_lead: 'Skipped: has an open lead', duplicate_in_file: 'Skipped: repeated in file', already_imported: 'Skipped: already imported' }
type Step = 'upload' | 'map' | 'preview' | 'done'

function Wizard({ limits, onDone }: { limits: LogData['limits']; onDone: () => void }) {
  const [step, setStep] = useState<Step>('upload')
  const [file, setFile] = useState<File | null>(null)
  const [insp, setInsp] = useState<Inspect | null>(null)
  const [map, setMap] = useState<Mapping>({})
  const [prev, setPrev] = useState<Preview | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [totals, setTotals] = useState<Totals | null>(null)
  const [skipped, setSkipped] = useState<{ row: number; message: string }[]>([])
  const [err, setErr] = useState('')
  const input = useRef<HTMLInputElement>(null)

  const send = (mode: string, f: File, m?: Mapping) => {
    const fd = new FormData()
    fd.set('file', f); fd.set('mode', mode)
    if (m) fd.set('mapping', JSON.stringify(Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined))))
    return api<any>('/api/import/leads', { method: 'POST', body: fd })
  }
  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(''); try { await fn() } catch (e) { setErr((e as Error).message) } finally { setBusy(false) } }
  const reset = () => { setStep('upload'); setFile(null); setInsp(null); setMap({}); setPrev(null); setTotals(null); setSkipped([]); setProgress(null); setErr(''); if (input.current) input.current.value = '' }

  const pick = (f: File | undefined) => run(async () => {
    if (!f) return
    setFile(f)
    const r: Inspect = await send('inspect', f)
    setInsp(r); setMap(r.mapping); setStep('map')
  })
  const doPreview = () => run(async () => { setPrev(await send('preview', file!, map)); setStep('preview') })
  // The browser splits the file and sends 100 rows at a time. Every row has a stable key on the server, so a chunk that
  // is sent twice (a retry after a dropped connection) writes nothing the second time.
  const doCommit = () => run(async () => {
    const data = parseCsv(await file!.text(), undefined, limits.max_rows + 2).slice(1)
    const mapping = Object.fromEntries(Object.entries(map).filter(([, v]) => v !== undefined))
    const importId = crypto.randomUUID()
    const sum: Totals = { rows: 0, leads_created: 0, contacts_created: 0, duplicates: 0, errors: 0, tags_created: 0 }
    const problems: { row: number; message: string }[] = []
    setProgress({ done: 0, total: data.length })
    try {
      for (let i = 0, c = 0; i < data.length; i += CHUNK, c++) {
        const last = i + CHUNK >= data.length
        const body = { import_id: importId, chunk: c, file: file!.name, mapping, rows: data.slice(i, i + CHUNK), ...(last ? { last: true, totals: sum } : {}) }
        let r: any
        for (let attempt = 0; ; attempt++) {
          try { r = await api<any>('/api/import/leads/commit', { method: 'POST', body }); break } catch (e) {
            if (!(e instanceof ApiError && e.status === 0) || attempt >= 2) throw e
            await new Promise((ok) => setTimeout(ok, 800 * (attempt + 1)))
          }
        }
        sum.rows += body.rows.length
        for (const k of ['leads_created', 'contacts_created', 'duplicates', 'errors', 'tags_created'] as const) sum[k] += r.result[k]
        if (problems.length < 50) problems.push(...r.errors.slice(0, 50 - problems.length))
        setProgress({ done: Math.min(i + CHUNK, data.length), total: data.length })
      }
    } catch (e) {
      // keep what was saved so far visible: the file can be uploaded again and finishes the rest
      setTotals(sum)
      throw new Error(`${(e as Error).message} ${sum.leads_created.toLocaleString()} leads were saved before it stopped. Upload the same file again to finish: rows already imported are skipped.`)
    }
    setTotals(sum); setSkipped(problems); setStep('done'); onDone()
  })

  const steps: [Step, string][] = [['upload', 'Upload'], ['map', 'Match columns'], ['preview', 'Preview'], ['done', 'Done']]
  return (
    <div>
      <ol className="mb-4 flex gap-1 text-xs font-semibold" aria-label="Import steps">
        {steps.map(([k, l], i) => <li key={k} aria-current={step === k ? 'step' : undefined} className={cn('flex-1 truncate rounded-md px-2 py-1.5 text-center', step === k ? 'bg-accent text-accent-foreground' : 'bg-muted text-muted-foreground')}>{i + 1}. {l}</li>)}
      </ol>

      {step === 'upload' && (
        <div>
          <p className="mb-3 text-sm text-muted-foreground">A CSV with a header row and a phone column. Up to {limits.max_rows.toLocaleString()} rows and {limits.max_bytes / 1024 / 1024} MB. Numbers without a country code use your default country. Phones already on an open lead are skipped.</p>
          <label className="flex min-h-[96px] cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-4 py-6 text-center text-sm font-semibold hover:bg-muted focus-within:outline focus-within:outline-2 focus-within:outline-accent">
            <FileUp aria-hidden className="h-5 w-5 text-muted-foreground" />
            <span>{busy ? 'Reading the file' : 'Choose a CSV file'}</span>
            <input ref={input} type="file" accept=".csv,text/csv" className="sr-only" aria-label="CSV file" disabled={busy} onChange={(e) => void pick(e.target.files?.[0])} />
          </label>
        </div>
      )}

      {step === 'map' && insp && (
        <div>
          <p className="mb-3 text-sm text-muted-foreground"><span className="break-all font-semibold text-foreground">{file?.name}</span>: {insp.row_count.toLocaleString()} rows. Check which column feeds each field.</p>
          <div className="mb-3 space-y-2">
            {FIELDS.map((f) => (
              <label key={f} className="grid grid-cols-[8.5rem_1fr] items-center gap-2 text-sm font-semibold">
                <span>{FIELD_LABEL[f]}</span>
                <Select value={map[f] === undefined ? '' : String(map[f])} onChange={(e) => setMap({ ...map, [f]: e.target.value === '' ? undefined : Number(e.target.value) })}>
                  <option value="">Not in this file</option>
                  {insp.headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                </Select>
              </label>
            ))}
          </div>
          {insp.sample.length > 0 && (
            <div className="mb-3 overflow-x-auto rounded-md border">
              <table className="w-full min-w-max text-xs">
                <thead><tr className="border-b bg-muted text-left">{insp.headers.map((h, i) => <th key={i} className="px-2 py-1.5 font-semibold">{h}</th>)}</tr></thead>
                <tbody>{insp.sample.map((r, ri) => <tr key={ri} className="border-b last:border-0">{insp.headers.map((_, ci) => <td key={ci} className="max-w-[10rem] truncate px-2 py-1.5">{r[ci] ?? ''}</td>)}</tr>)}</tbody>
              </table>
            </div>
          )}
          <FormMsg error={err} />
          <div className="mt-2 flex gap-2"><Button loading={busy} disabled={map.phone === undefined} onClick={() => void doPreview()}>Preview import</Button><Button variant="secondary" onClick={reset}>Start over</Button></div>
        </div>
      )}

      {step === 'preview' && prev && (
        <div>
          <p className="mb-3 text-sm">Nothing is saved yet. <span className="font-semibold">{prev.counts.to_create.toLocaleString()}</span> new leads will be created ({prev.counts.new_contacts.toLocaleString()} new contacts).</p>
          <dl className="mb-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            {([['Rows', prev.counts.rows], ['Duplicates', prev.counts.duplicates], ['Errors', prev.counts.errors], ['New tags', prev.counts.new_tags]] as const).map(([k, v]) => (
              <div key={k} className="rounded-md border p-2"><dt className="text-xs text-muted-foreground">{k}</dt><dd className="text-lg font-bold">{v.toLocaleString()}</dd></div>
            ))}
          </dl>
          {prev.counts.duplicates > 0 && <p className="mb-2 text-xs text-muted-foreground">{prev.counts.duplicates_imported} were imported before, {prev.counts.duplicates_open_lead} already have an open lead, {prev.counts.duplicates_in_file} repeat a row from earlier in the file. They are skipped.</p>}
          {prev.errors.length > 0 && (
            <div className="mb-3 rounded-md border border-danger/40 p-3">
              <h3 className="mb-1 text-sm font-semibold text-danger">Rows with problems ({prev.counts.errors}) will be skipped</h3>
              <ul className="max-h-40 space-y-1 overflow-y-auto text-xs">{prev.errors.map((e) => <li key={e.row} className="break-words">Row {e.row}: {e.message}{e.phone ? ` (${e.phone})` : ''}</li>)}</ul>
              {prev.errors_truncated && <p className="mt-1 text-xs text-muted-foreground">Showing the first {prev.errors.length}.</p>}
            </div>
          )}
          {prev.preview.length > 0 && (
            <div className="mb-3 overflow-x-auto rounded-md border">
              <table className="w-full min-w-max text-xs">
                <thead><tr className="border-b bg-muted text-left"><th className="px-2 py-1.5">Row</th><th className="px-2 py-1.5">Phone</th><th className="px-2 py-1.5">Name</th><th className="px-2 py-1.5">Stage</th><th className="px-2 py-1.5">Result</th></tr></thead>
                <tbody>{prev.preview.map((r) => (
                  <tr key={r.row} className="border-b last:border-0 align-top">
                    <td className="px-2 py-1.5">{r.row}</td><td className="px-2 py-1.5">{r.phone}</td><td className="max-w-[10rem] truncate px-2 py-1.5">{r.name}</td><td className="px-2 py-1.5">{r.stage}</td>
                    <td className="px-2 py-1.5"><span className={r.action === 'create_lead' ? 'font-semibold' : 'text-muted-foreground'}>{ACTION[r.action] ?? r.action}</span>{r.warnings.length > 0 && <span className="block text-muted-foreground">{r.warnings.join('; ')}</span>}</td>
                  </tr>))}</tbody>
              </table>
            </div>
          )}
          <p className="mb-2 text-xs text-muted-foreground">Showing the first {prev.preview.length} rows.</p>
          {progress && busy && (
            <div className="mb-3" role="progressbar" aria-label="Import progress" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
              <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-accent transition-[width]" style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }} /></div>
              <p className="mt-1 text-xs text-muted-foreground">Saving {progress.done.toLocaleString()} of {progress.total.toLocaleString()} rows. Keep this page open.</p>
            </div>
          )}
          <FormMsg error={err} />
          <div className="mt-2 flex gap-2">
            <Button loading={busy} disabled={prev.counts.to_create === 0} onClick={() => void doCommit()}>Import {prev.counts.to_create.toLocaleString()} leads</Button>
            <Button variant="secondary" disabled={busy} onClick={() => setStep('map')}>Back</Button>
          </div>
        </div>
      )}

      {step === 'done' && totals && (
        <div role="status">
          <p className="mb-1 text-base font-semibold">Imported {totals.leads_created.toLocaleString()} leads</p>
          <p className="mb-3 text-sm text-muted-foreground">{totals.contacts_created.toLocaleString()} new contacts, {totals.duplicates.toLocaleString()} skipped as duplicates, {totals.errors.toLocaleString()} rows with errors, {totals.tags_created} new tags.</p>
          <div className="flex gap-2"><Link to="/leads"><Button>See leads</Button></Link><Button variant="secondary" onClick={reset}>Import another file</Button></div>
        </div>
      )}
    </div>
  )
}

export default function Data() {
  const { state, reload } = useLoad<LogData>('/api/export/log')
  return (
    <SettingsPage title="Data" subtitle="Export your leads, or bring leads in from a spreadsheet">
      <Card title="Export">
        <p className="mb-3 text-sm text-muted-foreground">The leads CSV opens in Excel or Sheets. The full export is a JSON backup of leads, contacts, messages, staff and settings. Passwords, keys and tokens are never included.</p>
        <div className="flex flex-wrap gap-2">
          <a href="/api/export/leads.csv" download onClick={() => setTimeout(() => void reload(), 1500)}><Button type="button" variant="secondary" tabIndex={-1}><Download aria-hidden className="h-4 w-4" />Leads CSV</Button></a>
          <a href="/api/export/full.json" download onClick={() => setTimeout(() => void reload(), 1500)}><Button type="button" variant="secondary" tabIndex={-1}><Download aria-hidden className="h-4 w-4" />Full export (JSON)</Button></a>
        </div>
      </Card>
      <LoadGate load={state} retry={() => void reload()} rows={2}>
        {(d) => (
          <>
            <Card title="Import leads"><Wizard limits={d.limits} onDone={() => void reload()} /></Card>
            <Card title="Recent activity">
              {d.events.length === 0 ? <p className="text-sm text-muted-foreground">No exports or imports yet.</p> : (
                <ul className="divide-y text-sm">
                  {d.events.map((e) => (
                    <li key={e.id} className="flex items-baseline justify-between gap-3 py-2">
                      <span className="min-w-0 truncate">{e.kind === 'import' ? `Imported ${e.leads_created ?? 0} leads from ${e.file ?? 'a file'}` : `Exported ${e.format === 'full_json' ? 'full JSON' : 'leads CSV'}`}</span>
                      <time className="shrink-0 text-xs text-muted-foreground" dateTime={new Date(e.at * 1000).toISOString()}>{new Date(e.at * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</time>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </>
        )}
      </LoadGate>
    </SettingsPage>
  )
}
