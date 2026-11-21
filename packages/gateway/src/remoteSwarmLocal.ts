/**
 * Container-local loopback HTTP endpoint (`/internal/v3/remote-swarm/*`) + production
 * worker executor for `RemoteSwarmRuntime` (OCV5-835).
 *
 * Security invariants:
 *   - Loopback-only (`127.0.0.1` / `::1`) + raw container gateway accessToken + HMAC-signed
 *     per-session/per-member caller token (`x-oc-remote-swarm-token`). Never routed via browser `/api/*`.
 *   - Rejects unregistered sessions (fail-closed; no auto-registration from arbitrary headers).
 *   - Workers inherit the parent coordinator agent's identity & toolset ceiling (NEVER escalate to `main`).
 *   - Workers forward parent billing attribution (`parentTurnKey`, `parentSessionId`, `delegateAgentId`)
 *     and use per-turn unique `sessionKey` / `peerId` so `turnKey` and freshness checks never collide.
 *   - Checks `AbortSignal` after every async preparation step before calling `sessions.submit()`, and
 *     releases lanes strictly scoped by `(operationId, generation)`.
 */
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { REMOTE_SWARM_LOCAL_PREFIX } from '@openclaude/protocol'
import type { AgentDef, AgentsConfig } from '@openclaude/storage'
import { checkToken } from './auth.js'
import {
  acquireDelegateRemoteLane,
  releaseDelegateRemoteLaneSession,
} from './delegateRemoteLane.js'
import {
  RemoteSwarmRuntime,
  type RemoteSwarmWorkerExecutor,
  type RemoteSwarmWorkerTurnInput,
  type RemoteSwarmWorkerTurnResult,
} from './remoteSwarmRuntime.js'
import type { SessionManager } from './sessionManager.js'

export { REMOTE_SWARM_LOCAL_PREFIX }
export type { RemoteSwarmRuntime }

export const REMOTE_SWARM_SESSION_HEADER = 'x-oc-remote-swarm-session'
export const REMOTE_SWARM_MEMBER_HEADER = 'x-oc-remote-swarm-member'
export const REMOTE_SWARM_TOKEN_HEADER = 'x-oc-remote-swarm-token'

const VALID_SWARM_TOOLS = new Set(['swarm', 'post_message', 'read_board', 'swarm_wait'] as const)
const SESSION_KEY_RE = /^agent:[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,32}:[A-Za-z0-9_-]{1,32}:[A-Za-z0-9_.:-]{1,180}$/
const MEMBER_HEADER_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

/** Intersect optional toolset ceilings so a worker can NEVER exceed its coordinator's toolset scope. */
export function capWorkerToolsets(
  parentAgentToolsets: readonly string[] | undefined,
  sessionAllowedToolsets: readonly string[] | undefined,
): string[] | undefined {
  if (parentAgentToolsets === undefined && sessionAllowedToolsets === undefined) return undefined
  if (parentAgentToolsets === undefined) return [...sessionAllowedToolsets!]
  if (sessionAllowedToolsets === undefined) return [...parentAgentToolsets]
  const allowedSet = new Set(sessionAllowedToolsets)
  return parentAgentToolsets.filter((t) => allowedSet.has(t))
}

