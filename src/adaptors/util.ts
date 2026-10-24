import type { AdaptorError, MediaSend, TemplateButtonSend, TemplateHeaderSend } from './types'

const enc = new TextEncoder()

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)))
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Constant-time string compare (length mismatch returns early; lengths are not secret). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

export function netError(e: unknown): AdaptorError {
  return { source: 'network', error: String(e), message: `network error: ${String(e)}` }
}

/** One-line summary of a Meta/Graph-style error object. */
export function metaMessage(e: any, fallback = 'error'): string {
  if (!e || typeof e !== 'object') return fallback
  const code = e.code ? ` (code ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''})` : ''
  return `${e.message ?? fallback}${code}`
}

/** The `image` / `document` / ... object of a Meta media message. Audio takes no caption, only documents a filename. */
export function mediaObject(m: MediaSend): Record<string, string> {
  const o: Record<string, string> = { id: m.mediaId }
  if (m.caption && m.kind !== 'audio') o.caption = m.caption
  if (m.filename && m.kind === 'document') o.filename = m.filename
  return o
}

/**
 * The `template.components` array of a template message. Meta order: header, then body.
 * Media headers go by `id` when we uploaded the file, else by `link`. No body component when there are no body params.
 */
export function templateComponents(params: string[], header?: TemplateHeaderSend, buttons?: TemplateButtonSend[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  if (header) {
    if (header.format === 'TEXT') {
      if (header.params.length) out.push({ type: 'header', parameters: header.params.map((text) => ({ type: 'text', text })) })
    } else {
      const kind = header.format.toLowerCase()
      const obj: Record<string, string> = header.mediaId ? { id: header.mediaId } : { link: header.link ?? '' }
      if (header.format === 'DOCUMENT' && header.filename) obj.filename = header.filename
      out.push({ type: 'header', parameters: [{ type: kind, [kind]: obj }] })
    }
  }
  if (params.length) out.push({ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) })
  for (const b of buttons ?? []) out.push({ type: 'button', sub_type: b.sub_type, index: String(b.index), parameters: [{ type: 'text', text: b.text }] })
  return out
}
