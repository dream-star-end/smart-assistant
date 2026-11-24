/**
 * Durable PostgreSQL-backed `BrowserHandoffStore` + authoritative outbound
 * `browser_handoff` card observer (OCV5-832 B3).
 *
 * Guarantees:
 *   - Survives master restarts (`pending_browser_handoffs` table).
 *   - Atomic pending-only CAS on `resolve(...)` with strict uid ownership, expiry,
 *     idempotent same-decision replay, and 409 conflict on opposite decision.
 *   - Deterministic handoff IDs from `(userId, sessionId, messageId, cardIdx, url)`
 *     combined with `ON CONFLICT (id) DO NOTHING RETURNING *` so WS replays never
 *     duplicate records or trigger duplicate proactive IM pushes.
 */

import { createHash, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import {
  type BrowserHandoffResumeWhen,
  type PendingDecisionAction,
  type PendingDecisionRiskLevel,
  normalizeBrowserHandoffResumeWhen,
} from '@openclaude/protocol'
import { rootLogger } from '../logging/logger.js'
import { PendingDecisionError, type BrowserHandoffRecord, type BrowserHandoffStore } from './types.js'

const handoffLog = rootLogger.child({ module: 'pending-decisions.browser-handoff' })

const DEFAULT_HANDOFF_TTL_MS = 15 * 60_000

export interface PgBrowserHandoffPool {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<{ rows: R[]; rowCount: number | null }>
}

interface BrowserHandoffPgRow extends Record<string, unknown> {
  id: string
  user_id: string
  session_id: string | null
  title: string
  url: string
  reason: string
  risk_level: string
  status: string
  metadata_json: unknown
  resolution_note: string | null
  created_at: Date | string
  expires_at: Date | string
  resolved_at: Date | string | null
}

function toIso(v: Date | string | null | undefined, fallbackMs = Date.now()): string {
  if (!v) return new Date(fallbackMs).toISOString()
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? new Date(fallbackMs).toISOString() : d.toISOString()
}

function rowToRecord(row: BrowserHandoffPgRow): BrowserHandoffRecord {
  const risk: PendingDecisionRiskLevel =
    row.risk_level === 'low' ||
    row.risk_level === 'medium' ||
    row.risk_level === 'high' ||
    row.risk_level === 'critical'
      ? row.risk_level
      : 'high'
  const status: BrowserHandoffRecord['status'] =
    row.status === 'pending' ||
    row.status === 'approved' ||
    row.status === 'denied' ||
    row.status === 'expired'
      ? row.status
      : 'pending'
  const meta =
    row.metadata_json && typeof row.metadata_json === 'object' && !Array.isArray(row.metadata_json)
      ? (row.metadata_json as Record<string, unknown>)
      : undefined
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    title: row.title,
    url: row.url,
    reason: row.reason,
    riskLevel: risk,
    status,
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
    resolvedAt: row.resolved_at ? toIso(row.resolved_at) : null,
    resolutionNote: row.resolution_note ?? null,
    ...(meta ? { metadata: meta } : {}),
  }
}

function isUndefinedTableError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown }
  if (e?.code !== '42P01') return false
  return typeof e.message === 'string' && e.message.includes('pending_browser_handoffs')
}

export class PgBrowserHandoffStore implements BrowserHandoffStore {
  private readonly pool: PgBrowserHandoffPool
  private readonly now: () => number
  private readonly onCreated?: (rec: BrowserHandoffRecord) => void | Promise<void>

  constructor(opts: {
    pool: Pool | PgBrowserHandoffPool
    now?: () => number
    onCreated?: (rec: BrowserHandoffRecord) => void | Promise<void>
  }) {
    this.pool = opts.pool as PgBrowserHandoffPool
    this.now = opts.now ?? (() => Date.now())
    this.onCreated = opts.onCreated
  }

