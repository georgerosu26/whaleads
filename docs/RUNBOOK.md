# Runbook

How each part of the app behaves, for the person running an instance. Deploying is in [DEPLOY.md](DEPLOY.md); routes are in [API.md](API.md); automations in [AUTOMATIONS.md](AUTOMATIONS.md); adaptor setup in [ADAPTORS.md](ADAPTORS.md).

## Web app, setup and auth
`ui/` is a Vite + React SPA served by Workers Static Assets (`dist/`, built by `npm run build`). Only `/api/*` and `/webhooks/*` run the Worker first; any other path is a static file or falls back to `index.html`.

- **First boot.** Open `https://<host>/setup`. The setup key is the Worker's `SESSION_SECRET`. It creates the first admin, the business settings and a VAPID keypair (private half encrypted under a key derived from `SESSION_SECRET`), then signs you in. The lock is a single D1 batch, so two simultaneous setups yield one 201 and one 409. Without `SESSION_SECRET`, setup, login and recovery answer 503 `session_secret_missing`.
- **Passwords.** PBKDF2-SHA256, 100000 iterations, 16-byte salt, stored as `pbkdf2-sha256$<iter>$<salt>$<hash>`. Unknown or inactive accounts still run a full hash so timing does not reveal which emails exist. Minimum length 10.
- **Locked out (D26).** `https://<host>/recover` (linked from the login page as "Forgot your password?") resets any active account's password with the setup key, signs out all of that account's sessions and signs you in. It is meant for the owner; team members ask an admin (Settings, Team). A wrong key and an unknown or inactive email give the same 403 `invalid_recovery`. Limits: 5 attempts per 15 min per IP and 20 per hour across all IPs, every attempt counted. Each success writes a `staff_password_recovered` event. `ADMIN_KEY` with `POST /api/staff/:id/reset-password` remains the scripted route.
- **Sessions.** Cookie `wl_session=v1.<token>.<mac>` (`HttpOnly; Secure; SameSite=Lax`, 30 days, sliding, refreshed at most daily). The MAC is checked before any D1 read; D1 holds only the SHA-256 of the token.
- **CSRF.** Session requests that change state need `X-CSRF-Token` (from login/me) and an `Origin` equal to the request origin. The `ADMIN_KEY` bearer is for scripts, needs neither, and acts as admin.
- **One gate.** Every `/api/*` route other than health, intake, setup, login and recovery goes through `src/auth.ts`; `/api/admin/*` additionally needs the admin role. A staff row with `must_change_pw` can only reach `/api/auth/*` until it changes its password.

## Inbox
Every inbound and outbound message upserts the thread's `conversations` row (preview, `last_message_at`, `last_inbound_at`). Unread rises once per new `wamid`, so a replayed or doubly delivered webhook does not double it; an inbound message reopens a closed conversation. The 24 h reply window is open while `now - last_inbound_at < 86400 s`. Sending and media are later slices; the thread shows a window banner and no composer.

Live refresh (free-plan polling, no sockets): an open thread polls `GET /api/contacts/:id/messages?after=<id>` every 4 s (new messages, window and unread state, recent outbound statuses for the ticks), the list refreshes every 10 s and at once when the unread count changes, the nav badge every 15 s. Polling pauses while the tab is hidden, resumes immediately on focus, never overlaps itself and backs off to 30 s on errors. Sends are optimistic: the bubble shows at once and flips to sent; a failed one offers tap-to-retry.

Latency (D19): `POST /api/send`, `POST /api/inbox/:id/send`, `POST /api/inbox/:id/send-media` and both webhook POSTs return `Server-Timing: worker;dur=, upstream;dur=` plus the gateway's `wb`/`meta`/`auth` entries when it sends them (exposed to browsers via `Access-Control-Expose-Headers`). Each send also writes an `events` row of kind `send_timing` with `{route, status, timing:{worker, upstream, wb, meta, auth}}` for p50/p95 queries.

### Phone numbers
Stored form is E.164 digits without `+`. Input starting with `+` or `00` is read as international. Anything else is read against the default country: the `default_country` setting, then env `DEFAULT_COUNTRY`, then `IN`. Input that is not a possible number for that country is rejected.

