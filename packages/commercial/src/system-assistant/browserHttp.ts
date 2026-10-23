/** First-party browser surface. Container relay never receives these handlers or credentials. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { SystemActionError } from '@openclaude/storage'
import type { QueryRunner } from '../db/queries.js'
import { requireAuth } from '../http/auth.js'
import { HttpError, readJsonBody, sendJson } from '../http/util.js'
import { requireBrowserConfirmationPrincipal } from '../auth/browserConfirmation.js'
import { SystemOperationRejected } from './operations.js'
import type { SystemActionsService } from './service.js'

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
const readPath = new RegExp(`^/api/me/system-actions/(${UUID})(/result)?$`)
const writePath = new RegExp(`^/api/auth/system-actions/(${UUID})/(challenge|confirm|deny)$`)
const challengeSchema = z.object({ deviceId: z.string().uuid(), previewHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const confirmSchema = challengeSchema.extend({ nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict()
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw)
  if (!result.success) throw new HttpError(400, 'INVALID_INPUT', '请重新打开确认。')
  return result.data
}
export interface SystemActionsBrowserHttpDeps {
  service: SystemActionsService
  jwtSecret: string | Uint8Array
  firstPartyOrigin: string | null
  runner: QueryRunner
}
export function makeSystemActionsBrowserHandler(deps: SystemActionsBrowserHttpDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const path = new URL(req.url ?? '/', 'http://system-actions.invalid').pathname
    const read = readPath.exec(path)
    const write = writePath.exec(path)
    if (!read && !write) throw new HttpError(404, 'NOT_FOUND', '操作不存在。')
    try {
      if (read) {
        if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'GET required')
        const user = await requireAuth(req, deps.jwtSecret)
        const active = await deps.runner.query<{ role: string }>("SELECT role FROM users WHERE id=$1 AND status='active'", [user.id])
        if (active.rows[0]?.role !== user.role) throw new HttpError(403, 'FORBIDDEN', '请重新登录后查看。')
        sendJson(res, 200, read[2] ? deps.service.result(user.id, read[1]!) : deps.service.detail(user.id, read[1]!))
        return
      }
      if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'POST required')
      // Origin / Fetch Metadata / independent HttpOnly refresh proof are checked on every POST.
      const principal = await requireBrowserConfirmationPrincipal(req, deps)
      const body = await readJsonBody(req, 16 * 1024)
      const id = write![1]!
      const action = write![2]!
      if (action === 'deny') {
        parse(z.object({}).strict(), body)
        sendJson(res, 200, deps.service.deny(principal, id))
        return
      }
      // Browser/control executors require their own claim and receipt adapters before exposure.
      if (deps.service.detail(principal.id, id).executor !== 'master') throw new HttpError(503, 'UNAVAILABLE', '此操作尚不能在当前设备执行。')
      if (action === 'challenge') {
        const input = parse(challengeSchema, body)
        sendJson(res, 200, deps.service.challenge(principal, id, input.deviceId, input.previewHash))
      } else {
        sendJson(res, 200, await deps.service.confirm(principal, id, parse(confirmSchema, body)))
      }
    } catch (e) {
      if (e instanceof SystemActionError) {
        const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'INVALID_INPUT' ? 400 : 409
        throw new HttpError(status, e.code, e.code === 'RECONCILIATION_REQUIRED' ? '执行结果待核对，请勿重复执行。' : '操作不可用或状态已变化，请刷新查看。')
      }
      if (e instanceof SystemOperationRejected) throw new HttpError(
        e.code === 'FORBIDDEN' ? 403 : e.code === 'INVALID_INPUT' ? 400 : e.code === 'UNAVAILABLE' ? 503 : 409,
        e.code, '操作不可用或权限已变化，请刷新查看。')
      throw e
    }
  }
}

/** Router adapter retains its common maintenance, request-id and error handling. */
export async function dispatchSystemActionsBrowserRoute(
  req: IncomingMessage, res: ServerResponse,
  _ctx: import('../http/handlers.js').RequestContext,
  deps: import('../http/handlers.js').CommercialHttpDeps,
): Promise<void> {
  if (!deps.systemActionsHttp) throw new HttpError(503, 'UNAVAILABLE', '系统操作暂不可用。')
  await deps.systemActionsHttp(req, res)
}
