// Local stand-in for the WhaBuzz side of one-click Connect, shaped like the LIVE contract
// (see docs/ADAPTORS.md), served on PW_PORT + 1:
//   GET  /connect          hosted page (app, callback, state, code_challenge) with Approve / Cancel
//   GET  /approve          signed verify ping to <callback origin>/api/whabuzz/webhook, then 302 to the callback with code + state
//   GET  /cancel           302 to the callback with error=access_denied
//   POST /connect/token    API ROOT, not /v1: {app, code, state, code_verifier} -> credentials; S256, state and single use are checked
//   GET  /v1/numbers/:id   what status() calls after the exchange
// All identifiers are throwaway test values.
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'

export const STUB_PORT = Number(process.env.PW_PORT ?? 8799) + 1
export const STUB_PHONE_NUMBER_ID = '1000000000000002'
export const STUB_DISPLAY_NUMBER = '+1 555 0100'
export const STUB_API_KEY = 'wb_live_TEST_e2e_connect'
export const STUB_WEBHOOK_SECRET = 'whsec_TEST_e2e_connect'

export interface ConnectStub {
  server: Server
  /** Query strings the hosted page saw. */
  visits: URLSearchParams[]
  /** Verify pings sent to the app, with the status it answered and whether it echoed the challenge. */
  pings: { url: string; status: number; echoed: boolean }[]
  exchanges: { code: string; ok: boolean; body: Record<string, unknown> }[]
  /** Every path the app called on the API (exchange + numbers), to prove nothing forbidden is used. */
  apiCalls: string[]
  /** Set to a WhaBuzz error code to make the next exchange fail with it. */
  failExchange: string | null
  close(): Promise<void>
}

const s256 = (v: string) => createHash('sha256').update(v).digest('base64url')
const ERR_STATUS: Record<string, number> = { unknown_app: 400, invalid_code: 400, code_used: 410, code_expired: 410, connection_gone: 410, connection_unavailable: 409, rate_limited: 429 }

export async function startConnectStub(): Promise<ConnectStub> {
  const codes = new Map<string, { challenge: string; state: string; used: boolean }>()
  const stub: ConnectStub = { server: null as unknown as Server, visits: [], pings: [], exchanges: [], apiCalls: [], failExchange: null, close: async () => {} }
  stub.server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', `http://127.0.0.1:${STUB_PORT}`)
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString()
      const send = (status: number, o: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)) }
      const q = (k: string) => u.searchParams.get(k) ?? ''
      if (req.method === 'GET' && u.pathname === '/connect') {
        stub.visits.push(u.searchParams)
        const h = (k: string) => q(k).replace(/[<>"&]/g, '')
        const hidden = ['callback', 'state', 'code_challenge'].map((k) => `<input type="hidden" name="${k}" value="${h(k)}">`).join('')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>WhaBuzz Connect (stub)</title>
<body style="font-family:system-ui;max-width:420px;margin:48px auto;padding:0 16px"><h1>Connect ${h('app')}</h1><p>Test stand-in for the hosted WhaBuzz page.</p>
<form method="GET" action="/approve">${hidden}<button type="submit" style="padding:12px 20px;font-size:16px">Approve</button></form>
<form method="GET" action="/cancel" style="margin-top:12px">${hidden}<button type="submit" style="padding:12px 20px;font-size:16px">Cancel</button></form></body>`)
        return
      }
      if (req.method === 'GET' && (u.pathname === '/approve' || u.pathname === '/cancel')) {
        const callback = q('callback')
        const state = q('state')
        if (u.pathname === '/cancel') { res.writeHead(302, { Location: `${callback}?error=access_denied&state=${encodeURIComponent(state)}` }); res.end(); return }
        // Verify before issue: a signed ping to the instance's webhook, answered 2xx with the challenge or nothing is created.
        const challenge = randomBytes(16).toString('hex')
        const ping = JSON.stringify({ type: 'webhook.verify', challenge, endpoint_id: 'we_e2e_1', created_at: new Date().toISOString() })
        const t = Math.floor(Date.now() / 1000)
        const url = `${new URL(callback).origin}/api/whabuzz/webhook`
        try {
          const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'X-WhaBuzz-Signature': `t=${t},v1=${createHmac('sha256', STUB_WEBHOOK_SECRET).update(`${t}.${ping}`).digest('hex')}` }, body: ping, signal: AbortSignal.timeout(5000) })
          const text = await r.text()
          const echoed = text.trim() === challenge
          stub.pings.push({ url, status: r.status, echoed })
          if (!r.ok || !echoed) { res.writeHead(422, { 'content-type': 'text/plain' }); res.end('webhook_verify_failed'); return }
        } catch { stub.pings.push({ url, status: 0, echoed: false }); res.writeHead(422, { 'content-type': 'text/plain' }); res.end('webhook_verify_failed'); return }
        const code = randomBytes(32).toString('base64url') // 43 chars
        codes.set(code, { challenge: q('code_challenge'), state, used: false })
        res.writeHead(302, { Location: `${callback}?code=${code}&state=${encodeURIComponent(state)}` })
        res.end()
        return
      }
      if (req.method === 'POST' && u.pathname === '/connect/token') {
        stub.apiCalls.push(u.pathname)
        let b: any = {}
        try { b = JSON.parse(body) } catch { /* empty */ }
        const g = codes.get(String(b.code))
        const ok = !stub.failExchange && b.app === 'whaleads' && !!g && !g.used && g.state === b.state && (!g.challenge || s256(String(b.code_verifier)) === g.challenge)
        stub.exchanges.push({ code: String(b.code), ok, body: b })
        if (stub.failExchange) { const c = stub.failExchange; stub.failExchange = null; return send(ERR_STATUS[c] ?? 400, { error: { code: c, message: c } }) }
        if (!ok) return send(400, { error: { code: 'invalid_code', message: 'The code is invalid' } })
        g!.used = true
        return send(200, { api_key: STUB_API_KEY, webhook_secret: STUB_WEBHOOK_SECRET, phone_number_id: STUB_PHONE_NUMBER_ID, waba_id: '2605997', tenant_id: 'tenant_demo_1', display_phone_number: STUB_DISPLAY_NUMBER })
      }
      if (req.method === 'GET' && u.pathname === `/v1/numbers/${STUB_PHONE_NUMBER_ID}`) {
        stub.apiCalls.push(u.pathname)
        return send(200, { connection_state: 'connected', display_phone_number: STUB_DISPLAY_NUMBER, verified_name: 'Example Co', quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K' })
      }
      send(404, { error: { code: 'not_found' } })
    })
  })
  await new Promise<void>((r) => stub.server.listen(STUB_PORT, '127.0.0.1', r))
  stub.close = () => new Promise((r) => { stub.server.close(() => r()); stub.server.closeAllConnections() })
  return stub
}
