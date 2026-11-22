/**
 * Commercial master proxy & aggregation routes for session background tasks (OCV5-844):
 *   - GET  `/api/sessions/:id/background-tasks`
 *   - GET  `/api/sessions/:id/inflight-delegates`
 *   - POST `/api/sessions/:id/inflight-delegates/:jobId/cancel`
 *   - POST `/api/sessions/:id/muse-jobs/:jobId/cancel`
 *   - POST `/api/sessions/:id/bg-commands/:jobId/cancel`
 *
 * Security & availability invariants:
 *   1. Authenticates caller via Bearer JWT or `oc_session` cookie + active account check (401/403).
 *   2. Verifies `sessionId` ownership in PG `client_sessions` (`403 FORBIDDEN` for another user's
 *      session, `404 NOT_FOUND` if missing/deleted).
 *   3. NEVER wakes a sleeping container: inspects `getV3ContainerStatus` first and only dials the
 *      container when `status.state === 'running'`, with short fail-open timeouts on read routes.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  INTERNAL_SWARM_USER_ID_HEADER,
  SESSION_BG_COMMAND_ID_RE,
} from '@openclaude/gateway'
import { getV3ContainerStatus, type V3ContainerStatus } from '../agent-sandbox/v3supervisor.js'
import { getPool } from '../db/index.js'
import type { MuseSessionJobView } from '../muse/hub.js'
import { MASTER_USER_PREFIX } from '../wechat/userIds.js'
import { authenticateActiveCommercialUser } from './activeUserAuth.js'
import {
  ContainerInternalRequestError,
  requestUserContainerInternal,
  type ContainerInternalClientDeps,
} from './containerInternalClient.js'
import {
  delegateInflightSurfaceAdvertised,
  type CommercialHttpDeps,
  type RequestContext,
} from './handlers.js'
import { HttpError, sendJson } from './util.js'

const SESSION_BG_TASKS_ROUTE_RE = /^\/api\/sessions\/([^/]+)\/background-tasks$/
const SESSION_INFLIGHT_DELEGATES_ROUTE_RE = /^\/api\/sessions\/([^/]+)\/inflight-delegates$/
const SESSION_DELEGATE_CANCEL_ROUTE_RE =
  /^\/api\/sessions\/([^/]+)\/inflight-delegates\/([^/]+)\/cancel$/
const SESSION_MUSE_CANCEL_ROUTE_RE = /^\/api\/sessions\/([^/]+)\/muse-jobs\/([^/]+)\/cancel$/
const SESSION_BG_CMD_CANCEL_ROUTE_RE = /^\/api\/sessions\/([^/]+)\/bg-commands\/([^/]+)\/cancel$/

const SAFE_SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const SAFE_DELEGATE_JOB_ID_RE = /^[A-Za-z0-9._:-]{1,180}$/
const SAFE_MUSE_JOB_ID_RE = /^mj_[0-9a-f-]{36}$/

const CONTAINER_READ_CONNECT_MS = 1_500
const CONTAINER_READ_IDLE_MS = 3_000
const CONTAINER_CONTROL_CONNECT_MS = 2_000
const CONTAINER_CONTROL_IDLE_MS = 5_000

export interface CommercialSessionBackgroundTasksDeps {
  /** Test seam: override PG session ownership lookup ('owner' | 'forbidden' | 'not_found'). */
  verifySessionOwnership?: (
    userId: string,
    sessionId: string,
  ) => Promise<'owner' | 'forbidden' | 'not_found'>
  /** Test seam: override container status lookup without PG/Docker. */
  getContainerStatus?: (uid: number) => Promise<V3ContainerStatus | null>
  /** Test seam: override container internal client (e.g., loopback test container). */
  containerClientOverrides?: Partial<ContainerInternalClientDeps>
  /** Test seam: skip DB active account check in unit tests without PG. */
  skipDbActiveCheck?: boolean
  /** Test seam: override `delegateInflightSurfaceAdvertised()`. */
  isInflightSurfaceAdvertised?: () => boolean
}

