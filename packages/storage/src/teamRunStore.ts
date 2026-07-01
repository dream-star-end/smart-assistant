// team_runs / team_delegations CRUD — v5 团队模式 team run 服务端一等实体。
//
// team run 是服务端权威运行态：一次"用户发起团队协作"的生命周期 + 委派账本。
// SQLite（sessions.db，与 wechat_bindings 同库）为**权威**；gateway 里的
// in-memory map 仅当进程内 live cache，恢复/审计一律以此为准。
//
// 表声明在 sessionsDb.ts（见 CREATE TABLE team_runs / team_delegations）。
// admission 的原子性（数在跑委派 < maxParallel 才插新委派）由 admitTeamDelegation
// 的 db.transaction 保证 —— 不能在应用层先 count 再 insert（有 race）。

import { randomBytes } from 'node:crypto'
import { getSessionsDb } from './sessionsDb.js'

export type TeamRunStatus =
  | 'pending'
  | 'running'
  | 'waiting_review'
  | 'finalize_required'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'interrupted'

export type TeamDelegationStatus = 'queued' | 'running' | 'completed' | 'failed' | 'rejected'

export type TeamDelegationRejectReason = 'maxParallel' | 'not_member' | 'memory' | 'depth' | 'timeout'

export interface TeamRun {
  teamRunId: string
  teamId: string
  teamSnapshot: unknown // 冻结的 TeamDef（policy+members），JSON
  userGoal: string
  originChannel: string
  originPeerId: string
  originSessionKey: string
  originUserId: string | null
  leaderAgentId: string
  leaderSessionKey: string
  status: TeamRunStatus
  maxParallel: number
  reviewRequired: boolean
  reviewAgentId: string | null
  reviewReturnedAt: number | null
  finalAcceptedAt: number | null
  finalContentRef: string | null
  parentRunId: string | null
  createdAt: number
  updatedAt: number
}

export interface TeamDelegation {
  delegationId: string
  teamRunId: string
  memberAgentId: string
  goal: string
  status: TeamDelegationStatus
  childSessionKey: string | null
  rejectReason: TeamDelegationRejectReason | null
  startedAt: number | null
  completedAt: number | null
  resultRef: string | null
  error: string | null
  createdAt: number
  updatedAt: number
}

interface TeamRunRow {
  team_run_id: string
  team_id: string
  team_snapshot: string
  user_goal: string
  origin_channel: string
  origin_peer_id: string
  origin_session_key: string
  origin_user_id: string | null
  leader_agent_id: string
  leader_session_key: string
  status: string
  max_parallel: number
  review_required: number
  review_agent_id: string | null
  review_returned_at: number | null
  final_accepted_at: number | null
  final_content_ref: string | null
  parent_run_id: string | null
  created_at: number
  updated_at: number
}

interface TeamDelegationRow {
  delegation_id: string
  team_run_id: string
  member_agent_id: string
  goal: string
  status: string
  child_session_key: string | null
  reject_reason: string | null
  started_at: number | null
  completed_at: number | null
  result_ref: string | null
  error: string | null
  created_at: number
  updated_at: number
}

