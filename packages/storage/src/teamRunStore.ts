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
  originPeerKind: string | null
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
  finalizeToken: string | null
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
  origin_peer_kind: string | null
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
  finalize_token: string | null
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
    originPeerKind: r.origin_peer_kind,
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
    finalizeToken: r.finalize_token,
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
  originPeerKind?: string | null
  originSessionKey: string
  originUserId?: string | null
  leaderAgentId: string
  leaderSessionKey: string
  maxParallel: number
  reviewRequired: boolean
  reviewAgentId?: string | null
  finalizeToken?: string | null
  parentRunId?: string | null
  status?: TeamRunStatus
}

export async function createTeamRun(input: CreateTeamRunInput): Promise<TeamRun> {
  const db = await getSessionsDb()
  const now = Date.now()
  db.prepare(
    `INSERT INTO team_runs
       (team_run_id, team_id, team_snapshot, user_goal, origin_channel, origin_peer_id,
        origin_peer_kind, origin_session_key, origin_user_id, leader_agent_id, leader_session_key,
        status, max_parallel, review_required, review_agent_id, finalize_token, parent_run_id, created_at, updated_at)
     VALUES
       (@teamRunId, @teamId, @teamSnapshot, @userGoal, @originChannel, @originPeerId,
        @originPeerKind, @originSessionKey, @originUserId, @leaderAgentId, @leaderSessionKey,
        @status, @maxParallel, @reviewRequired, @reviewAgentId, @finalizeToken, @parentRunId, @now, @now)`,
  ).run({
    teamRunId: input.teamRunId,
    teamId: input.teamId,
    teamSnapshot: JSON.stringify(input.teamSnapshot ?? null),
    userGoal: input.userGoal,
    originChannel: input.originChannel,
    originPeerId: input.originPeerId,
    originPeerKind: input.originPeerKind ?? null,
    originSessionKey: input.originSessionKey,
    originUserId: input.originUserId ?? null,
    leaderAgentId: input.leaderAgentId,
    leaderSessionKey: input.leaderSessionKey,
    status: input.status ?? 'pending',
    maxParallel: input.maxParallel,
    reviewRequired: input.reviewRequired ? 1 : 0,
    reviewAgentId: input.reviewAgentId ?? null,
    finalizeToken: input.finalizeToken ?? null,
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

// CAS 标 failed：仅当 run 仍活跃才写。用于队长异步收尾——不能覆盖用户 stop 标的
// interrupted，也不能覆盖已 completed（Codex 审：stop 后最终态必须仍是 interrupted）。
export async function failTeamRunIfActive(teamRunId: string): Promise<boolean> {
  const db = await getSessionsDb()
  const info = db
    .prepare(
      `UPDATE team_runs SET status = 'failed', updated_at = ?
       WHERE team_run_id = ?
         AND status IN ('pending','running','waiting_review','finalize_required','finalizing')`,
    )
    .run(Date.now(), teamRunId)
  return info.changes > 0
}

export async function markTeamRunReviewReturned(teamRunId: string, at: number): Promise<void> {
  const db = await getSessionsDb()
  db.prepare(
    'UPDATE team_runs SET review_returned_at = ?, updated_at = ? WHERE team_run_id = ?',
  ).run(at, Date.now(), teamRunId)
}

// 原子 CAS finalize：仅当 run 仍开放（未 finalize、非终态）才落 completed，返回是否生效。
// 防并发 double-finalize / last-write-wins（Codex 审）。
export async function markTeamRunFinalAccepted(
  teamRunId: string,
  at: number,
  finalContentRef: string | null,
): Promise<boolean> {
  const db = await getSessionsDb()
  const info = db
    .prepare(
      `UPDATE team_runs
         SET final_accepted_at = ?, final_content_ref = ?, status = 'completed', updated_at = ?
       WHERE team_run_id = ?
         AND final_accepted_at IS NULL
         AND status NOT IN ('failed','interrupted','completed')`,
    )
    .run(at, finalContentRef, Date.now(), teamRunId)
  return info.changes > 0
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

// 用户主动停止：**先在事务里 CAS 关 DB**（run→interrupted + 活跃委派→failed），
// 关掉后 admission tx / finalize CAS 会据此拒绝新委派与收尾（关竞态窗口）。返回
// wasActive + 被中断委派的 child_session_key 列表（供 gateway 逐个 interrupt，覆盖
// admit→register 之间尚未进 active map 的 child）。幂等：已终态 wasActive=false。
export async function interruptTeamRun(
  teamRunId: string,
): Promise<{ wasActive: boolean; childSessionKeys: string[] }> {
  const db = await getSessionsDb()
  const now = Date.now()
  const tx = db.transaction((): { wasActive: boolean; childSessionKeys: string[] } => {
    const rows = db
      .prepare(
        "SELECT child_session_key FROM team_delegations WHERE team_run_id = ? AND status IN ('queued','running')",
      )
      .all(teamRunId) as Array<{ child_session_key: string | null }>
    const childSessionKeys = rows
      .map((r) => r.child_session_key)
      .filter((k): k is string => !!k)
    const info = db
      .prepare(
        `UPDATE team_runs SET status = 'interrupted', updated_at = ?
         WHERE team_run_id = ?
           AND status IN ('pending','running','waiting_review','finalize_required','finalizing')`,
      )
      .run(now, teamRunId)
    db.prepare(
      `UPDATE team_delegations SET status = 'failed', error = 'team run interrupted', completed_at = ?, updated_at = ?
       WHERE team_run_id = ? AND status IN ('queued','running')`,
    ).run(now, now, teamRunId)
    return { wasActive: info.changes > 0, childSessionKeys }
  })
  return tx()
}

// ---- team_delegations ----

// D-C / P5：入队式准入（原子事务）。run 仍 active 时：slot 空且无人排在前面 → 直接
// 'running'；否则 'queued'（不拒绝，等 slot）。run status 检查在事务内，防 finalize/
// admit 并发穿透（Codex 审）。gateway 传的 maxParallel 若为 0（内存水位高）→ 一律入队。
export async function enqueueTeamDelegation(input: {
  teamRunId: string
  memberAgentId: string
  goal: string
  maxParallel: number
}): Promise<{ delegationId: string; status: 'running' | 'queued' | 'run_closed' }> {
  const db = await getSessionsDb()
  const now = Date.now()
  const tx = db.transaction((): { delegationId: string; status: 'running' | 'queued' | 'run_closed' } => {
    const run = db
      .prepare('SELECT status FROM team_runs WHERE team_run_id = ?')
      .get(input.teamRunId) as { status: string } | undefined
    if (!run || run.status !== 'running') return { delegationId: '', status: 'run_closed' }
    const running = (
      db
        .prepare("SELECT COUNT(*) AS c FROM team_delegations WHERE team_run_id = ? AND status = 'running'")
        .get(input.teamRunId) as { c: number }
    ).c
    const queued = (
      db
        .prepare("SELECT COUNT(*) AS c FROM team_delegations WHERE team_run_id = ? AND status = 'queued'")
        .get(input.teamRunId) as { c: number }
    ).c
    const delegationId = `tdl-${now.toString(36)}-${randomBytes(4).toString('hex')}`
    // slot 空 且 队列为空才立即跑（保 FIFO：有人排队时新来的也排队）。
    const status: 'running' | 'queued' = running < input.maxParallel && queued === 0 ? 'running' : 'queued'
    db.prepare(
      `INSERT INTO team_delegations
         (delegation_id, team_run_id, member_agent_id, goal, status, started_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      delegationId,
      input.teamRunId,
      input.memberAgentId,
      input.goal,
      status,
      status === 'running' ? now : null,
      now,
      now,
    )
    return { delegationId, status }
  })
  return tx()
}

// P5：尝试把一个 queued 委派提升为 running。仅当 run 仍 active + slot 空 + 自己是最老
// 的 queued（FIFO）时成功。原子事务。
export async function tryAcquireTeamSlot(input: {
  delegationId: string
  teamRunId: string
  maxParallel: number
}): Promise<'acquired' | 'waiting' | 'run_closed' | 'gone'> {
  const db = await getSessionsDb()
  const now = Date.now()
  const tx = db.transaction((): 'acquired' | 'waiting' | 'run_closed' | 'gone' => {
    const run = db
      .prepare('SELECT status FROM team_runs WHERE team_run_id = ?')
      .get(input.teamRunId) as { status: string } | undefined
    if (!run || run.status !== 'running') return 'run_closed'
    const self = db
      .prepare('SELECT status FROM team_delegations WHERE delegation_id = ?')
      .get(input.delegationId) as { status: string } | undefined
    if (!self) return 'gone'
    if (self.status === 'running') return 'acquired'
    if (self.status !== 'queued') return 'gone' // failed/rejected（如被 stop）
    const running = (
      db
        .prepare("SELECT COUNT(*) AS c FROM team_delegations WHERE team_run_id = ? AND status = 'running'")
        .get(input.teamRunId) as { c: number }
    ).c
    if (running >= input.maxParallel) return 'waiting'
    const oldest = db
      .prepare(
        "SELECT delegation_id FROM team_delegations WHERE team_run_id = ? AND status = 'queued' ORDER BY created_at ASC, delegation_id ASC LIMIT 1",
      )
      .get(input.teamRunId) as { delegation_id: string } | undefined
    if (!oldest || oldest.delegation_id !== input.delegationId) return 'waiting'
    const info = db
      .prepare(
        "UPDATE team_delegations SET status = 'running', started_at = ?, updated_at = ? WHERE delegation_id = ? AND status = 'queued'",
      )
      .run(now, now, input.delegationId)
    return info.changes > 0 ? 'acquired' : 'waiting'
  })
  return tx()
}

// P5：排队超时——把仍 queued 的委派标 rejected(reason)，供账本可见。
export async function rejectQueuedTeamDelegation(
  delegationId: string,
  reason: TeamDelegationRejectReason,
): Promise<void> {
  const db = await getSessionsDb()
  const now = Date.now()
  db.prepare(
    "UPDATE team_delegations SET status = 'rejected', reject_reason = ?, completed_at = ?, updated_at = ? WHERE delegation_id = ? AND status = 'queued'",
  ).run(reason, now, now, delegationId)
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
  // CAS：仅当委派仍 queued/running 才落终态。防 stop 已把它标 failed(interrupted)后，
  // 晚到的 delegate finally 又把它覆盖成 completed，污染账本、掩盖 stop 语义（Codex 审）。
  db.prepare(
    `UPDATE team_delegations
       SET status = ?, result_ref = ?, error = ?, completed_at = ?, updated_at = ?
     WHERE delegation_id = ? AND status IN ('queued','running')`,
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
