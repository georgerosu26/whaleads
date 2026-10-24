import { describe, expect, it } from 'vitest'
import { MAX_AUDIENCE as SERVER_MAX } from '../src/broadcasts/audience'
import { checkParams } from '../src/broadcasts/params'
import {
  MAX_AUDIENCE, applyProgress, audienceTooLarge, blankParams, broadcastErrorText, broadcastable, canCancel, canDelete, canPause, confirmMatches, emptyFilter, estimateMinutes,
  excludedLine, filterIssue, fitParams, hasOptOutHint, paceLabel, paramError, paramProblems, paramsPayload, paramsValid, placeholderParams, progressPct, renderBody, sampleValues,
  setKind, specSample, tierCap, tierWarning, waiting, type ParamsSpec,
} from '../ui/src/lib/broadcasts'
import { ApiError } from '../ui/src/lib/api'
import type { Tpl } from '../ui/src/lib/templates'

const tpl = (o: Partial<Tpl> = {}): Tpl => ({
  id: 't1', name: 'offer', language: 'en', category: 'MARKETING', status: 'APPROVED', rejected_reason: null, header_format: 'NONE', header_text: null,
  body: 'Hi {{1}}, offer ends soon.', footer: null, body_params_count: 1, header_params_count: 0, sendable: true, unsendable_reason: null,
  has_header_sample: false, header_media_mime: null, synced_at: null, created_at: 0, ...o,
})

describe('audience step', () => {
  it('needs a tag, a stage or everyone', () => {
    expect(filterIssue(emptyFilter())).toMatch(/at least one tag/)
    expect(filterIssue({ ...emptyFilter(), tags: [1] })).toBeNull()
    expect(filterIssue({ ...emptyFilter(), stage: 'new' })).toBeNull()
    expect(filterIssue({ ...emptyFilter(), all: true })).toBeNull()
  })
  it('keeps the size cap in step with the server', () => {
    expect(MAX_AUDIENCE).toBe(SERVER_MAX)
    expect(audienceTooLarge(MAX_AUDIENCE)).toBe(false)
    expect(audienceTooLarge(MAX_AUDIENCE + 1)).toBe(true)
  })
  it('words the exclusions', () => {
    expect(excludedLine({ opted_out: 3, no_phone: 0, duplicate: 1 })).toBe('3 opted out · 1 duplicate (one message per person)')
    expect(excludedLine({ opted_out: 0, no_phone: 2, duplicate: 0 })).toBe('2 with no phone number')
  })
})

describe('template choice', () => {
  it('lists approved sendable marketing and utility only', () => {
    expect(broadcastable(tpl())).toBe(true)
    expect(broadcastable(tpl({ category: 'UTILITY' }))).toBe(true)
    expect(broadcastable(tpl({ category: 'AUTHENTICATION' }))).toBe(false)
    expect(broadcastable(tpl({ status: 'PENDING' }))).toBe(false)
    expect(broadcastable(tpl({ sendable: false }))).toBe(false)
  })
  it('spots an opt-out line in footer or body', () => {
    expect(hasOptOutHint(tpl())).toBe(false)
    expect(hasOptOutHint(tpl({ footer: 'Reply STOP to opt out' }))).toBe(true)
    expect(hasOptOutHint(tpl({ body: 'Unsubscribe any time {{1}}' }))).toBe(true)
  })
})

