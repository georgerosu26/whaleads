// SSRF-guarded fetch for the flow engine's outbound HTTP (the `http_request` node). Adapted from an earlier
// guard with the audited fixes: IPv6 hex-form / NAT64 / 6to4 parsing, credential stripping on cross-origin
// redirects, 8 s / 256 KB limits, and a self-target block. Cloudflare drops private egress at the network layer;
// this guard is defence-in-depth with clear errors.
//
// Policy: http(s) only; no IP literal in a private/loopback/link-local/metadata/reserved range (v4 or v6, in any
// textual form - the WHATWG URL parser already normalises decimal/hex/short IPv4 to a dotted quad); no
// localhost-style or metadata hostnames; no `.local` / `.internal`; no request to this instance itself; each
// redirect hop is re-validated, max 3 hops.

export interface SafeFetchOptions {
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
  /** Optional egress allowlist of host suffixes. */
  allowHosts?: string[]
  /** This instance's own hostnames (request host, custom domains): refused as targets. */
  selfHosts?: string[]
  /**
   * The node explicitly set an Authorization header. Without this flag Authorization is never sent; with it, it is sent
   * to the first origin only and stripped on any cross-origin redirect.
   */
  allowAuth?: boolean
  /** This Worker's script name: `<script>.<subdomain>.workers.dev` is refused as a target. */
  selfScript?: string
}

export class SsrfBlockedError extends Error {
  constructor(message: string) { super(message); this.name = 'SsrfBlockedError' }
}

export const HTTP_TIMEOUT_MS = 8_000
export const HTTP_MAX_BYTES = 256 * 1024
const DEFAULT_MAX_REDIRECTS = 3

const BLOCKED_HOSTNAMES = new Set([
  'localhost', 'localhost.localdomain', 'metadata', 'metadata.google.internal', 'metadata.goog',
  'instance-data', 'instance-data.ec2.internal',
])

function ipv4ToInt(host: string): number | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  const o = m.slice(1).map(Number)
  if (o.some((x) => x > 255)) return null
  return (((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3]) >>> 0
}

const inCidr = (ip: number, base: number, prefix: number) => {
  if (prefix === 0) return true
  const mask = (0xffffffff << (32 - prefix)) >>> 0
  return ((ip & mask) >>> 0) === ((base & mask) >>> 0)
}

const V4_BLOCKS: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4], ['255.255.255.255', 32],
]
const blockedIntV4 = (ip: number) => V4_BLOCKS.some(([b, p]) => inCidr(ip, ipv4ToInt(b)!, p))
export function isBlockedIpv4(host: string): boolean {
  const ip = ipv4ToInt(host)
  return ip !== null && blockedIntV4(ip)
}

/** Expands an IPv6 literal (no brackets) to eight 16-bit groups, or null when it is not valid IPv6. */
export function parseIpv6(host: string): number[] | null {
  let h = host.toLowerCase().split('%')[0]
  // trailing dotted quad -> two hex groups
  const dq = h.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (dq) {
    const v = ipv4ToInt(dq[2])
    if (v === null) return null
    h = dq[1] + ((v >>> 16) & 0xffff).toString(16) + ':' + (v & 0xffff).toString(16)
  }
  const halves = h.split('::')
  if (halves.length > 2) return null
  const toGroups = (s: string) => (s === '' ? [] : s.split(':'))
  const head = toGroups(halves[0])
  const tail = halves.length === 2 ? toGroups(halves[1]) : []
  if (halves.length === 1 && head.length !== 8) return null
  if (halves.length === 2 && head.length + tail.length > 7) return null
  const fill = halves.length === 2 ? new Array(8 - head.length - tail.length).fill('0') : []
  const all = [...head, ...fill, ...tail]
  if (all.length !== 8) return null
  const out: number[] = []
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null
    out.push(parseInt(g, 16))
  }
  return out
}

