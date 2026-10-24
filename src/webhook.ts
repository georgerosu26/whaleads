import type { Env } from './db'
import { logEvent } from './db'
import { ConfigUndecryptable, resolveForRoute, whabuzzSecretConfigured } from './adaptors'
import { CloudApiAdaptor } from './adaptors/cloud-api'
import type { AdaptorKind } from './adaptors/types'
import { processEvents } from './inbound'
import { connectPending } from './routes/connect'

/** GET /webhooks/meta: Meta's verify-token handshake. */
export async function verifyChallenge(url: URL, env: Env): Promise<Response> {
  const a = await resolveForRoute(env, 'cloud_api')
  return a instanceof CloudApiAdaptor ? a.verifyChallenge(url) : new Response('forbidden', { status: 403 })
}

/** The challenge of a `webhook.verify` body, or null when the body is anything else (or the challenge is not a short printable string). */
export function verifyPing(raw: string): string | null {
  if (raw.length > 2048) return null
  let j: any
  try { j = JSON.parse(raw) } catch { return null }
  if (!j || typeof j !== 'object' || Array.isArray(j) || j.type !== 'webhook.verify') return null
  return typeof j.challenge === 'string' && /^[\x21-\x7e]{1,256}$/.test(j.challenge) ? j.challenge : null
}

function scrub(body: any): unknown {
  // WhaBuzz envelopes carry the full Meta POST in `raw`; the event log keeps the envelope without it.
  if (body && typeof body === 'object' && !Array.isArray(body) && 'raw' in body) { const { raw: _r, ...rest } = body; return rest }
  return body
}

/**
 * POST /webhooks/meta and POST /webhooks/whabuzz. Verify -> parse -> shared pipeline.
 * /meta always answers 200 once the signature is good (Meta retry-storms otherwise, and the
 * first version behaved so). /whabuzz answers 500 if the pipeline fails: WhaBuzz retries and the pipeline is idempotent.
 */
export async function handleWebhook(kind: AdaptorKind, req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const raw = await req.text()

  // Connect with WhaBuzz: before it issues anything WhaBuzz POSTs a verify ping that is signed with a secret we do not
  // have yet. That one event type, and nothing else, is accepted unsigned, and only while (a) no WhaBuzz webhook secret
  // is saved or (b) a connect is pending. Every other event, in every state, still needs a valid signature (below).
  if (kind === 'whabuzz') {
    const ping = verifyPing(raw)
    if (ping && (!(await whabuzzSecretConfigured(env)) || (await connectPending(env)))) {
      return new Response(ping, { status: 200, headers: { 'content-type': 'text/plain' } })
    }
  }

  let adaptor
  try {
    adaptor = await resolveForRoute(env, kind)
  } catch (e) {
    if (e instanceof ConfigUndecryptable) return new Response(`${kind} adaptor config is undecryptable (check SESSION_SECRET)`, { status: 503 })
    throw e
  }
  if (!adaptor) return new Response(`${kind} adaptor not configured`, { status: 401 })

  if (!(await adaptor.verifyWebhook(req, raw))) return new Response('invalid signature', { status: 401 })

  let json: any
  try { json = JSON.parse(raw) } catch { return new Response('bad json', { status: 400 }) }

  // WhaBuzz verify ping (SPEC-v1 7.4): signed POST, pass = 2xx with the challenge echoed back as plain text.
  if (kind === 'whabuzz' && json && !Array.isArray(json) && json.type === 'webhook.verify' && typeof json.challenge === 'string') {
    return new Response(json.challenge, { status: 200, headers: { 'content-type': 'text/plain' } })
  }

  let ignored = 0
  let events
  try { events = adaptor.parseWebhook(raw, (n) => { ignored += n }) } catch { return new Response('bad json', { status: 400 }) }
  if (ignored) await logEvent(env.DB, 'ignored_other_number', { route: kind, count: ignored })
  await logEvent(env.DB, 'webhook', { route: kind, body: scrub(json) })

  try {
    await processEvents(env, ctx, events)
  } catch (e) {
    await logEvent(env.DB, 'webhook_error', { route: kind, error: String(e) })
    if (kind === 'whabuzz') return new Response('processing error', { status: 500 })
  }
  return new Response('ok', { status: 200 })
}
