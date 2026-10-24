import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Modal } from './Modal'

export const OUTCOMES: [string, string][] = [['answered', 'Answered'], ['no_answer', 'No answer'], ['busy', 'Busy'], ['voicemail', 'Voicemail'], ['wrong_number', 'Wrong number']]

export function CallDialog({ onSave, onClose }: { onSave: (b: { outcome: string; duration_s?: number; note?: string }) => Promise<void>; onClose: () => void }) {
  const [outcome, setOutcome] = useState('answered')
  const [mins, setMins] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const save = async () => {
    setBusy(true); setErr(null)
    try { await onSave({ outcome, ...(mins ? { duration_s: Math.round(Number(mins) * 60) } : {}), ...(note.trim() ? { note: note.trim() } : {}) }) }
    catch (e) { setErr((e as Error).message); setBusy(false) }
  }
  return (
    <Modal title="Log a call" onClose={onClose}>
      <div className="space-y-3">
        <div><Label htmlFor="call-outcome">Outcome</Label><Select id="call-outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)}>{OUTCOMES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></div>
        <div><Label htmlFor="call-mins">Minutes (optional)</Label><Input id="call-mins" type="number" inputMode="decimal" min="0" max="1440" value={mins} onChange={(e) => setMins(e.target.value)} /></div>
        <div><Label htmlFor="call-note">Note (optional)</Label><Input id="call-note" maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} /></div>
        {err && <p role="alert" className="text-sm text-danger">{err}</p>}
        <div className="flex gap-2"><Button loading={busy} onClick={() => void save()}>Save call</Button><Button variant="ghost" onClick={onClose}>Cancel</Button></div>
      </div>
    </Modal>
  )
}
