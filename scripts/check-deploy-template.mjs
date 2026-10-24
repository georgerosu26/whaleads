#!/usr/bin/env node
// Validates that the generic wrangler.jsonc (the file the "Deploy to Cloudflare" button reads) is a clean template:
// nothing account-specific, no routes, no client strings, and the resources/secrets the button needs are declared.
//
//   node scripts/check-deploy-template.mjs [dir]        dir defaults to the repo root
//   WHALEADS_SCRUB_LIST=/path/to/list  adds your private name/host patterns (one regex per line, never committed)
//
// Exit 0 = clean, 1 = findings (printed), 2 = could not run.
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'))
const problems = []
const fail = (file, msg) => problems.push(`${file}: ${msg}`)

/** JSONC -> JSON. String-aware, so "https://x" inside a string is not taken for a comment. */
export function parseJsonc(text) {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1
      if (i === 0) throw new Error('unterminated block comment')
    } else out += c
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

function walk(node, visit, path = '') {
  visit(node, path)
  if (Array.isArray(node)) node.forEach((v, i) => walk(v, visit, `${path}[${i}]`))
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, visit, path ? `${path}.${k}` : k)
}

// ---- wrangler.jsonc ----
const wranglerPath = join(root, 'wrangler.jsonc')
if (!existsSync(wranglerPath)) { console.error(`no wrangler.jsonc in ${root}`); process.exit(2) }
const rawWrangler = readFileSync(wranglerPath, 'utf8')
let cfg
try { cfg = parseJsonc(rawWrangler) } catch (e) { console.error(`wrangler.jsonc does not parse: ${e.message}`); process.exit(2) }

const BANNED_KEYS = new Set(['account_id', 'route', 'routes', 'zone_id', 'zone_name', 'database_id', 'id', 'preview_id', 'preview_database_id', 'env', 'dev', 'pattern'])
walk(cfg, (node, path) => {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    for (const k of Object.keys(node)) if (BANNED_KEYS.has(k)) fail('wrangler.jsonc', `"${k}" must not be set in the generic template (at ${path || '<root>'})`)
  }
})

if (cfg.name !== 'whaleads') fail('wrangler.jsonc', `name must be "whaleads" (got ${JSON.stringify(cfg.name)})`)
if (cfg.workers_dev === false) fail('wrangler.jsonc', 'workers_dev must not be false: the button lands on workers.dev')
if (cfg.placement?.mode !== 'smart') fail('wrangler.jsonc', 'placement.mode must be "smart" (unknown D1 region); pin a region in your own config instead')
if (cfg.placement && (cfg.placement.region || cfg.placement.host || cfg.placement.hostname)) fail('wrangler.jsonc', 'placement must not pin a region/host in the generic template')

const d1 = cfg.d1_databases ?? []
if (!(d1.length === 1 && d1[0].binding === 'DB' && d1[0].database_name === 'whaleads-db')) fail('wrangler.jsonc', 'd1_databases must be exactly [{binding:"DB", database_name:"whaleads-db"}] with no database_id')
const r2 = cfg.r2_buckets ?? []
if (!(r2.length === 1 && r2[0].binding === 'MEDIA' && r2[0].bucket_name === 'whaleads-media')) fail('wrangler.jsonc', 'r2_buckets must be exactly [{binding:"MEDIA", bucket_name:"whaleads-media"}]')
const dos = cfg.durable_objects?.bindings ?? []
if (!dos.some((b) => b.name === 'LIVE' && b.class_name === 'LiveHub')) fail('wrangler.jsonc', 'durable_objects must bind LIVE -> LiveHub')
if (!(cfg.migrations ?? []).some((m) => (m.new_sqlite_classes ?? []).includes('LiveHub'))) fail('wrangler.jsonc', 'migrations must create LiveHub as a SQLite class')
if (!(cfg.triggers?.crons ?? []).length) fail('wrangler.jsonc', 'triggers.crons is empty: the flow engine needs the every-minute tick')
if (cfg.build?.command !== 'npm run build') fail('wrangler.jsonc', 'build.command must be "npm run build"')
if (cfg.build?.cwd) fail('wrangler.jsonc', 'build.cwd must not be set in the generic template')
if (cfg.observability?.enabled !== true) fail('wrangler.jsonc', 'observability.enabled must be true')
if (!cfg.assets?.directory || cfg.assets.directory.startsWith('..') || cfg.assets.directory.startsWith('/')) fail('wrangler.jsonc', 'assets.directory must be a path inside the repo')
if (cfg.main !== 'src/index.ts') fail('wrangler.jsonc', 'main must be src/index.ts')

