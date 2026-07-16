import type { IncomingMessage, ServerResponse } from 'node:http'

import type { ContainerPreviewViewport } from '@openclaude/protocol'

import { requireAuth } from './auth.js'
import type { CommercialHttpDeps, RequestContext } from './handlers.js'
import { requireActiveAccountVerifyDb } from './requireUser.js'
import { HttpError, readJsonBody, sendJson } from './util.js'

export async function handleCreateContainerPreviewTicket(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  if (
    !deps.containerPreviewTickets ||
    !deps.v3Supervisor ||
    deps.containerPreviewAvailable?.() !== true
  ) {
    throw new HttpError(503, 'PREVIEW_UNAVAILABLE', '网页预览暂不可用')
  }
  const user = await requireAuth(req, deps.jwtSecret)
  if (!(await requireActiveAccountVerifyDb(user.id, ['user', 'admin'], deps.v3Supervisor.pool))) {
    throw new HttpError(403, 'FORBIDDEN', 'account is not allowed to open a container preview')
  }
  const body = await readJsonBody(req)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'VALIDATION', 'object body required')
  }
  const value = body as Record<string, unknown>
  if (typeof value.url !== 'string') throw new HttpError(400, 'VALIDATION', 'url is required')
  if (
    value.viewport !== undefined &&
    (!value.viewport || typeof value.viewport !== 'object' || Array.isArray(value.viewport))
  ) {
    throw new HttpError(400, 'VALIDATION', 'viewport must be an object')
  }
  if (value.direct !== undefined && typeof value.direct !== 'boolean') {
    throw new HttpError(400, 'VALIDATION', 'direct must be a boolean')
  }
  try {
    let direct = null
    if (deps.directContainerPreview && value.direct !== false) {
      try {
        direct = await deps.directContainerPreview.issue(
          BigInt(user.id),
          value.url,
          value.viewport as Partial<ContainerPreviewViewport> | undefined,
        )
      } catch (err) {
        _ctx.log.warn('container_preview_direct_issue_failed', {
          error: (err as Error)?.message ?? String(err),
        })
      }
    }
    // Mint the 30-second legacy ticket last so the direct tunnel startup time
    // does not eat the fallback window.
    const issued = deps.containerPreviewTickets.issue(
      BigInt(user.id),
      value.url,
      value.viewport as Partial<ContainerPreviewViewport> | undefined,
    )
    sendJson(res, 201, {
      ticket: issued.ticket,
      expiresAt: issued.expiresAt,
      url: issued.url,
      viewport: issued.viewport,
      protocol: 'preview-v1',
      ...(direct ? { direct } : {}),
    })
  } catch (err) {
    throw new HttpError(
      400,
      'INVALID_PREVIEW_URL',
      (err as Error)?.message ?? 'invalid preview URL',
    )
  }
}

export async function handleHeartbeatContainerPreview(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  if (!deps.directContainerPreview || !deps.v3Supervisor) {
    throw new HttpError(503, 'PREVIEW_UNAVAILABLE', '网页预览暂不可用')
  }
  const user = await requireAuth(req, deps.jwtSecret)
  if (!(await requireActiveAccountVerifyDb(user.id, ['user', 'admin'], deps.v3Supervisor.pool))) {
    throw new HttpError(403, 'FORBIDDEN', 'account is not allowed to use a container preview')
  }
  const sessionId = await readDirectSessionId(req)
  if (!deps.directContainerPreview.heartbeat(BigInt(user.id), sessionId)) {
    throw new HttpError(404, 'PREVIEW_NOT_FOUND', '网页预览已结束')
  }
  sendJson(res, 200, { ok: true })
}

export async function handleRevokeContainerPreview(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  if (!deps.directContainerPreview || !deps.v3Supervisor) {
    throw new HttpError(503, 'PREVIEW_UNAVAILABLE', '网页预览暂不可用')
  }
  const user = await requireAuth(req, deps.jwtSecret)
  if (!(await requireActiveAccountVerifyDb(user.id, ['user', 'admin'], deps.v3Supervisor.pool))) {
    throw new HttpError(403, 'FORBIDDEN', 'account is not allowed to use a container preview')
  }
  const sessionId = await readDirectSessionId(req)
  await deps.directContainerPreview.revoke(BigInt(user.id), sessionId)
  // Idempotent from the browser's perspective: a stale cleanup request must
  // not turn modal close/fallback into a user-visible error.
  sendJson(res, 200, { ok: true })
}

async function readDirectSessionId(req: IncomingMessage): Promise<string> {
  const body = await readJsonBody(req)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'VALIDATION', 'object body required')
  }
  const sessionId = (body as Record<string, unknown>).sessionId
  if (typeof sessionId !== 'string' || !/^[0-9a-f]{32}$/.test(sessionId)) {
    throw new HttpError(400, 'VALIDATION', 'valid sessionId is required')
  }
  return sessionId
}
