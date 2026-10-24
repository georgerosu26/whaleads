// D1 call meter. The free plan allows 50 D1 queries per invocation (a batch counts as one), and a cron tick shares
// that budget with the other jobs. Wrapping env.DB counts every executed statement so the tick can stop resuming
// runs before it hits the wall, instead of guessing from the shape of the code.

export interface Meter {
  calls: number
  /** Outbound fetches made by nodes (AI, HTTP, WhatsApp sends). The free plan allows 50 subrequests per invocation. */
  subrequests?: number
}

export const countSubrequest = (m: Meter | undefined, n = 1): void => { if (m) m.subrequests = (m.subrequests ?? 0) + n }

const EXEC = new Set(['first', 'all', 'run', 'raw'])
const REAL = Symbol('real')

function wrapStmt(stmt: D1PreparedStatement, m: Meter): D1PreparedStatement {
  return new Proxy(stmt, {
    get(t, p) {
      if (p === REAL) return t
      if (p === 'bind') return (...a: unknown[]) => wrapStmt(t.bind(...a), m)
      const v = Reflect.get(t, p, t) as unknown
      if (typeof p === 'string' && EXEC.has(p) && typeof v === 'function') return (...a: unknown[]) => { m.calls++; return (v as (...x: unknown[]) => unknown).apply(t, a) }
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v
    },
  })
}

const unwrap = (s: D1PreparedStatement): D1PreparedStatement => ((s as unknown as Record<symbol, D1PreparedStatement>)[REAL] ?? s)

/** A D1Database whose executed statements are counted in `m`. Statements built on it can be batched on it. */
export function meterDb(db: D1Database, m: Meter): D1Database {
  return new Proxy(db, {
    get(t, p) {
      if (p === 'prepare') return (sql: string) => wrapStmt(t.prepare(sql), m)
      if (p === 'batch') return (stmts: D1PreparedStatement[]) => { m.calls++; return t.batch(stmts.map(unwrap)) }
      if (p === 'exec') return (sql: string) => { m.calls++; return t.exec(sql) }
      const v = Reflect.get(t, p, t) as unknown
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v
    },
  })
}
