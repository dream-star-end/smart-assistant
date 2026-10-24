import { createHash } from 'node:crypto'
import type { Pool } from 'pg'

export interface SwitchContext {
  revision: number
  fingerprint: string
  sourceModel: string | null
  sourceAgent: string
  tokens: number | null
  source: 'last-call' | 'unknown' | 'empty' | 'unchanged'
  warmRatio: number
  outputs: number[]
  calls: number
  lastOutputTokens: number
}
export class ModelSwitchCostError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ModelSwitchCostError'
  }
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null

/** Only reads small metadata/bounded immutable bytes. Unknown is never a zero quote. */
export async function readSwitchContext(
  pool: Pool,
  uid: string,
  sessionId: string,
  requestId: string,
  options: { targetModel: string },
): Promise<SwitchContext> {
  const owner = `c:${uid}`
  const row = (
    await pool.query<{
      history_revision: string
      timeline_generation: string
      has_content: boolean
      deleted_at: unknown
      archived: boolean
    }>(
      `SELECT history_revision::text,timeline_generation::text,messages <> '[]' AS has_content,deleted_at,
       EXISTS(SELECT 1 FROM client_session_archive_chunks a WHERE a.session_id=cs.id AND a.user_id=cs.user_id) AS archived
       FROM client_sessions cs WHERE id=$1 AND user_id=$2`,
      [sessionId, owner],
    )
  ).rows[0]
  const empty: SwitchContext = {
    revision: 0,
    fingerprint: digest(['empty', sessionId]),
    sourceModel: null,
    sourceAgent: 'main',
    tokens: 0,
    source: 'empty',
    warmRatio: 0,
    outputs: [],
    calls: 1,
    lastOutputTokens: 0,
  }
  if (!row) return empty // Durable admission still verifies new/foreign session ownership.
  if (row.deleted_at != null)
    throw new ModelSwitchCostError('SESSION_GONE', '会话已删除，请新建会话')
  const revision = Number(row.history_revision)
  const tapes = (
    await pool.query<{
      tape_id: string
      tape_sha256: string
      agent_id: string
      status: string
      usage: Record<string, unknown>
      created_at: string
      finalized_at: string | null
      client_message_id: string | null
    }>(
      `SELECT tape_id,tape_sha256,agent_id,status,usage,created_at::text,finalized_at::text,client_message_id
       FROM client_session_turn_tapes WHERE session_id=$1 AND user_id=$2
         AND parent_turn_key IS NULL AND continuation_of_turn_key IS NULL
       ORDER BY created_at DESC,tape_id DESC LIMIT 6`,
      [sessionId, owner],
    )
  ).rows
  // Image-edit is a fixed-price external feature, not the ordinary chat model.
  const ordinary = tapes.filter((t) => t.usage?.model !== 'gpt-image-2')
  const executed = (t: (typeof tapes)[number]) =>
    ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'].some(
      (k) => (count(t.usage?.[k]) ?? 0) > 0,
    )
  const root = ordinary[0]
  const sourceTape = ordinary.find(executed)
  const newestIsOrdinary = root !== undefined && root === tapes[0]
  const accepted =
    typeof sourceTape?.usage?.model === 'string'
      ? undefined
      : (
          await pool.query<{ model: string | null; agent_id: string; dispatch_id: string }>(
            `SELECT d.model,d.agent_id,d.dispatch_id FROM turn_dispatches d
       WHERE d.user_id=$1::bigint AND d.session_id=$2 AND d.accepted_at IS NOT NULL
         AND d.status='terminal' AND d.outcome='completed'
         AND EXISTS(SELECT 1 FROM usage_records u WHERE u.dispatch_id=d.dispatch_id AND u.user_id=d.user_id AND u.model<>'gpt-image-2')
       ORDER BY d.admitted_at DESC LIMIT 1`,
            [uid, sessionId],
          )
        ).rows[0]
  const sourceModel =
    typeof sourceTape?.usage?.model === 'string'
      ? sourceTape.usage.model
      : (accepted?.model ?? null)
  const sourceAgent = sourceTape?.agent_id ?? accepted?.agent_id ?? 'main'
  if (!root && !sourceModel) {
    if (!row.has_content && !row.archived) return { ...empty, revision }
    // A queue may already have admitted the first user row. Exclude exactly
    // this request; do not hydrate old tapes or unbounded legacy hot rows.
    const hot = (
      await pool.query<{ messages: string | null }>(
        `SELECT CASE WHEN octet_length(messages)<=4194304 THEN messages ELSE NULL END AS messages
       FROM client_sessions WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
        [sessionId, owner],
      )
    ).rows[0]
    if (hot?.messages && !row.archived) {
      try {
        const messages: unknown = JSON.parse(hot.messages)
        if (
          Array.isArray(messages) &&
          !messages.some(
            (m) =>
              m &&
              typeof m === 'object' &&
              ['user', 'assistant', 'tool', 'agent-group'].includes(m.role) &&
              !(m.role === 'user' && (m.id === requestId || m._clientMessageId === requestId)),
          )
        ) {
          return { ...empty, revision }
        }
      } catch {
        /* Cannot attest empty: use B. */
      }
    }
  }
  const base: SwitchContext = {
    ...empty,
    revision,
    sourceModel,
    sourceAgent,
    tokens: null,
    source: 'unknown',
    fingerprint: digest([
      row.timeline_generation,
      root?.tape_id,
      root?.tape_sha256,
      tapes[0]?.tape_id,
      tapes[0]?.tape_sha256,
      accepted?.dispatch_id,
      sourceModel,
    ]),
    outputs: ordinary
      .filter((t) => t.status === 'completed' && t.finalized_at !== null)
      .map((t) => count(t.usage.outputTokens))
      .filter((n): n is number => n !== null)
      .slice(0, 5),
  }
  if (sourceModel === options.targetModel) return { ...base, source: 'unchanged' }
  if (!root || root.status !== 'completed' || root.finalized_at === null || !newestIsOrdinary)
    return base
  const active = (
    await pool.query<{ client_message_id: string }>(
      `SELECT client_message_id FROM turn_dispatches WHERE user_id=$1::bigint AND session_id=$2
      AND status<>'terminal' ORDER BY admitted_at DESC LIMIT 2`,
      [uid, sessionId],
    )
  ).rows
  if (active.some((d) => d.client_message_id !== requestId)) return base
  const records = (
    await pool.query<{ ordinal: number; payload: Buffer | null }>(
      `WITH tail AS (
       SELECT ordinal,payload FROM client_session_turn_tape_records
       WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
         AND role IN ('assistant','thinking','tool','plan','goal') ORDER BY ordinal DESC LIMIT 16
     ), sized AS (SELECT ordinal,payload,octet_length(payload) AS size,
       sum(octet_length(payload)) OVER(ORDER BY ordinal DESC) AS running FROM tail)
     SELECT ordinal,CASE WHEN size<=1048576 AND running<=8388608 THEN payload ELSE NULL END AS payload
       FROM sized ORDER BY ordinal DESC`,
      [sessionId, owner, root.tape_id],
    )
  ).rows
  let tokens: number | null = null
  let lastOutputTokens = 0
  let warmRatio = 0
  let latestCall: string | null = null
  const calls = new Set<string>()
  for (const record of records) {
    if (record.payload === null) {
      if (tokens === null) return base
      break
    }
    let message: Record<string, unknown>
    try {
      message = JSON.parse(record.payload.toString('utf8'))
    } catch {
      return base
    }
    const call = message._callUsage as
      | { callId?: unknown; usage?: Record<string, unknown> }
      | undefined
    if (!call) {
      if (tokens === null && message.role === 'tool') return base
      continue
    }
    if (typeof call.callId !== 'string' || !call.usage) return base
    const input = count(call.usage.inputTokens)
    const output = count(call.usage.outputTokens)
    // Optional cache dimensions mean zero in the exact CallTokenUsageSnapshot
    // contract (CCB/Codex); this is never applied to a turn-wide provider report.
    const read = count(call.usage.cacheReadTokens ?? 0)
    const write = count(call.usage.cacheCreationTokens ?? 0)
    if (input === null || output === null || read === null || write === null) return base
    calls.add(call.callId)
    if (tokens === null) {
      tokens = input + read + write
      lastOutputTokens = output
      latestCall = call.callId
      warmRatio = tokens ? (read + write) / tokens : 0
    }
  }
  if (tokens === null || !Number.isSafeInteger(tokens) || tokens <= 0) return base
  return {
    ...base,
    tokens,
    source: 'last-call',
    lastOutputTokens,
    warmRatio,
    calls: Math.max(1, calls.size),
    fingerprint: digest([base.fingerprint, latestCall, tokens, lastOutputTokens]),
  }
}
