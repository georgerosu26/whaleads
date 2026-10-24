// Minimal D1 shim over node:sqlite so tests run the real migrations and SQL.
import { DatabaseSync } from 'node:sqlite'

class Stmt {
  constructor(private db: DatabaseSync, private sql: string, private params: unknown[] = []) {}
  bind(...p: unknown[]) { return new Stmt(this.db, this.sql, p) }
  runSync() {
    const st = this.db.prepare(this.sql)
    // Like a real D1 batch, a SELECT inside it returns its rows.
    if (st.columns().length > 0) return { success: true, results: st.all(...(this.params as any[])) as unknown[], meta: { changes: 0, last_row_id: 0 } } as any
    const r = st.run(...(this.params as any[]))
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }
  }
  async run() { return this.runSync() }
  async first<T>() { return (this.db.prepare(this.sql).get(...(this.params as any[])) as T | undefined) ?? null }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...(this.params as any[])) as T[] } }
}

/** Pass `shared` to open a second D1 handle on the same database (two isolates, one D1). */
export function fakeD1(shared?: DatabaseSync) {
  const db = shared ?? new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  const d1 = {
    prepare: (sql: string) => new Stmt(db, sql),
    exec: async (sql: string) => { db.exec(sql) },
    // One synchronous block, like a D1 batch: all statements in a single transaction, nothing interleaves.
    batch: async (stmts: Stmt[]) => {
      if (stmts.length === 0) throw new Error('D1_ERROR: No SQL statements detected.') // real D1 rejects an empty batch
      db.exec('BEGIN')
      try { const out = stmts.map((s) => s.runSync()); db.exec('COMMIT'); return out } catch (e) { db.exec('ROLLBACK'); throw e }
    },
  }
  return { d1: d1 as unknown as D1Database, raw: db }
}

/** A database exactly as an earlier release left it: the first `version` migrations, applied by hand. */
async function legacy(version: 2 | 3 | 4 | 5 | 6 | 7 | 8, withLocks: boolean) {
  const { MIGRATIONS } = await import('../src/db')
  const f = fakeD1()
  f.raw.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
  for (const step of MIGRATIONS.slice(0, version)) for (const sql of step) f.raw.exec(sql)
  f.raw.exec(`INSERT INTO meta VALUES ('schema_version','${version}')`)
  if (withLocks) for (let n = 1; n <= version; n++) f.raw.exec(`INSERT INTO meta VALUES ('applied_${n}','0')`)
  return f
}

/** A genuine v2 database (schema_version 2, no `applied_<n>` lock rows). */
export const legacyV2 = () => legacy(2, false)
/** A genuine v3 database: lock rows applied_1..3 present. */
export const legacyV3 = () => legacy(3, true)
/** A genuine v4 database: lock rows applied_1..4 present, as deployed before the polling indexes. */
export const legacyV4 = () => legacy(4, true)
/** A genuine v5 database (polling indexes): lock rows applied_1..5, as deployed before the flow engine. */
export const legacyV5 = () => legacy(5, true)
/** A genuine v6 database (templates): lock rows applied_1..6 present, before the reports indexes. */
export const legacyV6 = () => legacy(6, true)
/** A genuine v7 database (flows): locks applied_1..7 present, before the reports indexes. */
export const legacyV7 = () => legacy(7, true)
/** A genuine v8 database (reports indexes): locks applied_1..8 present, before broadcasts. */
export const legacyV8 = () => legacy(8, true)
