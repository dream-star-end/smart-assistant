import type { IncomingMessage, ServerResponse } from 'node:http'
import { freemem } from 'node:os'
import { getHeapStatistics } from 'node:v8'
import { PromptQueueMutationFrame, PROMPT_QUEUE_MAX_TOTAL_CONTENT_BYTES } from '@openclaude/protocol'
import { Value } from '@sinclair/typebox/value'

import {
  ContainerIdentityError,
  type ContainerIdentityRepo,
  verifyContainerIdentity,
} from '../auth/containerIdentity.js'
import { type Logger, rootLogger } from '../logging/logger.js'
import {
  PgPromptQueueStore,
  PromptQueueStoreError,
  type PromptQueueClaimRequest,
  type PromptQueueOwner,
} from '../promptQueue/pgPromptQueueStore.js'
import { REQUEST_ID_HEADER, ensureRequestId, setSecurityHeaders } from './util.js'

import {
  PROMPT_QUEUE_MUTATION_PATH,
  PROMPT_QUEUE_SNAPSHOT_PATH,
  PROMPT_QUEUE_DETAIL_PATH,
  PROMPT_QUEUE_CLAIM_PATH,
} from '@openclaude/protocol'

export {
  PROMPT_QUEUE_MUTATION_PATH,
  PROMPT_QUEUE_SNAPSHOT_PATH,
  PROMPT_QUEUE_DETAIL_PATH,
  PROMPT_QUEUE_CLAIM_PATH,
}

const SMALL_BODY_BYTES = 8 * 1024
const MUTATION_ENVELOPE_BYTES = 64 * 1024
const MUTATION_BODY_BYTES = PROMPT_QUEUE_MAX_TOTAL_CONTENT_BYTES + MUTATION_ENVELOPE_BYTES
const MUTATION_PARALLEL_BODY_BUDGET = 64 * 1024 * 1024
const MUTATION_MEMORY_RESERVE = 128 * 1024 * 1024
const VERSION_RE = /^(0|[1-9][0-9]*)$/
const ITEM_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const TURN_ID_RE = /^[0-9a-f]{64}$/
const TRACE_ID_RE = /^[A-Za-z0-9_-]{16,64}$/
const TOKEN_RE = /^[0-9a-f]{64}$/
const MEDIA_URL_RE = /^\/api\/media\/[0-9a-f]{64}\.[A-Za-z0-9]{1,32}$/

type PromptQueueStoreApi = Pick<PgPromptQueueStore, 'mutate' | 'getSnapshot' | 'getDetail' | 'claim'>

export interface PromptQueueHandlerDeps {
  identityRepo: ContainerIdentityRepo
  store: PromptQueueStoreApi
  logger?: Logger
}

export interface PromptQueueHandlerCtx {
  hostUuid: string
  boundIp: string
}

export type PromptQueueHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: PromptQueueHandlerCtx,
) => Promise<void>

export function isPromptQueueV1Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OC_PROMPT_QUEUE_V1 === '1'
}

