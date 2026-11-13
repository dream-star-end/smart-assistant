/** Zero-output proof for new long-task waivers. Never trusts a browser flag. */
import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { TurnWaiveReason } from '@openclaude/protocol'
import { expandHydratedRuntimeBatch } from '../db/runtimeBatch.js'
import { PERMANENT_CODEX_WAIVER_PREFIX } from './codexFinalizer.js'

export type TurnWaiverPolicyDecision =
  | { disposition: 'eligible' }
  | { disposition: 'denied'; reason: 'has_output' | 'unproven_effect' }
  | { disposition: 'deferred'; reason: 'tape_not_complete' | 'settlement_not_complete' }

export function requiresZeroOutputProof(reason: TurnWaiveReason): boolean {
  return reason === 'platform_authority_expired' || reason === 'turn_limit'
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function observedUnprovenTool(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(observedUnprovenTool)
  const row = value as Record<string, unknown>
  if (row.kind === 'tool_use' || row.type === 'tool_use') return true
  return Object.values(row).some(observedUnprovenTool)
}

export function assessZeroOutputWaiver(input: {
  complete: boolean
  hasSettledOutput: boolean
  engineBillings: readonly unknown[]
  settledRequests: ReadonlySet<string>
  records: readonly Record<string, unknown>[]
}): TurnWaiverPolicyDecision {
  if (input.hasSettledOutput) return { disposition: 'denied', reason: 'has_output' }
  let unknownBilling = false
  for (const billing of input.engineBillings) {
    if (!object(billing)) { unknownBilling = true; continue }
    const usage = object(billing.usage) ? billing.usage : undefined
    if (usage && ((count(usage.output_tokens) && usage.output_tokens > 0) ||
      (count(usage.reasoning_output_tokens) && usage.reasoning_output_tokens > 0))) {
      return { disposition: 'denied', reason: 'has_output' }
    }
    const knownSettled = typeof billing.requestId === 'string' && input.settledRequests.has(billing.requestId)
    if (!knownSettled && (!usage || !count(usage.output_tokens) ||
      (usage.reasoning_output_tokens !== undefined && !count(usage.reasoning_output_tokens)))) {
      unknownBilling = true
    }
  }
  if (!input.complete) return { disposition: 'deferred', reason: 'tape_not_complete' }
  for (const row of input.records) {
    const text = typeof row.text === 'string' ? row.text.trim() : ''
    const usage = object(row.usage) ? row.usage : undefined
    if (usage && [usage.outputTokens, usage.output_tokens, usage.reasoning_output_tokens]
      .some((value) => count(value) && value > 0)) return { disposition: 'denied', reason: 'has_output' }
    if ((row.role === 'assistant' && row._isError !== true && text) ||
      ((row.role === 'thinking' || row.role === 'plan' || row.role === 'goal') && text) ||
      ((row.role === 'tool' || row.role === 'agent-group') && row._completed === true)) {
      return { disposition: 'denied', reason: 'has_output' }
    }
    if (row.role === 'tool' || row.role === 'agent-group' || row.role === 'delegate-progress' ||
      row.role === 'permission' || observedUnprovenTool(row._runtimeEvent)) {
      return { disposition: 'denied', reason: 'unproven_effect' }
    }
    if (!['assistant', 'thinking', 'tool', 'agent-group', 'plan', 'goal', 'runtime-event'].includes(String(row.role))) {
      return { disposition: 'deferred', reason: 'tape_not_complete' }
    }
  }
  return unknownBilling
    ? { disposition: 'deferred', reason: 'settlement_not_complete' }
    : { disposition: 'eligible' }
}

/** Called while holding the same exact-turn lock as settlement. Finalized
 * records are immutable; header-only/partially staged tapes cannot prove zero. */
export async function readTurnWaiverPolicy(
  client: PoolClient,
  input: { userId: bigint; turnKey: string },
): Promise<TurnWaiverPolicyDecision> {
  const tapes = (await client.query<{
    session_id: string; tape_id: string; tape_sha256: string; finalized_at: unknown
    materialization_status: string; physical_record_count: number | null; engine_billings: unknown
  }>(
    `SELECT session_id,tape_id,tape_sha256,finalized_at,materialization_status,
            physical_record_count,engine_billings
       FROM client_session_turn_tapes
      WHERE user_id=$1 AND (turn_key=$2 OR continuation_of_turn_key=$2)`,
    [`c:${input.userId.toString()}`, input.turnKey],
  )).rows
  const engineBillings = tapes.flatMap((tape) => Array.isArray(tape.engine_billings)
    ? tape.engine_billings : [null])
  const requestIds = engineBillings.flatMap((billing) => object(billing) && typeof billing.requestId === 'string'
    ? [billing.requestId] : [])
  const usage = (await client.query<{ request_id: string; output_tokens: string; status: string }>(
    `SELECT request_id,output_tokens::text AS output_tokens,status FROM usage_records
      WHERE user_id=$1 AND (turn_key=$2 OR parent_turn_key=$2 OR request_id=ANY($3::text[]))`,
    [input.userId.toString(), input.turnKey, requestIds],
  )).rows
  const settledRequests = new Set(usage.filter((row) => row.status === 'success' || row.status === 'error')
    .map((row) => row.request_id))
  if (requestIds.length > 0) {
    const noUsage = (await client.query<{ request_id: string }>(
      `SELECT request_id FROM request_finalize_journal
        WHERE user_id=$1 AND request_id=ANY($2::text[]) AND state='aborted'
          AND starts_with(error_msg,$3)`,
      [input.userId.toString(), requestIds, PERMANENT_CODEX_WAIVER_PREFIX],
    )).rows
    for (const row of noUsage) settledRequests.add(row.request_id)
  }
  const records: Record<string, unknown>[] = []
  let complete = tapes.length > 0
  for (const tape of tapes) {
    if (tape.finalized_at === null || tape.materialization_status !== 'complete') { complete = false; continue }
    const rows = (await client.query<{
      msg_id: string; ordinal: number; payload: Buffer; content_sha256: string
    }>(
      `SELECT msg_id,ordinal,payload,content_sha256 FROM client_session_turn_tape_records
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 ORDER BY ordinal`,
      [tape.session_id, `c:${input.userId.toString()}`, tape.tape_id],
    )).rows
    if (rows.length === 0 || (tape.physical_record_count !== null && rows.length !== tape.physical_record_count)) {
      complete = false; continue
    }
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!
      if (row.ordinal !== index || createHash('sha256').update(row.payload).digest('hex') !== row.content_sha256) {
        complete = false; break
      }
      try {
        const parsed: unknown = JSON.parse(row.payload.toString('utf8'))
        if (!object(parsed)) { complete = false; break }
        records.push(...expandHydratedRuntimeBatch(parsed, {
          tape_id: tape.tape_id, tape_sha256: tape.tape_sha256,
          msg_id: row.msg_id, ordinal: row.ordinal,
        }, {}).messages)
      } catch { complete = false; break }
    }
  }
  return assessZeroOutputWaiver({ complete,
    hasSettledOutput: usage.some((row) => BigInt(row.output_tokens) > 0n),
    engineBillings, settledRequests, records })
}
