/**
 * Admin HTTP endpoints for `remote-driver-v4` commissioning, cutover, budget policy,
 * reverification, and legacy rollback (`OCV5-749`, R12). Restricted strictly to `uid = 3`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { writeAdminAuditBestEffort } from '../../admin/audit.js'
import { requireAdminVerifyDb } from '../../admin/requireAdmin.js'
import type { CommercialHttpDeps, RequestContext } from '../handlers.js'
import { HttpError, readJsonBody, sendJson } from '../util.js'

const UUID_RE = /^[a-f0-9-]{36}$/i

export async function handleAdminRemoteDriverV4(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret)
  if (String(admin.id) !== '3') {
    throw new HttpError(
      403,
      'FORBIDDEN',
      'remote-driver-v4 commissioning is restricted to selfhost admin uid3',
    )
  }
  const service = deps.remoteDriverV4
  if (!service) {
    throw new HttpError(
      503,
      'UNAVAILABLE',
      'remote-driver-v4 commissioning requires the selfhost master with signed model authority',
    )
  }

  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  const base = '/api/admin/remote-pool/driver-v4'
  if (!pathname.startsWith(base)) {
    throw new HttpError(404, 'NOT_FOUND', 'unknown remote-driver-v4 path')
  }
  const suffix = pathname.slice(base.length)

  try {
    let result: unknown
    let statusCode = 200
    let targetId = 'policy'
    let action = suffix.replace(/^\//, '') || 'unknown'

    if (req.method === 'GET' && suffix === '/policy') {
      result = await service.getPolicy()
      action = 'policy.get'
    } else if (req.method === 'POST' && suffix === '/policy') {
      const body = (await readJsonBody(req)) as Record<string, unknown>
      result = await service.updatePolicy(body, Number(admin.id))
      action = 'policy.set'
    } else if (req.method === 'POST' && suffix === '/cutover') {
      const body = (await readJsonBody(req)) as Record<string, unknown>
      if (!body || typeof body.profileId !== 'string' || !UUID_RE.test(body.profileId)) {
        throw new Error('REMOTE_PROFILE_ID_INVALID')
      }
      targetId = body.profileId
      action = 'cutover'
      statusCode = 202
      result = await service.startCutover(
        {
          profileId: body.profileId,
          ...(typeof body.driverId === 'string' ? { driverId: body.driverId } : {}),
          ...(typeof body.deadlineMs === 'number' ? { deadlineMs: body.deadlineMs } : {}),
          ...(typeof body.maxCreditsPerRun === 'number'
            ? { maxCreditsPerRun: body.maxCreditsPerRun }
            : {}),
          ...(typeof body.maxCreditsPerDay === 'number'
            ? { maxCreditsPerDay: body.maxCreditsPerDay }
            : {}),
        },
        Number(admin.id),
      )
    } else if (req.method === 'POST' && suffix === '/reverify') {
      const body = (await readJsonBody(req)) as Record<string, unknown>
      if (!body || typeof body.profileId !== 'string' || !UUID_RE.test(body.profileId)) {
        throw new Error('REMOTE_PROFILE_ID_INVALID')
      }
      targetId = body.profileId
      action = 'reverify'
      statusCode = 202
      result = await service.startReverify(
        {
          profileId: body.profileId,
          ...(typeof body.deadlineMs === 'number' ? { deadlineMs: body.deadlineMs } : {}),
          ...(typeof body.maxCreditsPerRun === 'number'
            ? { maxCreditsPerRun: body.maxCreditsPerRun }
            : {}),
          ...(typeof body.maxCreditsPerDay === 'number'
            ? { maxCreditsPerDay: body.maxCreditsPerDay }
            : {}),
        },
        Number(admin.id),
      )
    } else if (req.method === 'POST' && suffix === '/revert') {
      const body = (await readJsonBody(req)) as Record<string, unknown>
      if (!body || typeof body.profileId !== 'string' || !UUID_RE.test(body.profileId)) {
        throw new Error('REMOTE_PROFILE_ID_INVALID')
      }
      targetId = body.profileId
      action = 'revert'
      result = await service.revertToLegacy(body.profileId)
    } else if (req.method === 'GET' && suffix.startsWith('/jobs/')) {
      const jobId = suffix.slice('/jobs/'.length)
      if (!jobId) throw new HttpError(404, 'NOT_FOUND', 'missing job id')
      const job = service.getJobStatus(jobId)
      if (!job) throw new HttpError(404, 'NOT_FOUND', 'job not found')
      targetId = job.profileId
      action = 'job.status'
      result = job
    } else if (req.method === 'GET' && suffix.startsWith('/profiles/')) {
      const profileId = suffix.slice('/profiles/'.length)
      if (!UUID_RE.test(profileId)) throw new Error('REMOTE_PROFILE_ID_INVALID')
      targetId = profileId
      action = 'profile.status'
      result = await service.getProfileStatus(profileId)
    } else {
      throw new HttpError(404, 'NOT_FOUND', 'unknown remote-driver-v4 action')
    }

    await writeAdminAuditBestEffort(
      { adminId: admin.id, ip: ctx.clientIp, userAgent: ctx.userAgent },
      'remote_pool.driver_v4_commissioning',
      targetId,
      null,
      { method: req.method, action },
    )
    sendJson(res, statusCode, result)
  } catch (err) {
    if (err instanceof HttpError) throw err
    throw new HttpError(
      409,
      'CONFLICT',
      err instanceof Error && /^REMOTE_[A-Z0-9_]+$/.test(err.message)
        ? err.message
        : 'REMOTE_DRIVER_V4_COMMISSION_REJECTED',
    )
  }
}
