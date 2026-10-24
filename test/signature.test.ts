import { describe, expect, it } from 'vitest'
import { CloudApiAdaptor } from '../src/adaptors/cloud-api'
import { WhaBuzzAdaptor, verifySignatureHeader } from '../src/adaptors/whabuzz'
import { fixture, metaSig, sign } from './helpers'

const SECRET = 'whsec_TEST_testsecret_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const NEW = 'whsec_TEST_newsecret_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const raw = JSON.stringify(fixture('text'))
const now = () => Math.floor(Date.now() / 1000)
const wb = (secret = SECRET) => new WhaBuzzAdaptor({ api_key: 'k', phone_number_id: '1', waba_id: '2', webhook_secret: secret })
const req = (headers: Record<string, string>) => new Request('https://x/webhooks/whabuzz', { method: 'POST', headers, body: raw })

describe('WhaBuzz signature (X-WhaBuzz-Signature)', () => {
  it('accepts a valid signature', async () => {
    expect(await wb().verifyWebhook(req({ 'X-WhaBuzz-Signature': sign([SECRET], raw, now()) }), raw)).toBe(true)
  })
  it('rejects a tampered body', async () => {
    const h = sign([SECRET], raw, now())
    expect(await wb().verifyWebhook(req({ 'X-WhaBuzz-Signature': h }), raw + ' ')).toBe(false)
  })
  it('rejects a stale timestamp (>300 s) and a future one', async () => {
    expect(await wb().verifyWebhook(req({ 'X-WhaBuzz-Signature': sign([SECRET], raw, now() - 301) }), raw)).toBe(false)
    expect(await wb().verifyWebhook(req({ 'X-WhaBuzz-Signature': sign([SECRET], raw, now() + 301) }), raw)).toBe(false)
    expect(await wb().verifyWebhook(req({ 'X-WhaBuzz-Signature': sign([SECRET], raw, now() - 299) }), raw)).toBe(true)
  })
  it('rejects wrong secret, missing and malformed headers', async () => {
    expect(await wb('whsec_TEST_other').verifyWebhook(req({ 'X-WhaBuzz-Signature': sign([SECRET], raw, now()) }), raw)).toBe(false)
    expect(await wb().verifyWebhook(req({}), raw)).toBe(false)
    expect(await wb().verifyWebhook(req({ 'X-WhaBuzz-Signature': 'garbage' }), raw)).toBe(false)
    expect(await wb('').verifyWebhook(req({ 'X-WhaBuzz-Signature': sign([''], raw, now()) }), raw)).toBe(false)
  })
  it('accepts multiple v1 values during rotation (either order, either secret)', async () => {
    const t = now()
    expect(await wb(NEW).verifyWebhook(req({ 'X-WhaBuzz-Signature': sign([NEW, SECRET], raw, t) }), raw)).toBe(true)
    // consumer still on the old secret, sender signing with both
    expect(await wb(SECRET).verifyWebhook(req({ 'X-WhaBuzz-Signature': sign([NEW, SECRET], raw, t) }), raw)).toBe(true)
    // consumer holds both secrets
    expect(await wb(`${NEW},${SECRET}`).verifyWebhook(req({ 'X-WhaBuzz-Signature': sign([SECRET], raw, t) }), raw)).toBe(true)
  })
  it('reports the reason', async () => {
    const t = 1_000_000
    expect((await verifySignatureHeader(sign([SECRET], raw, t), raw, [SECRET], t + 301)).reason).toBe('stale')
    expect((await verifySignatureHeader(sign([SECRET], raw, t), raw, ['nope'], t)).reason).toBe('mismatch')
    expect((await verifySignatureHeader('t=abc', raw, [SECRET], t)).reason).toBe('malformed')
  })
})

describe('Cloud API signature (X-Hub-Signature-256)', () => {
  const cloud = (app_secret = 'appsecret') => new CloudApiAdaptor({ system_token: 't', app_secret, phone_number_id: '1', waba_id: '2' })
  const r = (sig: string) => new Request('https://x/webhooks/meta', { method: 'POST', headers: { 'X-Hub-Signature-256': sig }, body: raw })
  it('accepts valid, rejects tampered / wrong / missing / unset secret', async () => {
    expect(await cloud().verifyWebhook(r(metaSig('appsecret', raw)), raw)).toBe(true)
    expect(await cloud().verifyWebhook(r(metaSig('appsecret', raw)), raw + 'x')).toBe(false)
    expect(await cloud().verifyWebhook(r(metaSig('other', raw)), raw)).toBe(false)
    expect(await cloud().verifyWebhook(r(''), raw)).toBe(false)
    expect(await cloud('').verifyWebhook(r(metaSig('', raw)), raw)).toBe(false)
  })
})
