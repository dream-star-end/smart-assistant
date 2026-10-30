import { unadmittedToolRollover, unadmittedToolRolloverSql } from '../../billing/boxToolRolloverIdentity.js'
/** Durable invocation generations. A fence is never a keeper/settlement receipt. */
import type { Pool } from 'pg'
import type { BoxAgentScopeIdentity } from '@openclaude/protocol'
import { lock, type BoxDurableJournal, type BoxPrelaunchRecoveryCandidate } from './boxDurableJournal.js'
import { BoxAgentScopeError } from './boxAgentScopeFence.js'
import type { BoxUserStopCoordinator } from './boxUserStopCoordinator.js'
import { parseBoxTerminalProof } from './boxTerminalProof.js'
import { parseBoxPrelaunchBootstrap, type BoxPrelaunchReceipt } from './boxPrelaunchControl.js'

type Owner = { uid: bigint; containerId: bigint }
type Row = { request_id: string; state: string; ctx: Record<string, unknown> }
type Reason = 'explicit-stop' | 'finish' | 'owner-lost'
export type BoxAgentScopeReceipt = {
  scopeId: string; status: 'active' | 'pending' | 'stopped'
  fence: 'active' | 'cancelled'
  proof?: 'prelaunch_cancelled' | 'all_physical_runs_terminal'
}
function prelaunchReceipt(ctx: Record<string, unknown>): BoxPrelaunchReceipt | null {
  try {
    const receipt = ctx.boxPrelaunchControl as BoxPrelaunchReceipt
    const sorted = Object.fromEntries(Object.entries(receipt).sort(([a], [b]) => a.localeCompare(b)))
    parseBoxPrelaunchBootstrap(JSON.stringify(sorted), receipt)
    return receipt
  } catch { return null }
}
function terminalGroup(rows: Row[]): boolean {
  if (!rows.length) return false
  const leafs = rows.filter(row => row.ctx.boxResumeRequestId === undefined)
  if (leafs.length !== 1) return false
  const leaf = leafs[0]!
  const ctx = leaf.ctx
  if (rows.length === 1 && ctx.boxState === 'prestart_stopped' && ctx.boxLaunchPermit === undefined
    && ctx.boxOwnerRequestId === undefined && ctx.boxResumeRequestId === undefined
    && typeof ctx.boxRunNonce === 'string' && /^[a-f0-9]{24}$/.test(ctx.boxRunNonce)
    && typeof ctx.boxLeaseEpoch === 'string' && /^[a-f0-9]{32}$/.test(ctx.boxLeaseEpoch)
    && typeof ctx.boxAccountId === 'string' && /^[1-9][0-9]{0,18}$/.test(ctx.boxAccountId)) {
    if (ctx.boxPrelaunchControl === undefined) return true // Original caller's prestart-only CAS.
    const receipt = prelaunchReceipt(ctx)
    const cleanup = ctx.boxPrelaunchCleanup as Record<string, unknown> | undefined
    return !!receipt && receipt.runNonce === ctx.boxRunNonce && receipt.leaseEpoch === ctx.boxLeaseEpoch
      && receipt.accountId === ctx.boxAccountId && cleanup?.v === 1
      && cleanup.receipt === `cleaned:${receipt.identityHash}`
  }
  if (rows.some(row => !['committed', 'aborted'].includes(row.state))) return false
  try {
    parseBoxTerminalProof(JSON.stringify(ctx.boxTerminalProof) + '\n',
      { runNonce: String(ctx.boxRunNonce), leaseEpoch: String(ctx.boxLeaseEpoch) })
  } catch { return false }
  // Validate the complete physical chain; native cache ancestors are different runs.
  const byId = new Map(rows.map(row => [row.request_id, row]))
  const seen = new Set<string>()
  let cursor: Row | undefined = leaf
  while (cursor) {
    const item = cursor.ctx
    if (seen.has(cursor.request_id) || !['terminal', 'failed_stopped'].includes(String(item.boxState))
      || item.boxAccountId !== ctx.boxAccountId || item.boxRunNonce !== ctx.boxRunNonce
      || item.boxLeaseEpoch !== ctx.boxLeaseEpoch || item.boxSessionId !== ctx.boxSessionId
      || item.boxTurnKey !== ctx.boxTurnKey || item.boxAgentScopeId !== ctx.boxAgentScopeId) return false
    seen.add(cursor.request_id)
    if (item.boxOwnerRequestId === undefined) break
    const parent = typeof item.boxOwnerRequestId === 'string' ? byId.get(item.boxOwnerRequestId) : undefined
    if (!parent || parent.ctx.boxResumeRequestId !== cursor.request_id) return false
    cursor = parent
  }
  return seen.size === rows.length
}

