/** Resolve canonical actor from one current durable-dispatch snapshot, never request identity fields. */
import type { ContainerIdentity } from '../auth/containerIdentity.js'
import type { QueryRunner } from '../db/queries.js'
import type { SystemActor } from './operations.js'
import { SystemHelpGrantError, type SystemHelpIdentityScope, type SystemHelpScope } from './helpGrant.js'
export async function resolveCurrentSystemHelpActor(runner: QueryRunner, identity: Pick<ContainerIdentity, 'userId' | 'containerId'>,
  proof: SystemHelpIdentityScope, expectedSecurityEpoch?: string,
): Promise<{ actor: SystemActor; scope: SystemHelpScope }> {
  if (proof.uid !== String(identity.userId) || proof.containerId !== String(identity.containerId)) throw new SystemHelpGrantError('INVALID_CONTEXT')
  const result = await runner.query<{
    user_id: string; role: 'user' | 'admin'; session_id: string; agent_id: string;
    dispatch_id: string; attempt_no: number; owner_id: string; dispatch_lease_epoch: string; security_epoch: string
  }>(`SELECT u.id::text AS user_id, u.role, td.session_id, td.agent_id,
       td.dispatch_id::text AS dispatch_id, td.attempt_no, td.owner_id,
       td.lease_epoch::text AS dispatch_lease_epoch, se.epoch::text AS security_epoch
      FROM turn_dispatches td
      JOIN users u ON u.id=td.user_id AND u.status='active' AND u.deleted_at IS NULL AND u.role IN ('user','admin')
      JOIN client_sessions cs ON cs.id=td.session_id AND cs.user_id=('c:' || td.user_id::text) AND cs.deleted_at IS NULL
      JOIN model_security_epoch se ON se.id=TRUE
     WHERE td.dispatch_id=$1::uuid AND td.attempt_no=$2::integer
       AND td.user_id=$3::bigint AND td.agent_container_id=$4::bigint AND td.runtime_kind='docker'
       AND td.owner_id=$5 AND td.lease_epoch=$6::bigint AND td.session_id=$7 AND td.agent_id=$8
       AND td.status IN ('admitted','accepted') AND td.terminal_at IS NULL AND td.producer_fenced_at IS NULL
       AND ($9::text IS NULL OR se.epoch::text=$9)`,
    [proof.dispatchId, proof.attemptNo, proof.uid, proof.containerId, proof.ownerId, proof.dispatchLeaseEpoch,
      proof.sessionId, proof.agentId, expectedSecurityEpoch ?? null])
  const row = result.rows[0]
  if (result.rows.length !== 1 || !row || row.user_id !== proof.uid || row.session_id !== proof.sessionId || row.agent_id !== proof.agentId ||
      row.dispatch_id !== proof.dispatchId || row.attempt_no !== proof.attemptNo || row.owner_id !== proof.ownerId || row.dispatch_lease_epoch !== proof.dispatchLeaseEpoch ||
      !['user', 'admin'].includes(row.role) || !/^(0|[1-9][0-9]{0,18})$/.test(row.security_epoch)) throw new SystemHelpGrantError('INVALID_CONTEXT')
  return { actor: { userId: row.user_id, role: row.role, sessionId: row.session_id, agentId: row.agent_id },
    scope: { uid: row.user_id, containerId: String(identity.containerId), sessionId: row.session_id, agentId: row.agent_id,
      dispatchId: row.dispatch_id, attemptNo: row.attempt_no, ownerId: row.owner_id, dispatchLeaseEpoch: row.dispatch_lease_epoch, securityEpoch: row.security_epoch } }
}
