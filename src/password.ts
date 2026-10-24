// Password hashing: PBKDF2-SHA256 through WebCrypto. 100000 is the highest iteration count workerd
// allows. The count is stored inside every hash (`pbkdf2-sha256$<iter>$<salt_b64>$<hash_b64>`), so it
// can be lowered later without invalidating existing hashes.

export const PBKDF2_ITER = 100000
const MAX_ITER = 100000
const enc = new TextEncoder()

const b64 = (bytes: Uint8Array): string => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

async function derive(password: string, salt: Uint8Array, iter: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256))
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]
  return d === 0
}

export async function hashPassword(password: string, iter = PBKDF2_ITER): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return `pbkdf2-sha256$${iter}$${b64(salt)}$${b64(await derive(password, salt, iter))}`
}

/** Fixed, well-formed hash of a random value nobody knows. Verifying against it costs one full PBKDF2 run. */
export const DUMMY_HASH = `pbkdf2-sha256$${PBKDF2_ITER}$AAECAwQFBgcICQoLDA0ODw==$ESIzRFVmd4iZqrvM3e7/ABEiM0RVZneImaq7zN3u/wA=`

/** False for any malformed hash; never throws on bad input. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterS, saltB64, hashB64] = stored.split('$')
  const iter = Number(iterS)
  if (scheme !== 'pbkdf2-sha256' || !Number.isInteger(iter) || iter < 1 || iter > MAX_ITER || !saltB64 || !hashB64) return false
  let salt: Uint8Array, want: Uint8Array
  try { salt = unb64(saltB64); want = unb64(hashB64) } catch { return false }
  return timingSafeEqual(await derive(password, salt, iter), want)
}

/**
 * Login check that costs the same whether or not the account exists: with no stored hash it verifies
 * against DUMMY_HASH (and returns false), so response time does not reveal which emails are registered.
 */
export async function verifyOrDummy(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) { await verifyPassword(password, DUMMY_HASH); return false }
  return verifyPassword(password, stored)
}