  /**
   * Strictly relies on migration `0348_commercial_pending_browser_handoffs.sql` /
   * `0352_pending_browser_handoffs.sql` (never runs DDL on the request path).
   * Missing table fails closed as `SOURCE_UNAVAILABLE`.
   */
  private async runQuery<R extends Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<{ rows: R[]; rowCount: number | null }> {
    try {
      return await this.pool.query<R>(sql, params)
    } catch (err) {
      if (isUndefinedTableError(err)) {
        throw new PendingDecisionError(
          'SOURCE_UNAVAILABLE',
          'pending_browser_handoffs table missing (migration 0348/0352 required)',
        )
      }
      throw err
    }
  }

  async create(input: {
    id?: string
    userId: string
    sessionId?: string | null
    title: string
    url: string
    reason: string
    riskLevel?: PendingDecisionRiskLevel
    ttlMs?: number
    metadata?: Record<string, unknown>
  }): Promise<BrowserHandoffRecord> {
    const nowMs = this.now()
    const id = input.id?.trim() || `bh-${randomUUID()}`
    const ttlMs = Math.max(1000, input.ttlMs ?? DEFAULT_HANDOFF_TTL_MS)
    const createdAt = new Date(nowMs)
    const expiresAt = new Date(nowMs + ttlMs)
    const riskLevel = input.riskLevel ?? 'high'

    const inserted = await this.runQuery<BrowserHandoffPgRow>(
      `INSERT INTO pending_browser_handoffs (
         id, user_id, session_id, title, url, reason, risk_level,
         status, metadata_json, created_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8::jsonb, $9, $10)
       ON CONFLICT (id) DO NOTHING
       RETURNING id, user_id, session_id, title, url, reason, risk_level,
                 status, metadata_json, resolution_note, created_at, expires_at, resolved_at`,
      [
        id,
        input.userId,
        input.sessionId ?? null,
        input.title.slice(0, 240),
        input.url.slice(0, 2000),
        input.reason.slice(0, 1000),
        riskLevel,
        input.metadata ? JSON.stringify(input.metadata) : null,
        createdAt.toISOString(),
        expiresAt.toISOString(),
      ],
    )

    if ((inserted.rowCount ?? 0) > 0 && inserted.rows[0]) {
      const rec = rowToRecord(inserted.rows[0])
      if (this.onCreated) {
        await Promise.resolve(this.onCreated(rec)).catch((err) => {
          handoffLog.warn('browser_handoff onCreated listener failed', { id: rec.id, userId: rec.userId, err })
        })
      }
      return rec
    }

    const existing = await this.getById(id)
    if (existing) return existing
    throw new PendingDecisionError('SOURCE_UNAVAILABLE', `failed to persist browser handoff ${id}`)
  }

  async listPending(userId: string, limit: number, nowMs = this.now()): Promise<BrowserHandoffRecord[]> {
    const safeLimit = Math.max(1, Math.min(limit, 200))
    const res = await this.runQuery<BrowserHandoffPgRow>(
      `SELECT id, user_id, session_id, title, url, reason, risk_level,
              status, metadata_json, resolution_note, created_at, expires_at, resolved_at
         FROM pending_browser_handoffs
        WHERE user_id = $1 AND status = 'pending' AND expires_at > $2
        ORDER BY created_at ASC
        LIMIT $3`,
      [userId, new Date(nowMs).toISOString(), safeLimit],
    )
    return res.rows.map(rowToRecord)
  }

  async getById(id: string): Promise<BrowserHandoffRecord | null> {
    const res = await this.runQuery<BrowserHandoffPgRow>(
      `SELECT id, user_id, session_id, title, url, reason, risk_level,
              status, metadata_json, resolution_note, created_at, expires_at, resolved_at
         FROM pending_browser_handoffs
        WHERE id = $1
        LIMIT 1`,
      [id],
    )
    return res.rows[0] ? rowToRecord(res.rows[0]) : null
  }