export async function handleRemoteSwarmLocal(input: {
  method: string
  pathname: string
  remoteAddress: string | undefined
  authorized: boolean
  sessionHeader: string | undefined
  memberHeader: string | undefined
  tokenHeader: string | undefined
  bodyRaw: string
  runtime: RemoteSwarmRuntime
}): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!isLoopbackAddress(input.remoteAddress)) {
    return { status: 403, body: { ok: false, error: 'loopback only' } }
  }
  if (!input.authorized) {
    return { status: 401, body: { ok: false, error: 'unauthorized' } }
  }
  if (input.method !== 'POST') {
    return { status: 405, body: { ok: false, error: 'POST required' } }
  }

  const prefixWithSlash = REMOTE_SWARM_LOCAL_PREFIX.endsWith('/')
    ? REMOTE_SWARM_LOCAL_PREFIX
    : `${REMOTE_SWARM_LOCAL_PREFIX}/`
  if (!input.pathname.startsWith(prefixWithSlash)) {
    return { status: 404, body: { ok: false, error: 'unknown remote-swarm route' } }
  }
  const toolRaw = input.pathname.slice(prefixWithSlash.length).trim()
  if (!VALID_SWARM_TOOLS.has(toolRaw as 'swarm' | 'post_message' | 'read_board' | 'swarm_wait')) {
    return { status: 404, body: { ok: false, error: `unknown remote-swarm tool: ${toolRaw}` } }
  }
  const tool = toolRaw as 'swarm' | 'post_message' | 'read_board' | 'swarm_wait'

  const sessionKey = (input.sessionHeader ?? '').trim()
  if (!SESSION_KEY_RE.test(sessionKey)) {
    return { status: 400, body: { ok: false, error: 'invalid remote swarm session header' } }
  }
  const callerMemberRaw = (input.memberHeader ?? 'coordinator').trim().toLowerCase() || 'coordinator'
  if (!MEMBER_HEADER_RE.test(callerMemberRaw)) {
    return { status: 400, body: { ok: false, error: 'invalid remote swarm member header' } }
  }
  if (!input.runtime.verifyCallerToken(input.tokenHeader, sessionKey, callerMemberRaw)) {
    return { status: 401, body: { ok: false, error: 'invalid or expired remote swarm caller token' } }
  }

  let args: Record<string, unknown> = {}
  if (input.bodyRaw.trim()) {
    try {
      const parsed = JSON.parse(input.bodyRaw) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { status: 400, body: { ok: false, error: 'JSON object body required' } }
      }
      args = parsed as Record<string, unknown>
    } catch {
      return { status: 400, body: { ok: false, error: 'invalid JSON body' } }
    }
  }

  try {
    const result = await input.runtime.handleToolCall({
      sessionKey,
      callerMember: callerMemberRaw,
      tool,
      args,
    })
    return { status: 200, body: result }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = msg === 'REMOTE_SWARM_SESSION_NOT_REGISTERED' ? 404 : 400
    return { status, body: { ok: false, error: msg } }
  }
}

