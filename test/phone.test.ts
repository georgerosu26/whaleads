import { describe, expect, it } from 'vitest'
import { formatPhone, phoneError, toWaDigits } from '../src/phone'

/** The original India-only parser, verbatim, as the parity reference. */
function legacyNormalisePhone(input: string): string | null {
  const d = String(input ?? '').replace(/\D/g, '')
  if (/^[6-9]\d{9}$/.test(d)) return '91' + d
  if (/^0[6-9]\d{9}$/.test(d)) return '91' + d.slice(1)
  if (/^91[6-9]\d{9}$/.test(d)) return d
  if (/^0091[6-9]\d{9}$/.test(d)) return d.slice(2)
  if (d.length >= 8 && d.length <= 15 && !d.startsWith('0')) return d
  return null
}

describe('toWaDigits: parity with the old Indian parser under default_country = IN', () => {
  const indian = [
    '9999000012', '99990 00012', '99990-00012', '(99990) 00012', '09999000012', '919999000012', '+91 99990 00012',
    '+919999000012', '0091 9999000012', '00919999000012', '91-9999000012', '6000000001', '7000000001', '8000000001',
  ]
  for (const input of indian) {
    it(`"${input}" -> ${legacyNormalisePhone(input)}`, () => {
      expect(toWaDigits(input, 'IN')).toBe(legacyNormalisePhone(input))
      expect(toWaDigits(input, 'IN')).toMatch(/^91[6-9]\d{9}$/)
    })
  }
  it('explicit international numbers keep their digits', () => {
    expect(toWaDigits('+1 555 000 0001', 'IN')).toBe(legacyNormalisePhone('+1 555 000 0001'))
    expect(toWaDigits('+44 7700 900123', 'IN')).toBe('447700900123')
    expect(toWaDigits('0044 7700 900123', 'IN')).toBe('447700900123')
  })
  it('garbage is rejected like before', () => {
    for (const bad of ['', '   ', 'abc', '123', '0000', '+', null, undefined, 12345]) expect(toWaDigits(bad as any, 'IN')).toBeNull()
    expect(legacyNormalisePhone('123')).toBeNull()
  })
})

describe('toWaDigits: country-neutral', () => {
  it('uses the default country for national numbers', () => {
    expect(toWaDigits('(555) 000-0002', 'US')).toBe('15550000002')
    expect(toWaDigits('07700 900123', 'GB')).toBe('447700900123')
    expect(toWaDigits('0412 345 678', 'AU')).toBe('61412345678')
    expect(toWaDigits('0412 345 678', 'au')).toBe('61412345678')
  })
  it('a leading + or 00 wins over the default country', () => {
    expect(toWaDigits('+447700900123', 'IN')).toBe('447700900123')
    expect(toWaDigits('+15550000002', 'GB')).toBe('15550000002')
    expect(toWaDigits('0015550000002', 'GB')).toBe('15550000002')
  })
  it('without + and without a usable default country the input is rejected', () => {
    for (const c of [undefined, null, '', '  ', 'ZZ', 'XX1']) {
      expect(toWaDigits('9999000012', c as any)).toBeNull()
      expect(toWaDigits('15550000002', c as any)).toBeNull()
    }
    expect(phoneError('9999000012', undefined)).toBe('phone needs a country code')
    expect(phoneError('9999000012', 'IN')).toBe('valid phone required')
    expect(phoneError('+1', undefined)).toBe('valid phone required')
  })
  it('with a + and no default country it still works', () => {
    expect(toWaDigits('+15550000002')).toBe('15550000002')
    expect(toWaDigits('+91 99990 00012', null)).toBe('919999000012')
  })
  it('formatPhone gives the international display form, and degrades to +digits', () => {
    expect(formatPhone('919999000012')).toBe('+91 99990 00012')
    expect(formatPhone('15550000002')).toBe('+1 555 000 0002')
    expect(formatPhone('')).toBe('')
    expect(formatPhone(null)).toBe('')
    expect(formatPhone('99')).toBe('+99')
  })
})

describe('toWaDigits: foreign numbers typed without "+" are never given the default country', () => {
  for (const n of ['447700900123', '971501234567', '15550000002', '14155550123', '61412345678', '4930231250012']) {
    it(`${n} under IN stays ${n}`, () => { expect(toWaDigits(n, 'IN')).toBe(n) })
  }
  it('10-digit UK national under GB, and with a trunk 0', () => {
    expect(toWaDigits('7700900123', 'GB')).toBe('447700900123')
    expect(toWaDigits('07700900123', 'GB')).toBe('447700900123')
  })
  it('10-digit US national under US, with and without the leading 1', () => {
    expect(toWaDigits('4155550123', 'US')).toBe('14155550123')
    expect(toWaDigits('(415) 555-0123', 'US')).toBe('14155550123')
    expect(toWaDigits('14155550123', 'US')).toBe('14155550123')
  })
})
