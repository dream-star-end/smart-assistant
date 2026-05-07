/**
 * Phase 4 — 容器侧 GitHub session-repo workspace 管理。
 * Phase 5 — 加 short-grained lock + RepoState headSha/errorCode/errorMessage 字段
 *           + getRepoSnapshot 公开 API + 版本化 unbind(tombstone-too-old 不删)。
 *
 * 职责:
 *   - 接收 master bridge 富化后的 inbound.control.session_repo_bind 帧
 *   - clone repo 到 /home/agent/.openclaude/repos/<sessionId>/<selectionVersion>/(原子 rename)
 *   - token 文件落到独立目录 /home/agent/.openclaude/git-creds/<sessionId>/<version>/token,
 *     git credential.helper 引用绝对 path,token 字符串永不进 argv / .git/config / log
 *   - 状态机:pending → cloning → ready / failed,通过 outbound.control.session_repo_status
 *     回送给 bridge(bridge 落库 + 透传 userWs)
 *   - 同 sessionId 新 version 进入时,abort 旧 in-flight clone(每个异步检查点都验证
 *     state.selectionVersion === myVersion + abort signal)
 *   - hydrate:旧 dir + .git 有效 → 直接 ack ready,不 reclone
 *   - getSessionRepoCwd(sessionId) 给 Phase 5 promptSlots/Bash 用
 *
 * 路径约定(与 Dockerfile + supervisor mount 一致):
 *   /home/agent/.openclaude/                    ← named volume oc-v3-data-u<uid>(已挂)
 *     ├── repos/<sessionId>/<version>/          ← clone 工作树
 *     └── git-creds/<sessionId>/<version>/token ← token file (chmod 600)
 *
 * 安全约束(Phase 4 plan v3 修 #5 + Codex 边界):
 *   - sessionId 已在 master bridge 校验过 [A-Za-z0-9_-]+;容器侧再 sanity check
 *   - owner/repo/branch 进 spawn args[],不拼 shell
 *   - askpass 临时脚本 chmod 700,clone 完成后立即删
 *   - token 内容只进 token file,argv/config/log 永不出现
 *   - unbind / token_invalid 清相应 version 的 token 目录(精确 version,不全删 sessionId)
 *
 * Phase 5 锁不变量:
 *   - 单 sessionId 一把异步锁 (withSessionLock),所有 state 读写 + abort 决策都在锁内
 *   - 长 IO(validateWorkspace / writeTokenFile / runClone)走锁外,通过 aliveAndCurrent 兜底
 *   - 写终态(ready / failed)前再短锁 commit + aliveAndCurrent 双校验
 *   - 旧 version fs 目录:**ready 时不主动 GC**(避免误删旧 runner cwd),unbind 时
 *     按 cleanupVersionsThrough 精确删 `<= tombstone version` 的子目录,父目录用 rmdir
 *     只在空时清。这样并发 bind v2 即使在 unbind v1 释放锁后立刻写 v2 token 也不会被误删。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, writeFile, chmod, rename, rm, readFile, mkdtemp, stat, readdir, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/
const SAFE_GIT_REF_RE = /^[A-Za-z0-9._/-]+$/

const DATA_ROOT = '/home/agent/.openclaude'
const REPOS_ROOT = path.join(DATA_ROOT, 'repos')
const CREDS_ROOT = path.join(DATA_ROOT, 'git-creds')

export interface SessionRepoBindFrame {
  type: 'inbound.control.session_repo_bind'
  sessionId: string
  selectionVersion: number
  peer: { id: string; kind: 'dm' }
  agentId: string
  channel: string
  owner: string
  repo: string
  branch: string
  defaultBranch: string | null
  headSha: string | null
  accessToken: string
  scopes: string
}

export interface SessionRepoStatusOut {
  type: 'outbound.control.session_repo_status'
  sessionId: string
  selectionVersion: number
  status: 'cloning' | 'ready' | 'failed'
  /** 绝对路径,ready 时填(让消费方不再硬编码 path 拼接)。 */
  workspaceDir?: string | null
  headSha?: string | null
  errorCode?: string | null
  errorMessage?: string | null
}

/** 公开给 master / Phase 5 promptSlots 的 RepoState 快照。 */
export interface RepoSnapshot {
  status: 'pending' | 'cloning' | 'ready' | 'failed'
  selectionVersion: number
  owner: string
  repo: string
  branch: string
  workspaceDir: string | null
  headSha: string | null
  errorCode: string | null
  errorMessage: string | null
}

