import type { IncomingMessage, ServerResponse } from 'node:http'
import { isClientMessageId, type ModelSwitchCostRequest } from '@openclaude/protocol'
import { requireAuth } from './auth.js'
import { readJsonBody, sendJson, HttpError } from './util.js'
import type { CommercialHttpDeps } from './handlers.js'
import { ModelSwitchCostError } from '../billing/modelSwitchCost.js'

export async function handleModelSwitchCost(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const match = new URL(req.url ?? '', 'http://local').pathname.match(
    /^\/api\/me\/sessions\/([^/]+)\/model-switch-estimate$/,
  )
  if (!match) throw new HttpError(404, 'NOT_FOUND', 'not found')
  let sessionId: string
  try {
    sessionId = decodeURIComponent(match[1])
  } catch {
    throw new HttpError(400, 'VALIDATION', 'invalid session')
  }
  if (!/^[A-Za-z0-9_:-]{1,256}$/.test(sessionId))
    throw new HttpError(400, 'VALIDATION', 'invalid session')
  const raw = await readJsonBody(req, 1024 * 1024)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new HttpError(400, 'VALIDATION', 'invalid request')
  const b = raw as Record<string, unknown>
  if (
    !isClientMessageId(b.requestId) ||
    typeof b.targetModel !== 'string' ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(b.targetModel) ||
    typeof b.agentId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(b.agentId) ||
    (b.teamMode !== undefined && typeof b.teamMode !== 'boolean') ||
    (b.contextTier !== undefined && b.contextTier !== '300k' && b.contextTier !== '1m') ||
    (b.serviceTier !== undefined && b.serviceTier !== 'fast') ||
    (b.text !== undefined && typeof b.text !== 'string') ||
    (b.mediaCount !== undefined &&
      (typeof b.mediaCount !== 'number' ||
        !Number.isInteger(b.mediaCount) ||
        b.mediaCount < 0 ||
        b.mediaCount > 8)) ||
    (b.quoteToken !== undefined &&
      (typeof b.quoteToken !== 'string' || b.quoteToken.length > 4096)) ||
    (b.consent !== undefined && (typeof b.consent !== 'string' || b.consent.length > 4096))
  )
    throw new HttpError(400, 'VALIDATION', 'invalid switch parameters')
  const service = deps.modelSwitchCost
  if (!service) throw new HttpError(503, 'MODEL_SWITCH_UNAVAILABLE', '费用确认暂不可用，请重试')
  const input: ModelSwitchCostRequest = {
    sessionId,
    requestId: b.requestId,
    targetModel: b.targetModel,
    agentId: b.agentId,
    ...(b.teamMode === true ? { teamMode: true } : {}),
    ...(b.contextTier ? { contextTier: b.contextTier as '300k' | '1m' } : {}),
    ...(b.serviceTier === 'fast' ? { serviceTier: 'fast' as const } : {}),
    ...(typeof b.text === 'string' ? { text: b.text } : {}),
    ...(typeof b.mediaCount === 'number' ? { mediaCount: b.mediaCount } : {}),
  }
  try {
    await service.validateTarget(user.id, input)
    const result =
      typeof b.quoteToken === 'string'
        ? await service.confirm(user.id, input, b.quoteToken)
        : await service.quote(user.id, input, b.consent as string | undefined)
    res.setHeader('Cache-Control', 'no-store')
    sendJson(res, 200, result)
  } catch (e) {
    if (e instanceof ModelSwitchCostError)
      throw new HttpError(
        e.code === 'MODEL_SWITCH_UNAVAILABLE'
          ? 503
          : e.code === 'UNAUTHORIZED_MODEL'
            ? 403
            : e.code === 'MODEL_NOT_AVAILABLE'
              ? 404
              : 409,
        e.code,
        e.message,
      )
    throw e
  }
}