export function isSessionBackgroundTasksPath(path: string): boolean {
  return (
    SESSION_BG_TASKS_ROUTE_RE.test(path) ||
    SESSION_INFLIGHT_DELEGATES_ROUTE_RE.test(path) ||
    SESSION_DELEGATE_CANCEL_ROUTE_RE.test(path) ||
    SESSION_MUSE_CANCEL_ROUTE_RE.test(path) ||
    SESSION_BG_CMD_CANCEL_ROUTE_RE.test(path)
  )
}

async function defaultVerifySessionOwnership(
  userId: string,
  sessionId: string,
  pool = getPool(),
): Promise<'owner' | 'forbidden' | 'not_found'> {
  const res = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM client_sessions WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
    [sessionId],
  )
  const row = res.rows[0]
  if (!row) return 'not_found'
  const expectedOwner = `${MASTER_USER_PREFIX}${userId}`
  if (row.user_id !== expectedOwner) return 'forbidden'
  return 'owner'
}

function decodeSegment(raw: string, code: string, label: string): string {
  let decoded = ''
  try {
    decoded = decodeURIComponent(raw).trim()
  } catch {
    throw new HttpError(400, code, `invalid ${label} encoding`)
  }
  if (!decoded) {
    throw new HttpError(400, code, `${label} required`)
  }
  return decoded
}

function parseSessionId(raw: string): string {
  const sid = decodeSegment(raw, 'INVALID_SESSION_ID', 'sessionId')
  if (!SAFE_SESSION_ID_RE.test(sid)) {
    throw new HttpError(400, 'INVALID_SESSION_ID', 'invalid sessionId')
  }
  return sid
}

async function resolveRunningContainer(
  uid: bigint,
  deps: CommercialHttpDeps,
  overrides?: CommercialSessionBackgroundTasksDeps,
): Promise<{ status: V3ContainerStatus; clientDeps: ContainerInternalClientDeps } | null> {
  if (!deps.v3Supervisor || !deps.bridgeSecret) return null
  if (uid <= 0n || uid > BigInt(Number.MAX_SAFE_INTEGER)) return null
  const uidNum = Number(uid)
  const status = overrides?.getContainerStatus
    ? await overrides.getContainerStatus(uidNum)
    : await getV3ContainerStatus(deps.v3Supervisor, uidNum)
  if (!status || status.state !== 'running') return null
  const clientDeps: ContainerInternalClientDeps = {
    v3: deps.v3Supervisor,
    bridgeSecret: deps.bridgeSecret,
    selfHostId: deps.v3Supervisor.selfHostId,
    getStatus: async () => status,
    ...overrides?.containerClientOverrides,
  }
  return { status, clientDeps }
}

interface ContainerBackgroundStatePayload {
  delegates: unknown[]
  nextCursor: string | null
  truncated: boolean
  bgCommands: unknown[]
}

async function fetchContainerBackgroundStateFailOpen(
  uid: bigint,
  sessionId: string,
  searchParams: URLSearchParams,
  deps: CommercialHttpDeps,
  overrides?: CommercialSessionBackgroundTasksDeps,
): Promise<ContainerBackgroundStatePayload> {
  const empty: ContainerBackgroundStatePayload = {
    delegates: [],
    nextCursor: null,
    truncated: false,
    bgCommands: [],
  }
  let running: { status: V3ContainerStatus; clientDeps: ContainerInternalClientDeps } | null
  try {
    running = await resolveRunningContainer(uid, deps, overrides)
  } catch {
    return empty
  }
  if (!running) return empty

  const qs = new URLSearchParams()
  const limit = searchParams.get('limit')
  const cursor = searchParams.get('cursor')
  if (limit) qs.set('limit', limit)
  if (cursor) qs.set('cursor', cursor)
  const suffix = qs.toString() ? `?${qs.toString()}` : ''

  try {
    const resp = await requestUserContainerInternal(running.clientDeps, {
      uid,
      method: 'GET',
      pathAndQuery: `/internal/sessions/${encodeURIComponent(sessionId)}/background-state${suffix}`,
      connectTimeoutMs: CONTAINER_READ_CONNECT_MS,
      idleTimeoutMs: CONTAINER_READ_IDLE_MS,
    })
    if (resp.status !== 200 || resp.body.length === 0) return empty
    const parsed = JSON.parse(resp.body.toString('utf8')) as Record<string, unknown>
    return {
      delegates: Array.isArray(parsed.delegates) ? parsed.delegates : [],
      nextCursor: typeof parsed.nextCursor === 'string' ? parsed.nextCursor : null,
      truncated: parsed.truncated === true,
      bgCommands: Array.isArray(parsed.bgCommands) ? parsed.bgCommands : [],
    }
  } catch {
    return empty
  }
}