export function makePromptQueueHandler(deps: PromptQueueHandlerDeps): PromptQueueHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: 'internalPromptQueue' })
  const mutationAdmission = new MutationBodyAdmission()
  return async (req, res, ctx) => {
    setSecurityHeaders(res)
    const requestId = ensureRequestId(req)
    res.setHeader(REQUEST_ID_HEADER, requestId)
    const path = (req.url ?? '/').split('?')[0]
    const reqLog = log.child({ requestId, path, hostUuid: ctx.hostUuid, boundIp: ctx.boundIp })

    if (req.method !== 'POST') {
      sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } })
      return
    }

    let identity: Awaited<ReturnType<typeof verifyContainerIdentity>>
    try {
      identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization)
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        reqLog.warn('identity_failed', { errcode: err.code })
        sendJson(res, 401, {
          error: { code: 'UNAUTHORIZED', message: 'container identity verification failed' },
        })
        return
      }
      throw err
    }

    const maxBytes = path === PROMPT_QUEUE_MUTATION_PATH ? MUTATION_BODY_BYTES : SMALL_BODY_BYTES
    try {
      const releaseAdmission = path === PROMPT_QUEUE_MUTATION_PATH
        ? mutationAdmission.reserve(req, maxBytes)
        : () => {}
      try {
        let body: unknown
        try {
          body = await readBoundedJson(req, maxBytes)
        } catch (err) {
          const tooLarge = err instanceof BodyTooLargeError
          sendJson(res, tooLarge ? 413 : 400, {
            error: {
              code: tooLarge ? 'BODY_TOO_LARGE' : 'INVALID_BODY',
              message: (err as Error).message,
            },
          })
          return
        }

        try {
          const parsed = parseCommonBody(body, BigInt(identity.userId))
          if (path === PROMPT_QUEUE_MUTATION_PATH) {
            assertOnlyKeys(body, ['owner', 'mutation'])
            const mutation = (body as Record<string, unknown>).mutation
            validateMutation(mutation, parsed.owner)
            const result = await deps.store.mutate(parsed.owner, mutation as PromptQueueMutationFrame)
            sendJson(res, 200, { ok: true, ...result })
            return
          }
          if (path === PROMPT_QUEUE_SNAPSHOT_PATH) {
            assertOnlyKeys(body, ['owner'])
            sendJson(res, 200, { ok: true, snapshot: await deps.store.getSnapshot(parsed.owner) })
            return
          }
          if (path === PROMPT_QUEUE_DETAIL_PATH) {
            assertOnlyKeys(body, ['owner', 'itemId'])
            const itemId = (body as Record<string, unknown>).itemId
            assertString('itemId', itemId, 128, ITEM_ID_RE)
            sendJson(res, 200, { ok: true, detail: await deps.store.getDetail(parsed.owner, itemId) })
            return
          }
          if (path === PROMPT_QUEUE_CLAIM_PATH) {
            assertOnlyKeys(body, ['owner', 'claim'])
            const claim = parseClaim((body as Record<string, unknown>).claim)
            const result = await deps.store.claim(parsed.owner, identity.containerId, claim)
            sendJson(res, 200, { ok: true, ...result })
            return
          }
          sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'not found' } })
        } catch (err) {
          if (err instanceof InvalidPromptQueueBodyError) {
            sendJson(res, 400, { error: { code: 'INVALID_BODY', message: err.message } })
            return
          }
          if (err instanceof PromptQueueStoreError) {
            const status = err.code === 'IDEMPOTENCY_CONFLICT' || err.code === 'CLAIM_CAS_MISMATCH'
              ? 409
              : err.code === 'QUEUE_LIMIT' || err.code === 'CONTENT_LIMIT'
                ? 413
                : err.code === 'ITEM_NOT_FOUND'
                  ? 404
                  : 400
            sendJson(res, status, { error: { code: err.code, message: err.message } })
            return
          }
          reqLog.error('prompt_queue_failed', { err: (err as Error).message })
          sendJson(res, 500, { error: { code: 'INTERNAL', message: 'prompt queue request failed' } })
        }
      } finally {
        releaseAdmission()
      }
    } catch (err) {
      if (
        err instanceof MutationAdmissionError
        || err instanceof BodyTooLargeError
        || err instanceof InvalidPromptQueueBodyError
      ) {
        const status = err instanceof BodyTooLargeError
          ? 413
          : err instanceof MutationAdmissionError ? err.status : 400
        sendJson(res, status, {
          error: {
            code: err instanceof BodyTooLargeError
              ? 'BODY_TOO_LARGE'
              : err instanceof MutationAdmissionError ? err.code : 'INVALID_BODY',
            message: err.message,
          },
        })
        return
      }
      throw err
    }
  }
}

function parseCommonBody(body: unknown, userId: bigint): { owner: PromptQueueOwner } {
  if (!isRecord(body)) throw new InvalidPromptQueueBodyError('object body required')
  if ('userId' in body) throw new InvalidPromptQueueBodyError('wire userId is forbidden')
  const raw = body.owner
  if (!isRecord(raw)) throw new InvalidPromptQueueBodyError('owner object required')
  assertOnlyKeys(raw, ['sessionKey', 'clientSessionId', 'agentId', 'peer'])
  assertString('sessionKey', raw.sessionKey, 512)
  assertString('clientSessionId', raw.clientSessionId, 128)
  assertString('agentId', raw.agentId, 64)
  if (!isRecord(raw.peer)) throw new InvalidPromptQueueBodyError('owner.peer object required')
  assertOnlyKeys(raw.peer, ['id', 'kind'])
  assertString('peer.id', raw.peer.id, 256)
  if (raw.peer.kind !== 'dm') throw new InvalidPromptQueueBodyError('owner.peer.kind must be dm')
  if (raw.clientSessionId !== raw.peer.id) {
    throw new InvalidPromptQueueBodyError('clientSessionId must equal peer.id')
  }
  const canonical = `agent:${raw.agentId}:webchat:dm:${raw.peer.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`
  if (raw.sessionKey !== canonical) throw new InvalidPromptQueueBodyError('non-canonical sessionKey')
  return {
    owner: {
      userId,
      sessionKey: raw.sessionKey,
      clientSessionId: raw.clientSessionId,
      agentId: raw.agentId,
      peer: { id: raw.peer.id, kind: 'dm' },
    },
  }
}

