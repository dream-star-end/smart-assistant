import { automaticRetryStatus, type SessionSnapshot, type TurnTokenUsageSnapshot } from '@openclaude/protocol'
import type { Pool, PoolClient } from 'pg'
import { readDispatchSettledCredits } from '../billing/dispatchSettledCredits.js'
import {
  HELLO_PENDING_PERMISSION_MAX_SESSIONS,
  pendingPermissionPromptToFrame,
  readPendingPermissionPrompts,
  readPendingPermissionPromptsForSessions,
} from '../dispatch/turnControlStore.js'
import { readOpenDispatchEngineReady } from './liveTurnFrames.js'
import { openDispatchTurnStatusSnapshotFrame, terminalDispatchReconcile } from './sessionSnapshotStatus.js'

export interface SessionSnapshotOptions {
  afterSeq?: number
  afterSeqByAgent?: Record<string, number>
  limit?: number
  clientMessageId?: string
  /** Echo the previous snapshot's stream identity whenever afterSeq is nonzero. */
  streamKey?: string
  streamKeyAgentId?: string
  containerId?: number
}
export const SESSION_SNAPSHOT_MAX_BYTES = 1024 * 1024
/** Upper bound on fallback BYTEA fact scan pages when pointer columns are NULL (8 * 64 = 512 matches). */
export const SESSION_SNAPSHOT_FACTS_MAX_PAGES = 8

type Queryable = Pick<PoolClient, 'query'>
type SnapshotFact = { record_id: string; frame_seq: string; payload: Buffer }
type Dispatch = {
  dispatch_id: string; client_message_id: string; agent_id: string
  status: string; outcome: string | null; attempt_no: number
  admitted_at: Date; accepted_at: Date | null; terminal_at: Date | null
}
type RecoveryRow = {
  status: NonNullable<SessionSnapshot['recovery']>['status']
  semantic_recovery_attempt: number
  retry_limit: number | null
}

function buildRecoveryState(recovery: RecoveryRow | undefined): SessionSnapshot['recovery'] {
  if (!recovery) return null
  const retryStatus = automaticRetryStatus(
    recovery.status === 'forwarded' ? 'running' : 'scheduled',
    recovery.semantic_recovery_attempt,
    recovery.retry_limit ?? undefined,
  )
  return {
    status: recovery.status,
    attempt: recovery.semantic_recovery_attempt,
    maxAttempts: recovery.retry_limit,
    retryStatus: { ...retryStatus, actions: [...retryStatus.actions] },
  }
}

export function parseLatestTurnStatusPointer(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  if (!('status' in obj)) return null
  return obj
}

export function parseLatestTurnUsagePointer(raw: unknown): SessionSnapshot['usage'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  if (
    typeof obj.frameSeq !== 'number' ||
    !Number.isSafeInteger(obj.frameSeq) ||
    !obj.usage ||
    typeof obj.usage !== 'object' ||
    Array.isArray(obj.usage)
  ) {
    return null
  }
  return { frameSeq: obj.frameSeq, usage: obj.usage as TurnTokenUsageSnapshot }
}

function hasPositiveCursor(options: SessionSnapshotOptions): boolean {
  const requestedAfterBase = Number.isSafeInteger(options.afterSeq) && options.afterSeq! > 0 ? options.afterSeq! : 0
  if (requestedAfterBase > 0) return true
  return !!options.afterSeqByAgent && Object.values(options.afterSeqByAgent).some(
    (v) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0,
  )
}

function emptySessionSnapshot(sessionId: string, asOf: number): SessionSnapshot {
  return {
    v: 1, sessionId, dispatch: null, streamKey: null, lastFrameSeq: null, lastFrameAt: null,
    engineReady: null, turnStatus: null, reconcile: null, recovery: null,
    pendingPermissions: { items: [], completeness: 'complete' }, usage: null, credits: null,
    frames: [], nextAfterSeq: 0, hasMore: false, gap: null, asOf,
  }
}

