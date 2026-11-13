import type { Pool } from 'pg'

export interface FailedStartSource {
  model: string
  agent: string
  dispatchId: string
}

const zeroCounter = (alias: string, key: string) =>
  `jsonb_typeof(${alias}.usage->'${key}')='number' AND (${alias}.usage->>'${key}')='0'`

/**
 * A first turn that crashed at zero tokens leaves no executed source, yet the
 * session still looks like "history exists" to the ordinary reader. This proof
 * is deliberately narrow: the newest tape in the whole session is a finalized
 * zero-token crash, exactly one accepted terminal crashed dispatch owns it, and
 * nothing else in the session (tape, usage, archive, other dispatch) proves any
 * executed or unknown history. It only names the failed attempt's route; it is
 * never evidence that a turn ran, so the caller must not turn it into a numeric
 * context and must never report it as an empty session.
 *
 * The NOT EXISTS predicates are whole-session on purpose: the ordinary reader
 * only sees the six newest tapes, while a stale successful tape, a usage row or
 * a child tape must veto the exemption no matter how far back it sits.
 */
export async function readFailedStartSource(
  pool: Pool,
  uid: string,
  sessionId: string,
  requestId: string,
  tape: { tapeId: string; clientMessageId: string | null },
): Promise<FailedStartSource | null> {
  if (!tape.clientMessageId) return null
  const row = (
    await pool.query<{
      dispatch_id: string
      tape_sha256: string
      model: string | null
      agent_id: string
      messages: string | null
    }>(
      `WITH root AS (
         SELECT t.session_id,t.tape_id,t.agent_id,t.status,t.finalized_at,t.client_message_id,
                t.usage,t.created_at,t.dispatch_id,t.attempt_no,t.tape_sha256
           FROM client_session_turn_tapes t /* model-switch-failed-start */
          WHERE t.session_id=$1 AND t.user_id=$2 AND t.tape_id=$3
            AND t.parent_turn_key IS NULL AND t.continuation_of_turn_key IS NULL
            AND (t.usage->>'model') IS DISTINCT FROM 'gpt-image-2'
       ), zero AS (
         SELECT * FROM root
          WHERE status='crashed' AND finalized_at IS NOT NULL AND client_message_id IS NOT NULL
            AND usage->>'model' IS NOT NULL AND dispatch_id IS NOT NULL AND attempt_no IS NOT NULL
            AND ${zeroCounter('root', 'inputTokens')} AND ${zeroCounter('root', 'outputTokens')}
            AND ${zeroCounter('root', 'cacheReadTokens')}
            AND ${zeroCounter('root', 'cacheCreationTokens')}
       ), failed AS (
         SELECT d.dispatch_id AS dispatch_id,d.model::text AS model,d.agent_id::text AS agent_id
           FROM turn_dispatches d JOIN zero z ON z.dispatch_id=d.dispatch_id
            AND z.attempt_no=d.attempt_no AND z.client_message_id=d.client_message_id
          WHERE d.user_id=$4::bigint AND d.session_id=$1
            AND d.status='terminal' AND d.outcome='crashed' AND d.accepted_at IS NOT NULL
            AND d.agent_id=z.agent_id AND d.model=z.usage->>'model'
          ORDER BY d.attempt_no DESC,d.admitted_at DESC LIMIT 1
       )
       SELECT z.tape_id,z.tape_sha256,f.dispatch_id,f.model,f.agent_id,
              CASE WHEN octet_length(cs.messages)<=65536 THEN cs.messages ELSE NULL END AS messages
         FROM zero z
         JOIN failed f ON TRUE
         JOIN client_sessions cs ON cs.id=z.session_id AND cs.user_id=$2
        WHERE cs.deleted_at IS NULL
          -- Nothing newer than this tape anywhere in the session (not the six-row window).
          AND NOT EXISTS (SELECT 1 FROM client_session_turn_tapes t4
             WHERE t4.session_id=$1 AND t4.user_id=$2
               AND (t4.created_at,t4.tape_id)>(z.created_at,z.tape_id))
          -- Any child or continuation tape carries model-visible history.
          AND NOT EXISTS (SELECT 1 FROM client_session_turn_tapes t3
             WHERE t3.session_id=$1 AND t3.user_id=$2
               AND (t3.parent_turn_key IS NOT NULL OR t3.continuation_of_turn_key IS NOT NULL))
          -- Every other tape must itself be a finalized zero-token crash.
          AND NOT EXISTS (SELECT 1 FROM client_session_turn_tapes t2
             WHERE t2.session_id=$1 AND t2.user_id=$2 AND t2.tape_id<>z.tape_id
               AND (t2.status='crashed' AND t2.finalized_at IS NOT NULL
                 AND ${zeroCounter('t2', 'inputTokens')} AND ${zeroCounter('t2', 'outputTokens')}
                 AND ${zeroCounter('t2', 'cacheReadTokens')}
                 AND ${zeroCounter('t2', 'cacheCreationTokens')}) IS NOT TRUE)
          -- Archived hot rows are real user-visible history.
          AND NOT EXISTS (SELECT 1 FROM client_session_archive_chunks a
             WHERE a.session_id=$1 AND a.user_id=$2)
          -- Anything billed or executed, including a zero-token success row.
          AND NOT EXISTS (SELECT 1 FROM usage_records u
             WHERE u.session_id=$1 AND u.user_id=$4::bigint
               AND (u.status<>'success' AND u.input_tokens=0 AND u.output_tokens=0
                 AND u.cache_read_tokens=0 AND u.cache_write_tokens=0) IS NOT TRUE)
          -- Any other turn's dispatch, except this request or the same failed turn.
          AND NOT EXISTS (SELECT 1 FROM turn_dispatches d2
             WHERE d2.user_id=$4::bigint AND d2.session_id=$1
               AND (d2.dispatch_id=f.dispatch_id OR
                 (d2.client_message_id=$5 AND d2.status='admitted' AND d2.accepted_at IS NULL)) IS NOT TRUE)`,
      [sessionId, `c:${uid}`, tape.tapeId, uid, requestId],
    )
  ).rows[0]
  if (!row || !row.messages) return null
  let messages: unknown
  try {
    messages = JSON.parse(row.messages)
  } catch {
    return null
  }
  if (!Array.isArray(messages)) return null
  for (const message of messages) {
    if (!message || typeof message !== 'object') return null
    const m = message as Record<string, unknown>
    // This tape's own anchor row and the failed/current user rows are the only
    // hot entries a zero-token first failure can legitimately leave behind.
    if (m._turnTapeId === tape.tapeId && m._turnTapeSha256 === row.tape_sha256 &&
        m._turnTapeComplete === true && m.role === 'assistant' && m._source === 'server' &&
        typeof m.id === 'string' &&
        (m._turnTapeRuntimeManifestSha256 === undefined ||
          (typeof m._turnTapeRuntimeManifestSha256 === 'string' && /^[a-f0-9]{64}$/.test(m._turnTapeRuntimeManifestSha256))) &&
        Object.keys(m).every(key => [
          'id', 'ts', '_seq', 'role', '_source', '_orderSeq', '_turnTapeId',
          '_turnTapeSha256', '_turnTapeComplete', '_turnTapeRecordCount',
          '_turnTapeLogicalRecordCount', '_turnTapePhysicalRecordCount', '_turnTapeRuntimeManifestSha256',
        ].includes(key))) continue
    if (
      m.role === 'user' &&
      (m.id === tape.clientMessageId ||
        m._clientMessageId === tape.clientMessageId ||
        m.id === requestId ||
        m._clientMessageId === requestId)
    )
      continue
    return null
  }
  if (row.model === null) return null
  return { model: row.model, agent: row.agent_id, dispatchId: row.dispatch_id }
}
