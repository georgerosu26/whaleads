// Click-to-WhatsApp referral and prefilled reference-code parsing (plan C3). Pure: no I/O.
// Meta puts a `referral` object on the first message after an ad click. Its fields are copied as bounded
// strings; nothing else from the payload is trusted or stored.

export interface Referral {
  /** JSON-able object stored in leads.attribution. */
  attribution: Record<string, string | null>
  ctwa_clid: string | null
  ad_source_id: string | null
  /** True when Meta sent a referral object (an ad click). False for a reference code alone. */
  fromAd: boolean
}

const FIELDS = ['source_url', 'source_id', 'source_type', 'headline', 'body', 'media_type', 'ctwa_clid'] as const
const clip = (v: unknown, n = 500): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null)

/** `ref:ABC-123` anywhere in a message, as its own token. The code is 2 to 40 chars of letters, digits, `_` or `-`. */
const REF_RE = /(?:^|[\s(])ref:([a-z0-9][a-z0-9_-]{1,39})(?=$|[\s).,;:!?])/i

export function refCodeOf(body: string | null | undefined): string | null {
  const m = REF_RE.exec(body ?? '')
  return m ? m[1] : null
}

export function parseReferral(raw: unknown, body: string | null | undefined): Referral | null {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).referral : undefined
  const attribution: Record<string, string | null> = {}
  let fromAd = false
  if (r && typeof r === 'object' && !Array.isArray(r)) {
    for (const k of FIELDS) attribution[k] = clip((r as Record<string, unknown>)[k])
    fromAd = Object.values(attribution).some((v) => v !== null)
    if (!fromAd) for (const k of FIELDS) delete attribution[k]
  }
  const ref = refCodeOf(body)
  if (ref) attribution.ref_code = ref
  if (!fromAd && !ref) return null
  return { attribution, ctwa_clid: fromAd ? attribution.ctwa_clid ?? null : null, ad_source_id: fromAd ? attribution.source_id ?? null : null, fromAd }
}
