# Adaptors

WhaLeads reaches WhatsApp through one adaptor per deployment: **WhaBuzz** (connect a number from Settings, no Meta app of your own) or **Cloud API** (your own Meta app, entered by hand).

## Adaptors
One adaptor is active per deployment (`src/adaptors/types.ts` is the contract). Resolution: the `adaptor_config` row in D1 first, then the legacy env vars below (so older instances keep working with no change).

`PUT /api/admin/adaptor` bodies:
```
{"kind":"whabuzz","config":{"api_key":"…","phone_number_id":"…","waba_id":"…","webhook_secret":"whsec_TEST_…"}}
{"kind":"cloud_api","config":{"system_token":"…","app_secret":"…","phone_number_id":"…","waba_id":"…","app_id":"…","verify_token":"…","graph_version":"v22.0"}}
```
`webhook_secret` may hold two secrets comma-separated during a rotation. The WhaBuzz webhook endpoint to register is `https://<host>/webhooks/whabuzz`. `/webhooks/meta` keeps verifying with the legacy env credentials even while WhaBuzz is the active sender.

## Connect through WhaBuzz

Settings, WhatsApp, "Connect with WhaBuzz" sends an admin to a WhaBuzz page and back, so no keys are pasted. "Enter keys manually" stays as the fallback and always works.

Connect is on by default: the template sets `WHABUZZ_CONNECT_BASE` to `https://app.whabuzz.com`. Set it to an empty string to hide the button; then `GET /api/admin/adaptor` returns `connect_available: false`, the page shows only "Enter keys manually", and `start` answers 409 `connect_unavailable`.

This follows the WhaBuzz connect contract ([Connect apps](https://docs.whabuzz.com/guides/connect-apps) in the WhaBuzz docs). Flow and routes:
1. `POST /api/connect/whabuzz/start` (admin, CSRF, 5 per 10 min per person) makes a random `state` (43 printable ASCII chars; WhaBuzz allows 200) and a PKCE `code_verifier` (43 chars), stores them encrypted as one pending connect (10 minutes), and returns `{url}`: `<WHABUZZ_CONNECT_BASE>/connect?app=whaleads&callback=https://<host>/api/whabuzz/callback&state=…&code_challenge=<base64url S256>`. No other parameters.
2. WhaBuzz POSTs a signed `webhook.verify` ping to `https://<host>/api/whabuzz/webhook` and waits for the challenge to be echoed (2xx within 5 s). We do not hold the secret yet, so this one event type is accepted unsigned, only while no WhaBuzz webhook secret is saved or a connect is pending. Every other event needs a valid `X-WhaBuzz-Signature`, in every state.
3. WhaBuzz redirects to `GET /api/whabuzz/callback?code&state` (or `?error=access_denied&state`). The callback needs the same signed-in session, compares the state first, spends the pending connect (single use), and exchanges the code with `POST <API root>/connect/token` (the API root is `WHABUZZ_BASE_URL` without `/v1`) using `{app, code, state, code_verifier}`. The 200 carries `api_key`, `webhook_secret`, `phone_number_id`, `waba_id`, `tenant_id`, `display_phone_number`, once. The adaptor is saved through the same path as the manual form (after a `status()` check), and `display_phone_number` and `tenant_id` are kept as a non-secret setting for the page. There is no second verify call: WhaBuzz verified the endpoint at approve time. WhaBuzz has already activated the new connection and revoked earlier ones by then, so the grant is saved even if the `status()` check fails; the redirect then carries `?connected=1&warn=status_failed` and the page says the status check failed and to retry from the Status panel.
4. The browser lands on `/settings/whatsapp?connected=1` or `?connect_error=<code>`: `access_denied`, `state_mismatch`, `invalid_code`, `code_used`, `code_expired`, `connection_gone`, `connection_unavailable`, `rate_limited`, `unknown_app`, plus local `too_many_attempts`, `forbidden`, `exchange_failed`, `connect_failed`. A `code_used` answer means WhaBuzz revoked the connection it created; it is logged as `connect_revoked`.

The key from Connect is scoped (messages, templates, media, numbers:read, events:read) and bound to one number. It cannot manage API keys or webhooks (those answer 403/409), and WhaLeads never calls them; the adaptor only uses `/v1/messages`, `/v1/templates`, `/v1/media` and `GET /v1/numbers/{id}`. A `wb_test_` key prefix would still show a "Sandbox" badge; Connect issues `wb_live_` keys. Replacing an active Cloud API number asks to confirm. If the API later answers 401 the user revoked access in WhaBuzz; connect again.

The webhook endpoint WhaBuzz registers receives all events for the workspace; the adaptor's `phone_number_id` filter drops the other numbers. `POST /webhooks/whabuzz` is the same pipeline and keeps working for instances registered by hand.

Signed out mid-flow: if the callback arrives without a session, the browser goes to `/login?next=<callback>` and back, and that always ends in `connect_error=state_mismatch`, because the pending connect is bound to the session that started it. Press Connect again.

Environment variables (both optional, each https on `whabuzz.com` or `*.whabuzz.com`; loopback http is allowed only for local mocks):

| Variable | Purpose |
|---|---|
| `WHABUZZ_BASE_URL` | WhaBuzz API base, default `https://api.whabuzz.com/v1` (the connect token exchange uses the same host without `/v1`). The API key is sent here, so it is an allow-listed env var and not a setting; a `base_url` in an adaptor PUT is ignored. |
| `WHABUZZ_CONNECT_BASE` | WhaBuzz connect page. Default `https://app.whabuzz.com` in the template; an empty value hides the button. |

See [ROUTES](ROUTES.md) for auth and rate limits of each route.

## Meta onboarding (once per client)
- Meta app with the WhatsApp product; WABA + phone number registered (Cloud API, not coexisting on a BSP).
- A permanent System User token with `whatsapp_business_messaging` and `whatsapp_business_management` on the WABA.
- App secret from App settings > Basic (used for signature check and the app token for webhook registration).
- Replies are free text only inside the 24h customer window; outside it Graph returns error 131047, surfaced as JSON by `/api/send`.




## Webhook behaviour notes

- The WhaBuzz verify ping (`webhook.verify`, signed) is answered with the challenge as `text/plain`.
- WhaBuzz envelopes whose `phone_number_id` differs from the configured number are dropped and counted in `events` as `ignored_other_number`.
- A message and its lead (and a status dedupe row and its status update) commit in one `db.batch`, so a failed retry is reprocessed rather than skipped.
- `failed` is a terminal message status.
