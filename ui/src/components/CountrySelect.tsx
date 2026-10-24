import { useMemo } from 'react'
import { COUNTRY_CODES } from '../../../src/countries'
import { Select } from './ui/select'

export function countryName(code: string) {
  try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code } catch { return code }
}

export function CountrySelect({ id, value, onChange, noneLabel = 'No default country' }: { id: string; value: string; onChange: (v: string) => void; noneLabel?: string }) {
  const items = useMemo(() => COUNTRY_CODES.map((c) => ({ c, n: countryName(c) })).sort((a, b) => a.n.localeCompare(b.n)), [])
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{noneLabel}</option>
      {items.map((i) => <option key={i.c} value={i.c}>{i.n}</option>)}
    </Select>
  )
}

export function timezoneList(current: string): string[] {
  let z: string[] = []
  try { z = Intl.supportedValuesOf('timeZone') } catch { /* older engines */ }
  return z.includes(current) || !current ? z : [current, ...z]
}