export function createGatewayRemoteSwarmExecutor(deps: {
  sessions: SessionManager
  resolveAgent: (agentId: string) => Promise<AgentDef | null> | AgentDef | null
  log: { warn: (msg: string, fields?: Record<string, unknown>) => void }
}): RemoteSwarmWorkerExecutor {
  /** Maps active worker sessionKey -> exact Master lane scope for generation-safe release. */
  const activeLaneScopes = new Map<string, { operationId: string; generation?: string }>()

  return {
    async runWorkerTurn(input: RemoteSwarmWorkerTurnInput): Promise<RemoteSwarmWorkerTurnResult> {
      if (input.signal.aborted) {
        return { text: '', error: 'aborted before start' }
      }

      const parent = deps.sessions.getByKey(input.coordinatorSessionKey)
      const effectiveAgentId = (parent?.agentId ?? input.parentAgentId ?? '').trim()
      if (!effectiveAgentId) {
        return { text: '', error: 'missing parent agent identity for swarm worker' }
      }

      const parentAgent = await deps.resolveAgent(effectiveAgentId)
      if (!parentAgent) {
        return { text: '', error: `parent agent not found: ${effectiveAgentId}` }
      }
      const cappedToolsets = capWorkerToolsets(parentAgent.toolsets, input.allowedToolsets)
      // Fail closed on empty intersection BEFORE acquiring a lane: `SubprocessRunner` treats `[]` as unfiltered (B5).
      if (
        (parentAgent.toolsets !== undefined || input.allowedToolsets !== undefined) &&
        cappedToolsets !== undefined &&
        cappedToolsets.length === 0
      ) {
        return { text: '', error: 'worker toolset intersection with parent coordinator is empty' }
      }
      if (input.signal.aborted) {
        return { text: '', error: 'aborted during agent resolution' }
      }

      const acquired = await acquireDelegateRemoteLane({
        sessionKey: input.workerSessionKey,
        model: input.model,
        agentId: effectiveAgentId,
        delegateAgentId: `swarm:${input.workerName}`,
        ...(parent?._currentTurnKey ? { parentTurnKey: parent._currentTurnKey } : {}),
        ...(parent?.peerId ? { parentSessionId: parent.peerId } : {}),
        log: deps.log,
      })
      if (!acquired.ok) {
        return { text: '', error: `远端蜂群成员车道申请失败（${acquired.code}）: ${acquired.reason}` }
      }
      const lease = acquired.lease
      activeLaneScopes.set(input.workerSessionKey, {
        operationId: lease.operationId,
        generation: lease.generation,
      })
      if (input.signal.aborted) {
        await lease.release({ outcome: 'interrupted', releaseLane: true })
        activeLaneScopes.delete(input.workerSessionKey)
        return { text: '', error: 'aborted during lane acquisition' }
      }

      const workerAgent: AgentDef = {
        ...parentAgent,
        model: lease.canonicalModel,
        ...(cappedToolsets !== undefined ? { toolsets: cappedToolsets } : {}),
      }
      const coordSlug = createHash('sha256')
        .update(input.coordinatorSessionKey, 'utf8')
        .digest('hex')
        .slice(0, 12)
      const workerPeerId = `${coordSlug}_${input.workerName.replace(/[^A-Za-z0-9_-]/g, '_')}_r${input.workerTurnSeq}_${input.workerTurnNonce}`

      let output = ''
      let turnError: string | undefined
      let inputTokens = 0
      let outputTokens = 0

      try {
        const session = await deps.sessions.getOrCreate({
          sessionKey: input.workerSessionKey,
          agent: workerAgent,
          model: lease.canonicalModel,
          executionAuthority: {
            canonicalModel: lease.canonicalModel,
            engine: lease.engine,
            executionBackend: lease.executionBackend,
            source: 'bridge_signed',
          },
          channel: 'swarm',
          peerId: workerPeerId,
          repoSessionId: parent?.peerId ?? parent?.repoSessionId,
          workspaceMode: parent?.workspaceMode,
          workspaceCwd: input.workspaceCwd,
          projectId: parent?.projectId ?? undefined,
          parentSessionKey: input.coordinatorSessionKey,
          title: `[swarm:${input.workerName}]`,
          delegationDepth: 1,
          usageAttribution: {
            mode: 'delegate',
            delegateAgentId: `swarm:${input.workerName}`,
            ...(parent?.peerId ? { parentSessionId: parent.peerId } : {}),
            ...(parent?._currentTurnKey ? { parentTurnKey: parent._currentTurnKey } : {}),
          },
        })

        // Re-check abort AFTER async getOrCreate and BEFORE registering listener / submitting (IMPORTANT 7).
        if (input.signal.aborted) {
          turnError = 'aborted before submit'
        } else {
          const onAbort = () => {
            try {
              session.runner.interrupt?.('user')
            } catch {
              /* ignore */
            }
          }
          input.signal.addEventListener('abort', onAbort, { once: true })

          try {
            await deps.sessions.submit(
              session,
              input.prompt,
              (ev) => {
                if (ev.kind === 'block' && ev.block.kind === 'text') {
                  output += ev.block.text
                } else if (ev.kind === 'block' && ev.block.kind === 'tool_use') {
                  input.onTelemetry({
                    type: 'TOOL_CALL',
                    status: 'ACTIVE',
                    toolName: ev.block.toolName,
                    toolArgs:
                      ev.block.inputJson && typeof ev.block.inputJson === 'object'
                        ? (ev.block.inputJson as Record<string, unknown>)
                        : {},
                  })
                } else if (ev.kind === 'usage') {
                  const inTok = ev.usage.inputTokens ?? 0
                  const outTok = ev.usage.outputTokens ?? 0
                  inputTokens += inTok
                  outputTokens += outTok
                  input.onTelemetry({
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    inputTokens: inTok,
                    outputTokens: outTok,
                  })
                } else if (ev.kind === 'error') {
                  turnError = ev.error
                  input.onTelemetry({
                    type: 'ERROR',
                    status: 'ERROR',
                    error: ev.error,
                  })
                }
              },
              input.effort,
              lease.canonicalModel,
              lease.billingRequestId,
              undefined,
              undefined,
              {
                modelAuthority: lease.turnModelAuthority,
              },
            )
          } finally {
            input.signal.removeEventListener('abort', onAbort)
          }
        }
      } catch (err) {
        turnError = turnError ?? (err instanceof Error ? err.message : String(err))
      } finally {
        const rel = await lease.release({
          outcome: input.signal.aborted
            ? 'interrupted'
            : turnError
              ? 'executed_error'
              : 'completed',
          releaseLane: true,
        })
        // Retain unconfirmed release scope so subsequent cleanup/retry can still release it (I2).
        if (rel.released || rel.state === 'mismatch' || rel.state === 'not_found') {
          activeLaneScopes.delete(input.workerSessionKey)
        }
        await deps.sessions.destroySession(input.workerSessionKey).catch(() => {})
      }

      return {
        text: output,
        ...(turnError ? { error: turnError } : {}),
        inputTokens,
        outputTokens,
      }
    },

    async releaseWorkerSession(
      workerSessionKey: string,
    ): Promise<{ released: boolean; state: string }> {
      const scope = activeLaneScopes.get(workerSessionKey)
      await deps.sessions.destroySession(workerSessionKey).catch(() => {})
      if (!scope) {
        return { released: true, state: 'not_found' }
      }
      const rel = await releaseDelegateRemoteLaneSession({
        sessionKey: workerSessionKey,
        operationId: scope.operationId,
        generation: scope.generation,
        log: deps.log,
      })
      if (rel.released || rel.state === 'mismatch' || rel.state === 'not_found') {
        activeLaneScopes.delete(workerSessionKey)
      }
      return rel
    },
  }
}

