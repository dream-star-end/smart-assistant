/** Exact admin-only, default-OFF task endpoint. It never invokes public registration or login. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Cc5TestUserError, createCc5UnverifiedTestUser } from '../../admin/cc5TestUser.js'
import { requireAdminVerifyDb } from '../../admin/requireAdmin.js'
import { type FlavorIdentity, assertFlavorIdentity } from '../../flavor/assertFlavor.js'
import { getRuntimeChannel } from '../../runtimeChannel.js'
import type { CommercialHttpDeps, RequestContext } from '../handlers.js'
import { HttpError, readJsonBody, sendJson } from '../util.js'

export async function handleAdminCreateCc5TestUser(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
  /** Test-only identity probe. The production router always omits this argument. */
  identityProbe: () => FlavorIdentity = assertFlavorIdentity,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret)
  if (
    process.env.OC_SELFHOST_CC5_T1555U_ADMIN_CREATE_ENABLED !== '1' ||
    getRuntimeChannel() !== 'v5'
  ) {
    throw new HttpError(404, 'NOT_FOUND', 'endpoint unavailable')
  }
  let selfhost = false
  try {
    const identity = identityProbe()
    selfhost = identity.status === 'ok' && identity.flavor === 'selfhost'
  } catch {
    /* fail closed */
  }
  if (!selfhost) throw new HttpError(404, 'NOT_FOUND', 'endpoint unavailable')
  const body = await readJsonBody(req, 1024)
  try {
    const result = await createCc5UnverifiedTestUser(body, {
      adminId: admin.id,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    })
    sendJson(res, 201, result)
  } catch (error) {
    const code = error instanceof Cc5TestUserError ? error.code : 'FAILED'
    if (code === 'VALIDATION')
      throw new HttpError(400, 'VALIDATION', 'only a valid password is accepted')
    if (code === 'CONFLICT')
      throw new HttpError(
        409,
        'CONFLICT',
        'test account already exists; inspect the audited admin record',
      )
    throw new HttpError(500, 'INTERNAL', 'test account creation failed')
  }
}
