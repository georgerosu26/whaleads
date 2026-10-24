import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const fixture = (name: string): any => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))

/** Independent re-implementation of WhaBuzz's signPayload (SPEC-v1 §7.3) using node:crypto. */
export function sign(secrets: string[], raw: string, t: number): string {
  return [`t=${t}`, ...secrets.map((s) => `v1=${createHmac('sha256', s).update(`${t}.${raw}`).digest('hex')}`)].join(',')
}

export function metaSig(secret: string, raw: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex')
}

/** WhaBuzz envelope (SPEC-v1 §6.2) around one item of a Meta POST body. */
export function envelope(type: 'message.inbound' | 'message.status', body: any, index = 0, extra: Record<string, unknown> = {}) {
  const v = body.entry[0].changes[0].value
  const { messages, statuses, errors, ...rest } = v
  const item = type === 'message.inbound' ? messages[index] : statuses[index]
  return {
    id: 'evt_01JAB3K9X2S8C4M7Q1V5R6T0YZ', type, api_version: '2026-10-16', created_at: '2026-10-16T05:12:03.481Z',
    tenant_id: 't', waba_id: body.entry[0].id, phone_number_id: v.metadata.phone_number_id, display_phone_number: v.metadata.display_phone_number,
    wamid: item.id, wa_id: item.from ?? item.recipient_id, user_id: null, dedupe_key: `msg:${item.id}`,
    data: { ...rest, [type === 'message.inbound' ? 'message' : 'status']: item },
    raw: body, raw_path: `entry[0].changes[0].value.${type === 'message.inbound' ? 'messages' : 'statuses'}[${index}]`, ...extra,
  }
}

export const ctx = { waitUntil: (_p: Promise<unknown>) => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
