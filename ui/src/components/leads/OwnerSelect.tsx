import { Select } from '@/components/ui/select'
import type { Owner } from '@/lib/crm'

export function OwnerSelect({ owners, value, onChange, id, disabled, noneLabel = 'Unassigned' }: {
  owners: Owner[]; value: number | null; onChange: (v: number | null) => void; id?: string; disabled?: boolean; noneLabel?: string
}) {
  return (
    <Select id={id} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">{noneLabel}</option>
      {owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
    </Select>
  )
}
