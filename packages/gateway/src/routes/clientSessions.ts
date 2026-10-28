import { isClientMessageId } from '@openclaude/protocol'
/**
 * Client session HTTP routes (/api/sessions/*), moved verbatim out of
 * Gateway._handleHttpAfterCommercial (FINDINGS §7 step 2a, OCV5-465) following
 * the routes/<domain>.ts pattern of httpIo.ts: same branches in the same order,
 * same responses; a branch that handled the request returns true. The Gateway
 * calls this at the spot the inline block used to be.
 *
 * Dependencies are the narrow ClientSessionsHttpIo below instead of the whole
 * Gateway: what this block actually needs from it is now explicit.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import {
  isLiveUnitsEnabled,
  isPersistedClientMessageId,
  normalizeMessageReplyQuote,
} from '@openclaude/protocol'
import {
  ClientTimelineCursorStaleError,
  SESSION_LIST_LIMIT_MAX,
  SESSION_SEARCH_LIMIT_DEFAULT,
  SESSION_SEARCH_LIMIT_MAX,
  SESSION_SEARCH_Q_MAX,
  appendServerAuthoredMessage,
  batchClientSessions,
  claimSession,
  classifyClientSessions,
  decodeClientTimelineCursor,
  deleteClientSession,
  encodeClientTimelineCursor,
  getClientSession,
  getClientSessionPartial,
  listClientSessions,
  listTurnTapeRecords,
  listUnclaimedSessions,
  markAllClientSessionsRead,
  markClientSessionRead,
  parseIncludeArchivedFlag,
  parseOptionalPositiveInt,
  parseSessionBatchInput,
  patchClientSessionMeta,
  readArchivedMessages,
  readClientSessionLiveFrames,
  readClientSessionLiveUnits,
  readClientTimelinePage,
  readLiveOrTapeFramePayload,
  readTapeRecordPayloadChunk,
  readUserMessagePayload,
  searchClientSessions,
  upsertClientSession,
} from '@openclaude/storage'
import type { AdvisorConfigStore } from '../advisorConfigStore.js'
import { handleInflightDelegatesRequest } from '../delegateInflightSurface.js'
import type { DelegateInflightSurfaceStore } from '../delegateInflightSurface.js'
import type { DelegateJobStore } from '../delegateJobs.js'
import { isDelegateInflightSurfaceEffective } from '../delegateSmFlag.js'
import { parseByteRange } from '../httpRange.js'
import {
  attachPermissionSnapshotIfMissing,
  parsePermissionLookupQuery,
} from '../pendingPermissionSnapshot.js'
import type { SessionManager } from '../sessionManager.js'
import { isPatrolSessionKey } from '../taskboard/domain.js'
import { handleChatProjectsHttp } from './chatProjects.js'
import type { GatewayHttpIo } from './httpIo.js'
import { handleProjectAssetsHttp } from './projectAssets.js'

export interface ClientSessionsHttpIo extends GatewayHttpIo {
  sendSessionReadFailure(
    res: ServerResponse,
    error: unknown,
    sessionId: string,
    publicError: string,
  ): void
  listSessions: SessionManager['list']
  preheatSessionOnOpen(
    sessId: string,
    userId: string,
    row: { agentId?: string; modelId?: string },
  ): void
  pendingPermissions: Parameters<typeof attachPermissionSnapshotIfMissing>[1]
  delegateJobs(): DelegateJobStore | undefined
  ensureDelegateInflightSurface(): DelegateInflightSurfaceStore
  advisorConfigStore(): AdvisorConfigStore
}

export function handleClientSessionsHttp(
  io: ClientSessionsHttpIo,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): boolean {
  if (url.pathname === '/api/sessions') {
    // Filter live sessions to those belonging to the authenticated user.
    // Session keys contain the peerId (which is the client session ID);
    // we match against client_sessions owned by this userId.
    const userId = io.getUserId(req)
    const allLive = io.listSessions()
    // For multi-user: only show sessions whose peerId belongs to this user
    listClientSessions(userId)
      .then((owned) => {
        const ownedIds = new Set(owned.sessions.map((s) => s.id))
        // Also include sessions with no matching client session (cron/task sessions) only for default user
        const filtered = filterUserVisibleLiveSessions(allLive, ownedIds, userId)
        io.sendJson(res, 200, { sessions: filtered })
      })
      .catch(() => io.sendJson(res, 200, { sessions: [] }))
    return true
  }
  // ── Client session sync (cross-device, multi-user) ──
  if (url.pathname === '/api/sessions/list' && req.method === 'GET') {
    const userId = io.getUserId(req)
    const includeArchived = parseIncludeArchivedFlag(url.searchParams.get('includeArchived'))
    const limitRaw = url.searchParams.get('limit')
    const beforeRaw = url.searchParams.get('before')
    let limit: number | undefined
    let before: number | undefined
    if (limitRaw !== null && limitRaw !== '') {
      const n = Number(limitRaw)
      if (!Number.isFinite(n) || n <= 0) {
        io.sendJson(res, 400, { error: 'limit must be a positive integer' })
        return true
      }
      limit = Math.min(SESSION_LIST_LIMIT_MAX, Math.floor(n))
    }
    if (beforeRaw !== null && beforeRaw !== '') {
      const n = Number(beforeRaw)
      if (!Number.isFinite(n) || n <= 0) {
        io.sendJson(res, 400, { error: 'before must be a positive millisecond timestamp' })
        return true
      }
      before = Math.floor(n)
    }
    listClientSessions(userId, { includeArchived, limit, before })
      .then((list) =>
        io.sendJson(res, 200, {
          sessions: list.sessions,
          ...(list.nextCursor !== undefined ? { nextCursor: list.nextCursor } : {}),
        }),
      )
      .catch(() => io.sendJson(res, 500, { error: 'list failed' }))
    return true
  }
  if (url.pathname === '/api/sessions/search' && req.method === 'GET') {
    const userId = io.getUserId(req)
    const q = (url.searchParams.get('q') ?? '').trim()
    if (q.length > SESSION_SEARCH_Q_MAX) {
      io.sendJson(res, 400, { error: `q too long (max ${SESSION_SEARCH_Q_MAX} chars)` })
      return true
    }
    const limit = parseOptionalPositiveInt(
      url.searchParams.get('limit'),
      SESSION_SEARCH_LIMIT_DEFAULT,
      SESSION_SEARCH_LIMIT_MAX,
    )
    const includeArchived = parseIncludeArchivedFlag(url.searchParams.get('includeArchived'))
    const projectRaw = url.searchParams.get('projectId')
    const projectId =
      projectRaw === null || projectRaw === '' || projectRaw === 'all'
        ? undefined
        : projectRaw === 'none'
          ? null
          : projectRaw.trim()
    if (projectId && (projectId.length < 8 || projectId.length > 64)) {
      io.sendJson(res, 400, { error: 'invalid projectId' })
      return true
    }
    searchClientSessions(userId, { q, limit, includeArchived, projectId })
      .then((out) => io.sendJson(res, 200, out))
      .catch(() => io.sendJson(res, 500, { error: 'search failed' }))
    return true
  }
  if (url.pathname === '/api/sessions/batch' && req.method === 'POST') {
    const userId = io.getUserId(req)
    ;(async () => {
      let data: {
        ids?: unknown
        action?: unknown
        projectId?: unknown
        expectedSessions?: unknown
        operationId?: unknown
      }
      try {
        data = JSON.parse(await io.readBody(req, 64 * 1024))
      } catch {
        io.sendJson(res, 400, { error: 'invalid JSON' })
        return
      }
      const parsed = parseSessionBatchInput(data)
      if ('ok' in parsed && parsed.ok === false) {
        if (parsed.error === 'ids_limit') {
          io.sendJson(res, 400, { error: 'ids limit exceeded (max 200)' })
          return
        }
        if (parsed.error === 'invalid_action') {
          io.sendJson(res, 400, { error: 'action must be archive, unarchive, delete or move' })
          return
        }
        io.sendJson(res, 400, { error: 'ids required (string array)' })
        return
      }
      const result = await batchClientSessions(userId, data)
      if (!result.ok) {
        if (result.error === 'project_not_found') {
          io.sendJson(res, 404, { error: 'project not found' })
          return
        }
        if (result.error === 'stale_session') {
          io.sendJson(res, 409, {
            error: 'stale session',
            code: 'stale_session',
            staleIds: result.staleIds ?? [],
          })
          return
        }
        io.sendJson(res, 400, { error: result.error.replace(/_/g, ' ') })
        return
      }
      io.sendJson(res, 200, result)
    })().catch(() => io.sendJson(res, 500, { error: 'batch failed' }))
    return true
  }
  if (url.pathname === '/api/sessions/read-all' && req.method === 'POST') {
    const userId = io.getUserId(req)
    markAllClientSessionsRead(userId)
      .then((out) => io.sendJson(res, 200, { ok: true, updated: out.updated }))
      .catch(() => io.sendJson(res, 500, { error: 'read-all failed' }))
    return true
  }
  // 侧栏聊天项目(与 /api/board/projects 看板无关)。浏览器直打 gateway,与 /api/sessions/list 同平面。
  // 路由本体在 routes/chatProjects.ts(OCV5-376 P2,原样搬出)。
  if (handleChatProjectsHttp(io, req, res, url)) return true
  // 聊天项目资产(上传参考资料 + 会话产出物索引)。浏览器直打 gateway,与 /api/chat-projects 同平面。
  // 路由本体在 routes/projectAssets.ts(OCV5-376 P2,原样搬出)。
  if (handleProjectAssetsHttp(io, req, res, url)) return true
  // ── Session migration (must be before clientSessMatch regex which would capture "unclaimed"/"claim") ──
  if (url.pathname === '/api/sessions/unclaimed' && req.method === 'GET') {
    listUnclaimedSessions()
      .then((list) => io.sendJson(res, 200, { sessions: list }))
      .catch(() => io.sendJson(res, 500, { error: 'list failed' }))
    return true
  }
  if (url.pathname === '/api/sessions/claim' && req.method === 'POST') {
    const userId = io.getUserId(req)
    io.readBody(req)
      .then(async (body) => {
        const { sessionIds } = JSON.parse(body) as { sessionIds: string[] }
        if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
          io.sendJson(res, 400, { error: 'sessionIds required' })
          return
        }
        const results: Record<string, boolean> = {}
        for (const sid of sessionIds) {
          results[sid] = await claimSession(sid, userId)
        }
        io.sendJson(res, 200, { ok: true, results })
      })
      .catch(() => io.sendJson(res, 400, { error: 'invalid body' }))
    return true
  }
  // 持久化「用户发送的消息」到 master(跨设备/换浏览器可见)。前端发消息后调用,带自己的
  // 客户端消息 id —— getSession 回带同 id,前端合并天然去重(不与本地乐观 user 重复)。
  // 直写(appendServerAuthoredMessage,绕乐观并发,scoped by userId),只构造 role:'user',
  // 客户端无法注入 role/usage/_source/billing。会话行须先存在(前端 ensureServerSession 已建)。
  const userMsgMatch = url.pathname.match(/^\/api\/sessions\/([a-zA-Z0-9_-]{8,50})\/user-message$/)
  if (userMsgMatch && req.method === 'POST') {
    const sessId = userMsgMatch[1]
    const userId = io.getUserId(req)
    ;(async () => {
      let body: string
      try {
        body = await io.readBody(req, 4 * 1024 * 1024)
      } catch (error) {
        if (error instanceof Error && error.message === 'body too large') {
          io.sendJson(res, 413, { error: 'request body too large', maxBytes: 4 * 1024 * 1024 })
        } else {
          io.sendJson(res, 400, { error: 'invalid body' })
        }
        return
      }
      let data: {
        id?: unknown
        text?: unknown
        ts?: unknown
        media?: unknown
        _retryMedia?: unknown
        _imageEdit?: unknown
        _modelText?: unknown
        _replyTo?: unknown
        _routing?: unknown
        _sendAttempt?: unknown
        _isAutoRetry?: unknown
        _recoveryOfClientMessageId?: unknown
        _recoveryMode?: unknown
        _automaticRecovery?: unknown
        _idem?: unknown
      }
      try {
        data = JSON.parse(body)
      } catch {
        io.sendJson(res, 400, { error: 'invalid JSON' })
        return
      }
      if (!isPersistedClientMessageId(data.id) || typeof data.text !== 'string') {
        io.sendJson(res, 400, { error: 'id+text required' })
        return
      }
      const rawRouting =
        data._routing && typeof data._routing === 'object' && !Array.isArray(data._routing)
          ? (data._routing as { model?: unknown; teamMode?: unknown; effortLevel?: unknown })
          : undefined
      const routing = rawRouting
        ? {
            ...(typeof rawRouting.model === 'string' ? { model: rawRouting.model } : {}),
            ...(typeof rawRouting.teamMode === 'boolean' ? { teamMode: rawRouting.teamMode } : {}),
            ...(typeof rawRouting.effortLevel === 'string' || rawRouting.effortLevel === null
              ? { effortLevel: rawRouting.effortLevel }
              : {}),
          }
        : undefined
      const replyTo = normalizeMessageReplyQuote(data._replyTo)
      const msg = {
        id: data.id,
        role: 'user' as const,
        // Persist exactly what the user sent. The former 200k-character
        // slice silently changed the conversation and was indistinguishable
        // from an Agent/model failure in a long prompt.
        text: data.text,
        ts: typeof data.ts === 'number' && Number.isFinite(data.ts) ? data.ts : Date.now(),
        ...(Array.isArray(data.media) ? { _media: data.media } : {}),
        ...(Array.isArray(data._retryMedia) ? { _retryMedia: data._retryMedia } : {}),
        ...(data._imageEdit &&
        typeof data._imageEdit === 'object' &&
        !Array.isArray(data._imageEdit)
          ? { _imageEdit: data._imageEdit }
          : {}),
        ...(typeof data._modelText === 'string' ? { _modelText: data._modelText } : {}),
        ...(replyTo ? { _replyTo: replyTo } : {}),
        ...(routing ? { _routing: routing } : {}),
        ...(typeof data._sendAttempt === 'number' &&
        Number.isSafeInteger(data._sendAttempt) &&
        data._sendAttempt >= 0
          ? { _sendAttempt: data._sendAttempt }
          : {}),
        ...(typeof data._isAutoRetry === 'boolean' ? { _isAutoRetry: data._isAutoRetry } : {}),
        ...(isPersistedClientMessageId(data._recoveryOfClientMessageId)
          ? { _recoveryOfClientMessageId: data._recoveryOfClientMessageId }
          : {}),
        ...(data._recoveryMode === 'checkpoint' || data._recoveryMode === 'replay'
          ? { _recoveryMode: data._recoveryMode }
          : {}),
        ...(typeof data._automaticRecovery === 'boolean'
          ? { _automaticRecovery: data._automaticRecovery }
          : {}),
        ...(typeof data._idem === 'string' ? { _idem: data._idem } : {}),
      }
      const r = await appendServerAuthoredMessage(sessId, userId, msg)
      if (r.applied) io.sendJson(res, 200, { ok: true })
      else if (r.reason === 'already_exists') io.sendJson(res, 200, { ok: true, idempotent: true })
      else if (r.reason === 'session_not_found')
        io.sendJson(res, 404, { error: 'session_not_found' })
      else if (r.reason === 'session_deleted') io.sendJson(res, 410, { error: 'session_deleted' })
      else if (r.reason === 'oversized')
        io.sendJson(res, 413, { error: 'session too large', reason: 'oversized' })
      else io.sendJson(res, 409, { error: r.reason ?? 'conflict' })
    })().catch(() => io.sendJson(res, 500, { error: 'append failed' }))
    return true
  }
  // Raw immutable record payload. The response is the exact post-redaction
  // JSON bytes committed in client_session_turn_tape_records. Range is
  // supported, while a normal GET streams the entire record in bounded DB
  // windows with HTTP backpressure; the window size is never a content cap.
  const tapePayloadMatch = url.pathname.match(
    /^\/api\/sessions\/([a-zA-Z0-9_-]{8,50})\/tape\/([A-Za-z0-9_-]{8,128})\/records\/([0-9]+)\/payload$/,
  )
  if (tapePayloadMatch) {
    const sessId = tapePayloadMatch[1]
    const tapeId = tapePayloadMatch[2]
    const recordOrdinal = Number(tapePayloadMatch[3])
    const userId = io.getUserId(req)
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !Number.isSafeInteger(recordOrdinal)) {
      io.sendJson(res, req.method === 'GET' || req.method === 'HEAD' ? 400 : 405, {
        error:
          req.method === 'GET' || req.method === 'HEAD' ? 'invalid ordinal' : 'method not allowed',
      })
      return true
    }
    ;(async () => {
      const head = await readTapeRecordPayloadChunk(sessId, userId, tapeId, recordOrdinal, 0, 1)
      if (!head) {
        io.sendJson(res, 404, { error: 'not found' })
        return
      }
      const rawRange = req.headers.range
      const rangeHeader = Array.isArray(rawRange) ? rawRange[0] : rawRange
      const range = parseByteRange(rangeHeader, head.totalBytes)
      const start = range?.start ?? 0
      const endExclusive = range ? range.end + 1 : head.totalBytes
      const contentLength = Math.max(0, endExclusive - start)
      res.writeHead(range ? 206 : 200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': contentLength,
        'Accept-Ranges': 'bytes',
        ETag: `"${head.contentSha256}"`,
        ..._immutableRecordIdHeaders(head.msgId),
        'X-OpenClaude-Record-Role': head.role,
        'X-OpenClaude-Content-Sha256': head.contentSha256,
        ...(range
          ? { 'Content-Range': `bytes ${start}-${endExclusive - 1}/${head.totalBytes}` }
          : {}),
      })
      if (req.method === 'HEAD' || contentLength === 0) {
        res.end()
        return
      }
      let offset = start
      while (offset < endExclusive && !res.destroyed) {
        const part = await readTapeRecordPayloadChunk(
          sessId,
          userId,
          tapeId,
          recordOrdinal,
          offset,
          Math.min(1024 * 1024, endExclusive - offset),
        )
        if (
          !part ||
          part.start !== offset ||
          part.endExclusive <= offset ||
          part.contentSha256 !== head.contentSha256 ||
          part.totalBytes !== head.totalBytes
        ) {
          res.destroy(new Error('immutable tape payload changed during stream'))
          return
        }
        offset = part.endExclusive
        if (!res.write(part.chunk)) {
          if (res.destroyed) return
          const drained = await new Promise<boolean>((resolve) => {
            const finish = (value: boolean) => {
              res.off('drain', onDrain)
              res.off('close', onClose)
              res.off('error', onClose)
              resolve(value)
            }
            const onDrain = () => finish(true)
            const onClose = () => finish(false)
            res.once('drain', onDrain)
            res.once('close', onClose)
            res.once('error', onClose)
          })
          if (!drained) return
        }
      }
      if (!res.destroyed) res.end()
    })().catch((error) => {
      if (!res.headersSent) io.sendJson(res, 500, { error: 'tape payload read failed' })
      else res.destroy(error as Error)
    })
    return true
  }

  // Oversized user messages use the same exact lazy-payload contract as
  // immutable Agent records. The hot session row contains only a locator;
  // mounted browser rows reconstruct the original user JSON via HEAD +
  // Range without imposing a message-size ceiling.
  const userPayloadMatch = url.pathname.match(
    /^\/api\/sessions\/([a-zA-Z0-9_-]{8,50})\/messages\/([^/]{1,240})\/payload$/,
  )
  if (userPayloadMatch) {
    const sessId = userPayloadMatch[1]
    let msgId = ''
    try {
      msgId = decodeURIComponent(userPayloadMatch[2])
    } catch {
      io.sendJson(res, 400, { error: 'invalid message id' })
      return true
    }
    const userId = io.getUserId(req)
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !isPersistedClientMessageId(msgId)) {
      io.sendJson(res, req.method === 'GET' || req.method === 'HEAD' ? 400 : 405, {
        error:
          req.method === 'GET' || req.method === 'HEAD'
            ? 'invalid message id'
            : 'method not allowed',
      })
      return true
    }
    ;(async () => {
      const head = await readUserMessagePayload(sessId, userId, msgId, 0, 1)
      if (!head) {
        io.sendJson(res, 404, { error: 'not found' })
        return
      }
      const rawRange = req.headers.range
      const rangeHeader = Array.isArray(rawRange) ? rawRange[0] : rawRange
      const range = parseByteRange(rangeHeader, head.totalBytes)
      const start = range?.start ?? 0
      const endExclusive = range ? range.end + 1 : head.totalBytes
      const contentLength = Math.max(0, endExclusive - start)
      res.writeHead(range ? 206 : 200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': contentLength,
        'Accept-Ranges': 'bytes',
        ETag: `"${head.contentSha256}"`,
        ..._immutableRecordIdHeaders(head.msgId),
        'X-OpenClaude-Record-Role': head.role,
        'X-OpenClaude-Content-Sha256': head.contentSha256,
        ...(range
          ? { 'Content-Range': `bytes ${start}-${endExclusive - 1}/${head.totalBytes}` }
          : {}),
      })
      if (req.method === 'HEAD' || contentLength === 0) {
        res.end()
        return
      }
      let offset = start
      while (offset < endExclusive && !res.destroyed) {
        const part = await readUserMessagePayload(
          sessId,
          userId,
          msgId,
          offset,
          Math.min(1024 * 1024, endExclusive - offset),
        )
        if (
          !part ||
          part.offset !== offset ||
          part.payload.length === 0 ||
          part.msgId !== head.msgId ||
          part.role !== head.role ||
          part.contentSha256 !== head.contentSha256 ||
          part.totalBytes !== head.totalBytes
        ) {
          res.destroy(new Error('immutable user payload changed during stream'))
          return
        }
        offset += part.payload.length
        if (!res.write(part.payload)) {
          if (res.destroyed) return
          const drained = await new Promise<boolean>((resolve) => {
            const finish = (value: boolean) => {
              res.off('drain', onDrain)
              res.off('close', onClose)
              res.off('error', onClose)
              resolve(value)
            }
            const onDrain = () => finish(true)
            const onClose = () => finish(false)
            res.once('drain', onDrain)
            res.once('close', onClose)
            res.once('error', onClose)
          })
          if (!drained) return
        }
      }
      if (!res.destroyed) res.end()
    })().catch((error) => {
      if (!res.headersSent) io.sendJson(res, 500, { error: 'user payload read failed' })
      else res.destroy(error as Error)
    })
    return true
  }

  // Cursor-page every immutable physical/logical turn record. Large records
  // return metadata plus the payload URL above; no generated content is
  // shortened or replaced.
  const tapeRecordsMatch = url.pathname.match(
    /^\/api\/sessions\/([a-zA-Z0-9_-]{8,50})\/tape\/([A-Za-z0-9_-]{8,128})\/records$/,
  )
  if (tapeRecordsMatch) {
    const sessId = tapeRecordsMatch[1]
    const tapeId = tapeRecordsMatch[2]
    const userId = io.getUserId(req)
    if (req.method !== 'GET') {
      io.sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    const cursorRaw = Number(url.searchParams.get('cursor'))
    const limitRaw = Number(url.searchParams.get('limit'))
    const cursor = Number.isSafeInteger(cursorRaw) && cursorRaw > 0 ? cursorRaw : 0
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 200
    const beforeRaw = url.searchParams.get('before')
    let before: number | null | undefined
    if (beforeRaw !== null) {
      if (beforeRaw === 'tail') before = null
      else {
        const parsed = Number(beforeRaw)
        if (!Number.isSafeInteger(parsed) || parsed <= 0) {
          io.sendJson(res, 400, { error: 'before must be tail or a positive ordinal' })
          return true
        }
        before = parsed
      }
    }
    listTurnTapeRecords(sessId, userId, tapeId, cursor, limit, before)
      .then((result) =>
        result ? io.sendJson(res, 200, result) : io.sendJson(res, 404, { error: 'not found' }),
      )
      .catch(() => io.sendJson(res, 500, { error: 'tape records read failed' }))
    return true
  }

  // One real chronological history stream. The opaque cursor can resume
  // inside an immutable tape physical record sequence; scroll position is a
  // UI concern and never triggers this endpoint automatically.
  const timelineMatch = url.pathname.match(/^\/api\/sessions\/([a-zA-Z0-9_-]{8,50})\/timeline$/)
  if (timelineMatch) {
    const sessId = timelineMatch[1]
    const userId = io.getUserId(req)
    if (req.method !== 'GET') {
      io.sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    const rawCursor = url.searchParams.get('cursor')
    const cursor = rawCursor === null ? null : decodeClientTimelineCursor(rawCursor)
    if (rawCursor !== null && cursor === null) {
      io.sendJson(res, 400, { error: 'invalid timeline cursor' })
      return true
    }
    const rawLimit = Number(url.searchParams.get('limit'))
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(200, Math.floor(rawLimit)) : 100
    readClientTimelinePage(sessId, userId, cursor, limit)
      .then((page) => {
        if (!page) {
          io.sendJson(res, 404, { error: 'not found' })
          return
        }
        io.sendJson(res, 200, {
          messages: page.messages,
          nextCursor: page.nextCursor ? encodeClientTimelineCursor(page.nextCursor) : null,
          hasMore: page.hasMore,
          timelineGeneration: page.timelineGeneration,
          historyRevision: page.historyRevision,
          snapshotMaxSeq: page.snapshotMaxSeq,
        })
      })
      .catch((error: unknown) => {
        if (error instanceof ClientTimelineCursorStaleError) {
          io.sendJson(res, 409, { error: 'timeline cursor stale', code: 'TIMELINE_CURSOR_STALE' })
        } else {
          io.sendSessionReadFailure(res, error, sessId, 'timeline read failed')
        }
      })
    return true
  }

  // 归档分页端点(长会话热尾巴+归档 §2.1):GET /api/sessions/:id/archive?before=<seq>&limit=<n>
  // 与下面 /api/sessions/:id 同款按 userId 分租(readArchivedMessages 内部 WHERE user_id=?
  // → userA 永远拿不到 userB 的归档)。commercial 侧 router.ts 的 BLOCKED_FOR_USER_RULES
  // 只拦 /api/sessions/(unclaimed|claim),本子路径不匹配 → 自动透传给本 handler。
  const archiveMatch = url.pathname.match(/^\/api\/sessions\/([a-zA-Z0-9_-]{8,50})\/archive$/)
  if (archiveMatch) {
    const sessId = archiveMatch[1]
    const userId = io.getUserId(req)
    if (req.method !== 'GET') {
      io.sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    const { beforeSeq, limit } = _parseArchiveQuery(
      url.searchParams.get('before'),
      url.searchParams.get('limit'),
    )
    // readArchivedMessages 直通:{ messages(升序), hasMore, oldestSeq }。storage 内部
    // 再 clamp limit;缺省/0 = 最新归档页(archived_through_seq+1 起)。
    readArchivedMessages(sessId, userId, beforeSeq, limit, { view: 'timeline' })
      .then((r) => io.sendJson(res, 200, r))
      .catch(() => io.sendJson(res, 500, { error: 'archive read failed' }))
    return true
  }
  const inflightDelegatesMatch = url.pathname.match(
    /^\/api\/sessions\/([a-zA-Z0-9_-]{8,50})\/inflight-delegates$/,
  )
  if (inflightDelegatesMatch) {
    const sessId = inflightDelegatesMatch[1]
    const userId = io.getUserId(req)
    const enabled = isDelegateInflightSurfaceEffective()
    handleInflightDelegatesRequest({
      method: req.method ?? 'GET',
      sessionId: sessId,
      userId,
      enabled,
      searchParams: url.searchParams,
      loadSession: async (id, uid) =>
        (await clientSessionIsActive(id, uid)) ? { id, userId: uid } : null,
      store: enabled ? io.ensureDelegateInflightSurface() : null,
      overlayJobs: () => io.delegateJobs()?.listNonTerminal() ?? [],
      resolveJob: (jobId) => io.delegateJobs()?.snapshotOf(jobId),
    })
      .then((result) => io.sendJson(res, result.status, result.body))
      .catch((error: unknown) =>
        io.sendSessionReadFailure(res, error, sessId, 'inflight delegates read failed'),
      )
    return true
  }
  const sessionReadMatch = url.pathname.match(/^\/api\/sessions\/([a-zA-Z0-9_-]{8,50})\/read$/)
  if (sessionReadMatch) {
    const sessId = sessionReadMatch[1]
    const userId = io.getUserId(req)
    if (req.method !== 'POST') {
      io.sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    markClientSessionRead(userId, sessId)
      .then((result) => {
        if (!result.ok) {
          io.sendJson(res, 404, { error: 'not found' })
          return
        }
        io.sendJson(res, 200, { ok: true, updated: result.updated })
      })
      .catch(() => io.sendJson(res, 500, { error: 'mark read failed' }))
    return true
  }
  // Exact browser-visible process frames, committed by the commercial
  // master before live WS delivery.  This is cursor-paged with no total cap;
  // personal/container SQLite returns an empty page.
  const liveFramePayloadMatch = url.pathname.match(
    /^\/api\/sessions\/([a-zA-Z0-9_-]{8,50})\/live-frames\/payload$/,
  )
  if (liveFramePayloadMatch) {
    const sessId = liveFramePayloadMatch[1]
    const userId = io.getUserId(req)
    if (req.method !== 'GET') {
      io.sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    const recordId = url.searchParams.get('recordId')
    const sha256 = url.searchParams.get('sha256')
    readLiveOrTapeFramePayload(sessId, userId, { recordId, sha256 })
      .then((row) =>
        row ? io.sendJson(res, 200, row) : io.sendJson(res, 404, { error: 'not found' }),
      )
      .catch(() => io.sendJson(res, 500, { error: 'live frame payload read failed' }))
    return true
  }
  const liveFramesMatch = url.pathname.match(
    /^\/api\/sessions\/([a-zA-Z0-9_-]{8,50})\/live-frames$/,
  )
  if (liveFramesMatch) {
    const sessId = liveFramesMatch[1]
    const userId = io.getUserId(req)
    if (req.method !== 'GET') {
      io.sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    const view = url.searchParams.get('view')
    if (view === 'units' && isLiveUnitsEnabled()) {
      const nRaw = url.searchParams.get('n')
      const n = nRaw === null ? 20 : Number(nRaw)
      if (!Number.isSafeInteger(n) || n < 1 || n > 80) {
        io.sendJson(res, 400, { error: 'invalid live units window' })
        return true
      }
      const before = url.searchParams.get('before')
      const group = url.searchParams.get('group')
      const nestedBefore = url.searchParams.get('nestedBefore')
      readClientSessionLiveUnits(sessId, userId, {
        n,
        before,
        group,
        nestedBefore,
      })
        .then((page) =>
          page ? io.sendJson(res, 200, page) : io.sendJson(res, 404, { error: 'not found' }),
        )
        .catch(() => io.sendJson(res, 500, { error: 'live units read failed' }))
      return true
    }
    const afterSeqRaw = url.searchParams.get('afterSeq')
    const afterSeq = afterSeqRaw === null ? 0 : Number(afterSeqRaw)
    const clientMessageId = url.searchParams.get('dispatch') ?? undefined
    const streamKey = url.searchParams.get('streamKey') ?? undefined
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 ||
      (clientMessageId !== undefined && !isClientMessageId(clientMessageId)) ||
      (streamKey !== undefined && !/^dispatch:[0-9a-f-]{36}:[1-9][0-9]*$/i.test(streamKey))) {
      io.sendJson(res, 400, { error: 'invalid session snapshot cursor' })
      return true
    }
    const afterRaw = url.searchParams.get('after')
    const limitRaw = url.searchParams.get('limit')
    const seekRaw = url.searchParams.get('seek')
    const after = afterRaw === null ? 0 : Number(afterRaw)
    const limit = limitRaw === null ? 200 : Number(limitRaw)
    const seekTail = seekRaw === 'tail'
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500 ||
      (seekRaw !== null && seekRaw !== 'tail')
    ) {
      io.sendJson(res, 400, { error: 'invalid live frame cursor' })
      return true
    }
    readClientSessionLiveFrames(sessId, userId, after, limit, { seekTail, afterSeq, clientMessageId, streamKey })
      .then((page) =>
        page ? io.sendJson(res, 200, page) : io.sendJson(res, 404, { error: 'not found' }),
      )
      .catch(() => io.sendJson(res, 500, { error: 'live frame read failed' }))
    return true
  }
  const clientSessMatch = url.pathname.match(/^\/api\/sessions\/([a-zA-Z0-9_-]{8,50})$/)
  if (clientSessMatch) {
    const sessId = clientSessMatch[1]
    const userId = io.getUserId(req)
    if (req.method === 'GET') {
      // Incremental sync (Plan v3): client passes `?since=<seq>` to get
      // only messages whose server-assigned `_seq` exceeds the cursor.
      // Legacy rows (any message without `_seq`) and missing/invalid
      // `since` fall back to the full payload via `isPartial: false`.
      const sinceRaw = url.searchParams.get('since')
      const sinceSeq = sinceRaw !== null ? Number(sinceRaw) : 0
      const historyRevisionRaw = url.searchParams.get('since_history_revision')
      // Missing/invalid rolling-client revisions are intentionally not a
      // 400: storage treats them as a revision mismatch and returns a full
      // payload, which self-heals old clients without a coordinated cutover.
      const sinceHistoryRevision = _parseHistoryRevisionCursor(historyRevisionRaw)
      const permissionLookupIds = parsePermissionLookupQuery(
        url.searchParams.get('permission_lookup'),
      )
      const useIncremental = Number.isFinite(sinceSeq) && sinceSeq > 0
      if (useIncremental) {
        getClientSessionPartial(sessId, userId, sinceSeq, {
          view: 'timeline',
          sinceHistoryRevision,
          ...(permissionLookupIds.length > 0 ? { permissionLookupIds } : {}),
        })
          .then((s) => {
            if (!s) {
              io.sendJson(res, 404, { error: 'not found' })
              return
            }
            const stamped = attachPermissionSnapshotIfMissing(s, io.pendingPermissions, userId)
            io.sendJson(res, 200, {
              ...stamped,
              timelineCursor: stamped.timelineCursor
                ? encodeClientTimelineCursor(stamped.timelineCursor)
                : null,
            })
            io.preheatSessionOnOpen(sessId, userId, s)
          })
          .catch((error: unknown) => io.sendSessionReadFailure(res, error, sessId, 'get failed'))
      } else {
        getClientSession(sessId, userId, {
          view: 'timeline',
          ...(permissionLookupIds.length > 0 ? { permissionLookupIds } : {}),
        })
          .then((s) => {
            if (!s) {
              io.sendJson(res, 404, { error: 'not found' })
              return
            }
            // Always stamp protocol fields explicitly (Codex review #6 — do
            // not rely on truthy/falsey of missing keys). `maxSeq` is
            // computed from messages, not next_seq.
            const messages = (s.messages as Array<{ _seq?: unknown }>) || []
            let maxSeq = 0
            for (const m of messages) {
              const v = (m as { _seq?: unknown })._seq
              if (typeof v === 'number' && Number.isFinite(v) && v > maxSeq) maxSeq = v
            }
            // 热尾巴+归档(§2.2):spill 后 s.messages 只是尾巴,老消息搬去归档表。
            // 总数 = 尾巴条数 + 归档条数;显式回带归档水位/计数供前端渲染"从云端加载
            // 更早历史"入口与"还有 N 条"计数、以及 mergeFullServerWins 的水位保留判定。
            // 显式 stamp(不依赖 ...s 的 truthy/falsey,对齐 Codex review #6 语义)。
            const archivedCount = s.archivedCount ?? 0
            const stamped = attachPermissionSnapshotIfMissing(s, io.pendingPermissions, userId)
            io.sendJson(res, 200, {
              ...stamped,
              isPartial: false,
              totalMessageCount: messages.length + archivedCount,
              maxSeq: s.timelineSnapshotMaxSeq ?? maxSeq,
              archivedCount,
              archivedThroughSeq: s.archivedThroughSeq ?? 0,
              timelineCursor: stamped.timelineCursor
                ? encodeClientTimelineCursor(stamped.timelineCursor)
                : null,
            })
            io.preheatSessionOnOpen(sessId, userId, s)
          })
          .catch((error: unknown) => io.sendSessionReadFailure(res, error, sessId, 'get failed'))
      }
      return true
    }
    if (req.method === 'PUT') {
      // Wire-level body cap = 2MB. Set BELOW the storage layer's
      // MAX_SESSION_BYTES (4MB) so a single PUT can never be the sole
      // cause of pushing a row past the storage cap; lets clients still
      // send moderate-size sessions while preventing the 2026-05-08
      // 8MB-PUT incident from recurring at the gateway boundary. Errors
      // from each stage are routed to distinct status codes:
      //   413 — body or post-merge blob too large (terminal, client must
      //         shrink session before retry)
      //   400 — malformed JSON
      //   409 — stale write (existing.updated_at > _baseSyncedAt OR
      //         concurrent racer beat us to the UPDATE)
      ;(async () => {
        let body: string
        try {
          body = await io.readBody(req, 2 * 1024 * 1024)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (msg === 'body too large') {
            io.sendJson(res, 413, { error: 'request body too large', maxBytes: 2 * 1024 * 1024 })
          } else {
            io.sendJson(res, 400, { error: 'invalid body' })
          }
          return
        }
        let data: {
          agentId?: string
          title?: string
          pinned?: unknown
          createdAt?: number
          lastAt?: number
          messages?: unknown
          modelId?: unknown
          _baseSyncedAt?: number
        }
        try {
          data = JSON.parse(body)
        } catch {
          io.sendJson(res, 400, { error: 'invalid JSON' })
          return
        }
        // modelId(会话级模型选择)建行透传。键缺席=不表态(upsert COALESCE 保留既有值,
        // 绝不清空);**键存在但非法 → 400**(与 PATCH 同一校验口径;静默忽略会造成
        // "客户端以为已保存、服务端实际没存"的假成功,Codex 审 MINOR)。
        let putModelId: string | undefined
        if (data.modelId !== undefined) {
          const m = typeof data.modelId === 'string' ? data.modelId.trim() : ''
          if (!/^[A-Za-z0-9._:-]{1,120}$/.test(m)) {
            io.sendJson(res, 400, { error: 'modelId invalid (1-120 chars, [A-Za-z0-9._:-])' })
            return
          }
          putModelId = m
        }
        const updatedAt = Date.now()
        const result = await upsertClientSession(
          {
            id: sessId,
            userId,
            agentId: data.agentId || 'main',
            title: data.title || '新会话',
            pinned: !!data.pinned,
            createdAt: data.createdAt || Date.now(),
            lastAt: data.lastAt || Date.now(),
            messages: (data.messages as unknown[]) || [],
            ...(putModelId ? { modelId: putModelId } : {}),
            updatedAt,
          },
          data._baseSyncedAt || 0,
        )
        if (result === 'oversized') {
          // Distinct from request-body 413 (which fires before parse).
          // The post-merge blob would push the on-disk row past
          // MAX_SESSION_BYTES — client should drop attachments / split
          // the session before retrying. Returning 409 here would
          // collide with the stale-write retry loop and recreate the
          // event-loop stall this fix was written to eliminate.
          io.sendJson(res, 413, { error: 'session too large', reason: 'oversized' })
        } else if (result === 'rejected_stale') {
          io.sendJson(res, 409, { error: 'conflict' })
        } else {
          io.sendJson(res, 200, { ok: true, applied: true, updatedAt })
        }
      })().catch(() => io.sendJson(res, 500, { error: 'put failed' }))
      return true
    }
    if (req.method === 'PATCH') {
      // 元数据专用更新(title / modelId / projectId / pinned / archived,至少携带其一)。不走 PUT 的
      // "整 blob 替换 + 乐观并发"语义:元数据不携带 messages。
      // modelId = 会话级模型选择(UI 恢复提示,非执行权威)。
      // projectId = 侧栏聊天项目归属(null = 移出项目)。
      // archived = 侧栏整会话归档(与消息 spill 水位无关)。
      ;(async () => {
        let data: {
          title?: unknown
          modelId?: unknown
          projectId?: unknown
          pinned?: unknown
          archived?: unknown
        }
        try {
          data = JSON.parse(await io.readBody(req, 16 * 1024))
        } catch {
          io.sendJson(res, 400, { error: 'invalid JSON' })
          return
        }
        const hasTitle = data.title !== undefined
        const hasModel = data.modelId !== undefined
        const hasProject = data.projectId !== undefined
        const hasPinned = data.pinned !== undefined
        const hasArchived = data.archived !== undefined
        if (!hasTitle && !hasModel && !hasProject && !hasPinned && !hasArchived) {
          io.sendJson(res, 400, { error: 'title, modelId, projectId, pinned or archived required' })
          return
        }
        const title = typeof data.title === 'string' ? data.title.trim() : ''
        if (hasTitle && (!title || title.length > 120)) {
          io.sendJson(res, 400, { error: 'title required (1-120 chars)' })
          return
        }
        const modelId = typeof data.modelId === 'string' ? data.modelId.trim() : ''
        if (hasModel && !/^[A-Za-z0-9._:-]{1,120}$/.test(modelId)) {
          io.sendJson(res, 400, { error: 'modelId invalid (1-120 chars, [A-Za-z0-9._:-])' })
          return
        }
        if (hasProject && data.projectId !== null && typeof data.projectId !== 'string') {
          io.sendJson(res, 400, { error: 'projectId must be a string or null' })
          return
        }
        const projectId = hasProject
          ? data.projectId === null
            ? null
            : String(data.projectId).trim()
          : undefined
        if (
          hasProject &&
          projectId !== null &&
          projectId !== undefined &&
          (projectId.length < 8 || projectId.length > 64)
        ) {
          io.sendJson(res, 400, { error: 'projectId invalid' })
          return
        }
        if (hasPinned && typeof data.pinned !== 'boolean') {
          io.sendJson(res, 400, { error: 'pinned must be a boolean' })
          return
        }
        if (hasArchived && typeof data.archived !== 'boolean') {
          io.sendJson(res, 400, { error: 'archived must be a boolean' })
          return
        }
        const result = await patchClientSessionMeta(sessId, userId, {
          ...(hasTitle ? { title } : {}),
          ...(hasModel ? { modelId } : {}),
          ...(hasProject ? { projectId: projectId ?? null } : {}),
          ...(hasPinned ? { pinned: data.pinned as boolean } : {}),
          ...(hasArchived ? { archived: data.archived as boolean } : {}),
        })
        if (!result.ok) {
          if (result.error === 'project_not_found') {
            io.sendJson(res, 404, { error: 'project not found' })
            return
          }
          io.sendJson(res, 404, { error: 'not found' })
          return
        }
        io.sendJson(res, 200, { ok: true, updatedAt: result.updatedAt })
      })().catch(() => io.sendJson(res, 500, { error: 'patch failed' }))
      return true
    }
    if (req.method === 'DELETE') {
      deleteClientSession(sessId, userId)
        .then(async () => {
          try {
            await io.advisorConfigStore().deleteSession(sessId)
          } catch {
            /* config cleanup is best-effort; session row is already gone */
          }
          io.sendJson(res, 200, { ok: true })
        })
        .catch(() => io.sendJson(res, 500, { error: 'delete failed' }))
      return true
    }
  }
  return false
}

