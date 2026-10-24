# Automations

Flows run on the Worker and D1, resumed by the every-minute cron. Every flow can run in shadow mode (it executes, nothing is sent) and be dry-run before it goes live.

## Flows engine (internal)

The automation engine lives in `src/flows/`. The API, the triggers, the send nodes and the editor UI are described below. What exists:

- **Schema (step 7).** `flows` (draft `graph`, `published_graph`, `shadow`, `reentry`), `flow_runs` (own `snapshot`, `context`, `trace`) and `messages.origin`. Additive, under the `applied_<n>` lock. A run keeps its snapshot, so editing a flow never changes a run in flight.
- **Nodes.** `trigger`, `condition` (ports `yes`/`no`), `variable`, `delay`, `wait_event` (ports `completed`/`timeout`), `action` (`set_stage`, `add_tag`, `remove_tag`, `assign`, `note`, `set_next_action`) and `lead_writeback` (rating + `qualified` activity). Lead writes go through `crm.ts` with actor `flow:<id>`. Other node types fail the run cleanly until they ship.
- **Engine.** One step runs until the flow waits, ends, hits the 50-node cap or the 20 s budget, then persists once: the planned lead writes and the run row in a single `DB.batch`, so a failed step applies none of its writes. A budget-parked run continues on the next tick. Context is capped at 32 KB; trace at 100 entries.
- **Idempotency.** `flow:lead:kind:key` starts at most one run (UNIQUE `idem_key`); an event with no key is refused (`missing_key`) rather than started without idempotency. One live run per (flow, lead, shadow); `once` flows never re-enter a lead. A resume is a compare-and-swap on `(status, await_kind, step)`: `step` is bumped by every state write, so a resume that read the run at one wait loses if another resume has since moved it to the next wait. Reply keys (wamid) are remembered so redeliveries are no-ops.
- **Fresh data on resume.** A resumed run reloads the lead (stage, tags, owner), contact and opening hours before it continues, so conditions after a wait see the present, not the start.
- **Shadow vs dry-run.** A shadow flow runs for real with real waits, but `action` and `lead_writeback` only record `{would: ...}`: no writes, no messages. Shadow runs never take the "once" slot of a live run (and vice versa), and never receive a contact's real reply. A dry-run persists nothing and fast-forwards delays.
- **Limits (Workers Free, checked 2026-10-19).** 50 subrequests per request, 10 ms CPU per request or cron, D1 50 queries per invocation (a batch counts as one), cron wall clock up to 15 min. The tick therefore meters its own D1 calls: budget 40 on ordinary minutes, 20 on quarter-hour minutes (shared with the media jobs), and stops resuming runs when one more would overspend. Each step also has its own cap of 30 D1 calls (smaller when the tick has less left): past it the run parks as a due timer and continues next tick, so a long chain of tag or stage nodes spreads over ticks instead of tripping the 50-call wall. Tag state is read once per step. Leftover due runs wait for the next minute.
- **Known edges.** A cancel racing a step still lets that step's lead writes apply; only the oldest reply-awaiting run per contact receives a reply; durations are validated (unknown units are rejected) with per-node default units: delay=minutes, wait timeout=hours, set next action=hours (table in `src/flows/nodes/time.ts`). Numeric condition operators (`gt`/`gte`/`lt`/`lte`) are false for missing, empty or non-decimal values.

**Cron.** `wrangler.jsonc` now fires `* * * * *` (was every 15 minutes). `src/cron.ts` runs the flow tick every minute and the 15-minute jobs (media retries and purge, template sync, dead push subscriptions) only when the scheduled minute is divisible by 15. Finished runs are purged at 03:00 UTC (setting `flow_run_retention_days`, default 90). Try it locally: `wrangler dev --test-scheduled`, then `curl 'http://localhost:8787/cdn-cgi/handler/scheduled?cron=*+*+*+*+*'`.

