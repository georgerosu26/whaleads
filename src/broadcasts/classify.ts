// Send-error classification for broadcasts (plan D4). Lives here, never in src/adaptors/ (D23: adaptors pass Meta's
// error through verbatim). Codes checked against the Cloud API error-code page, 2026-10-21.
import type { AdaptorResult } from '../adaptors/types'

export type ErrorClass = 'retry' | 'recipient' | 'pause' | 'unknown_outcome'
export interface Verdict {
  class: ErrorClass
  code: number | null
  message: string
  /** Stop the step: the sender is being throttled. */
  stop: boolean
  /** 131050: the recipient stopped marketing messages. */
  optOut: boolean
}

export const RETRY_CODES = new Set([130429, 131056, 131000, 131016, 4, 80007])
export const RECIPIENT_CODES = new Set([131026, 131049, 131050, 131009, 131008, 131021])
export const PAUSE_CODES = new Set([131048, 132000, 132001, 132005, 132007, 132012, 132015, 132016, 131042, 131031, 133010, 368, 190])
const STOP_CODES = new Set([130429, 4, 80007])

export const MAX_ATTEMPTS = 3
export const BACKOFF_CAP_S = 1800

/** Seconds to wait after the nth failed attempt (n >= 1): 60, 120, 240 ... capped at 30 minutes. */
export const backoff = (attempts: number) => Math.min(BACKOFF_CAP_S, 60 * 2 ** Math.max(0, attempts - 1))

/** The Meta error code inside whatever envelope the adaptor handed back (Graph or WhaBuzz), or null. */
export function errorCode(e: unknown): number | null {
  const o = e as any
  for (const c of [o?.code, o?.error?.code, o?.error?.error?.code, o?.errors?.[0]?.code]) {
    const n = typeof c === 'string' ? Number(c) : c
    if (typeof n === 'number' && Number.isFinite(n)) return n
  }
  return null
}

export function errorMessage(e: unknown, fallback: string): string {
  const o = e as any
  const m = o?.error_data?.details ?? o?.message ?? o?.error?.message ?? o?.error?.error?.message ?? o?.title ?? o?.errors?.[0]?.message
  return typeof m === 'string' && m ? m.slice(0, 300) : fallback
}

/** One Meta error (a send response or a status webhook `errors[]` item): recipient-final unless it is a pause or retry code. */
export function classifyCode(code: number | null, message: string, status = 0): Verdict {
  const v = (cls: ErrorClass, stop = false): Verdict => ({ class: cls, code, message, stop, optOut: code === 131050 })
  if (code !== null && RECIPIENT_CODES.has(code)) return v('recipient')
  if (code !== null && PAUSE_CODES.has(code)) return v('pause')
  if (code !== null && RETRY_CODES.has(code)) return v('retry', STOP_CODES.has(code))
  if (status === 429) return v('retry', true)
  if (status >= 500) return v('retry')
  if (status === 401) return v('pause')
  return v('recipient') // unknown codes are recipient-final; the caller logs the raw error
}

/** A failed adaptor send. Status 0 (timeout / dropped connection) means the message may have gone out: never re-sent. */
export function classifySend(r: AdaptorResult): Verdict {
  const raw = (r.error as any)?.error
  const code = errorCode(raw)
  const message = errorMessage(raw, r.error?.message ?? 'send failed')
  if (r.status === 0 && code === null) return { class: 'unknown_outcome', code: null, message, stop: false, optOut: false }
  return classifyCode(code, message, r.status)
}

export const reasonOf = (v: Verdict) => `${v.code ?? 'error'}: ${v.message}`.slice(0, 400)
