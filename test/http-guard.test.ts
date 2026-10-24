import { afterEach, describe, expect, it, vi } from 'vitest'
import { HTTP_MAX_BYTES, SsrfBlockedError, assertUrlAllowed, safeFetch } from '../src/flows/http-guard'

afterEach(() => vi.unstubAllGlobals())

describe('assertUrlAllowed', () => {
  const blocked = [
    'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://[::1]/', 'http://[::]/',
    'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[64:ff9b::7f00:1]/', 'http://[2002:7f00:1::]/',
    'http://169.254.169.254/latest/meta-data', 'http://[::ffff:a9fe:a9fe]/', 'http://[fe80::1]/', 'http://[fc00::1]/', 'http://[fd12::1]/',
    'http://10.0.0.5/', 'http://192.168.1.1/', 'http://172.16.0.1/', 'http://100.64.0.1/', 'http://0.0.0.0/',
    'http://localhost/', 'http://metadata.google.internal/', 'http://printer.local/', 'http://svc.internal/',
    'ftp://example.com/', 'file:///etc/passwd', 'http://user:pw@example.com/', 'not a url',
  ]
  for (const u of blocked) it(`blocks ${u}`, () => expect(() => assertUrlAllowed(u)).toThrow(SsrfBlockedError))

  it('allows ordinary public hosts and public IPv6', () => {
    for (const u of ['https://example.com/x', 'http://93.184.216.34/', 'https://[2606:4700:4700::1111]/']) expect(() => assertUrlAllowed(u)).not.toThrow()
  })
  it('blocks the instance itself and its workers.dev name', () => {
    expect(() => assertUrlAllowed('https://leads.example.org/api', { selfHosts: ['leads.example.org'] })).toThrow(/this instance/i)
    expect(() => assertUrlAllowed('https://myscript.acct.workers.dev/', { selfScript: 'myscript' })).toThrow(SsrfBlockedError)
    expect(() => assertUrlAllowed('https://other.acct.workers.dev/', { selfScript: 'myscript' })).not.toThrow()
  })
  it('honours an allowlist of host suffixes', () => {
    expect(() => assertUrlAllowed('https://api.good.com/', { allowHosts: ['good.com'] })).not.toThrow()
    expect(() => assertUrlAllowed('https://evil.com/', { allowHosts: ['good.com'] })).toThrow(SsrfBlockedError)
  })
})

const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } })

describe('safeFetch redirects', () => {
  it('strips authorization / cookie on a cross-origin hop, keeps them same-origin', async () => {
    const seen: Headers[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      seen.push(new Headers(init.headers))
      if (url === 'https://a.example.com/start') return redirect('https://a.example.com/same')
      if (url === 'https://a.example.com/same') return redirect('https://b.example.net/other')
      return new Response('ok')
    }))
    const res = await safeFetch('https://a.example.com/start', { headers: { Authorization: 'Bearer s', Cookie: 'c=1', 'X-Api-Key': 'k', 'X-Keep': '1' } }, { allowAuth: true })
    expect(await res.text()).toBe('ok')
    expect(seen[1].get('authorization')).toBe('Bearer s') // same origin
    expect(seen[2].get('authorization')).toBeNull() // cross-origin
    expect(seen[2].get('cookie')).toBeNull()
    expect(seen[2].get('x-api-key')).toBeNull()
    expect(seen[2].get('x-keep')).toBe('1')
    expect(seen[0].get('cookie')).toBeNull() // Cookie is never sent, even to the first origin
  })
  it('re-validates every hop: a redirect to the metadata IP is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => redirect('http://169.254.169.254/latest')))
    await expect(safeFetch('https://example.com/')).rejects.toThrow(SsrfBlockedError)
  })
  it('a redirect to a mapped-loopback literal is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => redirect('http://[::ffff:7f00:1]/')))
    await expect(safeFetch('https://example.com/')).rejects.toThrow(SsrfBlockedError)
  })
  it('303 and POST-on-302 become a bodyless GET; 307 keeps the method and body', async () => {
    const calls: { method?: string; body?: unknown }[] = []
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => { calls.push({ method: init.method, body: init.body }); return ++n === 1 ? redirect('https://example.com/b', 303) : new Response('x') }))
    await safeFetch('https://example.com/a', { method: 'POST', body: 'payload', headers: { 'content-type': 'text/plain' } })
    expect(calls[1]).toEqual({ method: 'GET', body: undefined })
    calls.length = 0; n = 0
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => { calls.push({ method: init.method, body: init.body }); return ++n === 1 ? redirect('https://example.com/b', 307) : new Response('x') }))
    await safeFetch('https://example.com/a', { method: 'POST', body: 'payload' })
    expect(calls[1]).toEqual({ method: 'POST', body: 'payload' })
  })
  it('stops after 3 redirects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => redirect('https://example.com/loop')))
    await expect(safeFetch('https://example.com/')).rejects.toThrow(/too many redirects/)
  })
})