function validateMutation(value: unknown, owner: PromptQueueOwner): void {
  if (!Value.Check(PromptQueueMutationFrame, value) || !isRecord(value)) {
    throw new InvalidPromptQueueBodyError('mutation does not match P0 protocol')
  }
  const common = ['type', 'peer', 'agentId', 'itemId', 'expectedVersion', 'idempotencyKey']
  switch (value.type) {
    case 'inbound.prompt_queue.enqueue':
      assertOnlyKeys(value, ['type', 'peer', 'channel', 'agentId', 'itemId', 'clientMessageId',
        'observedVersion', 'idempotencyKey', 'content', 'requestedExecution'])
      if (value.channel !== 'webchat') throw new InvalidPromptQueueBodyError('channel must be webchat')
      validateContent(value.content)
      if (!isRecord(value.requestedExecution)) {
        throw new InvalidPromptQueueBodyError('requestedExecution object required')
      }
      assertOnlyKeys(value.requestedExecution, ['model', 'effortLevel', 'teamMode'])
      assertOptionalString('model', value.requestedExecution.model, 256)
      assertOptionalString('effortLevel', value.requestedExecution.effortLevel, 64, true)
      if (value.observedVersion !== undefined) assertString('observedVersion', value.observedVersion, 20, VERSION_RE)
      assertString('clientMessageId', value.clientMessageId, 128, ITEM_ID_RE)
      break
    case 'inbound.prompt_queue.edit':
      assertOnlyKeys(value, [...common, 'content'])
      validateContent(value.content)
      break
    case 'inbound.prompt_queue.delete':
      assertOnlyKeys(value, common)
      break
    case 'inbound.prompt_queue.reorder':
      assertOnlyKeys(value, ['type', 'peer', 'agentId', 'orderedItemIds', 'expectedVersion', 'idempotencyKey'])
      if (!Array.isArray(value.orderedItemIds) || value.orderedItemIds.length > 50) {
        throw new InvalidPromptQueueBodyError('orderedItemIds is invalid')
      }
      for (const id of value.orderedItemIds) assertString('orderedItemId', id, 128, ITEM_ID_RE)
      break
    case 'inbound.prompt_queue.interject':
      assertOnlyKeys(value, [...common, 'mode', 'expectedTurnId'])
      assertString('expectedTurnId', value.expectedTurnId, 64, TURN_ID_RE)
      break
    default:
      throw new InvalidPromptQueueBodyError('unknown mutation type')
  }
  if (!isRecord(value.peer)) throw new InvalidPromptQueueBodyError('mutation.peer object required')
  assertOnlyKeys(value.peer, ['id', 'kind', 'displayName'])
  assertString('mutation.peer.id', value.peer.id, 256)
  assertOptionalString('mutation.peer.displayName', value.peer.displayName, 256)
  if (value.peer.kind !== 'dm' || value.peer.id !== owner.peer.id || value.agentId !== owner.agentId) {
    throw new InvalidPromptQueueBodyError('mutation owner mismatch')
  }
  assertString('agentId', value.agentId, 64)
  assertString('idempotencyKey', value.idempotencyKey, 128)
  if ('itemId' in value) assertString('itemId', value.itemId, 128, ITEM_ID_RE)
  if ('expectedVersion' in value) assertString('expectedVersion', value.expectedVersion, 20, VERSION_RE)
}

function validateContent(value: unknown): void {
  if (!isRecord(value)) throw new InvalidPromptQueueBodyError('content object required')
  assertOnlyKeys(value, ['text', 'media', 'imageEdit'])
  if (value.text !== undefined && typeof value.text !== 'string') {
    throw new InvalidPromptQueueBodyError('content.text must be a string')
  }
  if (value.media !== undefined) {
    if (!Array.isArray(value.media) || value.media.length > 8) {
      throw new InvalidPromptQueueBodyError('content.media is invalid')
    }
    for (const media of value.media) {
      if (!isRecord(media)) throw new InvalidPromptQueueBodyError('media object required')
      assertOnlyKeys(media, ['kind', 'url', 'base64', 'mimeType', 'filename', 'hidden', 'localSrc'])
      if (!['image', 'audio', 'video', 'file'].includes(String(media.kind))) {
        throw new InvalidPromptQueueBodyError('media.kind is invalid')
      }
      if ('base64' in media || 'localSrc' in media) {
        throw new InvalidPromptQueueBodyError('inline or local media is forbidden')
      }
      assertString('media.url', media.url, 256, MEDIA_URL_RE)
      assertOptionalString('media.mimeType', media.mimeType, 128)
      assertOptionalString('media.filename', media.filename, 512)
    }
  }
  if (value.imageEdit !== undefined) {
    if (!isRecord(value.imageEdit)) throw new InvalidPromptQueueBodyError('imageEdit object required')
    assertOnlyKeys(value.imageEdit, ['clientJobId', 'mode', 'sourceIndex', 'maskIndex', 'guideIndex',
      'targetAspect', 'width', 'height'])
  }
}

