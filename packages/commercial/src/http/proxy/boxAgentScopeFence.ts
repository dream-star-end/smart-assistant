/** All helpers use the caller's transaction and existing session advisory lock. */
import type { PoolClient } from 'pg'
import { BOX_AGENT_SCOPE_UUID } from '@openclaude/protocol'
import type { BoxCallFingerprint } from './boxCallFingerprint.js'

export class BoxAgentScopeError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'BoxAgentScopeError' }
}
export async function assertBoxAgentRequestActive(client: PoolClient, uid: bigint,
  requestId: string, fingerprint?: BoxCallFingerprint): Promise<string | undefined> {
  const found = await client.query<{ ctx: Record<string, unknown> }>(
    'SELECT ctx FROM request_finalize_journal WHERE user_id=$1 AND request_id=$2',
    [uid.toString(), requestId])
  const row = found.rows[0]
  const scopeId = row?.ctx.boxAgentScopeId
  if (scopeId === undefined && fingerprint?.agentScopeId === undefined) return undefined
  if (!row || typeof scopeId !== 'string' || !BOX_AGENT_SCOPE_UUID.test(scopeId)
    || (fingerprint !== undefined && fingerprint.agentScopeId !== scopeId)) {
    throw new BoxAgentScopeError('BOX_AGENT_SCOPE_BINDING_INVALID')
  }
  // Legacy journal fixtures/paths need no new schema or container lookup.
  const binding = await client.query<{container_id:string|null}>(
    'SELECT container_id::text FROM request_finalize_journal WHERE user_id=$1 AND request_id=$2',
    [uid.toString(),requestId])
  const containerId = binding.rows[0]?.container_id
  if (!containerId || !/^[1-9][0-9]*$/.test(containerId)) throw new BoxAgentScopeError('BOX_AGENT_SCOPE_BINDING_INVALID')
  const sessionId = fingerprint?.sessionId ?? row.ctx.boxSessionId
  const turnKey = fingerprint?.turnKey ?? row.ctx.boxTurnKey
  const scope = await client.query<{ session_id: string; turn_key: string; cancelled_at: unknown }>(
    `SELECT session_id::text,turn_key,cancelled_at FROM box_agent_api_scopes
      WHERE user_id=$1 AND container_id=$2 AND scope_id=$3::uuid FOR UPDATE`,
    [uid.toString(), containerId, scopeId])
  const registered = scope.rows[0]
  if (scope.rowCount !== 1 || !registered || registered.session_id !== sessionId
    || registered.turn_key !== turnKey || registered.cancelled_at !== null) {
    throw new BoxAgentScopeError('BOX_AGENT_SCOPE_INACTIVE')
  }
  return scopeId
}

export function assertSameBoxAgentScope(incoming: string | undefined,
  ...contexts: Record<string, unknown>[]): void {
  if (contexts.some(ctx => ctx.boxAgentScopeId !== incoming)) {
    throw new BoxAgentScopeError('BOX_AGENT_SCOPE_GENERATION_CONFLICT')
  }
}
