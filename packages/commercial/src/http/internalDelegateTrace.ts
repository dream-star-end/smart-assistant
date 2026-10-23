import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Pool } from 'pg'
import { DELEGATE_TRACE_PATH, newTraceId } from '@openclaude/protocol'
import {
  ContainerIdentityError,
  verifyContainerIdentity,
  type ContainerIdentityRepo,
} from '../auth/containerIdentity.js'
import { insertTurnTrace } from '../ws/turnTraces.js'
import type { Logger } from '../logging/logger.js'
import { rootLogger } from '../logging/logger.js'
import { setSecurityHeaders } from './util.js'

export { DELEGATE_TRACE_PATH }
const TRACE_RE = /^[0-9a-f]{32}$/

/** Observation only: no billing, permissions, admission or execution writes. */
export function makeDelegateTraceHandler(deps: {
  pool: Pool
  identityRepo: ContainerIdentityRepo
  log?: Logger
}) {
  const log = deps.log ?? rootLogger
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    ctx: { hostUuid: string; boundIp: string },
  ): Promise<void> => {
    setSecurityHeaders(res)
    const send = (status: number, body: unknown) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(JSON.stringify(body))
    }
    if (req.method !== 'POST') return send(405, { error: 'METHOD_NOT_ALLOWED' })
    let identity: Awaited<ReturnType<typeof verifyContainerIdentity>>
    try {
      identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization)
    } catch (err) {
      if (err instanceof ContainerIdentityError) return send(401, { error: 'UNAUTHORIZED' })
      throw err
    }
    let body: Record<string, unknown>
    try {
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const raw of req) {
        const chunk = Buffer.from(raw)
        bytes += chunk.length
        if (bytes > 8_192) return send(400, { error: 'INVALID_BODY_SIZE' })
        chunks.push(chunk)
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('body')
    } catch {
      return send(400, { error: 'INVALID_BODY' })
    }
    const { sessionKey, agentId, delegateRunId, parentTraceId, model } = body
    if (
      typeof sessionKey !== 'string' ||
      !sessionKey.trim() ||
      sessionKey.length > 512 ||
      typeof agentId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(agentId) ||
      typeof delegateRunId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(delegateRunId) ||
      (model !== undefined && (typeof model !== 'string' || model.length > 128)) ||
      (parentTraceId !== undefined &&
        (typeof parentTraceId !== 'string' || !TRACE_RE.test(parentTraceId)))
    ) {
      return send(400, { error: 'INVALID_TRACE_INPUT' })
    }
    try {
      if (parentTraceId) {
        const parent = await deps.pool.query({
          text: 'SELECT trace_id FROM turn_traces WHERE trace_id=$1 AND user_id=$2',
          values: [parentTraceId, identity.userId],
          query_timeout: 2_000,
        })
        if (parent.rows.length !== 1) return send(403, { error: 'PARENT_TRACE_NOT_OWNED' })
      }
      const traceId = newTraceId()
      await insertTurnTrace(
        deps.pool,
        {
          traceId,
          userId: BigInt(identity.userId),
          sessionKey,
          agentId,
          model: model as string | undefined,
        },
        2_000,
      )
      log.info('delegate_trace_created', {
        traceId,
        parentTraceId,
        delegateRunId,
        userId: String(identity.userId),
        containerId: identity.containerId,
        sessionKey,
        ...(parentTraceId ? {} : { parentTraceIdMissing: 'legacy-parent-context' }),
      })
      return send(200, { traceId, parentTraceId })
    } catch {
      log.warn('delegate_trace_record_failed', {
        userId: String(identity.userId),
        parentTraceId,
        delegateRunId,
      })
      return send(503, { error: 'TRACE_UNAVAILABLE' })
    }
  }
}