interface RepoState {
  selectionVersion: number
  owner: string
  repo: string
  branch: string
  status: 'pending' | 'cloning' | 'ready' | 'failed'
  workspaceDir: string | null
  /** Phase 5 持久化字段:hydrate / runClone success 时填,getRepoSnapshot 直接返。 */
  headSha: string | null
  errorCode: string | null
  errorMessage: string | null
  abort: AbortController
  cloneProc: ChildProcess | null
}

export interface RepoWorkspaceLogger {
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
}

const noopLogger: RepoWorkspaceLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

export class SessionRepoWorkspaceManager {
  private states = new Map<string, RepoState>()
  /** Phase 5:每个 sessionId 一把异步锁,串行化 bind/unbind/状态写。 */
  private opLocks = new Map<string, Promise<void>>()
  private log: RepoWorkspaceLogger

  constructor(log: RepoWorkspaceLogger = noopLogger) {
    this.log = log
  }

  /** Phase 5 用:给 Bash 工具拿当前 session 的 cwd。null = 未 ready。 */
  getSessionRepoCwd(sessionId: string): string | null {
    const snap = this.getRepoSnapshot(sessionId)
    return snap?.status === 'ready' ? snap.workspaceDir : null
  }

  /**
   * Phase 5 公开 API:返当前 sessionId 的 RepoSnapshot 拷贝(字段值,不含 abort 等内部对象)。
   * 单线程 V8 下 Map.get + 字段拷贝原子,不需要进锁。
   */
  getRepoSnapshot(sessionId: string): RepoSnapshot | null {
    const s = this.states.get(sessionId)
    if (!s) return null
    return {
      status: s.status,
      selectionVersion: s.selectionVersion,
      owner: s.owner,
      repo: s.repo,
      branch: s.branch,
      workspaceDir: s.workspaceDir,
      headSha: s.headSha,
      errorCode: s.errorCode,
      errorMessage: s.errorMessage,
    }
  }

