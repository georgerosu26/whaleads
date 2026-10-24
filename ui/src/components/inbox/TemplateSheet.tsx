import { ArrowLeft, FileText, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ErrorState } from '@/components/ErrorState'
import { WaCard } from '@/components/templates/WaCard'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { HEADER_LABEL, prefillParams, type HeaderChoice, type RecentFile, type TemplateJob, type Tpl, type TplList } from '@/lib/templates'
import { useLoad } from '@/lib/useLoad'
import { paramProblem, renderParams } from '../../../../src/templateRules'

const ACCEPT: Record<string, string> = { IMAGE: 'image/jpeg,image/png', VIDEO: 'video/mp4,video/3gpp', DOCUMENT: 'application/pdf' }

/** Approved-only picker, then the value form. Slides over the composer; Escape or the X closes it. */
export function TemplateSheet({ contactName, onClose, onSend }: { contactName: string | null; onClose: () => void; onSend: (job: TemplateJob) => boolean }) {
  const { state, reload } = useLoad<TplList>('/api/templates')
  const [q, setQ] = useState('')
  const [pick, setPick] = useState<Tpl | null>(null)
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k) }, [onClose])

  const approved = useMemo(() => (state.status === 'ready' ? state.data.templates.filter((t) => t.status === 'APPROVED' && t.sendable !== false) : []), [state])
  const shown = approved.filter((t) => !q.trim() || `${t.name} ${t.body}`.toLowerCase().includes(q.trim().toLowerCase()))

  return (
    <div role="dialog" aria-label="Send a template" className="fixed inset-0 z-40 flex flex-col bg-background sm:left-auto sm:w-[420px] sm:border-l">
      <header className="flex min-h-14 items-center gap-2 border-b bg-surface px-2">
        {pick
          ? <button type="button" aria-label="Back to templates" className="flex h-11 w-11 items-center justify-center rounded-md hover:bg-muted" onClick={() => setPick(null)}><ArrowLeft aria-hidden className="h-5 w-5" /></button>
          : <span className="w-2" />}
        <h2 className="min-w-0 flex-1 truncate text-base font-bold">{pick ? pick.name : 'Send a template'}</h2>
        <button type="button" aria-label="Close" className="flex h-11 w-11 items-center justify-center rounded-md hover:bg-muted" onClick={onClose}><X aria-hidden className="h-5 w-5" /></button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {pick ? <ParamForm tpl={pick} contactName={contactName} onSend={(j) => { if (onSend(j)) onClose() }} />
          : state.status === 'loading' ? <div aria-busy="true" aria-label="Loading templates" className="space-y-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16" />)}</div>
          : state.status === 'error' ? <ErrorState message={state.message} onRetry={() => void reload()} />
          : approved.length === 0 ? (
            <div className="flex flex-col items-center rounded-lg border border-dashed bg-surface px-6 py-10 text-center">
              <FileText aria-hidden className="mb-3 h-6 w-6 text-muted-foreground" />
              <h3 className="text-base font-semibold">No approved templates</h3>
              <p className="mt-1 text-sm text-muted-foreground">Create one in Settings, Templates. It can be sent once Meta approves it.</p>
            </div>
          ) : (
            <>
              <div className="relative mb-3">
                <Search aria-hidden className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                <Input aria-label="Search templates" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search templates" autoFocus />
              </div>
              {shown.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">No templates match &ldquo;{q}&rdquo;.</p> : (
                <ul className="divide-y rounded-lg border bg-surface" aria-label="Approved templates">
                  {shown.map((t) => (
                    <li key={t.id}>
                      <button type="button" className="block min-h-[56px] w-full px-4 py-3 text-left hover:bg-muted" onClick={() => setPick(t)}>
                        <span className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-sm font-bold">{t.name}</span><Badge>{t.language}</Badge></span>
                        <span className="mt-0.5 line-clamp-2 block break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">{t.body}</span>
                        {t.header_format !== 'NONE' && <span className="mt-1 block text-[11px] text-muted-foreground">{HEADER_LABEL[t.header_format]}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
      </div>
    </div>
  )
}

function ParamForm({ tpl, contactName, onSend }: { tpl: Tpl; contactName: string | null; onSend: (j: TemplateJob) => void }) {
  const media = tpl.header_format === 'IMAGE' || tpl.header_format === 'VIDEO' || tpl.header_format === 'DOCUMENT'
  const [bp, setBp] = useState(() => prefillParams(tpl.body_params_count, contactName))
  const [hp, setHp] = useState<string[]>(() => Array.from({ length: tpl.header_params_count }, () => ''))
  const [touched, setTouched] = useState(false)
  const [choice, setChoice] = useState<'default' | 'stored' | 'upload'>(tpl.has_header_sample ? 'default' : 'upload')
  const [storedId, setStoredId] = useState<number | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [recent, setRecent] = useState<RecentFile[] | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!media) return
    api<{ files: RecentFile[] }>(`/api/templates/recent-media?format=${tpl.header_format}`).then((r) => setRecent(r.files)).catch(() => setRecent([]))
  }, [media, tpl.header_format])

  const set = (list: string[], fn: (v: string[]) => void, i: number, v: string) => fn(list.map((x, j) => (j === i ? v : x)))
  const problems = [...bp, ...hp].map(paramProblem)
  const headerOk = !media || (choice === 'default' ? tpl.has_header_sample : choice === 'stored' ? storedId !== null : !!file)
  const valid = problems.every((p) => p === null) && headerOk
  const header: HeaderChoice | null = !media ? null : choice === 'default' ? { kind: 'default' } : choice === 'stored' ? { kind: 'stored', messageId: storedId! } : { kind: 'upload', file: file! }
  const rendered = [tpl.header_format === 'TEXT' && tpl.header_text ? renderParams(tpl.header_text, hp) : '', renderParams(tpl.body, bp)].filter(Boolean).join('\n')

  const fields = (label: string, list: string[], fn: (v: string[]) => void, offset: number) => list.map((v, i) => {
    const p = problems[offset + i]
    return (
      <label key={`${label}${i}`} className="block text-xs font-semibold">{label} {`{{${i + 1}}}`}
        <Input className="mt-1" aria-label={`${label} {{${i + 1}}}`} aria-invalid={touched && !!p} value={v} onChange={(e) => set(list, fn, i, e.target.value)} />
        {touched && p && <span role="alert" className="mt-1 block text-xs font-normal text-danger">{p}</span>}
      </label>
    )
  })

  return (
    <form className="space-y-4" noValidate onSubmit={(e) => { e.preventDefault(); setTouched(true); if (valid) onSend({ tpl, bodyParams: bp, headerParams: hp, header, rendered }) }}>
      {hp.length > 0 && <div className="space-y-2">{fields('Header', hp, setHp, bp.length)}</div>}
      {bp.length > 0 && <div className="space-y-2">{fields('Value', bp, setBp, 0)}</div>}
      {media && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold">{HEADER_LABEL[tpl.header_format]}</legend>
          {tpl.has_header_sample && <label className="flex min-h-[40px] items-center gap-2 text-sm"><input type="radio" name="hdr" checked={choice === 'default'} onChange={() => setChoice('default')} />Use the template&rsquo;s sample</label>}
          <label className="flex min-h-[40px] items-center gap-2 text-sm"><input type="radio" name="hdr" checked={choice === 'upload'} onChange={() => setChoice('upload')} />Upload a file</label>
          {choice === 'upload' && (
            <div className="pl-6">
              <input ref={fileRef} type="file" hidden accept={ACCEPT[tpl.header_format]} aria-label="Header file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              <Button type="button" variant="secondary" onClick={() => fileRef.current?.click()}>{file ? 'Change file' : 'Choose file'}</Button>
              {file && <span className="ml-2 break-all text-xs text-muted-foreground">{file.name}</span>}
            </div>
          )}
          <label className="flex min-h-[40px] items-center gap-2 text-sm"><input type="radio" name="hdr" checked={choice === 'stored'} onChange={() => setChoice('stored')} disabled={!recent?.length} />Recent files{recent === null ? ' (loading)' : recent.length === 0 ? ' (none yet)' : ''}</label>
          {choice === 'stored' && recent && (
            <ul className="ml-6 grid grid-cols-3 gap-2" aria-label="Recent files">
              {recent.map((f) => (
                <li key={f.message_id}>
                  <button type="button" aria-pressed={storedId === f.message_id} onClick={() => setStoredId(f.message_id)} className={`block h-20 w-full overflow-hidden rounded-md border bg-muted text-[11px] ${storedId === f.message_id ? 'outline outline-2 outline-accent' : ''}`}>
                    {f.mime.startsWith('image/') ? <img src={`/api/media/${f.message_id}`} alt={f.filename ?? 'Stored file'} loading="lazy" className="h-full w-full object-cover" /> : <span className="block break-all p-1">{f.filename ?? 'File'}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {touched && !headerOk && <p role="alert" className="text-xs text-danger">Pick a file for the header.</p>}
        </fieldset>
      )}
      <div>
        <p className="mb-1 text-xs font-semibold text-muted-foreground">Preview</p>
        <WaCard header={tpl.header_format} headerImageUrl={tpl.has_header_sample ? `/api/templates/${encodeURIComponent(tpl.id)}/media` : null} headerText={tpl.header_text} body={tpl.body} footer={tpl.footer} samples={bp} headerSamples={hp} />
      </div>
      <Button type="submit" className="w-full">Send template</Button>
    </form>
  )
}
