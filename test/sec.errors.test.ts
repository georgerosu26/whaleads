// unhandled errors and the public health check never echo exception text.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import type { Env } from '../src/db'
import { encryptJson } from '../src/crypto'
import { ctx } from './helpers'
import { fakeD1 } from './d1'

let env: Env
let raw: ReturnType<typeof fakeD1>['raw']
beforeEach(() => {
  const f = fakeD1(); raw = f.raw
  env = { DB: f.d1, ADMIN_KEY: 'adminkey', SESSION_SECRET: 'sess', INSTANCE_NAME: 't', ALLOWED_ORIGINS: '' } as unknown as Env
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('error responses', () => {
  it('a thrown handler error returns a generic 500 with a ref, and logs the detail', async () => {
    const real = env.DB
    await worker.fetch(new Request('https://x/api/health'), env, ctx) // schema up
    ;(env as any).DB = new Proxy(real, { get: (t: any, p) => (p === 'prepare' ? (sql: string) => { if (/FROM staff/i.test(sql) && /ORDER BY/i.test(sql)) throw new Error('D1_ERROR: no such column: secret_col in SELECT pw_hash FROM staff'); return t.prepare(sql) } : t[p]) })
    const res = await worker.fetch(new Request('https://x/api/staff', { headers: { Authorization: 'Bearer adminkey' } }), env, ctx)
    expect(res.status).toBe(500)
    const body = await res.text()
    expect(body).not.toMatch(/D1_ERROR|pw_hash|secret_col/)
    expect(JSON.parse(body)).toMatchObject({ ok: false, error: 'internal error', ref: expect.stringMatching(/^[0-9a-f]{8}$/) })
    expect(String((console.error as any).mock.calls[0][0])).toContain('secret_col')
  })
  it('/api/health does not echo the adaptor exception', async () => {
    await worker.fetch(new Request('https://x/api/health'), env, ctx)
    raw.prepare(`INSERT INTO adaptor_config (id,kind,config_enc) VALUES (1,'whabuzz',?)`).run(await encryptJson('other-secret', { api_key: 'TEST_KEY_VALUE' }, 'whaleads/adaptor-config/v1'))
    const body = await (await worker.fetch(new Request('https://x/api/health'), env, ctx)).text()
    expect(JSON.parse(body)).toMatchObject({ ok: false, adaptor_error: expect.any(String) })
    expect(JSON.parse(body).detail).toBeUndefined()
  })
})
