// Calendar-day maths in an IANA time zone, using only Intl (no tz database shipped). Shared by the Worker
// (Today buckets) and the SPA (next-action pickers), so both agree where a "day" starts.

const fmtCache = new Map<string, Intl.DateTimeFormat>()
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    fmtCache.set(tz, f)
  }
  return f
}

export function isTimezone(tz: string): boolean {
  try { fmt(tz); return true } catch { return false }
}

/** Offset of `tz` from UTC at the instant `epoch` (unix seconds), in seconds. East of UTC is positive. */
export function tzOffset(epoch: number, tz: string): number {
  const p: Record<string, number> = {}
  for (const part of fmt(tz).formatToParts(new Date(epoch * 1000))) if (part.type !== 'literal') p[part.type] = Number(part.value)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000
  return Math.round(asUtc - Math.floor(epoch))
}

/** Unix seconds for a wall-clock time in `tz`. In a DST gap the time resolves forward; in an overlap, to the first. */
export function zonedToEpoch(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi, 0) / 1000
  // Try the offsets in force a day either side; keep candidates that really map back to this wall time.
  const cands = [...new Set([wall - tzOffset(wall - 86400, tz), wall - tzOffset(wall + 86400, tz)])].sort((x, y) => x - y)
  const valid = cands.filter((c) => c + tzOffset(c, tz) === wall)
  // Overlap: first occurrence. Gap (no valid candidate, e.g. midnight skipped): the later candidate, which is the wall time shifted forward.
  return valid.length ? valid[0] : cands[cands.length - 1]
}

/** Unix seconds of local midnight at the start of the day containing `epoch`. */
export function startOfDay(epoch: number, tz: string): number {
  const local = epoch + tzOffset(epoch, tz)
  const day = new Date(local * 1000)
  return zonedToEpoch(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), 0, 0, tz)
}

/** Start of the NEXT local day (handles 23 and 25 hour days). */
export function startOfNextDay(epoch: number, tz: string): number {
  return startOfDay(startOfDay(epoch, tz) + 36 * 3600, tz)
}

/** `YYYY-MM-DD` of the local date, for date inputs. */
export function localDate(epoch: number, tz: string): string {
  const d = new Date((epoch + tzOffset(epoch, tz)) * 1000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}
/** `HH:MM` of the local time. */
export function localTime(epoch: number, tz: string): string {
  const d = new Date((epoch + tzOffset(epoch, tz)) * 1000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
