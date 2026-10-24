// Self-migrating D1 schema (same idea as blogkit): ensureSchema() runs once per
// isolate, walks MIGRATIONS from the version stored in `meta`. Upgrading the
// worker is just `wrangler deploy`.

export interface Env {
  DB: D1Database
  META_GRAPH_VERSION: string
  META_APP_ID: string
  META_WABA_ID: string
  META_PHONE_NUMBER_ID: string
  ALLOWED_ORIGINS?: string
  INSTANCE_NAME: string
  META_SYSTEM_TOKEN: string
  META_APP_SECRET: string
  WEBHOOK_VERIFY_TOKEN: string
  ADMIN_KEY: string
  /** Derives the keys that encrypt adaptor config and sign sessions; also the first-boot setup key. */
  SESSION_SECRET?: string
  /** Workers Static Assets binding (the SPA). Absent in unit tests. */
  ASSETS?: Fetcher
  /** Optional defaults; the D1 setting wins. */
  DEFAULT_COUNTRY?: string
  TIMEZONE?: string
  /** Optional WhaBuzz API host override; https and *.whabuzz.com only. Set in the deployment, never from the UI. */
  WHABUZZ_BASE_URL?: string
  /** Optional host of the hosted WhaBuzz Connect page; same allow-list as WHABUZZ_BASE_URL. Default https://app.whabuzz.com. */
  WHABUZZ_CONNECT_BASE?: string
  /** R2 bucket for message media. Optional: without it media is proxied live from Meta and not kept. */
  MEDIA?: R2Bucket
  /** D20: the live-channel Durable Object (one hub per deployment). Optional: without it the browsers just poll. */
  LIVE?: DurableObjectNamespace<import('./livehub').LiveHub>
}

