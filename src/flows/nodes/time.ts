import { LIMITS } from '../types'

export const UNIT_S: Record<string, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86400 }

/**
 * Every duration a node can carry, in one place: which `data` fields hold the amount and the unit, and the unit used
 * when the unit field is absent. `validateGraph` enforces this table (unknown units are rejected, never read as seconds).
 *   delay            data.duration     + data.unit         default minutes
 *   wait_event       data.timeout      + data.timeoutUnit  default hours
 *   action set_next_action  data.duration + data.unit      default hours
 */
export const DURATIONS = {
  delay: { amount: 'duration', unit: 'unit', defaultUnit: 'minutes' },
  wait_event: { amount: 'timeout', unit: 'timeoutUnit', defaultUnit: 'hours' },
  set_next_action: { amount: 'duration', unit: 'unit', defaultUnit: 'hours' },
} as const

/** `amount` in `unit` as seconds, clamped to [min, max]. Non-numeric input falls to `fallback`. */
export function toSeconds(amount: unknown, unit: unknown, min: number, max: number, fallback: number): number {
  const n = Number(amount)
  const s = Number.isFinite(n) && n > 0 ? n * (UNIT_S[String(unit)] ?? 1) : fallback
  return Math.min(Math.max(Math.round(s), min), max)
}

/** A problem with a node's duration fields, or null. Empty amount is allowed (the node default applies). */
export function durationError(type: string, data: Record<string, unknown>): string | null {
  const spec = type === 'delay' || type === 'wait_event' ? DURATIONS[type] : type === 'action' && data.actionType === 'set_next_action' ? DURATIONS.set_next_action : null
  if (!spec) return null
  const unit = data[spec.unit]
  if (unit !== undefined && unit !== null && unit !== '' && !(typeof unit === 'string' && unit in UNIT_S)) return `unit must be one of ${Object.keys(UNIT_S).join(', ')}`
  const amount = data[spec.amount]
  if (amount !== undefined && amount !== null && amount !== '') {
    const n = typeof amount === 'number' ? amount : typeof amount === 'string' && amount.trim() !== '' ? Number(amount) : NaN
    if (!Number.isFinite(n) || n <= 0) return `${spec.amount} must be a positive number`
  }
  return null
}

const unitOf = (u: unknown, d: string) => (u === undefined || u === null || u === '' ? d : u)

export const delaySeconds = (d: { duration?: unknown; unit?: unknown }) => toSeconds(d.duration, unitOf(d.unit, DURATIONS.delay.defaultUnit), LIMITS.DELAY_MIN_S, LIMITS.DELAY_MAX_S, LIMITS.DELAY_MIN_S)
export const waitSeconds = (d: { timeout?: unknown; timeoutUnit?: unknown }) => toSeconds(d.timeout, unitOf(d.timeoutUnit, DURATIONS.wait_event.defaultUnit), LIMITS.DELAY_MIN_S, LIMITS.WAIT_MAX_S, LIMITS.WAIT_DEFAULT_S)
export const nextActionSeconds = (d: { duration?: unknown; unit?: unknown }) => toSeconds(d.duration, unitOf(d.unit, DURATIONS.set_next_action.defaultUnit), 60, 365 * 86400, 86400)