function parseClaim(value: unknown): PromptQueueClaimRequest {
  if (!isRecord(value) || typeof value.action !== 'string') {
    throw new InvalidPromptQueueBodyError('claim object required')
  }
  if (value.action === 'acquire') {
    assertOnlyKeys(value, ['action', 'expectedVersion'])
    assertString('expectedVersion', value.expectedVersion, 20, VERSION_RE)
    return { action: 'acquire', expectedVersion: value.expectedVersion }
  }
  if (value.action === 'release') {
    assertOnlyKeys(value, ['action', 'epoch', 'claimToken', 'disposition', 'reasonCode'])
    assertString('epoch', value.epoch, 20, VERSION_RE)
    assertString('claimToken', value.claimToken, 64, TOKEN_RE)
    if (value.disposition !== 'retryable' && value.disposition !== 'user_action_required') {
      throw new InvalidPromptQueueBodyError('invalid release disposition')
    }
    assertOptionalString('reasonCode', value.reasonCode, 128)
    return {
      action: 'release',
      epoch: value.epoch,
      claimToken: value.claimToken,
      disposition: value.disposition,
      ...(typeof value.reasonCode === 'string' ? { reasonCode: value.reasonCode } : {}),
    }
  }
  if (value.action === 'activate') {
    assertOnlyKeys(value, ['action', 'epoch', 'claimToken', 'turnId', 'turnIndex', 'traceId', 'steerDelivery'])
    assertString('epoch', value.epoch, 20, VERSION_RE)
    assertString('claimToken', value.claimToken, 64, TOKEN_RE)
    assertString('turnId', value.turnId, 64, TURN_ID_RE)
    assertTurnIndex(value.turnIndex)
    if (value.traceId !== undefined) assertString('traceId', value.traceId, 64, TRACE_ID_RE)
    if (!['native', 'fork-native', 'turn-boundary'].includes(String(value.steerDelivery))) {
      throw new InvalidPromptQueueBodyError('invalid steerDelivery')
    }
    return {
      action: 'activate',
      epoch: value.epoch,
      claimToken: value.claimToken,
      turnId: value.turnId,
      turnIndex: value.turnIndex,
      ...(typeof value.traceId === 'string' ? { traceId: value.traceId } : {}),
      steerDelivery: value.steerDelivery as 'native' | 'fork-native' | 'turn-boundary',
    }
  }
  if (value.action === 'complete') {
    assertOnlyKeys(value, ['action', 'turnId', 'turnIndex'])
    assertString('turnId', value.turnId, 64, TURN_ID_RE)
    assertTurnIndex(value.turnIndex)
    return { action: 'complete', turnId: value.turnId, turnIndex: value.turnIndex }
  }
  if (value.action === 'interrupt_ack') {
    assertOnlyKeys(value, ['action', 'turnId'])
    assertString('turnId', value.turnId, 64, TURN_ID_RE)
    return { action: 'interrupt_ack', turnId: value.turnId }
  }
  throw new InvalidPromptQueueBodyError('unknown claim action')
}

function assertTurnIndex(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 2_147_483_647) {
    throw new InvalidPromptQueueBodyError('turnIndex must fit the non-negative PostgreSQL integer range')
  }
}

class InvalidPromptQueueBodyError extends Error {}
class BodyTooLargeError extends Error {}
class MutationAdmissionError extends Error {
  constructor(readonly status: 411 | 429 | 503, readonly code: string, message: string) {
    super(message)
  }
}

/**
 * The wire contract preserves the existing 300 MiB content ceiling, but JSON
 * parsing/canonicalization can require several copies. Admission therefore
 * requires Content-Length, bounds aggregate small requests to 64 MiB, makes a
 * larger request exclusive, and refuses it unless both V8 heap and system
 * memory have conservative headroom. One authenticated container cannot turn
 * the compatibility limit into unbounded shared-master concurrency.
 */
