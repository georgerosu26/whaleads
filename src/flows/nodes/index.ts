import type { ExecutorMap } from '../executor'
import { actionExecutor } from './action'
import { aiExecutor } from './ai'
import { conditionExecutor } from './condition'
import { delayExecutor } from './delay'
import { httpRequestExecutor } from './http_request'
import { leadWritebackExecutor } from './lead_writeback'
import { messageExecutor } from './message'
import { templateExecutor } from './template'
import { triggerExecutor } from './trigger'
import { variableExecutor } from './variable'
import { waitEventExecutor } from './wait_event'

/** The full node set (core + message, template, ai, http_request). */
export const EXECUTORS: ExecutorMap = {
  trigger: triggerExecutor,
  condition: conditionExecutor,
  variable: variableExecutor,
  delay: delayExecutor,
  wait_event: waitEventExecutor,
  action: actionExecutor,
  lead_writeback: leadWritebackExecutor,
  message: messageExecutor,
  template: templateExecutor,
  ai: aiExecutor,
  http_request: httpRequestExecutor,
}
