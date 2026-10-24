// per-actor limits on the state-changing / expensive routes that had none (src/routelimits.ts).
import { beforeEach, describe, expect, it } from 'vitest'
import worker from '../src/index'
import type { Env } from '../src/db'
import { routeLimit } from '../src/routelimits'
import { ctx } from './helpers'
import { fakeD1 } from './d1'

const SECRET = 'test-session-secret-0123456789'
const ORIGIN = 'https://leads.example.com'
let env: Env
let raw: ReturnType<typeof fakeD1>['raw']
type Opts = { cookie?: string; csrf?: string; bearer?: string }
const call = (method: string, path: string, body?: unknown, o: Opts = { bearer: 'adminkey' }) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (o.cookie) headers.Cookie = o.cookie
  if (o.csrf) headers['X-CSRF-Token'] = o.csrf
  if (method !== 'GET') headers.Origin = ORIGIN
  if (o.bearer) headers.Authorization = `Bearer ${o.bearer}`
  return worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx)
}

beforeEach(() => {
  const f = fakeD1(); raw = f.raw
  env = { DB: f.d1, ADMIN_KEY: 'adminkey', SESSION_SECRET: SECRET, INSTANCE_NAME: 'inst', ALLOWED_ORIGINS: '' } as unknown as Env
})

describe('route limits', () => {
  it('covers send, push test, template create, export and import', () => {
    for (const [m, p] of [['POST', '/api/send'], ['POST', '/api/inbox/4/send'], ['POST', '/api/inbox/4/send-media'], ['POST', '/api/inbox/4/send-template'],
      ['POST', '/api/push/test'], ['POST', '/api/templates'], ['GET', '/api/export/full.json'], ['GET', '/api/export/leads.csv'],
      ['POST', '/api/import/leads'], ['POST', '/api/import/leads/commit']] as const) expect(routeLimit(m, p), `${m} ${p}`).not.toBeNull()
    expect(routeLimit('GET', '/api/templates')).toBeNull()
    expect(routeLimit('GET', '/api/export/log')).toBeNull()
  })
  it('returns 429 with Retry-After once the export budget is spent', async () => {
    for (let i = 0; i < 10; i++) expect((await call('GET', '/api/export/leads.csv')).status).toBe(200)
    const r = await call('GET', '/api/export/leads.csv')
    expect(r.status).toBe(429)
    expect(r.headers.get('retry-after')).toBe('3600')
  })
  it('limits push tests to 5 a minute', async () => {
    const codes: number[] = []
    for (let i = 0; i < 6; i++) codes.push((await call('POST', '/api/push/test', {})).status)
    expect(codes.slice(0, 5)).not.toContain(429)
    expect(codes[5]).toBe(429)
  })
  it('a cross-site request (no CSRF token) does not spend the victim’s budget', async () => {
    const setup = await call('POST', '/api/setup', { setup_key: SECRET, business_name: 'Example Co', timezone: 'UTC', admin: { name: 'A', email: 'a@example.com', password: 'correct horse battery' } }, {})
    const cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0]!
    for (let i = 0; i < 8; i++) expect((await call('POST', '/api/push/test', {}, { cookie })).status).toBe(403)
    expect(raw.prepare(`SELECT COUNT(*) n FROM rate_limits WHERE key LIKE 'rl:%'`).get()).toEqual({ n: 0 })
  })
})
