import type { IncomingMessage, ServerResponse } from 'node:http'
import { BOX_AGENT_SCOPE_PATH, parseBoxAgentScopeIdentity } from '@openclaude/protocol'
import { IdentityError, type IdentityStrategy } from '../../auth/proxyIdentity.js'
import { BoxAgentScopeError } from './boxAgentScopeFence.js'
import type { BoxAgentScopes } from './boxAgentScopes.js'

export function makeBoxAgentScopeHandler(deps: { identity: IdentityStrategy; scopes: BoxAgentScopes }) {
  const inFlight = new Map<string, Promise<Awaited<ReturnType<BoxAgentScopes['control']>>>>()
  return async (req: IncomingMessage, res: ServerResponse,
    ctx: { hostUuid: string; boundIp: string }): Promise<void> => {
    const reply = (code: number, body: unknown) => {
      if (res.headersSent || res.destroyed) return
      res.statusCode = code
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(JSON.stringify(body))
    }
    if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== BOX_AGENT_SCOPE_PATH) {
      reply(404, { error: 'NOT_FOUND' }); return
    }
    let auth: Awaited<ReturnType<IdentityStrategy['resolve']>>
    try { auth = await deps.identity.resolve(req, ctx) }
    catch (error) {
      if (error instanceof IdentityError) { reply(401, { error: 'UNAUTHORIZED' }); return }
      throw error
    }
    if (auth.containerId === null || auth.apiKey) { reply(403, { error: 'CONTAINER_REQUIRED' }); return }
    let parsed: unknown
    const timer = setTimeout(() => { reply(408, { error: 'REQUEST_TIMEOUT' }); req.destroy() }, 5_000)
    try {
      let size = 0
      const parts: Buffer[] = []
      for await (const chunk of req) {
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += part.length
        if (size > 2048) { reply(413, { error: 'INVALID_REQUEST' }); return }
        parts.push(part)
      }
      parsed = JSON.parse(Buffer.concat(parts).toString('utf8'))
    } catch { reply(400, { error: 'INVALID_REQUEST' }); return }
    finally { clearTimeout(timer) }
    const identity = parseBoxAgentScopeIdentity(parsed)
    const body = parsed as Record<string, unknown> | null
    if (!identity || !body || !['register', 'cancel', 'status'].includes(String(body.operation))
      || Object.keys(body).sort().join(',') !== (body.operation === 'cancel'
        ? 'agentId,operation,reason,rootSessionId,scopeId,sessionId,turnKey'
        : 'agentId,operation,rootSessionId,scopeId,sessionId,turnKey')
      || (body.operation === 'cancel' && !['explicit-stop', 'finish', 'owner-lost'].includes(String(body.reason)))) {
      reply(400, { error: 'INVALID_REQUEST' }); return
    }
    const operation = body.operation as 'register' | 'cancel' | 'status'
    const reason = body.reason as 'explicit-stop' | 'finish' | 'owner-lost' | undefined
    const key = `${auth.uid}:${auth.containerId}:${identity.scopeId}:${operation}:${reason ?? ''}`
    let pending = inFlight.get(key)
    if (!pending) {
      if (inFlight.size >= 4) { reply(429, { error: 'SCOPE_CONTROL_BUSY' }); return }
      pending = deps.scopes.control({ uid: auth.uid, containerId: auth.containerId }, identity, operation, reason)
      inFlight.set(key, pending)
      void pending.finally(() => { if (inFlight.get(key) === pending) inFlight.delete(key) }).catch(() => {})
    }
    try { reply(200, await pending) }
    catch (error) {
      if (error instanceof BoxAgentScopeError) {
        reply(error.code === 'BOX_AGENT_SCOPE_UNKNOWN' ? 404 : 409, { error: error.code }); return
      }
      reply(503, { status: 'pending' })
    }
  }
}
