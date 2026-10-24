// AES-GCM at-rest encryption for adaptor credentials. The key is derived with HKDF-SHA256 from the
// Worker secret SESSION_SECRET (the same secret signs sessions). Rotating SESSION_SECRET
// makes stored config undecryptable: re-enter it in Settings / via PUT /api/admin/adaptor.

const enc = new TextEncoder()
const dec = new TextDecoder()
const INFO = 'whaleads/adaptor-config/v1'
/** HKDF info for the VAPID private key stored by /setup. */
export const VAPID_INFO = 'whaleads/vapid/v1'
const SALT = enc.encode('whaleads')

function b64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}
function unb64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export async function deriveKey(secret: string, info: string = INFO): Promise<CryptoKey> {
  if (!secret) throw new Error('SESSION_SECRET is not set')
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: SALT, info: enc.encode(info) },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  )
}

/** HMAC-SHA256 key from SESSION_SECRET. Each purpose uses its own HKDF `info`, so keys never overlap. */
export async function deriveHmacKey(secret: string, info: string): Promise<CryptoKey> {
  if (!secret) throw new Error('SESSION_SECRET is not set')
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: SALT, info: enc.encode(info) },
    base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify'],
  )
}

/** Returns `v1.<iv b64>.<ciphertext b64>`. */
export async function encryptJson(secret: string, value: unknown, info?: string): Promise<string> {
  const key = await deriveKey(secret, info)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value))))
  return `v1.${b64(iv)}.${b64(ct)}`
}

export async function decryptJson<T = unknown>(secret: string, blob: string, info?: string): Promise<T> {
  const [ver, ivB64, ctB64] = blob.split('.')
  if (ver !== 'v1' || !ivB64 || !ctB64) throw new Error('unrecognised config blob')
  const key = await deriveKey(secret, info)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB64) }, key, unb64(ctB64))
  return JSON.parse(dec.decode(pt)) as T
}
