import { Bad, activityStmts, planLeadUpdate } from '../../crm'
import { resolve, type RunContext } from '../context'
import type { NodeExecutor } from '../executor'
import { leadRowOf } from './action'

interface Signal { path: string; weight: number }
interface Threshold { min: number; verdict: string; stage?: string }
export interface RatingRules { signals?: Signal[]; thresholds?: Threshold[] }

/**
 * Closes a qualification: rates the lead from the run's context, moves it to the verdict's stage (through the CRM
 * core, actor `flow:<id>`) and writes a `qualified` activity row. There are no verdict/score columns on leads; the
 * activity row is where the rating lives.
 */
export const leadWritebackExecutor: NodeExecutor = async (node, ctx, svc) => {
  const d = node.data as { ratingRules?: RatingRules; verdict?: string; score?: number; stage?: string }
  const rules = d.ratingRules ?? {}
  let { verdict, score } = computeRating(rules, ctx)
  if (d.verdict) verdict = String(d.verdict)
  if (typeof d.score === 'number' && Number.isFinite(d.score)) score = d.score
  score = Math.round(score)
  const stage = d.stage || (rules.thresholds ?? []).find((t) => t.verdict === verdict)?.stage || null

  if (svc.shadow || svc.dryRun) return { port: 'out', output: { would: { verdict, score, stage }, verdict, score, shadow: true } }

  const lead = await leadRowOf(svc, ctx.lead.id)
  let moved = false
  let stageError: string | null = null
  if (stage) {
    try {
      const { stmts } = await planLeadUpdate(svc.env, svc.actor, lead, { status: stage }, svc.now)
      svc.pending.push(...stmts)
      if (stmts.length) { lead.status = stage; ctx.lead.stage = stage; moved = true; svc.stageChanged = true }
    } catch (e) {
      if (!(e instanceof Bad)) throw e
      stageError = e.message
    }
  }
  svc.pending.push(...activityStmts(svc.env, lead.id, lead.contact_id, svc.actor, 'qualified', { verdict, score, run_id: svc.runId, stage: moved ? stage : null }, svc.now))
  return { port: 'out', status: stageError ? 'failed' : 'ok', output: { verdict, score, stage, moved, ...(stageError ? { error: stageError } : {}) } }
}

/** Weighted-signal rating: each signal adds weight * numeric value; the highest threshold the total reaches wins. */
export function computeRating(rules: RatingRules, ctx: RunContext): { verdict: string; score: number } {
  const signals = Array.isArray(rules.signals) ? rules.signals : []
  const thresholds = (Array.isArray(rules.thresholds) ? rules.thresholds : []).slice().sort((a, b) => b.min - a.min)
  if (signals.length === 0) {
    const s = Number(resolve(ctx, 'ai.score') ?? NaN)
    const score = Number.isFinite(s) ? s : 50
    return pickVerdict(score, thresholds) ?? { verdict: 'warm', score }
  }
  let score = 0
  for (const s of signals) {
    const v = Number(resolve(ctx, s.path) ?? 0)
    if (Number.isFinite(v)) score += v * (s.weight ?? 1)
  }
  return pickVerdict(score, thresholds) ?? { verdict: 'warm', score }
}

export function pickVerdict(score: number, thresholds: Threshold[]): { verdict: string; score: number } | null {
  for (const t of thresholds) if (score >= t.min) return { verdict: t.verdict, score }
  return thresholds.length ? { verdict: thresholds[thresholds.length - 1].verdict, score } : null
}
