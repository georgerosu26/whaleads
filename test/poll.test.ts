import { describe, expect, it } from 'vitest'
import { MAX_BACKOFF_MS, nextDelay } from '../ui/src/lib/poll'

describe('poll backoff', () => {
  it('keeps the base cadence while healthy, doubles per failure, caps at 30 s', () => {
    expect(nextDelay(4000, 0)).toBe(4000)
    expect([1, 2, 3].map((n) => nextDelay(4000, n))).toEqual([8000, 16000, 30000])
    expect(nextDelay(15000, 1)).toBe(MAX_BACKOFF_MS)
    expect(nextDelay(4000, 50)).toBe(30000)
  })
})