export function createGatewayRemoteSwarmRuntime(deps: {
  sessions: SessionManager
  getAgentsConfig: () => Promise<AgentsConfig>
  defaultModel: string
  log: { warn: (msg: string, fields?: Record<string, unknown>) => void }
}): RemoteSwarmRuntime {
  const executor = createGatewayRemoteSwarmExecutor({
    sessions: deps.sessions,
    resolveAgent: async (agentId) => {
      const cfg = await deps.getAgentsConfig()
      return cfg.agents.find((a) => a.id === agentId) ?? null
    },
    log: deps.log,
  })
  return new RemoteSwarmRuntime({ executor })
}

export async function handleGatewayRemoteSwarmHttp(deps: {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  extractToken: (req: IncomingMessage) => string
  accessToken: string
  readBody: (req: IncomingMessage, maxBytes?: number) => Promise<string>
  sendJson: (res: ServerResponse, code: number, body: unknown) => void
  runtime: RemoteSwarmRuntime
  sessions: SessionManager
}): Promise<void> {
  void deps.sessions
  const authorized = checkToken(deps.extractToken(deps.req), deps.accessToken)
  const bodyRaw = deps.req.method === 'POST' ? await deps.readBody(deps.req, 512 * 1024) : ''
  const sessionHeader = deps.req.headers[REMOTE_SWARM_SESSION_HEADER]
  const memberHeader = deps.req.headers[REMOTE_SWARM_MEMBER_HEADER]
  const tokenHeader = deps.req.headers[REMOTE_SWARM_TOKEN_HEADER]
  const result = await handleRemoteSwarmLocal({
    method: deps.req.method ?? 'GET',
    pathname: deps.url.pathname,
    remoteAddress: deps.req.socket.remoteAddress,
    authorized,
    sessionHeader: Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader,
    memberHeader: Array.isArray(memberHeader) ? memberHeader[0] : memberHeader,
    tokenHeader: Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader,
    bodyRaw,
    runtime: deps.runtime,
  })
  deps.sendJson(deps.res, result.status, result.body)
}