/**
 * Existence/ownership probe that never hydrates turn tapes. `getClientSession`
 * (exact view) materializes every tape payload of the session — hundreds of
 * MB on long sessions — which is what pushed the inflight-delegates poll and
 * cron/delegate callback lookups into the 30s PG statement budget
 * (OCV5-94). One indexed `client_sessions` row is enough to answer
 * "does this active session belong to this user".
 */
export async function clientSessionIsActive(sessionId: string, userId: string): Promise<boolean> {
  const [state] = await classifyClientSessions([{ sessionId, userId }])
  return state?.state === 'active'
}

export function _parseHistoryRevisionCursor(raw: string | null): number | undefined {
  if (raw === null || !/^(0|[1-9]\d*)$/.test(raw)) return undefined
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

export function filterUserVisibleLiveSessions<T extends { sessionKey: string }>(
  sessions: readonly T[],
  ownedIds: ReadonlySet<string>,
  userId: string,
): T[] {
  return sessions.filter((s) => {
    if (isPatrolSessionKey(s.sessionKey)) return false
    // 排除内部委派会话：它们不是用户聊天会话，不能经此 API 泄露（Codex 审）。
    // key 形如 agent:<id>:delegate:...（第 3 段区分）。
    const kind = s.sessionKey.split(':')[2] || ''
    if (kind === 'delegate') return false
    const peerId = s.sessionKey.split(':')[4] || ''
    return ownedIds.has(peerId) || (userId === 'default' && !peerId.startsWith('web-'))
  })
}

// ── 长会话热尾巴 + 归档 (Agent B §2) — pure helpers(`_` 前缀 test seam)──

/**
 * 归档分页端点(GET /api/sessions/:id/archive)的 query 解析 + 边界收敛。
 *
 * 契约(与 storage.readArchivedMessages 语义对齐):
 *   - `before`:游标,返回 `_seq < before` 的最近一页;缺省 / 非法 / 负数 → 0
 *     (0 = 从 archived_through_seq+1 开始,即最新归档页)。取整。
 *   - `limit`:默认 100;非法 / ≤0 → 100;上限 200(storage 内部也 clamp,这里在
 *     gateway 边界先兜一次防御坏输入)。
 *
 * 纯函数,不抛 —— 坏输入静默收敛到安全默认(端点是只读回看,不需要对畸形参数
 * 硬 400;与 /api/sessions 的 `?since=` 解析同风格)。
 */
export function _parseArchiveQuery(
  beforeRaw: string | null,
  limitRaw: string | null,
): { beforeSeq: number; limit: number } {
  const b = beforeRaw !== null ? Number(beforeRaw) : 0
  const beforeSeq = Number.isFinite(b) && b >= 0 ? Math.floor(b) : 0
  const l = limitRaw !== null ? Number(limitRaw) : 100
  const limit = Number.isFinite(l) && l > 0 ? Math.min(Math.floor(l), 200) : 100
  return { beforeSeq, limit }
}

/** Deferred record IDs are immutable identity metadata. New records normally
 * use visible ASCII IDs, but historical Cursor call IDs may contain LF or
 * Unicode. Never pass those bytes directly to node:http header validation. */
export function _immutableRecordIdHeaders(recordId: string): Record<string, string> {
  if (/^[\x21-\x7e]{1,1024}$/.test(recordId)) {
    return { 'X-OpenClaude-Record-Id': recordId }
  }
  return {
    'X-OpenClaude-Record-Id-Base64url': Buffer.from(recordId, 'utf8').toString('base64url'),
  }
}