  /**
   * 接收 bind 帧。同步返回 'cloning' status(立即 ack 给 bridge),后续异步发出
   * ready/failed via sendStatus 回调。
   *
   * hydrate 路径(同 version + dir 有效)→ 直接发 'ready',不重 clone。
   *
   * Phase 5 lock 模式:
   *   - 短锁 #1:决定 hydrate / noop / fresh + state 设置
   *   - 锁外 IO:validateWorkspace + writeTokenFile + runClone
   *   - 短锁 #2:hydrate 路径 commit headSha;runClone 内 ready/failed commit
   */
  async bind(
    frame: SessionRepoBindFrame,
    sendStatus: (s: SessionRepoStatusOut) => void,
  ): Promise<void> {
    // Codex Phase 5 review P1:显式 typeof string 检查,防 regex.test(undefined) 绕过。
    // server.ts 路径已先做兜底,但 manager 是公开 API,不能依赖 caller 已校验。
    const safeStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0
    if (!safeStr(frame.sessionId) || !SESSION_ID_RE.test(frame.sessionId)) {
      sendStatus({
        type: 'outbound.control.session_repo_status',
        sessionId: typeof frame.sessionId === 'string' ? frame.sessionId : '',
        selectionVersion: typeof frame.selectionVersion === 'number' ? frame.selectionVersion : 0,
        status: 'failed',
        errorCode: 'INVALID_SESSION_ID',
        errorMessage: 'sessionId contains invalid characters',
      })
      return
    }
    if (
      !Number.isSafeInteger(frame.selectionVersion) ||
      (frame.selectionVersion as number) <= 0
    ) {
      sendStatus({
        type: 'outbound.control.session_repo_status',
        sessionId: frame.sessionId,
        selectionVersion: 0,
        status: 'failed',
        errorCode: 'INVALID_VERSION',
        errorMessage: 'selectionVersion must be positive safe integer',
      })
      return
    }
    if (
      !safeStr(frame.owner) ||
      !safeStr(frame.repo) ||
      !safeStr(frame.branch) ||
      !SAFE_GIT_REF_RE.test(frame.owner) ||
      !SAFE_GIT_REF_RE.test(frame.repo) ||
      !SAFE_GIT_REF_RE.test(frame.branch)
    ) {
      sendStatus({
        type: 'outbound.control.session_repo_status',
        sessionId: frame.sessionId,
        selectionVersion: frame.selectionVersion,
        status: 'failed',
        errorCode: 'INVALID_REF',
        errorMessage: 'owner/repo/branch contains invalid characters',
      })
      return
    }

    // ── 短锁 #1:决定路径分支 + 状态 set ──
    type Decision =
      | { kind: 'noop' }
      | { kind: 'maybe-hydrate'; existing: RepoState; workspaceDir: string }
      | { kind: 'hydrate-from-disk'; workspaceDir: string; placeholderState: RepoState }
      | { kind: 'fresh'; newState: RepoState }
    const decision = await this.withSessionLock<Decision>(frame.sessionId, async () => {
      const existing = this.states.get(frame.sessionId)

      if (existing && existing.selectionVersion === frame.selectionVersion) {
        if (existing.status === 'ready' && existing.workspaceDir) {
          return { kind: 'maybe-hydrate', existing, workspaceDir: existing.workspaceDir }
        }
        if (existing.status === 'cloning' || existing.status === 'pending') {
          return { kind: 'noop' }
        }
        // failed → 落到 fresh
      }

      // hydrate-from-disk(state 缺失但 dir 存在,容器重启场景)— 锁内先 install
      // 一个 'pending' placeholder state(带 AbortController),让并发 unbind 能命中
      // 正轨(s 存在 + version 匹配 → abort + delete + 返回 true → caller recycle)。
      // 锁外 stat + git rev-parse 验证;commit 时 identity-equality 检查 placeholder
      // 是否仍持有(没被 unbind 删 / 没被新 PUT 覆盖)。
      // Codex Phase 5 final review P0 race fix:不再 release lock 后才 set state。
      if (!existing) {
        const placeholder: RepoState = {
          selectionVersion: frame.selectionVersion,
          owner: frame.owner,
          repo: frame.repo,
          branch: frame.branch,
          status: 'pending',
          workspaceDir: null,
          headSha: null,
          errorCode: null,
          errorMessage: null,
          abort: new AbortController(),
          cloneProc: null,
        }
        this.states.set(frame.sessionId, placeholder)
        const candidate = path.join(REPOS_ROOT, frame.sessionId, String(frame.selectionVersion))
        return { kind: 'hydrate-from-disk', workspaceDir: candidate, placeholderState: placeholder }
      }

      // existing 但版本不同,或 status === 'failed' → abort 旧 + set 新 cloning
      existing.abort.abort()
      if (existing.cloneProc && !existing.cloneProc.killed) {
        try {
          existing.cloneProc.kill('SIGTERM')
        } catch {
          /* */
        }
      }
      const newState: RepoState = {
        selectionVersion: frame.selectionVersion,
        owner: frame.owner,
        repo: frame.repo,
        branch: frame.branch,
        status: 'cloning',
        workspaceDir: null,
        headSha: null,
        errorCode: null,
        errorMessage: null,
        abort: new AbortController(),
        cloneProc: null,
      }
      this.states.set(frame.sessionId, newState)
      return { kind: 'fresh', newState }
    })

    if (decision.kind === 'noop') return

    // ── maybe-hydrate 路径 ──
    if (decision.kind === 'maybe-hydrate') {
      // (a) 锁外 validateWorkspace
      const ok = await this.validateWorkspace(decision.workspaceDir)
      if (!ok) {
        // 验证失败 → 短锁覆盖 state 为新 cloning(同 fresh),再走 runClone
        const fresh = await this.withSessionLock<RepoState | null>(frame.sessionId, async () => {
          const cur = this.states.get(frame.sessionId)
          if (cur !== decision.existing) return null // 别人已先动
          cur.abort.abort()
          if (cur.cloneProc && !cur.cloneProc.killed) {
            try {
              cur.cloneProc.kill('SIGTERM')
            } catch {
              /* */
            }
          }
          const newState: RepoState = {
            selectionVersion: frame.selectionVersion,
            owner: frame.owner,
            repo: frame.repo,
            branch: frame.branch,
            status: 'cloning',
            workspaceDir: null,
            headSha: null,
            errorCode: null,
            errorMessage: null,
            abort: new AbortController(),
            cloneProc: null,
          }
          this.states.set(frame.sessionId, newState)
          return newState
        })
        if (!fresh) return
        sendStatus({
          type: 'outbound.control.session_repo_status',
          sessionId: frame.sessionId,
          selectionVersion: frame.selectionVersion,
          status: 'cloning',
        })
        this.runClone(frame, fresh, sendStatus).catch((err) => {
          this.log.error('repo_workspace_clone_uncaught', {
            sessionId: frame.sessionId,
            version: frame.selectionVersion,
            err: err instanceof Error ? err.message : String(err),
          })
        })
        return
      }

      // (b) 锁外 writeTokenFile(可能写到 unbind 之后,后置兜底删孤儿)
      // Codex Phase 5 review P1:writeTokenFile 失败必须转 failed status,
      // 否则 bind() reject → 用户 UI 一直停在 cloning,真因被 swallowed。
      try {
        await this.writeTokenFile(frame.sessionId, frame.selectionVersion, frame.accessToken)
      } catch (err) {
        await this.commitMaybeFailed(
          frame,
          decision.existing,
          'token_write_failed',
          (err as Error)?.message || 'failed to write git credentials',
          sendStatus,
        )
        return
      }

      // (c) 短锁:确认仍 current + 写 headSha
      const committed = await this.withSessionLock<boolean>(frame.sessionId, async () => {
        const cur = this.states.get(frame.sessionId)
        if (cur !== decision.existing) return false
        if (cur.status !== 'ready') return false
        if (cur.selectionVersion !== frame.selectionVersion) return false
        cur.headSha = ok.headSha
        return true
      })

      if (!committed) {
        // 被 unbind / 新 PUT 抢先 → 清掉刚写的 token 孤儿(精确 version 目录,不删 sessionId 级)
        const orphanCredDir = path.join(CREDS_ROOT, frame.sessionId, String(frame.selectionVersion))
        await rm(orphanCredDir, { recursive: true, force: true }).catch(() => {})
        return
      }

      // (d) 锁外 sendStatus
      sendStatus({
        type: 'outbound.control.session_repo_status',
        sessionId: frame.sessionId,
        selectionVersion: frame.selectionVersion,
        status: 'ready',
        workspaceDir: decision.workspaceDir,
        headSha: ok.headSha,
      })
      return
    }

    // ── hydrate-from-disk 路径 ──
    if (decision.kind === 'hydrate-from-disk') {
      const ok = await this.validateWorkspace(decision.workspaceDir)
      if (ok) {
        // 重建 state + token file(token 可能因为容器重启已丢)
        // Codex Phase 5 review P1:hydrate-from-disk 路径写 token 失败也要发 failed status。
        try {
          await this.writeTokenFile(frame.sessionId, frame.selectionVersion, frame.accessToken)
        } catch (err) {
          await this.commitHydrateFromDiskFailed(
            frame,
            decision.placeholderState,
            'token_write_failed',
            (err as Error)?.message || 'failed to write git credentials',
            sendStatus,
          )
          return
        }
        // 短锁 commit:identity-equality 检查 placeholder 仍持有(没被 unbind 删 /
        // 没被新 PUT 覆盖)。Codex Phase 5 final review:不再用 selectionVersion 比较,
        // 因为 unbind 删 state 后 cur===undefined 会被旧逻辑当作 "可以 set" 而复活
        // 已被 tombstone 的 state。
        const committed = await this.withSessionLock<boolean>(frame.sessionId, async () => {
          const cur = this.states.get(frame.sessionId)
          if (cur !== decision.placeholderState) return false
          cur.status = 'ready'
          cur.workspaceDir = decision.workspaceDir
          cur.headSha = ok.headSha
          return true
        })
        if (!committed) {
          const orphanCredDir = path.join(
            CREDS_ROOT,
            frame.sessionId,
            String(frame.selectionVersion),
          )
          await rm(orphanCredDir, { recursive: true, force: true }).catch(() => {})
          return
        }
        sendStatus({
          type: 'outbound.control.session_repo_status',
          sessionId: frame.sessionId,
          selectionVersion: frame.selectionVersion,
          status: 'ready',
          workspaceDir: decision.workspaceDir,
          headSha: ok.headSha,
        })
        return
      }
      // hydrate-from-disk 验证失败 → 复用 placeholder 转 cloning(identity check
      // 兜住 unbind / 新 PUT 抢先)。Codex Phase 5 final review:旧逻辑 cur===undefined
      // 才 set,会让 unbind 后的 fresh fallback 复活已 tombstone 的 state。
      const fresh = await this.withSessionLock<RepoState | null>(frame.sessionId, async () => {
        const cur = this.states.get(frame.sessionId)
        if (cur !== decision.placeholderState) return null
        cur.status = 'cloning'
        cur.abort = new AbortController() // 给 clone 阶段一个新 signal
        return cur
      })
      if (!fresh) return
      sendStatus({
        type: 'outbound.control.session_repo_status',
        sessionId: frame.sessionId,
        selectionVersion: frame.selectionVersion,
        status: 'cloning',
      })
      this.runClone(frame, fresh, sendStatus).catch((err) => {
        this.log.error('repo_workspace_clone_uncaught', {
          sessionId: frame.sessionId,
          version: frame.selectionVersion,
          err: err instanceof Error ? err.message : String(err),
        })
      })
      return
    }

    // ── fresh 路径 ──
    sendStatus({
      type: 'outbound.control.session_repo_status',
      sessionId: frame.sessionId,
      selectionVersion: frame.selectionVersion,
      status: 'cloning',
    })
    this.runClone(frame, decision.newState, sendStatus).catch((err) => {
      this.log.error('repo_workspace_clone_uncaught', {
        sessionId: frame.sessionId,
        version: frame.selectionVersion,
        err: err instanceof Error ? err.message : String(err),
      })
    })
  }

