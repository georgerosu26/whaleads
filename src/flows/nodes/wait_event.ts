import type { NodeExecutor } from '../executor'
import { waitSeconds } from './time'

/**
 * Wait for the contact's next inbound message. Parks as a reply wait whose `resume_at` is the timeout, so the tick
 * finds expired waits through the same index as timers (they resume on the `timeout` port).
 * A dry run takes the supplied reply (`completed`) or follows `timeout`.
 */
export const waitEventExecutor: NodeExecutor = async (node, ctx, svc) => {
  const seconds = waitSeconds(node.data as { timeout?: unknown; timeoutUnit?: unknown })
  if (svc.dryRun) {
    if (svc.dryReply) {
      ctx.lastEvent = svc.dryReply
      return { port: 'completed', output: { reply: svc.dryReply } }
    }
    return { port: 'timeout', output: { timed_out: true } }
  }
  const resumeAt = svc.now + seconds
  return { port: 'await', output: { waiting_for: 'reply', timeout_s: seconds, resume_at: resumeAt }, await: { kind: 'reply', resumeAt } }
}
