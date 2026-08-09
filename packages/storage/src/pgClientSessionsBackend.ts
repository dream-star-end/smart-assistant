import { createHash } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import {
  type ClientSession,
  type ClientSessionMeta,
  type ClientSessionTapeFrame,
  type ClientSessionTapePage,
  type ClientSessionsBackend,
  type ClientTurnState,
  type MessageLike,
  appendServerAuthoredPure,
  mergePreservingServerAuthored,
} from './sessionsDb.js'

export const PERSONAL_SESSIONS_SCHEMA_VERSION = 1

function int(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0)
}

function nullableInt(value: unknown): number | null {
  return value === null || value === undefined ? null : int(value)
}

function parseMessages(raw: unknown): MessageLike[] | null {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(parsed) ? (parsed as MessageLike[]) : null
  } catch {
    return null
  }
}

async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function lockSession(client: PoolClient, sessionId: string, userId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `${userId}:${sessionId}`,
  ])
}

async function markAuthorityMutation(client: PoolClient): Promise<void> {
  await client.query(
    `UPDATE client_sessions_authority
     SET mutation_count = mutation_count + 1,
         first_mutation_at = COALESCE(first_mutation_at, $1)
     WHERE singleton = TRUE`,
    [Date.now()],
  )
}

/** Schema creation is an explicit migration operation; gateway startup only probes it. */
export async function createPgClientSessionsSchema(pool: Pool): Promise<void> {
  await transaction(pool, async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS openclaude_schema_meta (
        key TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        updated_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS client_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL DEFAULT 'main',
        title TEXT NOT NULL DEFAULT '新会话',
        pinned BOOLEAN NOT NULL DEFAULT FALSE,
        created_at BIGINT NOT NULL,
        last_at BIGINT NOT NULL,
        messages_json TEXT NOT NULL DEFAULT '[]',
        message_count INTEGER NOT NULL DEFAULT 0,
        tape_turn_count INTEGER NOT NULL DEFAULT 0,
        last_tape_seq BIGINT NOT NULL DEFAULT 0,
        updated_at BIGINT NOT NULL,
        deleted_at BIGINT
      );
      CREATE INDEX IF NOT EXISTS idx_client_sessions_user_last
        ON client_sessions(user_id, last_at DESC) WHERE deleted_at IS NULL;
      CREATE TABLE IF NOT EXISTS client_session_tape (
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        tape_seq BIGINT NOT NULL,
        turn_key TEXT NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
        ts BIGINT NOT NULL,
        frame_json TEXT NOT NULL,
        frame_bytes BIGINT NOT NULL,
        frame_sha256 TEXT NOT NULL,
        PRIMARY KEY (session_id, user_id, tape_seq)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_client_session_tape_inbound_turn
        ON client_session_tape(session_id, user_id, turn_key)
        WHERE direction = 'inbound';
      CREATE INDEX IF NOT EXISTS idx_client_session_tape_turn
        ON client_session_tape(session_id, user_id, turn_key, tape_seq);
      CREATE TABLE IF NOT EXISTS client_session_tape_payload_parts (
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        tape_seq BIGINT NOT NULL,
        part_index INTEGER NOT NULL,
        payload BYTEA NOT NULL,
        PRIMARY KEY (session_id, user_id, tape_seq, part_index)
      );
      CREATE TABLE IF NOT EXISTS client_session_turns (
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        client_message_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('running', 'completed', 'interrupted')),
        started_at BIGINT NOT NULL,
        finished_at BIGINT,
        PRIMARY KEY (session_id, user_id, client_message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_client_session_turns_latest
        ON client_session_turns(session_id, user_id, started_at DESC);
      CREATE TABLE IF NOT EXISTS client_session_tombstones (
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        deleted_at BIGINT NOT NULL,
        last_tape_seq BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS client_sessions_authority (
        singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
        mutation_count BIGINT NOT NULL DEFAULT 0,
        first_mutation_at BIGINT
      );
      INSERT INTO client_sessions_authority(singleton) VALUES (TRUE)
        ON CONFLICT(singleton) DO NOTHING;
    `)
    await client.query(
      `INSERT INTO openclaude_schema_meta(key, version, updated_at)
       VALUES ('personal_client_sessions', $1, $2)
       ON CONFLICT(key) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`,
      [PERSONAL_SESSIONS_SCHEMA_VERSION, Date.now()],
    )
  })
}

export function createPgClientSessionsBackend(source: string | Pool): ClientSessionsBackend {
  const ownsPool = typeof source === 'string'
  const pool = ownsPool ? new Pool({ connectionString: source }) : source

  const backend: ClientSessionsBackend = {
    probe: async () => {
      const result = await pool.query(
        `SELECT version FROM openclaude_schema_meta WHERE key = 'personal_client_sessions'`,
      )
      if (
        result.rowCount !== 1 ||
        int(result.rows[0]?.version) !== PERSONAL_SESSIONS_SCHEMA_VERSION
      ) {
        throw new Error(
          `personal sessions PostgreSQL schema mismatch: expected ${PERSONAL_SESSIONS_SCHEMA_VERSION}`,
        )
      }
    },

    close: async () => {
      if (ownsPool) await pool.end()
    },

    upsertClientSession: async (session: ClientSession, baseSyncedAt = 0) =>
      transaction(pool, async (client) => {
        await lockSession(client, session.id, session.userId)
        const existingResult = await client.query(
          `SELECT messages_json, updated_at FROM client_sessions
           WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE`,
          [session.id, session.userId],
        )
        const existing = existingResult.rows[0] as
          | { messages_json: string; updated_at: string | number }
          | undefined
        if (existing && int(existing.updated_at) > baseSyncedAt) return false

        let oldMessages = existing ? (parseMessages(existing.messages_json) ?? []) : []
        const tape = await client.query(
          `SELECT MIN(ts) AS first_ts, COUNT(DISTINCT turn_key) AS turn_count,
                  COALESCE(MAX(tape_seq), 0) AS last_seq
           FROM client_session_tape WHERE session_id = $1 AND user_id = $2`,
          [session.id, session.userId],
        )
        const firstTapeTs = nullableInt(tape.rows[0]?.first_ts)
        const inboundIds = new Set<string>()
        if (firstTapeTs !== null) {
          const inbound = await client.query(
            `SELECT frame_json FROM client_session_tape
             WHERE session_id = $1 AND user_id = $2 AND direction = 'inbound'
             ORDER BY tape_seq`,
            [session.id, session.userId],
          )
          for (const row of inbound.rows as Array<{ frame_json: string }>) {
            try {
              const parsed = JSON.parse(row.frame_json) as { clientMessage?: { id?: unknown } }
              if (typeof parsed.clientMessage?.id === 'string')
                inboundIds.add(parsed.clientMessage.id)
            } catch {}
          }
        }
        oldMessages = oldMessages.filter(
          (message) => typeof message.id !== 'string' || !inboundIds.has(message.id),
        )
        const submitted = session.messages as MessageLike[]
        const firstTapedClientIndex = submitted.findIndex(
          (message) => typeof message.id === 'string' && inboundIds.has(message.id),
        )
        const beforeTape = (message: MessageLike) =>
          firstTapeTs === null || (typeof message.ts === 'number' && message.ts < firstTapeTs)
        const clientMessages =
          existing && firstTapeTs !== null
            ? []
            : firstTapeTs === null
              ? submitted
              : firstTapedClientIndex >= 0
                ? submitted.slice(0, firstTapedClientIndex)
                : submitted.filter(beforeTape)
        const finalMessages =
          existing && firstTapeTs !== null
            ? oldMessages
            : mergePreservingServerAuthored(oldMessages, clientMessages)
        const result = await client.query(
          `INSERT INTO client_sessions
             (id, user_id, agent_id, title, pinned, created_at, last_at, messages_json,
              message_count, tape_turn_count, last_tape_seq, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT(id) DO UPDATE SET
             agent_id = excluded.agent_id,
             title = excluded.title,
             pinned = excluded.pinned,
             last_at = excluded.last_at,
             messages_json = excluded.messages_json,
             message_count = excluded.message_count,
             tape_turn_count = GREATEST(client_sessions.tape_turn_count, excluded.tape_turn_count),
             last_tape_seq = GREATEST(client_sessions.last_tape_seq, excluded.last_tape_seq),
             updated_at = excluded.updated_at
           WHERE client_sessions.updated_at <= $13
             AND client_sessions.user_id = excluded.user_id
           RETURNING id`,
          [
            session.id,
            session.userId,
            session.agentId,
            session.title,
            session.pinned,
            session.createdAt,
            session.lastAt,
            JSON.stringify(finalMessages),
            finalMessages.length,
            int(tape.rows[0]?.turn_count),
            int(tape.rows[0]?.last_seq),
            session.updatedAt,
            baseSyncedAt,
          ],
        )
        if (result.rowCount === 1) await markAuthorityMutation(client)
        return result.rowCount === 1
      }),

    appendServerAuthoredMessage: async (sessionId, userId, message) =>
      transaction(pool, async (client) => {
        await lockSession(client, sessionId, userId)
        const selected = await client.query(
          `SELECT messages_json FROM client_sessions
           WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE`,
          [sessionId, userId],
        )
        const row = selected.rows[0] as { messages_json: string } | undefined
        if (!row) return { applied: false, reason: 'session_not_found' as const }
        const taped = await client.query(
          'SELECT 1 FROM client_session_tape WHERE session_id = $1 AND user_id = $2 LIMIT 1',
          [sessionId, userId],
        )
        if (taped.rowCount) return { applied: false, reason: 'tape_authoritative' as const }
        const messages = parseMessages(row.messages_json)
        if (!messages) return { applied: false, reason: 'malformed' as const }
        const appended = appendServerAuthoredPure(messages, message as MessageLike & { id: string })
        if (!appended.applied) return { applied: false, reason: appended.reason }
        const now = Date.now()
        await client.query(
          `UPDATE client_sessions SET messages_json = $1, message_count = $2,
             last_at = $3, updated_at = $3 WHERE id = $4 AND user_id = $5`,
          [JSON.stringify(appended.messages), appended.messages.length, now, sessionId, userId],
        )
        await markAuthorityMutation(client)
        return { applied: true }
      }),

    appendClientSessionTapeFrame: async (input) =>
      transaction(pool, async (client) => {
        await lockSession(client, input.sessionId, input.userId)
        if (input.direction === 'inbound') {
          const existing = await client.query(
            `SELECT tape_seq, ts, frame_json FROM client_session_tape
             WHERE session_id = $1 AND user_id = $2 AND turn_key = $3
               AND direction = 'inbound'`,
            [input.sessionId, input.userId, input.turnKey],
          )
          if (existing.rowCount) {
            const row = existing.rows[0]
            return {
              tapeSeq: int(row.tape_seq),
              turnKey: input.turnKey,
              direction: 'inbound' as const,
              ts: int(row.ts),
              frame: JSON.parse(row.frame_json) as Record<string, unknown>,
              inserted: false,
            }
          }
        }
        const max = await client.query(
          `SELECT COALESCE(MAX(tape_seq), 0) AS max_seq FROM client_session_tape
           WHERE session_id = $1 AND user_id = $2`,
          [input.sessionId, input.userId],
        )
        const tapeSeq = int(max.rows[0]?.max_seq) + 1
        const frameJson = JSON.stringify(input.frame)
        const frameBytes = Buffer.byteLength(frameJson)
        const frameSha = createHash('sha256').update(frameJson).digest('hex')
        await client.query(
          `INSERT INTO client_session_tape
             (session_id,user_id,tape_seq,turn_key,direction,ts,frame_json,frame_bytes,frame_sha256)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            input.sessionId,
            input.userId,
            tapeSeq,
            input.turnKey,
            input.direction,
            input.ts,
            frameJson,
            frameBytes,
            frameSha,
          ],
        )
        await client.query(
          `UPDATE client_sessions SET last_tape_seq = $1,
             tape_turn_count = tape_turn_count + $2
           WHERE id = $3 AND user_id = $4`,
          [tapeSeq, input.direction === 'inbound' ? 1 : 0, input.sessionId, input.userId],
        )
        await markAuthorityMutation(client)
        return { ...input, tapeSeq, frame: input.frame, inserted: true }
      }),

    getClientSessionTapeMeta: async (sessionId, userId) => {
      const result = await pool.query(
        `SELECT MIN(tape_seq) AS first_seq, MIN(ts) AS first_ts,
                MAX(tape_seq) AS last_seq, COUNT(DISTINCT turn_key) AS turn_count
         FROM client_session_tape WHERE session_id = $1 AND user_id = $2`,
        [sessionId, userId],
      )
      const row = result.rows[0]
      return {
        firstTapeSeq: nullableInt(row?.first_seq),
        firstTapeTs: nullableInt(row?.first_ts),
        lastTapeSeq: nullableInt(row?.last_seq),
        turnCount: int(row?.turn_count),
      }
    },

    listClientSessionTapePage: async (
      sessionId,
      userId,
      opts = {},
    ): Promise<ClientSessionTapePage | null> => {
      const owned = await pool.query(
        `SELECT 1 FROM client_sessions
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [sessionId, userId],
      )
      if (!owned.rowCount) return null
      const before =
        Number.isSafeInteger(opts.before) && Number(opts.before) > 0
          ? Number(opts.before)
          : Number.MAX_SAFE_INTEGER
      const turns = Math.max(1, Math.min(50, Math.floor(opts.turns ?? 5)))
      const turnResult = await pool.query(
        `SELECT turn_key, MIN(tape_seq) AS first_seq
         FROM client_session_tape
         WHERE session_id = $1 AND user_id = $2
         GROUP BY turn_key HAVING MIN(tape_seq) < $3
         ORDER BY first_seq DESC LIMIT $4`,
        [sessionId, userId, before, turns],
      )
      const meta = await backend.getClientSessionTapeMeta(sessionId, userId)
      if (!turnResult.rowCount) {
        return { frames: [], ...meta, nextBefore: null, hasMore: false }
      }
      const keys = turnResult.rows.map((row) => String(row.turn_key))
      const records = await pool.query(
        `SELECT tape_seq, turn_key, direction, ts, frame_json
         FROM client_session_tape
         WHERE session_id = $1 AND user_id = $2 AND turn_key = ANY($3::text[])
         ORDER BY tape_seq`,
        [sessionId, userId, keys],
      )
      const frames: ClientSessionTapeFrame[] = records.rows.map((row) => ({
        tapeSeq: int(row.tape_seq),
        turnKey: String(row.turn_key),
        direction: row.direction,
        ts: int(row.ts),
        frame: JSON.parse(row.frame_json),
      }))
      const nextBefore = Math.min(...turnResult.rows.map((row) => int(row.first_seq)))
      const older = await pool.query(
        `SELECT 1 FROM client_session_tape
         WHERE session_id = $1 AND user_id = $2
         GROUP BY turn_key HAVING MIN(tape_seq) < $3 LIMIT 1`,
        [sessionId, userId, nextBefore],
      )
      return {
        frames,
        firstTapeSeq: meta.firstTapeSeq,
        firstTapeTs: meta.firstTapeTs,
        nextBefore,
        hasMore: !!older.rowCount,
      }
    },

    readClientSessionTapePayload: async (sessionId, userId, tapeSeq) => {
      const result = await pool.query(
        `SELECT convert_to(t.frame_json, 'UTF8') AS payload,
                t.frame_bytes, t.frame_sha256
         FROM client_session_tape t
         JOIN client_sessions s ON s.id = t.session_id AND s.user_id = t.user_id
         WHERE t.session_id = $1 AND t.user_id = $2 AND t.tape_seq = $3
           AND s.deleted_at IS NULL`,
        [sessionId, userId, tapeSeq],
      )
      const row = result.rows[0]
      if (!row) return null
      return {
        payload: Buffer.from(row.payload),
        bytes: int(row.frame_bytes),
        sha256: String(row.frame_sha256),
      }
    },

    listClientSessions: async (userId): Promise<ClientSessionMeta[]> => {
      const result = await pool.query(
        `SELECT id, agent_id, title, pinned, created_at, last_at, updated_at,
                message_count + 2 * tape_turn_count AS msg_count,
                tape_turn_count, NULLIF(last_tape_seq, 0) AS last_tape_seq
         FROM client_sessions WHERE user_id = $1 AND deleted_at IS NULL
         ORDER BY last_at DESC`,
        [userId],
      )
      return result.rows.map((row) => ({
        id: row.id,
        agentId: row.agent_id,
        title: row.title,
        pinned: row.pinned,
        createdAt: int(row.created_at),
        lastAt: int(row.last_at),
        messageCount: int(row.msg_count),
        tapeTurnCount: int(row.tape_turn_count),
        lastTapeSeq: nullableInt(row.last_tape_seq),
        updatedAt: int(row.updated_at),
      }))
    },

    getClientSession: async (id, userId): Promise<ClientSession | null> => {
      const values: unknown[] = [id]
      const ownerClause = userId ? 'AND user_id = $2' : ''
      if (userId) values.push(userId)
      const result = await pool.query(
        `SELECT id,user_id,agent_id,title,pinned,created_at,last_at,messages_json,updated_at
         FROM client_sessions WHERE id = $1 ${ownerClause} AND deleted_at IS NULL`,
        values,
      )
      const row = result.rows[0]
      if (!row) return null
      const messages = parseMessages(row.messages_json)
      if (!messages) throw new Error(`malformed messages_json for session ${id}`)
      return {
        id: row.id,
        userId: row.user_id,
        agentId: row.agent_id,
        title: row.title,
        pinned: row.pinned,
        createdAt: int(row.created_at),
        lastAt: int(row.last_at),
        messages,
        updatedAt: int(row.updated_at),
        tape: await backend.getClientSessionTapeMeta(row.id, row.user_id),
      }
    },

    deleteClientSession: async (id, userId) =>
      transaction(pool, async (client) => {
        const selected = await client.query(
          `SELECT user_id, last_tape_seq FROM client_sessions
           WHERE id = $1 ${userId ? 'AND user_id = $2' : ''} AND deleted_at IS NULL FOR UPDATE`,
          userId ? [id, userId] : [id],
        )
        const row = selected.rows[0]
        if (!row) return false
        const now = Date.now()
        await client.query(
          `INSERT INTO client_session_tombstones(session_id,user_id,deleted_at,last_tape_seq)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT(session_id,user_id) DO UPDATE SET
             deleted_at = excluded.deleted_at, last_tape_seq = excluded.last_tape_seq`,
          [id, row.user_id, now, int(row.last_tape_seq)],
        )
        await client.query(
          `UPDATE client_sessions SET deleted_at = $1, messages_json = '[]', message_count = 0
           WHERE id = $2 AND user_id = $3`,
          [now, id, row.user_id],
        )
        await client.query(
          'DELETE FROM client_session_tape_payload_parts WHERE session_id = $1 AND user_id = $2',
          [id, row.user_id],
        )
        await client.query(
          'DELETE FROM client_session_tape WHERE session_id = $1 AND user_id = $2',
          [id, row.user_id],
        )
        await client.query(
          'DELETE FROM client_session_turns WHERE session_id = $1 AND user_id = $2',
          [id, row.user_id],
        )
        await markAuthorityMutation(client)
        return true
      }),

    listUnclaimedSessions: async () => {
      const result = await pool.query(
        `SELECT id,agent_id,title,created_at,last_at,messages_json,message_count
         FROM client_sessions WHERE user_id = 'default' AND deleted_at IS NULL
         ORDER BY last_at DESC`,
      )
      return result.rows.map((row) => {
        const messages = parseMessages(row.messages_json) ?? []
        let summary = messages
          .filter((message) => message.role === 'user')
          .slice(0, 3)
          .map((message) => String(message.text ?? '').slice(0, 80))
          .join(' / ')
        if (summary.length > 200) summary = `${summary.slice(0, 200)}…`
        return {
          id: row.id,
          agentId: row.agent_id,
          title: row.title,
          createdAt: int(row.created_at),
          lastAt: int(row.last_at),
          messageCount: int(row.message_count),
          summary,
        }
      })
    },

    claimSession: async (sessionId, userId) =>
      transaction(pool, async (client) => {
        await lockSession(client, sessionId, 'default')
        const updated = await client.query(
          `UPDATE client_sessions SET user_id = $1, updated_at = GREATEST(updated_at + 1, $2)
           WHERE id = $3 AND user_id = 'default' AND deleted_at IS NULL RETURNING id`,
          [userId, Date.now(), sessionId],
        )
        if (!updated.rowCount) return false
        await client.query(
          `UPDATE client_session_tape SET user_id = $1
           WHERE session_id = $2 AND user_id = 'default'`,
          [userId, sessionId],
        )
        await client.query(
          `UPDATE client_session_tape_payload_parts SET user_id = $1
           WHERE session_id = $2 AND user_id = 'default'`,
          [userId, sessionId],
        )
        await client.query(
          `UPDATE client_session_turns SET user_id = $1
           WHERE session_id = $2 AND user_id = 'default'`,
          [userId, sessionId],
        )
        await markAuthorityMutation(client)
        return true
      }),

    recordClientTurnState: async (input) =>
      transaction(pool, async (client) => {
        await client.query(
          `INSERT INTO client_session_turns
             (session_id,user_id,client_message_id,state,started_at,finished_at)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT(session_id,user_id,client_message_id) DO UPDATE SET
             state = excluded.state,
             started_at = LEAST(client_session_turns.started_at, excluded.started_at),
             finished_at = excluded.finished_at`,
          [
            input.sessionId,
            input.userId,
            input.clientMessageId,
            input.state,
            input.startedAt,
            input.finishedAt ?? null,
          ],
        )
        await markAuthorityMutation(client)
      }),

    getClientTurnState: async (
      sessionId,
      userId,
      clientMessageId,
    ): Promise<ClientTurnState | null> => {
      const result = await pool.query(
        `SELECT client_message_id,state,started_at,finished_at FROM client_session_turns
         WHERE session_id = $1 AND user_id = $2 AND client_message_id = $3`,
        [sessionId, userId, clientMessageId],
      )
      const row = result.rows[0]
      return row
        ? {
            clientMessageId: row.client_message_id,
            state: row.state,
            startedAt: int(row.started_at),
            finishedAt: nullableInt(row.finished_at),
          }
        : null
    },
  }
  return backend
}
