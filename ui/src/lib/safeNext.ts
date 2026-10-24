// the login `?next=` target. Parsed as a URL against our own origin so tabs, backslashes and schemes cannot
// smuggle a foreign host past a string-prefix check; only the path, query and hash of a same-origin result are used.
export function safeNext(next: string | null | undefined, origin: string): string | null {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return null
  try {
    const u = new URL(next, origin)
    if (u.origin !== origin) return null
    return u.pathname + u.search + u.hash
  } catch { return null }
}
