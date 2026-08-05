import { createHmac, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ContainerIdentityRepo } from '../auth/containerIdentity.js'
import { ContainerIdentityError, verifyContainerIdentity } from '../auth/containerIdentity.js'
import { requireAuth } from '../http/auth.js'
import type { RequestContext } from '../http/handlers.js'
import {
  HttpError,
  REQUEST_ID_HEADER,
  ensureRequestId,
  readJsonBody,
  sendError,
  sendJson,
  setSecurityHeaders,
} from '../http/util.js'
import type { MediaGenerationService } from './service.js'

// Container-facing user operation: use the ordinary /internal/v3 namespace so
// the split egress forwards it; /internal/v5/* is reserved for control-plane calls.
export const MEDIA_GENERATION_INTERNAL_PREFIX = '/internal/v3/media-generation'
export const MEDIA_GENERATION_BROWSER_PREFIX = '/api/media-generation'
const RESULT_TICKET_TTL_SECONDS = 15 * 60

type ResultTicketPayload = { userId: string; jobId: string; expiresAt: number }

export function createMediaResultTicket(
  secret: string | Uint8Array,
  userId: string,
  jobId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const payload = Buffer.from(
    JSON.stringify({ userId, jobId, expiresAt: nowSeconds + RESULT_TICKET_TTL_SECONDS }),
  ).toString('base64url')
  const signature = createHmac('sha256', secret)
    .update(`openclaude-media-result:${payload}`)
    .digest('base64url')
  return `${payload}.${signature}`
}

export function verifyMediaResultTicket(
  secret: string | Uint8Array,
  token: string,
  jobId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  if (token.length > 2048)
    throw new HttpError(401, 'INVALID_RESULT_TICKET', 'invalid result ticket')
  const [payload, signature, extra] = token.split('.')
  if (!payload || !signature || extra)
    throw new HttpError(401, 'INVALID_RESULT_TICKET', 'invalid result ticket')
  const expected = createHmac('sha256', secret)
    .update(`openclaude-media-result:${payload}`)
    .digest('base64url')
  const supplied = Buffer.from(signature, 'utf8')
  const canonical = Buffer.from(expected, 'utf8')
  if (supplied.length !== canonical.length || !timingSafeEqual(supplied, canonical))
    throw new HttpError(401, 'INVALID_RESULT_TICKET', 'invalid result ticket')
  let value: ResultTicketPayload
  try {
    value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ResultTicketPayload
  } catch {
    throw new HttpError(401, 'INVALID_RESULT_TICKET', 'invalid result ticket')
  }
  if (
    typeof value.userId !== 'string' ||
    value.jobId !== jobId ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= nowSeconds
  )
    throw new HttpError(401, 'INVALID_RESULT_TICKET', 'invalid result ticket')
  return value.userId
}

export interface MediaGenerationInternalDeps {
  identityRepo: ContainerIdentityRepo
  service: MediaGenerationService
}

export type MediaGenerationInternalHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { hostUuid: string; boundIp: string },
) => Promise<void>

function bodyRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_body')
  return value as Record<string, unknown>
}

function mapError(error: unknown): HttpError {
  const code = error instanceof Error ? error.message : String(error)
  if (code === 'media_generation_not_configured')
    return new HttpError(
      503,
      'MEDIA_GENERATION_NOT_CONFIGURED',
      'video generation is not configured',
    )
  if (code === 'media_generation_not_enabled')
    return new HttpError(
      403,
      'MEDIA_GENERATION_NOT_ENABLED',
      'video generation is not enabled for this account',
    )
  if (code === 'project_not_found' || code === 'shot_not_found')
    return new HttpError(404, 'NOT_FOUND', 'video project not found')
  if (code === 'project_revision_conflict')
    return new HttpError(
      409,
      'PROJECT_REVISION_CONFLICT',
      'video project changed; refresh and retry',
    )
  if (code.endsWith('_idempotency_conflict') || code === 'compose_job_conflict') {
    return new HttpError(
      409,
      'IDEMPOTENCY_CONFLICT',
      'request id was already used for different video parameters',
    )
  }
  if (
    code === 'project_not_ready' ||
    code === 'project_not_started' ||
    code === 'project_already_started' ||
    code === 'project_canceled' ||
    code === 'shot_not_stale'
  )
    return new HttpError(409, 'PROJECT_NOT_READY', 'video project is not ready for this operation')
  if (
    code === 'media_input_file_quota_exceeded' ||
    code === 'media_input_user_quota_exceeded' ||
    code === 'input_size_exceeded'
  )
    return new HttpError(413, 'MEDIA_INPUT_TOO_LARGE', code)
  if (
    code === 'media_input_not_found' ||
    code.startsWith('duplicate_') ||
    code.includes('required') ||
    code.startsWith('invalid_') ||
    code.includes('integrity') ||
    code === 'steps_exceed_worker_contract'
  ) {
    return new HttpError(400, 'BAD_REQUEST', code)
  }
  return new HttpError(500, 'INTERNAL', 'video generation operation failed')
}