**HTTP guard (`src/flows/http-guard.ts`).** For the coming `http_request` node. http(s) only; no userinfo in the URL; every IP literal is parsed in any textual form and refused when loopback, private, link-local, metadata, unspecified, multicast or reserved, including all of `::ffff:0:0/96`, NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`), Teredo (`2001::/32`), site-local (`fec0::/10`) and 6to4 forms; `localhost`, `.local`, `.internal` and metadata hostnames are refused, as is this instance itself and its `workers.dev` name. Each redirect hop (max 3) is re-validated; a cross-origin 307/308 (which would re-send the body) and an https-to-http redirect are refused; credential headers are dropped when a hop crosses origin; 303 and POST-on-301/302 become a bodyless GET. Only `Content-Type`, `Accept`, `User-Agent` and custom `X-*` request headers are sent (not `X-Forwarded-*`); `Authorization` goes out only when the node sets it (`allowAuth`); `Host` and `Cookie` never do. 8 s timeout, 256 KB response cap.

## Flow nodes, triggers and live runs

**One send path.** `src/send.ts` holds the only code that sends: text, media and template. It enforces the 24 h window (text and media only inside it, templates any time), writes the deferred record, publishes the live frame and returns the timing. The inbox, media and template routes and the flow nodes are thin callers. Automation sends carry `messages.origin = flow:<id>`.

**Nodes** (all in `src/flows/nodes/`):
- `message`: text to the lead's contact, values filled from variables and lead fields. Outside the window it leaves by the optional `window_closed` port, else the run fails with a readable error.
- `template`: approved and sendable templates only (`templateId` or `templateName`). `bodyParams` / `headerParams` are lists of templated strings (`{{lead.name}}`, `{{var}}`, `{{node.field}}`); the count must match the template. A media header uses the template's stored sample.
- `ai`: one Anthropic Messages call. `systemPrompt` and `prompt` are templated, the answer goes to `outputVariable` and `output.answer`. Request: `POST https://api.anthropic.com/v1/messages` with `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json`; body `{model, max_tokens (default 300, ceiling 1024), system, messages:[{role:'user', content}]}`. Haiku 5 models also get `thinking:{type:'disabled'}` and `output_config:{effort:'low'}`. 8 s timeout, counts as 1 subrequest, input capped at 8000 characters. **Configuration:** save the key under Settings (stored encrypted as `anthropic_key_enc`, never logged or put in a trace) and optionally set the `ai_model` setting (default `claude-haiku-5-5`). No key fails the node with `ai_not_configured`.
- `http_request`: through the SSRF guard (`safeFetch`). URL, headers and body are templated; the JSON response (text if not JSON) goes to `outputVariable`. `Authorization` is sent only when the node sets it explicitly. Every failure, including non-2xx, follows the error-port rule.
- Failures on `message`, `template`, `ai` and `http_request` go to a connected `error` port, else fail the run.

**Shadow mode.** A shadow flow runs with real waits, but `message`, `template`, `ai` and `http_request` are SKIPPED with a trace entry (`{would: ...}`), and `action` / `lead_writeback` only record what they would do. Nothing is sent or written.

**Triggers** (`src/flows/triggers.ts`; only published, active flows run, at most 5 per event, in priority order):
- `lead.created`: filters `sources[]`, `stages[]`. Key: lead id. Fired by WhatsApp intake, the form endpoint and manual create.
- `message.received`: `match` is `any`, `keyword` (case-insensitive, any entry) or `regex`. Key: wamid. Text is clipped to 1000 characters. Patterns over the length cap, with back-references, nested repeats, two overlapping open-ended repeats in a row (`\w*\w*`), more than 2 open-ended repeats of a wide match, or a worst-case score over 8 never match and are refused when the graph is validated. The hook picks the contact's newest OPEN lead only (a contact with only won/lost leads starts nothing). Reply-loop cap: one flow starts at most 10 `message.received` runs per contact per rolling hour; the excess is refused (`rate_capped`) with one `flow_run` activity row.
- `stage.changed`: filters `from[]`, `to[]`. Key: activity id. Fired by staff edits and by flow `set_stage`.

Hooks run in `ctx.waitUntil` after the batches commit (inline from cron, which has no context) and never throw into the webhook. On an inbound message a waiting `wait_event` run is resumed first; if one resumed, the message is consumed and no `message.received` flow starts for it. Otherwise `message.received` is matched, then `lead.created` for a brand-new lead.

**Loop guard.** A stage change made by `flow:<id>` never re-triggers that same flow, and chained triggers stop at depth 3 (A moves the stage, B reacts, A reacts, then the next start is refused).

**Live and timeline.** Publish, pause and archive publish `flow.updated {flow_id,status,version}`. Each run publishes `flow.run` (`started`, `awaiting`, `completed`, `failed`) and writes `flow_run` activity rows (actor `flow:<id>`, data `{run_id, flow, status, shadow}`) at start and at finish.

**Cron observability.** Each cron run logs one JSON line `{cron, ran, ms}` and overwrites the `meta` key `cron_last_at`; `/api/health` returns it as `cron_last_at` (unix seconds, `null` before the first run). No per-tick rows are written.


## The editor

Admins build flows at **Automations** (staff can read them). The list shows status and the last run; a new flow starts as a draft with one empty trigger and shadow mode on.

- **Canvas**: hand-rolled pan/zoom (drag the background, ctrl/cmd + wheel to zoom, fit button), 10 px snap, steps added from the palette, ports dragged to connect, Delete removes the selected step or connection, undo/redo. The inspector edits the selected step; the graph is validated locally with the server's own validators, so the errors you see are the ones publish enforces.
- **Autosave**: edits save after a short pause (one save in flight at a time). Publish saves first, locks the canvas, and publishes the exact graph saved; if the draft moved underneath, the editor says so and reloads it.
- **Shadow**: while on, a published flow runs but sends and changes nothing; the run trace shows what it would have done. Uncheck it to go live.
- **Test panel**: a dry run against a chosen lead (and optional incoming text) with a per-step trace and the payloads that would be sent. Nothing is sent or written.
- **Runs tab**: runs for the flow, live (a new run or status change appears without reload), with a trace and Cancel for parked runs. Lead timelines show "Automation: <flow>" rows and refresh live.
- **Narrow screens (under 768 px)**: structure editing needs width. The canvas is a read-only preview with a list of steps; tapping a step opens its settings (data is editable, connections and positions are locked), with a note that editing the layout needs a wider screen. Automations is hidden from the bottom bar and reached from Settings.

