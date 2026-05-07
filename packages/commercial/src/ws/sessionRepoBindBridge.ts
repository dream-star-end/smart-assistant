/**
 * Phase 4 — bridge 侧 GitHub session-repo bind/unbind/status 帧处理 helpers。
 *
 * 设计权威源:Phase 4 plan v3(Codex PASS)。本文件不直接读写 ws,只暴露 pure
 * functions / async helpers,被 userChatBridge.ts 串成主路径。
 *
 * 三个职责:
 *   1. enrichBindFrame   — inbound.control.session_repo_bind 富化:DB 查 selection
 *                          + GitHub link token,组装完整 bind payload
 *   2. handleStatusFrame — outbound.control.session_repo_status 落库:UPDATE
 *                          github_session_workspaces 状态;token_invalid 触发级联 revoke
 *   3. buildAutoRebindFrames — auto-rebind 时拿 hello peers + cached selections,
 *                          配合 token 组帧
 *
 * 不做的事:
 *   - 不直接 ws.send;调用方拿返回值自己 forward
 *   - 不维护任何 state;state 都在 caller(bridge instance)里
 */

import type { Pool } from 'pg'
import {
  getGithubLinkWithToken,
  revokeGithubLinkAndClearSessions,
} from '../github/tokenStore.js'
import {
  getSessionSelection,
  listActiveGithubWorkspaceSelections,
  updateGithubWorkspaceStatusIfVersion,
  type GithubSelectionRow,
} from '../github/sessionWorkspaces.js'

/** sessionId 必须只含 [A-Za-z0-9_-]。Phase 4 plan v3 修 #3 + Codex 边界 #1。 */
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/

/** github owner/repo/branch 也要轻校验,防 shell injection 进 git argv(虽然我们用 spawn args[],
 * 但还是不允许换行 / 控制字符)。GitHub 自己规则更严,这里只兜最低限。 */
const SAFE_GIT_REF_RE = /^[A-Za-z0-9._/-]+$/

export interface SessionRepoBindRequest {
  sessionId: string
  selectionVersion: number
  /** frontend WS frame 自带 peer/agentId/channel,容器侧用来构造 sessionKey 校验 */
  peer: { id: string; kind: 'dm' }
  agentId: string
  channel: string
}

export interface SessionRepoBindEnriched extends SessionRepoBindRequest {
  type: 'inbound.control.session_repo_bind'
  owner: string
  repo: string
  branch: string
  defaultBranch: string | null
  headSha: string | null
  accessToken: string
  scopes: string
}

export interface SessionRepoBindError {
  type: 'outbound.control.session_repo_bind_error'
  sessionId: string
  selectionVersion: number
  errorCode:
    | 'INVALID_SESSION_ID'
    | 'INVALID_BIND_PAYLOAD'
    | 'STALE_OR_MISSING'
    | 'GITHUB_NOT_LINKED'
  errorMessage: string
}

/** parse + validate frontend 发来的 bind 请求帧。返 null 表示帧 schema 错。 */
export function parseBindRequest(parsed: unknown): SessionRepoBindRequest | null {
  if (parsed === null || typeof parsed !== 'object') return null
  const p = parsed as Record<string, unknown>
  if (p.type !== 'inbound.control.session_repo_bind') return null
  if (typeof p.sessionId !== 'string' || !SESSION_ID_RE.test(p.sessionId)) return null
  if (typeof p.selectionVersion !== 'number' || !Number.isSafeInteger(p.selectionVersion) || p.selectionVersion <= 0) return null
  if (typeof p.peer !== 'object' || p.peer === null) return null
  const peer = p.peer as Record<string, unknown>
  if (typeof peer.id !== 'string' || peer.id !== p.sessionId) return null  // 约定 peerId === sessionId
  if (peer.kind !== 'dm') return null
  if (typeof p.agentId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(p.agentId)) return null
  if (typeof p.channel !== 'string' || !/^[A-Za-z0-9_-]+$/.test(p.channel)) return null
  return {
    sessionId: p.sessionId,
    selectionVersion: p.selectionVersion,
    peer: { id: peer.id, kind: 'dm' },
    agentId: p.agentId,
    channel: p.channel,
  }
}

export interface SessionRepoUnbindRequest {
  type: 'inbound.control.session_repo_unbind'
  sessionId: string
  /** Phase 5 — gateway 用 selectionVersion 做 tombstone-too-old 校验:
   *  state.selectionVersion > 此值 时,本帧是过期 unbind,不删 state(避免误杀新 bind)。
   *  caller 必须从前端帧透传过来,parser 不重组帧, fall-through forward 仍带原字段。 */
  selectionVersion: number
}

