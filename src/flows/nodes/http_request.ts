import { getSettings } from '../../settings'
import { interpolate } from '../context'
import type { NodeExecutor } from '../executor'
import { safeFetch } from '../http-guard'
import { countSubrequest } from '../meter'
import { SAFE_VAR, failOrRoute } from './fail'

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
const MAX_VALUE_JSON = 8 * 1024 // what a response may add to the run context (32 KB cap overall)
/** This Worker's script name: its workers.dev address is refused as a target. */
export const SELF_SCRIPT = 'whaleads-client'

type Hdr = { name?: unknown; key?: unknown; value?: unknown }
function headerList(v: unknown, render: (s: string) => string): [string, string][] {
  const pairs: [string, unknown][] = Array.isArray(v) ? (v as Hdr[]).map((h) => [String(h?.name ?? h?.key ?? ''), h?.value]) : v && typeof v === 'object' ? Object.entries(v as Record<string, unknown>) : []
  return pairs.filter(([k]) => /^[\w-]{1,64}$/.test(k.trim())).map(([k, val]) => [k.trim(), render(String(val ?? ''))] as [string, string]).slice(0, 20)
}

/**
 * An HTTP call through the SSRF guard (http-guard.safeFetch: public http(s) hosts only, 8 s, 256 KB, redirect hops
 * re-checked, request headers allow-listed). method / url / headers / body are templates over the run. The
 * Authorization header goes out only when the node sets one explicitly (allowAuth), and never follows a redirect to
 * another origin. A 2xx routes `success`; anything else, or a blocked / failed / timed-out call, routes `error` (or fails the run when that port is not connected).
 * The JSON response (text if it is not JSON) lands in `output.body` and, with `outputVariable`, in that variable.
 * Shadow and dry runs skip every method, GET included.
 */
export const httpRequestExecutor: NodeExecutor = async (node, ctx, svc) => {
  const d = node.data as { method?: unknown; url?: unknown; headers?: unknown; body?: unknown; outputVariable?: unknown }
  const render = (s: string) => interpolate(s, ctx)
  const method = String(d.method ?? 'GET').toUpperCase()
  const url = render(String(d.url ?? '')).trim()
  const outVar = typeof d.outputVariable === 'string' ? d.outputVariable.trim() : ''
  if (svc.shadow || svc.dryRun) return { port: 'success', status: 'skipped', output: { would: { method, url }, shadow: true }, note: 'shadow: HTTP call skipped' }
  // Same rule as the send nodes: a connected `error` port takes the run on; with none the run fails readably.
  const fail = (error: string, extra: Record<string, unknown> = {}) => failOrRoute(svc, node, 'http_failed', error, 'error', extra)
  if (!METHODS.has(method)) return fail('invalid_method')
  if (!url) return fail('empty_url')
  if (outVar && !SAFE_VAR.test(outVar)) return fail('invalid_variable_name')

  const headers = headerList(d.headers, render)
  const authExplicit = headers.some(([k]) => k.toLowerCase() === 'authorization')
  const hasBody = method !== 'GET' && d.body !== undefined && d.body !== ''
  const body = hasBody ? render(String(d.body)) : undefined
  const h = new Headers(headers)
  if (body !== undefined && !h.has('content-type')) { try { JSON.parse(body); h.set('content-type', 'application/json') } catch { h.set('content-type', 'text/plain') } }

  const settings = await getSettings(svc.env)
  const selfHosts = settings.allowed_origins.flatMap((o) => { try { return [new URL(o).host.toLowerCase()] } catch { return [] } })
  countSubrequest(svc.meter)
  let res: Response
  try {
    res = await safeFetch(url, { method, headers: h, body }, { allowAuth: authExplicit, selfHosts, selfScript: SELF_SCRIPT })
  } catch (e) {
    return fail(e instanceof Error ? e.message.slice(0, 200) : 'request_failed')
  }
  const text = await res.text()
  let value: unknown = text.slice(0, MAX_VALUE_JSON)
  let truncated = text.length > MAX_VALUE_JSON
  try {
    const j = JSON.parse(text)
    if (JSON.stringify(j).length <= MAX_VALUE_JSON) { value = j; truncated = false }
  } catch { /* not JSON: the text, clipped */ }
  if (outVar) ctx.vars[outVar] = value
  const ok = res.status >= 200 && res.status < 300
  const output = { ok, status: res.status, body: value, ...(truncated ? { truncated: true } : {}) }
  return ok ? { port: 'success', output } : fail(`HTTP ${res.status}`, { status: res.status, body: value })
}