export class BoxAgentScopes {
  constructor(private readonly deps: {
    pool: Pick<Pool, 'connect' | 'query'>
    journal: Pick<BoxDurableJournal, 'prelaunchCleanupDoneByRunIdentity'>
    coordinator: Pick<BoxUserStopCoordinator, 'requestStop'>
    recoverPrelaunch: (candidate: BoxPrelaunchRecoveryCandidate, scopeId: string) => Promise<boolean>
  }) {}

  private async snapshot(owner: Owner, identity: BoxAgentScopeIdentity,
    operation: 'register' | 'cancel' | 'status', reason?: Reason): Promise<{
      receipt: BoxAgentScopeReceipt; groups: Row[][]; reason: Reason
    }> {
    const client = await this.deps.pool.connect()
    let done = false
    try {
      await client.query('BEGIN')
      await lock(client, [`box:session:${owner.uid}:${identity.sessionId}`])
      if (operation === 'register') {
        await client.query(`INSERT INTO box_agent_api_scopes
          (user_id,container_id,scope_id,root_session_id,session_id,agent_id,turn_key)
          VALUES ($1,$2,$3::uuid,$4::uuid,$5::uuid,$6,$7) ON CONFLICT DO NOTHING`,
        [owner.uid.toString(), owner.containerId.toString(), identity.scopeId,
          identity.rootSessionId, identity.sessionId, identity.agentId, identity.turnKey])
      }
      const found = await client.query<{ root_session_id: string; session_id: string; agent_id: string;
        turn_key: string; cancelled_at: unknown; cancel_reason: Reason | null }>(
        `SELECT root_session_id::text,session_id::text,agent_id,turn_key,cancelled_at,cancel_reason
          FROM box_agent_api_scopes WHERE user_id=$1 AND container_id=$2 AND scope_id=$3::uuid FOR UPDATE`,
        [owner.uid.toString(), owner.containerId.toString(), identity.scopeId])
      const scope = found.rows[0]
      if (!scope) throw new BoxAgentScopeError('BOX_AGENT_SCOPE_UNKNOWN')
      if (scope.session_id !== identity.sessionId || scope.root_session_id !== identity.rootSessionId
        || scope.agent_id !== identity.agentId || scope.turn_key !== identity.turnKey) {
        throw new BoxAgentScopeError('BOX_AGENT_SCOPE_CONFLICT')
      }
      if (operation === 'cancel' && scope.cancelled_at === null) {
        if (!reason) throw new BoxAgentScopeError('BOX_AGENT_SCOPE_REASON_INVALID')
        await client.query(`UPDATE box_agent_api_scopes SET cancelled_at=NOW(),cancel_reason=$4
          WHERE user_id=$1 AND container_id=$2 AND scope_id=$3::uuid AND cancelled_at IS NULL`,
        [owner.uid.toString(), owner.containerId.toString(), identity.scopeId, reason])
        scope.cancelled_at = true
        scope.cancel_reason = reason
      }
      if (scope.cancelled_at !== null) {
        await client.query(`UPDATE request_finalize_journal SET
          ctx=ctx || '{"boxRolloverCancelled":true,"boxState":"prestart_stopped"}'::jsonb,updated_at=NOW()
          WHERE user_id=$1 AND container_id=$2 AND ctx->>'boxAgentScopeId'=$3
            AND ctx->>'boxSessionId'=$4 AND ctx->>'boxTurnKey'=$5
            AND state IN ('inflight','aborted') AND ${unadmittedToolRolloverSql()}`,
          [owner.uid.toString(),owner.containerId.toString(),identity.scopeId,identity.sessionId,identity.turnKey]);
      }
      const groups = new Map<string, Row[]>()
      const rows = await client.query<Row>(`SELECT request_id,state,ctx FROM request_finalize_journal
        WHERE user_id=$1 AND container_id=$2 AND ctx->>'boxAgentScopeId'=$3 ORDER BY request_id`,
      [owner.uid.toString(), owner.containerId.toString(), identity.scopeId])
      for (const row of rows.rows) {
        const ctx = row.ctx
        if (ctx.boxRolloverCancelled === true && ctx.boxState === 'prestart_stopped'
          && unadmittedToolRollover(ctx,row.request_id)) continue
        // An HTTP row that never admitted has no physical run. The committed
        // generation fence still rejects its late admit, even after this read.
        if (ctx.boxState === undefined && ctx.boxRunNonce === undefined && ctx.boxLaunchPermit === undefined
          && ctx.boxRolloverFrom === undefined) continue
        const key = `${String(ctx.boxAccountId)}:${String(ctx.boxRunNonce)}:${String(ctx.boxLeaseEpoch)}`
        const group = groups.get(key) ?? []
        group.push(row); groups.set(key, group)
      }
      const cancelled = scope.cancelled_at !== null
      const physical = [...groups.values()]
      const proven = cancelled && physical.every(terminalGroup)
      const receipt: BoxAgentScopeReceipt = { scopeId: identity.scopeId,
        status: cancelled ? proven ? 'stopped' : 'pending' : 'active',
        fence: cancelled ? 'cancelled' : 'active',
        ...(proven ? { proof: physical.length ? 'all_physical_runs_terminal' as const : 'prelaunch_cancelled' as const } : {}) }
      // Commit the future fence BEFORE any pool-based/remote stop operation.
      await client.query('COMMIT'); done = true
      return { receipt, groups: physical, reason: scope.cancel_reason ?? reason ?? 'finish' }
    } finally {
      if (!done) await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  }

  async control(owner: Owner, identity: BoxAgentScopeIdentity,
    operation: 'register' | 'cancel' | 'status', reason?: Reason): Promise<BoxAgentScopeReceipt> {
    const view = await this.snapshot(owner, identity, operation, reason)
    if (view.receipt.fence !== 'cancelled' || view.receipt.status === 'stopped' || operation === 'register') return view.receipt
    // One control request never launches/replays a model or tool. Original
    // keeper and guarded-prelaunch cleanup retain their existing budgets.
    await Promise.allSettled(view.groups.filter(rows => !terminalGroup(rows)).map(async rows => {
      const leafs = rows.filter(row => row.ctx.boxResumeRequestId === undefined)
      if (leafs.length !== 1) return
      const leaf = leafs[0]!, ctx = leaf.ctx
      if (ctx.boxAgentScopeId !== identity.scopeId || ctx.boxSessionId !== identity.sessionId
        || ctx.boxTurnKey !== identity.turnKey || typeof ctx.boxAccountId !== 'string'
        || !/^[1-9][0-9]{0,18}$/.test(ctx.boxAccountId)
        || typeof ctx.boxRunNonce !== 'string' || !/^[a-f0-9]{24}$/.test(ctx.boxRunNonce)
        || typeof ctx.boxLeaseEpoch !== 'string' || !/^[a-f0-9]{32}$/.test(ctx.boxLeaseEpoch)) return
      const run = { requestId: leaf.request_id, uid: owner.uid, accountId: BigInt(ctx.boxAccountId),
        runNonce: ctx.boxRunNonce, leaseEpoch: ctx.boxLeaseEpoch }
      if (ctx.boxPrelaunchControl !== undefined && ctx.boxLaunchPermit === undefined) {
        const receipt = prelaunchReceipt(ctx)
        if (receipt) await this.deps.recoverPrelaunch({ ...run, receipt }, identity.scopeId)
      } else {
        try { parseBoxTerminalProof(JSON.stringify(ctx.boxTerminalProof) + '\n', run); return }
        catch { /* Pending physical run: use only its original keeper. */ }
        await this.deps.coordinator.requestStop(run, { scopeId: identity.scopeId, reason: view.reason })
      }
    }))
    return (await this.snapshot(owner, identity, 'status')).receipt
  }
}
