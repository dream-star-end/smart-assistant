import type { IncomingMessage, ServerResponse } from 'node:http'

import type { ContainerPreviewViewport } from '@openclaude/protocol'

import { requireAuth } from './auth.js'
import type { CommercialHttpDeps, RequestContext } from './handlers.js'
import { requireUserVerifyDb } from './requireUser.js'
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
  if (user.role !== 'user' || !(await requireUserVerifyDb(user.id, deps.v3Supervisor.pool))) {
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
  try {
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
    })
  } catch (err) {
    throw new HttpError(
      400,
      'INVALID_PREVIEW_URL',
      (err as Error)?.message ?? 'invalid preview URL',
    )
  }
}
