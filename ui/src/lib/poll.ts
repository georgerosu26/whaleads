import { useEffect, useRef } from 'react'

export const MAX_BACKOFF_MS = 30_000

/** Next delay: the base cadence while healthy, doubling per consecutive failure up to 30 s. */
export const nextDelay = (baseMs: number, failures: number) => Math.min(baseMs * 2 ** failures, MAX_BACKOFF_MS)

/**
 * Free-plan live refresh: calls `task` every `baseMs` while the tab is visible. A rejected task counts as a failure
 * and backs the cadence off exponentially to 30 s; one success returns to `baseMs`. Never overlaps itself (a tick
 * that finds the previous call still running is skipped). Pauses while hidden and fires at once when the tab becomes
 * visible or focused again. The task closure is read through a ref so it may change freely.
 */
export function usePoller(task: () => Promise<unknown>, baseMs: number, enabled = true): void {
  const fn = useRef(task)
  fn.current = task
  useEffect(() => {
    if (!enabled) return
    let alive = true
    let failures = 0
    let busy = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const visible = () => document.visibilityState === 'visible'
    const schedule = () => {
      clearTimeout(timer)
      if (alive && visible()) timer = setTimeout(run, nextDelay(baseMs, failures))
    }
    const run = async () => {
      if (!alive) return
      if (!visible()) return // resumed by the visibility listener
      if (busy) { schedule(); return }
      busy = true
      try { await fn.current(); failures = 0 } catch { failures += 1 } finally { busy = false }
      schedule()
    }
    const wake = () => { if (visible()) { clearTimeout(timer); void run() } }
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('focus', wake)
    schedule()
    return () => { alive = false; clearTimeout(timer); document.removeEventListener('visibilitychange', wake); window.removeEventListener('focus', wake) }
  }, [baseMs, enabled])
}
