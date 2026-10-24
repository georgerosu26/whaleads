# Deploy

WhaLeads is one Cloudflare Worker with a D1 database, an R2 bucket for media, one Durable Object class for the live inbox and an every-minute cron. All of it is declared in [`wrangler.jsonc`](../wrangler.jsonc), so the Deploy button and `wrangler deploy` create the same thing in your own Cloudflare account. Nothing runs anywhere else. No telemetry, no phone-home; sends go through WhaBuzz only when you choose the WhaBuzz adaptor.

## Option 1: the Deploy to Cloudflare button

Check the "Before you press it" list in the [README](../README.md) first: a `workers.dev` subdomain picked, R2 enabled, a GitHub or GitLab account, a saved session secret. Then use the button. It:

1. copies this repository into your GitHub or GitLab account (the repository must be public for the button to work);
2. reads `wrangler.jsonc` and creates the D1 database (`whaleads-db`) and the R2 bucket (`whaleads-media`) in your account, and the Durable Object class from the `v1-live` migration;
3. asks for the one secret listed in [`.dev.vars.example`](../.dev.vars.example): `SESSION_SECRET`;
4. builds with `npm run build` and deploys (the build is skipped the second time it is asked for, so the deploy does not build twice); you can rename the Worker on that page;
5. leaves the Worker on `https://<worker-name>.<your-subdomain>.workers.dev`.

The new repository is connected to Cloudflare's Workers Builds, so pushing to it redeploys.

### First run

1. **Deploy** with the button. Paste a `SESSION_SECRET` of 32+ random characters (`openssl rand -hex 32`) and keep a copy.
2. **Open** the `workers.dev` URL the deploy ends on. A fresh instance sends you to `/setup`. If the deploy ends with no URL, the account has no `workers.dev` subdomain yet (new accounts pick one on first use): open the Worker, Settings, Domains & Routes, add `workers.dev`, choose a subdomain, and the address appears.
3. **Set up.** Enter the same `SESSION_SECRET` as the setup key, then your business name, your name, email and a password (10+ characters). This creates the first admin and locks `/setup`.
4. **Connect WhatsApp.** Settings, WhatsApp: connect with WhaBuzz, or enter your own Meta Cloud API app. The banner at the top of the app takes you there. See [ADAPTORS.md](ADAPTORS.md).
5. **Add staff.** Settings, Team. Each person signs in, then turns on notifications from Settings, My profile (web push; on iPhone, add the app to the Home Screen first).

**Locked out?** Open `/recover` ("Forgot your password?" on the login page), enter the same `SESSION_SECRET` as the setup key, your email and a new password. It signs out your other sessions and signs you in. Team members ask an admin to reset theirs from Settings, Team. For scripts, `ADMIN_KEY` with `POST /api/staff/:id/reset-password` remains the alternative.

Then point your website forms at `POST https://<your-host>/api/leads` (see [API.md](API.md)) and add your site under Settings, Lead forms so the origin is allowed.

## Option 2: from the command line

```bash
git clone <your copy of this repo> && cd whaleads
npm ci
npx wrangler login                     # or export CLOUDFLARE_API_TOKEN
npx wrangler deploy                    # builds the app, creates D1 + R2 + the Durable Object, uploads
npx wrangler secret put SESSION_SECRET # paste: openssl rand -hex 32
```

`wrangler deploy` writes the new D1 id into your copy of `wrangler.jsonc`; keep that change in your own copy only. The schema migrates itself on first request, so there are no migration commands.

## After deploying

- **Custom domain.** Cloudflare dashboard, your Worker, Settings, Domains and Routes, Add, Custom domain. Or add a `routes` entry with `"custom_domain": true` to your own copy of `wrangler.jsonc`. Then add the new origin under Settings, Lead forms, and re-register the webhook URL with your adaptor if you had already connected one.
- **Placement.** The template uses Smart Placement because a self-hoster's D1 region is not known in advance. If you know it, you can replace `"placement": { "mode": "smart" }` with a pinned region (see the Cloudflare placement docs) to run the Worker next to the database.
- **Scripted access (optional).** The browser app needs only the session. For scripts, set an optional bearer key: `openssl rand -hex 24 | npx wrangler secret put ADMIN_KEY`. Without it, bearer access is off.
- **Upgrading.** Pull the new release into your copy of the repo and push; the schema upgrades itself on the next request.
- **Logs.** Observability is on; use the Worker's Logs tab, or `npx wrangler tail`.

## Environment reference

| Name | Kind | Needed | Purpose |
|---|---|---|---|
| `SESSION_SECRET` | secret | yes | Signs sessions, encrypts the saved WhatsApp connection and push keys, and is the key you type on `/setup` and `/recover`. Changing it makes the saved connection unreadable (Health shows `adaptor_error`, `/webhooks/whabuzz` answers 503); save the connection again. |
| `ADMIN_KEY` | secret | no | Bearer key for scripts; acts as admin. Unset means off. |
| `INSTANCE_NAME` | var | no | Default business name before you set one. Template value: `WhaLeads`. |
| `ALLOWED_ORIGINS` | var | no | Comma list of form origins. Settings, Lead forms overrides it. Not in the template on purpose: the Deploy button asks for a value for every empty var. |
| `WHABUZZ_BASE_URL` | var | no | WhaBuzz API host. https on `*.whabuzz.com` only; `http://127.0.0.1` or `localhost` for local mocks. |
| `META_GRAPH_VERSION`, `META_APP_ID`, `META_WABA_ID`, `META_PHONE_NUMBER_ID` | vars | no | Legacy Cloud API path. Not needed once an adaptor is saved in Settings. |
| `META_SYSTEM_TOKEN`, `META_APP_SECRET`, `WEBHOOK_VERIFY_TOKEN` | secrets | no | Legacy Cloud API path, same as above. |

## Limits worth knowing

The Workers Free plan is supported (one SQLite-backed Durable Object is allowed on it). Subrequest, CPU and storage limits are Cloudflare's and change; check the [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) page. The R2 block is optional: delete it from `wrangler.jsonc` on an account without R2 and media is fetched live from WhatsApp instead of stored.

## Build notes

`npm run build` runs `scripts/build-ui.mjs`, which builds the app only when something under `ui/` or the build config is newer than `dist/`. The same command is the `build.command` in `wrangler.jsonc` (the Deploy button needs it), so Workers Builds, `wrangler deploy` and `wrangler dev` do not rebuild an unchanged app. `FORCE_BUILD=1 npm run build` or `npm run build:force` always rebuilds.

## After deploying: two settings the Worker cannot set for you

- Turn on HSTS for the zone your custom domain uses (SSL/TLS, Edge Certificates, HSTS). `workers.dev` hosts cannot use it.
- Keep the R2 bucket private: no `r2.dev` address and no custom domain. Media is served only through `/api/media/:id`, behind sign-in.

See the [security model](SECURITY-MODEL.md) for the rest.
