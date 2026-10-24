import { useLoad } from '@/lib/useLoad'
import { useLiveEvents } from '@/lib/live'
import type { FlowSummary } from '@/lib/flows'

/** The flow list, refetched when a flow is published/paused elsewhere or a run starts. */
export function useLive() {
  const { state, reload } = useLoad<{ flows: FlowSummary[] }>('/api/flows')
  useLiveEvents((s) => { if (s.type === 'flow.updated' || s.type === 'resync') void reload() })
  return { st: state, reload }
}
