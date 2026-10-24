import { interpolate } from '../context'
import type { NodeExecutor } from '../executor'

/** `__`-prefixed names are the engine's own; a flow author cannot set them. */
const BAD_NAME = /^(__|constructor$|prototype$)/

export const variableExecutor: NodeExecutor = async (node, ctx) => {
  const d = node.data as { variableName?: string; operation?: 'set' | 'append' | 'increment' | 'clear'; value?: string }
  const name = (d.variableName ?? '').trim()
  const op = d.operation ?? 'set'
  if (!name || BAD_NAME.test(name) || !/^[\w-]{1,60}$/.test(name)) {
    return { port: 'out', status: 'failed', output: { ok: false, error: 'invalid_variable_name' } }
  }
  const rendered = interpolate(d.value ?? '', ctx)
  let next: unknown
  switch (op) {
    case 'append': next = `${ctx.vars[name] ?? ''}${rendered}`; break
    case 'increment': {
      const base = Number(ctx.vars[name] ?? 0)
      const delta = Number(rendered || 1)
      next = (Number.isFinite(base) ? base : 0) + (Number.isFinite(delta) ? delta : 0)
      break
    }
    case 'clear': next = undefined; break
    default: next = rendered
  }
  if (next === undefined) delete ctx.vars[name]
  else ctx.vars[name] = next
  return { port: 'out', output: { name, operation: op, value: next ?? null } }
}