async function forwardContainerCancel(
  uid: bigint,
  userId: string,
  pathAndQuery: string,
  deps: CommercialHttpDeps,
  overrides: CommercialSessionBackgroundTasksDeps | undefined,
  onNotRunning: () => { status: number; body: Record<string, unknown> },
  res: ServerResponse,
): Promise<void> {
  const running = await resolveRunningContainer(uid, deps, overrides)
  if (!running) {
    const fallback = onNotRunning()
    sendJson(res, fallback.status, fallback.body)
    return
  }
  try {
    const resp = await requestUserContainerInternal(running.clientDeps, {
      uid,
      method: 'POST',
      pathAndQuery,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        [INTERNAL_SWARM_USER_ID_HEADER]: userId,
      },
      body: '{}',
      connectTimeoutMs: CONTAINER_CONTROL_CONNECT_MS,
      idleTimeoutMs: CONTAINER_CONTROL_IDLE_MS,
    })
    let parsed: unknown = null
    try {
      parsed = resp.body.length > 0 ? JSON.parse(resp.body.toString('utf8')) : null
    } catch {
      parsed = null
    }
    if (parsed && typeof parsed === 'object') {
      sendJson(res, resp.status, parsed)
      return
    }
    throw new HttpError(
      resp.status >= 400 ? resp.status : 502,
      'BAD_GATEWAY',
      'invalid container response',
    )
  } catch (err) {
    if (err instanceof ContainerInternalRequestError) {
      throw new HttpError(err.httpStatus, err.code, err.message)
    }
    throw err
  }
}