describe('safeFetch limits', () => {
  it('refuses a declared or streamed body over the cap', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { headers: { 'content-length': String(HTTP_MAX_BYTES + 1) } })))
    await expect(safeFetch('https://example.com/')).rejects.toThrow(/exceeded/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(HTTP_MAX_BYTES + 10))))
    await expect(safeFetch('https://example.com/')).rejects.toThrow(/exceeded/)
  })
  it('returns a small body intact', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('hello', { status: 201 })))
    const res = await safeFetch('https://example.com/')
    expect(res.status).toBe(201)
    expect(await res.text()).toBe('hello')
  })
  it('aborts on timeout with a clear error', async () => {
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise((_, rej) => init.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))))))
    await expect(safeFetch('https://example.com/', {}, { timeoutMs: 20 })).rejects.toThrow(/timed out/)
  })
})

// The review's 24 literal / redirect / header cases (all expectations now decided: the previously open ones are refused).
describe('assertUrlAllowed: review literals', () => {
  const cases: [string, boolean][] = [
    ['http://[::ffff:7f00:0001]/', true], ['http://[0:0:0:0:0:ffff:127.0.0.1]/', true], ['http://[::ffff:169.254.169.254]/', true],
    ['http://[64:ff9b::a9fe:a9fe]/', true], ['http://[64:ff9b::8.8.8.8]/', true],
    ['http://[2002:a9fe:a9fe::1]/', true], ['http://[2002:0808:0808::1]/', false],
    ['http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/', true], // Teredo 2001::/32
    ['http://[64:ff9b:1::a00:1]/', true], // 64:ff9b:1::/48
    ['http://[::ffff:0:7f00:1]/', true], // SIIT
    ['http://[::ffff:8.8.8.8]/', true], // the whole ::ffff:0:0/96
    ['http://100.127.255.255/', true], ['http://100.128.0.1/', false], ['http://169.254.169.254./', true],
    ['http://0177.0.0.1/', true], ['http://0x7f000001/', true], ['http://127.000.000.001/', true],
    ['http://[fec0::1]/', true], // fec0::/10
    ['http://LOCALHOST./', true], ['http://foo.localhost/', true], ['http://[::1%25eth0]/', true],
    ['https://xn--bcher-kva.example/', false], ['https://xn--localhost/', true],
  ]
  for (const [u, want] of cases) it(`${want ? 'blocks' : 'allows'} ${u}`, () => {
    let blocked = false
    try { assertUrlAllowed(u) } catch (e) { blocked = e instanceof SsrfBlockedError }
    expect(blocked).toBe(want)
  })
})

describe('safeFetch: redirect and header policy', () => {
  it('refuses a cross-origin 307 and 308 that would re-send the body', async () => {
    for (const status of [307, 308]) {
      const fetchMock = vi.fn(async () => redirect('https://evil.example.net/x', status))
      vi.stubGlobal('fetch', fetchMock)
      await expect(safeFetch('https://good.example.com/a', { method: 'POST', body: '{"secret":"s"}' })).rejects.toThrow(/cross-origin/)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  })
  it('a cross-origin 302 on a GET still follows (no body to leak)', async () => {
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async () => (++n === 1 ? redirect('https://other.example.net/x') : new Response('ok'))))
    expect(await (await safeFetch('https://good.example.com/a')).text()).toBe('ok')
  })
  it('refuses an https to http redirect', async () => {
    const fetchMock = vi.fn(async () => redirect('http://good.example.com/a'))
    vi.stubGlobal('fetch', fetchMock)
    await expect(safeFetch('https://good.example.com/a')).rejects.toThrow(/https to http/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('sends only Content-Type, Accept, User-Agent and X-* by default; Host, Cookie, Authorization, Origin are dropped', async () => {
    let h: Record<string, string> = {}
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => { h = Object.fromEntries(new Headers(init.headers)); return new Response('x') }))
    await safeFetch('https://good.example.com/a', { headers: { host: 'internal.example', cookie: 'a=1', authorization: 'Bearer t', origin: 'https://x', 'x-forwarded-for': '10.0.0.1', 'content-type': 'application/json', accept: '*/*', 'user-agent': 'ua', 'x-custom': '1' } })
    expect(h).toEqual({ 'content-type': 'application/json', accept: '*/*', 'user-agent': 'ua', 'x-custom': '1' })
  })
  it('Authorization is sent only when the node sets it, and not past a cross-origin hop', async () => {
    const seen: (string | null)[] = []
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => { seen.push(new Headers(init.headers).get('authorization')); return ++n === 1 ? redirect('https://other.example.net/x') : new Response('x') }))
    await safeFetch('https://good.example.com/a', { headers: { authorization: 'Bearer t' } }, { allowAuth: true })
    expect(seen).toEqual(['Bearer t', null])
  })
})