  async resolve(input: {
    id: string
    userId: string
    decision: PendingDecisionAction
    reason?: string
    nowMs?: number
  }): Promise<{ status: 'approved' | 'denied'; idempotentReplay: boolean; resolvedAt: string }> {
    const nowMs = input.nowMs ?? this.now()
    const nowIso = new Date(nowMs).toISOString()
    const desiredStatus: 'approved' | 'denied' = input.decision === 'approve' ? 'approved' : 'denied'

    const updated = await this.runQuery<BrowserHandoffPgRow>(
      `UPDATE pending_browser_handoffs
          SET status = $1,
              resolved_at = $2,
              resolution_note = $3
        WHERE id = $4
          AND user_id = $5
          AND status = 'pending'
          AND expires_at > $2
      RETURNING id, user_id, session_id, title, url, reason, risk_level,
                status, metadata_json, resolution_note, created_at, expires_at, resolved_at`,
      [desiredStatus, nowIso, input.reason?.trim() || null, input.id, input.userId],
    )

    if ((updated.rowCount ?? 0) > 0 && updated.rows[0]) {
      return {
        status: desiredStatus,
        idempotentReplay: false,
        resolvedAt: toIso(updated.rows[0].resolved_at, nowMs),
      }
    }

    const existing = await this.getById(input.id)
    if (!existing) {
      throw new PendingDecisionError('NOT_FOUND', `browser handoff not found: ${input.id}`)
    }
    if (existing.userId !== input.userId) {
      throw new PendingDecisionError('FORBIDDEN', 'browser handoff belongs to another user')
    }
    if (existing.status === desiredStatus) {
      return {
        status: desiredStatus,
        idempotentReplay: true,
        resolvedAt: existing.resolvedAt ?? nowIso,
      }
    }
    if (existing.status === 'approved' || existing.status === 'denied') {
      throw new PendingDecisionError(
        'CONFLICT_ALREADY_RESOLVED',
        `browser handoff already resolved (${existing.status})`,
      )
    }
    if (existing.status === 'expired' || new Date(existing.expiresAt).getTime() <= nowMs) {
      if (existing.status === 'pending') {
        await this.runQuery(
          `UPDATE pending_browser_handoffs
              SET status = 'expired'
            WHERE id = $1
              AND user_id = $2
              AND status = 'pending'
              AND expires_at <= $3`,
          [input.id, input.userId, nowIso],
        ).catch((err) => {
          handoffLog.warn('browser_handoff mark expired failed', { id: input.id, userId: input.userId, err })
        })
      }
      throw new PendingDecisionError('EXPIRED', 'browser handoff has expired')
    }
    throw new PendingDecisionError('CONFLICT_ALREADY_RESOLVED', 'browser handoff state changed')
  }

  async expireStale(nowMs = this.now()): Promise<number> {
    const res = await this.runQuery(
      `UPDATE pending_browser_handoffs
          SET status = 'expired'
        WHERE status = 'pending'
          AND expires_at <= $1`,
      [new Date(nowMs).toISOString()],
    )
    return res.rowCount ?? 0
  }
}

export interface ParsedBrowserHandoffCard {
  title: string
  url: string
  reason: string
  continuePrompt?: string
  resumeWhen?: BrowserHandoffResumeWhen
}

const UI_FENCE_RE = /```ui\s*\r?\n([\s\S]*?)```/gi

/**
 * Extract valid `browser_handoff` intelligent UI cards from assistant outbound text.
 */