const vars = cfg.vars ?? {}
for (const [k, v] of Object.entries(vars)) {
  if (/^META_|TOKEN|SECRET|KEY|PASSWORD/i.test(k)) fail('wrangler.jsonc', `vars.${k}: adaptor config lives in D1 and secrets never go in vars`)
  if (k === 'ALLOWED_ORIGINS') fail('wrangler.jsonc', 'vars.ALLOWED_ORIGINS must not be in the template: the Deploy button makes the deployer fill empty vars (set origins in Settings)')
  if (k === 'INSTANCE_NAME' && v !== 'WhaLeads') fail('wrangler.jsonc', 'vars.INSTANCE_NAME must be "WhaLeads"')
}

// ---- .dev.vars.example: exactly one secret, no value ----
const examplePath = join(root, '.dev.vars.example')
let rawExample = ''
if (!existsSync(examplePath)) fail('.dev.vars.example', 'missing: the button prompts for what this file lists')
else {
  rawExample = readFileSync(examplePath, 'utf8')
  const keys = rawExample.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).map((l) => l.split('=')[0].trim())
  if (keys.length !== 1 || keys[0] !== 'SESSION_SECRET') fail('.dev.vars.example', `must list exactly SESSION_SECRET (got: ${keys.join(', ') || 'nothing'})`)
  for (const l of rawExample.split('\n')) if (/^SESSION_SECRET=\S/.test(l)) fail('.dev.vars.example', 'SESSION_SECRET must have no value')
}

// ---- raw-text scan: generic identifiers + your private list ----
const generic = [
  [/\b[0-9a-f]{32}\b/i, '32-hex id (account / zone / database id)'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, 'UUID (database / namespace id)'],
  [/\b\d{12,}\b/, '12+ digit number (Meta / phone id)'],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/, 'email address'],
  [/\bwhsec_\w+|\bwb_live_\w+|\bwbk_\w+|\bEAA[A-Za-z0-9]{20,}/, 'token-looking string'],
  [/\b[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\b/i, 'account-specific workers.dev host'],
]
const listPath = process.env.WHALEADS_SCRUB_LIST
if (listPath) {
  if (!existsSync(listPath)) { console.error(`WHALEADS_SCRUB_LIST not found: ${listPath}`); process.exit(2) }
  for (const line of readFileSync(listPath, 'utf8').split('\n')) {
    const t = line.trim()
    if (t && !t.startsWith('#')) generic.push([new RegExp(t, 'i'), 'private scrub-list entry'])
  }
}
const ALLOWED_HOSTS = /^(?:[a-z0-9-]+\.)*(?:example\.(?:com|org|net)|whabuzz\.com|cloudflare\.com)$/i
for (const [file, text] of [['wrangler.jsonc', rawWrangler], ['.dev.vars.example', rawExample]]) {
  text.split('\n').forEach((line, i) => {
    for (const [re, what] of generic) if (re.test(line)) fail(`${file}:${i + 1}`, `${what}`)
    for (const m of line.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) if (!ALLOWED_HOSTS.test(m[1])) fail(`${file}:${i + 1}`, `host not allowed in the template: ${m[1]}`)
  })
}

if (problems.length) {
  console.error(`lint:template FAILED (${problems.length})`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log('lint:template ok: wrangler.jsonc and .dev.vars.example are a clean generic template')
