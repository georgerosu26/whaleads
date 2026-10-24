import { interpolate, resolve, type RunContext } from '../context'
import { clipText, compileSafeRegex } from '../regex'
import type { NodeExecutor } from '../executor'

/** Branch on the context: an operator against an interpolated left value. Routes `yes` / `no`. */
export const conditionExecutor: NodeExecutor = async (node, ctx) => {
  const d = node.data as { operator?: string; value?: string; left?: string }
  const operator = d.operator ?? 'equals'
  const rhs = interpolate(d.value ?? '', ctx)
  const lhs = d.left ? interpolate(d.left.includes('{{') ? d.left : `{{${d.left}}}`, ctx) : interpolate('{{user_response}}', ctx)
  const matched = evaluate(operator, lhs, rhs, ctx, d.left)
  return { port: matched ? 'yes' : 'no', output: { matched, operator, lhs, rhs } }
}

function evaluate(op: string, lhs: string, rhs: string, ctx: RunContext, leftExpr?: string): boolean {
  const l = lhs.toLowerCase()
  const r = rhs.toLowerCase()
  switch (op) {
    case 'equals': return l === r
    case 'not_equals': return l !== r
    case 'contains': return l.includes(r)
    case 'not_contains': return !l.includes(r)
    case 'starts_with': return l.startsWith(r)
    case 'ends_with': return l.endsWith(r)
    case 'regex': {
      // The pattern may be templated ({{...}}), so it is checked here, at run time, with the same guard publish uses:
      // a pattern the guard refuses (catastrophic backtracking, too long, invalid) never matches. The text is clipped too.
      const c = compileSafeRegex(rhs)
      return c.ok ? c.re.test(clipText(lhs)) : false
    }
    case 'gt': case 'gte': case 'lt': case 'lte': {
      const a = num(lhs), b = num(rhs)
      if (a === null || b === null) return false // missing / empty / non-numeric is never greater or less than anything
      return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b
    }
    case 'is_empty': return lhs.trim() === ''
    case 'is_not_empty': return lhs.trim() !== ''
    case 'exists': {
      if (!leftExpr) return lhs.trim() !== ''
      return resolve(ctx, leftExpr.replace(/^\{\{\s*|\s*\}\}$/g, '')) !== undefined
    }
    default: return l === r
  }
}

/** Strict number: trimmed, non-empty, decimal only (no '', '0x10', '1e3 apples', 'Infinity'). */
function num(v: string): number | null {
  const t = v.trim()
  return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : null
}
