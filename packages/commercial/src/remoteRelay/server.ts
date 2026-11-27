/**
 * AF_UNIX HTTP RPC server for the standalone blue-green `remote-relay` daemon.
 *
 * Security & operational guarantees:
 * - Parent directory created with `0700`, stale socket unlinked, listening socket `chmod 0600`.
 * - Every route (including `/healthz`, `/status`, `/drain*`, `/reopen`, `/rpc/*`) requires
 *   constant-time `x-oc-egress-secret` authentication (401 on missing/mismatch).
 * - Request bodies capped strictly at 64 KiB (413) and validated as JSON objects (400).
 * - `/rpc/ensure-lane` rejects immediately with 503 `REMOTE_POOL_DRAINING_RETRY_LATER` once
 *   draining has begun via `/drain-begin`, `/drain`, or process shutdown.
 * - Tracks `inFlightRpcCount` across active RPC handlers (B4) so shutdown drain never exits
 *   mid-admission.
 * - Distinguishes `runtimeState: 'ready' | 'disabled' | 'error'` on `/healthz` (B6).
 * - Single-hop peer forwarding (`x-oc-relay-hop: 1` loop guard) with fail-closed `unknown`
 *   reporting on inconclusive peer releases (B8) and coordinated container `release` cleanup.
 */
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname } from 'node:path'
import type { Pool } from 'pg'
import type {
  Cc5PreparedContainer,
  RemoteLaneRequest,
  RemoteLaneRuntimePort,
} from '@openclaude/gateway/cc5-container-runtime'
import type { RemoteReleaseDrainCoordinator } from '../account-pool/remotePool/drainGate.js'
import type { RemoteRelayPeerClient } from '../agent-sandbox/remoteRelayClient.js'
import {
  REMOTE_RELAY_HOP_HEADER,
  REMOTE_RELAY_MAX_BODY_BYTES,
  REMOTE_RELAY_PATHS,
  REMOTE_RELAY_SECRET_HEADER,
  type ReleaseSessionIfIdleResult,
  type ReleaseSessionKeyResult,
  type RemoteRelayHealthStatus,
  type RemoteRelayRuntimeState,
  type RemoteRelaySlot,
  httpStatusForRpcError,
  serializeRpcError,
  verifyRelaySecret,
} from './protocol.js'

const POSITIVE_ID_RE = /^[1-9][0-9]{0,18}$/
const HEX64_RE = /^[a-f0-9]{64}$/
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const GENERATION_RE = /^[1-9][0-9]{0,15}$/
const VALID_LANE_ENGINES: ReadonlySet<string> = new Set(['ccb', 'codex', 'antigravity'])

export interface RemoteRelayReleaseOptions {
  readonly skipViewCleanup?: boolean
  readonly peerCleanup?: () => Promise<boolean>
}

export interface RemoteRelayRuntimeLike extends RemoteLaneRuntimePort {
  release(containerDbId: string, dockerId?: string, opts?: RemoteRelayReleaseOptions): Promise<void>
  releaseSessionIfIdle?(
    sessionKey: string,
    opts?: { operationId?: string },
  ): Promise<ReleaseSessionIfIdleResult>
  drainOwnIdleAndOwnedLanes?(): Promise<void>
  hasLivePeerOwnedLane?(filter?: {
    readonly containerDbId?: string
    readonly sessionKey?: string
    readonly operationId?: string
  }): boolean
}

export interface RemoteRelayLogger {
  info?(msg: string, meta?: Record<string, unknown>): void
  warn?(msg: string, meta?: Record<string, unknown>): void
  error?(msg: string, meta?: Record<string, unknown>): void
}

export interface RemoteRelayQueryPoolLike {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ readonly rows: readonly R[] }>
}

