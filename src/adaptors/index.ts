// Active-adaptor resolution. Order: D1 `adaptor_config` row (encrypted) -> legacy env vars/secrets
// (so earlier deployments keep working untouched).
import type { Env } from '../db'
import { logEvent } from '../db'
import { decryptJson, encryptJson } from '../crypto'
import { CloudApiAdaptor } from './cloud-api'
import { WhaBuzzAdaptor } from './whabuzz'
import type { AdaptorConfig, AdaptorKind, CloudApiConfig, MetaAdaptor, NumberStatus, WhaBuzzConfig } from './types'

export type { MetaAdaptor, AdaptorKind } from './types'

export function envCloudConfig(env: Env): CloudApiConfig | null {
  if (!env.META_SYSTEM_TOKEN || !env.META_PHONE_NUMBER_ID) return null
  return {
    system_token: env.META_SYSTEM_TOKEN, app_secret: env.META_APP_SECRET, phone_number_id: env.META_PHONE_NUMBER_ID,
    waba_id: env.META_WABA_ID, app_id: env.META_APP_ID, verify_token: env.WEBHOOK_VERIFY_TOKEN, graph_version: env.META_GRAPH_VERSION,
  }
}

export interface Resolved { adaptor: MetaAdaptor; kind: AdaptorKind; source: 'd1' | 'env'; config: CloudApiConfig | WhaBuzzConfig }

export function build(c: AdaptorConfig, env?: Pick<Env, 'WHABUZZ_BASE_URL'>): MetaAdaptor {
  return c.kind === 'whabuzz' ? new WhaBuzzAdaptor(c.config, undefined, env?.WHABUZZ_BASE_URL) : new CloudApiAdaptor(c.config)
}

/** The stored adaptor_config row cannot be decrypted (SESSION_SECRET missing, rotated, or the blob is corrupt). */
export class ConfigUndecryptable extends Error {
  readonly code = 'config_undecryptable'
  constructor(detail: string) { super(`adaptor config undecryptable: ${detail}`) }
}

async function readRow(env: Env): Promise<AdaptorConfig | null> {
  const row = await env.DB.prepare(`SELECT kind, config_enc FROM adaptor_config WHERE id=1`).first<{ kind: AdaptorKind; config_enc: string }>()
  if (!row) return null
  if (!env.SESSION_SECRET) throw new ConfigUndecryptable('SESSION_SECRET is not set')
  try {
    const config = await decryptJson<Record<string, unknown>>(env.SESSION_SECRET, row.config_enc)
    delete config.base_url // legacy field: the API host is deployment-controlled only
    return { kind: row.kind, config } as unknown as AdaptorConfig
  } catch (e) {
    throw new ConfigUndecryptable(String(e))
  }
}

/** The adaptor that sends and the one the Settings UI shows. Null when nothing is configured. */
export async function resolveActive(env: Env): Promise<Resolved | null> {
  const row = await readRow(env)
  if (row) return { adaptor: build(row, env), kind: row.kind, source: 'd1', config: row.config }
  const cfg = envCloudConfig(env)
  if (cfg) return { adaptor: new CloudApiAdaptor(cfg), kind: 'cloud_api', source: 'env', config: cfg }
  return null
}

