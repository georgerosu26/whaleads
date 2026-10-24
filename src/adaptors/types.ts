// Adaptor contract (REQUIREMENTS §5). An adaptor is a thin transport to Meta: no business logic,
// no retries, no policy. Meta error objects pass through verbatim under `error.error` with
// `error.source === 'meta'`.

export type AdaptorKind = 'whabuzz' | 'cloud_api'

export interface AdaptorError {
  /** Who produced the error. 'meta' = Meta's own error object, untouched. */
  source: 'meta' | 'whabuzz' | 'network'
  /** The error object exactly as the upstream returned it. */
  error: unknown
  /** One-line summary for logs / UI. */
  message: string
}

export interface AdaptorResult<T = any> {
  ok: boolean
  /** Upstream HTTP status (0 = network failure). */
  status: number
  data: T
  error?: AdaptorError
}

export interface SendResult extends AdaptorResult {
  wamid: string | null
}

export interface NumberStatus {
  /** The upstream answered and the credentials were accepted. */
  ok: boolean
  /** The number is live on WhatsApp (WhaBuzz connection_state 'connected' / Graph status 'CONNECTED'). */
  connected: boolean
  display_number: string | null
  verified_name: string | null
  quality: string | null
  tier: string | null
  detail: string | null
  error?: AdaptorError
  raw?: unknown
}

export type MediaFetch =
  | { ok: true; bytes: ReadableStream<Uint8Array>; mime: string }
  | { ok: false; status: number; error: AdaptorError }

export interface SendContext {
  /** wamid being replied to. */
  replyTo?: string
}

export type MediaKind = 'image' | 'document' | 'video' | 'audio'

export interface MediaSend {
  kind: MediaKind
  /** Id returned by uploadMedia. */
  mediaId: string
  /** Not sent for audio (WhatsApp does not allow one). */
  caption?: string
  /** Documents only. */
  filename?: string
}

/** Header of a template message. Media goes by uploaded `mediaId` (preferred) or public `link`; TEXT headers carry their own params. */
export type TemplateHeaderSend =
  | { format: 'IMAGE' | 'VIDEO' | 'DOCUMENT'; mediaId?: string; link?: string; filename?: string }
  | { format: 'TEXT'; params: string[] }

/** A button component of a template message (e.g. the copy-code button of an authentication template). Passed through as-is. */
export interface TemplateButtonSend { index: number; sub_type: 'url' | 'quick_reply' | 'phone_number' | 'copy_code'; text: string }

export interface TemplateAdaptor {
  /** `after` = Graph paging cursor (Cloud API); WhaBuzz returns everything for the WABA. */
  list(opts?: { name?: string; after?: string }): Promise<AdaptorResult>
  /** Delete by name (all languages) or one language when `id` is given. */
  delete(opts: { name: string; id?: string }): Promise<AdaptorResult>
  /** `def` is Meta's create-template body (name, language, category, components). */
  create(def: Record<string, unknown>): Promise<AdaptorResult>
  /** Re-read approval status from Meta. */
  syncStatus(): Promise<AdaptorResult>
  /** Upload a header sample; resolves `data.h` = handle for template creation. */
  mediaHandle(bytes: ArrayBuffer | Uint8Array, mime: string): Promise<AdaptorResult>
}

/** Normalised inbound events. `raw` is always the original Meta object for that item. */
export interface InboundMessage {
  kind: 'message'
  wamid: string
  /** Sender wa_id. */
  from: string
  name: string | null
  /** Meta message type (text, image, ...). */
  type: string
  body: string | null
  media_id: string | null
  /** Unix seconds. */
  timestamp: number
  raw: unknown
}

export interface InboundStatus {
  kind: 'status'
  wamid: string
  /** sent | delivered | read | failed */
  status: string
  timestamp: number
  recipient: string | null
  errors: unknown[] | null
  raw: unknown
}

/** Lead Ads lead. WhaBuzz adaptor only (D6). */
export interface InboundLead {
  kind: 'lead'
  id: string | null
  data: unknown
  raw: unknown
}

export type InboundEvent = InboundMessage | InboundStatus | InboundLead

export interface MetaAdaptor {
  readonly kind: AdaptorKind
  readonly onboarding: 'connect_button' | 'manual_form'
  status(): Promise<NumberStatus>
  sendText(to: string, text: string, ctx?: SendContext): Promise<SendResult>
  sendTemplate(to: string, name: string, lang: string, params: string[], header?: TemplateHeaderSend, buttons?: TemplateButtonSend[]): Promise<SendResult>
  markRead(messageId: string): Promise<AdaptorResult>
  fetchMedia(mediaId: string): Promise<MediaFetch>
  uploadMedia(bytes: ArrayBuffer | Uint8Array, mime: string): Promise<AdaptorResult<{ id?: string }>>
  // send an already-uploaded media id (uploadMedia first, then this).
  sendMedia(to: string, media: MediaSend, ctx?: SendContext): Promise<SendResult>
  templates: TemplateAdaptor
  verifyWebhook(req: Request, rawBody: string): Promise<boolean>
  /** Throws SyntaxError on malformed JSON. Unknown / irrelevant events yield []. */
  parseWebhook(rawBody: string, onIgnored?: (n: number) => void): InboundEvent[]
}

export interface CloudApiConfig {
  system_token: string
  app_secret: string
  phone_number_id: string
  waba_id: string
  app_id?: string
  /** Echoed back on Meta's GET subscribe handshake. */
  verify_token?: string
  graph_version?: string
}

export interface WhaBuzzConfig {
  api_key: string
  phone_number_id: string
  waba_id: string
  /** `whsec_TEST_...`. Comma-separate two secrets during a rotation overlap. */
  webhook_secret: string
}

export type AdaptorConfig =
  | { kind: 'cloud_api'; config: CloudApiConfig }
  | { kind: 'whabuzz'; config: WhaBuzzConfig }