export interface RemoteRelayRpcServerDeps {
  readonly socketPath: string
  readonly secret: string
  readonly slot: RemoteRelaySlot | null
  readonly instanceId: string
  readonly runtime: RemoteRelayRuntimeLike | undefined
  readonly runtimeState?: RemoteRelayRuntimeState
  readonly drainGate: RemoteReleaseDrainCoordinator
  readonly pool: () => RemoteRelayQueryPoolLike
  readonly peerClient?: RemoteRelayPeerClient
  readonly peerSocketPath?: string
  readonly isDrainingForShutdown?: () => boolean
  readonly onDrainBegin?: (opts?: { readonly exitWhenDrained?: boolean }) => void
  readonly onReopen?: () => void
  readonly logger?: RemoteRelayLogger
}

export interface RemoteRelayRpcServerHandle {
  readonly socketPath: string
  readonly server: Server
  readonly isDraining: () => boolean
  readonly getInFlightRpcCount: () => number
  readonly beginDrain: () => void
  readonly reopen: () => void
  readonly close: (opts?: { readonly unlinkSocket?: boolean }) => Promise<void>
}

class RequestBodyError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string) {
    super(code)
    this.status = status
    this.code = code
  }
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.headersSent || res.destroyed) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

async function readJsonObject(
  req: IncomingMessage,
  allowEmpty: boolean,
): Promise<Record<string, unknown>> {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > REMOTE_RELAY_MAX_BODY_BYTES) {
    throw new RequestBodyError(413, 'PAYLOAD_TOO_LARGE')
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')
    total += buf.length
    if (total > REMOTE_RELAY_MAX_BODY_BYTES) {
      throw new RequestBodyError(413, 'PAYLOAD_TOO_LARGE')
    }
    chunks.push(buf)
  }
  const text = total === 0 ? '' : Buffer.concat(chunks, total).toString('utf8').trim()
  if (text.length === 0) {
    if (allowEmpty) return {}
    throw new RequestBodyError(400, 'INVALID_JSON')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new RequestBodyError(400, 'INVALID_JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RequestBodyError(400, 'INVALID_REQUEST')
  }
  return parsed as Record<string, unknown>
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0
}

function isPositiveIdStr(v: unknown): v is string {
  return typeof v === 'string' && POSITIVE_ID_RE.test(v)
}

function isHex64(v: unknown): v is string {
  return typeof v === 'string' && HEX64_RE.test(v)
}

function isNonEmptyStr(v: unknown, maxLen: number): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= maxLen
}

function parsePreparedHandle(raw: unknown): Cc5PreparedContainer {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RequestBodyError(400, 'INVALID_REQUEST')
  }
  const obj = raw as Record<string, unknown>
  if (!isNonEmptyStr(obj.mountSource, 512) || !isPositiveIdStr(obj.containerDbId)) {
    throw new RequestBodyError(400, 'INVALID_REQUEST')
  }
  return Object.freeze({ mountSource: obj.mountSource, containerDbId: obj.containerDbId })
}

