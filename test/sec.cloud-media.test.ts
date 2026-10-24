// Cloud API media download pins the media id and the download host; the verify token compare is constant time.
import { describe, expect, it } from 'vitest'
import { CloudApiAdaptor, metaMediaUrl } from '../src/adaptors/cloud-api'

const mk = (url: string, calls: string[], headers: Record<string, string>[] = []) => new CloudApiAdaptor(
  { system_token: 'SYSTOKEN', app_secret: 's', phone_number_id: '1', waba_id: '2', verify_token: 'vt-123' } as any,
  (async (u: any, init: RequestInit = {}) => {
    calls.push(String(u)); headers.push((init.headers ?? {}) as Record<string, string>)
    return String(u).startsWith('https://graph.facebook.com/') ? new Response(JSON.stringify({ url, mime_type: 'image/jpeg' })) : new Response('JPEGBYTES', { headers: { 'content-type': 'image/jpeg' } })
  }) as typeof fetch,
)

describe('Cloud API fetchMedia', () => {
  it('downloads from a Meta media host with the token', async () => {
    const calls: string[] = []
    const out = await mk('https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1', calls).fetchMedia('1234567890')
    expect(out.ok).toBe(true)
    expect(calls).toEqual(['https://graph.facebook.com/v22.0/1234567890', 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1'])
  })
  it('never sends the system token to a non-Meta download URL', async () => {
    const calls: string[] = []
    for (const bad of ['https://attacker.example.net/x', 'http://lookaside.fbsbx.com/x', 'https://fbsbx.com.attacker.example/x', 'https://lookaside.fbsbx.com' + String.fromCharCode(64) + 'attacker.example/x']) {
      const out = await mk(bad, calls).fetchMedia('1234567890')
      expect(out.ok, bad).toBe(false)
    }
    expect(calls.every((c) => c.startsWith('https://graph.facebook.com/'))).toBe(true)
  })
  it('refuses a media id that is not a plain id (no Graph path traversal)', async () => {
    const calls: string[] = []
    for (const id of ['../2/message_templates', '1?fields=x', '1/2', '']) expect((await mk('https://lookaside.fbsbx.com/x', calls).fetchMedia(id)).ok).toBe(false)
    expect(calls).toEqual([])
  })
  it('metaMediaUrl', () => {
    expect(metaMediaUrl('https://mmg.whatsapp.net/v/t62/x')).toBe(true)
    expect(metaMediaUrl('https://scontent.fbcdn.net/x')).toBe(true)
    expect(metaMediaUrl('https://lookaside.fbsbx.com:8443/x')).toBe(false)
  })
})

describe('Cloud API verifyChallenge', () => {
  const a = mk('https://lookaside.fbsbx.com/x', [])
  const q = (t: string | null) => new URL(`https://x/webhooks/meta?hub.mode=subscribe&hub.challenge=CH${t === null ? '' : `&hub.verify_token=${t}`}`)
  it('echoes the challenge only for the right token', async () => {
    expect(await a.verifyChallenge(q('vt-123')).text()).toBe('CH')
    expect(a.verifyChallenge(q('vt-124')).status).toBe(403)
    expect(a.verifyChallenge(q(null)).status).toBe(403)
    expect(a.verifyChallenge(q('')).status).toBe(403)
  })
})
