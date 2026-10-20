/**
 * Gateway session repo binding: bind, unbind, session check and pending-bind flush
 *
 * Moved verbatim out of Gateway (server.ts) — FINDINGS §7.6, OCV5-493. The class
 * keeps one-line forwarders that call these with the instance as `this`, so behaviour, closures and
 * `this.x` reads/writes are unchanged. SessionRepoBindingHost lists exactly the Gateway members this code
 * touches (typed from the class itself).
 */
import type { WebSocket } from 'ws'
import type { SessionRepoBindFrame } from './sessionRepoWorkspace.js'
import { makePeerKey, REPO_BIND_HELLO_GRACE_MS, REPO_BIND_PENDING_TIMEOUT_MS } from './server.js'
import type { Gateway } from './server.js'

export interface SessionRepoBindingHost {
  _buildStatusCallback: Gateway['_buildStatusCallback']
  _checkRepoBindSession: Gateway['_checkRepoBindSession']
  _pendingRepoBinds: Gateway['_pendingRepoBinds']
  _recentHelloPeers: Gateway['_recentHelloPeers']
  _repoWorkspace: Gateway['_repoWorkspace']
  _sendStatusFrame: Gateway['_sendStatusFrame']
  clientsByPeer: Gateway['clientsByPeer']
  getWsUserId: Gateway['getWsUserId']
  log: Gateway['log']
  sessions: Gateway['sessions']
}

/** Phase 4 — bind 帧处理 */
export async function _handleSessionRepoBind(
  this: SessionRepoBindingHost,
  ws: WebSocket,
  frame: SessionRepoBindFrame,
): Promise<void> {
  // 基础 schema 校验(master bridge 已做严格校验,这里兜底)。
  // Codex Phase 5 review P1:owner/repo/branch typeof + selectionVersion safe-int 必须显式
  // 校验,否则 manager 里 regex.test(undefined) 会把 'undefined' 字符串通过,
  // version 被 NaN/Infinity/小数/负数 污染会进路径和 pending key。
  const isSafePositiveInt =
    typeof frame.selectionVersion === 'number' &&
    Number.isSafeInteger(frame.selectionVersion) &&
    frame.selectionVersion > 0
  const isNonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0
  if (
    !isNonEmptyStr(frame.sessionId) ||
    !/^[A-Za-z0-9_-]+$/.test(frame.sessionId) ||
    !isSafePositiveInt ||
    !isNonEmptyStr(frame.accessToken) ||
    !isNonEmptyStr(frame.owner) ||
    !isNonEmptyStr(frame.repo) ||
    !isNonEmptyStr(frame.branch)
  ) {
    this._sendStatusFrame(ws, {
      type: 'outbound.control.session_repo_status',
      sessionId: String(frame?.sessionId ?? ''),
      selectionVersion: isSafePositiveInt ? frame.selectionVersion : 0,
      status: 'failed',
      errorCode: 'INVALID_BIND_FRAME',
      errorMessage: 'bind frame schema invalid',
    })
    return
  }
  const auth = this._checkRepoBindSession(ws, frame.sessionId)
  // v1.0.95 诊断 instrument:确认 auth 走了哪条路径(authorized / queued)
  this.log.info('repo_bind_auth_decision', {
    sessionId: frame.sessionId,
    selectionVersion: frame.selectionVersion,
    auth,
  })
  if (auth === 'queued') {
    // 入 pending 5s 队列
    const key = `${frame.sessionId}|${frame.selectionVersion}`
    // 同 key 已在 pending → 覆盖(用最新 frame)
    const old = this._pendingRepoBinds.get(key)
    if (old) clearTimeout(old.timer)
    const timer = setTimeout(() => {
      this._pendingRepoBinds.delete(key)
      // v1.0.95 诊断 instrument:5s grace 没等到 hello 注册 → 走 fail 路径
      this.log.warn('repo_bind_pending_timeout', {
        sessionId: frame.sessionId,
        selectionVersion: frame.selectionVersion,
      })
      this._sendStatusFrame(ws, {
        type: 'outbound.control.session_repo_status',
        sessionId: frame.sessionId,
        selectionVersion: frame.selectionVersion,
        status: 'failed',
        errorCode: 'SESSION_NOT_REGISTERED',
        errorMessage: 'session not registered with this WS within grace window',
      })
    }, REPO_BIND_PENDING_TIMEOUT_MS)
    this._pendingRepoBinds.set(key, { ws, frame, timer })
    return
  }
  // authorized → 立即处理
  await this._repoWorkspace.bind(frame, this._buildStatusCallback(ws, frame.sessionId))
}