export function extractBrowserHandoffCardsFromText(text: string): ParsedBrowserHandoffCard[] {
  if (!text || !text.includes('browser_handoff')) return []
  const out: ParsedBrowserHandoffCard[] = []
  UI_FENCE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = UI_FENCE_RE.exec(text)) !== null) {
    const rawJson = (m[1] ?? '').trim()
    if (!rawJson) continue
    try {
      const parsed = JSON.parse(rawJson) as Record<string, unknown>
      if (!parsed || typeof parsed !== 'object' || parsed.type !== 'browser_handoff') continue
      const url = typeof parsed.url === 'string' && parsed.url.trim() ? parsed.url.trim() : 'about:blank'
      const title =
        typeof parsed.title === 'string' && parsed.title.trim()
          ? parsed.title.trim()
          : '浏览器人工接管'
      const reason =
        typeof parsed.reason === 'string' && parsed.reason.trim()
          ? parsed.reason.trim()
          : '当前网页需要你登录、完成 2FA 或验证码验证'
      const continuePrompt =
        typeof parsed.continue_prompt === 'string' && parsed.continue_prompt.trim()
          ? parsed.continue_prompt.trim()
          : undefined
      const resumeWhen = normalizeBrowserHandoffResumeWhen(parsed.resume_when ?? parsed.resumeWhen)
      out.push({
        title,
        url,
        reason,
        ...(continuePrompt ? { continuePrompt } : {}),
        ...(resumeWhen ? { resumeWhen } : {}),
      })
    } catch {
      // ignore malformed ui block
    }
  }
  return out
}

export interface OutboundBrowserHandoffFrameEvent {
  userId: string
  sessionId: string | null
  messageId?: string | null
  text: string
}

type OutboundBrowserHandoffListener = (evt: OutboundBrowserHandoffFrameEvent) => void | Promise<void>
const outboundBrowserHandoffListeners = new Set<OutboundBrowserHandoffListener>()

export function onOutboundBrowserHandoffFrame(
  listener: OutboundBrowserHandoffListener,
): () => void {
  outboundBrowserHandoffListeners.add(listener)
  return () => {
    outboundBrowserHandoffListeners.delete(listener)
  }
}

export function emitOutboundBrowserHandoffFrame(evt: OutboundBrowserHandoffFrameEvent): void {
  if (outboundBrowserHandoffListeners.size === 0) return
  for (const listener of outboundBrowserHandoffListeners) {
    void Promise.resolve(listener(evt)).catch((err) => {
      handoffLog.warn('outbound browser_handoff listener failed', {
        userId: evt.userId,
        sessionId: evt.sessionId,
        err,
      })
    })
  }
}

export function deterministicBrowserHandoffId(args: {
  userId: string
  sessionId: string | null
  messageId?: string | null
  cardIndex: number
  url: string
  title: string
}): string {
  const seed = [
    args.userId,
    args.sessionId ?? '',
    args.messageId ?? '',
    String(args.cardIndex),
    args.url,
    args.title,
  ].join('\0')
  return `bh-${createHash('sha256').update(seed).digest('hex').slice(0, 24)}`
}

interface StreamReassemblyState {
  text: string
  emittedCardIds: Set<string>
  updatedAt: number
}

/**
 * Bounded per-(userId, sessionId, messageId) streaming reassembler for assistant
 * `outbound.message` frames (OCV5-832 B3).
 *
 * WebChat / Antigravity streams assistant text block-by-block (`isFinal: false`)
 * and may emit an empty `blocks: []` terminal frame (`isFinal: true`). Reassembling
 * visible text chunks across frames ensures fenced ```ui browser_handoff``` cards
 * split across arbitrary frame boundaries are detected reliably and emitted once
 * (deduplicated by deterministic card ID).
 */
export class OutboundBrowserHandoffFrameObserver {
  private readonly streams = new Map<string, StreamReassemblyState>()
  private readonly maxStreams: number
  private readonly maxCharsPerStream: number
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly emitFn: (evt: OutboundBrowserHandoffFrameEvent) => void

  constructor(opts?: {
    maxStreams?: number
    maxCharsPerStream?: number
    ttlMs?: number
    now?: () => number
    emit?: (evt: OutboundBrowserHandoffFrameEvent) => void
  }) {
    this.maxStreams = opts?.maxStreams ?? 512
    this.maxCharsPerStream = opts?.maxCharsPerStream ?? 128 * 1024
    this.ttlMs = opts?.ttlMs ?? 10 * 60_000
    this.now = opts?.now ?? (() => Date.now())
    this.emitFn = opts?.emit ?? emitOutboundBrowserHandoffFrame
  }

