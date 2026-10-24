// the login ?next= parser (ui/src/lib/safeNext.ts) must never produce an off-site or script target.
import { describe, expect, it } from 'vitest'
import { safeNext } from '../ui/src/lib/safeNext'

const O = 'https://leads.example.com'
describe('safeNext', () => {
  it('keeps same-origin paths, query and hash', () => {
    expect(safeNext('/settings/whatsapp?connected=1#x', O)).toBe('/settings/whatsapp?connected=1#x')
    expect(safeNext('/api/whabuzz/callback?code=abc&state=def', O)).toBe('/api/whabuzz/callback?code=abc&state=def')
  })
  it('refuses everything that could leave the origin', () => {
    for (const bad of ['%2F%09%2Fevil.com', '/\t/evil.com', '//evil.com', '//evil', '\\evil', '/\\evil.com', '\\\\evil.com', 'javascript:alert(1)', 'https://evil.com', 'http://leads.example.com.evil.com/', '', 'evil.com']) {
      expect(safeNext(bad, O), bad).toBeNull()
    }
  })
  it('a decoded tab-slash-slash cannot become protocol-relative', () => {
    const r = safeNext(decodeURIComponent('%2F%09%2Fevil.com'), O)
    expect(r === null || (!r.startsWith('//') && new URL(r, O).origin === O)).toBe(true)
  })
  it('null and undefined', () => { expect(safeNext(null, O)).toBeNull(); expect(safeNext(undefined, O)).toBeNull() })
})
