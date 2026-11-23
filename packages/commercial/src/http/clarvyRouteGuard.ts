import type { ServerResponse } from 'node:http'

import { incrGatewayRequest } from '../admin/metrics.js'
import type { Logger } from '../logging/logger.js'
import { sendError } from './util.js'

/**
 * Clarvy 上下文健康、确定性清理、记忆归档箱与技能归档箱路由(OCV5-859)。
 *
 * 商业版中普通用户只能经前置 `containerApiProxy` 访问自己隔离容器内的同类路由；
 * 一旦跳过 proxy 进入 commercial 兜底防火墙且缺乏有效 commercial JWT（包括无凭据、
 * 伪造/过期 JWT，或仅 gateway 层认得的跨层凭据如 `sec-websocket-protocol` / 裸
 * `Authorization` / gateway JWT），严禁 `return false` fall-through 到宿主 gateway
 * (`contextHealthApi.ts` 无多租户隔离)，必须在此直接返回规范 `401 UNAUTHORIZED` 终结请求。
 */
export const CLARVY_FAIL_CLOSED_PATTERNS: readonly RegExp[] = [
  /^\/api\/agents\/[^/]+\/context-health$/,
  /^\/api\/agents\/[^/]+\/context-hygiene\/.+$/,
  /^\/api\/agents\/[^/]+\/memory\/archive(\/restore)?$/,
  /^\/api\/skills\/archive(\/restore)?$/,
  /^\/api\/skills\/[^/]+\/archive$/,
]

export function isClarvyFailClosedRoute(path: string): boolean {
  return CLARVY_FAIL_CLOSED_PATTERNS.some((re) => re.test(path))
}

export function handleUnauthenticatedClarvyRoute(
  path: string,
  method: string,
  res: ServerResponse,
  requestId: string,
  log: Logger,
): boolean {
  if (!isClarvyFailClosedRoute(path)) return false
  log.warn('clarvy_unauthenticated_blocked', { method })
  sendError(res, 401, 'UNAUTHORIZED', 'authentication required', requestId)
  incrGatewayRequest('__blocked_for_user__', method, res.statusCode)
  return true
}
