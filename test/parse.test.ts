import { describe, expect, it } from 'vitest'
import { CloudApiAdaptor } from '../src/adaptors/cloud-api'
import { WhaBuzzAdaptor } from '../src/adaptors/whabuzz'
import { envelope, fixture } from './helpers'

const cloud = new CloudApiAdaptor({ system_token: 't', app_secret: 's', phone_number_id: '1', waba_id: '2' })
const wb = new WhaBuzzAdaptor({ api_key: 'k', phone_number_id: '1000000000000001', waba_id: '2', webhook_secret: 's' })

describe('Meta payload parsing (Cloud API adaptor)', () => {
  it('text message', () => {
    const body = fixture('text')
    const [e] = cloud.parseWebhook(JSON.stringify(body))
    expect(e).toMatchObject({ kind: 'message', from: '16505550123', name: 'Kerry Fisher', type: 'text', body: 'Hi, is the 7am batch open tomorrow?', media_id: null, timestamp: 1760591523 })
    expect(e.raw).toEqual(body.entry[0].changes[0].value.messages[0])
  })
  it('image keeps media id and caption form', () => {
    const [e] = cloud.parseWebhook(JSON.stringify(fixture('image')))
    expect(e.kind).toBe('message')
    if (e.kind === 'message') { expect(e.type).toBe('image'); expect(e.media_id).toBeTruthy(); expect(e.body).toMatch(/^\[image\]/) }
  })
  it('interactive reply uses the button title', () => {
    const [e] = cloud.parseWebhook(JSON.stringify(fixture('interactive_button_reply')))
    expect(e.kind === 'message' && e.type).toBe('interactive')
    expect(e.kind === 'message' && e.body).not.toBe('[interactive]')
  })
  it('statuses (3 in one POST -> 3 events) and failed status errors', () => {
    expect(cloud.parseWebhook(JSON.stringify(fixture('statuses_multi'))).map((e) => e.kind)).toEqual(['status', 'status', 'status'])
    const [f] = cloud.parseWebhook(JSON.stringify(fixture('status_failed_not_allowed')))
    expect(f).toMatchObject({ kind: 'status', status: 'failed' })
    expect(f.kind === 'status' && f.errors?.length).toBeGreaterThan(0)
  })
  it('ignores non-message fields and bad json throws', () => {
    expect(cloud.parseWebhook(JSON.stringify(fixture('template_status_approved')))).toEqual([])
    expect(() => cloud.parseWebhook('{nope')).toThrow(SyntaxError)
  })
})

describe('WhaBuzz envelope parsing', () => {
  it('message.inbound -> same event as the Meta path', () => {
    const body = fixture('text')
    const viaMeta = cloud.parseWebhook(JSON.stringify(body))
    const viaWb = wb.parseWebhook(JSON.stringify(envelope('message.inbound', body)))
    expect(viaWb).toEqual(viaMeta)
  })
  it('message.status -> same event as the Meta path', () => {
    const body = fixture('status_delivered')
    expect(wb.parseWebhook(JSON.stringify(envelope('message.status', body)))).toEqual(cloud.parseWebhook(JSON.stringify(body)))
  })
  it('keeps the original Meta object as raw', () => {
    const body = fixture('statuses_multi')
    const [e] = wb.parseWebhook(JSON.stringify(envelope('message.status', body, 1)))
    expect(e.raw).toEqual(body.entry[0].changes[0].value.statuses[1])
  })
  it('lead.* becomes a lead event; unrelated types are dropped', () => {
    const lead = { id: 'evt_1', type: 'lead.created', data: { form_id: 'f', fields: [] }, raw: { x: 1 } }
    expect(wb.parseWebhook(JSON.stringify(lead))).toEqual([{ kind: 'lead', id: 'evt_1', data: lead.data, raw: lead.raw }])
    for (const type of ['message.outbound', 'template.status', 'number.quality', 'message.echo', 'meta.other']) {
      expect(wb.parseWebhook(JSON.stringify({ id: 'e', type, data: {}, raw: null }))).toEqual([])
    }
  })
  it('bad json throws', () => { expect(() => wb.parseWebhook('nope')).toThrow(SyntaxError) })
})
