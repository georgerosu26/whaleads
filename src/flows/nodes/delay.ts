import type { NodeExecutor } from '../executor'
import { delaySeconds } from './time'

/** Parks the run as a timer. Dry runs fast-forward. A shadow run really waits (that is the point of shadowing). */
export const delayExecutor: NodeExecutor = async (node, _ctx, svc) => {
  const seconds = delaySeconds(node.data as { duration?: unknown; unit?: unknown })
  if (svc.dryRun) return { port: 'out', output: { seconds, skipped: true } }
  const resumeAt = svc.now + seconds
  return { port: 'await', output: { seconds, resume_at: resumeAt }, await: { kind: 'timer', resumeAt } }
}
