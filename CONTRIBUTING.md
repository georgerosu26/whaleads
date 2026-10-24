# Contributing

Thanks for looking. WhaLeads is a small, deliberately narrow tool: one WhatsApp number, one team, one Cloudflare Worker. Changes that keep it that way are the easiest to merge.

## Dev setup

You need Node 22 or newer (the unit tests use the built-in `node:sqlite`) and npm.

```bash
npm ci
printf 'SESSION_SECRET=%s\nADMIN_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 24)" > .dev.vars   # git-ignored
npm run dev        # the Worker on :8787 (builds the app first)
npm run dev:ui     # optional: Vite with hot reload, proxies /api and /webhooks to :8787
```

Open `http://localhost:8787/setup`; the setup key is the `SESSION_SECRET` from `.dev.vars`. `ADMIN_KEY` is optional and only enables bearer access for scripts.

## Checks to run before a PR

```bash
npm run typecheck      # the Worker and ui/
npm test               # vitest; no Cloudflare runtime needed, D1 is shimmed over node:sqlite
npm run lint:template  # the generic wrangler.jsonc must stay deployable by the button
```

End-to-end (Playwright against `wrangler dev` with a throwaway local D1):

```bash
npx playwright install chromium           # once, or point PW_CHROMIUM at a Chromium binary
PW_CHROMIUM=/path/to/chromium PW_PORT=8799 npm run test:e2e
```

`PW_PORT` defaults to 8799. Run the e2e specs that cover what you changed; the full suite is slow. Run `npm run build` if you touched `ui/`.

## The D18 rule: no client data, ever

Nothing in this repository may identify a real business or person: no real phone numbers, names, emails, hostnames, Cloudflare account or database ids, WhatsApp business or phone-number ids, API keys, or screenshots with real chats. This applies to code, tests, fixtures, docs, issues and pull requests. Use `example.com`, `+1 555 000 xxxx` and obviously fake ids. `npm run lint:template` checks the deploy template; the same care applies everywhere else.

Your own instance's `wrangler.jsonc` (account id, routes, database id) belongs in your own private repo, not in a pull request.

## Pull requests

- One change per pull request, with a short description of what and why. Open an issue first for anything large or anything that adds scope.
- Tests for new behaviour, in `test/` (unit, `*.test.ts`) or `test/e2e/` when the change is visible in the browser.
- New UI needs loading, empty and error states, and has to work at phone width (360 px) and desktop.
- No new runtime dependencies without a reason in the description. No analytics, telemetry or calls to third parties other than the WhatsApp adaptors and the optional AI key the owner enters.
- Out of scope for now (see the README): scheduled or recurring broadcasts, segments beyond tags and stage, several numbers per deployment, email, voice. Basic broadcasts (one approved template to tag-picked leads, paced, opt-outs honoured) are in.
- Security problems: do not open an issue. See [SECURITY.md](SECURITY.md).

By contributing you agree your work is licensed under Apache-2.0.