### Schema v4: one-time `leads` rebuild
The first request after deploying the inbox release runs migration v4 as a single D1 batch under the `applied_4` lock: `leads` is rebuilt (v1 `CHECK` on `source` dropped, new columns added, ids and rows preserved), and `conversations`, `media`, `lead_tags`, `activity`, `quick_replies`, `push_subscriptions` are created and backfilled. If any statement fails the whole batch rolls back and the database stays on v3. Back up first: `wrangler d1 export <db> --remote --output backup.sql` (or note a Time Travel bookmark).

## Send and media

**Sending.** Text and media go out through the active adaptor (`sendText`, `sendMedia`; media is a two-step upload then send on both WhaBuzz and the Cloud API). Provider errors are passed through untouched. The composer disables free text when the 24h window is closed and shows a banner; the template picker takes over.

**Broadcast sends.** Queued broadcast messages are written like any outbound message but are paced by the cron, so the live inbox shows them as they go and the send counters under-report until the tick commits.

**Inbound media.** The webhook stores a `media` row in the same D1 batch as the message (`pending`), then copies the file from the provider into R2 at key `m/<message id>` (`stored`). Files over 25 MB become `too_large` and are not copied. A failed copy stays `pending` and is retried by the 15-minute cron jobs (minutes divisible by 15, at most 10 rows per run); after 5 attempts the row becomes `failed`. The thread shows "only on the phone" for `failed` and `too_large`. The same cron deletes expired sessions and rate-limit rows.

