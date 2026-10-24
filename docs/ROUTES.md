# Routes: auth, CSRF and rate limits

Every route the Worker serves (`/api/*`, `/webhooks/*`). The SPA and static files never reach the Worker; their headers come from `ui/public/_headers`.

**Auth columns**
- **public**: no credentials.
- **staff** / **admin**: a session cookie (`wl_session`, HttpOnly, Secure, SameSite=Lax) for that role, or the `ADMIN_KEY` bearer. The bearer counts as admin.
- Sessions with `must_change_pw` get `403 password_change_required` everywhere except `/api/auth/me` and `/api/auth/password`.

**CSRF**: on every non-GET request, cookie sessions must send `X-CSRF-Token` and an `Origin` equal to the instance origin. The token comes from `/api/auth/me` and is checked in `require()`. The `ADMIN_KEY` bearer is exempt. It is only read from `Authorization`, never from a cookie.

**Limits**: D1 fixed windows (`src/ratelimit.ts`, `src/routelimits.ts`). They are keyed per session, or as `api` for the bearer, and only count once auth and CSRF pass.

**Headers**: all Worker responses carry nosniff, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`, `Permissions-Policy` and a CSP (`src/headers.ts`).

## Public

| Route | Auth | CSRF | Limit | Notes |
|---|---|---|---|---|
| GET `/api/health` | public | - | - | No exception text in the body |
| GET `/webhooks/meta` | public | - | - | Verify ping: constant-time `hub.verify_token` |
| POST `/webhooks/meta` | `X-Hub-Signature-256` over the raw body | - | - | 401 on a bad signature; idempotent by wamid |
| POST `/webhooks/whabuzz` | HMAC signature + timestamp | - | - | Same as above |
| POST `/api/whabuzz/webhook` | HMAC signature + timestamp; an unsigned `webhook.verify` ping only while no WhaBuzz secret is saved or a connect is pending | - | - | Alias of `/webhooks/whabuzz`, registered by Connect. Any other unsigned event is 401 in every state |
| POST, OPTIONS `/api/leads` | Origin in `allowed_origins` | Origin check | 10/min per IP | Form intake (CORS) |
| GET `/api/whabuzz/callback` | public, then session (non-staff gets 302 to `/login?next=`; non-admin gets `connect_error=forbidden`) | - (GET; state + PKCE instead) | 10 per 10 min per IP while signed out; 10 per 10 min per staff once signed in | Always ends in `state_mismatch` after a login redirect (new session = new sid). Single-use pending row, spent only after session + state + expiry check; redirects carry no-store and no-referrer |
| GET `/api/setup/status` | public | - | - | |
| POST `/api/setup` | setup key (= `SESSION_SECRET`), same-origin | Origin | 5 per 15 min per IP | Locked once any staff row exists |
| POST `/api/auth/login` | public | - | 10 per 15 min per IP; 5 per email | |
| POST `/api/auth/recover` | setup key (= `SESSION_SECRET`), same-origin | Origin | 5 per 15 min per IP; 20 per hour across all IPs (every attempt counts) | D26. Wrong key and unknown/inactive email are the same 403 `invalid_recovery`. Ends all of that staff's sessions and sockets, then signs in |
| POST `/api/auth/logout` | session | yes | - | Deletes the session and closes its sockets |
| GET `/api/auth/me` | session (must_change allowed) | - | - | |
| PATCH `/api/auth/me` | session | yes | - | |
| POST `/api/auth/password` | session (must_change allowed) | yes | 5 per 15 min per staff | |

## Staff

| Route | Auth | CSRF | Limit |
|---|---|---|---|
| GET `/api/live` (WebSocket) | staff | Origin must equal host | 100 sockets per instance; revoked on logout, deactivate or reset |
| POST `/api/send`, `/api/inbox/:id/send`, `/send-media`, `/send-template` | staff | yes | `send` 60/min |
| GET `/api/inbox`, `/api/inbox/unread`, `/api/contacts/:id/messages` | staff | - | - |
| POST `/api/conversations/:id/read`; PATCH `/api/conversations/:id` | staff | yes | - |
| GET, POST `/api/quick-replies`; PATCH, DELETE `/api/quick-replies/:id` | staff (shared team list) | yes | - |
| GET `/api/media/:messageId` | staff | - | DB id only; `sandbox` CSP, allowlisted inline types |
| GET `/api/leads`, `/leads/board`, `/leads/owners`, `/leads/:id`, `/leads/:id/notes` | staff | - | - |
| POST `/api/leads/manual`, `/leads/:id/notes`, `/leads/:id/calls`; PATCH `/leads/:id`; PUT `/leads/:id/tags` | staff | yes | - |
| GET `/api/contacts`, `/contacts/:id`; PATCH `/contacts/:id` | staff | PATCH: yes | - |
| GET `/api/today`, `/api/reports/overview` | staff | - | - |
| GET `/api/stages`, `/api/sources`, `/api/tags` | staff | - | - |
| GET `/api/templates`, `/templates/recent-media`, `/templates/:id/media` | staff | - | - |
| POST `/api/templates/sync` | staff | yes | `tplsync` 10/min |
| POST `/api/send-otp` | Bearer `ADMIN_KEY` only (a session, even admin, gets 403) | no (no cookie) | `otp` 30/min deployment-wide, plus 5 per destination per 10 min |
| GET `/api/push/vapid` | staff | - | - |
| POST, DELETE `/api/push/subscribe`; POST `/api/push/unsubscribe` | staff | yes | `pushsub` 30/min |
| POST `/api/push/test` | staff | yes | `pushtest` 5/min |
| GET `/api/flows`, `/flows/:id`, `/flows/:id/runs`, `/api/flow-runs/:id`, `/api/leads/:id/flow-runs` | staff | - | - |
| POST `/api/flows/:id/dry-run` | staff | yes | 10/min per staff; HTTP nodes skipped |
| GET `/api/broadcasts`, `/broadcasts/:id`, `/broadcasts/:id/recipients` | staff | - | `bcread` 240/min |
| PATCH `/api/contacts/:id/opt-out` | staff | yes | `optout` 60/min |
| GET `/api/settings` | staff (AI key shown as `last4`, admins only) | - | - |

## Admin

| Route | Auth | CSRF | Limit |
|---|---|---|---|
| PUT, PATCH `/api/settings` | admin | yes | - |
| POST `/api/broadcasts/preview` | admin | yes | `bcpreview` 30/min |
| POST `/api/broadcasts`, `/broadcasts/:id/start`, `/pause`, `/resume`, `/cancel`, `/requeue-unknown`; PATCH, DELETE `/api/broadcasts/:id` | admin | yes | `bcwrite` 30/min |
| GET `/api/staff`; PATCH `/api/staff/:id` | admin | PATCH: yes | Deactivating deletes sessions and closes sockets |
| POST `/api/staff`, `/api/staff/:id/reset-password` | admin | yes | `staffwrite` 20 per 10 min |
| POST, PATCH, DELETE `/api/stages`, `/stages/reorder`, `/api/sources`, `/api/tags` | admin | yes | - |
| POST `/api/templates`; DELETE `/api/templates/:id` | admin | yes | `tplcreate` 20/h (create); delete is 409 `template_in_use` while a draft, queued, running or paused broadcast uses it |
| POST, PUT, DELETE `/api/flows`, `/flows/:id`, `/flows/:id/{publish,pause,archive,duplicate}`, `/api/flow-runs/:id/cancel` | admin | yes | 60/min per staff |
| GET `/api/export/leads.csv`, `/api/export/full.json` | admin | - | `export` 10/h |
| GET `/api/export/log` | admin | - | - |
| POST `/api/import/leads` | admin | yes | `import` 30/min |
| POST `/api/import/leads/commit` | admin | yes | `importcommit` 120/min |
| GET, PUT `/api/admin/adaptor` | admin | PUT: yes | Secrets masked to `••••last4` |
| POST `/api/connect/whabuzz/start` | admin (staff session; the bearer gets 403) | yes | 5 per 10 min per staff (in handler) | 409 `connect_unavailable` unless `WHABUZZ_CONNECT_BASE` is set. Stores the encrypted PKCE pending row |
| POST `/api/admin/setup` | admin | yes | `adminsetup` 5 per 10 min |

New routes belong in this table, and in `ROUTE_LIMITS` when the route sends, spends or fans out.
