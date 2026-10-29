import { automaticRetryStatus, type SessionSnapshot, type TurnTokenUsageSnapshot } from '@openclaude/protocol'
import type { Pool, PoolClient } from 'pg'
import { readDispatchSettledCredits } from '../billing/dispatchSettledCredits.js'
import { pendingPermissionPromptToFrame, readPendingPermissionPrompts } from '../dispatch/turnControlStore.js'
import { readOpenDispatchEngineReady } from './liveTurnFrames.js'
import { openDispatchTurnStatusSnapshotFrame, terminalDispatchReconcile } from './sessionSnapshotStatus.js'

export interface SessionSnapshotOptions {
  afterSeq?: number
  limit?: number
  clientMessageId?: string
  /** Echo the previous snapshot's stream identity whenever afterSeq is nonzero. */
  streamKey?: string
}
export const SESSION_SNAPSHOT_MAX_BYTES = 1024 * 1024

type Queryable = Pick<PoolClient, 'query'>
type SnapshotFact = { record_id: string; frame_seq: string; payload: Buffer }
type Dispatch = {
  dispatch_id: string; client_message_id: string; agent_id: string
  status: string; outcome: string | null; attempt_no: number
  admitted_at: Date; accepted_at: Date | null; terminal_at: Date | null
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
  const snapshot: SessionSnapshot = {
    v: 1, sessionId, dispatch: null, streamKey: null, lastFrameSeq: null, lastFrameAt: null,
    engineReady: null, turnStatus: null, reconcile: null, recovery: null,
    pendingPermissions: { items: [], completeness: 'complete' }, usage: null, credits: null,
    frames: [], nextAfterSeq: 0, hasMore: false, gap: null, asOf,
  }
  // Optional during rolling upgrades; a missing recovery table must not poison
  // the transaction used by the remaining authoritative snapshot queries.
  await q.query('SAVEPOINT session_snapshot_recovery')
  try {
    const recovery = (await q.query<{
      status: NonNullable<SessionSnapshot['recovery']>['status']
      semantic_recovery_attempt: number; retry_limit: number | null
    }>(
      `/* session-snapshot-recovery */
       SELECT status,semantic_recovery_attempt,
              request_json->'_automaticRecoveryRetryLimit' AS retry_limit
         FROM turn_recovery_jobs
        WHERE user_id=$1::bigint AND session_id=$2
          AND status IN ('queued','leased','sent','forwarded')
        ORDER BY created_at DESC,job_id DESC LIMIT 1`,
      [uid, sessionId],
    )).rows[0]
    if (recovery) {
      const retryStatus = automaticRetryStatus(recovery.status === 'forwarded' ? 'running' : 'scheduled',
        recovery.semantic_recovery_attempt, recovery.retry_limit ?? undefined)
      snapshot.recovery = {
        status: recovery.status, attempt: recovery.semantic_recovery_attempt, maxAttempts: recovery.retry_limit,
        retryStatus: { ...retryStatus, actions: [...retryStatus.actions] },
      }
    }
  } catch (error) {
    await q.query('ROLLBACK TO SAVEPOINT session_snapshot_recovery')
    // Only a not-yet-migrated rolling peer means this optional fact is absent.
    // A timeout/read failure cannot prove that automatic recovery stopped.
    if ((error as { code?: unknown } | null)?.code !== '42P01') throw error
  } finally {
    await q.query('RELEASE SAVEPOINT session_snapshot_recovery')
  }
  const agentId = row?.agent_id || 'main'
  const sessionKey = `agent:${agentId}:webchat:dm:${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
  try {
    const permissions = await readPendingPermissionPrompts(q, { userId: BigInt(uid), sessionId, limit: 64 })
    snapshot.pendingPermissions = {
      items: permissions.map(p => pendingPermissionPromptToFrame(p, { peerId: sessionId, sessionKey }, asOf))
        .filter((p): p is Record<string, unknown> => p !== null),
      completeness: permissions.length === 64 ? 'truncated' : 'complete',
    }
  } catch {
    snapshot.pendingPermissions.completeness = 'unavailable'
  }
  if (!row) return snapshot
  snapshot.dispatch = {
    id: row.dispatch_id, clientMessageId: row.client_message_id, agentId,
    status: row.status, outcome: row.outcome, attempt: row.attempt_no,
    since: row.admitted_at.getTime(), acceptedAt: row.accepted_at?.getTime() ?? null,
    terminalAt: row.terminal_at?.getTime() ?? null,
  }
  const streamKey = `dispatch:${row.dispatch_id}:${row.attempt_no}`
  snapshot.streamKey = streamKey
  // A failed optional credit query must not abort the transaction's state read.
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
    projection_source: string; provenance: { containerLinkGap?: SessionSnapshot['gap'] }; frame_seq: string | null; created_at: Date | null
  }>(
    `/* session-snapshot-watermark */
     SELECT s.projection_source, s.provenance, f.frame_seq, f.created_at
       FROM client_session_live_streams s
       LEFT JOIN LATERAL (
         SELECT frame_seq,created_at FROM client_session_live_frames
          WHERE stream_key=s.stream_key ORDER BY frame_seq DESC LIMIT 1
       ) f ON TRUE
      WHERE s.stream_key=$1 AND s.user_id=$2 AND s.session_id=$3`,
    [streamKey, `c:${uid}`, sessionId],
  )).rows[0]
  snapshot.gap = stream?.provenance?.containerLinkGap ?? null
  snapshot.lastFrameSeq = stream?.frame_seq == null ? null : Number(stream.frame_seq)
  snapshot.lastFrameAt = stream?.created_at?.getTime() ?? null

  // BYTEA can contain JSON strings that PostgreSQL JSONB cannot represent
  // (e.g. escaped NUL / lone surrogates). Narrow by wire-type bytes, then
  // JSON.parse and verify the top-level type in JS. Page past false positives
  // such as nested objects; never cap the latest-usage search at 64 tail frames.
  let latestStatus: Record<string, unknown> | null = null
  let before: [string, string] | null = null
  while (!latestStatus || !snapshot.usage) {
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
  if (row.status === 'admitted' || row.status === 'accepted') {
    snapshot.engineReady = await readOpenDispatchEngineReady(q, { dispatchId: row.dispatch_id, attemptNo: row.attempt_no })
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
  const requestedAfter = Number.isSafeInteger(options.afterSeq) && options.afterSeq! > 0 ? options.afterSeq! : 0
  const reset = requestedAfter > 0 && (options.streamKey !== streamKey || requestedAfter > (snapshot.lastFrameSeq ?? 0))
  const after = reset ? 0 : requestedAfter
  snapshot.nextAfterSeq = after
  const limit = Number.isSafeInteger(options.limit) ? Math.max(1, Math.min(500, options.limit!)) : 200
  if (stream?.projection_source === 'tape') {
    snapshot.gap = { reason: 'tape' }
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
  for (const frame of page.rows.slice(0, limit)) {
    if (frame.payload === null) {
      // Fetch exact bytes through the existing payload endpoint, then advance
      // to frameSeq. Do not silently skip a frame or loop at the same cursor.
      snapshot.gap = { reason: 'byte_limit', recordId: frame.record_id, sha256: frame.payload_sha256, frameSeq: Number(frame.frame_seq) }
      snapshot.hasMore = true
      break
    }
    if (snapshot.nextAfterSeq > 0 && Number(frame.frame_seq) > snapshot.nextAfterSeq + 1) {
      // A session-scoped sequence can include non-journalled sidebands. Report
      // the observed discontinuity, without claiming those bytes are recoverable.
      snapshot.gap ??= { reason: 'sequence_gap', afterSeq: snapshot.nextAfterSeq, beforeSeq: Number(frame.frame_seq) }
    }
    snapshot.frames.push({ recordId: frame.record_id, frameSeq: Number(frame.frame_seq), payload: JSON.parse(frame.payload.toString('utf8')) })
    snapshot.nextAfterSeq = Number(frame.frame_seq)
  }
  snapshot.hasMore ||= page.rows.length > limit
  snapshot.gap ??= reset ? { reason: 'cursor_reset' } : snapshot.hasMore ? { reason: 'page_limit' } : null
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
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}