async function queryUnsettledJournals(
  pool: RemoteRelayQueryPoolLike,
): Promise<{ readonly ok: boolean; readonly count: number }> {
  try {
    const q = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
         FROM request_finalize_journal
        WHERE ctx ? 'remoteNativeBillingRecovery'
          AND state IN ('inflight', 'finalizing')`,
    )
    const count = Number(q.rows[0]?.cnt ?? '0')
    return { ok: true, count: Number.isSafeInteger(count) && count >= 0 ? count : 0 }
  } catch {
    return { ok: false, count: -1 }
  }
}

export async function createRemoteRelayRpcServer(
  deps: RemoteRelayRpcServerDeps,
): Promise<RemoteRelayRpcServerHandle> {
  const socketPath = deps.socketPath.trim()
  if (!socketPath) throw new Error('REMOTE_RELAY_SOCKET_REQUIRED')
  if (!deps.secret) throw new Error('REMOTE_RELAY_SECRET_REQUIRED')

  const parent = dirname(socketPath)
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true, mode: 0o700 })
  }
  rmSync(socketPath, { force: true })

  const effectiveRuntimeState: RemoteRelayRuntimeState =
    deps.runtimeState ?? (deps.runtime ? 'ready' : 'error')
  const peerSocketPath = deps.peerSocketPath ?? deps.peerClient?.socketPath

  let manualDraining = false
  let inFlightRpcCount = 0

  const isDraining = (): boolean =>
    manualDraining || deps.drainGate.isDraining || (deps.isDrainingForShutdown?.() ?? false)

  const getInFlightRpcCount = (): number => inFlightRpcCount

  const beginDrain = (): void => {
    manualDraining = true
    server.closeIdleConnections?.()
    deps.onDrainBegin?.()
  }

  const reopen = (): void => {
    manualDraining = false
    deps.drainGate.reopen()
    deps.onReopen?.()
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (!verifyRelaySecret(req.headers[REMOTE_RELAY_SECRET_HEADER], deps.secret)) {
        sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' })
        return
      }

      const path = (req.url ?? '/').split('?')[0] ?? '/'
      const method = (req.method ?? 'GET').toUpperCase()
      const isPeerHop = req.headers[REMOTE_RELAY_HOP_HEADER] === '1'

      if (path === REMOTE_RELAY_PATHS.healthz && method === 'GET') {
        const journals = await queryUnsettledJournals(deps.pool())
        const remoteRuntimeReady = effectiveRuntimeState === 'ready' && Boolean(deps.runtime)
        const draining = isDraining()
        // B6: Distinguish intentionally-disabled (200 ok:true, remoteRuntimeReady:false,
        // accepting:false) from enabled-but-broken error (503 ok:false, fail-closed).
        const ok =
          journals.ok && (remoteRuntimeReady || effectiveRuntimeState === 'disabled')
        const accepting = journals.ok && remoteRuntimeReady && !draining
        const health: RemoteRelayHealthStatus = {
          ok,
          role: 'remote-relay',
          slot: deps.slot,
          instanceId: deps.instanceId,
          pid: process.pid,
          accepting,
          draining,
          activeRelayCount: deps.drainGate.activeRelayCount,
          registeredRelayCount: deps.drainGate.registeredRelayCount,
          unsettledJournals: journals.count,
          remoteRuntimeReady,
          runtimeState: effectiveRuntimeState,
          inFlightRpcCount,
        }
        sendJson(res, ok ? 200 : 503, health as unknown as Record<string, unknown>)
        return
      }

      if (path === REMOTE_RELAY_PATHS.status && (method === 'GET' || method === 'POST')) {
        const journals = await queryUnsettledJournals(deps.pool())
        const draining = isDraining()
        const remoteRuntimeReady = effectiveRuntimeState === 'ready' && Boolean(deps.runtime)
        sendJson(res, 200, {
          ok: true,
          role: 'remote-relay',
          slot: deps.slot,
          instanceId: deps.instanceId,
          pid: process.pid,
          unsettledJournals: journals.count,
          ...deps.drainGate.status(),
          draining,
          accepting: remoteRuntimeReady && !draining,
          remoteRuntimeReady,
          runtimeState: effectiveRuntimeState,
          inFlightRpcCount,
        })
        return
      }

      if (path === REMOTE_RELAY_PATHS.drainBegin && method === 'POST') {
        const body = await readJsonObject(req, true)
        const exitWhenDrained = body.exitWhenDrained === true
        manualDraining = true
        deps.onDrainBegin?.({ exitWhenDrained })
        sendJson(res, 200, {
          ok: true,
          draining: true,
          accepting: false,
          exitWhenDrained,
          activeRelayCount: deps.drainGate.activeRelayCount,
          registeredRelayCount: deps.drainGate.registeredRelayCount,
          inFlightRpcCount,
          slot: deps.slot,
          instanceId: deps.instanceId,
          pid: process.pid,
        })
        return
      }

      if (path === REMOTE_RELAY_PATHS.reopen && method === 'POST') {
        await readJsonObject(req, true)
        reopen()
        const draining = isDraining()
        const remoteRuntimeReady = effectiveRuntimeState === 'ready' && Boolean(deps.runtime)
        sendJson(res, 200, {
          ok: true,
          ...deps.drainGate.status(),
          draining,
          accepting: remoteRuntimeReady && !draining,
          slot: deps.slot,
          instanceId: deps.instanceId,
          pid: process.pid,
        })
        return
      }

      if (path === REMOTE_RELAY_PATHS.drain && method === 'POST') {
        const body = await readJsonObject(req, true)
        const prevManualDraining = manualDraining
        try {
          const keepClosedForRestart =
            typeof body.keepClosedForRestart === 'boolean' ? body.keepClosedForRestart : true
          const releaseIdleLanes = body.releaseIdleLanes === true
          const timeoutMs =
            typeof body.timeoutMs === 'number' && Number.isFinite(body.timeoutMs)
              ? Math.max(50, Math.floor(body.timeoutMs))
              : 60_000
          const pollIntervalMs =
            typeof body.pollIntervalMs === 'number' && Number.isFinite(body.pollIntervalMs)
              ? Math.max(10, Math.min(1_000, Math.floor(body.pollIntervalMs)))
              : 100
          const startedAt = Date.now()
          // B2: Close new RPC admission BEFORE waiting for in-flight RPCs & active relays.
          manualDraining = true
          while (inFlightRpcCount > 0) {
            if (Date.now() - startedAt >= timeoutMs) {
              throw new Error('REMOTE_RELEASE_DRAIN_TIMEOUT')
            }
            await new Promise((r) => setTimeout(r, pollIntervalMs))
          }
          const remainingMs = Math.max(50, timeoutMs - (Date.now() - startedAt))
          const out = await deps.drainGate.drainForCutover(deps.pool() as Pool, {
            timeoutMs: remainingMs,
            pollIntervalMs,
            releaseRunId: typeof body.releaseRunId === 'string' ? body.releaseRunId : undefined,
            keepClosedForRestart,
          })
          // B2: Re-check in-flight RPCs after drainForCutover so no late ensureLane slipped through.
          while (inFlightRpcCount > 0) {
            if (Date.now() - startedAt >= timeoutMs) {
              throw new Error('REMOTE_RELEASE_DRAIN_TIMEOUT')
            }
            await new Promise((r) => setTimeout(r, pollIntervalMs))
          }
          if (deps.drainGate.activeRelayCount > 0) {
            throw new Error('REMOTE_RELEASE_DRAIN_TIMEOUT')
          }
          // B2: Reverse rollback / topology switch may request releasing warm idle lanes so
          // PG remote_agent_bindings transition cleanly to 'released' before switching runtime mode.
          if (releaseIdleLanes && deps.runtime?.drainOwnIdleAndOwnedLanes) {
            await deps.runtime.drainOwnIdleAndOwnedLanes()
            const postIdle = await queryUnsettledJournals(deps.pool())
            if (
              !postIdle.ok ||
              postIdle.count > 0 ||
              inFlightRpcCount > 0 ||
              deps.drainGate.activeRelayCount > 0
            ) {
              throw new Error('REMOTE_RELEASE_DRAIN_TIMEOUT')
            }
          }
          if (!keepClosedForRestart) {
            manualDraining = false
          }
          sendJson(res, 200, {
            ok: true,
            ...out,
            ...deps.drainGate.status(),
            inFlightRpcCount,
            releasedIdleLanes: releaseIdleLanes,
            draining: isDraining(),
            slot: deps.slot,
            instanceId: deps.instanceId,
            pid: process.pid,
          })
        } catch (err) {
          manualDraining = prevManualDraining
          deps.drainGate.reopen()
          const msg = err instanceof Error ? err.message : String(err)
          sendJson(res, msg === 'REMOTE_RELEASE_DRAIN_TIMEOUT' ? 409 : 500, {
            ok: false,
            error: msg,
            ...deps.drainGate.status(),
            inFlightRpcCount,
            draining: isDraining(),
            slot: deps.slot,
            instanceId: deps.instanceId,
            pid: process.pid,
          })
        }
        return
      }

      if (method !== 'POST' || !path.startsWith('/rpc/')) {
        sendJson(res, 404, { ok: false, error: 'NOT_FOUND' })
        return
      }

      const body = await readJsonObject(req, false)
      const runtime = deps.runtime
      if (!runtime) {
        const err = serializeRpcError(new Error('REMOTE_LANE_UNAVAILABLE'))
        sendJson(res, 503, { ok: false, error: err })
        return
      }

      // B4: Track every active RPC invocation so shutdown drain waits for in-flight admissions.
      inFlightRpcCount += 1
      try {
        if (path === REMOTE_RELAY_PATHS.prepare) {
          if (
            !isPositiveInt(body.uid) ||
            !isPositiveIdStr(body.containerDbId) ||
            typeof body.local !== 'boolean' ||
            typeof body.publicKeyring !== 'string' ||
            body.publicKeyring.length > 32 * 1024
          ) {
            throw new RequestBodyError(400, 'INVALID_REQUEST')
          }
          const prepared = await runtime.prepare({
            uid: body.uid,
            containerDbId: body.containerDbId,
            local: body.local,
            publicKeyring: body.publicKeyring,
          })
          sendJson(res, 200, { ok: true, result: prepared })
          return
        }

        if (path === REMOTE_RELAY_PATHS.bindCreated) {
          const handle = parsePreparedHandle(body.handle)
          if (!isHex64(body.dockerId)) {
            throw new RequestBodyError(400, 'INVALID_REQUEST')
          }
          await runtime.bindCreated(handle, body.dockerId)
          sendJson(res, 200, { ok: true })
          return
        }

        if (path === REMOTE_RELAY_PATHS.activate) {
          const handle = parsePreparedHandle(body.handle)
          if (!isHex64(body.dockerId)) {
            throw new RequestBodyError(400, 'INVALID_REQUEST')
          }
          await runtime.activate(handle, body.dockerId)
          sendJson(res, 200, { ok: true })
          return
        }

        if (path === REMOTE_RELAY_PATHS.release) {
          if (
            !isPositiveIdStr(body.containerDbId) ||
            (body.dockerId !== undefined && !isHex64(body.dockerId))
          ) {
            throw new RequestBodyError(400, 'INVALID_REQUEST')
          }
          const containerDbId = body.containerDbId
          const dockerId = body.dockerId
          if (isPeerHop) {
            // B8: Peer hop stops only this slot's own lanes; NEVER deletes shared view/.
            await runtime.release(containerDbId, dockerId, { skipViewCleanup: true })
            sendJson(res, 200, { ok: true })
            return
          }

          let peerCleanupInvoked = false
          const peerCleanup = async (): Promise<boolean> => {
            peerCleanupInvoked = true
            const peerSocketExists = Boolean(peerSocketPath && existsSync(peerSocketPath))
            const diskLivePeer =
              runtime.hasLivePeerOwnedLane?.({ containerDbId }) === true
            if (!peerSocketExists && !diskLivePeer) {
              return true
            }
            if (!deps.peerClient) {
              return false
            }
            return await deps.peerClient
              .release(containerDbId, dockerId)
              .catch(() => false)
          }

          await runtime.release(containerDbId, dockerId, { peerCleanup })
          if (!peerCleanupInvoked) {
            const peerOk = await peerCleanup()
            if (!peerOk) {
              throw new Error('REMOTE_LANE_PEER_RELEASE_UNPROVEN')
            }
          }
          sendJson(res, 200, { ok: true })
          return
        }

        if (path === REMOTE_RELAY_PATHS.ensureLane) {
          if (
            !isPositiveInt(body.uid) ||
            !isPositiveIdStr(body.containerDbId) ||
            !isNonEmptyStr(body.sessionKey, 512) ||
            !isNonEmptyStr(body.canonicalModel, 128) ||
            (body.engine !== undefined &&
              (typeof body.engine !== 'string' || !VALID_LANE_ENGINES.has(body.engine))) ||
            (body.allowStickyFailover !== undefined &&
              typeof body.allowStickyFailover !== 'boolean')
          ) {
            throw new RequestBodyError(400, 'INVALID_REQUEST')
          }
          if (isDraining()) {
            const err = serializeRpcError(new Error('REMOTE_POOL_DRAINING_RETRY_LATER'))
            sendJson(res, 503, { ok: false, error: err })
            return
          }
          const laneReq: RemoteLaneRequest & { readonly allowStickyFailover?: boolean } = {
            uid: body.uid,
            containerDbId: body.containerDbId,
            sessionKey: body.sessionKey,
            canonicalModel: body.canonicalModel,
            ...(body.engine !== undefined
              ? { engine: body.engine as 'ccb' | 'codex' | 'antigravity' }
              : {}),
            ...(body.allowStickyFailover === true ? { allowStickyFailover: true } : {}),
          }
          const backend = await runtime.ensureLane(laneReq)
          sendJson(res, 200, { ok: true, result: backend })
          return
        }

        if (path === REMOTE_RELAY_PATHS.releaseChat) {
          if (!isPositiveInt(body.uid) || !isNonEmptyStr(body.chatId, 512)) {
            throw new RequestBodyError(400, 'INVALID_REQUEST')
          }
          await runtime.releaseChat(body.uid, body.chatId)
          if (!isPeerHop && deps.peerClient) {
            await deps.peerClient.releaseChat(body.uid, body.chatId).catch(() => false)
          }
          sendJson(res, 200, { ok: true })
          return
        }

        if (path === REMOTE_RELAY_PATHS.releaseSessionKey) {
          if (!isPositiveInt(body.uid) || !isNonEmptyStr(body.sessionKey, 512)) {
            throw new RequestBodyError(400, 'INVALID_REQUEST')
          }
          let opts:
            | { containerDbId?: string; operationId?: string; generation?: string }
            | undefined
          if (body.opts !== undefined) {
            if (!body.opts || typeof body.opts !== 'object' || Array.isArray(body.opts)) {
              throw new RequestBodyError(400, 'INVALID_REQUEST')
            }
            const rawOpts = body.opts as Record<string, unknown>
            if (rawOpts.containerDbId !== undefined && !isPositiveIdStr(rawOpts.containerDbId)) {
              throw new RequestBodyError(400, 'INVALID_REQUEST')
            }
            if (
              rawOpts.operationId !== undefined &&
              (typeof rawOpts.operationId !== 'string' || !UUID_RE.test(rawOpts.operationId))
            ) {
              throw new RequestBodyError(400, 'INVALID_REQUEST')
            }
            if (
              rawOpts.generation !== undefined &&
              (typeof rawOpts.generation !== 'string' || !GENERATION_RE.test(rawOpts.generation))
            ) {
              throw new RequestBodyError(400, 'INVALID_REQUEST')
            }
            opts = {
              ...(rawOpts.containerDbId !== undefined
                ? { containerDbId: rawOpts.containerDbId as string }
                : {}),
              ...(rawOpts.operationId !== undefined
                ? { operationId: rawOpts.operationId as string }
                : {}),
              ...(rawOpts.generation !== undefined
                ? { generation: rawOpts.generation as string }
                : {}),
            }
          }

          let result: ReleaseSessionKeyResult =
            typeof runtime.releaseSessionKey === 'function'
              ? await runtime.releaseSessionKey(body.uid, body.sessionKey, opts)
              : { released: true, state: 'not_found' }

          // B8: Never fabricate `not_found` when a live peer slot may still own this lane.
          if (result.state === 'not_found' && !isPeerHop) {
            const peerSocketExists = Boolean(peerSocketPath && existsSync(peerSocketPath))
            const diskLivePeer =
              runtime.hasLivePeerOwnedLane?.({
                ...(opts?.containerDbId ? { containerDbId: opts.containerDbId } : {}),
                sessionKey: body.sessionKey,
                ...(opts?.operationId ? { operationId: opts.operationId } : {}),
              }) === true
            if (peerSocketExists || diskLivePeer) {
              if (!deps.peerClient) {
                sendJson(res, 503, {
                  ok: true,
                  result: { released: false, state: 'unknown' },
                })
                return
              }
              const peerRes = await deps.peerClient
                .releaseSessionKey(body.uid, body.sessionKey, opts)
                .catch(() => null)
              if (!peerRes || peerRes.state === 'unknown') {
                sendJson(res, 503, {
                  ok: true,
                  result: { released: false, state: 'unknown' },
                })
                return
              }
              result = peerRes
            }
          }

          if (result.state === 'unknown') {
            sendJson(res, 503, { ok: true, result: { released: false, state: 'unknown' } })
            return
          }

          sendJson(res, 200, { ok: true, result })
          return
        }

        if (path === REMOTE_RELAY_PATHS.releaseSessionIfIdle) {
          if (!isNonEmptyStr(body.sessionKey, 512)) {
            throw new RequestBodyError(400, 'INVALID_REQUEST')
          }
          let opts: { operationId?: string } | undefined
          if (body.opts !== undefined) {
            if (!body.opts || typeof body.opts !== 'object' || Array.isArray(body.opts)) {
              throw new RequestBodyError(400, 'INVALID_REQUEST')
            }
            const rawOpts = body.opts as Record<string, unknown>
            if (
              rawOpts.operationId !== undefined &&
              (typeof rawOpts.operationId !== 'string' || !UUID_RE.test(rawOpts.operationId))
            ) {
              throw new RequestBodyError(400, 'INVALID_REQUEST')
            }
            if (rawOpts.operationId !== undefined) {
              opts = { operationId: rawOpts.operationId }
            }
          }

          const result: ReleaseSessionIfIdleResult =
            typeof runtime.releaseSessionIfIdle === 'function'
              ? await runtime.releaseSessionIfIdle(body.sessionKey, opts)
              : { status: 'not_found' }
          sendJson(res, 200, { ok: true, result })
          return
        }

        sendJson(res, 404, { ok: false, error: 'NOT_FOUND' })
      } finally {
        inFlightRpcCount = Math.max(0, inFlightRpcCount - 1)
      }
    })().catch((err) => {
      if (err instanceof RequestBodyError) {
        sendJson(res, err.status, {
          ok: false,
          error: { code: err.code, message: err.code },
        })
        return
      }
      const serialized = serializeRpcError(err)
      const status = httpStatusForRpcError(serialized.code)
      deps.logger?.warn?.('remote_relay_rpc_error', {
        path: req.url,
        code: serialized.code,
        status,
      })
      sendJson(res, status, { ok: false, error: serialized })
    })
  })

  server.keepAliveTimeout = 60_000
  server.headersTimeout = 65_000

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      reject(err)
    }
    server.once('error', onError)
    server.listen(socketPath, () => {
      server.removeListener('error', onError)
      try {
        chmodSync(socketPath, 0o600)
        resolve()
      } catch (err) {
        server.close(() => reject(err instanceof Error ? err : new Error(String(err))))
      }
    })
  })

  let closed = false
  return {
    socketPath,
    server,
    isDraining,
    getInFlightRpcCount,
    beginDrain,
    reopen,
    async close(opts?: { readonly unlinkSocket?: boolean }): Promise<void> {
      if (closed) return
      closed = true
      if (server.listening) {
        server.closeIdleConnections?.()
        const forceTimer = setTimeout(() => {
          server.closeAllConnections?.()
        }, 500)
        forceTimer.unref?.()
        try {
          await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
        } finally {
          clearTimeout(forceTimer)
        }
      }
      if (opts?.unlinkSocket !== false) {
        try {
          rmSync(socketPath, { force: true })
        } catch {
          // Best-effort cleanup of this slot's own socket.
        }
      }
    },
  }
}