  /**
   * Unbind:取消 in-flight clone + 删 workspace 目录 + 删 token dir(best-effort)。
   *
   * Phase 5 版本化 unbind:state.selectionVersion > selectionVersion 时,本帧是
   * "tombstone-too-old"(新 PUT 已先于本帧到达),不删,只 log。
   *
   * 返回 boolean:**true = 真正删了 state,caller 应 recycle runner**;
   *               false = 跳过(不存在 / stale tombstone),caller **不要 recycle**。
   */
  async unbind(sessionId: string, selectionVersion: number): Promise<boolean> {
    if (!SESSION_ID_RE.test(sessionId)) return false

    // 短锁:版本判断 + abort + state.delete
    // 返 true 仅当真正 delete 了 state(state 存在且非 stale)。
    const deleted = await this.withSessionLock<boolean>(sessionId, async () => {
      const s = this.states.get(sessionId)
      if (!s) return false // 没有 state 可删 — caller 不应 recycle(本来就没绑)
      if (s.selectionVersion > selectionVersion) {
        this.log.info('repo_workspace_unbind_tombstone_ignored', {
          sessionId,
          stateVer: s.selectionVersion,
          tombstoneVer: selectionVersion,
        })
        return false
      }
      s.abort.abort()
      if (s.cloneProc && !s.cloneProc.killed) {
        try {
          s.cloneProc.kill('SIGTERM')
        } catch {
          /* */
        }
      }
      this.states.delete(sessionId)
      return true
    })
    if (!deleted) return false

    // 锁外清理:**只删 <= tombstone selectionVersion 的 version 子目录**,再用
    // rmdir(空目录才删)兜底。Codex Phase 5 v2 review P0:
    // 不能 rm -rf 整个 sessionId 子树,因为新版本 bind v2 可能在 unbind v1 释放锁之后
    // 已经进锁、写了 git-creds/<sessionId>/2/token。如果这里 rm 整个 git-creds/<sessionId>,
    // v2 token 会被旧 unbind 误删,askpass 读 token 失败 → clone 401。
    await Promise.all([
      this.cleanupVersionsThrough(REPOS_ROOT, sessionId, selectionVersion),
      this.cleanupVersionsThrough(CREDS_ROOT, sessionId, selectionVersion),
    ])
    return true
  }

