import type { NodeExecutor } from '../executor'

/** The entry node. Matching (sources, stages, keywords) is the dispatcher's job; here it only publishes the event. */
export const triggerExecutor: NodeExecutor = async (node, ctx) => ({
  port: 'out',
  output: { kind: node.data.kind ?? null, ...(ctx.lastEvent ?? {}) },
})
