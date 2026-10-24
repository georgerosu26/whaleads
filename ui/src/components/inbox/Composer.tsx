import { FileText, Lock, Paperclip, Send, Zap } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { fillQuickReply } from '@/lib/quickReplies'
import type { TemplateJob } from '@/lib/templates'
import { TemplateSheet } from './TemplateSheet'

interface QR { id: number; shortcut: string; body: string }
const ACCEPT = 'image/jpeg,image/png,video/mp4,video/3gpp,audio/aac,audio/mp4,audio/mpeg,audio/amr,audio/ogg,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain'

/** `onSubmit` returns false when the send is refused (the same text is still pending), so the input is kept. */
export function Composer({ contactId, contactName, windowOpen, onSubmit, onSendTemplate }: {
  contactId: number; contactName: string | null; windowOpen: boolean; onSubmit: (job: { text: string; file: File | null }) => boolean
  onSendTemplate: (job: TemplateJob) => boolean
}) {
  const [sheet, setSheet] = useState(false)
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [qrs, setQrs] = useState<QR[] | null>(null)
  const [qrErr, setQrErr] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => { setText(''); setFile(null); setPickerOpen(false); setSheet(false) }, [contactId])
  useEffect(() => {
    if (!windowOpen || qrs || qrErr) return
    api<{ quick_replies: QR[] }>('/api/quick-replies').then((r) => setQrs(r.quick_replies)).catch(() => setQrErr(true))
  }, [windowOpen, qrs, qrErr])

  if (!windowOpen) {
    return (
      <div className="border-t bg-surface px-3 py-3">
        <p role="status" className="flex items-start gap-2 pb-2 text-sm"><Lock aria-hidden className="mt-0.5 h-4 w-4 shrink-0" /><span><strong>Reply window closed.</strong> Free text is off until they message again.</span></p>
        <div className="flex gap-2">
          <textarea disabled rows={1} aria-label="Message" placeholder="Free text unavailable" className="min-h-[44px] flex-1 resize-none rounded-md border bg-muted px-3 py-2 text-base opacity-60" />
          <Button onClick={() => setSheet(true)}><FileText aria-hidden className="h-4 w-4" />Template</Button>
        </div>
        {sheet && <TemplateSheet contactName={contactName} onClose={() => setSheet(false)} onSend={onSendTemplate} />}
      </div>
    )
  }

  const filtered = (() => {
    const m = /^\/([\p{L}\p{N}_-]*)$/u.exec(text)
    if (!qrs) return []
    if (m) return qrs.filter((r) => r.shortcut.toLowerCase().startsWith(m[1]!.toLowerCase()))
    return pickerOpen ? qrs : []
  })()
  const showPicker = filtered.length > 0 && (pickerOpen || /^\/[^\s]*$/.test(text))

  // Optimistic: the thread shows the bubble at once and the input is free for the next message while it goes out.
  const send = () => {
    const body = text.trim()
    if (!body && !file) return
    if (!onSubmit({ text: body, file })) return
    setText(''); setFile(null); setPickerOpen(false)
  }

  return (
    <div className="border-t bg-surface px-3 py-2">
      {sheet && <TemplateSheet contactName={contactName} onClose={() => setSheet(false)} onSend={onSendTemplate} />}
      {showPicker && (
        <ul aria-label="Quick replies" className="mb-2 max-h-40 divide-y overflow-y-auto rounded-md border bg-background">
          {filtered.map((r) => (
            <li key={r.id}>
              <button type="button" className="block min-h-[44px] w-full px-3 py-2 text-left hover:bg-muted" onClick={() => { setText(fillQuickReply(r.body, { name: contactName })); setPickerOpen(false) }}>
                <span className="block text-sm font-bold">/{r.shortcut}</span>
                <span className="block truncate text-xs text-muted-foreground">{r.body}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {file && (
        <p className="mb-2 flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm"><Paperclip aria-hidden className="h-4 w-4 shrink-0" /><span className="min-w-0 flex-1 truncate">{file.name}</span><button type="button" className="font-semibold text-accent" onClick={() => setFile(null)}>Remove</button></p>
      )}
      <div className="flex items-end gap-1">
        <input ref={fileRef} type="file" hidden accept={ACCEPT} aria-label="Attach file" onChange={(e) => { setFile(e.target.files?.[0] ?? null); e.target.value = '' }} />
        <Button variant="ghost" aria-label="Attach file" className="w-11 shrink-0 px-0" onClick={() => fileRef.current?.click()}><Paperclip aria-hidden className="h-5 w-5" /></Button>
        <Button variant="ghost" aria-label="Template" className="w-11 shrink-0 px-0" onClick={() => setSheet(true)}><FileText aria-hidden className="h-5 w-5" /></Button>
        <Button variant="ghost" aria-label="Quick replies" aria-pressed={pickerOpen} className="w-11 shrink-0 px-0" onClick={() => setPickerOpen((v) => !v)}><Zap aria-hidden className="h-5 w-5" /></Button>
        <textarea
          aria-label="Message" rows={Math.min(5, Math.max(1, text.split('\n').length, Math.ceil(text.length / 26)))} value={text} maxLength={4096}
          placeholder={file ? 'Add a caption' : 'Message, or / for replies'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send() } }}
          className="max-h-32 min-h-[44px] min-w-0 flex-1 resize-none rounded-md border bg-background px-3 py-2 text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        />
        <Button aria-label="Send" className="w-11 shrink-0 px-0" disabled={!text.trim() && !file} onClick={() => send()}><Send aria-hidden className="h-5 w-5" /></Button>
      </div>
    </div>
  )
}