  /**
   * Phase 5 v2:删 root/sessionId/ 下所有 numeric-name <= maxVersion 的子目录,
   * 再 rmdir 父空目录(只在为空时成功,保护并发 bind 写入的高版本目录)。
   * 非数字名称的目录(eg 残留 tmp / 未来扩展)不删 — 不在清理 contract 内。
   */
  private async cleanupVersionsThrough(
    root: string,
    sessionId: string,
    maxVersion: number,
  ): Promise<void> {
    const sessionRoot = path.join(root, sessionId)
    let entries: string[]
    try {
      entries = await readdir(sessionRoot)
    } catch {
      return
    }
    await Promise.all(
      entries.map(async (name) => {
        const n = Number(name)
        if (!Number.isSafeInteger(n) || n > maxVersion) return
        await rm(path.join(sessionRoot, name), { recursive: true, force: true }).catch(() => {})
      }),
    )
    // rmdir 只在目录为空时成功 — 高版本子目录还在的话保留,留给后续 unbind / bind 处理
    await rmdir(sessionRoot).catch(() => {})
  }

  /** 容器关闭时调用,best-effort 清理。 */
  async shutdown(): Promise<void> {
    for (const s of this.states.values()) {
      s.abort.abort()
      if (s.cloneProc && !s.cloneProc.killed) {
        try {
          s.cloneProc.kill('SIGTERM')
        } catch {
          /* */
        }
      }
    }
    this.states.clear()
    this.opLocks.clear()
  }

  // ---------- 内部 ----------

  /**
   * Phase 5 异步锁:每 sessionId 一把,串行化所有状态读写。
   * runAfter = prev.catch(() => {}) 吸收上轮 reject,防 chain 毒化。
   * Map 里存的 next 一定 resolve(finally 必 release)。
   */
  private async withSessionLock<T>(sessionId: string, op: () => Promise<T>): Promise<T> {
    const prev = this.opLocks.get(sessionId) ?? Promise.resolve()
    const runAfter = prev.catch(() => {})
    let release!: () => void
    const next = new Promise<void>((r) => {
      release = r
    })
    this.opLocks.set(sessionId, next)
    try {
      await runAfter
      return await op()
    } finally {
      release()
      // GC:只删自己刚 set 进去的那条,避免删走后来者
      if (this.opLocks.get(sessionId) === next) this.opLocks.delete(sessionId)
    }
  }