/** The caller owns a REPEATABLE READ READ ONLY transaction. HTTP invokes this
 * inside its legacy page transaction; WS uses readSessionSnapshot below. */
export async function buildSessionSnapshot(
  q: Queryable, uid: string, sessionId: string, options: SessionSnapshotOptions = {},
): Promise<SessionSnapshot | null> {
  if (!/^[1-9][0-9]*$/.test(uid)) return null
  const session = await q.query<{ as_of: string }>(
    `/* session-snapshot-owner */ SELECT (EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint AS as_of
       FROM client_sessions WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
    [sessionId, `c:${uid}`],
  )
  if (!session.rows[0]) return null
  const asOf = Number(session.rows[0].as_of)
  const row = (await q.query<Dispatch>(
    `/* session-snapshot-dispatch */
     SELECT dispatch_id,client_message_id,agent_id,status,outcome,attempt_no,admitted_at,accepted_at,terminal_at
       FROM turn_dispatches
      WHERE user_id=$1::bigint AND session_id=$2
        AND (client_message_id=$3 OR status IN ('admitted','accepted','rejecting'))
      ORDER BY (client_message_id=$3) DESC NULLS LAST, admitted_at DESC, dispatch_id DESC LIMIT 1`,
    [uid, sessionId, options.clientMessageId ?? null],
  )).rows[0]
  const snapshot = emptySessionSnapshot(sessionId, asOf)
  // turn_recovery_jobs has been permanently migrated since 0202; query directly
  // without allocating a hot-path SAVEPOINT / subtransaction.
  const recovery = (await q.query<RecoveryRow>(
    `/* session-snapshot-recovery */
     SELECT status,semantic_recovery_attempt,
            request_json->'_automaticRecoveryRetryLimit' AS retry_limit
       FROM turn_recovery_jobs
      WHERE user_id=$1::bigint AND session_id=$2
        AND status IN ('queued','leased','sent','forwarded')
      ORDER BY created_at DESC,job_id DESC LIMIT 1`,
    [uid, sessionId],
  )).rows[0]
  snapshot.recovery = buildRecoveryState(recovery)

  const agentId = row?.agent_id || 'main'
  const sessionKey = `agent:${agentId}:webchat:dm:${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
  try {
    const permissions = await readPendingPermissionPrompts(q, { userId: BigInt(uid), sessionId, limit: 64 })
    snapshot.pendingPermissions = {
      items: permissions.map((p) => pendingPermissionPromptToFrame(p, { peerId: sessionId, sessionKey }, asOf))
        .filter((p): p is Record<string, unknown> => p !== null),
      completeness: permissions.length === 64 ? 'truncated' : 'complete',
    }
  } catch {
    snapshot.pendingPermissions.completeness = 'unavailable'
  }
  const requestedAfterBase = Number.isSafeInteger(options.afterSeq) && options.afterSeq! > 0 ? options.afterSeq! : 0
  if (!row) {
    if (hasPositiveCursor(options) && typeof options.containerId === 'number' &&
        Number.isSafeInteger(options.containerId) && options.containerId > 0) {
      const lastDispatch = (await q.query<{ agent_container_id: string | number | null }>(
        `/* session-snapshot-container-cursor */
         SELECT agent_container_id FROM turn_dispatches
          WHERE user_id=$1::bigint AND session_id=$2 AND agent_container_id IS NOT NULL
          ORDER BY admitted_at DESC, dispatch_id DESC LIMIT 1`,
        [uid, sessionId],
      )).rows[0]
      if (!lastDispatch || Number(lastDispatch.agent_container_id) !== options.containerId) {
        snapshot.gap = { reason: 'cursor_reset' }
      }
    }
    return snapshot
  }
  snapshot.dispatch = {
    id: row.dispatch_id, clientMessageId: row.client_message_id, agentId,
    status: row.status, outcome: row.outcome, attempt: row.attempt_no,
    since: row.admitted_at.getTime(), acceptedAt: row.accepted_at?.getTime() ?? null,
    terminalAt: row.terminal_at?.getTime() ?? null,
  }
  const streamKey = `dispatch:${row.dispatch_id}:${row.attempt_no}`
  snapshot.streamKey = streamKey
  // Keep credit isolation ONLY on active/requested dispatch rows (never on idle sessions).
  await q.query('SAVEPOINT session_snapshot_credits')
  try {
    snapshot.credits = await readDispatchSettledCredits(q, {
      uid, dispatchId: row.dispatch_id, attemptNo: row.attempt_no, admittedAt: row.admitted_at,
    })
  } catch {
    await q.query('ROLLBACK TO SAVEPOINT session_snapshot_credits')
  }
  await q.query('RELEASE SAVEPOINT session_snapshot_credits')
  if (row.status === 'terminal' && !snapshot.recovery) snapshot.reconcile = terminalDispatchReconcile(row.outcome)
  const stream = (await q.query<{
    projection_source: string
    provenance: { containerLinkGap?: SessionSnapshot['gap'] }
    latest_turn_status_json?: unknown
    latest_turn_usage_json?: unknown
    frame_seq: string | null
    created_at: Date | null
  }>(
    `/* session-snapshot-watermark */
     SELECT s.projection_source, s.provenance,
            s.latest_turn_status_json, s.latest_turn_usage_json,
            f.frame_seq, f.created_at
       FROM client_session_live_streams s
       LEFT JOIN LATERAL (
         SELECT frame_seq,created_at FROM client_session_live_frames
          WHERE stream_key=s.stream_key ORDER BY frame_seq DESC LIMIT 1
       ) f ON TRUE
      WHERE s.stream_key=$1 AND s.user_id=$2 AND s.session_id=$3`,
    [streamKey, `c:${uid}`, sessionId],
  )).rows[0]
  const containerLinkGap = stream?.provenance?.containerLinkGap ?? null
  snapshot.lastFrameSeq = stream?.frame_seq == null ? null : Number(stream.frame_seq)
  snapshot.lastFrameAt = stream?.created_at?.getTime() ?? null

  const needStatus = row.status === 'admitted' || row.status === 'accepted'
  const hasFrames = snapshot.lastFrameSeq !== null

  // O(1) fast path: read persisted pointer columns maintained on frame write.
  // Legacy NULL streams (or payloads skipped due to NUL/lone surrogates) fall
  // back to a strictly bounded BYTEA scan (never unbounded full-table scan).
  let latestStatus = parseLatestTurnStatusPointer(stream?.latest_turn_status_json)
  snapshot.usage = parseLatestTurnUsagePointer(stream?.latest_turn_usage_json)
  if (hasFrames && ((needStatus && !latestStatus) || !snapshot.usage)) {
    let before: [string, string] | null = null
    for (
      let pageNo = 0;
      pageNo < SESSION_SNAPSHOT_FACTS_MAX_PAGES && ((needStatus && !latestStatus) || !snapshot.usage);
      pageNo++
    ) {
      const facts: { rows: SnapshotFact[] } = await q.query<SnapshotFact>(
        `/* session-snapshot-facts */
         SELECT record_id::text,frame_seq,payload FROM client_session_live_frames
          WHERE stream_key=$1 AND ($2::bigint IS NULL OR (frame_seq,record_id)<($2::bigint,$3::bigint))
            AND octet_length(payload)<=65536
            AND (position($4::bytea IN payload)>0 OR position($5::bytea IN payload)>0)
          ORDER BY frame_seq DESC,record_id DESC LIMIT 64`,
        [streamKey, before?.[0] ?? null, before?.[1] ?? null,
          Buffer.from('"outbound.turn_status"'), Buffer.from('"outbound.turn_usage"')],
      )
      for (const fact of facts.rows) {
        const payload = JSON.parse(fact.payload.toString('utf8')) as Record<string, unknown>
        if (!snapshot.usage && payload.type === 'outbound.turn_usage') {
          snapshot.usage = { frameSeq: Number(fact.frame_seq), usage: payload.usage as TurnTokenUsageSnapshot }
        } else if (!latestStatus && payload.type === 'outbound.turn_status') latestStatus = payload
      }
      if (facts.rows.length < 64) break
      const last = facts.rows[facts.rows.length - 1]!
      before = [last.frame_seq, last.record_id]
    }
  }
  if (needStatus) {
    snapshot.engineReady = hasFrames
      ? await readOpenDispatchEngineReady(q, { dispatchId: row.dispatch_id, attemptNo: row.attempt_no })
      : false
    snapshot.turnStatus = openDispatchTurnStatusSnapshotFrame({
      peerId: sessionId, agentId, clientMessageId: row.client_message_id,
      engineReady: snapshot.engineReady, admittedAt: row.admitted_at, now: asOf, credits: snapshot.credits,
    })
    if (latestStatus && !(snapshot.engineReady &&
      (latestStatus.status === 'engine_starting' || latestStatus.status === 'engine_resuming'))) {
      snapshot.turnStatus = { ...snapshot.turnStatus, status: latestStatus.status,
        ...(latestStatus.retry ? { retry: latestStatus.retry } : {}),
        ...(latestStatus.detail ? { detail: latestStatus.detail } : {}),
      }
    }
  }
  const agentAfter = options.afterSeqByAgent && Object.prototype.hasOwnProperty.call(options.afterSeqByAgent, agentId)
    ? options.afterSeqByAgent[agentId] : undefined
  const requestedAfter = typeof agentAfter === 'number' && Number.isSafeInteger(agentAfter) && agentAfter >= 0
    ? agentAfter : requestedAfterBase
  const sameRequestedStream = options.streamKey === streamKey &&
    (!options.streamKeyAgentId || options.streamKeyAgentId === agentId)
  const reset = requestedAfter > 0 && (!sameRequestedStream || requestedAfter > (snapshot.lastFrameSeq ?? 0))
  const after = reset ? 0 : requestedAfter
  snapshot.nextAfterSeq = after
  const limit = Number.isSafeInteger(options.limit) ? Math.max(1, Math.min(500, options.limit!)) : 200
  if (stream?.projection_source === 'tape') {
    snapshot.gap = { reason: 'tape' }
    return snapshot
  }
  if (!hasFrames) {
    snapshot.gap ??= reset ? { reason: 'cursor_reset' } : containerLinkGap
    return snapshot
  }
  const page = await q.query<{
    record_id: string; frame_seq: string; payload: Buffer | null; payload_sha256: string
  }>(
    `/* session-snapshot-frames */
     WITH candidates AS (
       SELECT record_id,frame_seq,payload_sha256,octet_length(payload) AS nbytes
         FROM client_session_live_frames WHERE stream_key=$1 AND frame_seq>$2
        ORDER BY frame_seq,record_id LIMIT $3
     ), sized AS (
       SELECT *,SUM(nbytes) OVER (ORDER BY frame_seq,record_id) AS total_bytes FROM candidates
     )
     SELECT p.record_id::text,p.frame_seq,f.payload,p.payload_sha256
       FROM sized p LEFT JOIN client_session_live_frames f
         ON f.record_id=p.record_id AND p.total_bytes<=$4
      ORDER BY p.frame_seq,p.record_id`, [streamKey, after, limit + 1, SESSION_SNAPSHOT_MAX_BYTES],
  )
  let sequenceGap: SessionSnapshot['gap'] = null
  for (const frame of page.rows.slice(0, limit)) {
    if (frame.payload === null) {
      if (!reset) {
        snapshot.gap = { reason: 'byte_limit', recordId: frame.record_id, sha256: frame.payload_sha256, frameSeq: Number(frame.frame_seq) }
      }
      snapshot.hasMore = true
      break
    }
    if (snapshot.nextAfterSeq > 0 && Number(frame.frame_seq) > snapshot.nextAfterSeq + 1) {
      sequenceGap ??= { reason: 'sequence_gap', afterSeq: snapshot.nextAfterSeq, beforeSeq: Number(frame.frame_seq) }
    }
    snapshot.frames.push({ recordId: frame.record_id, frameSeq: Number(frame.frame_seq), payload: JSON.parse(frame.payload.toString('utf8')) })
    snapshot.nextAfterSeq = Number(frame.frame_seq)
  }
  snapshot.hasMore ||= page.rows.length > limit
  snapshot.gap ??= reset ? { reason: 'cursor_reset' } : containerLinkGap ?? sequenceGap ?? (snapshot.hasMore ? { reason: 'page_limit' } : null)
  return snapshot
}

export async function readSessionSnapshot(
  pool: Pool, uid: string, sessionId: string, options: SessionSnapshotOptions = {},
): Promise<SessionSnapshot | null> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const result = await buildSessionSnapshot(client, uid, sessionId, options)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* preserve original error */ }
    throw error
  } finally { client.release() }
}