  private hasActiveStreamForUser(userId: string): boolean {
    if (this.streams.size === 0) return false
    const prefix = `${userId}\0`
    for (const key of this.streams.keys()) {
      if (key.startsWith(prefix)) return true
    }
    return false
  }

  observeOutboundFrame(userId: string, data: unknown): void {
    type OutboundFrameShape = {
      type?: unknown
      messageId?: unknown
      clientMessageId?: unknown
      isFinal?: unknown
      peer?: { id?: unknown }
      blocks?: Array<{ kind?: unknown; text?: unknown }>
    }

    let frame: OutboundFrameShape
    const isPreParsed =
      data !== null &&
      typeof data === 'object' &&
      !Buffer.isBuffer(data) &&
      !(data instanceof ArrayBuffer) &&
      !Array.isArray(data)

    if (isPreParsed) {
      frame = data as OutboundFrameShape
    } else {
      const raw =
        typeof data === 'string'
          ? data
          : Buffer.isBuffer(data)
            ? data.toString('utf8')
            : ''
      if (!raw || !raw.includes('outbound.message')) return
      // Fast pre-screen before JSON.parse: pass any frame containing a backtick or marker so split fences (e.g. "``" + "`ui") are never missed.
      if (!this.hasActiveStreamForUser(userId) && !raw.includes('browser_handoff') && !raw.includes('`')) {
        return
      }
      try {
        frame = JSON.parse(raw) as OutboundFrameShape
      } catch {
        return
      }
    }
    if (!frame || frame.type !== 'outbound.message') return

    const sessionId = typeof frame.peer?.id === 'string' ? frame.peer.id : null
    const messageId =
      typeof frame.messageId === 'string' && frame.messageId
        ? frame.messageId
        : typeof frame.clientMessageId === 'string' && frame.clientMessageId
          ? frame.clientMessageId
          : null
    const isFinal = frame.isFinal === true
    const blocks = Array.isArray(frame.blocks) ? frame.blocks : []
    const chunk = blocks
      .filter(
        (b) =>
          b &&
          typeof b.text === 'string' &&
          (b.kind === undefined || b.kind === 'text'),
      )
      .map((b) => b.text as string)
      .join('')

    const nowMs = this.now()
    const streamKey = `${userId}\0${sessionId ?? ''}\0${messageId ?? '__session__'}`
    let state = this.streams.get(streamKey)

    if (!state && !chunk.includes('browser_handoff') && !chunk.includes('`')) return

    if (!state) {
      this.prune(nowMs)
      while (this.streams.size >= this.maxStreams) {
        const oldest = this.streams.keys().next().value
        if (oldest !== undefined) this.streams.delete(oldest)
        else break
      }
      state = { text: '', emittedCardIds: new Set<string>(), updatedAt: nowMs }
      this.streams.set(streamKey, state)
    }

    state.updatedAt = nowMs
    if (chunk) {
      const next = state.text + chunk
      state.text =
        next.length > this.maxCharsPerStream
          ? next.slice(next.length - this.maxCharsPerStream)
          : next
    }

    if (state.text.includes('browser_handoff')) {
      const cards = extractBrowserHandoffCardsFromText(state.text)
      if (cards.length > 0) {
        let hasNew = false
        for (let idx = 0; idx < cards.length; idx++) {
          const card = cards[idx]!
          const cardId = deterministicBrowserHandoffId({
            userId,
            sessionId,
            messageId,
            cardIndex: idx,
            url: card.url,
            title: card.title,
          })
          if (!state.emittedCardIds.has(cardId)) {
            state.emittedCardIds.add(cardId)
            hasNew = true
          }
        }
        if (hasNew) {
          this.emitFn({
            userId,
            sessionId,
            messageId,
            text: state.text,
          })
        }
      }
    }

    if (isFinal) {
      this.streams.delete(streamKey)
    }
  }

  private prune(nowMs: number): void {
    for (const [k, v] of this.streams) {
      if (nowMs - v.updatedAt > this.ttlMs) {
        this.streams.delete(k)
      }
    }
  }

  clear(): void {
    this.streams.clear()
  }
}
