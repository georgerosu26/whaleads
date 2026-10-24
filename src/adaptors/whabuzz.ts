// WhaBuzz adaptor: the easy path to Meta. https://api.whabuzz.com/v1, Bearer API key.
// Webhooks: X-WhaBuzz-Signature `t=<unix>,v1=<hex>[,v1=<hex>]`, v1 = HMAC-SHA256(secret, "<t>.<raw body>"),
// 300 s tolerance (mirrors whabuzz packages/core/src/webhooks/sign.ts verifySignature).
import { timedFetch } from '../timing'
import type {
  AdaptorError, AdaptorResult, InboundEvent, MediaFetch, MediaSend, MetaAdaptor, NumberStatus, SendContext, SendResult, TemplateAdaptor, TemplateButtonSend, TemplateHeaderSend, WhaBuzzConfig,
} from './types'
import { contactNames, messageEvent, statusEvent } from './meta-parse'
import { hmacHex, mediaObject, metaMessage, netError, safeEqual, templateComponents } from './util'

export const DEFAULT_BASE = 'https://api.whabuzz.com/v1'

/** The API key is sent as a Bearer to this host, so only whabuzz.com hosts over https are accepted (plus loopback http, for local mock servers). */
export function resolveBaseUrl(raw?: string): string {
  const v = raw?.trim()
  if (!v) return DEFAULT_BASE
  let u: URL
  try { u = new URL(v) } catch { throw new Error(`WHABUZZ_BASE_URL is not a valid URL: ${v}`) }
  const host = u.hostname.toLowerCase()
  // Loopback http is allowed so a local mock can stand in for the API in dev/e2e; it can never leave the machine.
  const loopback = u.protocol === 'http:' && !u.username && !u.password && (host === 'localhost' || host === '127.0.0.1' || host === '[::1]')
  if (loopback) return v.replace(/\/+$/, '')
  if (u.protocol !== 'https:' || u.username || u.password || !(host === 'api.whabuzz.com' || host.endsWith('.whabuzz.com'))) {
    throw new Error('WHABUZZ_BASE_URL must be an https URL on api.whabuzz.com or a .whabuzz.com host')
  }
  return v.replace(/\/+$/, '')
}
/** The API root (no `/v1`): where POST /connect/token lives. Derived from WHABUZZ_BASE_URL, so it obeys the same host rules. */
export function resolveApiRoot(raw?: string): string {
  return resolveBaseUrl(raw).replace(/\/v1$/, '')
}
/** Host of the hosted Connect page the admin's browser is sent to. Same rules as resolveBaseUrl: https on whabuzz.com, loopback http for local stubs. */
/** There is no default: Connect is off until WHABUZZ_CONNECT_BASE is set (connectAvailable). */
export function resolveConnectBase(raw?: string): string {
  const v = raw?.trim()
  if (!v) throw new Error('WHABUZZ_CONNECT_BASE is not set')
  let u: URL
  try { u = new URL(v) } catch { throw new Error(`WHABUZZ_CONNECT_BASE is not a valid URL: ${v}`) }
  const host = u.hostname.toLowerCase()
  const loopback = u.protocol === 'http:' && !u.username && !u.password && (host === 'localhost' || host === '127.0.0.1' || host === '[::1]')
  if (!loopback && (u.protocol !== 'https:' || u.username || u.password || !(host === 'whabuzz.com' || host.endsWith('.whabuzz.com')))) {
    throw new Error('WHABUZZ_CONNECT_BASE must be an https URL on a .whabuzz.com host')
  }
  return v.replace(/\/+$/, '')
}
export const SIGNATURE_TOLERANCE_S = 300
export const SIGNATURE_HEADER = 'X-WhaBuzz-Signature'

export interface SignatureCheck { ok: boolean; reason?: 'malformed' | 'stale' | 'mismatch' }

export async function verifySignatureHeader(
  header: string, rawBody: string, secrets: string[],
  nowSeconds: number = Math.floor(Date.now() / 1000), toleranceS: number = SIGNATURE_TOLERANCE_S,
): Promise<SignatureCheck> {
  let t = NaN
  const v1: string[] = []
  for (const part of header.split(',')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k === 't') t = Number(v)
    else if (k === 'v1') v1.push(v)
  }
  if (!Number.isFinite(t) || v1.length === 0) return { ok: false, reason: 'malformed' }
  if (Math.abs(nowSeconds - t) > toleranceS) return { ok: false, reason: 'stale' }
  for (const s of secrets) {
    if (!s) continue
    const want = await hmacHex(s, `${t}.${rawBody}`)
    if (v1.some((got) => safeEqual(got, want))) return { ok: true }
  }
  return { ok: false, reason: 'mismatch' }
}

