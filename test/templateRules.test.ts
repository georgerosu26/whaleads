// Authentication (one-time code) template rules and the Meta create body.
import { describe, expect, it } from 'vitest'
import { AUTH_LIMITS, OTP_CODE_RE, buildComponents, validateTemplate, type TemplateInput } from '../src/templateRules'

const auth: TemplateInput = { name: 'login_code', language: 'en', category: 'AUTHENTICATION', body: '', auth: { security_note: true, expiry_minutes: 10, button_text: 'Copy code' } }
const fields = (t: Partial<TemplateInput>) => validateTemplate({ ...auth, ...t }).errors.map((e) => e.field)

describe('authentication templates', () => {
  it('accepts a valid one and ignores the (empty) body', () => expect(validateTemplate(auth).errors).toEqual([]))
  it('builds Meta body: BODY flag, FOOTER expiry, OTP COPY_CODE button, no body text', () => {
    expect(buildComponents(auth)).toEqual([
      { type: 'BODY', add_security_recommendation: true },
      { type: 'FOOTER', code_expiration_minutes: 10 },
      { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' }] },
    ])
  })
  it('omits the flag, footer and button text when unset', () => {
    expect(buildComponents({ ...auth, auth: {} })).toEqual([{ type: 'BODY' }, { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE' }] }])
  })
  it('expiry must be a whole number 1 to 90', () => {
    for (const n of [0, 91, 1.5, -3]) expect(fields({ auth: { expiry_minutes: n } })).toContain('auth')
    for (const n of [AUTH_LIMITS.expiryMin, AUTH_LIMITS.expiryMax]) expect(fields({ auth: { expiry_minutes: n } })).not.toContain('auth')
  })
  it('button text is 1 to 25 characters', () => {
    expect(fields({ auth: { button_text: 'x'.repeat(26) } })).toContain('auth')
    expect(fields({ auth: { button_text: 'x'.repeat(25) } })).not.toContain('auth')
    expect(fields({ auth: { button_text: '  ' } })).toContain('auth')
  })
  it('rejects header, footer text and media', () => {
    expect(fields({ header: { format: 'TEXT', text: 'Hi' } })).toContain('header')
    expect(fields({ footer: 'Reply STOP' })).toContain('footer')
    expect(fields({ has_media_sample: true })).toContain('media')
  })
  it('rejects one-tap and zero-tap', () => {
    expect(fields({ auth: { button_type: 'ONE_TAP' } })).toContain('auth')
    expect(fields({ auth: { button_type: 'copy_code' } })).not.toContain('auth')
  })
  it('keeps the name and language rules', () => {
    expect(fields({ name: 'Bad Name' })).toContain('name')
    expect(fields({ language: 'english' })).toContain('language')
  })
  it('OTP code pattern: 1 to 15 letters, digits, dashes', () => {
    for (const ok of ['123456', 'AB-12', 'a'.repeat(15)]) expect(OTP_CODE_RE.test(ok)).toBe(true)
    for (const bad of ['', 'a'.repeat(16), '12 34', '12\n34', '1;2']) expect(OTP_CODE_RE.test(bad)).toBe(false)
  })
})