export async function handleCommercialSessionBackgroundTasks(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x')
  const pathname = url.pathname
  const method = (req.method ?? 'GET').toUpperCase()
  const overrides = deps.sessionBackgroundTasksRouteDeps

  const bgTasksMatch = SESSION_BG_TASKS_ROUTE_RE.exec(pathname)
  const inflightMatch = SESSION_INFLIGHT_DELEGATES_ROUTE_RE.exec(pathname)
  const delegateCancelMatch = SESSION_DELEGATE_CANCEL_ROUTE_RE.exec(pathname)
  const museCancelMatch = SESSION_MUSE_CANCEL_ROUTE_RE.exec(pathname)
  const bgCmdCancelMatch = SESSION_BG_CMD_CANCEL_ROUTE_RE.exec(pathname)

  const expectedMethod = bgTasksMatch || inflightMatch ? 'GET' : 'POST'
  if (method !== expectedMethod) {
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', `${expectedMethod} required`, {
      extraHeaders: { Allow: expectedMethod },
    })
  }

  const user = await authenticateActiveCommercialUser(req, deps.jwtSecret, {
    pool: deps.v3Supervisor?.pool,
    verifyActiveAccount: deps.verifyActiveAccount,
    skipDbActiveCheck: overrides?.skipDbActiveCheck,
  })

  const rawSessionId =
    bgTasksMatch?.[1] ??
    inflightMatch?.[1] ??
    delegateCancelMatch?.[1] ??
    museCancelMatch?.[1] ??
    bgCmdCancelMatch?.[1]
  if (!rawSessionId) {
    throw new HttpError(404, 'NOT_FOUND', 'session background task route not found')
  }
  const sessionId = parseSessionId(rawSessionId)

  const ownership = overrides?.verifySessionOwnership
    ? await overrides.verifySessionOwnership(user.id, sessionId)
    : await defaultVerifySessionOwnership(user.id, sessionId, deps.v3Supervisor?.pool ?? getPool())
  if (ownership === 'forbidden') {
    throw new HttpError(403, 'FORBIDDEN', 'session does not belong to user')
  }
  if (ownership === 'not_found') {
    throw new HttpError(404, 'NOT_FOUND', 'session not found')
  }

  const uid = BigInt(user.id)

  if (bgTasksMatch) {
    const [museJobs, containerState] = await Promise.all([
      deps.museHub
        ? deps.museHub.listSessionJobs(user.id, sessionId).catch((): MuseSessionJobView[] => [])
        : Promise.resolve<MuseSessionJobView[]>([]),
      fetchContainerBackgroundStateFailOpen(uid, sessionId, url.searchParams, deps, overrides),
    ])
    sendJson(res, 200, {
      delegates: containerState.delegates,
      museJobs,
      bgCommands: containerState.bgCommands,
    })
    return
  }

  if (inflightMatch) {
    const advertised = overrides?.isInflightSurfaceAdvertised
      ? overrides.isInflightSurfaceAdvertised()
      : delegateInflightSurfaceAdvertised()
    if (!advertised) {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    const containerState = await fetchContainerBackgroundStateFailOpen(
      uid,
      sessionId,
      url.searchParams,
      deps,
      overrides,
    )
    sendJson(res, 200, {
      enabled: true,
      items: containerState.delegates,
      nextCursor: containerState.nextCursor,
      truncated: containerState.truncated,
    })
    return
  }

  if (delegateCancelMatch) {
    const jobId = decodeSegment(delegateCancelMatch[2]!, 'INVALID_JOB_ID', 'jobId')
    if (!SAFE_DELEGATE_JOB_ID_RE.test(jobId)) {
      throw new HttpError(400, 'INVALID_JOB_ID', 'invalid delegate jobId')
    }
    await forwardContainerCancel(
      uid,
      user.id,
      `/internal/sessions/${encodeURIComponent(sessionId)}/inflight-delegates/${encodeURIComponent(jobId)}/cancel`,
      deps,
      overrides,
      () => ({ status: 404, body: { ok: false, code: 'NOT_FOUND', error: 'delegate job not found' } }),
      res,
    )
    return
  }

  if (museCancelMatch) {
    const jobId = decodeSegment(museCancelMatch[2]!, 'INVALID_JOB_ID', 'jobId')
    if (!SAFE_MUSE_JOB_ID_RE.test(jobId)) {
      throw new HttpError(400, 'INVALID_JOB_ID', 'invalid muse jobId')
    }
    if (!deps.museHub) {
      throw new HttpError(404, 'NOT_FOUND', 'muse job not found')
    }
    const result = await deps.museHub.cancelSessionJob(user.id, sessionId, jobId)
    if (!result) {
      throw new HttpError(404, 'NOT_FOUND', 'muse job not found')
    }
    sendJson(res, 200, result)
    return
  }

  if (bgCmdCancelMatch) {
    const entryId = decodeSegment(bgCmdCancelMatch[2]!, 'INVALID_JOB_ID', 'jobId')
    if (!SESSION_BG_COMMAND_ID_RE.test(entryId)) {
      throw new HttpError(400, 'INVALID_JOB_ID', 'invalid background command id')
    }
    await forwardContainerCancel(
      uid,
      user.id,
      `/internal/sessions/${encodeURIComponent(sessionId)}/bg-commands/${encodeURIComponent(entryId)}/cancel`,
      deps,
      overrides,
      () => ({ status: 200, body: { ok: true, cancelled: false, alreadyExited: true } }),
      res,
    )
    return
  }

  throw new HttpError(404, 'NOT_FOUND', 'session background task route not found')
}
