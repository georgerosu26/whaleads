import { describe, expect, it } from 'vitest'
import { MAX_ATTEMPTS, backoff, classifyCode, classifySend, errorCode } from '../src/broadcasts/classify'
import { checkParams } from '../src/broadcasts/params'
import { parseFilter } from '../src/broadcasts/audience'
import { classifyKeyword } from '../src/broadcasts/optout'

describe('error classification (plan D4)', () => {
  it.each([[130429, 'retry'], [131056, 'retry'], [131000, 'retry'], [131016, 'retry'], [4, 'retry'], [80007, 'retry'],
    [131026, 'recipient'], [131049, 'recipient'], [131050, 'recipient'], [131009, 'recipient'], [131008, 'recipient'], [131021, 'recipient'],
    [131048, 'pause'], [132000, 'pause'], [132001, 'pause'], [132005, 'pause'], [132007, 'pause'], [132012, 'pause'], [132015, 'pause'], [132016, 'pause'],
    [131042, 'pause'], [131031, 'pause'], [133010, 'pause'], [368, 'pause'], [190, 'pause']] as const)('code %i is %s', (code, cls) => {
    expect(classifyCode(code, 'm', 400).class).toBe(cls)
  })
  it('throttle codes stop the step; others do not', () => {
    for (const c of [130429, 4, 80007]) expect(classifyCode(c, 'm', 400).stop).toBe(true)
    expect(classifyCode(131056, 'm', 400).stop).toBe(false)
    expect(classifyCode(131026, 'm', 400).stop).toBe(false)
  })
  it('only 131050 flags an opt-out', () => {
    expect(classifyCode(131050, 'm', 400).optOut).toBe(true)
    expect(classifyCode(131026, 'm', 400).optOut).toBe(false)
  })
  it('falls back on the HTTP status when there is no known code', () => {
    expect(classifyCode(null, 'm', 429)).toMatchObject({ class: 'retry', stop: true })
    expect(classifyCode(null, 'm', 503).class).toBe('retry')
    expect(classifyCode(null, 'm', 401).class).toBe('pause')
    expect(classifyCode(999999, 'm', 400).class).toBe('recipient')
  })
  it('a send that never got an answer (status 0, no code) is an unknown outcome', () => {
    expect(classifySend({ ok: false, status: 0, error: { message: 'timeout' } } as any).class).toBe('unknown_outcome')
    expect(classifySend({ ok: false, status: 400, error: { message: 'x', error: { error: { code: 131026, message: 'undeliverable' } } } } as any).class).toBe('recipient')
  })
  it('finds the code in Graph and WhaBuzz envelopes', () => {
    expect(errorCode({ code: 131026 })).toBe(131026)
    expect(errorCode({ error: { code: 131026 } })).toBe(131026)
    expect(errorCode({ errors: [{ code: 131050 }] })).toBe(131050)
    expect(errorCode({})).toBeNull()
    expect(errorCode(null)).toBeNull()
  })
  it('backoff doubles from a minute and is capped at 30 minutes; three attempts is the limit', () => {
    expect([1, 2, 3, 4].map(backoff)).toEqual([60, 120, 240, 480])
    expect(backoff(20)).toBe(1800)
    expect(MAX_ATTEMPTS).toBe(3)
  })
})

describe('params validation', () => {
  it('needs exactly the template placeholder count, a fallback for every field, and a clean fixed value', () => {
    expect(checkParams({ body: [{ kind: 'fixed', value: 'Diwali' }] }, 1, 0)).toMatchObject({ ok: true })
    expect(checkParams({ body: [] }, 1, 0)).toMatchObject({ ok: false })
    expect(checkParams({ body: [{ kind: 'field', field: 'contact.name', fallback: '' }] }, 1, 0)).toMatchObject({ ok: false })
    expect(checkParams({ body: [{ kind: 'field', field: 'lead.name', fallback: 'there' }] }, 1, 0)).toMatchObject({ ok: false, error: expect.stringMatching(/unknown field/) })
    expect(checkParams({ body: [{ kind: 'field', field: 'nope', fallback: 'x' }] }, 1, 0)).toMatchObject({ ok: false })
    expect(checkParams({ body: [{ kind: 'fixed', value: 'a\nb' }] }, 1, 0)).toMatchObject({ ok: false })
    expect(checkParams({ body: [{ kind: 'field', field: 'lead.owner', fallback: 'our team' }] }, 1, 0)).toMatchObject({ ok: true })
    expect(checkParams(undefined, 0, 0)).toMatchObject({ ok: true })
  })
})

describe('filter validation (decision 2)', () => {
  it('no tags and no stage needs the explicit all flag, which cannot be mixed with tags', () => {
    expect(parseFilter({})).toMatchObject({ ok: false })
    expect(parseFilter({ all: true })).toMatchObject({ ok: true })
    expect(parseFilter({ all: true, tags: [1] })).toMatchObject({ ok: false })
    expect(parseFilter({ tags: [1], tag_mode: 'all' })).toMatchObject({ ok: true })
    expect(parseFilter({ tags: [1], tag_mode: 'weird' })).toMatchObject({ ok: false })
    expect(parseFilter({ tags: ['x'] })).toMatchObject({ ok: false })
    expect(parseFilter({ stage: 'new' })).toMatchObject({ ok: true })
  })
})

describe('keywords', () => {
  it('match whole messages only', () => {
    for (const k of ['STOP', ' stop. ', 'Unsubscribe', 'opt out', 'STOP ALL', 'band karo']) expect(classifyKeyword(k), k).toBe('out')
    for (const k of ['start', 'Subscribe!']) expect(classifyKeyword(k), k).toBe('in')
    for (const k of ['please stop', 'stop calling me about this thing today', 'bus stop timings', '', null, 'hello']) expect(classifyKeyword(k as any), String(k)).toBeNull()
  })
})
