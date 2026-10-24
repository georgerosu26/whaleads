// Settings: D1 `settings` row > env var > default. The raw rows are cached per isolate for 30 s and the
// cache is dropped on every write in this isolate. Env is applied on read, never cached.
import { decryptJson, encryptJson } from './crypto'
import type { Env } from './db'

export const SETTINGS_TTL_MS = 30_000
export const AI_INFO = 'whaleads/anthropic/v1'
const cache = new WeakMap<D1Database, { at: number; rows: Map<string, unknown> }>()

export function clearSettingsCache(db: D1Database): void { cache.delete(db) }

async function rows(db: D1Database): Promise<Map<string, unknown>> {
  const hit = cache.get(db)
  if (hit && Date.now() - hit.at < SETTINGS_TTL_MS) return hit.rows
  const { results } = await db.prepare(`SELECT key,value FROM settings`).all<{ key: string; value: string }>()
  const m = new Map<string, unknown>()
  for (const r of results) { try { m.set(r.key, JSON.parse(r.value)) } catch { m.set(r.key, r.value) } }
  cache.set(db, { at: Date.now(), rows: m })
  return m
}

export type Source = 'setting' | 'env' | 'default'
export interface Resolved {
  business_name: string
  default_country: string | null
  timezone: string
  working_hours: unknown | null
  allowed_origins: string[]
  vapid_public: string | null
  ai_key_set: boolean
  sources: Record<'business_name' | 'default_country' | 'timezone' | 'working_hours' | 'allowed_origins', Source>
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
export const splitOrigins = (s: string | undefined): string[] => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean)

export async function getSettings(env: Env): Promise<Resolved> {
  const m = await rows(env.DB)
  const sources = {} as Resolved['sources']
  const pick = <T>(key: keyof Resolved['sources'], fromSetting: T | undefined, fromEnv: T | undefined, dflt: T): T => {
    if (fromSetting !== undefined) { sources[key] = 'setting'; return fromSetting }
    if (fromEnv !== undefined) { sources[key] = 'env'; return fromEnv }
    sources[key] = 'default'; return dflt
  }
  const str = (k: string) => (nonEmpty(m.get(k)) ? (m.get(k) as string) : undefined)
  const envStr = (v: string | undefined) => (nonEmpty(v) ? v.trim() : undefined)
  const origins = m.get('allowed_origins')
  return {
    business_name: pick('business_name', str('business_name'), envStr(env.INSTANCE_NAME), 'WhaLeads'),
    default_country: pick<string | null>('default_country', str('default_country'), envStr(env.DEFAULT_COUNTRY)?.toUpperCase(), null),
    timezone: pick('timezone', str('timezone'), envStr(env.TIMEZONE), 'UTC'),
    working_hours: pick<unknown | null>('working_hours', m.has('working_hours') ? m.get('working_hours') : undefined, undefined, null),
    allowed_origins: pick<string[]>('allowed_origins', Array.isArray(origins) ? (origins as string[]) : undefined, env.ALLOWED_ORIGINS === undefined ? undefined : splitOrigins(env.ALLOWED_ORIGINS), []),
    vapid_public: str('vapid_public') ?? null,
    ai_key_set: m.has('anthropic_key_enc'),
    sources,
  }
}

/** Upserts (or, with `undefined`, removes so the env fallback applies again). */
export async function putSetting(env: Env, key: string, value: unknown, by: number | null): Promise<void> {
  if (value === undefined) await env.DB.prepare(`DELETE FROM settings WHERE key=?`).bind(key).run()
  else {
    await env.DB.prepare(`INSERT INTO settings (key,value,updated_by) VALUES (?1,?2,?3)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=unixepoch(), updated_by=excluded.updated_by`).bind(key, JSON.stringify(value), by).run()
  }
  clearSettingsCache(env.DB)
}

export async function setAnthropicKey(env: Env, key: string | null, by: number | null): Promise<void> {
  if (!env.SESSION_SECRET) throw new Error('SESSION_SECRET is not set')
  await putSetting(env, 'anthropic_key_enc', key ? await encryptJson(env.SESSION_SECRET, { key }, AI_INFO) : undefined, by)
}

/** Masked view for the admin UI. The key itself is never returned; only the last 4 characters. */
export async function anthropicKeyInfo(env: Env): Promise<{ configured: boolean; last4: string | null; readable: boolean }> {
  const m = await rows(env.DB)
  const blob = m.get('anthropic_key_enc')
  if (typeof blob !== 'string') return { configured: false, last4: null, readable: true }
  try {
    const { key } = await decryptJson<{ key: string }>(env.SESSION_SECRET ?? '', blob, AI_INFO)
    return { configured: true, last4: key.slice(-4), readable: true }
  } catch { return { configured: true, last4: null, readable: false } }
}

/** Default model for the flow AI node: the fast, low-cost Haiku. A deployment may override it with the `ai_model` setting. */
export const DEFAULT_AI_MODEL = 'claude-haiku-5-5'

/** The decrypted Anthropic key for the AI node, or null when none is set / it cannot be read. Never log the result. */
export async function getAnthropicKey(env: Env): Promise<string | null> {
  if (!env.SESSION_SECRET) return null
  const blob = (await rows(env.DB)).get('anthropic_key_enc')
  if (typeof blob !== 'string') return null
  try {
    const { key } = await decryptJson<{ key: string }>(env.SESSION_SECRET, blob, AI_INFO)
    return typeof key === 'string' && key ? key : null
  } catch { return null }
}

export async function getAiModel(env: Env): Promise<string> {
  const m = (await rows(env.DB)).get('ai_model')
  return typeof m === 'string' && /^[\w.-]{3,80}$/.test(m.trim()) ? m.trim() : DEFAULT_AI_MODEL
}

/** Country used to read numbers typed without a "+": the setting, then DEFAULT_COUNTRY, then IN. */
export async function phoneCountry(env: Env): Promise<string> {
  return (await getSettings(env)).default_country ?? 'IN'
}

/** Broadcast pace, sends per minute (1-40). The Worker's cron step reads it; the default keeps one tick inside the free-plan subrequest cap. */
export async function getBroadcastPerMinute(env: Env): Promise<number> {
  const n = Number((await rows(env.DB)).get('broadcast_per_minute'))
  return Number.isInteger(n) && n >= 1 && n <= 40 ? n : 20
}