function rowToTeamRun(r: TeamRunRow): TeamRun {
  let snapshot: unknown = null
  try {
    snapshot = JSON.parse(r.team_snapshot)
  } catch {
    snapshot = null
  }
  return {
    teamRunId: r.team_run_id,
    teamId: r.team_id,
    teamSnapshot: snapshot,
    userGoal: r.user_goal,
    originChannel: r.origin_channel,
    originPeerId: r.origin_peer_id,
    originSessionKey: r.origin_session_key,
    originUserId: r.origin_user_id,
    leaderAgentId: r.leader_agent_id,
    leaderSessionKey: r.leader_session_key,
    status: r.status as TeamRunStatus,
    maxParallel: r.max_parallel,
    reviewRequired: r.review_required === 1,
    reviewAgentId: r.review_agent_id,
    reviewReturnedAt: r.review_returned_at,
    finalAcceptedAt: r.final_accepted_at,
    finalContentRef: r.final_content_ref,
    parentRunId: r.parent_run_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function rowToTeamDelegation(r: TeamDelegationRow): TeamDelegation {
  return {
    delegationId: r.delegation_id,
    teamRunId: r.team_run_id,
    memberAgentId: r.member_agent_id,
    goal: r.goal,
    status: r.status as TeamDelegationStatus,
    childSessionKey: r.child_session_key,
    rejectReason: (r.reject_reason as TeamDelegationRejectReason | null) ?? null,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    resultRef: r.result_ref,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

// ---- team_runs ----

export interface CreateTeamRunInput {
  teamRunId: string
  teamId: string
  teamSnapshot: unknown
  userGoal: string
  originChannel: string
  originPeerId: string
  originSessionKey: string
  originUserId?: string | null
  leaderAgentId: string
  leaderSessionKey: string
  maxParallel: number
  reviewRequired: boolean
  reviewAgentId?: string | null
  parentRunId?: string | null
  status?: TeamRunStatus
}

export async function createTeamRun(input: CreateTeamRunInput): Promise<TeamRun> {
  const db = await getSessionsDb()
  const now = Date.now()
  db.prepare(
    `INSERT INTO team_runs
       (team_run_id, team_id, team_snapshot, user_goal, origin_channel, origin_peer_id,
        origin_session_key, origin_user_id, leader_agent_id, leader_session_key, status,
        max_parallel, review_required, review_agent_id, parent_run_id, created_at, updated_at)
     VALUES
       (@teamRunId, @teamId, @teamSnapshot, @userGoal, @originChannel, @originPeerId,
        @originSessionKey, @originUserId, @leaderAgentId, @leaderSessionKey, @status,
        @maxParallel, @reviewRequired, @reviewAgentId, @parentRunId, @now, @now)`,
  ).run({
    teamRunId: input.teamRunId,
    teamId: input.teamId,
    teamSnapshot: JSON.stringify(input.teamSnapshot ?? null),
    userGoal: input.userGoal,
    originChannel: input.originChannel,
    originPeerId: input.originPeerId,
    originSessionKey: input.originSessionKey,
    originUserId: input.originUserId ?? null,
    leaderAgentId: input.leaderAgentId,
    leaderSessionKey: input.leaderSessionKey,
    status: input.status ?? 'pending',
    maxParallel: input.maxParallel,
    reviewRequired: input.reviewRequired ? 1 : 0,
    reviewAgentId: input.reviewAgentId ?? null,
    parentRunId: input.parentRunId ?? null,
    now,
  })
  const created = await getTeamRun(input.teamRunId)
  if (!created) throw new Error(`createTeamRun: row not found after insert: ${input.teamRunId}`)
  return created
}

export async function getTeamRun(teamRunId: string): Promise<TeamRun | null> {
  const db = await getSessionsDb()
  const row = db.prepare('SELECT * FROM team_runs WHERE team_run_id = ?').get(teamRunId) as
    | TeamRunRow
    | undefined
  return row ? rowToTeamRun(row) : null
}

// D-B：delegate admission 用 parentSessionKey 反查 —— 命中即"leader 委派"。
export async function getTeamRunByLeaderSessionKey(sessionKey: string): Promise<TeamRun | null> {
  const db = await getSessionsDb()
  const row = db.prepare('SELECT * FROM team_runs WHERE leader_session_key = ?').get(sessionKey) as
    | TeamRunRow
    | undefined
  return row ? rowToTeamRun(row) : null
}

export async function updateTeamRunStatus(
  teamRunId: string,
  status: TeamRunStatus,
): Promise<void> {
  const db = await getSessionsDb()
  db.prepare('UPDATE team_runs SET status = ?, updated_at = ? WHERE team_run_id = ?').run(
    status,
    Date.now(),
    teamRunId,
  )
}

export async function markTeamRunReviewReturned(teamRunId: string, at: number): Promise<void> {
  const db = await getSessionsDb()
  db.prepare(
    'UPDATE team_runs SET review_returned_at = ?, updated_at = ? WHERE team_run_id = ?',
  ).run(at, Date.now(), teamRunId)
}

export async function markTeamRunFinalAccepted(
  teamRunId: string,
  at: number,
  finalContentRef: string | null,
): Promise<void> {
  const db = await getSessionsDb()
  db.prepare(
    `UPDATE team_runs
       SET final_accepted_at = ?, final_content_ref = ?, status = 'completed', updated_at = ?
     WHERE team_run_id = ?`,
  ).run(at, finalContentRef, Date.now(), teamRunId)
}

// gateway 重启：把残留活跃 run 标记为 interrupted（in-memory interrupt map 已丢，
// 不能假装恢复）。返回受影响 run 数。
export async function interruptStaleTeamRuns(): Promise<number> {
  const db = await getSessionsDb()
  const now = Date.now()
  const info = db
    .prepare(
      `UPDATE team_runs SET status = 'interrupted', updated_at = ?
       WHERE status IN ('pending','running','waiting_review','finalize_required','finalizing')`,
    )
    .run(now)
  db.prepare(
    `UPDATE team_delegations SET status = 'failed', error = 'gateway restart', completed_at = ?, updated_at = ?
     WHERE status IN ('queued','running')`,
  ).run(now, now)
  return info.changes
}

// ---- team_delegations ----

// D-C：admission 原子事务 —— 数在跑委派 < maxParallel 才插一行 running。
// P1 不排队：超额直接 rejected(maxParallel)。queued 态为 P5 资源队列预留。
export async function admitTeamDelegation(input: {
  teamRunId: string
  memberAgentId: string
  goal: string
  maxParallel: number
}): Promise<
  { admitted: true; delegationId: string } | { admitted: false; reason: 'maxParallel' }
> {
  const db = await getSessionsDb()
  const now = Date.now()
  const tx = db.transaction((): string | null => {
    const running = db
      .prepare(
        "SELECT COUNT(*) AS c FROM team_delegations WHERE team_run_id = ? AND status = 'running'",
      )
      .get(input.teamRunId) as { c: number }
    if (running.c >= input.maxParallel) return null
    const delegationId = `tdl-${now.toString(36)}-${randomBytes(4).toString('hex')}`
    db.prepare(
      `INSERT INTO team_delegations
         (delegation_id, team_run_id, member_agent_id, goal, status, started_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`,
    ).run(delegationId, input.teamRunId, input.memberAgentId, input.goal, now, now, now)
    return delegationId
  })
  const delegationId = tx()
  return delegationId ? { admitted: true, delegationId } : { admitted: false, reason: 'maxParallel' }
}

// admission 后、spawn child 前：把新建的 child session key 记回委派行（D-B 反查依赖）。
export async function setTeamDelegationChildSession(
  delegationId: string,
  childSessionKey: string,
): Promise<void> {
  const db = await getSessionsDb()
  db.prepare(
    'UPDATE team_delegations SET child_session_key = ?, updated_at = ? WHERE delegation_id = ?',
  ).run(childSessionKey, Date.now(), delegationId)
}

// 记一条被拒委派（非 maxParallel 场景，如 not_member）—— 供 run 账本可见。
export async function recordRejectedTeamDelegation(input: {
  teamRunId: string
  memberAgentId: string
  goal: string
  reason: TeamDelegationRejectReason
}): Promise<string> {
  const db = await getSessionsDb()
  const now = Date.now()
  const delegationId = `tdl-${now.toString(36)}-${randomBytes(4).toString('hex')}`
  db.prepare(
    `INSERT INTO team_delegations
       (delegation_id, team_run_id, member_agent_id, goal, status, reject_reason, completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'rejected', ?, ?, ?, ?)`,
  ).run(delegationId, input.teamRunId, input.memberAgentId, input.goal, input.reason, now, now, now)
  return delegationId
}

// finally：委派终态。
export async function completeTeamDelegation(
  delegationId: string,
  patch: { status: 'completed' | 'failed'; resultRef?: string | null; error?: string | null },
): Promise<void> {
  const db = await getSessionsDb()
  const now = Date.now()
  db.prepare(
    `UPDATE team_delegations
       SET status = ?, result_ref = ?, error = ?, completed_at = ?, updated_at = ?
     WHERE delegation_id = ?`,
  ).run(patch.status, patch.resultRef ?? null, patch.error ?? null, now, now, delegationId)
}

// D-B：命中即"团队成员的嵌套委派"（P1 拒绝）。
export async function getTeamDelegationByChildSessionKey(
  childSessionKey: string,
): Promise<TeamDelegation | null> {
  const db = await getSessionsDb()
  const row = db
    .prepare('SELECT * FROM team_delegations WHERE child_session_key = ?')
    .get(childSessionKey) as TeamDelegationRow | undefined
  return row ? rowToTeamDelegation(row) : null
}

export async function listTeamDelegations(teamRunId: string): Promise<TeamDelegation[]> {
  const db = await getSessionsDb()
  const rows = db
    .prepare('SELECT * FROM team_delegations WHERE team_run_id = ? ORDER BY created_at ASC')
    .all(teamRunId) as TeamDelegationRow[]
  return rows.map(rowToTeamDelegation)
}

// requireReview 硬校验：是否存在一次 reviewer 且 completed 的委派。
export async function hasCompletedReviewerDelegation(
  teamRunId: string,
  reviewAgentId: string,
): Promise<boolean> {
  const db = await getSessionsDb()
  const row = db
    .prepare(
      "SELECT 1 FROM team_delegations WHERE team_run_id = ? AND member_agent_id = ? AND status = 'completed' LIMIT 1",
    )
    .get(teamRunId, reviewAgentId) as { 1: number } | undefined
  return !!row
}
