# Decisions

The product decisions behind WhaLeads and what is in and out of scope. A change here is a decision, not drift.

## What it is
An open-source, self-hosted lead CRM for one WhatsApp number. Three features: **CRM** (leads pipeline, contacts), **Inbox** (WhatsApp conversations), **Automation Builder** (graph flows). Runs as one Cloudflare Worker + D1 (+ R2 for media, one Durable Object for the live channel) on the Workers Free plan. One deployment = one business = one number.

Positioning: one number, one team, self-hosted → WhaLeads. Many numbers or many clients → [WhaBuzz](https://whabuzz.com) directly.

## Decisions

Numbers are stable identifiers; code comments refer to them (`// D20: …`). Retired numbers are not reused.

| # | Decision |
|---|---|
| D2 | **One WhatsApp number per deployment.** Number identity is config, never a table or a routing key |
| D4 | Meta sits behind an **adaptor interface** (`src/adaptors/types.ts`); prebuilt **WhaBuzz** and **Cloud API** adaptors ship in-repo; one adaptor active per deployment |
| D5 | **Connecting to WhaBuzz is guided** (sign in on WhaBuzz, pick the number, the instance receives its keys and webhook; see [ADAPTORS](ADAPTORS.md)). The Cloud API adaptor uses a manual form instead |
| D6 | **Lead Ads via the WhaBuzz adaptor only.** The Cloud API adaptor is WhatsApp only |
| D7 | **Broadcasts out.** No bulk template sends, no segments. One-to-one tool (Superseded by D27.) |
| D8 | **R2 bucket** provisioned on deploy; inbound media copied durably and served through the Worker behind auth |
| D10 | Auth: password login; Worker-signed HttpOnly session; never a third-party identity provider. `/setup` creates the first admin, then locks itself; no secrets-seeded admin |
| D11 | **Workers Free plan is the target.** No Queues; one SQLite-backed Durable Object per instance (D20) with WebSocket Hibernation so idle cost stays ~0; cron for delays and resumes; every step stays inside the plan's per-invocation D1 call budget |
| D13 | AI node only behind an optional bring-your-own Anthropic key; no voice node |
| D14 | No email anywhere. No telemetry, no phone-home |
| D16 | **Media templates are first-class**: image / video / document header templates, create + send; free-form media send inside the 24h window uses the same upload path |
| D17 | **No WhatsApp alerts to staff.** Web push through the installed web app is the only notification channel |
| D18 | **This repository contains nothing of any particular business**: no instance configs, ids, hosts, account ids or names. Your instance configuration belongs in your own repository |
| D19 | **Send latency is visible.** The Worker returns `Server-Timing` (`worker`, `upstream`) on send and webhook responses so time in the Worker, the adaptor and Meta can be told apart; the UI sends optimistically |
| D20 | **Live channel = one WebSocket per tab from the Worker to the browser, via one Durable Object per instance.** Webhook and send handlers post each event to the DO; it broadcasts to connected staff browsers (inbound, outbound, status ticks, assignment and read changes). The browser falls back to 4 s polling when the socket is unavailable. Meta→WhaBuzz and WhaBuzz→Worker stay HTTP |
| D23 | **Meta errors pass through verbatim** (`source: 'meta'`, rejection reasons shown as-is). No business logic in an adaptor |
| D24 | **Everyone sees everything.** Two roles (admin, staff); assignment drives ownership, not visibility |
| D25 | **One contact per phone number** (E.164), merged across form intake and WhatsApp |
| D26 | **Password recovery uses the setup key, not email.** `/recover` takes `SESSION_SECRET`, which every deployer holds and which already forges sessions, so it adds no privilege and needs no mail (D14) |
| D27 | **Basic broadcasts in.** (Supersedes D7.) Send one approved template to the leads carrying chosen tags, optionally narrowed to one stage, with fixed or per-lead params. The Worker paces sends on the existing cron, honours opt-outs (keywords, Meta 131050, manual) and pauses itself on account-level errors. Admins start, pause and cancel; all staff see progress. Out: scheduling, recurring sends, richer segments, A/B tests, analytics. Need those, many numbers or many clients: use WhaBuzz directly. |

## In scope (v1)
- **CRM**: configurable stages, sources, tags, owner, notes, activity timeline, won/lost with reason. Intake from website forms (`POST /api/leads`, origin allow-list, honeypot, rate limit, utm/gclid), Meta Lead Ads via WhaBuzz, and manual add. Click-to-WhatsApp attribution from the Meta `referral` object and prefilled reference codes. Reports: leads by source / stage / week; first-response time.
- **Inbox**: text, image, document and audio inbound; text, image, document and approved templates outbound. 24h window surfaced. Quick replies, assignment, read state, search, delivery ticks.
- **Automations**: triggers (lead created, message received, stage changed); nodes for condition, action, message, template, delay, wait-for-reply, HTTP request, variable, lead write-back, AI. Shadow mode, runs log, flow snapshot per run.
- **Templates**: list, create (text, media-header and authentication copy-code), variables with samples, approval sync, quality rating, fix-and-resubmit, duplicate. Authentication templates are sent by API only (`POST /api/send-otp`), never from the inbox, flows or broadcasts.
- **Settings** (all in D1, editable in the UI): business name, country code, timezone, working hours, stages, sources, tags, allowed form origins, active adaptor and its encrypted credentials, optional Anthropic key.

Details live in [API](API.md), [ROUTES](ROUTES.md), [AUTOMATIONS](AUTOMATIONS.md), [ADAPTORS](ADAPTORS.md) and [RUNBOOK](RUNBOOK.md).

## Non-goals
Scheduled or recurring broadcasts and segments beyond tags, multi-number, multi-tenant, telephony, email, calendar and booking, payments, invoices, Messenger and Instagram DMs, voice, org-level anything, and any industry-specific flow.
