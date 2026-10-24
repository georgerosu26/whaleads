// Quick-reply placeholders. Pure, no DOM, so the unit tests import it directly.

/** First word of a saved name, or null when the "name" is empty or really a phone number. */
export function firstName(name: string | null | undefined): string | null {
  const n = (name ?? '').trim()
  if (!n || !/\p{L}/u.test(n)) return null
  return n.split(/\s+/)[0]!
}

/** Fills `{name}` (case-insensitive) with the contact's first name, or "there" when we have none. Other braces are left alone. */
export function fillQuickReply(body: string, contact: { name: string | null | undefined }): string {
  const first = firstName(contact.name) ?? 'there'
  return body.replace(/\{name\}/gi, () => first)
}
