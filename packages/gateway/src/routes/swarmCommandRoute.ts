/**
 * Container-gateway internal HTTP endpoint for Swarm control commands:
 *   - POST `/internal/swarm/command?sessionId=<id>`
 *   - POST `/internal/swarm/command/:sessionId`
 *
 * Security invariants:
 *   - Protected by fail-closed `verifyInternalBridgeAuthDetailed(req, { body })`
 *     (master → container bridge + per-request HMAC signature + anti-replay).
 *   - Authoritatively resolves `{ brainDir, conversationId }` on the container side from
 *     SessionManager / per-session Antigravity `sessionBrainDir`; NEVER accepts client `brainDir`
 *     and NEVER falls back to scanning historical conversation directories (B6).
 *   - Delegates directly to `handleSwarmCommandRoute(...)` in `../swarmCommand.js` so steer,
 *     terminate (`status: 'requested' | 'confirmed'`), playbook, locking & validation stay
 *     100% authoritative.
 */

import { lstatSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { Readable } from 'node:stream'
import { antigravityRoot, antigravitySessionBrainDir } from '../engine/antigravityPlatform.js'
import { lookupRemoteSwarmRuntimeForSession } from '../remoteSwarmRuntime.js'
import {
  handleSwarmCommandRoute,
  parseSwarmControlCommand,
  type ResolvedSessionSwarmTarget,
} from '../swarmCommand.js'
import {
  verifyInternalBridgeAuthDetailed,
  verifyInternalBridgeHeaderPrecheck,
  type InternalBridgeAuthResult,
  type InternalBridgeReplayCache,
} from './internalBridgeAuth.js'
import type { PlatformRoutesIo } from './platform.js'
import { type HttpRoute, predicateRoute } from './routeTable.js'

export const INTERNAL_SWARM_COMMAND_PATH = '/internal/swarm/command'
export const INTERNAL_SWARM_COMMAND_PATH_RE = /^\/internal\/swarm\/command(?:\/([^/]+))?\/?$/
export const INTERNAL_SWARM_USER_ID_HEADER = 'x-openclaude-user-id'

const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
const SAFE_USER_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/
const MAX_INTERNAL_SWARM_BODY_BYTES = 32 * 1024

export interface SessionSwarmLookupResult {
  sessionKey: string
  brainDir?: string
  conversationId?: string
}

export interface InternalSwarmCommandDeps {
  verifyAuth?: (
    req: IncomingMessage,
    body?: Buffer,
  ) => boolean | InternalBridgeAuthResult
  env?: NodeJS.ProcessEnv
  replayCache?: InternalBridgeReplayCache
  lookupSessionTarget?: (sessionId: string) => SessionSwarmLookupResult | null
  resolveSessionSwarm?: (
    userId: string,
    sessionId: string,
  ) => Promise<ResolvedSessionSwarmTarget | 'forbidden' | null>
  antigravityRootDir?: () => string
  now?: () => number
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

function lstatSafe(p: string) {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

function hasSwarmMembersJson(brainDir: string, conversationId: string): boolean {
  if (!CONVERSATION_ID_RE.test(conversationId)) return false
  const rootStat = lstatSafe(brainDir)
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) return false
  const convDir = path.join(brainDir, conversationId)
  const convStat = lstatSafe(convDir)
  if (!convStat || convStat.isSymbolicLink() || !convStat.isDirectory()) return false
  const sysDir = path.join(convDir, '.system_generated')
  const sysStat = lstatSafe(sysDir)
  if (!sysStat || sysStat.isSymbolicLink() || !sysStat.isDirectory()) return false
  const swarmDir = path.join(sysDir, 'swarm')
  const swarmStat = lstatSafe(swarmDir)
  if (!swarmStat || swarmStat.isSymbolicLink() || !swarmStat.isDirectory()) return false
  const membersPath = path.join(swarmDir, 'members.json')
  const st = lstatSafe(membersPath)
  return Boolean(st && !st.isSymbolicLink() && st.isFile())
}

/**
 * Resolve the container-authoritative `{ brainDir, conversationId }` for `sessionId`.
 *
 * B6 (OCV5-832): Requires an authoritative session -> conversationId binding from
 * `lookupSessionTarget` (live runner, live session `ccbSessionId`, or persisted
 * SessionManager `_resumeMap`). If the bound conversation has no active swarm
 * (`members.json`), returns `null` (404 `SWARM_NOT_FOUND`) and NEVER scans or falls
 * back to older historical conversation directories in the same `brainDir`.
 */
export function resolveAuthoritativeSessionSwarm(
  sessionId: string,
  deps: Pick<InternalSwarmCommandDeps, 'lookupSessionTarget' | 'antigravityRootDir'> = {},
): ResolvedSessionSwarmTarget | null {
  if (!SAFE_SESSION_ID_RE.test(sessionId)) return null
  const lookedUp = deps.lookupSessionTarget?.(sessionId) ?? null
  if (!lookedUp?.conversationId || !CONVERSATION_ID_RE.test(lookedUp.conversationId)) {
    return null
  }

  const root = deps.antigravityRootDir ? deps.antigravityRootDir() : antigravityRoot()
  const candidateBrainDirs: string[] = []
  if (lookedUp.brainDir) candidateBrainDirs.push(lookedUp.brainDir)
  if (lookedUp.sessionKey) {
    const derived = antigravitySessionBrainDir(root, lookedUp.sessionKey)
    if (!candidateBrainDirs.includes(derived)) candidateBrainDirs.push(derived)
  }

  const matches: ResolvedSessionSwarmTarget[] = []
  for (const brainDir of candidateBrainDirs) {
    if (hasSwarmMembersJson(brainDir, lookedUp.conversationId)) {
      matches.push({ brainDir, conversationId: lookedUp.conversationId })
    }
  }
  // B6: Fail closed unless exactly one authoritative target matches.
  return matches.length === 1 ? matches[0]! : null
}

function extractSessionId(url: URL): string | null {
  const match = INTERNAL_SWARM_COMMAND_PATH_RE.exec(url.pathname)
  if (match && match[1]) {
    try {
      const decoded = decodeURIComponent(match[1]).trim()
      return decoded || null
    } catch {
      return null
    }
  }
  const q = (url.searchParams.get('sessionId') ?? '').trim()
  return q || null
}

function normalizeAuthOutcome(res: boolean | InternalBridgeAuthResult): InternalBridgeAuthResult {
  if (typeof res === 'boolean') {
    return res
      ? { ok: true }
      : { ok: false, status: 401, code: 'UNAUTHORIZED', error: 'unauthorized' }
  }
  return res
}

async function readRawBodyBounded(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > maxBytes) {
      throw new Error('BODY_TOO_LARGE')
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks, total)
}

export async function handleInternalSwarmCommand(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: InternalSwarmCommandDeps = {},
): Promise<void> {
  if ((req.method ?? '').toUpperCase() !== 'POST') {
    sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: 'POST required' })
    return
  }

  if (!deps.verifyAuth) {
    const pre = verifyInternalBridgeHeaderPrecheck(req, { env: deps.env, now: deps.now })
    if (!pre.ok) {
      sendJson(res, pre.status, { ok: false, code: pre.code, error: pre.error })
      return
    }
  }

  let rawBody: Buffer
  try {
    rawBody = await readRawBodyBounded(req, MAX_INTERNAL_SWARM_BODY_BYTES)
  } catch (err) {
    if ((err as Error).message === 'BODY_TOO_LARGE') {
      sendJson(res, 413, { ok: false, code: 'BODY_TOO_LARGE', error: 'command payload exceeds limit' })
      return
    }
    sendJson(res, 400, { ok: false, code: 'INVALID_JSON', error: 'failed to read body' })
    return
  }

  const authOutcome = deps.verifyAuth
    ? normalizeAuthOutcome(deps.verifyAuth(req, rawBody))
    : verifyInternalBridgeAuthDetailed(req, {
        env: deps.env,
        body: rawBody,
        now: deps.now,
        replayCache: deps.replayCache,
      })
  if (!authOutcome.ok) {
    sendJson(res, authOutcome.status, {
      ok: false,
      code: authOutcome.code,
      error: authOutcome.error,
    })
    return
  }

  const sessionId = extractSessionId(url)
  if (!sessionId || !SAFE_SESSION_ID_RE.test(sessionId)) {
    sendJson(res, 400, { ok: false, code: 'INVALID_SESSION_ID', error: 'valid sessionId is required' })
    return
  }

  const rawUid = req.headers[INTERNAL_SWARM_USER_ID_HEADER]
  const userId = (Array.isArray(rawUid) ? rawUid[0] : rawUid ?? '').trim()
  if (!userId || !SAFE_USER_ID_RE.test(userId)) {
    sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', error: 'missing internal user identity' })
    return
  }

  // If this session is an active Remote Antigravity Swarm coordinator, route trusted
  // human kill commands directly through `RemoteSwarmRuntime.executeOperatorKill` (honest
  // confirmed vs pending stop) and wake workers after `steer` board writes (OCV5-835).
  const lookedUpSession = deps.lookupSessionTarget?.(sessionId) ?? null
  const remoteRuntime = lookedUpSession?.sessionKey
    ? lookupRemoteSwarmRuntimeForSession(lookedUpSession.sessionKey)
    : undefined

  if (remoteRuntime && lookedUpSession?.sessionKey) {
    try {
      const parsedBody = JSON.parse(rawBody.toString('utf8') || '{}') as Record<string, unknown>
      let action = typeof parsedBody.action === 'string' ? parsedBody.action.trim().toLowerCase() : ''
      let memberName =
        typeof parsedBody.memberName === 'string'
          ? parsedBody.memberName
          : typeof parsedBody.target === 'string'
            ? parsedBody.target
            : ''
      let reason = typeof parsedBody.reason === 'string' ? parsedBody.reason : undefined
      if (!action && typeof parsedBody.command === 'string') {
        const cmd = parseSwarmControlCommand(parsedBody.command)
        if (cmd?.kind === 'kill') {
          action = 'kill'
          memberName = cmd.memberName
          reason = cmd.reason
        }
      }
      if ((action === 'kill' || action === 'terminate') && memberName.trim()) {
        const killRes = await remoteRuntime.executeOperatorKill(
          lookedUpSession.sessionKey,
          memberName.trim(),
          reason || `user:${userId}`,
        )
        if (killRes.notFound) {
          sendJson(res, 404, { ok: false, code: 'MEMBER_NOT_FOUND', error: `member not found: ${memberName}` })
          return
        }
        sendJson(res, 200, {
          ok: true,
          action: 'terminate',
          status: killRes.confirmed ? 'confirmed' : 'requested',
          killed: killRes.killed,
          unconfirmed: killRes.unconfirmed,
          alreadyKilled: killRes.alreadyKilled,
          preservedDirtyWorktrees: killRes.preservedDirtyWorktrees,
        })
        return
      }
    } catch {
      // Malformed JSON falls through to handleSwarmCommandRoute's standard 400 validation.
    }
  }

  // Feed the signature-verified bytes into `handleSwarmCommandRoute` with canonical URL
  // `/api/sessions/:id/swarm/command` so 100% of validation, brainDir rejection, steer,
  // terminate, playbook & locking stay authoritative.
  const replayReq = Readable.from(rawBody.length > 0 ? [rawBody] : []) as unknown as IncomingMessage
  replayReq.method = 'POST'
  replayReq.url = `/api/sessions/${encodeURIComponent(sessionId)}/swarm/command`
  replayReq.headers = req.headers
  ;(replayReq as unknown as { socket?: unknown }).socket = req.socket

  await handleSwarmCommandRoute(replayReq, res, {
    authenticate: async () => ({ id: userId }),
    resolveSessionSwarm:
      deps.resolveSessionSwarm ??
      (async (_uid, sid) => resolveAuthoritativeSessionSwarm(sid, deps)),
    now: deps.now,
  })
  if (remoteRuntime && lookedUpSession?.sessionKey) {
    remoteRuntime.onExternalBoardWrite(lookedUpSession.sessionKey)
  }
}

export const SWARM_COMMAND_INTERNAL_ROUTES: readonly HttpRoute<PlatformRoutesIo>[] = [
  predicateRoute(
    'POST /internal/swarm/command',
    (req, url) => INTERNAL_SWARM_COMMAND_PATH_RE.test(url.pathname) && req.method === 'POST',
    (io, req, res, url) => {
      handleInternalSwarmCommand(req, res, url, {
        lookupSessionTarget: (sid) => io.sessions.resolveAntigravitySwarmTarget(sid),
      }).catch((err) => {
        io.log.error('internal swarm command handler crashed', undefined, err as Error)
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, code: 'INTERNAL', error: 'internal swarm command error' })
        }
      })
      return true
    },
  ),
]
