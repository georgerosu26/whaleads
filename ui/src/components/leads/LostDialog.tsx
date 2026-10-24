import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Modal } from './Modal'

const REASONS = ['Too expensive', 'Not interested', 'No response', 'Bought elsewhere', 'Not a fit']

export function LostDialog({ stageLabel, onConfirm, onClose }: { stageLabel: string; onConfirm: (reason: string) => Promise<void>; onClose: () => void }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const submit = async () => {
    setBusy(true); setErr(null)
    try { await onConfirm(reason.trim()); onClose() } catch (e) { setErr((e as Error).message); setBusy(false) }
  }
  return (
    <Modal title={`Move to ${stageLabel}`} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); void submit() }} className="space-y-3">
        <div>
          <Label htmlFor="lost-reason">Why was it lost?</Label>
          <Input id="lost-reason" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="Optional" />
        </div>
        <div className="flex flex-wrap gap-2">
          {REASONS.map((r) => <button type="button" key={r} onClick={() => setReason(r)} className="min-h-[36px] rounded-full border px-3 text-xs font-semibold hover:bg-muted">{r}</button>)}
        </div>
        {err && <p role="alert" className="text-sm text-danger">{err}</p>}
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Mark as {stageLabel.toLowerCase()}</Button></div>
      </form>
    </Modal>
  )
}
