import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  ContainerIdentityError,
  type ContainerIdentityRepo,
  verifyContainerIdentity,
} from '../auth/containerIdentity.js'
import { type Logger, rootLogger } from '../logging/logger.js'
import {
  CoreMemoryRankQueue,
  type CoreMemoryRankDocument,
  type CoreMemoryRankedDocument,
} from './coreMemoryLocalRanker.js'
import { REQUEST_ID_HEADER, ensureRequestId, setSecurityHeaders } from './util.js'

export const CORE_MEMORY_RANK_PATH = '/internal/v3/core-memory-rank'

export interface CoreMemoryRankCtx {
  hostUuid: string
  boundIp: string
}

export interface CoreMemoryRankDeps {
  identityRepo: ContainerIdentityRepo
  logger?: Logger
  /** Test seam. Production uses one process-wide FIFO-backed local q8 ranker. */
  rankQueue?: Pick<CoreMemoryRankQueue, 'rank'>
}

export type CoreMemoryRankHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: CoreMemoryRankCtx,
) => Promise<void>

const MAX_BODY_BYTES = 512 * 1024
const MAX_QUERY_LENGTH = 8_000
const MAX_DOCUMENTS = 48
const MAX_DOCUMENT_ID_LENGTH = 128
const MAX_DOCUMENT_TEXT_LENGTH = 12_000

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify({ ...(body as object), requestId }))
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function parseRequest(raw: string): { query: string; documents: CoreMemoryRankDocument[] } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const value = parsed as Record<string, unknown>
  if (typeof value.query !== 'string') return null
  const query = value.query.trim()
  if (!query || query.length > MAX_QUERY_LENGTH) return null
  if (
    !Array.isArray(value.documents) ||
    value.documents.length === 0 ||
    value.documents.length > MAX_DOCUMENTS
  ) {
    return null
  }
  const ids = new Set<string>()
  const documents: CoreMemoryRankDocument[] = []
  for (const rawDocument of value.documents) {
    if (!rawDocument || typeof rawDocument !== 'object') return null
    const document = rawDocument as Record<string, unknown>
    if (typeof document.id !== 'string' || typeof document.text !== 'string') return null
    if (
      !document.id ||
      document.id.length > MAX_DOCUMENT_ID_LENGTH ||
      !document.text.trim() ||
      document.text.length > MAX_DOCUMENT_TEXT_LENGTH ||
      ids.has(document.id)
    ) {
      return null
    }
    ids.add(document.id)
    documents.push({ id: document.id, text: document.text })
  }
  return { query, documents }
}

function isValidRanking(
  ranked: CoreMemoryRankedDocument[],
  documents: CoreMemoryRankDocument[],
): boolean {
  if (ranked.length !== documents.length) return false
  const expected = new Set(documents.map((document) => document.id))
  for (const item of ranked) {
    if (!expected.delete(item.id) || !Number.isFinite(item.score)) return false
  }
  return expected.size === 0
}

export function makeCoreMemoryRankHandler(deps: CoreMemoryRankDeps): CoreMemoryRankHandler {
  const queue = deps.rankQueue ?? new CoreMemoryRankQueue()
  const log = (deps.logger ?? rootLogger).child({ subsys: 'internalCoreMemoryRank' })

  return async function handle(req, res, ctx) {
    setSecurityHeaders(res)
    const requestId = ensureRequestId(req)
    res.setHeader(REQUEST_ID_HEADER, requestId)
    const reqLog = log.child({ requestId, hostUuid: ctx.hostUuid, boundIp: ctx.boundIp })

    if ((req.method ?? 'GET') !== 'POST') {
      sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only' } }, requestId)
      return
    }

    let identity: Awaited<ReturnType<typeof verifyContainerIdentity>>
    try {
      identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization)
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        reqLog.warn('identity_failed', { errcode: err.code })
        sendJson(
          res,
          401,
          { error: { code: 'UNAUTHORIZED', message: 'identity verification failed' } },
          requestId,
        )
        return
      }
      throw err
    }

    let body: string
    try {
      body = await readBody(req)
    } catch {
      if (!res.destroyed) {
        sendJson(res, 413, { error: { code: 'BODY_TOO_LARGE', message: 'body too large' } }, requestId)
      }
      return
    }
    const parsed = parseRequest(body)
    if (!parsed) {
      sendJson(
        res,
        400,
        { error: { code: 'BAD_REQUEST', message: 'invalid core-memory-rank request' } },
        requestId,
      )
      return
    }

    const abort = new AbortController()
    const cancel = () => abort.abort()
    req.once('aborted', cancel)
    res.once('close', cancel)
    const startedAt = Date.now()
    try {
      const ranked = await queue.rank(
        parsed.query,
        parsed.documents,
        abort.signal,
        `user:${identity.userId}`,
      )
      if (abort.signal.aborted || res.destroyed) return
      if (!isValidRanking(ranked, parsed.documents)) throw new Error('invalid local ranking')
      reqLog.info('core_memory_rank_ok', {
        uid: identity.userId,
        containerId: identity.containerId,
        documents: parsed.documents.length,
        durationMs: Date.now() - startedAt,
      })
      sendJson(res, 200, { ok: true, ranked }, requestId)
    } catch {
      if (abort.signal.aborted || res.destroyed) return
      reqLog.warn('core_memory_rank_failed', {
        uid: identity.userId,
        containerId: identity.containerId,
        documents: parsed.documents.length,
        durationMs: Date.now() - startedAt,
      })
      sendJson(res, 200, { ok: false, reason: 'local_rank_error' }, requestId)
    } finally {
      req.off('aborted', cancel)
      res.off('close', cancel)
    }
  }
}