/** Envelope types that carry a Lead Ads lead (not yet defined in WhaBuzz SPEC-v1 §6.1; matched by prefix). */
const isLeadType = (t: string) => t === 'lead' || t.startsWith('lead.')

export function parseEnvelope(env: any): InboundEvent[] {
  if (!env || typeof env !== 'object') return []
  const type = String(env.type ?? '')
  const data = env.data ?? {}
  if (type === 'message.inbound') {
    const e = messageEvent(data.message, contactNames(data.contacts))
    return e ? [e] : []
  }
  if (type === 'message.status') {
    const e = statusEvent(data.status)
    return e ? [e] : []
  }
  if (isLeadType(type)) return [{ kind: 'lead', id: env.id ? String(env.id) : null, data, raw: env.raw ?? data }]
  return [] // echo, outbound, template.*, number.*, account.*, history.* ... not needed by WhaLeads yet
}

export class WhaBuzzAdaptor implements MetaAdaptor {
  readonly kind = 'whabuzz' as const
  readonly onboarding = 'connect_button' as const
  readonly templates: TemplateAdaptor
  private base: string

  // baseUrl comes only from the deployment env (WHABUZZ_BASE_URL), never from stored or browser-supplied config.
  constructor(private cfg: WhaBuzzConfig, private fetchImpl: typeof fetch = (...a) => fetch(...a), baseUrl?: string) {
    this.fetchImpl = timedFetch(fetchImpl)
    this.base = resolveBaseUrl(baseUrl)
    this.templates = {
      list: (opts) => this.call(`/templates?waba_id=${encodeURIComponent(cfg.waba_id)}${opts?.name ? `&name=${encodeURIComponent(opts.name)}` : ''}`, { method: 'GET' }),
      // WhaBuzz deletes by template id; without one, look the id up by name first.
      delete: async (o) => {
        let id = o.id
        if (!id) {
          const l = await this.call(`/templates?waba_id=${encodeURIComponent(cfg.waba_id)}&name=${encodeURIComponent(o.name)}`, { method: 'GET' })
          if (!l.ok) return l
          id = l.data?.data?.[0]?.id
          if (!id) return { ok: false, status: 404, data: {}, error: { source: 'whabuzz', error: { message: 'Template not found' }, message: 'Template not found' } }
        }
        return this.call(`/templates/${encodeURIComponent(id)}`, { method: 'DELETE' })
      },
      create: (def) => this.call('/templates', { body: { waba_id: cfg.waba_id, ...def } }),
      syncStatus: async () => {
        const s = await this.call('/templates/sync', { body: { waba_id: cfg.waba_id } })
        return s.ok ? this.call(`/templates?waba_id=${encodeURIComponent(cfg.waba_id)}`, { method: 'GET' }) : s
      },
      mediaHandle: (bytes, mime) => {
        const form = new FormData()
        form.set('type', mime)
        form.set('file', new Blob([bytes as any], { type: mime }), 'sample')
        return this.call('/templates/media-handle', { form })
      },
    }
  }