async function sendResult(
  req: IncomingMessage,
  res: ServerResponse,
  service: MediaGenerationService,
  userId: string,
  jobId: string,
): Promise<void> {
  const result = await service.result(userId, jobId)
  if (!result) throw new HttpError(404, 'RESULT_NOT_FOUND', 'video result is not available')
  const file = await stat(result.path)
  if (!file.isFile() || file.size !== result.size)
    throw new HttpError(409, 'RESULT_INTEGRITY_FAILED', 'video result is unavailable')
  const range = req.headers.range
  let start = 0
  let end = file.size - 1
  let status = 200
  if (typeof range === 'string') {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!match) throw new HttpError(416, 'INVALID_RANGE', 'invalid byte range')
    if (match[1]) start = Number(match[1])
    if (match[2]) end = Number(match[2])
    if (!match[1] && match[2]) {
      const suffix = Number(match[2])
      start = Math.max(0, file.size - suffix)
      end = file.size - 1
    }
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end >= file.size
    ) {
      res.setHeader('Content-Range', `bytes */${file.size}`)
      throw new HttpError(416, 'INVALID_RANGE', 'invalid byte range')
    }
    status = 206
    res.setHeader('Content-Range', `bytes ${start}-${end}/${file.size}`)
  }
  res.statusCode = status
  res.setHeader('Content-Type', 'video/mp4')
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Content-Length', String(end - start + 1))
  res.setHeader('Content-Disposition', `inline; filename="openclaude-video-${jobId}.mp4"`)
  res.setHeader('X-Content-SHA256', result.sha256)
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(result.path, { start, end })
    stream.on('error', reject)
    res.on('close', resolve)
    res.on('finish', resolve)
    stream.pipe(res)
  })
}