export const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wa_id TEXT UNIQUE,
      phone TEXT,
      name TEXT,
      email TEXT,
      first_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
      source TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS contacts_wa_idx ON contacts (wa_id)`,
    `CREATE INDEX IF NOT EXISTS contacts_phone_idx ON contacts (phone)`,
    `CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK (source IN ('whatsapp','pilot_form','contact_form','call')),
      page TEXT, message TEXT,
      utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, gclid TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,
    `CREATE INDEX IF NOT EXISTS leads_created_idx ON leads (created_at)`,
    `CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      wamid TEXT UNIQUE,
      type TEXT, body TEXT, media_id TEXT, status TEXT,
      timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
      raw TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,
    `CREATE INDEX IF NOT EXISTS messages_contact_idx ON messages (contact_id, timestamp)`,
    `CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL, payload TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,
    `CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL
    )`,
  ],
  // v2: adaptor config + idempotent inbound. The same WhatsApp message arrives on /webhooks/meta
  // AND /webhooks/whabuzz during a cutover, so wamid (messages) and (wamid,status) (statuses) are unique.
  [
    `CREATE UNIQUE INDEX IF NOT EXISTS messages_wamid_uidx ON messages (wamid)`,
    `CREATE TABLE IF NOT EXISTS message_statuses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wamid TEXT NOT NULL,
      status TEXT NOT NULL,
      timestamp INTEGER,
      raw TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS message_statuses_wamid_status_uidx ON message_statuses (wamid, status)`,
    `CREATE TABLE IF NOT EXISTS adaptor_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      kind TEXT NOT NULL CHECK (kind IN ('whabuzz','cloud_api')),
      config_enc TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,
  ],
  // v3: staff, sessions, settings, pipeline lookups. Additive. The seeds are configuration,
  // not sample data: no contacts, leads or staff are seeded.
  [
    `CREATE TABLE staff (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','staff')),
      pw_hash TEXT NOT NULL,
      must_change_pw INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_login_at INTEGER
    )`,
    `CREATE TABLE sessions (
      id_hash TEXT PRIMARY KEY,
      staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at INTEGER NOT NULL,
      last_seen_at INTEGER,
      user_agent TEXT
    )`,
    `CREATE INDEX sessions_staff_idx ON sessions (staff_id)`,
    `CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_by INTEGER
    )`,
    `CREATE TABLE stages (
      key TEXT PRIMARY KEY, label TEXT NOT NULL, position INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('open','won','lost')),
      archived INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE sources (
      key TEXT PRIMARY KEY, label TEXT NOT NULL,
      system INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL UNIQUE COLLATE NOCASE,
      color TEXT NOT NULL DEFAULT 'neutral'
    )`,
    `INSERT OR IGNORE INTO stages VALUES ('new','New',0,'open',0),('contacted','Contacted',1,'open',0),
      ('qualified','Qualified',2,'open',0),('won','Won',3,'won',0),('lost','Lost',4,'lost',0)`,
    `INSERT OR IGNORE INTO sources VALUES ('whatsapp','WhatsApp',1,0),('ctwa','WhatsApp ad',1,0),('pilot_form','Pilot form',1,0),
      ('contact_form','Contact form',1,0),('call','Call',1,0),('manual','Added by staff',1,0),('import','Import',1,0),('meta_lead_ads','Meta lead ad',1,0)`,
  ],
  // v4: the ONE non-additive step. The v1 CHECK on leads.source blocks manual/import/ctwa and SQLite
  // cannot drop a CHECK in place, so leads is rebuilt (ids preserved) inside this single batch. Nothing
  // references leads before v4 (the tables that do are created after the rename), so the DROP cascades
  // nowhere. Takes the whole step with it on any failure: the batch is one transaction. Back up first.
  [
    `CREATE TABLE leads_v4 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      page TEXT, message TEXT,
      utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, gclid TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      assigned_to INTEGER REFERENCES staff(id) ON DELETE SET NULL,
      external_id TEXT, attribution TEXT, ctwa_clid TEXT, ad_source_id TEXT,
      next_action_at INTEGER, lost_reason TEXT,
      won_at INTEGER, closed_at INTEGER, first_response_at INTEGER, last_activity_at INTEGER
    )`,
    `INSERT INTO leads_v4 (id,contact_id,source,page,message,utm_source,utm_medium,utm_campaign,gclid,status,created_at,updated_at)
      SELECT id,contact_id,source,page,message,utm_source,utm_medium,utm_campaign,gclid,status,created_at,updated_at FROM leads`,
    // Carry the AUTOINCREMENT counter over so ids of deleted top rows are never reused. SQLite renames the
    // sqlite_sequence row along with the table.
    `INSERT INTO sqlite_sequence (name, seq) SELECT 'leads_v4', seq FROM sqlite_sequence WHERE name='leads'
      AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='leads_v4')`,
    `UPDATE sqlite_sequence SET seq = (SELECT seq FROM sqlite_sequence WHERE name='leads')
      WHERE name='leads_v4' AND seq < (SELECT seq FROM sqlite_sequence WHERE name='leads')`,
    `DROP TABLE leads`,
    `ALTER TABLE leads_v4 RENAME TO leads`,
    `CREATE INDEX leads_created_idx ON leads (created_at)`,
    `CREATE INDEX leads_contact_idx ON leads (contact_id, created_at)`,
    `CREATE INDEX leads_next_action_idx ON leads (next_action_at) WHERE next_action_at IS NOT NULL`,
    `CREATE TABLE lead_tags (
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (lead_id, tag_id)
    )`,
    // notes and logged calls are activity kinds 'note' and 'call'; there is no separate notes table
    `CREATE TABLE activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
      contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
      actor TEXT NOT NULL,
      kind TEXT NOT NULL, data TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,
    `CREATE INDEX activity_lead_idx ON activity (lead_id, created_at)`,
    `CREATE TABLE conversations (
      contact_id INTEGER PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
      last_message_at INTEGER NOT NULL,
      last_inbound_at INTEGER,
      last_preview TEXT,
      unread_count INTEGER NOT NULL DEFAULT 0,
      assigned_to INTEGER REFERENCES staff(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed'))
    )`,
    `CREATE INDEX conversations_last_idx ON conversations (last_message_at DESC)`,
    // Backfill with unread_count = 0 so there is no unread flood on first login.
    `INSERT INTO conversations (contact_id,last_message_at,last_inbound_at,last_preview)
      SELECT m.contact_id, MAX(m.timestamp), MAX(CASE WHEN m.direction='in' THEN m.timestamp END),
        (SELECT substr(COALESCE(x.body,'['||x.type||']'),1,140) FROM messages x WHERE x.contact_id=m.contact_id ORDER BY x.timestamp DESC, x.id DESC LIMIT 1)
      FROM messages m GROUP BY m.contact_id`,
    `CREATE TABLE media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
      media_id TEXT, r2_key TEXT, mime TEXT, filename TEXT, size INTEGER,
      status TEXT NOT NULL CHECK (status IN ('pending','stored','failed','too_large')),
      attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), stored_at INTEGER
    )`,
    `CREATE INDEX media_pending_idx ON media (status, attempts) WHERE status='pending'`,
    `INSERT INTO media (message_id, media_id, mime, status)
      SELECT id, media_id, NULL, 'pending' FROM messages WHERE media_id IS NOT NULL AND direction='in'`,
    `CREATE TABLE quick_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shortcut TEXT NOT NULL UNIQUE COLLATE NOCASE,
      body TEXT NOT NULL,
      created_by INTEGER REFERENCES staff(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,
    `CREATE TABLE push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, user_agent TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), last_ok_at INTEGER, fail_count INTEGER NOT NULL DEFAULT 0
    )`,
  ],
  // v5 (polling cost): additive indexes only. The unread badge and the list's unread_total count rows with unread_count > 0
  // (a partial index covers that without touching the table); the list orders unread-first, newest-first, which the
  // expression index serves so a page is read in order and stops at the LIMIT instead of sorting every conversation.
  [
    `CREATE INDEX IF NOT EXISTS conversations_unread_idx ON conversations (unread_count) WHERE unread_count > 0`,
    `CREATE INDEX IF NOT EXISTS conversations_list_idx ON conversations ((unread_count > 0) DESC, last_message_at DESC, contact_id DESC)`,
  ],
  // v6 (templates): a local mirror of Meta's template objects. `components` is Meta's own JSON; `status` and
  // `rejected_reason` are written only from what the adaptor returned. Additive: no existing table is touched.
  [
    `CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      language TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'UTILITY' CHECK (category IN ('MARKETING','UTILITY','AUTHENTICATION')),
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','PAUSED','DISABLED')),
      rejected_reason TEXT,
      components TEXT NOT NULL DEFAULT '[]',
      header_format TEXT NOT NULL DEFAULT 'NONE' CHECK (header_format IN ('NONE','TEXT','IMAGE','VIDEO','DOCUMENT')),
      header_media_r2_key TEXT,
      header_media_mime TEXT,
      body_params_count INTEGER NOT NULL DEFAULT 0,
      header_params_count INTEGER NOT NULL DEFAULT 0,
      synced_at INTEGER,
      created_by INTEGER REFERENCES staff(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE (name, language)
    )`,
    `CREATE INDEX IF NOT EXISTS templates_status_idx ON templates (status)`,
  ],
  // v7 (automation flows): the flow definitions and their runs. Additive only. `flows.graph` is the draft,
  // `published_graph` what new runs snapshot; a run keeps its own `snapshot`, so editing a flow never changes a run
  // in flight. `flow_runs_idem` makes a trigger event start at most one run; `flow_runs_one_live` allows at most
  // one running/awaiting run per (flow, lead, shadow), so a shadow run never blocks or consumes the slot of a live one. `step` is bumped by every state write: a resume locks on the step it read, so a stale resume loses. `messages.origin` ('flow:<id>') labels automation sends.
  [
    `CREATE TABLE flows (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','archived')),
      shadow INTEGER NOT NULL DEFAULT 1,
      reentry TEXT NOT NULL DEFAULT 'once' CHECK (reentry IN ('once','each_event')),
      trigger_kind TEXT,
      graph TEXT NOT NULL DEFAULT '{"nodes":[],"connections":[]}',
      published_graph TEXT, version INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 100,
      created_by INTEGER REFERENCES staff(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()), published_at INTEGER
    )`,
    `CREATE INDEX flows_trigger ON flows (status, trigger_kind, priority)`,
    `CREATE TABLE flow_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      flow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE, flow_version INTEGER NOT NULL,
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE, contact_id INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running','awaiting','completed','failed','abandoned','cancelled')),
      shadow INTEGER NOT NULL DEFAULT 0, trigger TEXT NOT NULL, idem_key TEXT,
      step INTEGER NOT NULL DEFAULT 0, current_node_id TEXT, await_kind TEXT CHECK (await_kind IN ('timer','reply')), resume_at INTEGER, expires_at INTEGER,
      snapshot TEXT NOT NULL, context TEXT NOT NULL, trace TEXT NOT NULL DEFAULT '[]', error TEXT,
      started_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()), completed_at INTEGER
    )`,
    `CREATE UNIQUE INDEX flow_runs_idem ON flow_runs (idem_key) WHERE idem_key IS NOT NULL`,
    `CREATE UNIQUE INDEX flow_runs_one_live ON flow_runs (flow_id, lead_id, shadow) WHERE status IN ('running','awaiting')`,
    `CREATE INDEX flow_runs_due ON flow_runs (resume_at) WHERE status = 'awaiting'`,
    `CREATE INDEX flow_runs_running ON flow_runs (updated_at) WHERE status = 'running'`,
    `CREATE INDEX flow_runs_reply ON flow_runs (contact_id) WHERE status = 'awaiting' AND await_kind = 'reply'`,
    `CREATE INDEX flow_runs_lead ON flow_runs (lead_id, started_at)`,
    `CREATE INDEX flow_runs_done ON flow_runs (completed_at) WHERE completed_at IS NOT NULL`,
    `ALTER TABLE messages ADD COLUMN origin TEXT`,
  ],
  // v8 (reports): additive indexes. Messages had only (contact_id, timestamp), so the weekly in/out counts for a date range
  // would scan the table; (timestamp, direction) answers them from the index alone. leads(ad_source_id) serves the campaign filter, leads(external_id) the import row-key lookup.
  [
    `CREATE INDEX IF NOT EXISTS messages_ts_idx ON messages (timestamp, direction)`,
    `CREATE INDEX IF NOT EXISTS leads_ad_source_idx ON leads (ad_source_id)`,
    `CREATE INDEX IF NOT EXISTS leads_external_idx ON leads (external_id) WHERE external_id IS NOT NULL`,
  ],
  // v9 (broadcasts): opt-out on contacts, template quality, broadcasts + recipients. Additive only; v8 code ignores all of it.
  [
    `ALTER TABLE contacts ADD COLUMN opted_out_at INTEGER`,
    `ALTER TABLE contacts ADD COLUMN opt_out_source TEXT`,
    `ALTER TABLE templates ADD COLUMN quality TEXT`,
    `CREATE TABLE broadcasts (
      id TEXT PRIMARY KEY,                       -- 'bc_' + random
      name TEXT NOT NULL,
      template_id TEXT NOT NULL,                 -- local templates.id; name/language/category copied below
      template_name TEXT NOT NULL,
      language TEXT NOT NULL,
      category TEXT NOT NULL,
      params TEXT NOT NULL DEFAULT '{}',         -- {body:[{kind:'fixed',value}|{kind:'field',field,fallback}], header:[...]}
      filter TEXT NOT NULL DEFAULT '{}',         -- {tags:[id], tag_mode:'any'|'all', stage?:key}; JSON so hosted segments can extend it
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','queued','running','paused','cancelled','finished','failed')),
      pause_reason TEXT,                         -- error code + message when the system paused it
      total INTEGER NOT NULL DEFAULT 0,
      excluded INTEGER NOT NULL DEFAULT 0,       -- opted out, no phone, duplicate contact
      sent INTEGER NOT NULL DEFAULT 0,
      delivered INTEGER NOT NULL DEFAULT 0,
      read INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      header_media_id TEXT,                      -- uploaded once per broadcast
      header_media_at INTEGER,
      scheduled_at INTEGER,                      -- reserved, unused in WhaLeads
      created_by TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX broadcasts_status ON broadcasts(status, created_at)`,
    `CREATE TABLE broadcast_recipients (
      broadcast_id TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      lead_id TEXT,                              -- the lead that matched (newest if several)
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','sending','sent','delivered','read','failed','skipped','unknown')),
      params TEXT,                               -- resolved params, frozen at start
      wamid TEXT,
      error_code INTEGER,
      error_message TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      sent_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (broadcast_id, contact_id)
    )`,
    `CREATE INDEX broadcast_recipients_queue ON broadcast_recipients(broadcast_id, status, next_attempt_at)`,
    `CREATE INDEX broadcast_recipients_wamid ON broadcast_recipients(wamid) WHERE wamid IS NOT NULL`,
    `CREATE INDEX contacts_opted_out ON contacts(opted_out_at) WHERE opted_out_at IS NOT NULL`,
  ],
]

const ready = new WeakMap<D1Database, Promise<number>>()

export function ensureSchema(db: D1Database): Promise<number> {
  let p = ready.get(db)
  if (!p) {
    p = migrate(db).catch((e) => {
      ready.delete(db)
      throw e
    })
    ready.set(db, p)
  }
  return p
}

/**
 * Walks MIGRATIONS from the stored schema_version. Each step is ONE batch (a single D1 transaction):
 * [lock row `applied_<n>`, ...DDL, schema_version bump]. The lock insert has no ON CONFLICT, so an
 * isolate racing the same step fails the whole batch and rolls it back; it then re-reads the version
 * and carries on from wherever the winner got to. The bump is atomic with the DDL.
 * `applied_<n>` is the 1-based version a step produces. Databases created before the locks existed
 * get applied_1..applied_<v> backfilled (INSERT OR IGNORE) before the first locked step runs.
 */
async function migrate(db: D1Database): Promise<number> {
  await db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
  const readVersion = async () => {
    const row = await db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).first<{ value: string }>()
    return row ? Number(row.value) : 0
  }
  let v = await readVersion()
  if (v > 0 && v < MIGRATIONS.length) {
    const fill: D1PreparedStatement[] = []
    for (let n = 1; n <= v; n++) fill.push(db.prepare(`INSERT OR IGNORE INTO meta (key,value) VALUES (?, CAST(unixepoch() AS TEXT))`).bind(`applied_${n}`))
    await db.batch(fill)
  }
  while (v < MIGRATIONS.length) {
    const n = v + 1
    try {
      await db.batch([
        db.prepare(`INSERT INTO meta (key,value) VALUES (?, CAST(unixepoch() AS TEXT))`).bind(`applied_${n}`),
        ...MIGRATIONS[v].map((s) => db.prepare(s)),
        db.prepare(`INSERT INTO meta (key,value) VALUES ('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(String(n)),
      ])
      v = n
    } catch (e) {
      const now = await readVersion()
      if (now <= v) throw e // a real failure, not a lost race
      v = now // another isolate applied this step; continue from there
    }
  }
  return v
}

export async function logEvent(db: D1Database, kind: string, payload: unknown): Promise<void> {
  try {
    await db.prepare(`INSERT INTO events (kind,payload) VALUES (?,?)`).bind(kind, JSON.stringify(payload)).run()
  } catch {
    /* logging must never break a request */
  }
}
