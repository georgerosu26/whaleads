// Cloud API adaptor: Meta Graph API direct. Advanced path (manual credentials). WhatsApp only (D6).
import { timedFetch } from '../timing'
import type {
  AdaptorError, AdaptorResult, CloudApiConfig, InboundEvent, MediaFetch, MediaSend, MetaAdaptor, NumberStatus, SendContext, SendResult, TemplateAdaptor, TemplateButtonSend, TemplateHeaderSend,
} from './types'
import { parseMetaBody } from './meta-parse'
import { hmacHex, mediaObject, metaMessage, netError, safeEqual, templateComponents } from './util'

const DEFAULT_GRAPH = 'v22.0'

const MEDIA_ID = /^[A-Za-z0-9_-]{1,128}$/
const META_MEDIA_HOSTS = ['fbsbx.com', 'facebook.com', 'fbcdn.net', 'whatsapp.net']
/** The media download URL Graph hands back: https, no credentials, on a Meta host. Anything else never sees the token. */
export function metaMediaUrl(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  let u: URL
  try { u = new URL(raw) } catch { return false }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false
  const h = u.hostname.toLowerCase()
  return META_MEDIA_HOSTS.some((d) => h === d || h.endsWith(`.${d}`))
}

export class CloudApiAdaptor implements MetaAdaptor {
  readonly kind = 'cloud_api' as const
  readonly onboarding = 'manual_form' as const
  readonly templates: TemplateAdaptor

  constructor(private cfg: CloudApiConfig, private fetchImpl: typeof fetch = (...a) => fetch(...a)) {
    this.fetchImpl = timedFetch(fetchImpl)
    this.templates = {
      list: (opts) => this.listTemplates(opts),
      create: (def) => this.graph(`${cfg.waba_id}/message_templates`, { body: def }),
      // Graph has no "sync": approval status is always read live, so this is list().
      syncStatus: () => this.listTemplates(),
      delete: (o) => this.graph(`${cfg.waba_id}/message_templates?name=${encodeURIComponent(o.name)}${o.id ? `&hsm_id=${encodeURIComponent(o.id)}` : ''}`, { method: 'DELETE' }),
      mediaHandle: (bytes, mime) => this.mediaHandle(bytes, mime),
    }
  }

  private listTemplates(opts?: { name?: string; after?: string }): Promise<AdaptorResult> {
    const q = `fields=id,name,status,category,language,rejected_reason,quality_score,components&limit=100${opts?.name ? `&name=${encodeURIComponent(opts.name)}` : ''}${opts?.after ? `&after=${encodeURIComponent(opts.after)}` : ''}`
    return this.graph(`${this.cfg.waba_id}/message_templates?${q}`, { method: 'GET' })
  }

  private get version() { return this.cfg.graph_version || DEFAULT_GRAPH }

