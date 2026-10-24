// Country-neutral phone handling. Stored form everywhere: E.164 digits without the "+".
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/min'
import { isCountryCode } from './countries'

export const NEEDS_COUNTRY = 'phone needs a country code'

/**
 * Returns E.164 digits (no "+") or null when the input cannot be a phone number.
 * A leading "+" or "00" means international. Otherwise the digits are read as a national number of
 * `defaultCountry` or as an international number missing its "+" (see the precedence below).
 * With no usable default country and no "+", the input is rejected (see `phoneError`).
 */
export function toWaDigits(input: unknown, defaultCountry?: string | null): string | null {
  const raw = String(input ?? '').trim()
  if (!raw) return null
  const digits = raw.replace(/\D/g, '')
  if (!digits) return null
  let international = raw.startsWith('+')
  let text = digits
  if (!international && digits.startsWith('00')) { international = true; text = digits.slice(2) }
  const country = defaultCountry?.trim().toUpperCase()
  if (!international && !(country && isCountryCode(country))) return null
  if (international) {
    const p = parsePhoneNumberFromString('+' + text)
    return p && p.isPossible() ? p.number.slice(1) : null
  }
  // No "+": the digits may be a national number (typed in the default country) or a full international
  // number whose "+" was left off. Never prepend the default country to something that is already international.
  // A national number is at most 10 digits, or has a trunk "0" in front. Anything longer without a "0" can
  // only be international (the legacy parser left such numbers as typed), so it is never given the default country.
  const nationalShaped = text.length <= 10 || text.startsWith('0')
  const nat = nationalShaped ? parsePhoneNumberFromString(text, country as CountryCode) : undefined
  const intl = parsePhoneNumberFromString('+' + text)
  const natOk = !!nat && nat.isValid()
  const intlOk = !!intl && intl.isValid()
  // Precedence: valid national, then valid international, then legacy.
  if (natOk) return nat!.number.slice(1)
  if (intlOk) return intl!.number.slice(1)
  // Neither is valid. Legacy: a 10-digit (or 0 + 10) number is the default country's when at least possible;
  // any other 8-15 digit string is kept as typed.
  if (nat && nat.isPossible() && (text.length === 10 || (text.startsWith('0') && text.length === 11))) return nat.number.slice(1)
  return text.length >= 8 && text.length <= 15 ? text : null
}

/** The user-facing reason a number was rejected. */
export function phoneError(input: unknown, defaultCountry?: string | null): string {
  const raw = String(input ?? '').trim()
  const intl = raw.startsWith('+') || raw.replace(/\D/g, '').startsWith('00')
  const country = defaultCountry?.trim().toUpperCase()
  return !intl && !(country && isCountryCode(country)) ? NEEDS_COUNTRY : 'valid phone required'
}

/** Display form, e.g. "+1 555 000 0001". Falls back to "+digits". */
export function formatPhone(digits: string | null | undefined): string {
  if (!digits) return ''
  return parsePhoneNumberFromString('+' + digits)?.formatInternational() ?? '+' + digits
}