describe('values step', () => {
  it('rejects empty fixed text and empty fallbacks', () => {
    expect(paramError({ kind: 'fixed', value: '  ' })).toBeTruthy()
    expect(paramError({ kind: 'fixed', value: 'Diwali' })).toBeNull()
    expect(paramError({ kind: 'field', field: 'contact.name', fallback: '' })).toMatch(/fallback is required/)
    expect(paramError({ kind: 'field', field: 'contact.name', fallback: 'there' })).toBeNull()
    expect(paramError({ kind: 'fixed', value: 'a\nb' })).toBeTruthy()
  })
  it('validates a whole set and reports per slot', () => {
    const p: ParamsSpec = { body: [{ kind: 'fixed', value: 'x' }, { kind: 'field', field: 'lead.stage', fallback: '' }], header: [] }
    expect(paramsValid(p)).toBe(false)
    expect(paramProblems(p).body.map(Boolean)).toEqual([false, true])
    expect(paramsValid(blankParams(1, 0))).toBe(false)
    expect(paramsValid(blankParams(0, 0))).toBe(true)
  })
  it('sends exactly what the server accepts', () => {
    const p: ParamsSpec = { body: [{ kind: 'fixed', value: ' Diwali ' }, { kind: 'field', field: 'contact.name', fallback: ' there ' }], header: [] }
    const r = checkParams(paramsPayload(p), 2, 0)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.spec.body).toEqual([{ kind: 'fixed', value: 'Diwali' }, { kind: 'field', field: 'contact.name', fallback: 'there' }])
    const ph = placeholderParams(2, 1)
    expect(checkParams(ph, 2, 1).ok).toBe(true)
  })
  it('refits stored values to a template and converts kinds', () => {
    expect(fitParams({ body: [{ kind: 'fixed', value: 'a' }] }, 2, 1).body).toHaveLength(2)
    expect(fitParams(null, 0, 0)).toEqual({ body: [], header: [] })
    expect(setKind({ kind: 'fixed', value: 'hi' }, 'field')).toEqual({ kind: 'field', field: 'contact.name', fallback: 'hi' })
    expect(setKind({ kind: 'field', field: 'contact.name', fallback: 'there' }, 'fixed')).toEqual({ kind: 'fixed', value: 'there' })
  })
  it('renders samples from frozen params, else from the specs', () => {
    const specs: ParamsSpec = { body: [{ kind: 'field', field: 'contact.name', fallback: 'there' }], header: [] }
    const row = { contact_id: 1, lead_id: 1, name: 'Asha', phone: '1', params: JSON.stringify({ body: ['Asha'], header: [] }) }
    expect(renderBody('Hi {{1}}!', sampleValues(row, specs).body)).toBe('Hi Asha!')
    expect(sampleValues({ ...row, params: null }, specs).body).toEqual(['there'])
    expect(sampleValues({ ...row, params: 'not json' }, specs).body).toEqual(['there'])
    expect(specSample(specs.body[0]!)).toBe('there')
  })
})

describe('review step', () => {
  it('needs the typed count only for everyone', () => {
    expect(confirmMatches(false, '', 120)).toBe(true)
    expect(confirmMatches(true, '', 120)).toBe(false)
    expect(confirmMatches(true, '119', 120)).toBe(false)
    expect(confirmMatches(true, '120', 120)).toBe(true)
    expect(confirmMatches(true, ' 1,200 ', 1200)).toBe(true)
  })
  it('estimates the pace', () => {
    expect(estimateMinutes(960, 20)).toBe(48)
    expect(paceLabel(960, 20)).toBe('about 48 min at 20 per minute')
    expect(paceLabel(2500, 20)).toBe('about 2 h 5 min at 20 per minute')
    expect(paceLabel(1, 20)).toBe('about 1 min at 20 per minute')
    expect(paceLabel(0, 20)).toBe('')
  })
  it('warns when the audience passes the tier cap, and only then', () => {
    expect(tierCap('TIER_1K')).toBe(1000)
    expect(tierCap('TIER_UNLIMITED')).toBeNull()
    expect(tierWarning(1000, 'TIER_1K')).toBeNull()
    expect(tierWarning(1001, 'TIER_1K')).toMatch(/1,000/)
    expect(tierWarning(5, null)).toBeNull()
  })
})

describe('progress', () => {
  const b = { id: 'bc_1', status: 'running' as const, pause_reason: null, total: 200, sent: 40, delivered: 10, read: 2, failed: 10 }
  it('computes percent and waiting', () => {
    expect(progressPct(b)).toBe(25)
    expect(progressPct({ ...b, total: 0 })).toBe(0)
    expect(progressPct({ ...b, status: 'finished' })).toBe(100)
    expect(waiting(b)).toBe(150)
    expect(waiting({ ...b, status: 'cancelled' })).toBe(0)
  })
  it('folds only its own frames', () => {
    expect(applyProgress(b, { id: 'bc_1', status: 'paused', pause_reason: 'quality', sent: 50 })).toMatchObject({ status: 'paused', pause_reason: 'quality', sent: 50, total: 200 })
    expect(applyProgress(b, { id: 'bc_2', sent: 99 })).toBe(b)
    expect(applyProgress(b, null)).toBe(b)
  })
  it('knows which controls apply', () => {
    expect(canPause('running')).toBe(true)
    expect(canPause('paused')).toBe(false)
    expect(canCancel('paused')).toBe(true)
    expect(canCancel('finished')).toBe(false)
    expect(canDelete('draft')).toBe(true)
    expect(canDelete('running')).toBe(false)
  })
})

describe('errors', () => {
  it('turns a 403 into plain words', () => {
    expect(broadcastErrorText(new ApiError(403, 'forbidden'))).toBe('Only an admin can do that.')
    expect(broadcastErrorText(new ApiError(409, 'Already started.'))).toBe('Already started.')
  })
})