export interface BatchSessionSnapshotTarget {
  sessionId: string
  options?: SessionSnapshotOptions
}

/**
 * Batch-read WS `hello` snapshots for multiple sessions inside ONE
 * `REPEATABLE READ READ ONLY` transaction (OCV5-824), eliminating the 64-serial
 * transaction storm while preserving exact single-session snapshot semantics.
 *
 * All queries on the single `PoolClient` execute strictly sequentially.
 */
export async function readSessionSnapshotsBatch(
  pool: Pool,
  uid: string,
  targets: readonly BatchSessionSnapshotTarget[],
  batchOptions?: { containerId?: number },
): Promise<Map<string, SessionSnapshot>> {
  const result = new Map<string, SessionSnapshot>()
  if (!/^[1-9][0-9]*$/.test(uid) || targets.length === 0) return result
  const uniqueTargets: BatchSessionSnapshotTarget[] = []
  const seen = new Set<string>()
  for (const t of targets) {
    if (!t.sessionId || seen.has(t.sessionId)) continue
    seen.add(t.sessionId)
    uniqueTargets.push(t)
  }
  if (uniqueTargets.length === 0) return result

  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const requestedIds = uniqueTargets.map((t) => t.sessionId)
    const ownedRows = (await client.query<{ session_id: string; as_of: string }>(
      `/* session-snapshot-batch-owner */
       SELECT id AS session_id,
              (EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint AS as_of
         FROM client_sessions
        WHERE user_id=$1 AND deleted_at IS NULL AND id=ANY($2::text[])`,
      [`c:${uid}`, requestedIds],
    )).rows
    if (ownedRows.length === 0) {
      await client.query('COMMIT')
      return result
    }
    const asOfBySession = new Map<string, number>()
    for (const r of ownedRows) asOfBySession.set(r.session_id, Number(r.as_of))
    const ownedTargets = uniqueTargets.filter((t) => asOfBySession.has(t.sessionId))
    const ownedIds = ownedTargets.map((t) => t.sessionId)

    const openDispatches = (await client.query<{ session_id: string }>(
      `/* session-snapshot-batch-dispatch */
       SELECT DISTINCT session_id
         FROM turn_dispatches
        WHERE user_id=$1::bigint AND session_id=ANY($2::text[])
          AND status IN ('admitted','accepted','rejecting')`,
      [uid, ownedIds],
    )).rows
    const openSessionSet = new Set(openDispatches.map((r) => r.session_id))

    const detailedTargets: BatchSessionSnapshotTarget[] = []
    const idleTargets: BatchSessionSnapshotTarget[] = []
    for (const t of ownedTargets) {
      if (openSessionSet.has(t.sessionId) || t.options?.clientMessageId) {
        detailedTargets.push(t)
      } else {
        idleTargets.push(t)
      }
    }

    if (idleTargets.length > 0) {
      const idleIds = idleTargets.map((t) => t.sessionId)
      const recoveryRows = (await client.query<RecoveryRow & { session_id: string }>(
        `/* session-snapshot-batch-recovery */
         SELECT DISTINCT ON (session_id)
                session_id, status, semantic_recovery_attempt,
                request_json->'_automaticRecoveryRetryLimit' AS retry_limit
           FROM turn_recovery_jobs
          WHERE user_id=$1::bigint AND session_id=ANY($2::text[])
            AND status IN ('queued','leased','sent','forwarded')
          ORDER BY session_id, created_at DESC, job_id DESC`,
        [uid, idleIds],
      )).rows
      const recoveryBySession = new Map<string, RecoveryRow>()
      for (const r of recoveryRows) recoveryBySession.set(r.session_id, r)

      const permissionsBySession = new Map<string, SessionSnapshot['pendingPermissions']>()
      const uidBig = BigInt(uid)
      for (let i = 0; i < idleIds.length; i += HELLO_PENDING_PERMISSION_MAX_SESSIONS) {
        const chunk = idleIds.slice(i, i + HELLO_PENDING_PERMISSION_MAX_SESSIONS)
        try {
          const scan = await readPendingPermissionPromptsForSessions(client, {
            userId: uidBig,
            sessionIds: chunk,
            limitPerSession: 64,
          })
          const uncovered = new Set(scan.uncoveredSessionIds)
          for (const sid of chunk) {
            const asOf = asOfBySession.get(sid) ?? Date.now()
            const sessionKey = `agent:main:webchat:dm:${sid.replace(/[^a-zA-Z0-9_-]/g, '_')}`
            const rows = scan.bySession.get(sid) ?? []
            const items = rows
              .map((p) => pendingPermissionPromptToFrame(p, { peerId: sid, sessionKey }, asOf))
              .filter((p): p is Record<string, unknown> => p !== null)
            permissionsBySession.set(sid, {
              items,
              completeness: uncovered.has(sid) || rows.length >= 64 ? 'truncated' : 'complete',
            })
          }
        } catch {
          for (const sid of chunk) {
            permissionsBySession.set(sid, { items: [], completeness: 'unavailable' })
          }
        }
      }

      const containerId = batchOptions?.containerId
      const cursorCheckIds = typeof containerId === 'number' && Number.isSafeInteger(containerId) && containerId > 0
        ? idleTargets.filter((t) => hasPositiveCursor(t.options ?? {})).map((t) => t.sessionId)
        : []
      const lastContainerBySession = new Map<string, number>()
      if (cursorCheckIds.length > 0) {
        const cursorRows = (await client.query<{ session_id: string; agent_container_id: string | number | null }>(
          `/* session-snapshot-batch-container-cursor */
           SELECT DISTINCT ON (session_id)
                  session_id, agent_container_id
             FROM turn_dispatches
            WHERE user_id=$1::bigint AND session_id=ANY($2::text[])
              AND agent_container_id IS NOT NULL
            ORDER BY session_id, admitted_at DESC, dispatch_id DESC`,
          [uid, cursorCheckIds],
        )).rows
        for (const r of cursorRows) {
          if (r.agent_container_id != null) lastContainerBySession.set(r.session_id, Number(r.agent_container_id))
        }
      }
      const cursorCheckSet = new Set(cursorCheckIds)

      for (const t of idleTargets) {
        const asOf = asOfBySession.get(t.sessionId)!
        const snap = emptySessionSnapshot(t.sessionId, asOf)
        snap.recovery = buildRecoveryState(recoveryBySession.get(t.sessionId))
        snap.pendingPermissions = permissionsBySession.get(t.sessionId) ?? { items: [], completeness: 'complete' }
        if (cursorCheckSet.has(t.sessionId)) {
          const lastCid = lastContainerBySession.get(t.sessionId)
          if (lastCid === undefined || lastCid !== containerId) {
            snap.gap = { reason: 'cursor_reset' }
          }
        }
        result.set(t.sessionId, snap)
      }
    }

    for (const t of detailedTargets) {
      const snap = await buildSessionSnapshot(client, uid, t.sessionId, {
        ...(t.options ?? {}),
        ...(typeof batchOptions?.containerId === 'number' ? { containerId: batchOptions.containerId } : {}),
      })
      if (snap) result.set(t.sessionId, snap)
    }

    await client.query('COMMIT')
    return result
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* preserve original error */ }
    throw error
  } finally {
    client.release()
  }
}
