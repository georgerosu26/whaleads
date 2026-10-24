import { describe, expect, it } from 'vitest'
import { decryptJson, encryptJson } from '../src/crypto'

describe('adaptor config encryption', () => {
  const cfg = { api_key: 'wb_TEST_abc123', phone_number_id: '100000000000001' }
  it('round-trips', async () => {
    const blob = await encryptJson('s3cret-session-key', cfg)
    expect(blob.startsWith('v1.')).toBe(true)
    expect(blob).not.toContain('wb_TEST_abc123')
    expect(await decryptJson('s3cret-session-key', blob)).toEqual(cfg)
  })
  it('uses a fresh IV each time', async () => {
    expect(await encryptJson('k', cfg)).not.toBe(await encryptJson('k', cfg))
  })
  it('fails with the wrong key or a tampered blob', async () => {
    const blob = await encryptJson('right', cfg)
    await expect(decryptJson('wrong', blob)).rejects.toThrow()
    const parts = blob.split('.'); parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1)
    await expect(decryptJson('right', parts.join('.'))).rejects.toThrow()
  })
  it('refuses an empty secret', async () => {
    await expect(encryptJson('', cfg)).rejects.toThrow()
  })
})
