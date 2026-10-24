import { interpolate } from '../context'
import type { NodeExecutor } from '../executor'
import { countSubrequest } from '../meter'
import { getAiModel, getAnthropicKey } from '../../settings'
import { LIMITS } from '../types'
import { SAFE_VAR, failOrRoute } from './fail'

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
export const ANTHROPIC_VERSION = '2023-06-01'
const MAX_ANSWER = 4000

/**
 * One Anthropic Messages call. The key comes from Settings (encrypted at rest, decrypted here, never logged, never put in
 * the trace or the run context). System prompt and user content are templates over the run. The answer goes to
 * `output.answer` and, when `outputVariable` is set, to that variable. 8 s timeout, small max_tokens, one subrequest.
 *
 * Model: setting `ai_model`, default claude-haiku-5-5. Haiku 5.5 thinks by default and thinking tokens count against
 * max_tokens, so for the Haiku 5 family the request turns thinking off (accepted at effort high or below) and asks for
 * low effort; other models are sent without those fields.
 *
 * No key set: the node fails with `ai_not_configured` (the `error` port if connected, else the run fails).
 * Shadow and dry runs skip the call.
 */
export const aiExecutor: NodeExecutor = async (node, ctx, svc) => {
  const d = node.data as { systemPrompt?: unknown; prompt?: unknown; outputVariable?: unknown; maxTokens?: unknown }
  const system = interpolate(String(d.systemPrompt ?? ''), ctx).trim().slice(0, LIMITS.AI_MAX_INPUT_CHARS)
  const content = interpolate(String(d.prompt ?? ''), ctx).trim().slice(0, LIMITS.AI_MAX_INPUT_CHARS)
  const n = Number(d.maxTokens)
  const maxTokens = Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), LIMITS.AI_MAX_TOKENS_CEILING) : LIMITS.AI_MAX_TOKENS
  const outVar = typeof d.outputVariable === 'string' ? d.outputVariable.trim() : ''
  if (outVar && !SAFE_VAR.test(outVar)) return failOrRoute(svc, node, 'invalid_variable_name', 'The output variable name is not valid.')

  if (svc.shadow || svc.dryRun) return { port: 'out', status: 'skipped', output: { would: { max_tokens: maxTokens, has_system: !!system, chars: content.length }, shadow: true }, note: 'shadow: AI call skipped' }
  if (!content) return failOrRoute(svc, node, 'empty_prompt', 'The AI node has nothing to ask.')

  const key = await getAnthropicKey(svc.env)
  if (!key) return failOrRoute(svc, node, 'ai_not_configured', 'No Anthropic key is set. Add one in Settings to use AI nodes.')
  const model = await getAiModel(svc.env)

  const body: Record<string, unknown> = { model, max_tokens: maxTokens, messages: [{ role: 'user', content }] }
  if (system) body.system = system
  if (/^claude-haiku-5/.test(model)) { body.thinking = { type: 'disabled' }; body.output_config = { effort: 'low' } }

  countSubrequest(svc.meter)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LIMITS.AI_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    // Only the error's name: a message could in theory echo request details.
    if (e instanceof Error && e.name === 'AbortError') return failOrRoute(svc, node, 'ai_timeout', `The AI did not answer within ${LIMITS.AI_TIMEOUT_MS / 1000} seconds.`)
    return failOrRoute(svc, node, 'ai_unreachable', 'The AI service could not be reached.')
  }
  let data: any = null
  try { data = await res.json() } catch { /* non-JSON error page */ }
  clearTimeout(timer)
  if (!res.ok) {
    const why = typeof data?.error?.message === 'string' ? data.error.message.slice(0, 160) : `HTTP ${res.status}`
    return failOrRoute(svc, node, res.status === 401 || res.status === 403 ? 'ai_auth_failed' : res.status === 429 ? 'ai_rate_limited' : 'ai_error', why, 'error', { status: res.status })
  }
  if (data?.stop_reason === 'refusal') return failOrRoute(svc, node, 'ai_refused', 'The AI declined to answer.')
  const answer = (Array.isArray(data?.content) ? data.content : []).filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('').trim().slice(0, MAX_ANSWER)
  if (outVar) ctx.vars[outVar] = answer
  return { port: 'out', output: { ok: true, answer, model: data?.model ?? model, stop_reason: data?.stop_reason ?? null, usage: { input_tokens: data?.usage?.input_tokens ?? null, output_tokens: data?.usage?.output_tokens ?? null } } }
}