  /**
   * Codex Phase 5 review P1 helper:maybe-hydrate 路径 writeTokenFile 失败时,
   * 把 existing state(此刻是 ready)转为 failed 并发 status,而不是抛到 caller。
   * existing 已被新 PUT 替换 / unbind 时静默(committed=false)。
   */
  private async commitMaybeFailed(
    frame: SessionRepoBindFrame,
    existing: RepoState,
    errorCode: string,
    errorMessage: string,
    sendStatus: (s: SessionRepoStatusOut) => void,
  ): Promise<void> {
    const committed = await this.withSessionLock<boolean>(frame.sessionId, async () => {
      const cur = this.states.get(frame.sessionId)
      if (cur !== existing) return false
      cur.status = 'failed'
      cur.errorCode = errorCode
      cur.errorMessage = errorMessage
      return true
    })
    if (committed) {
      sendStatus({
        type: 'outbound.control.session_repo_status',
        sessionId: frame.sessionId,
        selectionVersion: frame.selectionVersion,
        status: 'failed',
        errorCode,
        errorMessage,
      })
    }
  }

  /**
   * hydrate-from-disk 路径 writeTokenFile 失败:把 placeholder 转 failed,发 failed
   * status。Codex Phase 5 final review:placeholder 已落 state map,不能再"不写 state",
   * 否则 placeholder 会一直挂在那里(被新 bind 当作 cloning/pending 占位 → noop)。
   * identity check 兜住 unbind 已先到的情况(此时不发 failed status,避免 UI 与
   * unbind 后端口推送冲突)。
   */
  private async commitHydrateFromDiskFailed(
    frame: SessionRepoBindFrame,
    placeholderState: RepoState,
    errorCode: string,
    errorMessage: string,
    sendStatus: (s: SessionRepoStatusOut) => void,
  ): Promise<void> {
    const stillOurs = await this.withSessionLock<boolean>(frame.sessionId, async () => {
      const cur = this.states.get(frame.sessionId)
      if (cur !== placeholderState) return false
      cur.status = 'failed'
      cur.errorCode = errorCode
      cur.errorMessage = errorMessage
      return true
    })
    if (!stillOurs) return
    sendStatus({
      type: 'outbound.control.session_repo_status',
      sessionId: frame.sessionId,
      selectionVersion: frame.selectionVersion,
      status: 'failed',
      errorCode,
      errorMessage,
    })
  }

  /** state 还活着 + 同 version + 未 abort?Phase 4 plan v3 修 #4。 */
  private aliveAndCurrent(
    sessionId: string,
    myVersion: number,
    abort: AbortController,
  ): boolean {
    if (abort.signal.aborted) return false
    const s = this.states.get(sessionId)
    return s !== undefined && s.selectionVersion === myVersion
  }

  private async writeTokenFile(
    sessionId: string,
    version: number,
    token: string,
  ): Promise<string> {
    const dir = path.join(CREDS_ROOT, sessionId, String(version))
    await mkdir(dir, { recursive: true, mode: 0o700 })
    // 父目录 chmod 700(mkdir 在多级时不一定按预期设置,显式 chmod)
    await chmod(path.join(CREDS_ROOT, sessionId), 0o700).catch(() => {})
    await chmod(dir, 0o700).catch(() => {})
    const tokenPath = path.join(dir, 'token')
    await writeFile(tokenPath, token, { mode: 0o600 })
    await chmod(tokenPath, 0o600).catch(() => {})
    return tokenPath
  }