export function parseUnbindRequest(parsed: unknown): SessionRepoUnbindRequest | null {
  if (parsed === null || typeof parsed !== 'object') return null
  const p = parsed as Record<string, unknown>
  if (p.type !== 'inbound.control.session_repo_unbind') return null
  if (typeof p.sessionId !== 'string' || !SESSION_ID_RE.test(p.sessionId)) return null
  if (
    typeof p.selectionVersion !== 'number' ||
    !Number.isSafeInteger(p.selectionVersion) ||
    p.selectionVersion <= 0
  )
    return null
  return {
    type: 'inbound.control.session_repo_unbind',
    sessionId: p.sessionId,
    selectionVersion: p.selectionVersion,
  }
}

/** 富化 bind 请求。返 enriched 帧或 error 帧(由 caller 决定 forward 哪个)。 */
export async function enrichBindRequest(
  pool: Pool,
  userId: number,
  req: SessionRepoBindRequest,
): Promise<SessionRepoBindEnriched | SessionRepoBindError> {
  const sel = await getSessionSelection(pool, userId, req.sessionId)
  if (
    !sel ||
    sel.selectionVersion !== req.selectionVersion ||
    sel.status === 'cleared'
  ) {
    return {
      type: 'outbound.control.session_repo_bind_error',
      sessionId: req.sessionId,
      selectionVersion: req.selectionVersion,
      errorCode: 'STALE_OR_MISSING',
      errorMessage: 'Session repo selection is stale or missing; re-PUT the selection',
    }
  }
  // refs 兜底校验(DB 里的值理论上已被 Phase 3 验过,这里再防一道)
  if (
    !SAFE_GIT_REF_RE.test(sel.owner) ||
    !SAFE_GIT_REF_RE.test(sel.repo) ||
    !SAFE_GIT_REF_RE.test(sel.branch)
  ) {
    return {
      type: 'outbound.control.session_repo_bind_error',
      sessionId: req.sessionId,
      selectionVersion: req.selectionVersion,
      errorCode: 'INVALID_BIND_PAYLOAD',
      errorMessage: 'Invalid owner/repo/branch in DB selection',
    }
  }
  const link = await getGithubLinkWithToken(pool, userId)
  if (!link) {
    return {
      type: 'outbound.control.session_repo_bind_error',
      sessionId: req.sessionId,
      selectionVersion: req.selectionVersion,
      errorCode: 'GITHUB_NOT_LINKED',
      errorMessage: 'GitHub link missing or revoked; please relink',
    }
  }
  return {
    type: 'inbound.control.session_repo_bind',
    sessionId: req.sessionId,
    selectionVersion: req.selectionVersion,
    peer: req.peer,
    agentId: req.agentId,
    channel: req.channel,
    owner: sel.owner,
    repo: sel.repo,
    branch: sel.branch,
    defaultBranch: sel.defaultBranch,
    headSha: sel.headSha,
    accessToken: link.accessToken,
    scopes: link.scopes,
  }
}

export interface SessionRepoStatusFrame {
  type: 'outbound.control.session_repo_status'
  sessionId: string
  selectionVersion: number
  status: 'cloning' | 'ready' | 'failed'
  headSha?: string | null
  errorCode?: string | null
  errorMessage?: string | null
}

/** parse 容器发来的 status 帧。返 null 表示不是 status 帧或 schema 错。 */
export function parseStatusFrame(parsed: unknown): SessionRepoStatusFrame | null {
  if (parsed === null || typeof parsed !== 'object') return null
  const p = parsed as Record<string, unknown>
  if (p.type !== 'outbound.control.session_repo_status') return null
  if (typeof p.sessionId !== 'string' || !SESSION_ID_RE.test(p.sessionId)) return null
  if (typeof p.selectionVersion !== 'number' || !Number.isInteger(p.selectionVersion)) return null
  if (p.status !== 'cloning' && p.status !== 'ready' && p.status !== 'failed') return null
  return {
    type: 'outbound.control.session_repo_status',
    sessionId: p.sessionId,
    selectionVersion: p.selectionVersion,
    status: p.status,
    headSha: typeof p.headSha === 'string' ? p.headSha : null,
    errorCode: typeof p.errorCode === 'string' ? p.errorCode : null,
    errorMessage: typeof p.errorMessage === 'string' ? p.errorMessage : null,
  }
}

/**
 * Status 帧落库 + 级联 revoke。Phase 4 plan v3 修 #2 + 可选 #3:
 *   - 不依赖 stale UPDATE 成功;errorCode='token_invalid' 必先 revoke+clear,
 *     之后再尝试 versioned UPDATE(stale 失败可接受,revoke 已是终态语义)
 *   - 透传 status 帧给 userWs 由 caller 负责
 *
 * 返回 { dbUpdated, revoked }:caller 用于日志。
 */
