// the condition node runs regexes through the same guard as publish, including templated patterns.
import { describe, expect, it } from 'vitest'
import { conditionExecutor } from '../src/flows/nodes/condition'
import type { RunContext } from '../src/flows/context'

const ctx = (vars: Record<string, unknown>): RunContext => ({
  nodes: {}, vars, lead: {} as any, contact: { id: 1, name: null, phone: null, email: null, wa_id: null }, business: { open: true },
})
const run = (value: string, left: string, vars: Record<string, unknown>) =>
  conditionExecutor({ id: 'c', type: 'condition', data: { operator: 'regex', value, left } } as any, ctx(vars), {} as any)

describe('condition regex guard', () => {
  it('still matches a safe pattern', async () => {
    expect((await run('^ye?s', 'reply', { reply: 'Yes please' })).port).toBe('yes')
  })
  it('refuses a catastrophic pattern supplied through a variable, fast', async () => {
    const t = Date.now()
    const out = await run('{{pat}}', 'text', { pat: '(a+)+$', text: 'a'.repeat(26) + '!' })
    expect(out.port).toBe('no')
    expect(Date.now() - t).toBeLessThan(500)
  })
  it('refuses back-references and invalid patterns', async () => {
    expect((await run('(a)\\1', 't', { t: 'aa' })).port).toBe('no')
    expect((await run('([', 't', { t: '[' })).port).toBe('no')
  })
})