export function isBlockedIpv6(host: string): boolean {
  if (!host.includes(':')) return false
  const g = parseIpv6(host)
  if (!g) return true // unparseable IPv6: refuse
  const first96Zero = g.slice(0, 6).every((x) => x === 0)
  if (g.every((x) => x === 0)) return true // ::
  if (first96Zero) return true // ::1, ::a.b.c.d (IPv4-compatible) - none is a public destination
  if ((g[0] & 0xfe00) === 0xfc00) return true // fc00::/7 ULA
  if ((g[0] & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true // ff00::/8 multicast
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return true // ::ffff:0:0/96 IPv4-mapped: refused whole (no legitimate public target is written this way)
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return true // ::ffff:0:0:0/96 SIIT IPv4-translated
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) return true // 64:ff9b::/96 NAT64
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true // 64:ff9b:1::/48 local-use NAT64 (RFC 8215)
  if (g[0] === 0x2001 && g[1] === 0) return true // 2001::/32 Teredo
  if ((g[0] & 0xffc0) === 0xfec0) return true // fec0::/10 deprecated site-local
  if (g[0] === 0x2002) return blockedIntV4(((g[1] << 16) | g[2]) >>> 0) // 6to4 embeds the v4 in bits 16-47
  return false
}

/** Throws SsrfBlockedError if the URL is not safe to fetch. */
export function assertUrlAllowed(rawUrl: string, opts: SafeFetchOptions = {}): URL {
  let url: URL
  try { url = new URL(rawUrl) } catch { throw new SsrfBlockedError('invalid url') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SsrfBlockedError(`blocked protocol: ${url.protocol}`)
  if (url.username || url.password) throw new SsrfBlockedError('credentials in the url are not allowed')
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  if (!host) throw new SsrfBlockedError('empty host')
  if (BLOCKED_HOSTNAMES.has(host)) throw new SsrfBlockedError(`blocked host: ${host}`)
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new SsrfBlockedError(`blocked host suffix: ${host}`)
  if (isBlockedIpv4(host)) throw new SsrfBlockedError(`blocked private/loopback IPv4: ${host}`)
  if (isBlockedIpv6(host)) throw new SsrfBlockedError(`blocked private/loopback IPv6: ${host}`)
  if (opts.selfHosts?.some((s) => s && s.toLowerCase() === host)) throw new SsrfBlockedError('a flow cannot call this instance')
  if (opts.selfScript && new RegExp(`^${opts.selfScript.toLowerCase().replace(/[^a-z0-9-]/g, '')}\\.[a-z0-9-]+\\.workers\\.dev$`).test(host)) {
    throw new SsrfBlockedError('a flow cannot call this instance')
  }
  if (opts.allowHosts && opts.allowHosts.length > 0) {
    const ok = opts.allowHosts.some((suffix) => {
      const s = suffix.toLowerCase()
      return host === s.replace(/^\./, '') || host.endsWith(s.startsWith('.') ? s : `.${s}`)
    })
    if (!ok) throw new SsrfBlockedError(`host not in egress allowlist: ${host}`)
  }
  return url
}

const CRED_HEADER = /^(authorization|proxy-authorization|cookie)$|api[-_]?key|token|secret/i

/** Headers an author may set: Content-Type, Accept, User-Agent and custom X-*. Everything else (Host, Cookie, Origin,
 * Referer, Connection, ...) is dropped; forwarding-style X- headers that can spoof the client are dropped too. */
const SPOOFING_X = /^x-(forwarded-|real-ip|original-|rewrite-url|http-method|host)/i
export function allowedRequestHeaders(h: HeadersInit | undefined, allowAuth = false): Headers {
  const out = new Headers()
  for (const [k, v] of new Headers(h)) {
    const lk = k.toLowerCase()
    if (lk === 'content-type' || lk === 'accept' || lk === 'user-agent' || (lk.startsWith('x-') && !SPOOFING_X.test(lk)) || (allowAuth && lk === 'authorization')) out.set(k, v)
  }
  return out
}

/** Drops credential-bearing headers (a cross-origin hop must not receive them). */
export function stripCredentials(h: HeadersInit | undefined): Headers {
  const out = new Headers(h)
  for (const k of [...out.keys()]) if (CRED_HEADER.test(k)) out.delete(k)
  return out
}

/**
 * SSRF-guarded fetch. Validates the literal URL and every redirect hop, applies timeout and size caps, strips
 * credentials on cross-origin hops, refuses cross-origin 307/308 and https->http hops, allow-lists request headers, and turns 303 (and POST on 301/302) into a bodyless GET.
 */
export async function safeFetch(rawUrl: string, init: RequestInit = {}, opts: SafeFetchOptions = {}): Promise<Response> {
  const timeoutMs = Math.min(opts.timeoutMs ?? HTTP_TIMEOUT_MS, HTTP_TIMEOUT_MS)
  const maxBytes = Math.min(opts.maxBytes ?? HTTP_MAX_BYTES, HTTP_MAX_BYTES)
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS

  let url = assertUrlAllowed(rawUrl, opts)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let cur: RequestInit = { ...init, headers: allowedRequestHeaders(init.headers, opts.allowAuth) }
  try {
    for (let hops = 0; ; hops++) {
      const res = await fetch(url.toString(), { ...cur, redirect: 'manual', signal: controller.signal })
      const loc = res.headers.get('location')
      if (!(res.status >= 300 && res.status < 400 && loc)) return await capBody(res, maxBytes)
      if (hops >= maxRedirects) throw new SsrfBlockedError(`too many redirects (>${maxRedirects})`)
      const next = assertUrlAllowed(new URL(loc, url).toString(), opts)
      if (url.protocol === 'https:' && next.protocol === 'http:') throw new SsrfBlockedError('refused a redirect from https to http')
      const method = (cur.method ?? 'GET').toUpperCase()
      // 307/308 re-send the method and body. Never to a different origin: the body may carry data meant for the first host.
      if ((res.status === 307 || res.status === 308) && next.origin !== url.origin && cur.body !== undefined && cur.body !== null) {
        void res.body?.cancel()
        throw new SsrfBlockedError(`refused a cross-origin ${res.status} redirect (the request body would be re-sent to ${next.host})`)
      }
      const toGet = res.status === 303 ? method !== 'GET' && method !== 'HEAD' : (res.status === 301 || res.status === 302) && method === 'POST'
      let headers = new Headers(cur.headers)
      if (next.origin !== url.origin) headers = stripCredentials(headers)
      if (toGet) {
        headers.delete('content-type'); headers.delete('content-length')
        cur = { ...cur, method: 'GET', body: undefined, headers }
      } else cur = { ...cur, headers }
      url = next
    }
  } catch (e) {
    if (e instanceof SsrfBlockedError) throw e
    if (e instanceof DOMException && e.name === 'AbortError') throw new SsrfBlockedError(`request timed out after ${timeoutMs}ms`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

async function capBody(res: Response, maxBytes: number): Promise<Response> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) { void res.body?.cancel(); throw new SsrfBlockedError(`response exceeded ${maxBytes} bytes`) }
  if (!res.body) return res
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.byteLength
      if (total > maxBytes) { void reader.cancel(); throw new SsrfBlockedError(`response exceeded ${maxBytes} bytes`) }
      chunks.push(value)
    }
  }
  const merged = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { merged.set(c, off); off += c.byteLength }
  return new Response(merged, { status: res.status, statusText: res.statusText, headers: res.headers })
}
