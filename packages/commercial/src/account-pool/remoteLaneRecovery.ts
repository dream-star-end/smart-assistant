/** Privileged, proof-only lane recovery. No provision/launch/input port is reachable here. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Pool } from 'pg'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { remoteCcTargetFromPool,remoteNodeExecKeyDir,type RemoteAgentNodeView,type RemoteAgentProfileView,type RemoteModelOfferView } from './remoteBrainPool.js'
import { Cc5SshHost, CodexSshHost, type CodexLaneSpec, type RemoteCcTarget } from '@openclaude/gateway/cc5-container-runtime'
const exec = promisify(execFile)
const need = (ok: unknown): void => { if (!ok) throw new Error('REMOTE_LANE_RECOVERY_UNPROVEN') }
interface RecoverySpec {
  version: 1; operationId: string; runId: string; generation: string; taskRoot: string
  target: RemoteCcTarget; controllerPath: string; codex?: CodexLaneSpec
}
/** A responsive Docker daemon and complete immutable ID, not a name, establish local process absence. */
export async function proveRemoteLaneContainerStopped(dockerId: string): Promise<void> {
  need(/^[a-f0-9]{64}$/.test(dockerId))
  const { stdout } = await exec('/usr/bin/docker',['container','ls','--all','--no-trunc','--format','{{.ID}}'],{timeout:15000,maxBuffer:4*1024*1024})
  const ids = stdout.trim().split('\n').filter(Boolean)
  need(ids.every(id => /^[a-f0-9]{64}$/.test(id)))
  if (!ids.includes(dockerId)) return // Removed containers cannot have a live Docker-managed process.
  const result = await exec('/usr/bin/docker',['container','inspect',dockerId],{timeout:15000,maxBuffer:4*1024*1024})
  const rows = JSON.parse(result.stdout)
  need(rows.length === 1 && rows[0].Id === dockerId && rows[0].State.Running === false && rows[0].State.Restarting === false
    && rows[0].State.Pid === 0 && ['exited','dead','created'].includes(rows[0].State.Status))
}
export async function reconcileRemoteLane(pool: Pool, operationId: string, generation: string,
  fixtures: { proveLocal?: typeof proveRemoteLaneContainerStopped; proveRemote?: (spec: RecoverySpec) => Promise<void | { noHostEffect: boolean }> } = {}): Promise<void> {
  need(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(operationId) && /^[1-9][0-9]{0,15}$/.test(generation))
  const row = (await pool.query(`SELECT * FROM remote_agent_bindings WHERE operation_id=$1 AND generation=$2`,[operationId,generation])).rows[0]
  need(row)
  if (row.state === 'released') return
  if (row.engine === 'codex' && row.remote_start_attempted === false) {
    // This CAS fences a live old relay too: its before-provision CAS must see state=running.
    const released = await pool.query(`UPDATE remote_agent_bindings SET state='released',updated_at=NOW()
      WHERE operation_id=$1 AND generation=$2 AND engine='codex' AND state<>'released' AND remote_start_attempted=FALSE`,
    [operationId,generation])
    need(released.rowCount === 1)
    return // no node root nor local tool effect can exist before remote start
  }
  let spec = row.recovery_spec as RecoverySpec
  if (!spec && row.engine === 'cc') {
    // 0333 CC lanes used this exact deterministic task-root scheme and immutable node/profile IDs.
    // Reconstruct only this legacy format, then still require both independent stop proofs.
    const legacy = (await pool.query(`SELECT n.*,p.id AS profile_id,p.profile_name,p.engine,p.runner_mode
      FROM remote_agent_nodes n JOIN remote_agent_profiles p ON p.node_id=n.id
      WHERE n.id=$1 AND p.id=$2 AND p.engine='cc' AND p.runner_mode='interactive'`,[row.node_id,row.profile_id])).rows[0]
    need(legacy)
    const target = remoteCcTargetFromPool(legacy as RemoteAgentNodeView,
      {id:legacy.profile_id,node_id:legacy.id,engine:'cc',runner_mode:'interactive',profile_name:legacy.profile_name} as RemoteAgentProfileView,
      {profile_id:legacy.profile_id,canonical_model_id:row.canonical_model_id,
        upstream_model_id:row.canonical_model_id.replace(/-remote$/,'')} as RemoteModelOfferView,
      join(remoteNodeExecKeyDir(legacy.key_id),'known_hosts'))
    spec={version:1,target,operationId,runId:row.run_id,generation,
      taskRoot:`/home/${legacy.ssh_user}/oc-agentremote-c${operationId.replaceAll('-','').slice(0,23)}`,
      controllerPath:fileURLToPath(new URL('../../../../scripts/agent-remote/cc5-host-controller.py',import.meta.url))}
    const saved = await pool.query(`UPDATE remote_agent_bindings SET recovery_spec=$3::jsonb
      WHERE operation_id=$1 AND generation=$2 AND recovery_spec IS NULL`,[operationId,generation,JSON.stringify(spec)])
    need(saved.rowCount === 1)
  }
  need(spec?.version === 1 && spec.operationId === operationId && spec.generation === generation && spec.runId === row.run_id)
  await (fixtures.proveLocal ?? proveRemoteLaneContainerStopped)(row.docker_id)
  let noHostEffect = false
  if (fixtures.proveRemote) noHostEffect = (await fixtures.proveRemote(spec))?.noHostEffect === true
  else if (row.engine === 'codex') {
    need(spec.codex && spec.codex.manifest.operationId === operationId && spec.codex.manifest.generation === generation
      && spec.codex.manifest.runId === spec.runId && spec.codex.manifest.root === spec.taskRoot)
    noHostEffect = (await new CodexSshHost(spec.target,spec.codex!,undefined,true).stop()).noHostEffect === true
  } else {
    need(row.engine === 'cc' && !spec.codex)
    await new Cc5SshHost({ target:spec.target,taskRoot:spec.taskRoot,operationId,runId:spec.runId,
      controllerPath:spec.controllerPath,toolSocketPath:'/run/oc-remote-recovery-unused.sock' }).stop()
  }
  const updated = await pool.query(`UPDATE remote_agent_bindings SET state='released',no_host_effect_proven=$5,updated_at=NOW()
    WHERE operation_id=$1 AND generation=$2 AND docker_id=$3 AND recovery_spec=$4::jsonb AND state<>'released'`,
  [operationId,generation,row.docker_id,JSON.stringify(spec),row.engine === 'codex' && noHostEffect])
  need(updated.rowCount === 1)
  // Capacity only: never clear native pending_request_id or fabricate a terminal/zero receipt.
}
/** A full pool first reclaims this user's lanes left by an earlier container, each by its own stop proof. */
export async function reconcileStaleContainerLanes(pool: Pool, uid: number, liveDockerId: string): Promise<number> {
  const rows = (await pool.query(`SELECT operation_id::text,generation::text FROM remote_agent_bindings
    WHERE uid=$1 AND docker_id<>$2 AND state<>'released'`,[uid,liveDockerId])).rows
  let released = 0
  for (const row of rows) {
    try { await reconcileRemoteLane(pool,row.operation_id,row.generation); released++ }
    catch { /* A container that may still run keeps its slot. */ }
  }
  return released
}
/** Used on a new-container/master placement miss; a live old container remains fenced. */
export async function reconcileRemoteChat(pool: Pool, uid: number, sessionKey: string): Promise<void> {
  const rows = (await pool.query(`SELECT operation_id::text,generation::text FROM remote_agent_bindings
    WHERE uid=$1 AND session_key=$2 AND state<>'released'`,[uid,sessionKey])).rows
  for (const row of rows) await reconcileRemoteLane(pool,row.operation_id,row.generation)
}
