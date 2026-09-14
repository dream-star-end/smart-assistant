import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DelegateJobStore } from './delegateJobs.js'
import type { DelegateFailureCursor } from './delegateDurable.js'

/** New user APIs, not the native receipt or CLI-consumed protocol. */
export const DELEGATE_USER_PREFIX = '/api/delegates/'
export type DelegateUserHttpDeps = {
  user: () => string | null
  store: () => DelegateJobStore | undefined
  readBody: (req: IncomingMessage) => Promise<string>
  reconcileLifecycle: (userId: string, authorize: () => void) => Promise<boolean>
  send: (res: ServerResponse, status: number, value: unknown) => void
}
function cursor(raw: string | null): DelegateFailureCursor | undefined {
  if (raw === null) return undefined
  if (!raw || raw.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw Error('invalid cursor')
  const value: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'failedAt,generation,jobId') throw Error('invalid cursor')
  const v = value as DelegateFailureCursor
  if (!Number.isSafeInteger(v.failedAt) || v.failedAt < 0 || !Number.isSafeInteger(v.generation) || v.generation < 0 ||
      typeof v.jobId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(v.jobId)) throw Error('invalid cursor')
  return v
}
export async function handleDelegateUserHttp(req: IncomingMessage, res: ServerResponse, url: URL, deps: DelegateUserHttpDeps): Promise<void> {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Vary', 'Authorization, Cookie')
  const error = (status: number, code: string) => deps.send(res, status, { error: code })
  const userId = deps.user()
  if (!userId) return error(401, 'user_authentication_required')
  const ack = /^\/api\/delegates\/inbox\/([A-Za-z0-9_-]{1,128})\/ack$/.exec(url.pathname)
  const read = url.pathname === DELEGATE_USER_PREFIX + 'inbox' || url.pathname === DELEGATE_USER_PREFIX + 'summary'
  if (!ack && !read) return error(404, 'not_found')
  if ((ack && req.method !== 'POST') || (read && req.method !== 'GET')) return error(405, 'method_not_allowed')
  let generation: number | undefined, options: { limit?: number; before?: DelegateFailureCursor } = {}
  try {
    if (ack) {
      if (url.search) throw Error('unexpected query')
      const body: unknown = JSON.parse(await deps.readBody(req))
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join(',') !== 'generation') throw Error('invalid body')
      generation = (body as { generation: number }).generation
      if (!Number.isSafeInteger(generation) || generation < 0) throw Error('invalid generation')
    } else if (url.pathname.endsWith('/inbox')) {
      if ([...url.searchParams.keys()].some(key => !['limit', 'before'].includes(key)) ||
          url.searchParams.getAll('limit').length > 1 || url.searchParams.getAll('before').length > 1) throw Error('invalid query')
      const limit = url.searchParams.get('limit')
      if (limit !== null && (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 50)) throw Error('invalid limit')
      options = { ...(limit === null ? {} : { limit: Number(limit) }), before: cursor(url.searchParams.get('before')) }
    } else if (url.search) throw Error('unexpected query')
  } catch { return error(400, 'invalid_request') }
  // Body/storage awaits cannot turn an expired credential into legacy default.
  if (deps.user() !== userId) return error(401, 'user_authentication_expired')
  const store = deps.store()
  if (!store) return error(503, 'delegate_user_surface_unavailable')
  try {
    const authorize = () => { if (deps.user() !== userId) throw new Error('delegate user expired') }
    const complete = await deps.reconcileLifecycle(userId, authorize)
    if (deps.user() !== userId) return error(401, 'user_authentication_expired')
    if (!complete) return error(503, 'delegate_user_lifecycle_pending')
    if (ack) {
      const ok = store.acknowledgeUserFailure(userId, ack[1], generation!)
      return ok ? deps.send(res, 200, { version: 1, acknowledged: true }) : error(404, 'not_found')
    }
    if (url.pathname.endsWith('/summary')) return deps.send(res, 200, { version: 1, available: true, ...store.userSummary(userId) })
    const page = store.userFailureInbox(userId, options)
    deps.send(res, 200, { version: 1, count: page.count,
      nextCursor: page.nextCursor ? Buffer.from(JSON.stringify(page.nextCursor)).toString('base64url') : null,
      items: page.items.map(row => ({ jobId: row.jobId, generation: row.generation, parentSessionKey: row.parentSession,
        summaryCode: row.summaryCode, summaryText: row.summaryText, failedAt: row.failedAt,
        // Retry is unavailable until the complete durable source/action path is wired.
        retry: { available: false, reason: 'retry_not_ready' } })) })
  } catch { return error(deps.user() !== userId ? 401 : 503,
    deps.user() !== userId ? 'user_authentication_expired' : 'delegate_user_surface_unavailable') }
}
