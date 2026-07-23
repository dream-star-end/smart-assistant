import type { PgConn, PgRunner } from '../wechat/sessionPointer.js'
import type { WechatSessionId } from '../wechat/types.js'

export interface QqSessionPointer {
  sessionId: WechatSessionId
  agentId?: string
}

export async function getCurrentQqSessionId(
  conn: PgConn,
  userId: string,
): Promise<WechatSessionId | null> {
  const result = await (conn as PgRunner).query<{ current_session_id: string }>(
    'SELECT current_session_id FROM qq_session_pointer WHERE user_id = $1 LIMIT 1',
    [userId],
  )
  return result.rowCount === 0 ? null : (result.rows[0]!.current_session_id as WechatSessionId)
}

export async function getCurrentQqSessionPointer(
  conn: PgConn,
  userId: string,
): Promise<QqSessionPointer | null> {
  const result = await (conn as PgRunner).query<{
    current_session_id: string
    current_agent_id: string | null
  }>(
    `SELECT current_session_id, current_agent_id
       FROM qq_session_pointer
      WHERE user_id = $1
      LIMIT 1`,
    [userId],
  )
  if (result.rowCount === 0) return null
  const row = result.rows[0]!
  return {
    sessionId: row.current_session_id as WechatSessionId,
    ...(row.current_agent_id ? { agentId: row.current_agent_id } : {}),
  }
}

export async function setCurrentQqSessionId(
  conn: PgConn,
  userId: string,
  sessionId: WechatSessionId,
  now: number,
  agentId?: string,
): Promise<boolean> {
  const result = await (conn as PgRunner).query(
    `INSERT INTO qq_session_pointer
       (user_id, current_session_id, current_agent_id, updated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET
       current_session_id = EXCLUDED.current_session_id,
       current_agent_id   = EXCLUDED.current_agent_id,
       updated_at         = EXCLUDED.updated_at
     WHERE qq_session_pointer.updated_at <= EXCLUDED.updated_at`,
    [userId, sessionId, agentId ?? null, now],
  )
  return (result.rowCount ?? 0) > 0
}

export async function markRunningQqSession(
  conn: PgConn,
  userId: string,
  sessionId: WechatSessionId,
  runId: string,
  agentId: string | undefined,
  now: number,
): Promise<void> {
  await (conn as PgRunner).query(
    `INSERT INTO qq_running_sessions
       (user_id, session_id, run_id, agent_id, started_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (user_id, session_id, run_id) DO UPDATE SET
       agent_id   = EXCLUDED.agent_id,
       updated_at = EXCLUDED.updated_at`,
    [userId, sessionId, runId, agentId ?? null, now],
  )
}

export async function listRunningQqSessions(
  conn: PgConn,
  userId: string,
): Promise<Array<{ sessionId: WechatSessionId; runId: string; agentId?: string }>> {
  const result = await (conn as PgRunner).query<{
    session_id: string
    run_id: string
    agent_id: string | null
  }>(
    `SELECT session_id, run_id, agent_id
       FROM qq_running_sessions
      WHERE user_id = $1
      ORDER BY started_at DESC`,
    [userId],
  )
  return result.rows.map((row) => ({
    sessionId: row.session_id as WechatSessionId,
    runId: row.run_id,
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
  }))
}

export async function clearRunningQqSession(
  conn: PgConn,
  userId: string,
  sessionId: WechatSessionId,
  runId: string,
): Promise<boolean> {
  const result = await (conn as PgRunner).query(
    `DELETE FROM qq_running_sessions
      WHERE user_id = $1 AND session_id = $2 AND run_id = $3`,
    [userId, sessionId, runId],
  )
  return (result.rowCount ?? 0) > 0
}

export async function deleteQqSessionPointer(conn: PgConn, userId: string): Promise<boolean> {
  const result = await (conn as PgRunner).query(
    'DELETE FROM qq_session_pointer WHERE user_id = $1',
    [userId],
  )
  return (result.rowCount ?? 0) > 0
}