export async function applyStatusFrame(
  pool: Pool,
  userId: number,
  frame: SessionRepoStatusFrame,
): Promise<{ dbUpdated: boolean; revoked: boolean }> {
  let revoked = false
  if (frame.status === 'failed' && frame.errorCode === 'token_invalid') {
    try {
      await revokeGithubLinkAndClearSessions(pool, userId, 'link_revoked')
      revoked = true
    } catch {
      // best-effort:revoke 失败不阻塞 status 帧处理
    }
  }
  const r = await updateGithubWorkspaceStatusIfVersion(pool, {
    userId,
    sessionId: frame.sessionId,
    selectionVersion: frame.selectionVersion,
    status: frame.status,
    headSha: frame.headSha ?? null,
    errorCode: frame.errorCode ?? null,
    errorMessage: frame.errorMessage ?? null,
  })
  return { dbUpdated: r.updated, revoked }
}

/**
 * Auto-rebind:open 时 fetch 当前 user 全部 active selections(无 token)。
 * 调用方把结果塞进 bridge instance 的 pendingRebindMap;hello 到达时 flush。
 */
export async function fetchActiveSelectionsForRebind(
  pool: Pool,
  userId: number,
): Promise<GithubSelectionRow[]> {
  return listActiveGithubWorkspaceSelections(pool, userId)
}

/**
 * Hello 触发的 flush:对 hello peers 匹配 pendingRebindMap,把匹配的 selections
 * 富化为完整 bind 帧返回(token 在这一刻才取,覆盖 open→hello 中间窗 revoke 风险)。
 *
 * 返回:
 *   - frames: 要 forward 给 container 的富化帧数组(可空)
 *   - errors: 要发回 userWs 的 error 帧数组(GITHUB_NOT_LINKED 时一行 selection 对一个 error)
 *   - matchedSessionIds: 调用方用来从 pendingRebindMap 删除已处理的项
 */
export async function buildAutoRebindFrames(
  pool: Pool,
  userId: number,
  helloPeerIds: string[],
  pendingRebindMap: Map<string, GithubSelectionRow>,
): Promise<{
  frames: SessionRepoBindEnriched[]
  errors: SessionRepoBindError[]
  matchedSessionIds: string[]
}> {
  const matched: GithubSelectionRow[] = []
  const matchedSessionIds: string[] = []
  for (const peerId of helloPeerIds) {
    const sel = pendingRebindMap.get(peerId)
    if (sel) {
      matched.push(sel)
      matchedSessionIds.push(peerId)
    }
  }
  if (matched.length === 0) {
    return { frames: [], errors: [], matchedSessionIds: [] }
  }
  const link = await getGithubLinkWithToken(pool, userId)
  if (!link) {
    // open 和 hello 之间被 revoke;每个 matched session 都给 user error
    return {
      frames: [],
      errors: matched.map((sel) => ({
        type: 'outbound.control.session_repo_bind_error',
        sessionId: sel.sessionId,
        selectionVersion: sel.selectionVersion,
        errorCode: 'GITHUB_NOT_LINKED',
        errorMessage: 'GitHub link missing or revoked',
      })),
      matchedSessionIds,
    }
  }
  const frames: SessionRepoBindEnriched[] = []
  const errors: SessionRepoBindError[] = []
  for (const sel of matched) {
    if (
      !SAFE_GIT_REF_RE.test(sel.owner) ||
      !SAFE_GIT_REF_RE.test(sel.repo) ||
      !SAFE_GIT_REF_RE.test(sel.branch)
    ) {
      errors.push({
        type: 'outbound.control.session_repo_bind_error',
        sessionId: sel.sessionId,
        selectionVersion: sel.selectionVersion,
        errorCode: 'INVALID_BIND_PAYLOAD',
        errorMessage: 'Invalid owner/repo/branch',
      })
      continue
    }
    frames.push({
      type: 'inbound.control.session_repo_bind',
      sessionId: sel.sessionId,
      selectionVersion: sel.selectionVersion,
      peer: { id: sel.sessionId, kind: 'dm' },
      agentId: 'main', // Phase 4 假设单 agent;multi-agent 留 Phase 5
      channel: 'webchat',
      owner: sel.owner,
      repo: sel.repo,
      branch: sel.branch,
      defaultBranch: sel.defaultBranch,
      headSha: sel.headSha,
      accessToken: link.accessToken,
      scopes: link.scopes,
    })
  }
  return { frames, errors, matchedSessionIds }
}