class MutationBodyAdmission {
  private reservedBytes = 0
  private exclusive = false

  reserve(req: IncomingMessage, maxBytes: number): () => void {
    const declared = parseDeclaredLength(req)
    if (declared === undefined) {
      throw new MutationAdmissionError(411, 'LENGTH_REQUIRED', 'mutation Content-Length required')
    }
    if (declared > maxBytes) throw new BodyTooLargeError(`body exceeds ${maxBytes} bytes`)

    const isLarge = declared > MUTATION_PARALLEL_BODY_BUDGET
    if (
      this.exclusive
      || (isLarge && this.reservedBytes !== 0)
      || (!isLarge && this.reservedBytes + declared > MUTATION_PARALLEL_BODY_BUDGET)
    ) {
      throw new MutationAdmissionError(429, 'BODY_CAPACITY_BUSY', 'prompt queue body capacity busy')
    }

    // Buffer + UTF-8 string + parsed graph + canonical/driver strings.
    const estimatedPeak = declared * 4 + MUTATION_MEMORY_RESERVE
    const heapAvailable = getHeapStatistics().heap_size_limit - process.memoryUsage().heapUsed
    if (estimatedPeak > heapAvailable || estimatedPeak > freemem()) {
      throw new MutationAdmissionError(503, 'MEMORY_PRESSURE', 'insufficient memory for bounded mutation')
    }

    this.reservedBytes += declared
    if (isLarge) this.exclusive = true
    let released = false
    return () => {
      if (released) return
      released = true
      this.reservedBytes -= declared
      if (isLarge) this.exclusive = false
    }
  }
}

function parseDeclaredLength(req: IncomingMessage): number | undefined {
  const declared = req.headers['content-length']
  if (Array.isArray(declared) || (declared !== undefined && !/^[0-9]+$/.test(declared))) {
    throw new InvalidPromptQueueBodyError('invalid content-length')
  }
  if (declared === undefined) return undefined
  const parsed = Number(declared)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new InvalidPromptQueueBodyError('invalid content-length')
  }
  return parsed
}

async function readBoundedJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const declared = parseDeclaredLength(req)
  if (declared !== undefined && declared > maxBytes) {
    throw new BodyTooLargeError(`body exceeds ${maxBytes} bytes`)
  }
  if (declared !== undefined) {
    if (declared === 0) throw new InvalidPromptQueueBodyError('empty body')
    const buffer = Buffer.allocUnsafe(declared)
    let offset = 0
    for await (const chunk of req) {
      const bytes = chunk instanceof Buffer ? chunk : Buffer.from(chunk as string)
      if (offset + bytes.length > declared || offset + bytes.length > maxBytes) {
        throw new BodyTooLargeError(`body exceeds declared or maximum length`)
      }
      bytes.copy(buffer, offset)
      offset += bytes.length
    }
    if (offset !== declared) throw new InvalidPromptQueueBodyError('content-length mismatch')
    return JSON.parse(buffer.toString('utf8'))
  }

  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const bytes = chunk instanceof Buffer ? chunk : Buffer.from(chunk as string)
    total += bytes.length
    if (total > maxBytes) throw new BodyTooLargeError(`body exceeds ${maxBytes} bytes`)
    chunks.push(bytes)
  }
  if (total === 0) throw new InvalidPromptQueueBodyError('empty body')
  return JSON.parse(Buffer.concat(chunks, total).toString('utf8'))
}

function assertOnlyKeys(value: unknown, allowed: readonly string[]): void {
  if (!isRecord(value)) throw new InvalidPromptQueueBodyError('object required')
  const allowedSet = new Set(allowed)
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key))
  if (unknown) throw new InvalidPromptQueueBodyError(`unknown field: ${unknown}`)
}

function assertString(
  name: string,
  value: unknown,
  maxBytes: number,
  pattern?: RegExp,
): asserts value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value, 'utf8') > maxBytes
    || (pattern && !pattern.test(value))
  ) {
    throw new InvalidPromptQueueBodyError(`${name} is invalid`)
  }
}

function assertOptionalString(name: string, value: unknown, maxBytes: number, allowNull = false): void {
  if (value === undefined || (allowNull && value === null)) return
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new InvalidPromptQueueBodyError(`${name} is invalid`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return
  const json = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', String(Buffer.byteLength(json, 'utf8')))
  res.end(json)
}