**R2 binding.** `wrangler.jsonc` declares `r2_buckets: [{ binding: "MEDIA", bucket_name: "whaleads-media" }]`; create the bucket before deploying (`wrangler r2 bucket create whaleads-media`). **Without the binding** inbound rows stay `pending`, the cron skips them, and `GET /api/media/:id` proxies the file live from the provider each time (nothing is kept, so it stops working when the provider's copy expires). Outbound media rows are then marked `failed` with `r2_unbound`.

**Local mock.** `WHABUZZ_BASE_URL` may be an `http://127.0.0.1` or `localhost` address for local mock servers (used by the e2e); anything else must be https on whabuzz.com.

## Broadcasts

**What it is.** One approved template sent to the leads carrying chosen tags (optionally one stage). One message per contact, however many leads they have. "All contacts" needs the explicit `all` flag and a typed confirmation of the audience count. One broadcast runs at a time; a second `start` is refused until the first finishes or is cancelled.

**Pacing.** The existing every-minute cron sends a slice of the queue after the flow tick. `broadcast_per_minute` (Settings, 1 to 40, default 20) is a ceiling, not a promise: on the Workers Free plan one invocation allows 50 subrequests, each send costs two (the WhatsApp call and one D1 batch), and the step reserves six calls for the cron's own bookkeeping, so about 16 sends fit in an idle tick and about 11 when a flow tick also runs. Flows and media jobs share that budget and win when busy, and on quarter-hour firings the step leaves room for the other jobs. A 1,000 contact broadcast therefore takes roughly an hour. The Free plan CPU limit (10 ms per invocation) is a risk for large ticks; if ticks start failing, lower `broadcast_per_minute` or move to the Paid plan.

**Opt-outs.** Honoured at preview, at start, and again before every message. A contact opts out by sending a whole-message keyword (stop, stop all, unsubscribe, opt out, optout, stop messages, no more, band karo, band; case and trailing punctuation ignored; start or subscribe opts back in, but only undoes a keyword opt-out), when Meta returns 131050 (the user stopped marketing messages), or by staff (`PATCH /api/contacts/:id/opt-out`). Opted-out contacts still receive one-to-one replies; only broadcasts skip them.

**Automatic pauses.** The broadcast pauses itself, with the reason on the broadcast, on account-level errors: template paused, disabled or not approved, quality or ecosystem limits (131048, 132000 to 132016, 131042, 131031, 133010), and bad credentials (368, 190, HTTP 401). Fix the cause, then Resume. Throttling (130429, 4, 80007, HTTP 429) stops the tick and retries with backoff, up to 3 attempts per recipient. Recipient-level errors (131026, 131049, 131009, 131008, 131021) mark only that recipient failed.

**Unknown recipients.** If a send times out or a worker dies mid-send, the recipient is `unknown`, never retried automatically, because the message may already have gone out. Check the chat, then use Requeue unknown only for people who did not receive it.

**Counters and receipts.** Delivered and read counts come from status webhooks matched by message id. A receipt that arrives before the recipient's own `sent` write finishes is not counted (the message row still updates), so delivered and read can under-count by a few. Use the recipient list as the source of truth.

## Templates

Schema v6 adds `templates` (unique on name + language; the upgrade is additive and lock-guarded like v4 and v5).

| Route | Who | What |
|---|---|---|
| `GET /api/templates` | staff | Stored list. Stored list only; `?sync=1` is ignored (sync is `POST /api/templates/sync`). |
| `POST /api/templates` | admin | Create (JSON, or multipart: `payload` JSON + `sample` file for IMAGE/VIDEO/DOCUMENT headers). |
| `DELETE /api/templates/:id` | admin | Deletes at the provider (404 ignored), then locally. |
| `POST /api/templates/sync` | staff | Pull and upsert. Statuses update; `rejected_reason` is stored exactly as the provider returns it. |
| `GET /api/templates/:id/media` | staff | The stored header sample. |
| `GET /api/templates/recent-media?format=` | staff | Recent stored outbound files of that kind, for the header picker. |
| `POST /api/inbox/:id/send-template` | staff | Send an APPROVED template (422 `template_not_approved` otherwise; 422 `template_not_sendable` for named or button variables, authentication, location headers). Allowed outside the 24 hour window (free text there stays 409). |

All sit behind the session gate; state changes need the CSRF header.

**Meta rules enforced** (`src/templateRules.ts`, shared with the form): name `[a-z0-9_]` up to 512; language like `en` or `en_US`; category UTILITY, MARKETING or AUTHENTICATION (below); body up to 1024 characters; up to 10 variables numbered `{{1}}`.. with no gaps and a sample for each; a body that starts or ends with a variable is a warning; footer up to 60 with no variables; text header up to 60 with at most one variable and a sample; media headers need a sample file. Send values may not be empty, hold line breaks or tabs, or run 4+ spaces. Provider errors pass through verbatim; known Meta subcodes (for example 2388293, too many variables for the body length) also get a `field` and a `hint`.

**Media-handle flow.** A header sample is uploaded first and the returned handle goes in `example.header_handle`. WhaBuzz: `POST /templates/media-handle` (multipart `file`, `type`) returns `{h}`. Cloud API: `POST /{app_id}/uploads` opens a session, then the bytes go to `POST /{session}` with `Authorization: OAuth <token>` and `file_offset: 0` (needs `app_id` in the config). The sample is also kept in R2 at `t/<uuid>` and is the default header when sending.

**Sending.** Parameter counts must match the template (400 with `field`). Header media comes from the template default, a recent stored file (`header_message_id`) or a fresh upload; it is uploaded to the provider and referenced by `id`. The stored message is type `template` with the rendered text, and reuses the existing deferred-record path, so the response shape, optimistic bubble and live publish match text and media sends.

**Authentication templates (one-time codes).** Meta writes the body ("{{1}} is your verification code."), so the form only asks for three options: the security note, a code expiry of 1 to 90 minutes (a footer line) and the copy-code button text (up to 25 characters). One-tap and zero-tap buttons need a signed Android app and are not offered. These templates are never sendable from the inbox composer, a flow or a broadcast; the list shows them as "Sent by API only". The one send path is `POST /api/send-otp` with the `ADMIN_KEY` bearer, called from your own backend:

- Limits: 30 per minute for the whole deployment and 5 per destination number per 10 minutes. A burst past either gets 429 with `limit` saying which.
- An unknown number creates no contact and no lead. A known contact shows a `[one-time code]` row in the thread. The code itself is never stored, logged or put in an event.
- Meta bills authentication messages per message and may reject a code sent to a number that is not on WhatsApp. The error comes back verbatim.
- The `ADMIN_KEY` also opens the staff API. Keep it on the server and rotate it with `wrangler secret put ADMIN_KEY` if it leaks.

**Management.** The list filters by category, status and language and shows Meta's quality rating on approved templates (GREEN, YELLOW, RED; pending until Meta has data). A rejected template shows Meta's reason with a plain-words hint and a "Fix and resubmit" button that opens Create pre-filled under a new name (`_v2`); "Duplicate" does the same for any template. Samples and media are not kept, so they are entered again. PAUSED and DISABLED templates explain what they mean. Delete asks for confirmation in a dialog and is refused (409 `template_in_use`) while a draft, queued, running or paused broadcast still uses the template.

**Cron.** The scheduled handler syncs templates hourly, and only while some template is PENDING (a PENDING row with no sync, or one older than 55 minutes). With none pending it makes no provider call.

## CRM

All routes need a session or `Bearer <ADMIN_KEY>`; writes from a browser session also need `X-CSRF-Token`. Unix seconds everywhere. Cursors are `created_at.id` style strings; a malformed one is `400 bad cursor`.

| Route | Notes |
|---|---|
| `GET /api/leads?stage=&kind=open\|won\|lost&source=&owner=me\|none\|<id>&tag=<id>&q=&before=&limit=` | newest first, tags attached, `next_before` |
| `GET /api/leads/board?per_stage=` | every active stage with its `count`, the newest `per_stage` leads and a `next_before` (page a column with `GET /api/leads?stage=&before=`); same filters as the list except `stage` |
| `GET /api/leads/owners` | active staff, for owner pickers |
| `POST /api/leads/manual` | `{phone, name?, email?, message?, source?='manual', assigned_to?, next_action_at?, tag_ids?}`; phone goes through the same normaliser as the inbox (instance default country); `409 open_lead_exists` with `lead_id` if the contact already has an open lead. (`POST /api/leads` stays the public form intake.) |
| `GET /api/leads/:id?activity_before=` | lead, attribution, activity timeline (newest first, `actor_name`, `activity_next_before`), conversation summary |
| `PATCH /api/leads/:id` | any of `status` (must be an active stage), `assigned_to` (active staff or null), `next_action_at`, `lost_reason` (only with a lost stage), `tag_ids`. Won stamps `won_at` and `closed_at`; lost stamps `closed_at` and `lost_reason`; moving back to an open stage clears all three. |
| `GET/POST /api/leads/:id/notes`, `POST /api/leads/:id/calls`, `PUT /api/leads/:id/tags` | note `{text}`; call `{outcome: answered\|no_answer\|busy\|voicemail\|wrong_number, duration_s?, note?}`; tags `{tag_ids}` (ids only, tag creation stays admin in Settings) |
| `GET /api/contacts?q=&before=&limit=`, `GET/PATCH /api/contacts/:id` | search by name, email or digits; detail merges leads and conversation; PATCH `{name?, email?}` |
| `GET /api/today` | buckets in the instance timezone: `overdue` (next action before today 00:00), `due_today`, `new` (open leads in stage `new`), `unanswered` (open conversations whose last message is inbound), plus `counts`, `day_start`, `day_end`. Up to 50 per bucket. |

Every change writes a `lead_activity` row: `lead_created`, `stage_changed`, `assigned`, `next_action`, `tag_added`/`tag_removed`, `note`, `call`, `referral`, `contact_updated`. `first_response_at` is stamped by the first outbound message after the contact has written to you (not by a message you send first).

### Click-to-WhatsApp referral attribution

An inbound message carrying Meta's `referral` object (or a `ref:CODE` token in the text) is attributed like this:

1. The contact has no open lead: only an ad click (`referral` object) creates a lead (source `ctwa`). A typed `ref:CODE` never creates one (typed codes are attribution only, see Reports); it attributes an existing lead and adds the activity row.
2. The contact has an open lead: the referral is applied to the newest open lead (else the newest lead). Existing attribution is never overwritten (first touch wins); a second referral only adds a `referral` activity row.
3. Stored on the lead: `ctwa_clid`, `ad_source_id`, and `attribution` (`source_url`, `source_type`, `headline`, `body`, `media_url`, `ref_code`), each clipped to 500 characters. Only http(s) URLs are rendered as links in the UI.
4. Replays of the same message id do nothing.

## Push and install
Staff get Web Push (VAPID, RFC 8291 encryption, WebCrypto only) instead of WhatsApp alerts. **D17: there are no WhatsApp staff alerts; `ALERT_TO`, the alert template and `src/alerts.ts` are gone.** Push never blocks the webhook response (`ctx.waitUntil`).
- A new lead goes to all active staff. An inbound message goes to the chat's assignee if active, else all active staff. At most 40 subscriptions per send.
- A 404 or 410 from the push service deletes the subscription; 5 consecutive failures delete it too, and the cron purges any left at 5.
- Payload: title (business name), body, URL, tag.
- Routes (behind the gate, CSRF on changes): `GET /api/push/vapid` (public key), `POST /api/push/subscribe`, `DELETE /api/push/subscribe` or `POST /api/push/unsubscribe`, `POST /api/push/test` (returns `{sent}` to the caller's own devices). Max 10 devices per person.
- PWA: `manifest.webmanifest`, icons and `sw.js` ship with the SPA. Android and desktop Chrome offer install; on iPhone use Share, Add to Home Screen (push works only from the installed app). Enable from Settings, My profile, Notifications.

## Settings, staff and pipeline
All routes below need a staff session (cookie + `X-CSRF-Token`) or the `ADMIN_KEY` bearer. Reads are open to any staff; writes are admin only unless noted. Errors are `{ok:false, error, field?}`.

| Route | Purpose |
|---|---|
| `GET /api/settings` | `{settings, sources}`. `sources` says where each value came from (`setting`, `env`, `default`). Secrets are never returned; admins also get `settings.ai = {configured, last4, readable}`. |
| `PUT` or `PATCH /api/settings` | Any of `business_name`, `default_country` (ISO code), `timezone`, `working_hours`, `allowed_origins` (max 20; `null` reverts to env), `anthropic_key` (`null` removes; stored encrypted, write-only). |
| `GET /api/staff` | Team list. |
| `POST /api/staff` | `{name, email, role}` -> 201 `{staff, temp_password}`. The temp password is shown once; the user must change it at first login. 409 `email_taken`. |
| `PATCH /api/staff/:id` | `{name?, role?, active?}`. 409 `last_admin` if it would leave no active admin. Deactivating signs the user out. |
| `POST /api/staff/:id/reset-password` | New temp password, `must_change_pw` set, that user's sessions revoked. A session admin cannot reset themself (400 `use_profile`); `ADMIN_KEY` can, for lock-out recovery. |
| `PATCH /api/auth/me` | Any staff: `{name}`. |
| `GET/POST /api/stages`, `POST /api/stages/reorder {keys}`, `PATCH/DELETE /api/stages/:key` | Ordered stage list (`?all=1` includes archived; rows carry `lead_count`). Delete or archive with leads in the stage is 409 `stage_has_leads` unless `move_to` names another active stage. `new` is protected; at least one active stage of each kind (open, won, lost) must remain. |
| `GET/POST /api/sources`, `PATCH /api/sources/:key` | Lead sources. Built-in ones are locked (409 `system_locked`). |
| `GET/POST /api/tags`, `PATCH/DELETE /api/tags/:id` | Tags with a colour from a fixed palette (the GET also returns `colors`). |

The WhaBuzz API host is not a setting: it is the optional env var `WHABUZZ_BASE_URL` (https and `api.whabuzz.com` or `*.whabuzz.com` only, default `https://api.whabuzz.com/v1`), because the API key is sent to it. A `base_url` in an adaptor PUT is ignored.

`GET /api/setup/status` also returns `default_country` (from `DEFAULT_COUNTRY`, else `null`) so the setup page can preselect it.

UI pages: `/settings` (home), `/settings/business`, `team`, `pipeline`, `forms` (allowed websites and the `/api/leads` endpoint), `whatsapp` (status, Connect to WhaBuzz form, collapsed Cloud API form, webhook URL), `ai`, and `profile` (all staff; the rest are admin only).

### Setting fallbacks
Resolved on every read as setting > env > default. Raw rows are cached per isolate for 30 s and cleared by a write on that isolate, so settings changes (the CORS origins list included) reach other isolates within about 30 s.

| Setting | Env fallback | Default |
|---|---|---|
| `business_name` | `INSTANCE_NAME` | `WhaLeads` |
| `default_country` | `DEFAULT_COUNTRY` | none (the setup page suggests `IN`) |
| `timezone` | `TIMEZONE` | `UTC` |
| `allowed_origins` | `ALLOWED_ORIGINS` (comma list) | none (browser forms blocked) |
| `working_hours` | none | none |

## Live channel (D20)
One WebSocket per browser tab to `GET /api/live`, backed by a single SQLite Durable Object (`LiveHub`, binding `LIVE`, `idFromName('hub')`, Hibernation API, ping/pong auto-response, nothing stored). D11 allows exactly this one DO per instance.
- Auth: the session cookie. No session 401; ADMIN_KEY 400 (staff only); an Origin whose host differs from the request 403; non-Upgrade 426; no `LIVE` binding 503. Staff id and role are forwarded to the hub in headers. Sockets are closed after 12 h (the browser reconnects through the gate) and capped at 100.
- Revocation: sockets are tagged `staff:<id>` and `sid:<session hash>`. Logout (by session), deactivation and admin password reset (by person) and self password change (by person, except the current session) call `LiveHub.revoke`, best effort off the request path. The hub sends a `revoked` frame and closes with code 4001; the browser treats either as final (no reconnect), and its next poll meets the 401. The 12 h age cap remains as a backstop.
- Events, JSON `{type, ts, data}`: `message.new`, `message.status`, `conversation.update`, `unread.total`, `lead.new`, `lead.update`. They are published from `src/live.ts` inside `ctx.waitUntil` after the D1 write succeeded; a publish failure is logged as `live_publish_error` and never fails a webhook or a send.
- Browser (`ui/src/lib/live.ts`): jittered backoff 1 s to 30 s, `ping` every 25 s (a silent link is dropped), one full refresh on every (re)connect.
- Fallback: polling is never removed. Socket open: thread 30 s, list 60 s, badge off. Socket not open: thread 4 s, list 10 s, badge 15 s. `?after=` is unchanged.
- `data-live="open|connecting|closed"` on the app shell root reports the state (used by the e2e).
- Config (generic `wrangler.jsonc`; add the same to each instance):
```jsonc
"durable_objects": { "bindings": [{ "name": "LIVE", "class_name": "LiveHub" }] },
"migrations": [{ "tag": "v1-live", "new_sqlite_classes": ["LiveHub"] }],
```

## Reports, export and import

**Reports** (`/reports`, any signed-in staff). `GET /api/reports/overview?from=YYYY-MM-DD&to=YYYY-MM-DD` (both inclusive, in the instance timezone; default the last 30 days; max 366 days, else 400). It reports the cohort of leads created in the range:

- `totals`: leads, won, lost, open, `conversion` (won / leads), `win_rate` (won / closed), median and p90 first response in seconds (leads whose `first_response_at` is on or after creation), `unanswered_now` (open chats with unread messages, as of now; read from the partial unread index).
- `by_source` (ctwa rows carry `campaigns` grouped by ad source id and headline), `by_stage`, `by_staff` (Unassigned has `id: null`), and `weekly` (ISO weeks starting Monday in the instance timezone: new leads, messages in, messages out).
- Won and lost use the lead's current stage kind. A range with more than 100,000 leads is cut off and `truncated` is true. The messages query rides the `messages_ts_idx` index (schema v8).
- Click an ad on the page to open Leads filtered by `?campaign=<ad source id>` (`GET /api/leads` and the board take the same param).

**Export** (admin only, each download logs an `export` event, GET, streamed):

- `GET /api/export/leads.csv`: UTF-8 with BOM, CRLF, one row per lead. Columns: `id, created_at, name, phone, email, source, stage, owner, owner_email, tags, next_action_at, won_at, closed_at, lost_reason, first_response_at, message, utm_source, utm_medium, utm_campaign, gclid, ctwa_clid, referral_source_id, referral_source_type, referral_source_url, referral_headline`. Times are ISO 8601 UTC, phones are `+digits`, tags are joined with `;`. Cells that start with `=`, `@`, a tab, or `+`/`-` followed by text get a leading `'` so spreadsheets do not run them; the importer strips it again.
- `GET /api/export/full.json`: `{"whaleads_export":1, "exported_at", "instance", ...}` with the sections `settings, staff, stages, sources, tags, contacts, leads, lead_tags, activity, conversations, messages, media, quick_replies` (plus `templates` when that table exists). Secrets are left out: encrypted or key-like settings, password hashes, raw webhook payloads. Media rows list the R2 key; the bytes are not included.
- `GET /api/export/log`: the last 20 export and import events plus the import limits.

**Import** (admin only, CSRF like every write). Three steps, none of which keeps an upload on the server:

- `POST /api/import/leads`, multipart: `file` (CSV, comma, semicolon or tab delimited, header row required), `mode` (`inspect` or `preview`) and, for `preview`, `mapping` (JSON `{field: column index}`). The body is read with a hard byte cap (a bigger `Content-Length` is a 413 before any byte is read), and parsing stops at 5,001 rows. `inspect` returns headers, 5 sample rows, the row count and an auto-detected mapping. Fields: `phone` (required), `name, email, source, stage, tags, notes, owner_email, message, created_at, next_action_at, lost_reason, external_id`. `preview` is a dry run: counts, the first 50 rows with the action each would take, per-row errors (first 200, spreadsheet row numbers, header = row 1) and the tags that would be created. Nothing is written. `mode=commit` here is a 400 that points at the route below.
- `POST /api/import/leads/commit`, JSON, driven by the browser: `{import_id, chunk, file, mapping, rows, last?, totals?}`. The page parses the CSV itself and sends at most 100 already-split rows per request (101 is a 413 `chunk_too_large`; body cap 256 KB). `chunk` is the 0-based index (it only sets the row numbers in errors), `import_id` is 8 to 64 characters of `A-Za-z0-9_-`. The last request sets `last: true` and `totals` (sums over the earlier chunks) and the server writes one `import` event. One chunk is one D1 batch plus four or five lookups, so each request stays small enough for the free plan's 10 ms CPU limit.
- Dedupe is per row, for every stage. Each row gets a stable key, stored in `leads.external_id` (indexed): `imp:x:<phone>:<id>` when the file has an id column (`external_id`, `lead id`, `ref` and similar), else `imp:h:<phone>|<source>|<created_at>|<stage>` (a row with no date uses `na`, never today). A row whose key already exists is skipped, so re-uploading a file, or sending a chunk again after a lost response, creates nothing. An open row is also skipped when the contact already has an open lead. Won and lost rows take `won_at` and `closed_at` from the row's `created_at`, so history does not show up in the current week's report.
- Phones are normalised to E.164 with the instance default country. An existing contact gets a new lead and its blank name and email are filled. Unknown source falls back to `import`, unknown stage to `new`, an invalid email is dropped; each is a warning. Every created lead gets an `imported` activity (and a `note` when notes are mapped).
- Limits: 5,000 rows (413 `too_many_rows`) and 2 MB (413 `file_too_large`).
- Workers limits, from the [Workers limits page](https://developers.cloudflare.com/workers/platform/limits/) (checked 2026-10-19): a subrequest is any `fetch()` or any call to a Cloudflare service such as R2, KV or D1. The free plan allows 50 per invocation for outbound fetches and 1,000 to internal services (D1 calls count toward the 1,000, not the 50); the paid plan matches the configured limit (default 10,000). A 100-row chunk uses about ten D1 calls. CPU time is 10 ms on the free plan. Streaming the exports keeps memory flat and each read small, but it does not lower total CPU: on the free plan a very large `full.json` can still pass 10 ms, so run big exports on the paid plan.
- UI: Settings, Data (export buttons, the four-step wizard with a progress bar while chunks upload, recent activity).

## Build and run
- `npm run dev` runs the Worker (`wrangler dev`, port 8787; `build.command` builds the SPA first). Put `SESSION_SECRET` and `ADMIN_KEY` in `.dev.vars`.
- `npm run dev:ui` runs Vite with HMR and proxies `/api` and `/webhooks` to `:8787`.
- `npm run build` writes the SPA to `dist/`. `npm run typecheck` checks the Worker and `ui/`.

## Tests
`npm test` (vitest, no Cloudflare runtime needed; D1 is shimmed over `node:sqlite`, so the real migrations and SQL run).
`npm run test:e2e` runs the Playwright smokes in `test/e2e/` (setup and login, password recovery, settings, inbox at 360 and 1280 with a signed WhaBuzz webhook, send and media, CRM create/stage/note/Today, push, templates, automations, reports, Connect to WhaBuzz, live socket). `PW_PORT` changes the port (default 8799) against `wrangler dev` with a throwaway local D1. Set `PW_CHROMIUM` to a Chromium binary if `npx playwright install` has not been run.

