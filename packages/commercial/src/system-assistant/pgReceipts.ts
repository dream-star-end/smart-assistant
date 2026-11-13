/** PG-only effects and their positive receipts commit on the same connection. No constructor I/O. */
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import type { SystemActionResult } from '@openclaude/protocol'
import type { SystemActionExecution, SystemActionReceiptBinding } from '@openclaude/storage'
import { getPool } from '../db/index.js'
import { query, type QueryRunner } from '../db/queries.js'
import { SystemOperationRejected, type SystemActor } from './operations.js'

const bounded = (max: number) => z.string().min(1).max(max).refine(s => ![...s].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
const resultSchema = z.object({ summary: bounded(4000), completion: z.enum(['done', 'accepted', 'awaiting_user']),
  effectReference: bounded(512).optional(), code: bounded(200).optional() }).strict()
const hash = /^[a-f0-9]{64}$/
interface ReceiptRow { action_id: string; user_id: string; session_id: string; agent_id: string; operation_id: string;
  operation_version: number; request_hash: string; input_hash: string; result_json: unknown }
/** The caller must retain the ledger's unknown fence until a positive exact receipt is available. */
export class PgActionOutcomeUnknown extends Error {
  constructor() { super('System action outcome requires a committed receipt'); this.name = 'PgActionOutcomeUnknown' }
}
function validBinding(binding: SystemActionReceiptBinding): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(binding.id)
    && /^[1-9][0-9]{0,18}$/.test(binding.userId) && typeof binding.requestHash === 'string' && hash.test(binding.requestHash)
    && hash.test(binding.inputHash) && Number.isSafeInteger(binding.operationVersion) && binding.operationVersion > 0
}
async function lookup(binding: SystemActionReceiptBinding, runner: QueryRunner): Promise<SystemActionResult | null> {
  const found = await query<ReceiptRow>(`SELECT action_id::text,user_id::text,session_id,agent_id,operation_id,
    operation_version,request_hash,input_hash,result_json FROM system_action_receipts WHERE action_id=$1::uuid`, [binding.id], runner)
  const row = found.rows[0]
  if (!row) return null
  if (row.action_id !== binding.id || row.user_id !== binding.userId || row.session_id !== binding.sessionId
    || row.agent_id !== binding.agentId || row.operation_id !== binding.operationId || row.operation_version !== binding.operationVersion
    || row.request_hash !== binding.requestHash || row.input_hash !== binding.inputHash) throw new PgActionOutcomeUnknown()
  const parsed = resultSchema.safeParse(row.result_json)
  if (!parsed.success) throw new PgActionOutcomeUnknown()
  return parsed.data
}
/** Pure SELECT. Current ownership comes from the private binding and active canonical account. */
export async function getPgActionReceipt(binding: SystemActionReceiptBinding, runner: QueryRunner = getPool() as unknown as QueryRunner): Promise<SystemActionResult | null> {
  if (!validBinding(binding)) return null
  const active = await query("SELECT 1 FROM users WHERE id=$1::bigint AND status='active' AND deleted_at IS NULL", [binding.userId], runner)
  if (active.rows.length !== 1) throw new SystemOperationRejected('FORBIDDEN')
  return lookup(binding, runner)
}
/** work must contain PG effects only and use this runner for every business write. */
export async function withPgActionReceipt(actor: SystemActor, execution: SystemActionExecution,
  work: (runner: QueryRunner) => Promise<SystemActionResult>, pool: Pick<Pool, 'connect'> = getPool()): Promise<SystemActionResult> {
  if (!validBinding(execution) || actor.userId !== execution.userId || actor.sessionId !== execution.sessionId || actor.agentId !== execution.agentId)
    throw new SystemOperationRejected('UNAVAILABLE')
  let client: PoolClient
  try { client = await pool.connect() } catch { throw new SystemOperationRejected('UNAVAILABLE') }
  const runner = client as unknown as QueryRunner
  let commitStarted = false
  let discard = false
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL lock_timeout = '5s'")
    await client.query("SET LOCAL statement_timeout = '15s'")
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('oc-system-action:' || $1::text,6100327))", [execution.id])
    const active = await query<{ role: string }>("SELECT role FROM users WHERE id=$1::bigint AND status='active' AND deleted_at IS NULL FOR SHARE", [actor.userId], runner)
    if (active.rows.length !== 1 || active.rows[0]?.role !== actor.role) throw new SystemOperationRejected('FORBIDDEN')
    let result = await lookup(execution, runner)
    if (!result) {
      result = resultSchema.parse(await work(runner))
      await client.query(`INSERT INTO system_action_receipts
        (action_id,user_id,session_id,agent_id,operation_id,operation_version,request_hash,input_hash,actor_role,result_json)
        VALUES ($1::uuid,$2::bigint,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [execution.id, execution.userId, execution.sessionId, execution.agentId, execution.operationId, execution.operationVersion,
        execution.requestHash, execution.inputHash, actor.role, JSON.stringify(result)])
    }
    commitStarted = true
    await client.query('COMMIT')
    return result
  } catch (error) {
    let rolledBack = false
    try { await client.query('ROLLBACK'); rolledBack = true } catch { discard = true }
    if (commitStarted || error instanceof PgActionOutcomeUnknown || !rolledBack) {
      discard = true
      throw new PgActionOutcomeUnknown()
    }
    if (error instanceof SystemOperationRejected) throw error
    throw new SystemOperationRejected('UNAVAILABLE')
  } finally { client.release(discard) }
}
