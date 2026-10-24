// Fixed-window rate limiter on D1 (`rate_limits`). One atomic upsert per hit, so concurrent requests
// cannot both slip under the limit.
// Stale rows and expired sessions are purged by the cron in media.ts (purgeExpired).

/**
 * Records one hit for `key` and returns true when the caller is over `limit` hits per `windowSec`.
 * The window starts at the first hit and is not extended by later ones. Same behaviour as the original
 * intake limiter: with limit 10 the first ten hits pass and the eleventh is limited.
 */
export async function hit(db: D1Database, key: string, limit: number, windowSec: number): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key,count,window_start) VALUES (?1,1,?2)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN ?2 - window_start >= ?3 THEN 1 ELSE count + 1 END,
         window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2 ELSE window_start END
       RETURNING count`,
    )
    .bind(key, now, windowSec)
    .first<{ count: number }>()
  return (row?.count ?? 1) > limit
}

/** Current count for `key` inside its window, without recording a hit. */
export async function peek(db: D1Database, key: string, windowSec: number): Promise<number> {
  const now = Math.floor(Date.now() / 1000)
  const row = await db.prepare(`SELECT count FROM rate_limits WHERE key=?1 AND ?2 - window_start < ?3`).bind(key, now, windowSec).first<{ count: number }>()
  return row?.count ?? 0
}

export async function clear(db: D1Database, key: string): Promise<void> {
  await db.prepare(`DELETE FROM rate_limits WHERE key=?`).bind(key).run()
}
