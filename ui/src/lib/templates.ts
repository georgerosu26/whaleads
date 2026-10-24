// template list types and small helpers shared by the settings pages and the composer.
export type TplStatus = 'APPROVED' | 'PENDING' | 'REJECTED' | 'PAUSED' | 'DISABLED'
export type HeaderFormat = 'NONE' | 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT'

export interface Tpl {
  id: string; name: string; language: string; category: 'UTILITY' | 'MARKETING' | string; status: TplStatus
  rejected_reason: string | null; header_format: HeaderFormat; header_text: string | null
  body: string; footer: string | null; body_params_count: number; header_params_count: number
  sendable: boolean; unsendable_reason: string | null
  quality?: 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN' | null; auth?: { security_note: boolean; expiry_minutes: number | null; button_text: string | null }
  has_header_sample: boolean; header_media_mime: string | null; synced_at: number | null; created_at: number
}
export interface TplList { ok: boolean; templates: Tpl[]; synced_at: number | null; pending: number; sync?: { ok: boolean; error?: string; message?: string } }

export const STATUS_TONE: Record<string, string> = { APPROVED: 'green', PENDING: 'amber', REJECTED: 'coral', PAUSED: 'neutral', DISABLED: 'neutral' }
export const STATUS_LABEL: Record<string, string> = { APPROVED: 'Approved', PENDING: 'Pending', REJECTED: 'Rejected', PAUSED: 'Paused', DISABLED: 'Disabled' }
export const HEADER_LABEL: Record<string, string> = { NONE: 'No header', TEXT: 'Text header', IMAGE: 'Image header', VIDEO: 'Video header', DOCUMENT: 'Document header' }

export const QUALITY_TONE: Record<string, string> = { GREEN: 'green', YELLOW: 'amber', RED: 'coral', UNKNOWN: 'neutral' }
export const QUALITY_LABEL: Record<string, string> = { GREEN: 'High quality', YELLOW: 'Medium quality', RED: 'Low quality', UNKNOWN: 'Quality pending' }

/** One line on what a state means and what to do about it. */
export const STATE_NOTE: Record<string, string> = {
  PAUSED: 'Meta paused this template because customers reported it or rated it low. It cannot be sent until it recovers, usually within hours. Duplicate it with better wording if it stays paused.',
  DISABLED: 'Meta disabled this template after repeated low quality. It cannot be sent or edited. Duplicate it under a new name.',
}

/** Plain-words versions of the reasons Meta gives for a rejection. The raw reason is always shown too. */
export const REJECT_HINT: Record<string, string> = {
  INCORRECT_CATEGORY: 'Meta thinks the category is wrong. Resubmit under the category it suggests.',
  INVALID_FORMAT: 'The wording or variables break Meta\'s format rules. Check the placeholders and samples.',
  ABUSIVE_CONTENT: 'Meta flagged the wording as abusive or threatening. Rewrite it in neutral terms.',
  SCAM: 'Meta flagged the wording as looking like a scam. Remove urgent or too-good-to-be-true phrasing.',
  TAG_CONTENT_MISMATCH: 'The content does not match the category. Resubmit under the right category.',
}

export function ago(ts: number | null, now = Date.now()): string {
  if (!ts) return 'never'
  const s = Math.max(0, Math.floor(now / 1000) - ts)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

/** Composer prefill: `{{1}}` gets the contact's first name (the `{{name}}` helper), the rest start empty. */
export function prefillParams(count: number, name: string | null): string[] {
  const first = name?.trim().split(/\s+/)[0] ?? ''
  return Array.from({ length: count }, (_, i) => (i === 0 ? first : ''))
}

export type HeaderChoice = { kind: 'default' } | { kind: 'stored'; messageId: number } | { kind: 'upload'; file: File }
export interface TemplateJob { tpl: Tpl; bodyParams: string[]; headerParams: string[]; header: HeaderChoice | null; rendered: string }
export interface RecentFile { message_id: number; mime: string; filename: string | null; size: number | null; timestamp: number }