/**
 * Phase 4 — unbind 帧处理(Phase 5 加版本化)。
 *
 * 顺序(关键):
 *   1. _repoWorkspace.unbind(sessionId, version)  短锁内 state.delete
 *      → 之后 getRepoSnapshot 返 null
 *   2. recyclePeerForRepoUnbind(sessionId)        进 session.lock,shutdown runner
 *      → 排队的 submit 拿到 lock 时读 null snapshot,addDir 回 agentBaseDir
 *
 * 没有 selectionVersion 的 unbind 帧:rejected(理论不该发生,前端必带版本号;
 * 没版本的话 workspaceMgr 的 tombstone-too-old 保护就失效)。
 */
export async function _handleSessionRepoUnbind(
  this: SessionRepoBindingHost,
  ws: WebSocket,
  frame: { sessionId: string; selectionVersion?: number },
): Promise<void> {
  if (typeof frame?.sessionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(frame.sessionId)) return
  if (
    typeof frame.selectionVersion !== 'number' ||
    !Number.isSafeInteger(frame.selectionVersion) ||
    frame.selectionVersion <= 0
  ) {
    this.log.warn('repo_unbind_invalid_version', {
      sessionId: frame.sessionId,
      selectionVersion: frame.selectionVersion,
    })
    return
  }
  // unbind 不要求 ws 注册校验:用户主动清空,任何路径来都允许。
  // Codex Phase 5 review P0:unbind 返 boolean,只在真删 state 时 recycle。
  // stale tombstone(workspace 已被新 version 替换)被 manager ignore 时 caller
  // 必须不 kill runner — 否则旧 v_x runner 被错杀,新 v_y 还在 cloning,下次
  // spawn 读 ready snapshot 走 v_y workspaceDir 而非 v_x。
  const deleted = await this._repoWorkspace.unbind(frame.sessionId, frame.selectionVersion)
  if (!deleted) {
    this.log.info('repo_unbind_skipped_no_recycle', {
      sessionId: frame.sessionId,
      selectionVersion: frame.selectionVersion,
    })
    return
  }
  await this.sessions.recyclePeerForRepoUnbind(frame.sessionId).catch((err) =>
    this.log.warn('recycle_for_repo_unbind_failed', {
      sessionId: frame.sessionId,
      err: err instanceof Error ? err.message : String(err),
    }),
  )
  // 不发 status 帧 — DELETE 已经在 master DB 写 cleared
}

/**
 * Phase 4 — 校验 sessionId 在该 ws 的注册集合或最近 hello peers(grace window)。
 * 三种 outcome:
 *   - 'authorized':立即处理
 *   - 'queued':入 pending,等 hello/message 注册
 *   - 'rejected':硬拒(sessionId 不合法)
 */
export function _checkRepoBindSession(
  this: SessionRepoBindingHost,
  ws: WebSocket,
  sessionId: string,
): 'authorized' | 'queued' {
  const userId = this.getWsUserId(ws)
  // grace window:hello 后 5s 内,任何 bind 帧引用其 peerIds 视作 authorized。
  // 帮 race:bind 在 hello 之后但 message 注册之前到达。
  const recent = this._recentHelloPeers.get(ws)
  if (recent && Date.now() - recent.recordedAt <= REPO_BIND_HELLO_GRACE_MS) {
    if (recent.peerIds.has(sessionId)) return 'authorized'
  }
  // 直查 clientsByPeer:Codex Phase 4.7 #1 — makePeerKey 是 `userId:channel:peerId`
  // (3 parts),不是 4 parts。直接构造预期 key 避免格式漂移 bug。
  // sessionId 已通过 caller 的 SAFE_GIT_REF / SESSION_ID_RE 校验,sanitizePeerId
  // 后等于自身;仍走 sanitize 与 dispatch 路径(L3459-3460)的 makePeerKey 保持一致。
  const sanitizedSid = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  const expectedKey = makePeerKey(userId, 'webchat', sanitizedSid)
  const set = this.clientsByPeer.get(expectedKey)
  if (set?.has(ws)) return 'authorized'
  return 'queued'
}

/** Phase 4 — hello 到达后,看 pending 队列里有没有匹配的 bind 可以处理 */
export function _flushPendingRepoBinds(
  this: SessionRepoBindingHost,
  ws: WebSocket,
  peerIds: Set<string>,
): void {
  if (this._pendingRepoBinds.size === 0) return
  for (const [key, entry] of this._pendingRepoBinds) {
    if (entry.ws !== ws) continue
    if (!peerIds.has(entry.frame.sessionId)) continue
    clearTimeout(entry.timer)
    this._pendingRepoBinds.delete(key)
    // async 处理(不阻塞 hello 转发后续)
    // 用同一个 _buildStatusCallback wrapper:既 forward 给 ws,也触发 recycle。
    this._repoWorkspace
      .bind(entry.frame, this._buildStatusCallback(ws, entry.frame.sessionId))
      .catch((err) =>
        this.log.warn('flush_pending_bind_failed', {
          err: err instanceof Error ? err.message : String(err),
        }),
      )
  }
}
