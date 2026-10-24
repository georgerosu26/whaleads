// security headers on Worker responses (API, webhooks, media keeps its sandbox CSP, WS upgrades untouched),
// and the SPA's _headers carries a CSP that fits the built index.html.
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import worker from '../src/index'
import type { Env } from '../src/db'
import { withSecurityHeaders } from '../src/headers'
import { ctx } from './helpers'
import { fakeD1 } from './d1'

let env: Env
beforeEach(() => {
  env = { DB: fakeD1().d1, ADMIN_KEY: 'adminkey', SESSION_SECRET: 'sess', INSTANCE_NAME: 't', ALLOWED_ORIGINS: '' } as unknown as Env
})

const expectHardened = (res: Response) => {
  expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  expect(res.headers.get('X-Frame-Options')).toBe('DENY')
  expect(res.headers.get('Referrer-Policy')).toBe('same-origin')
  expect(res.headers.get('Permissions-Policy')).toContain('camera=()')
}

describe('Worker security headers', () => {
  it('API responses (ok, 401, 404) carry the headers and a locked-down CSP', async () => {
    for (const [path, init] of [['/api/health', {}], ['/api/leads', {}], ['/api/nope', { headers: { Authorization: 'Bearer adminkey' } }]] as const) {
      const res = await worker.fetch(new Request('https://x' + path, init), env, ctx)
      expectHardened(res)
      expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'none'; frame-ancestors 'none'")
    }
  })
  it('the send path (Server-Timing wrapper) is covered too', async () => {
    const res = await worker.fetch(new Request('https://x/api/send', { method: 'POST', body: '{}' }), env, ctx)
    expectHardened(res)
  })
  it('webhook verify ping is covered', async () => {
    const res = await worker.fetch(new Request('https://x/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=no&hub.challenge=1'), env, ctx)
    expectHardened(res)
  })
  it('keeps a response\'s own CSP (media sandbox) and does not override set headers', () => {
    const res = withSecurityHeaders(new Response('x', { headers: { 'Content-Security-Policy': 'sandbox', 'Referrer-Policy': 'no-referrer' } }))
    expect(res.headers.get('Content-Security-Policy')).toBe('sandbox')
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
  })
  it('passes WebSocket upgrades through unchanged', () => {
    const ws = { status: 101, webSocket: {} } as unknown as Response
    expect(withSecurityHeaders(ws)).toBe(ws)
  })
})

describe('SPA _headers', () => {
  const file = readFileSync(new URL('../ui/public/_headers', import.meta.url), 'utf8')
  const csp = /Content-Security-Policy: (.+)/.exec(file)?.[1] ?? ''
  it('sets a CSP with no inline/eval script and no framing', () => {
    expect(csp).toMatch(/script-src 'self'(;|$)/)
    expect(csp).not.toMatch(/unsafe-eval/)
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("worker-src 'self'")
    expect(csp).toMatch(/connect-src 'self'/)
    expect(file).toContain('X-Frame-Options: DENY')
  })
  it('the app shell has no inline script the CSP would block', () => {
    const html = readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8')
    for (const tag of html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) ?? []) expect(tag).toMatch(/\bsrc=/)
  })
})