/** Cheap "is any number configured" for the app shell: a row exists or the env Cloud API vars are set. No decrypt, no upstream call. */
export async function adaptorConfigured(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 AS x FROM adaptor_config WHERE id=1`).first()
  return !!row || envCloudConfig(env) !== null
}

/**
 * True when a WhaBuzz webhook secret is saved. An unreadable config counts as "secret present", so without a pending
 * connect the unsigned verify ping is refused; a valid pending connect (stored encrypted separately) still allows it.
 */
export async function whabuzzSecretConfigured(env: Env): Promise<boolean> {
  try {
    const row = await readRow(env)
    return row?.kind === 'whabuzz' && !!(row.config as WhaBuzzConfig).webhook_secret
  } catch { return true }
}

/**
 * The adaptor for a specific webhook route. /webhooks/meta must keep verifying Meta-signed posts
 * even after WhaBuzz becomes the active sender (Meta delivers to both during cutover), so a
 * cloud_api adaptor falls back to the legacy env credentials when D1 holds a different kind.
 */
export async function resolveForRoute(env: Env, kind: AdaptorKind): Promise<MetaAdaptor | null> {
  let row: AdaptorConfig | null = null
  try {
    row = await readRow(env)
  } catch (e) {
    if (!(e instanceof ConfigUndecryptable)) throw e
    console.error(e.message)
    await logEvent(env.DB, 'config_undecryptable', { route: kind, error: e.message })
    // cloud_api keeps working from the legacy env credentials; the whabuzz route cannot, so it surfaces the error.
    if (kind === 'whabuzz') throw e
  }
  if (row?.kind === kind) return build(row, env)
  if (kind === 'cloud_api') {
    const cfg = envCloudConfig(env)
    return cfg ? new CloudApiAdaptor(cfg) : null
  }
  return null
}

/**
 * Version of the stored adaptor config as one cheap scalar, selected inside a query the send path runs anyway.
 * AES-GCM draws a fresh IV on every save, so the blob prefix changes even for two saves in the same second.
 */
export const CONFIG_VERSION_SQL = `(SELECT kind || ':' || updated_at || ':' || substr(config_enc, 1, 24) FROM adaptor_config WHERE id=1)`

// Per-isolate cache of the resolved adaptor (decrypt + construct), valid while the stored config version is unchanged.
// A save from another isolate changes the version, which the next send reads for free, so there is no TTL to go stale.
const resolved = new WeakMap<object, { version: string; secret: string | undefined; base: string | undefined; value: Resolved | null }>()

/** resolveActive, skipping the config read and decrypt when `version` (CONFIG_VERSION_SQL, null = no row) matches the cache. */
export async function resolveActiveCached(env: Env, version: string | null): Promise<Resolved | null> {
  const v = version ?? 'none'
  const hit = resolved.get(env.DB)
  if (hit && hit.version === v && hit.secret === env.SESSION_SECRET && hit.base === env.WHABUZZ_BASE_URL) return hit.value
  const value = await resolveActive(env) // throws ConfigUndecryptable: never cached
  resolved.set(env.DB, { version: v, secret: env.SESSION_SECRET, base: env.WHABUZZ_BASE_URL, value })
  return value
}

export async function saveConfig(env: Env, c: AdaptorConfig): Promise<void> {
  if (!env.SESSION_SECRET) throw new Error('SESSION_SECRET is not set')
  resolved.delete(env.DB)
  const enc = await encryptJson(env.SESSION_SECRET, c.config)
  await env.DB.prepare(
    `INSERT INTO adaptor_config (id,kind,config_enc,updated_at) VALUES (1,?1,?2,unixepoch())
     ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, config_enc=excluded.config_enc, updated_at=excluded.updated_at`,
  ).bind(c.kind, enc).run()
}

const SECRET_FIELDS = new Set(['api_key', 'webhook_secret', 'system_token', 'app_secret', 'verify_token'])

export function maskConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(config)) {
    out[k] = SECRET_FIELDS.has(k) && typeof v === 'string' && v ? `••••${v.slice(-4)}` : v
  }
  return out
}

const REQUIRED: Record<AdaptorKind, string[]> = {
  whabuzz: ['api_key', 'phone_number_id', 'waba_id', 'webhook_secret'],
  cloud_api: ['system_token', 'app_secret', 'phone_number_id', 'waba_id'],
}
const OPTIONAL: Record<AdaptorKind, string[]> = {
  whabuzz: [],
  cloud_api: ['app_id', 'verify_token', 'graph_version'],
}

/** Returns a cleaned AdaptorConfig or an error string. Unknown fields are dropped. */
export function validateConfig(body: any): AdaptorConfig | string {
  const kind = body?.kind
  if (kind !== 'whabuzz' && kind !== 'cloud_api') return "kind must be 'whabuzz' or 'cloud_api'"
  const input = body?.config
  if (!input || typeof input !== 'object') return 'config object required'
  const config: Record<string, string> = {}
  for (const k of REQUIRED[kind as AdaptorKind]) {
    const v = input[k]
    if (typeof v !== 'string' || !v.trim()) return `config.${k} required`
    config[k] = v.trim()
  }
  for (const k of OPTIONAL[kind as AdaptorKind]) if (typeof input[k] === 'string' && input[k].trim()) config[k] = input[k].trim()
  return { kind, config } as unknown as AdaptorConfig
}

export type ApplyResult =
  | { ok: true; kind: AdaptorKind; config: Record<string, unknown>; status: NumberStatus; status_warning?: boolean }
  | { ok: false; http: number; body: Record<string, unknown> }

/**
 * The one save path for an adaptor config (manual PUT and one-click Connect): validate -> build -> status() ok ->
 * saveConfig -> log. Manual: nothing is saved unless the upstream accepts the credentials. Connect: WhaBuzz has already
 * activated the new connection and revoked the earlier ones, so the grant is ALWAYS saved and a failing status() (error
 * or throw) comes back as `status_warning` instead of discarding the only working key.
 */
export async function applyAdaptorConfig(env: Env, body: unknown, via: 'manual' | 'connect' = 'manual'): Promise<ApplyResult> {
  if (!env.SESSION_SECRET) return { ok: false, http: 500, body: { ok: false, error: 'SESSION_SECRET is not set on this Worker' } }
  const cfg = validateConfig(body)
  if (typeof cfg === 'string') return { ok: false, http: 400, body: { ok: false, error: cfg } }
  let adaptor: MetaAdaptor
  try { adaptor = build(cfg, env) } catch (e) { return { ok: false, http: 500, body: { ok: false, error: 'adaptor_misconfigured', detail: (e as Error).message } } }
  let status: NumberStatus
  if (via === 'connect') {
    try { status = await adaptor.status() } catch (e) { status = { ok: false, connected: false, display_number: null, verified_name: null, quality: null, tier: null, detail: (e as Error).message.slice(0, 120) } }
  } else {
    status = await adaptor.status()
    if (!status.ok) return { ok: false, http: 422, body: { ok: false, error: 'adaptor rejected: status() failed, nothing saved', status } }
  }
  await saveConfig(env, cfg)
  await logEvent(env.DB, 'adaptor_changed', { kind: cfg.kind, connected: status.connected, via })
  return { ok: true, kind: cfg.kind, config: cfg.config as unknown as Record<string, unknown>, status, ...(status.ok ? {} : { status_warning: true }) }
}