async function dispatchForUser(
  req: IncomingMessage,
  res: ServerResponse,
  service: MediaGenerationService,
  userId: string,
  prefix: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'x.invalid'}`)
  const path = url.pathname.slice(prefix.length) || '/'
  const method = req.method ?? 'GET'

  if (method === 'GET' && path === '/capabilities') {
    sendJson(res, 200, await service.capabilities(userId))
    return
  }
  if (method === 'PUT' && path === '/inputs') {
    const size = Number(req.headers['x-content-size'])
    const input = await service.ingestInput(userId, req, {
      kind: String(req.headers['x-input-kind'] ?? ''),
      filename: String(req.headers['x-input-filename'] ?? 'input.bin'),
      mime: String(req.headers['content-type'] ?? 'application/octet-stream').split(';', 1)[0]!,
      sha256: String(req.headers['x-content-sha256'] ?? '').toLowerCase(),
      size,
    })
    sendJson(res, 201, {
      inputId: input.id,
      sha256: input.sha256,
      size: input.sizeBytes,
      kind: input.kind,
    })
    return
  }
  if (method === 'POST' && path === '/jobs') {
    sendJson(res, 202, {
      job: await service.createJob(userId, bodyRecord(await readJsonBody(req))),
    })
    return
  }
  if (method === 'GET' && path === '/jobs') {
    const pageSize = url.searchParams.has('pageSize')
      ? Number(url.searchParams.get('pageSize'))
      : undefined
    sendJson(
      res,
      200,
      await service.listJobDtos(userId, url.searchParams.get('cursor') ?? undefined, pageSize),
    )
    return
  }
  const job = /^\/jobs\/([0-9a-f-]{36})(?:\/(cancel|result))?$/.exec(path)
  if (job && method === 'GET' && !job[2]) {
    const value = await service.getJobDto(userId, job[1]!)
    if (!value) throw new HttpError(404, 'NOT_FOUND', 'video job not found')
    sendJson(res, 200, { job: value })
    return
  }
  if (job && method === 'POST' && job[2] === 'cancel') {
    const value = await service.cancelJob(userId, job[1]!)
    if (!value) throw new HttpError(404, 'NOT_FOUND', 'video job not found')
    sendJson(res, 200, { job: value })
    return
  }
  if (job && method === 'GET' && job[2] === 'result') {
    await sendResult(req, res, service, userId, job[1]!)
    return
  }
  if (method === 'POST' && path === '/projects') {
    sendJson(res, 201, {
      project: await service.createVideoProject(userId, bodyRecord(await readJsonBody(req))),
    })
    return
  }
  if (method === 'GET' && path === '/projects') {
    const pageSize = url.searchParams.has('pageSize')
      ? Number(url.searchParams.get('pageSize'))
      : undefined
    sendJson(
      res,
      200,
      await service.listProjectDtos(userId, url.searchParams.get('cursor') ?? undefined, pageSize),
    )
    return
  }
  const project = /^\/projects\/([0-9a-f-]{36})(?:\/(edit|start|render|cancel))?$/.exec(path)
  if (project && method === 'GET' && !project[2]) {
    const value = await service.projectDto(userId, project[1]!)
    if (!value) throw new HttpError(404, 'NOT_FOUND', 'video project not found')
    sendJson(res, 200, { project: value })
    return
  }
  if (project && method === 'POST' && project[2] === 'render') {
    sendJson(res, 202, {
      job: await service.renderProject(userId, project[1]!, bodyRecord(await readJsonBody(req))),
    })
    return
  }
  if (project && method === 'POST' && project[2] === 'edit') {
    sendJson(res, 200, {
      project: await service.editVideoProject(
        userId,
        project[1]!,
        bodyRecord(await readJsonBody(req)),
      ),
    })
    return
  }
  if (project && method === 'POST' && project[2] === 'start') {
    const body = bodyRecord(await readJsonBody(req))
    sendJson(res, 202, {
      project: await service.startVideoProject(userId, project[1]!, Number(body.expectedRev)),
    })
    return
  }
  if (project && method === 'POST' && project[2] === 'cancel') {
    const body = bodyRecord(await readJsonBody(req))
    await service.cancelVideoProject(userId, project[1]!, Number(body.expectedRev))
    sendJson(res, 200, { ok: true })
    return
  }
  const shot = /^\/projects\/([0-9a-f-]{36})\/shots\/([0-9a-f-]{36})\/(regenerate|accept)$/.exec(
    path,
  )
  if (shot && method === 'POST' && shot[3] === 'regenerate') {
    sendJson(res, 202, {
      job: await service.regenerateProjectShot(
        userId,
        shot[1]!,
        shot[2]!,
        bodyRecord(await readJsonBody(req)),
      ),
    })
    return
  }
  if (shot && method === 'POST' && shot[3] === 'accept') {
    const body = bodyRecord(await readJsonBody(req))
    await service.acceptProjectShot(userId, shot[1]!, shot[2]!, Number(body.expectedRev))
    sendJson(res, 200, { ok: true })
    return
  }
  throw new HttpError(404, 'NOT_FOUND', 'video generation route not found')
}

export function makeMediaGenerationInternalHandler(
  deps: MediaGenerationInternalDeps,
): MediaGenerationInternalHandler {
  return async (req, res, ctx) => {
    setSecurityHeaders(res)
    const requestId = ensureRequestId(req)
    res.setHeader(REQUEST_ID_HEADER, requestId)
    try {
      const identity = await verifyContainerIdentity(
        deps.identityRepo,
        ctx,
        req.headers.authorization,
      )
      await dispatchForUser(
        req,
        res,
        deps.service,
        String(identity.userId),
        MEDIA_GENERATION_INTERNAL_PREFIX,
      )
    } catch (error) {
      const mapped =
        error instanceof ContainerIdentityError
          ? new HttpError(401, 'UNAUTHORIZED', 'container identity verification failed')
          : error instanceof HttpError
            ? error
            : mapError(error)
      sendError(res, mapped.status, mapped.code, mapped.message, requestId)
    }
  }
}

export interface MediaGenerationBrowserDeps {
  jwtSecret: string | Uint8Array
  mediaGeneration?: MediaGenerationService
}

export async function dispatchMediaGenerationRoute(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: MediaGenerationBrowserDeps,
): Promise<void> {
  if (!deps.mediaGeneration)
    throw new HttpError(
      503,
      'MEDIA_GENERATION_NOT_CONFIGURED',
      'video generation is not configured',
    )
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'x.invalid'}`)
  const resultPath = /^\/api\/media-generation\/jobs\/([0-9a-f-]{36})\/result$/.exec(url.pathname)
  const ticket = url.searchParams.get('ticket')
  if (req.method === 'GET' && resultPath && ticket) {
    const userId = verifyMediaResultTicket(deps.jwtSecret, ticket, resultPath[1]!)
    await dispatchForUser(req, res, deps.mediaGeneration, userId, MEDIA_GENERATION_BROWSER_PREFIX)
    return
  }
  const user = await requireAuth(req, deps.jwtSecret)
  const ticketPath = /^\/api\/media-generation\/jobs\/([0-9a-f-]{36})\/result-ticket$/.exec(
    url.pathname,
  )
  if (req.method === 'POST' && ticketPath) {
    const result = await deps.mediaGeneration.result(user.id, ticketPath[1]!)
    if (!result) throw new HttpError(404, 'RESULT_NOT_FOUND', 'video result is not available')
    const signed = createMediaResultTicket(deps.jwtSecret, user.id, ticketPath[1]!)
    sendJson(res, 200, {
      url: `${MEDIA_GENERATION_BROWSER_PREFIX}/jobs/${ticketPath[1]}/result?ticket=${encodeURIComponent(signed)}`,
      expiresInSeconds: RESULT_TICKET_TTL_SECONDS,
    })
    return
  }
  try {
    await dispatchForUser(req, res, deps.mediaGeneration, user.id, MEDIA_GENERATION_BROWSER_PREFIX)
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw mapError(error)
  }
}
