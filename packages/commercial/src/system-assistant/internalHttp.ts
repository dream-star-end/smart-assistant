import { SYSTEM_ACTIONS_INTERNAL_PATH } from '@openclaude/protocol'
/** Container authentication + dedicated help grants. There is deliberately no execute/confirm command. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { SystemActionError } from '@openclaude/storage'
import { ContainerIdentityError, verifyContainerIdentity, type ContainerIdentity, type ContainerIdentityRepo } from '../auth/containerIdentity.js'
import type { QueryRunner } from '../db/queries.js'
import { HttpError, sendJson, setSecurityHeaders } from '../http/util.js'
import { readSystemActionBody } from './httpLifetime.js'
import { resolveCurrentSystemHelpActor } from './helpActor.js'
import { SystemHelpGrantError, type SystemHelpGrantSigner } from './helpGrant.js'
import { SystemOperationRejected } from './operations.js'
import type { SystemActionsService } from './service.js'
export const INTERNAL_SYSTEM_ACTIONS_PATH = SYSTEM_ACTIONS_INTERNAL_PATH
const token = z.string().min(1).max(4096)
const operationId = z.string().regex(/^[a-z][a-z0-9.-]{1,99}$/)
const command = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('refresh'), bootstrap: token }).strict(),
  z.object({ kind: z.literal('catalog'), grant: token, after: z.string().max(100).optional(), limit: z.number().int().min(1).max(50).optional() }).strict(),
  z.object({ kind: z.literal('read'), grant: token, operationId, args: z.unknown().optional() }).strict(),
  z.object({ kind: z.literal('prepare'), grant: token, operationId, args: z.unknown().optional(), idempotencyKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/) }).strict(),
  z.object({ kind: z.literal('result'), grant: token, proposalId: z.string().uuid() }).strict(),
])
export function makeInternalSystemActionsHandler(deps: {
  identityRepo: ContainerIdentityRepo
  runner: QueryRunner
  service: SystemActionsService
  grants: SystemHelpGrantSigner
  /** The runtime tracks the entire authentication/body/PG/business-read lifecycle before pool close. */
  track<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T>
  verify?: (req: IncomingMessage, ctx: { hostUuid: string; boundIp: string }) => Promise<ContainerIdentity>
}): (req: IncomingMessage, res: ServerResponse, ctx: { hostUuid: string; boundIp: string }) => Promise<void> {
  return async (req, res, ctx) => {
    setSecurityHeaders(res); res.setHeader('Cache-Control', 'no-store')
    if (req.method !== 'POST') { sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } }); return }
    try {
      await deps.track(async signal => {
        const identity = await (deps.verify ? deps.verify(req, ctx) : verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization))
        const parsed = command.safeParse(await readSystemActionBody(req, 4 * 1024 * 1024, signal))
        if (!parsed.success) throw new HttpError(400, 'INVALID_INPUT', '无效的系统帮助请求。')
        const input = parsed.data
        if (input.kind === 'refresh') {
          const original = deps.grants.verifyBootstrap(input.bootstrap)
          const current = await resolveCurrentSystemHelpActor(deps.runner, identity, original)
          sendJson(res, 200, deps.grants.issue(current.scope))
          return
        }
        const proof = deps.grants.verify(input.grant)
        const { actor } = await resolveCurrentSystemHelpActor(deps.runner, identity, proof, proof.securityEpoch)
        switch (input.kind) {
          case 'catalog': sendJson(res, 200, await deps.service.registry.catalog(actor, input.after, input.limit)); return
          case 'read': sendJson(res, 200, await deps.service.registry.read(actor, input.operationId, input.args === undefined ? {} : input.args)); return
          case 'prepare': sendJson(res, 200, await deps.service.prepare(actor, input.operationId, input.args === undefined ? {} : input.args, input.idempotencyKey)); return
          case 'result': sendJson(res, 200, deps.service.result(actor.userId, input.proposalId)); return
        }
      })
    } catch (e) {
      if (e instanceof ContainerIdentityError) { sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: '容器身份无法核验。' } }); return }
      if (e instanceof SystemHelpGrantError) { sendJson(res, e.code === 'UNAVAILABLE' ? 503 : 403, { error: { code: e.code, message: '当前回合的系统帮助凭证已失效，请重新核验。' } }); return }
      if (e instanceof SystemOperationRejected || e instanceof SystemActionError) {
        const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'INVALID_INPUT' ? 400 : e.code === 'FORBIDDEN' ? 403 : e.code === 'UNAVAILABLE' ? 503 : 409
        sendJson(res, status, { error: { code: e.code, message: '操作不可用或状态已变化，请重新查看。' } }); return
      }
      if (e instanceof HttpError) { sendJson(res, e.status, { error: { code: e.code, message: '系统帮助请求未完成，请重新核验。' } }); return }
      sendJson(res, 503, { error: { code: 'UNAVAILABLE', message: '系统操作暂不可用。' } })
    }
  }
}