  /** 验证 workspaceDir 是有效 git repo;返回 HEAD sha 或 null。 */
  private async validateWorkspace(
    workspaceDir: string,
  ): Promise<{ headSha: string } | null> {
    try {
      const st = await stat(path.join(workspaceDir, '.git'))
      if (!st.isDirectory()) return null
    } catch {
      return null
    }
    return new Promise((resolve) => {
      const proc = spawn('git', ['-C', workspaceDir, 'rev-parse', 'HEAD'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      let out = ''
      proc.stdout.on('data', (b) => {
        out += b.toString('utf8')
      })
      proc.on('close', (code) => {
        if (code === 0) {
          const sha = out.trim()
          if (/^[0-9a-f]{40}$/.test(sha)) resolve({ headSha: sha })
          else resolve(null)
        } else resolve(null)
      })
      proc.on('error', () => resolve(null))
    })
  }

  /**
   * 真正干活的 clone 流程(异步,锁外)。每个步骤前都做 aliveAndCurrent 检查。
   * 写终态(ready / failed)前用短锁 commit + aliveAndCurrent 双校验。
   *
   * 不变量:本流程不 GC 旧版本目录。clone/rename 阶段不会动旧 version 目录,让仍在
   * 跑的 CCB 进程仍能 cwd 在旧 dir 工作。旧版本目录只在 unbind 时由
   * cleanupVersionsThrough(maxVersion = tombstone selectionVersion)精确清理 —
   * 严格 <= tombstone 的 numeric subdir,避免与并发新 bind(更高版本号)抢 rm。
   */
  private async runClone(
    frame: SessionRepoBindFrame,
    state: RepoState,
    sendStatus: (s: SessionRepoStatusOut) => void,
  ): Promise<void> {
    const { sessionId, selectionVersion, owner, repo, branch, accessToken } = frame

    // 检查 1:开 work 之前
    if (!this.aliveAndCurrent(sessionId, selectionVersion, state.abort)) return

    let tmpRepoDir: string | null = null
    let askpassPath: string | null = null
    let tokenPath: string | null = null

    try {
      // 写 token file(给 askpass + git config 后续都引用同一 path)
      tokenPath = await this.writeTokenFile(sessionId, selectionVersion, accessToken)

      // askpass 脚本(clone 阶段用,clone 完成后删除)
      const askpassDir = await mkdtemp(path.join(tmpdir(), 'oc-askpass-'))
      askpassPath = path.join(askpassDir, 'askpass.sh')
      const askpassContent = `#!/bin/sh
case "$1" in
  *Username*) echo x-access-token ;;
  *Password*) cat ${shellSingleQuote(tokenPath)} ;;
esac
`
      await writeFile(askpassPath, askpassContent, { mode: 0o700 })
      await chmod(askpassPath, 0o700)

      // 临时 clone 目录
      tmpRepoDir = await mkdtemp(path.join(tmpdir(), 'oc-clone-'))

      // 检查 2:spawn 之前
      if (!this.aliveAndCurrent(sessionId, selectionVersion, state.abort)) return

      const repoUrl = `https://github.com/${owner}/${repo}.git`
      const cloneArgs = [
        'clone',
        '--depth=50',
        '--single-branch',
        '--branch',
        branch,
        repoUrl,
        tmpRepoDir,
      ]

      await new Promise<void>((resolve, reject) => {
        const proc = spawn('git', cloneArgs, {
          env: {
            ...process.env,
            GIT_ASKPASS: askpassPath!,
            GIT_TERMINAL_PROMPT: '0',
            // 避免 git 走系统级 credential helper(可能弹 keyring/osx keychain),
            GIT_CONFIG_NOSYSTEM: '1',
            HOME: '/home/agent', // 防 fallback 到无效 HOME
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        state.cloneProc = proc
        let stderr = ''
        proc.stderr.on('data', (b) => {
          stderr += b.toString('utf8')
        })
        proc.stdout.on('data', () => {
          /* discard */
        })
        proc.on('close', (code) => {
          state.cloneProc = null
          if (state.abort.signal.aborted) {
            reject(new Error('aborted'))
          } else if (code === 0) {
            resolve()
          } else {
            // stderr 不打印 token(token 不在 argv/url),但可能含 repo url
            const errMsg = stderr.split('\n').slice(-5).join('\n').slice(0, 500)
            const isAuthErr = /Authentication failed|could not read Username|Invalid username|401/i.test(stderr)
            const err = new Error(isAuthErr ? 'token_invalid' : `git_clone_failed: ${errMsg}`)
            ;(err as Error & { authErr?: boolean }).authErr = isAuthErr
            reject(err)
          }
        })
        proc.on('error', (err) => {
          state.cloneProc = null
          reject(err)
        })
      })

      // 检查 3:clone 完之后,读 HEAD 之前
      if (!this.aliveAndCurrent(sessionId, selectionVersion, state.abort)) return

      // 读 HEAD sha
      const headSha = await new Promise<string>((resolve, reject) => {
        const proc = spawn('git', ['-C', tmpRepoDir!, 'rev-parse', 'HEAD'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let out = ''
        proc.stdout.on('data', (b) => {
          out += b.toString('utf8')
        })
        proc.on('close', (code) => {
          if (code === 0) {
            const sha = out.trim()
            if (/^[0-9a-f]{40}$/.test(sha)) resolve(sha)
            else reject(new Error('invalid_head_sha'))
          } else reject(new Error('rev_parse_failed'))
        })
        proc.on('error', reject)
      })

      // 配置 credential helper(把绝对 token path 写进去,后续 push/fetch 用)
      // helper 命令是 git 在执行时由 sh -c 解析,token path 单引号 quote。
      const helperCmd = `!f(){ echo username=x-access-token; echo password=$(cat ${shellSingleQuote(tokenPath)}); };f`
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('git', ['-C', tmpRepoDir!, 'config', 'credential.helper', helperCmd], {
          stdio: 'ignore',
        })
        proc.on('close', (code) =>
          code === 0 ? resolve() : reject(new Error('git_config_failed')),
        )
        proc.on('error', reject)
      })
      // remote.origin.url 设为不带 token 的 plain URL(clone 已成功,无需 url 内嵌 token)
      // clone 默认就是 plain url(我们 args 没塞 token);这里再 explicit set 一次防万一
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('git', ['-C', tmpRepoDir!, 'config', 'remote.origin.url', repoUrl], {
          stdio: 'ignore',
        })
        proc.on('close', (code) =>
          code === 0 ? resolve() : reject(new Error('git_config_url_failed')),
        )
        proc.on('error', reject)
      })

      // 检查 4:rename 之前
      if (!this.aliveAndCurrent(sessionId, selectionVersion, state.abort)) return

      // mkdir 父目录,删旧 version 同名 dir(if any),原子 rename
      const finalDir = path.join(REPOS_ROOT, sessionId, String(selectionVersion))
      const sessionRepoRoot = path.join(REPOS_ROOT, sessionId)
      await mkdir(sessionRepoRoot, { recursive: true })
      // 同名 finalDir 通常不存在(version 单调递增);若残留(进程崩 + 重 bind),先删
      await rm(finalDir, { recursive: true, force: true }).catch(() => {})
      await rename(tmpRepoDir, finalDir)
      tmpRepoDir = null // ownership 转交,finally 不再删

      // 注:故意 NOT eager-GC 旧 version 目录。Codex Phase 5 review P0:
      // 在 ready commit + recycle shutdown 之前删旧 dir 会让旧 runner(此刻可能正
      // 在跑 git push/fetch)的 cwd 文件突然消失。旧版本目录的清理推迟到 unbind 路径,
      // 由 cleanupVersionsThrough(<= tombstone selectionVersion)精确删除(避免和
      // 并发新 bind 的更高版本目录抢 rm)。短期磁盘累积有限(单 user × 切换次数有限)。

      // 检查 5 + commit:短锁 + aliveAndCurrent 双校验,写 ready 终态
      const committed = await this.withSessionLock<boolean>(sessionId, async () => {
        if (!this.aliveAndCurrent(sessionId, selectionVersion, state.abort)) return false
        state.status = 'ready'
        state.workspaceDir = finalDir
        state.headSha = headSha
        return true
      })

      if (!committed) {
        // 已被新 version 抢占 / unbind → 我们的 finalDir 现在是孤儿,新 version 的 GC 会清。
        // 不发 status。
        return
      }

      sendStatus({
        type: 'outbound.control.session_repo_status',
        sessionId,
        selectionVersion,
        status: 'ready',
        workspaceDir: finalDir,
        headSha,
      })
      this.log.info('repo_workspace_ready', { sessionId, version: selectionVersion, headSha })
    } catch (err) {
      // 失败路径:删 tmpRepoDir(if 还在),短锁 commit failed(若仍 current)
      if (state.abort.signal.aborted) {
        // 静默(被新 version 替换或 unbind)
        this.log.info('repo_workspace_aborted', { sessionId, version: selectionVersion })
        return
      }
      const e = err as Error & { authErr?: boolean }
      const isAuthErr = e.message === 'token_invalid' || e.authErr === true
      const errorCode = isAuthErr ? 'token_invalid' : 'clone_failed'
      const errorMessage = isAuthErr ? 'GitHub token rejected by remote' : (e.message || 'clone failed')

      const committed = await this.withSessionLock<boolean>(sessionId, async () => {
        if (!this.aliveAndCurrent(sessionId, selectionVersion, state.abort)) return false
        state.status = 'failed'
        state.errorCode = errorCode
        state.errorMessage = errorMessage
        return true
      })

      if (committed) {
        sendStatus({
          type: 'outbound.control.session_repo_status',
          sessionId,
          selectionVersion,
          status: 'failed',
          errorCode,
          errorMessage,
        })
        this.log.warn('repo_workspace_clone_failed', {
          sessionId,
          version: selectionVersion,
          err: e.message,
        })
      }
    } finally {
      // 清 askpass(无论成败,clone 已结束就该删)
      if (askpassPath) {
        await rm(path.dirname(askpassPath), { recursive: true, force: true }).catch(() => {})
      }
      if (tmpRepoDir) {
        await rm(tmpRepoDir, { recursive: true, force: true }).catch(() => {})
      }
    }
  }

}

/** shell 单引号 quote。path 已被 SESSION_ID_RE 校验,不含单引号,但兜底转义。 */
function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

// 避免 unused import warning(readFile 用于将来 token 加载,如有需要)
void readFile