  /** Graph call. Never throws; Graph errors come back under `error` with source 'meta'. */
  async graph(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<AdaptorResult> {
    try {
      const res = await this.fetchImpl(`https://graph.facebook.com/${this.version}/${path}`, {
        method: init.method ?? 'POST',
        headers: { Authorization: `Bearer ${init.token ?? this.cfg.system_token}`, 'Content-Type': 'application/json' },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      })
      const data: any = await res.json().catch(() => ({}))
      let error: AdaptorError | undefined
      if (!res.ok || data?.error) {
        const e = data?.error
        error = { source: 'meta', error: e ?? data, message: metaMessage(e, `HTTP ${res.status}`) }
      }
      return { ok: res.ok && !error, status: res.status, data, error }
    } catch (e) {
      return { ok: false, status: 0, data: {}, error: netError(e) }
    }
  }

  private toSend(r: AdaptorResult): SendResult {
    return { ...r, wamid: r.data?.messages?.[0]?.id ?? null }
  }

  async status(): Promise<NumberStatus> {
    const r = await this.graph(`${this.cfg.phone_number_id}?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier,status`, { method: 'GET' })
    if (!r.ok) {
      return { ok: false, connected: false, display_number: null, verified_name: null, quality: null, tier: null, detail: r.error?.message ?? null, error: r.error, raw: r.data }
    }
    const d = r.data
    return {
      ok: true, connected: d.status === 'CONNECTED', display_number: d.display_phone_number ?? null, verified_name: d.verified_name ?? null,
      quality: d.quality_rating ?? null, tier: d.messaging_limit_tier ?? null, detail: d.status ?? null, raw: d,
    }
  }

  async sendText(to: string, text: string, ctx?: SendContext): Promise<SendResult> {
    const body: Record<string, unknown> = { messaging_product: 'whatsapp', to, type: 'text', text: { body: text, preview_url: false } }
    if (ctx?.replyTo) body.context = { message_id: ctx.replyTo }
    return this.toSend(await this.graph(`${this.cfg.phone_number_id}/messages`, { body }))
  }

  async sendTemplate(to: string, name: string, lang: string, params: string[], header?: TemplateHeaderSend, buttons?: TemplateButtonSend[]): Promise<SendResult> {
    return this.toSend(await this.graph(`${this.cfg.phone_number_id}/messages`, {
      body: {
        messaging_product: 'whatsapp', to, type: 'template',
        template: { name, language: { code: lang }, components: templateComponents(params, header, buttons) },
      },
    }))
  }

  async sendMedia(to: string, media: MediaSend, ctx?: SendContext): Promise<SendResult> {
    const body: Record<string, unknown> = { messaging_product: 'whatsapp', to, type: media.kind, [media.kind]: mediaObject(media) }
    if (ctx?.replyTo) body.context = { message_id: ctx.replyTo }
    return this.toSend(await this.graph(`${this.cfg.phone_number_id}/messages`, { body }))
  }

  markRead(messageId: string): Promise<AdaptorResult> {
    return this.graph(`${this.cfg.phone_number_id}/messages`, { body: { messaging_product: 'whatsapp', status: 'read', message_id: messageId } })
  }

  async fetchMedia(mediaId: string): Promise<MediaFetch> {
    // the id becomes a Graph path segment, and the download carries the system token, so both are pinned: a
    // plain id only (no "/", "?", ".."), and the download URL Graph returns must be https on a Meta media host.
    if (!MEDIA_ID.test(mediaId)) return { ok: false, status: 0, error: { source: 'meta', error: { media_id: 'invalid' }, message: 'invalid media id' } }
    const meta = await this.graph(encodeURIComponent(mediaId), { method: 'GET' })
    if (!meta.ok || !meta.data?.url) {
      return { ok: false, status: meta.status, error: meta.error ?? { source: 'meta', error: meta.data, message: 'no media url' } }
    }
    if (!metaMediaUrl(meta.data.url)) return { ok: false, status: 0, error: { source: 'meta', error: { url: 'refused' }, message: 'media url is not on a Meta media host' } }
    try {
      const res = await this.fetchImpl(meta.data.url, { headers: { Authorization: `Bearer ${this.cfg.system_token}` } })
      if (!res.ok || !res.body) return { ok: false, status: res.status, error: { source: 'meta', error: { status: res.status }, message: `media download HTTP ${res.status}` } }
      return { ok: true, bytes: res.body, mime: res.headers.get('content-type') ?? meta.data.mime_type ?? 'application/octet-stream' }
    } catch (e) {
      return { ok: false, status: 0, error: netError(e) }
    }
  }

  async uploadMedia(bytes: ArrayBuffer | Uint8Array, mime: string): Promise<AdaptorResult<{ id?: string }>> {
    const form = new FormData()
    form.set('messaging_product', 'whatsapp')
    form.set('type', mime)
    form.set('file', new Blob([bytes as any], { type: mime }), 'upload')
    try {
      const res = await this.fetchImpl(`https://graph.facebook.com/${this.version}/${this.cfg.phone_number_id}/media`, {
        method: 'POST', headers: { Authorization: `Bearer ${this.cfg.system_token}` }, body: form,
      })
      const data: any = await res.json().catch(() => ({}))
      const error: AdaptorError | undefined = !res.ok || data?.error ? { source: 'meta', error: data?.error ?? data, message: metaMessage(data?.error, `HTTP ${res.status}`) } : undefined
      return { ok: !error, status: res.status, data, error }
    } catch (e) {
      return { ok: false, status: 0, data: {}, error: netError(e) }
    }
  }

  /** Resumable-upload handle for media-header templates (needs app_id). */
  private async mediaHandle(bytes: ArrayBuffer | Uint8Array, mime: string): Promise<AdaptorResult> {
    if (!this.cfg.app_id) return { ok: false, status: 0, data: {}, error: { source: 'network', error: 'app_id missing', message: 'app_id is required for template media handles' } }
    const len = bytes instanceof Uint8Array ? bytes.byteLength : bytes.byteLength
    const session = await this.graph(`${this.cfg.app_id}/uploads?file_length=${len}&file_type=${encodeURIComponent(mime)}`)
    if (!session.ok || !session.data?.id) return session
    try {
      const res = await this.fetchImpl(`https://graph.facebook.com/${this.version}/${session.data.id}`, {
        method: 'POST', headers: { Authorization: `OAuth ${this.cfg.system_token}`, file_offset: '0' }, body: bytes as BodyInit,
      })
      const data: any = await res.json().catch(() => ({}))
      const error: AdaptorError | undefined = !res.ok || data?.error ? { source: 'meta', error: data?.error ?? data, message: metaMessage(data?.error, `HTTP ${res.status}`) } : undefined
      return { ok: !error, status: res.status, data, error }
    } catch (e) {
      return { ok: false, status: 0, data: {}, error: netError(e) }
    }
  }

  async verifyWebhook(req: Request, rawBody: string): Promise<boolean> {
    if (!this.cfg.app_secret) return false
    const header = req.headers.get('X-Hub-Signature-256') ?? ''
    return safeEqual(header, 'sha256=' + (await hmacHex(this.cfg.app_secret, rawBody)))
  }

  parseWebhook(rawBody: string): InboundEvent[] {
    return parseMetaBody(JSON.parse(rawBody))
  }

  // ---- Cloud-API-only operations (setup of the direct webhook) ------------------------------

  subscribeWaba(): Promise<AdaptorResult> {
    return this.graph(`${this.cfg.waba_id}/subscribed_apps`)
  }

  /** Register the callback at app level (app token APP_ID|APP_SECRET). */
  subscribeApp(callbackUrl: string): Promise<AdaptorResult> {
    return this.graph(`${this.cfg.app_id}/subscriptions`, {
      token: `${this.cfg.app_id}|${this.cfg.app_secret}`,
      body: { object: 'whatsapp_business_account', callback_url: callbackUrl, verify_token: this.cfg.verify_token, fields: 'messages' },
    })
  }

  /** Meta's GET handshake. The verify token is compared in constant time. */
  verifyChallenge(url: URL): Response {
    const p = url.searchParams
    if (p.get('hub.mode') === 'subscribe' && this.cfg.verify_token && safeEqual(p.get('hub.verify_token') ?? '', this.cfg.verify_token)) {
      return new Response(p.get('hub.challenge') ?? '', { status: 200, headers: { 'content-type': 'text/plain' } })
    }
    return new Response('forbidden', { status: 403 })
  }
}
