import { Bad, activityStmts, getLeadRow, planLeadUpdate, tagDeltaStmts } from '../../crm'
import { interpolate } from '../context'
import type { FlowServices, NodeExecutor } from '../executor'
import { nextActionSeconds } from './time'

type ActionType = 'set_stage' | 'add_tag' | 'remove_tag' | 'assign' | 'note' | 'set_next_action'

/** Loads the lead row once per step; planned updates patch it so a second action in the step sees the first. */
export async function leadRowOf(svc: FlowServices, leadId: number) {
  if (!svc.leadRow) {
    const row = await getLeadRow(svc.env, leadId)
    if (!row) throw new Bad('lead no longer exists')
    svc.leadRow = row
  }
  return svc.leadRow
}

/**
 * A side effect on the lead through the CRM core, with actor `flow:<id>` so the activity timeline says who did it.
 * The statements join the step's batch (see FlowServices.pending). Shadow and dry-run record `{would}` and touch
 * nothing. A failed side effect is recorded and the run carries on from `out` (it must not dead-end the flow).
 */
export const actionExecutor: NodeExecutor = async (node, ctx, svc) => {
  const d = node.data as { actionType?: ActionType; stage?: string; tag?: string; staffId?: number | string | null; text?: string; duration?: number; unit?: string }
  const type = d.actionType
  const leadId = ctx.lead.id
  const out: Record<string, unknown> = { actionType: type ?? null }

  const text = d.text !== undefined ? interpolate(d.text, ctx).slice(0, 2000) : ''
  const tag = d.tag !== undefined ? interpolate(d.tag, ctx).trim() : ''
  const would: Record<string, unknown> = { ...out }
  switch (type) {
    case 'set_stage': would.stage = d.stage ?? null; break
    case 'add_tag': case 'remove_tag': would.tag = tag; break
    case 'assign': would.staff_id = d.staffId === '' || d.staffId == null ? null : Number(d.staffId); break
    case 'note': would.text = text; break
    case 'set_next_action': would.after_s = nextActionSeconds(d); break
    default: return { port: 'out', status: 'skipped', output: { ...out, skipped: true, reason: 'unknown_action' } }
  }
  if (svc.shadow || svc.dryRun) return { port: 'out', output: { would, shadow: true } }

  try {
    const lead = await leadRowOf(svc, leadId)
    const at = svc.now
    switch (type) {
      case 'set_stage': {
        const { stmts } = await planLeadUpdate(svc.env, svc.actor, lead, { status: d.stage }, at)
        svc.pending.push(...stmts)
        if (stmts.length) { lead.status = String(d.stage); ctx.lead.stage = lead.status; svc.stageChanged = true }
        out.stage = d.stage
        break
      }
      case 'assign': {
        const to = d.staffId === '' || d.staffId == null ? null : Number(d.staffId)
        const { stmts } = await planLeadUpdate(svc.env, svc.actor, lead, { assigned_to: to }, at)
        svc.pending.push(...stmts)
        if (stmts.length) { lead.assigned_to = to; ctx.lead.assigned_to = to }
        out.staff_id = to
        break
      }
      case 'set_next_action': {
        const when = at + (would.after_s as number)
        const { stmts } = await planLeadUpdate(svc.env, svc.actor, lead, { next_action_at: when }, at)
        svc.pending.push(...stmts)
        lead.next_action_at = when
        out.next_action_at = when
        break
      }
      case 'note':
        if (text) svc.pending.push(...activityStmts(svc.env, leadId, lead.contact_id, svc.actor, 'note', { text }, at))
        out.text = text
        break
      case 'add_tag': case 'remove_tag': {
        if (!tag) throw new Bad('tag is empty')
        // Tag state is read once per step (2 calls) and kept current as tag nodes plan, so N tag nodes cost 2 reads, not 2N,
        // and an add then a remove of the same tag in one step nets out correctly.
        if (!svc.tagState) {
          const [{ results: all }, { results: have }] = await Promise.all([
            svc.env.DB.prepare(`SELECT id,label FROM tags`).all<{ id: number; label: string }>(),
            svc.env.DB.prepare(`SELECT tag_id FROM lead_tags WHERE lead_id = ?`).bind(leadId).all<{ tag_id: number }>(),
          ])
          svc.tagState = { known: new Map(all.map((r) => [r.id, r.label])), have: new Set(have.map((r) => r.tag_id)) }
        }
        const { known, have } = svc.tagState
        const wantLabel = tag.toLowerCase()
        const t = [...known].map(([id, label]) => ({ id, label })).find((x) => x.label.toLowerCase() === wantLabel)
        if (!t) throw new Bad(`unknown tag "${tag}"`)
        const want = type === 'add_tag' ? [...new Set([...have, t.id])] : [...have].filter((id) => id !== t.id)
        const { stmts } = tagDeltaStmts(svc.env, svc.actor, lead, known, have, want, at)
        svc.pending.push(...stmts)
        svc.tagState.have = new Set(want)
        ctx.lead.tags = type === 'add_tag' ? [...new Set([...ctx.lead.tags, t.label])] : ctx.lead.tags.filter((x) => x.toLowerCase() !== t.label.toLowerCase())
        out.tag = t.label
        break
      }
    }
    out.ok = true
    return { port: 'out', output: out }
  } catch (e) {
    if (!(e instanceof Bad)) throw e
    return { port: 'out', status: 'failed', output: { ...out, ok: false, error: e.message } }
  }
}
