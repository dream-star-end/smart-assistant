/**
 * OCV5-907 Wave 2 (P1-1) — Master internal RPC endpoint for container <-> master
 * authoritative small-state synchronization (`AuthorityStateBridge`).
 *
 * Trust boundary & field ownership (R1 Audit B1/B2/B4/B6):
 * - Auth via injected container verifier; `userId` and `tenantId` (`c:${userId}`)
 *   are ALWAYS derived from the verified container identity.
 * - Narrow PATCH routes enforce strict field ownership:
 *   - `PUT   /pointer`      -> container-owned resume fields ONLY (never mutates
 *                              `pool_kind`, `operation_id`, `profile_id`,
 *                              `capsule_id`, `prompt_cache_meta_json`, or
 *                              `migration_state`). Requires `expectedPlacementEpoch`
 *                              or `createIfAbsentOnly: true`. Supports `reset: true`.
 *   - `PATCH /prompt-state` -> merges `promptState` watermark into
 *                              `prompt_cache_meta_json` without touching
 *                              `pendingInstallMigration` or `_capsuleMeta`.
 *   - `PATCH /capsule`      -> updates `capsule_id` + `_capsuleMeta` without
 *                              touching `pendingInstallMigration` or `promptState`.
 * - `GET /checkpoint` binds to the current authoritative pointer's
 *   `placementEpoch` by default (or explicit `placementEpoch` / `generation`),
 *   preventing stale cross-epoch checkpoint injection.
 * - Explicit placement-epoch / migration conflicts return HTTP 409 with exact
 *   coded error so container bridges fail closed.
 *
 * Layer: interface-http (L5). Zero `process.env`, zero `R3-special-case`,
 * zero direct `R3-handler-auth`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  AUTHORITY_ENGINE_KINDS,
  AUTHORITY_STATE_INTERNAL_PREFIX,
  ROLLING_CHECKPOINT_MODES,
  type AuthorityEngineKind,
  type RollingCheckpointMode,
  type SessionAuthorityEpoch,
  type SessionEnginePointer,
} from '@openclaude/protocol'
import {
  patchContainerCapsuleRef,
  patchContainerPromptState,
  patchContainerResumePointer,
  type PatchContainerCapsuleRefInput,
  type PatchContainerPromptStateInput,
  type PatchContainerResumePointerInput,
} from '../db/threeLayerContainerPatch.js'
import type {
  PgSessionAuthorityStateStore,
  PgTransactionPool,
} from '../db/threeLayerStateStore.js'
import type { ServerAuthoredHandler } from './internalServerAuthored.js'
import { ensureRequestId, sendError, sendJson, setSecurityHeaders } from './util.js'

export { AUTHORITY_STATE_INTERNAL_PREFIX }

const MAX_POINTER_BODY_BYTES = 128 * 1024
const MAX_CHECKPOINT_BODY_BYTES = 512 * 1024
const MAX_SESSION_KEY_LENGTH = 512
const MAX_STRING_ARRAY_LEN = 32
const MAX_STRING_ITEM_LEN = 256

const ENGINE_SET: ReadonlySet<string> = new Set<string>(AUTHORITY_ENGINE_KINDS)
const CHECKPOINT_MODE_SET: ReadonlySet<string> = new Set<string>(ROLLING_CHECKPOINT_MODES)

const CONFLICT_CODES: ReadonlySet<string> = new Set<string>([
  'SESSION_PLACEMENT_EPOCH_MISMATCH',
  'SESSION_PLACEMENT_MIGRATING',
  'CHECKPOINT_PLACEMENT_EPOCH_MISMATCH',
  'PLACEMENT_EPOCH_CONFLICT',
])

export interface InternalAuthorityStatePatchers {
  readonly patchResume: (input: PatchContainerResumePointerInput) => Promise<SessionEnginePointer>
  readonly patchPromptState: (input: PatchContainerPromptStateInput) => Promise<SessionEnginePointer>
  readonly patchCapsule: (input: PatchContainerCapsuleRefInput) => Promise<SessionEnginePointer>
}

export interface InternalAuthorityStateDeps {
  readonly store: PgSessionAuthorityStateStore
  readonly pgPool?: PgTransactionPool
  readonly patchers?: InternalAuthorityStatePatchers
  readonly verify: (
    req: IncomingMessage,
    ctx: Parameters<ServerAuthoredHandler>[2],
  ) => Promise<{ userId: number | bigint }>
}

class PayloadTooLargeError extends Error {
  readonly code = 'PAYLOAD_TOO_LARGE'
  constructor(limitBytes: number) {
    super(`Request body exceeds ${limitBytes} bytes`)
    this.name = 'PayloadTooLargeError'
  }
}

class InvalidJsonError extends Error {
  readonly code = 'INVALID_JSON'
  constructor() {
    super('Request body must be valid JSON')
    this.name = 'InvalidJsonError'
  }
}

function readJsonBodyBounded(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false

    const finish = (err: Error | null, parsed?: Record<string, unknown>) => {
      if (settled) return
      settled = true
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('aborted', onAborted)
      if (err) reject(err)
      else resolve(parsed ?? {})
    }

    const onData = (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      total += buf.length
      if (total > maxBytes) {
        req.resume()
        finish(new PayloadTooLargeError(maxBytes))
        return
      }
      chunks.push(buf)
    }

    const onEnd = () => {
      if (total === 0) {
        finish(null, {})
        return
      }
      try {
        const text = Buffer.concat(chunks, total).toString('utf8')
        const parsed: unknown = JSON.parse(text)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          finish(new InvalidJsonError())
          return
        }
        finish(null, parsed as Record<string, unknown>)
      } catch {
        finish(new InvalidJsonError())
      }
    }

    const onError = (err: Error) => finish(err)
    const onAborted = () => finish(new Error('REQUEST_ABORTED'))

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('aborted', onAborted)
  })
}

function validateSessionKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > MAX_SESSION_KEY_LENGTH) return null
  return trimmed
}

function validateOptionalString(raw: unknown, maxLen: number): string | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return null
  if (typeof raw !== 'string' || raw.length > maxLen) return undefined
  return raw
}

function validateOptionalPositiveInt(raw: unknown): number | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1) return undefined
  return raw
}

function validateOptionalStringArray(raw: unknown): readonly string[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) return undefined
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || item.length === 0 || item.length > MAX_STRING_ITEM_LEN) {
      return undefined
    }
    out.push(item)
    if (out.length >= MAX_STRING_ARRAY_LEN) break
  }
  return out
}

function validateOptionalNumberRecord(raw: unknown): Record<string, number> | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
    out[k] = v
  }
  return out
}

function validateSlotHashes(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined) return undefined
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && v.length <= 128) out[k] = v
  }
  return out
}

function extractConflictCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null
  const code = (err as { code?: unknown }).code
  if (typeof code === 'string' && CONFLICT_CODES.has(code)) return code
  const message = (err as { message?: unknown }).message
  if (typeof message === 'string') {
    for (const candidate of CONFLICT_CODES) {
      if (message.includes(candidate)) return candidate
    }
  }
  return null
}

function normalizeStoreError(
  res: ServerResponse,
  err: unknown,
  requestId: string,
): void {
  if (err instanceof PayloadTooLargeError) {
    sendError(res, 413, 'PAYLOAD_TOO_LARGE', err.message, requestId)
    return
  }
  if (err instanceof InvalidJsonError) {
    sendError(res, 400, 'INVALID_JSON', err.message, requestId)
    return
  }
  const conflict = extractConflictCode(err)
  if (conflict) {
    sendError(res, 409, conflict, `authoritative state conflict: ${conflict}`, requestId)
    return
  }
  const msg = err instanceof Error ? err.message : ''
  if (msg.startsWith('STATE_STORE_') || msg.startsWith('CHECKPOINT_')) {
    sendError(res, 400, msg, 'invalid authoritative state parameters', requestId)
    return
  }
  sendError(res, 500, 'AUTHORITY_STATE_ERROR', 'authoritative state operation failed', requestId)
}

export function makeInternalAuthorityStateHandler(
  deps: InternalAuthorityStateDeps,
): ServerAuthoredHandler {
  const patchers: InternalAuthorityStatePatchers | null =
    deps.patchers ??
    (deps.pgPool
      ? {
          patchResume: (input) => patchContainerResumePointer(deps.pgPool!, input),
          patchPromptState: (input) => patchContainerPromptState(deps.pgPool!, input),
          patchCapsule: (input) => patchContainerCapsuleRef(deps.pgPool!, input),
        }
      : null)

  return async (req, res, ctx) => {
    setSecurityHeaders(res)
    const requestId = ensureRequestId(req)
    res.setHeader('x-request-id', requestId)
    res.setHeader('cache-control', 'no-store')

    let userId: number | bigint
    try {
      const identity = await deps.verify(req, ctx)
      userId = identity.userId
    } catch {
      sendError(res, 401, 'UNAUTHORIZED', 'container identity verification failed', requestId)
      return
    }
    const tenantId = `c:${userId.toString()}`

    const url = new URL(req.url ?? '/', 'http://internal')
    const pathname = url.pathname
    if (!pathname.startsWith(AUTHORITY_STATE_INTERNAL_PREFIX)) {
      sendError(res, 404, 'NOT_FOUND', 'unknown authority state route', requestId)
      return
    }
    const subpath = pathname.slice(AUTHORITY_STATE_INTERNAL_PREFIX.length)
    const method = (req.method ?? 'GET').toUpperCase()

    try {
      if (subpath === 'epoch') {
        if (method !== 'GET') {
          sendError(res, 405, 'METHOD_NOT_ALLOWED', 'GET required', requestId)
          return
        }
        const sessionKey = validateSessionKey(url.searchParams.get('sessionKey'))
        if (!sessionKey) {
          sendError(res, 400, 'INVALID_SESSION_KEY', 'sessionKey query parameter required', requestId)
          return
        }
        const pointer = await deps.store.getEnginePointer(userId, sessionKey)
        const epoch: SessionAuthorityEpoch | null = pointer
          ? {
              tenantId,
              sessionKey: pointer.sessionKey,
              placementEpoch: pointer.placementEpoch,
              migrationState: pointer.migrationState,
              activeMigrationId: pointer.activeMigrationId ?? null,
              updatedAt: pointer.updatedAt,
            }
          : null
        sendJson(res, 200, { ok: true, epoch })
        return
      }

      if (subpath === 'pointer') {
        if (method === 'GET') {
          const sessionKey = validateSessionKey(url.searchParams.get('sessionKey'))
          if (!sessionKey) {
            sendError(res, 400, 'INVALID_SESSION_KEY', 'sessionKey query parameter required', requestId)
            return
          }
          const pointer = await deps.store.getEnginePointer(userId, sessionKey)
          sendJson(res, 200, { ok: true, pointer })
          return
        }
        if (method === 'PUT') {
          const body = await readJsonBodyBounded(req, MAX_POINTER_BODY_BYTES)
          const sessionKey = validateSessionKey(body.sessionKey)
          if (!sessionKey) {
            sendError(res, 400, 'INVALID_SESSION_KEY', 'sessionKey is required', requestId)
            return
          }
          if (typeof body.engine !== 'string' || !ENGINE_SET.has(body.engine)) {
            sendError(res, 400, 'INVALID_ENGINE', 'valid engine is required', requestId)
            return
          }
          const expectedPlacementEpoch =
            body.expectedPlacementEpoch !== undefined
              ? validateOptionalPositiveInt(body.expectedPlacementEpoch)
              : undefined
          if (body.expectedPlacementEpoch !== undefined && expectedPlacementEpoch === undefined) {
            sendError(res, 400, 'INVALID_EXPECTED_EPOCH', 'expectedPlacementEpoch must be positive integer', requestId)
            return
          }
          const createIfAbsentOnly = body.createIfAbsentOnly === true
          if (expectedPlacementEpoch === undefined && !createIfAbsentOnly) {
            sendError(
              res,
              400,
              'STATE_STORE_PRECONDITION_REQUIRED',
              'expectedPlacementEpoch or createIfAbsentOnly is required',
              requestId,
            )
            return
          }
          const reset = body.reset === true
          const history = validateOptionalStringArray(body.history)
          if (body.history !== undefined && history === undefined) {
            sendError(res, 400, 'INVALID_HISTORY', 'history must be an array of non-empty strings', requestId)
            return
          }
          const rejectedIds = validateOptionalStringArray(body.rejectedIds)
          if (body.rejectedIds !== undefined && rejectedIds === undefined) {
            sendError(res, 400, 'INVALID_REJECTED_IDS', 'rejectedIds must be an array of non-empty strings', requestId)
            return
          }
          const nativeSessionId = validateOptionalString(body.nativeSessionId, 256)
          if (body.nativeSessionId !== undefined && nativeSessionId === undefined) {
            sendError(res, 400, 'INVALID_NATIVE_SESSION_ID', 'invalid nativeSessionId', requestId)
            return
          }
          let totalCostUsd: number | undefined
          if (typeof body.totalCostUsd === 'number' && Number.isFinite(body.totalCostUsd)) {
            totalCostUsd = body.totalCostUsd
          } else {
            const usageBaseline = validateOptionalNumberRecord(body.usageBaseline)
            if (body.usageBaseline !== undefined && usageBaseline === undefined) {
              sendError(res, 400, 'INVALID_USAGE_BASELINE', 'usageBaseline must be number record or null', requestId)
              return
            }
            if (usageBaseline && typeof usageBaseline.totalCostUsd === 'number') {
              totalCostUsd = usageBaseline.totalCostUsd
            }
          }
          let historyContextVersion: number | null | undefined
          if (body.historyContextVersion === null) {
            historyContextVersion = null
          } else if (body.historyContextVersion !== undefined) {
            if (
              typeof body.historyContextVersion !== 'number' ||
              !Number.isSafeInteger(body.historyContextVersion)
            ) {
              sendError(res, 400, 'INVALID_HISTORY_CONTEXT_VERSION', 'invalid historyContextVersion', requestId)
              return
            }
            historyContextVersion = body.historyContextVersion
          }
          if (
            body.promotedFromHistory !== undefined &&
            typeof body.promotedFromHistory !== 'boolean'
          ) {
            sendError(res, 400, 'INVALID_PROMOTED_FROM_HISTORY', 'promotedFromHistory must be boolean', requestId)
            return
          }

          if (!patchers) {
            sendError(res, 503, 'AUTHORITY_PATCHERS_UNAVAILABLE', 'narrow state patchers unavailable', requestId)
            return
          }
          const pointer = await patchers.patchResume({
            userId,
            sessionKey,
            engine: body.engine as AuthorityEngineKind,
            nativeSessionId: reset ? null : (nativeSessionId ?? null),
            ...(history !== undefined ? { history } : {}),
            ...(rejectedIds !== undefined ? { rejectedIds } : {}),
            ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
            ...(historyContextVersion !== undefined ? { historyContextVersion } : {}),
            ...(typeof body.promotedFromHistory === 'boolean'
              ? { promotedFromHistory: body.promotedFromHistory }
              : {}),
            ...(expectedPlacementEpoch !== undefined ? { expectedPlacementEpoch } : {}),
            ...(createIfAbsentOnly ? { createIfAbsentOnly: true } : {}),
            ...(reset ? { reset: true } : {}),
          })
          sendJson(res, 200, { ok: true, pointer })
          return
        }
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'GET or PUT required', requestId)
        return
      }

      if (subpath === 'prompt-state') {
        if (method !== 'PATCH') {
          sendError(res, 405, 'METHOD_NOT_ALLOWED', 'PATCH required', requestId)
          return
        }
        if (!patchers) {
          sendError(res, 503, 'AUTHORITY_PATCHERS_UNAVAILABLE', 'narrow state patchers unavailable', requestId)
          return
        }
        const body = await readJsonBodyBounded(req, MAX_POINTER_BODY_BYTES)
        const sessionKey = validateSessionKey(body.sessionKey)
        const expectedPlacementEpoch = validateOptionalPositiveInt(body.expectedPlacementEpoch)
        const ps =
          body.promptState && typeof body.promptState === 'object' && !Array.isArray(body.promptState)
            ? (body.promptState as Record<string, unknown>)
            : null
        if (
          !sessionKey ||
          expectedPlacementEpoch === undefined ||
          typeof body.engine !== 'string' ||
          !ENGINE_SET.has(body.engine) ||
          !ps ||
          ps.v !== 1 ||
          ps.sessionKey !== sessionKey ||
          typeof ps.conversationId !== 'string' ||
          ps.conversationId.length === 0 ||
          ps.conversationId.length > 128 ||
          typeof ps.inputsKey !== 'string' ||
          ps.inputsKey.length === 0 ||
          ps.inputsKey.length > 128 ||
          typeof ps.injectedAfterBaseline !== 'number' ||
          !Number.isSafeInteger(ps.injectedAfterBaseline) ||
          ps.injectedAfterBaseline < -1 ||
          typeof ps.updatedAt !== 'number' ||
          !Number.isFinite(ps.updatedAt)
        ) {
          sendError(res, 400, 'INVALID_PROMPT_STATE', 'invalid prompt-state patch payload', requestId)
          return
        }
        const slotHashes = validateSlotHashes(ps.slotHashes)
        const pointer = await patchers.patchPromptState({
          userId,
          sessionKey,
          engine: body.engine as AuthorityEngineKind,
          expectedPlacementEpoch,
          promptState: {
            v: 1,
            sessionKey,
            conversationId: ps.conversationId,
            inputsKey: ps.inputsKey,
            ...(slotHashes ? { slotHashes } : {}),
            injectedAfterBaseline: ps.injectedAfterBaseline,
            updatedAt: ps.updatedAt,
          },
        })
        sendJson(res, 200, { ok: true, pointer })
        return
      }

      if (subpath === 'capsule') {
        if (method !== 'PATCH') {
          sendError(res, 405, 'METHOD_NOT_ALLOWED', 'PATCH required', requestId)
          return
        }
        if (!patchers) {
          sendError(res, 503, 'AUTHORITY_PATCHERS_UNAVAILABLE', 'narrow state patchers unavailable', requestId)
          return
        }
        const body = await readJsonBodyBounded(req, MAX_POINTER_BODY_BYTES)
        const sessionKey = validateSessionKey(body.sessionKey)
        const expectedPlacementEpoch = validateOptionalPositiveInt(body.expectedPlacementEpoch)
        const capsuleId = validateOptionalString(body.capsuleId, 256)
        const manifestBlobId = validateOptionalString(body.manifestBlobId, 128)
        const engineVersion = validateOptionalString(body.engineVersion, 128)
        const createdAt = validateOptionalString(body.createdAt, 64)
        const nativeSessionId = validateOptionalString(body.nativeSessionId, 256)
        const usageBaseline = validateOptionalNumberRecord(body.usageBaseline)
        if (
          !sessionKey ||
          expectedPlacementEpoch === undefined ||
          typeof body.engine !== 'string' ||
          !ENGINE_SET.has(body.engine) ||
          !capsuleId ||
          !manifestBlobId ||
          !engineVersion ||
          !createdAt ||
          (body.usageBaseline !== undefined && usageBaseline === undefined)
        ) {
          sendError(res, 400, 'INVALID_CAPSULE_PATCH', 'invalid capsule patch payload', requestId)
          return
        }
        const pointer = await patchers.patchCapsule({
          userId,
          sessionKey,
          engine: body.engine as AuthorityEngineKind,
          expectedPlacementEpoch,
          capsuleId,
          manifestBlobId,
          engineVersion,
          createdAt,
          ...(nativeSessionId !== undefined ? { nativeSessionId } : {}),
          ...(usageBaseline !== undefined ? { usageBaseline } : {}),
        })
        sendJson(res, 200, { ok: true, pointer })
        return
      }

      if (subpath === 'checkpoint') {
        if (method === 'GET') {
          const sessionKey = validateSessionKey(url.searchParams.get('sessionKey'))
          if (!sessionKey) {
            sendError(res, 400, 'INVALID_SESSION_KEY', 'sessionKey query parameter required', requestId)
            return
          }
          const genParam = url.searchParams.get('generation')?.trim()
          if (genParam) {
            const checkpoint = await deps.store.getRollingCheckpointByGeneration(
              userId,
              sessionKey,
              genParam,
            )
            sendJson(res, 200, { ok: true, checkpoint })
            return
          }
          const epochParamRaw = url.searchParams.get('placementEpoch')
          let requestedEpoch: number | undefined
          if (epochParamRaw !== null) {
            const parsed = Number(epochParamRaw)
            if (!Number.isSafeInteger(parsed) || parsed < 1) {
              sendError(res, 400, 'INVALID_PLACEMENT_EPOCH', 'placementEpoch must be positive integer', requestId)
              return
            }
            requestedEpoch = parsed
          }
          // B6: Always validate against current authoritative pointer epoch on Master so
          // a migration N -> N+1 committed between client GETs never returns an epoch N summary.
          const ptr = await deps.store.getEnginePointer(userId, sessionKey)
          if (!ptr) {
            sendJson(res, 200, { ok: true, checkpoint: null })
            return
          }
          if (requestedEpoch !== undefined && requestedEpoch !== ptr.placementEpoch) {
            sendJson(res, 200, { ok: true, checkpoint: null })
            return
          }
          const checkpoint = await deps.store.peekRollingCheckpoint(
            userId,
            sessionKey,
            ptr.placementEpoch,
          )
          sendJson(res, 200, { ok: true, checkpoint })
          return
        }
        if (method === 'POST') {
          const body = await readJsonBodyBounded(req, MAX_CHECKPOINT_BODY_BYTES)
          const sessionKey = validateSessionKey(body.sessionKey)
          const sessionId = validateOptionalString(body.sessionId, 256)
          const expectedPlacementEpoch = validateOptionalPositiveInt(
            body.expectedPlacementEpoch ?? body.placementEpoch,
          )
          if (!sessionKey || !sessionId || expectedPlacementEpoch === undefined) {
            sendError(res, 400, 'INVALID_CHECKPOINT_INPUT', 'sessionKey, sessionId and positive placementEpoch are required', requestId)
            return
          }
          if (typeof body.mode !== 'string' || !CHECKPOINT_MODE_SET.has(body.mode)) {
            sendError(res, 400, 'INVALID_CHECKPOINT_MODE', 'valid mode is required', requestId)
            return
          }
          if (typeof body.sourceEngine !== 'string' || !ENGINE_SET.has(body.sourceEngine)) {
            sendError(res, 400, 'INVALID_SOURCE_ENGINE', 'valid sourceEngine is required', requestId)
            return
          }
          if (
            typeof body.anchorSeq !== 'number' ||
            !Number.isSafeInteger(body.anchorSeq) ||
            body.anchorSeq < 0
          ) {
            sendError(res, 400, 'INVALID_ANCHOR_SEQ', 'anchorSeq must be non-negative integer', requestId)
            return
          }
          if (typeof body.summary !== 'string' || body.summary.trim().length === 0) {
            sendError(res, 400, 'INVALID_CHECKPOINT_SUMMARY', 'summary is required', requestId)
            return
          }
          const instructions = validateOptionalString(body.instructions, 32 * 1024)
          if (body.instructions !== undefined && instructions === undefined) {
            sendError(res, 400, 'INVALID_INSTRUCTIONS', 'invalid instructions', requestId)
            return
          }
          const checkpointGeneration = validateOptionalString(body.checkpointGeneration, 128)
          if (
            body.checkpointGeneration !== undefined &&
            (!checkpointGeneration || checkpointGeneration.trim().length === 0)
          ) {
            sendError(res, 400, 'INVALID_CHECKPOINT_GENERATION', 'invalid checkpointGeneration', requestId)
            return
          }
          const saved = await deps.store.saveRollingCheckpoint({
            userId,
            sessionKey,
            sessionId,
            expectedPlacementEpoch,
            mode: body.mode as RollingCheckpointMode,
            anchorSeq: body.anchorSeq,
            sourceEngine: body.sourceEngine as AuthorityEngineKind,
            summary: body.summary,
            ...(instructions !== undefined ? { instructions } : {}),
            ...(checkpointGeneration ? { checkpointGeneration } : {}),
          })
          sendJson(res, 200, {
            ok: true,
            checkpointGeneration: saved.checkpointGeneration,
            createdAtMs: saved.createdAtMs,
          })
          return
        }
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'GET or POST required', requestId)
        return
      }

      if (subpath === 'checkpoint/ack') {
        if (method !== 'POST') {
          sendError(res, 405, 'METHOD_NOT_ALLOWED', 'POST required', requestId)
          return
        }
        const body = await readJsonBodyBounded(req, MAX_POINTER_BODY_BYTES)
        const sessionKey = validateSessionKey(body.sessionKey)
        const checkpointGeneration = validateOptionalString(body.checkpointGeneration, 128)
        const turnKey = validateOptionalString(body.turnKey, 256)
        if (!sessionKey || !checkpointGeneration || !turnKey) {
          sendError(
            res,
            400,
            'INVALID_CHECKPOINT_ACK',
            'sessionKey, checkpointGeneration and turnKey are required',
            requestId,
          )
          return
        }
        const acked = await deps.store.ackRollingCheckpoint({
          userId,
          sessionKey,
          checkpointGeneration,
          consumedByTurnKey: turnKey,
        })
        sendJson(res, 200, { ok: true, acked })
        return
      }

      sendError(res, 404, 'NOT_FOUND', 'unknown authority state endpoint', requestId)
    } catch (err) {
      normalizeStoreError(res, err, requestId)
    }
  }
}