  /** Never throws. WhaBuzz errors are `{source:'meta'|'whabuzz', error:{...}}`; passed through unchanged. */
  private async call(path: string, init: { method?: string; body?: unknown; form?: FormData } = {}): Promise<AdaptorResult> {
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${this.cfg.api_key}` }
      if (init.body !== undefined) headers['Content-Type'] = 'application/json'
      const res = await this.fetchImpl(`${this.base}${path}`, {
        method: init.method ?? 'POST', headers,
        body: init.form ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
      })
      const data: any = await res.json().catch(() => ({}))
      return { ok: res.ok, status: res.status, data, error: res.ok ? undefined : this.errorOf(res.status, data) }
    } catch (e) {
      return { ok: false, status: 0, data: {}, error: netError(e) }
    }
  }

  private errorOf(status: number, data: any): AdaptorError {
    const source: AdaptorError['source'] = data?.source === 'meta' ? 'meta' : 'whabuzz'
    const e = data?.error
    return { source, error: e ?? data, message: metaMessage(e, `HTTP ${status}`) }
  }

  private toSend(r: AdaptorResult): SendResult {
    return { ...r, wamid: r.data?.messages?.[0]?.id ?? null }
  }

  async status(): Promise<NumberStatus> {
    const r = await this.call(`/numbers/${encodeURIComponent(this.cfg.phone_number_id)}`, { method: 'GET' })
    if (!r.ok) return { ok: false, connected: false, display_number: null, verified_name: null, quality: null, tier: null, detail: r.error?.message ?? null, error: r.error, raw: r.data }
    const d = r.data
    return {
      ok: true, connected: d.connection_state === 'connected', display_number: d.display_phone_number ?? null, verified_name: d.verified_name ?? null,
      quality: d.quality_rating ?? null, tier: d.messaging_limit_tier ?? null, detail: d.connection_detail ?? d.connection_state ?? null, raw: d,
    }
  }

  async sendText(to: string, text: string, ctx?: SendContext): Promise<SendResult> {
    const body: Record<string, unknown> = { from: this.cfg.phone_number_id, messaging_product: 'whatsapp', to, type: 'text', text: { body: text, preview_url: false } }
    if (ctx?.replyTo) body.context = { message_id: ctx.replyTo }
    return this.toSend(await this.call('/messages', { body }))
  }

  async sendTemplate(to: string, name: string, lang: string, params: string[], header?: TemplateHeaderSend, buttons?: TemplateButtonSend[]): Promise<SendResult> {
    return this.toSend(await this.call('/messages', {
      body: {
        from: this.cfg.phone_number_id, messaging_product: 'whatsapp', to, type: 'template',
        template: { name, language: { code: lang }, components: templateComponents(params, header, buttons) },
      },
    }))
  }

  async sendMedia(to: string, media: MediaSend, ctx?: SendContext): Promise<SendResult> {
    const body: Record<string, unknown> = { from: this.cfg.phone_number_id, messaging_product: 'whatsapp', to, type: media.kind, [media.kind]: mediaObject(media) }
    if (ctx?.replyTo) body.context = { message_id: ctx.replyTo }
    return this.toSend(await this.call('/messages', { body }))
  }

  markRead(messageId: string): Promise<AdaptorResult> {
    return this.call('/messages/read', { body: { from: this.cfg.phone_number_id, message_id: messageId } })
  }

  async fetchMedia(mediaId: string): Promise<MediaFetch> {
    try {
      const res = await this.fetchImpl(`${this.base}/media/${encodeURIComponent(mediaId)}?from=${encodeURIComponent(this.cfg.phone_number_id)}`, {
        headers: { Authorization: `Bearer ${this.cfg.api_key}` },
      })
      if (!res.ok || !res.body) {
        const data: any = await res.json().catch(() => ({}))
        return { ok: false, status: res.status, error: this.errorOf(res.status, data) }
      }
      return { ok: true, bytes: res.body, mime: res.headers.get('content-type') ?? 'application/octet-stream' }
    } catch (e) {
      return { ok: false, status: 0, error: netError(e) }
    }
  }

  uploadMedia(bytes: ArrayBuffer | Uint8Array, mime: string): Promise<AdaptorResult<{ id?: string }>> {
    const form = new FormData()
    form.set('type', mime)
    form.set('from', this.cfg.phone_number_id)
    form.set('file', new Blob([bytes as any], { type: mime }), 'upload')
    return this.call('/media', { form })
  }

  async verifyWebhook(req: Request, rawBody: string): Promise<boolean> {
    const secrets = (this.cfg.webhook_secret ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    if (!secrets.length) return false
    return (await verifySignatureHeader(req.headers.get(SIGNATURE_HEADER) ?? '', rawBody, secrets)).ok
  }

  /** Envelopes for another of the tenant's numbers (phone_number_id set and different) are dropped; `onIgnored` counts them. */
  parseWebhook(rawBody: string, onIgnored?: (n: number) => void): InboundEvent[] {
    const body = JSON.parse(rawBody)
    let ignored = 0
    const out = (Array.isArray(body) ? body : [body]).flatMap((env) => {
      const pn = env?.phone_number_id
      if (pn != null && pn !== '' && String(pn) !== String(this.cfg.phone_number_id)) { ignored++; return [] }
      return parseEnvelope(env)
    })
    if (ignored) onIgnored?.(ignored)
    return out
  }
}

/** The Connect button is on only when the operator set WHABUZZ_CONNECT_BASE explicitly (to a valid host). */
export function connectAvailable(raw?: string): boolean {
  if (!raw?.trim()) return false
  try { resolveConnectBase(raw); return true } catch { return false }
}
