import { interpolate } from '../context'
import type { NodeExecutor } from '../executor'
import { countSubrequest } from '../meter'
import { loadSendableTemplate, sampleHeaderMedia, sendTemplateToContact, type TemplateMedia } from '../../send'
import { paramProblem, renderParams } from '../../templateRules'
import { rowJson } from '../../templates'
import { failOrRoute, templated } from './fail'

/**
 * Sends an approved template (any time; templates ignore the 24 h window). Body and header values are templates over
 * the run: `{{lead.name}}`, `{{some_variable}}`, `{{node_id.field}}`. A media header uses the template's own stored
 * sample (a template that needs one and has none stored fails readably).
 * Only APPROVED, sendable templates go out; anything else routes to `error` or fails the run.
 */
export const templateExecutor: NodeExecutor = async (node, ctx, svc) => {
  const d = node.data as { templateId?: unknown; templateName?: unknown; bodyParams?: unknown; headerParams?: unknown }
  const render = (s: string) => interpolate(s, ctx).trim()
  const bodyParams = templated(d.bodyParams, render)
  const headerParams = templated(d.headerParams, render)
  if (svc.shadow || svc.dryRun) return { port: 'out', status: 'skipped', output: { would: { template: d.templateName ?? d.templateId ?? null, bodyParams, headerParams }, shadow: true }, note: 'shadow: template not sent' }

  const found = await loadSendableTemplate(svc.env, { id: d.templateId, name: d.templateName })
  if (!found.ok) return failOrRoute(svc, node, found.code, found.message)
  const t = found.template
  if (bodyParams.length !== t.body_params_count) return failOrRoute(svc, node, 'template_params', `This template needs ${t.body_params_count} body value${t.body_params_count === 1 ? '' : 's'}, the node has ${bodyParams.length}.`)
  if (headerParams.length !== t.header_params_count) return failOrRoute(svc, node, 'template_params', `The header needs ${t.header_params_count} value${t.header_params_count === 1 ? '' : 's'}, the node has ${headerParams.length}.`)
  for (const [i, v] of [...bodyParams, ...headerParams].entries()) {
    const p = paramProblem(v)
    if (p) return failOrRoute(svc, node, 'template_params', `Value ${i + 1}: ${p}`)
  }

  let media: TemplateMedia | null = null
  if (t.header_format === 'IMAGE' || t.header_format === 'VIDEO' || t.header_format === 'DOCUMENT') {
    const s = await sampleHeaderMedia(svc.env, t)
    if (!s.ok) return failOrRoute(svc, node, s.code, s.message)
    media = s.media
  }

  const view = rowJson(t)
  const text = [view.header_text ? renderParams(view.header_text, headerParams) : '', renderParams(view.body, bodyParams)].filter(Boolean).join('\n')
  countSubrequest(svc.meter, media ? 2 : 1)
  const r = await sendTemplateToContact(svc.env, ctx.contact.id, t, { bodyParams, headerParams, media, text }, { origin: svc.actor, awaitRecord: true, ctx: svc.ctx })
  if (r.ok) return { port: 'out', output: { ok: true, wamid: r.wamid, template: t.name, text, ...(r.queued ? { queued: true } : {}) } }
  return failOrRoute(svc, node, r.kind === 'refused' ? r.code : 'send_failed', r.message)
}
