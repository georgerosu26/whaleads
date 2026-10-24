// D19 latency budget: per-request timing, surfaced as a Server-Timing header and an events row.
//   worker   = our own time (request total minus time awaiting the adaptor's fetch)
//   upstream = time spent awaiting the adaptor's fetch (headers received)
//   wb / meta / auth = the gateway's own split, passed through from its Server-Timing header
// The request-scoped record lives in AsyncLocalStorage (nodejs_compat), so concurrent requests in one isolate never mix.
import { AsyncLocalStorage } from 'node:async_hooks'

export interface Timing { start: number; upstream: number; calls: number; passthrough: Record<string, number> }

const als = new AsyncLocalStorage<Timing>()
const PASS = new Set(['wb', 'meta', 'auth'])
const now = () => performance.now()

export const newTiming = (): Timing => ({ start: now(), upstream: 0, calls: 0, passthrough: {} })
export const runWithTiming = <T>(t: Timing, fn: () => Promise<T>): Promise<T> => als.run(t, fn)

/** Parses `wb;dur=12.3, meta;dur=300` and keeps only the whitelisted names with finite numeric durations. */
export function parseServerTiming(h: string | null | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  for (const part of (h ?? '').split(',')) {
    const [name, ...params] = part.trim().split(';')
    const key = name?.trim().toLowerCase()
    if (!key || !PASS.has(key)) continue
    const dur = params.map((p) => /^\s*dur\s*=\s*([0-9.]+)\s*$/i.exec(p)?.[1]).find((v) => v !== undefined)
    const n = Number(dur)
    if (dur !== undefined && Number.isFinite(n)) out[key] = (out[key] ?? 0) + n
  }
  return out
}

/** Wraps an adaptor's fetch: times the await and folds any upstream Server-Timing entries into the request's record. */
export function timedFetch(impl: typeof fetch): typeof fetch {
  return (async (...args: Parameters<typeof fetch>) => {
    const t = als.getStore()
    const t0 = now()
    try {
      const res = await impl(...args)
      if (t) for (const [k, v] of Object.entries(parseServerTiming(res.headers?.get?.('Server-Timing')))) t.passthrough[k] = (t.passthrough[k] ?? 0) + v
      return res
    } finally {
      if (t) { t.upstream += now() - t0; t.calls += 1 }
    }
  }) as typeof fetch
}

const r1 = (n: number) => Math.round(n * 10) / 10

export function summary(t: Timing): { worker: number; upstream: number; wb?: number; meta?: number; auth?: number } {
  const total = now() - t.start
  const out: ReturnType<typeof summary> = { worker: r1(Math.max(0, total - t.upstream)), upstream: r1(t.upstream) }
  for (const k of ['wb', 'meta', 'auth'] as const) if (t.passthrough[k] !== undefined) out[k] = r1(t.passthrough[k]!)
  return out
}

export function serverTimingHeader(t: Timing): string {
  const s = summary(t)
  return Object.entries(s).map(([k, v]) => `${k};dur=${v}`).join(', ')
}

/** Routes that carry the header: the three send routes and both webhook POSTs. */
export function timedRoute(method: string, path: string): 'send' | 'webhook' | null {
  if (method !== 'POST') return null
  if (path === '/webhooks/meta' || path === '/webhooks/whabuzz') return 'webhook'
  if (path === '/api/send' || /^\/api\/inbox\/\d+\/(send|send-media|send-template)$/.test(path)) return 'send'
  return null
}

export function withServerTiming(res: Response, t: Timing): Response {
  const out = new Response(res.body, res)
  const prior = out.headers.get('Server-Timing')
  out.headers.set('Server-Timing', prior ? `${prior}, ${serverTimingHeader(t)}` : serverTimingHeader(t))
  const exposed = out.headers.get('Access-Control-Expose-Headers')
  if (!exposed || !/server-timing/i.test(exposed)) out.headers.set('Access-Control-Expose-Headers', exposed ? `${exposed}, Server-Timing` : 'Server-Timing')
  return out
}
