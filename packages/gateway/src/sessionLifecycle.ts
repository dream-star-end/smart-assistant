import { withFreshPromptPrivacy } from './promptPrivacyRuntime.js'
import { type PreheatPreparation, reserveUnusedPreheat, armUnusedPreheat, consumeUnusedPreheat, clearUnusedPreheats } from './speculativePreheat.js'
/**
 * Session runner lifecycle: preheat, repo-change recycle, eviction loop, shutdown/destroy, idle drain, execution target and model switch
 *
 * Moved verbatim out of SessionManager (sessionManager.ts) — FINDINGS §7.6, OCV5-480. The class
 * keeps one-line forwarders that call these with the instance as `this`, so behaviour, closures and
 * `this.x` reads/writes are unchanged. SessionLifecycleHost lists exactly the SessionManager members this code
 * touches (typed from the class itself).
 */
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from '@openclaude/storage'
import {
  abandonAllIdle,
  consumeIdleReset,
  currentIdleSource,
  pruneIdleOps,
  readIdleReset,
  IdleCompactRejected,
} from './boxIdleCompact.js'
import { decideEngineCwd } from './engineCwd.js'
import { type ExecutionTarget, RemoteTargetUnavailableError } from './remoteTarget.js'
import type { RepoSnapshot } from './sessionRepoWorkspace.js'
import { log } from './sessionManagerLog.js'
import { isTempSessionKey, resolveEnginePreheatDeadlineMs } from './sessionManager.js'
import type { SessionManager, AgentSession, PreheatOutcome } from './sessionManager.js'

export interface SessionLifecycleHost {
  _flushTailFolding: SessionManager['_flushTailFolding']
  _getRepoSnapshot: SessionManager['_getRepoSnapshot']
  _preheatActive: SessionManager['_preheatActive']
  _preheatInFlight: SessionManager['_preheatInFlight']
  _promptQueueHolds: SessionManager['_promptQueueHolds']
  _pruneResumeMap: SessionManager['_pruneResumeMap']
  _remoteTargetController: SessionManager['_remoteTargetController']
  _resumeMap: SessionManager['_resumeMap']
  _resumeMapCostImprecise: SessionManager['_resumeMapCostImprecise']
  _resumeMapHistory: SessionManager['_resumeMapHistory']
  _resumeMapLastCost: SessionManager['_resumeMapLastCost']
  _resumeMapProvider: SessionManager['_resumeMapProvider']
  _resumeMapTimestamps: SessionManager['_resumeMapTimestamps']
  _resumeMapWrite: SessionManager['_resumeMapWrite']
  _runtimeRecycleDrainTimer: SessionManager['_runtimeRecycleDrainTimer']
  _runtimeRecycleDrainUntil: SessionManager['_runtimeRecycleDrainUntil']
  _saveResumeMap: SessionManager['_saveResumeMap']
  _sessionIdToKey: SessionManager['_sessionIdToKey']
  awaitPendingPersistence: SessionManager['awaitPendingPersistence']
  finishIdleUnderLock: SessionManager['finishIdleUnderLock']
  markPlannedServiceRestart: SessionManager['markPlannedServiceRestart']
  maxIdleMsChat: SessionManager['maxIdleMsChat']
  maxIdleMsCron: SessionManager['maxIdleMsCron']
  onSessionDestroyed: SessionManager['onSessionDestroyed']
  releaseRuntimeRecycleDrain: SessionManager['releaseRuntimeRecycleDrain']
  scheduleIdleDrain: SessionManager['scheduleIdleDrain']
  sessions: SessionManager['sessions']
  submit: SessionManager['submit']
}

/** Background idle drain re-arms while proof stays pending (egress settling). */
const IDLE_DRAIN_RETRIES = 6

const IDLE_DRAIN_RETRY_MS = 30_000

const NATIVE_MODEL_HANDOFF_MAX_CHARS = 256_000

const NATIVE_MODEL_SWITCH_TTL_MS = 30 * 60_000

const PREHEAT_DEADLINE_CODE = 'PREHEAT_DEADLINE'

function withPreheatDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`engine preheat exceeded ${ms}ms deadline`)
      ;(err as Error & { code: string }).code = PREHEAT_DEADLINE_CODE
      reject(err)
    }, ms)
    timer.unref?.()
  })
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function isPreheatDeadline(err: unknown): boolean {
  return Boolean(
    err && typeof err === 'object' && (err as { code?: string }).code === PREHEAT_DEADLINE_CODE,
  )
}

export async function preheatRunner(
  this: SessionLifecycleHost,
  session: AgentSession,
  preparation?: PreheatPreparation,
): Promise<PreheatOutcome> {
  if (session._plannedTeardown || session._replacing) return 'skipped_teardown'
  const runner = session.runner
  if (typeof runner.preheat !== 'function') return 'skipped_engine'
  if (runner.isRunning) return 'already_running'
  if (
    (session._activeTurnCount ?? 0) > 0 ||
    (session._idleInternalTurns ?? 0) > 0 ||
    this._promptQueueHolds(session)
  ) {
    return 'skipped_busy'
  }
  const existing = this._preheatInFlight.get(session.sessionKey)
  if (existing) return existing
  if (this._preheatActive >= 1) return 'skipped_cap'
  const reservation = reserveUnusedPreheat(this, session)
  if (reservation !== 'reserved') return reservation
  this._preheatActive += 1
  let preserveUnused = false
  const startedAt = Date.now()
  // `run` never rejects: concurrent callers share this promise via the map,
  // and a rejected shared promise would escape the first caller's handling.
  const run = (async (): Promise<PreheatOutcome> => {
    const prev = session.lock
    let release: () => void = () => {}
    session.lock = new Promise<void>((r) => (release = r))
    try {
      await prev
      // Re-check under the lock: a turn/teardown may have landed meanwhile.
      if (session._plannedTeardown || session._replacing) return 'skipped_teardown'
      if (session.runner.isRunning) return 'already_running'
      if (
        (session._activeTurnCount ?? 0) > 0 ||
        (session._idleInternalTurns ?? 0) > 0 ||
        this._promptQueueHolds(session)
      ) {
        return 'skipped_busy'
      }
      if (preparation) {
        const configurable = session.runner as typeof session.runner & {
          effortLevel?: string
          setCodexRoute?: (route: PreheatPreparation['codexRoute']) => void
        }
        if (configurable.engineId !== 'codex' || configurable.model !== preparation.model ||
          ('effortLevel' in preparation && configurable.effortLevel !== preparation.effortLevel) ||
          typeof configurable.setCodexRoute !== 'function') return 'skipped_busy'
        configurable.setCodexRoute(preparation.codexRoute)
      }
      const deadlineMs = resolveEnginePreheatDeadlineMs()
      try {
        await withFreshPromptPrivacy(session.runner, session.peerId, () => withPreheatDeadline(session.runner.preheat!(), deadlineMs))
      } catch (err) {
        if (!isPreheatDeadline(err)) throw err
        log.warn('engine_preheat', {
          sessionKey: session.sessionKey,
          engine: runner.engineId,
          outcome: 'timed_out',
          spawn_ms: Date.now() - startedAt,
          deadline_ms: deadlineMs,
          err: String(err),
        })
        try {
          await session.runner.shutdown()
        } catch (shutdownErr) {
          preserveUnused = true
          log.warn(
            'engine_preheat shutdown after deadline failed',
            {
              sessionKey: session.sessionKey,
            },
            shutdownErr,
          )
        }
        return 'failed'
      }
      session.lastUsedAt = Date.now()
      armUnusedPreheat(this, session)
      log.info('engine_preheat', {
        sessionKey: session.sessionKey,
        engine: runner.engineId,
        outcome: 'started',
        spawn_ms: Date.now() - startedAt,
      })
      return 'started'
    } catch (err) {
      log.warn('engine_preheat', {
        sessionKey: session.sessionKey,
        engine: runner.engineId,
        outcome: 'failed',
        spawn_ms: Date.now() - startedAt,
        err: String(err),
      })
      if ((session._activeTurnCount ?? 0) === 0) {
        await session.runner.shutdown().catch(() => { preserveUnused = true })
      } else preserveUnused = true
      return 'failed'
    } finally {
      release()
    }
  })()
  this._preheatInFlight.set(session.sessionKey, run)
  try {
    const result = await run
    if (result !== 'started') {
      if (preserveUnused) armUnusedPreheat(this, session)
      else consumeUnusedPreheat(this, session)
    }
    return result
  } finally {
    this._preheatActive -= 1
    if (this._preheatInFlight.get(session.sessionKey) === run) {
      this._preheatInFlight.delete(session.sessionKey)
    }
  }
}

/**
 * Phase 5:repo selection 版本变化时 recycle 该 session 的 runner。
 * 决策表(配合 SubprocessRunner.getBoundRepoBinding):
 *   binding=null & snap=ready              → SHUTDOWN(让下次 spawn 拿 repo cwd)
 *   binding=null & snap=cloning|failed     → NOOP(addDir 始终 agentBaseDir)
 *   binding=v_x & snap=ready & x===snap.v  → NOOP
 *   binding=v_x & snap=ready & x!==snap.v  → SHUTDOWN
 *   binding=v_x & snap=cloning|failed      → NOOP(让 CCB 继续在旧 v_x dir 工作)
 *
 * lock 内进行,与 submit() 互斥。runner.shutdown 后下次 submit 自动 spawn,
 * 拿当时的 repo snapshot(getRepoSnapshot provider 取自 _repoWorkspace.states)。
 */
export async function recyclePeerForRepoChange(
  this: SessionLifecycleHost,
  sessionId: string,
  newSnapshot: RepoSnapshot | null,
): Promise<void> {
  const sessionKey = this._sessionIdToKey.get(sessionId)
  if (!sessionKey) return
  const session = this.sessions.get(sessionKey)
  if (!session) return

  // Phase 5 G.1:codex-native 哪怕 runner.isRunning=false 也不能短路 —
  //   CodexRunner 是 per-turn `codex exec`,turn 结束后子进程退出(isRunning=false),
  //   但 runner 仍保留 threadId、session 仍保留 ccbSessionId、_resumeMap*
  //   仍含上一轮 thread id;repo 变了下一轮 turn 必须重置否则 codex 会 attach
  //   到旧 repo 对应的 thread,污染 LLM 上下文(Plan v3 Codex Round 3 BLOCKER)。
  //   CCB(SubprocessRunner)是 long-running:!isRunning ⇒ 进程已死,
  //   下次 submit() 会读最新 snapshot 起一个新 spawn,无需重置任何 in-memory 状态。
  const isCodex = session.providerTag === 'codex'
  if (!session.runner.isRunning && !isCodex) {
    return // 没活进程且非 codex,下次 submit 会自然读最新 snapshot
  }

  const binding = session.runner.getBoundRepoBinding()
  let shouldRecycle = false
  if (newSnapshot === null) {
    // null 走 unbind 路径,不该到这里;safety only
    shouldRecycle = binding !== null
  } else if (newSnapshot.status === 'ready') {
    shouldRecycle = !binding || binding.selectionVersion !== newSnapshot.selectionVersion
  } else {
    // cloning / failed / pending → 让 runner 继续在旧 binding(若有)dir 工作
    shouldRecycle = false
  }

  if (!shouldRecycle) return

  log.info('recycle-for-repo-change triggered', {
    sessionKey: session.sessionKey,
    sessionId,
    providerTag: session.providerTag,
    isRunning: session.runner.isRunning,
    bindingVersion: binding?.selectionVersion ?? null,
    newSnapshotVersion:
      newSnapshot && newSnapshot.status === 'ready' ? newSnapshot.selectionVersion : null,
  })

  // 串行化 recycle:与 submit() 互斥,避免本 turn 中途被打断
  const prev = session.lock
  let release!: () => void
  session.lock = new Promise<void>((r) => (release = r))
  try {
    await prev
    // Phase 5 G.2:codex-native 必须在 shutdown 之前清掉所有 thread / resume 残留。
    //   原因:CodexRunner 即便 isRunning=false 也会保留 in-memory threadId,
    //   且 _saveResumeMap 会从 live session.ccbSessionId 反推回 _resumeMap —
    //   只清 _resumeMap 不够,必须同时清 session.ccbSessionId + 调 runner.clearSessionId
    //   再 _saveResumeMap()。setExecutionTarget 已经是这套模式(Codex Round 2 BLOCKER)。
    if (isCodex) {
      this._resumeMap.delete(sessionKey)
      this._resumeMapTimestamps.delete(sessionKey)
      this._resumeMapProvider.delete(sessionKey)
      this._resumeMapLastCost.delete(sessionKey)
      this._resumeMapCostImprecise.delete(sessionKey)
      this._resumeMapHistory.delete(sessionKey)
      session.ccbSessionId = null
      session.runner.clearSessionId?.()
      this._saveResumeMap()
    }
    // shutdown 只在子进程实际存活时调;codex per-turn 在 turn 间 isRunning=false
    // 是常态,这里不应再 shutdown(否则 stop() 会试图 kill 一个不存在的 pid 浪费日志)。
    if (session.runner.isRunning) {
      try {
        await session.runner.shutdown()
      } catch (err) {
        log.warn(
          'recycle-for-repo-change shutdown failed',
          { sessionKey: session.sessionKey, sessionId },
          err,
        )
      }
    }
  } finally {
    release()
  }
}

/**
 * Phase 5:repo unbind(用户 DELETE selection / link revoke)时 recycle 该 session。
 * 调用前 caller(server.ts _handleSessionRepoUnbind)必须先 _repoWorkspace.unbind
 * (短锁内删 states[sessionId]),保证排队 submit 启动时 getRepoSnapshot 返 null。
 * 总是无条件 shutdown(若 isRunning):因为 unbind 后 addDir 必须切回 agentBaseDir。
 */
export async function recyclePeerForRepoUnbind(
  this: SessionLifecycleHost,
  sessionId: string,
): Promise<void> {
  const sessionKey = this._sessionIdToKey.get(sessionId)
  if (!sessionKey) return
  const session = this.sessions.get(sessionKey)
  if (!session) return
  if (!session.runner.isRunning) return

  const prev = session.lock
  let release!: () => void
  session.lock = new Promise<void>((r) => (release = r))
  try {
    await prev
    try {
      await session.runner.shutdown()
    } catch (err) {
      log.warn(
        'recycle-for-repo-unbind shutdown failed',
        { sessionKey: session.sessionKey, sessionId },
        err,
      )
    }
  } finally {
    release()
  }
}

// 周期性 LRU 驱逐 — webchat sessions survive much longer than cron/task sessions
export function startEvictionLoop(this: SessionLifecycleHost, intervalMs = 60_000): () => void {
  // 2026-04-22 Codex R1 N11:LRU 驱逐此前 fire-and-forget 调 runner.shutdown() 然后
  // 立刻 `sessions.delete(key)` + `onSessionDestroyed(key)` 清 ring。问题是 shutdown
  // 内部有 SIGTERM → 1s 等待 → SIGKILL 的异步链,在这期间 runner 仍可能从 stdout
  // 读到残余字节并推给 server(通过 onFrame callback),而此刻 server 的 outboundRing
  // 已被 onSessionDestroyed 清空 —— 这些尾帧会落到一个空 ring 上,下次 reconnect
  // replay 时丢掉(数据不一致且无 warning)。
  //
  // 修复:await 每个 runner.shutdown() 完成后才 delete + onSessionDestroyed。
  // 用 async IIFE 不阻塞 interval 队列(每轮 eviction 独立跑,上一轮若卡住不影响下一轮)。
  let _inFlight = false
  const t = setInterval(() => {
    if (_inFlight) return // 防并行:shutdown 链慢 → 跳过本轮,下一轮再扫
    _inFlight = true
    ;(async () => {
      try {
        const now = Date.now()
        const toEvict: string[] = []
        for (const [key, s] of this.sessions) {
          const isTempSession = isTempSessionKey(key)
          const maxIdle = isTempSession ? this.maxIdleMsCron : this.maxIdleMsChat
          const lastActive = Math.max(s.lastUsedAt, s.runner.lastActivityAt)
          if (now - lastActive > maxIdle) {
            toEvict.push(key)
          }
        }
        for (const key of toEvict) {
          const s = this.sessions.get(key)
          if (!s) continue
          // 先 await shutdown 完成(SIGTERM+SIGKILL 链走完),再清状态
          try {
            this.markPlannedServiceRestart(s)
            await s.runner.shutdown()
          } catch {}
          // A1:底座已停产出,flush 折叠 tail 的 pending 并清定时器/状态。
          await this._flushTailFolding(s)
          // 释放 remote mux refcount(若为 remote)—— 与 destroySession 语义一致
          if (s.executionTarget.kind === 'remote' && s.userId) {
            await this._remoteTargetController
              ?.releaseMux(key, s.userId, s.executionTarget.hostId)
              .catch((err) => log.warn('evict releaseMux failed', { key, err: String(err) }))
          }
          this.sessions.delete(key)
          // Phase 5:同步清 peer→sessionKey 反查索引(避免悬挂条目)。
          this._sessionIdToKey.delete(s.peerId)
          if (!key.includes(':webchat:')) {
            this._resumeMap.delete(key)
            this._resumeMapTimestamps.delete(key)
            this._resumeMapLastCost.delete(key)
            this._resumeMapCostImprecise.delete(key)
            this._resumeMapProvider.delete(key)
            this._resumeMapHistory.delete(key)
          }
          // Medium#G1 + N11:shutdown 完才清 ring,保证不会有"runner 已死但 ring 还能
          // 接尾帧"的窗口。webchat 虽然 resume-map 留着等 reconnect,但 outboundRing
          // 没必要留(重连时会重走 hello,server 按 lastFrameSeq=0 重建)。
          try {
            this.onSessionDestroyed?.(key)
          } catch {}
        }
        if (toEvict.length > 0) this._saveResumeMap()
        this._pruneResumeMap()
      } finally {
        _inFlight = false
      }
    })()
  }, intervalMs)
  return () => clearInterval(t)
}

export async function shutdownAll(this: SessionLifecycleHost): Promise<void> {
  clearUnusedPreheats(this)
  // Persist resume map BEFORE killing subprocesses — ensures state survives restart
  // (runner.shutdown() sets shuttingDown=true so the exit handler won't call _saveResumeMap)
  this._saveResumeMap()
  await this._resumeMapWrite
  // Medium#G1:shutdown 前先把所有 live sessionKey 通知一次 ring 清理,防止
  // 进程退出前最后一刻的 WS 重连拿到下一轮无主的 frame。
  const keysToClear = [...this.sessions.keys()]
  // 收集所有 remote session 的 mux 句柄,用于 shutdown 后统一 release,
  // 避免 mux 泄漏跨进程(systemd 重启 tmpfs 清干净是最后兜底,但 release
  // 在自 process 内做,是正路)。
  const muxReleases: Array<() => Promise<void>> = []
  for (const s of this.sessions.values()) {
    if (s.executionTarget.kind === 'remote' && s.userId) {
      const uid = s.userId
      const key = s.sessionKey
      const hostId = s.executionTarget.hostId
      muxReleases.push(
        () =>
          this._remoteTargetController?.releaseMux(key, uid, hostId).catch(() => {}) ??
          Promise.resolve(),
      )
    }
  }
  await Promise.all(
    [...this.sessions.values()].map((s) => {
      this.markPlannedServiceRestart(s)
      return s.runner.shutdown()
    }),
  )
  await Promise.all(muxReleases.map((fn) => fn()))
  // A1:底座已全部停产出,flush 各 session 折叠 tail 的 pending(其持久化随后被
  // awaitPendingPersistence 一并排空)。
  await Promise.all([...this.sessions.values()].map((s) => this._flushTailFolding(s)))
  // Drain server-authored persistence promises (turn-end fan-outs +
  // handleExit setTimeout-150ms partial flushes registered while the
  // runners were being torn down). Must complete before server.ts
  // clears the v3 sink singleton, otherwise late writes fall through
  // to the legacy local SQLite path that's permanently empty in v3.
  await this.awaitPendingPersistence()
  this.sessions.clear()
  // Phase 5:整体清空时同步清反查索引。
  this._sessionIdToKey.clear()
  for (const k of keysToClear) {
    try {
      this.onSessionDestroyed?.(k)
    } catch {}
  }
}

/** Destroy a single session: kill subprocess + remove from map + clear resume mapping.
 *  Also clears resume-map even if the session was already evicted from memory. */
export async function destroySession(
  this: SessionLifecycleHost,
  sessionKey: string,
): Promise<void> {
  const s = this.sessions.get(sessionKey)
  if (s) {
    // (跨 turn stdout 路由收在 adapter 内:session 引用被删后 adapter → turn
    //  闭包链整体可 GC,无需再显式卸 'message' listener。)
    this.markPlannedServiceRestart(s)
    await s.runner.shutdown()
    // A1:底座已停产出,flush 折叠 tail 的 pending 并清定时器/状态(await 持久化链)。
    await this._flushTailFolding(s)
    // 释放 remote mux refcount —— destroy 是 session 终结态,refcount 必须归零,
    // 否则 mux 泄漏。release 幂等,失败只 warn 不抛(上游不关心)。
    if (s.executionTarget.kind === 'remote' && s.userId) {
      await this._remoteTargetController
        ?.releaseMux(sessionKey, s.userId, s.executionTarget.hostId)
        .catch((err) =>
          log.warn('destroySession releaseMux failed', { sessionKey, err: String(err) }),
        )
    }
    this.sessions.delete(sessionKey)
    // Phase 5:同步清 peer→sessionKey 反查索引(避免悬挂条目让后续 recycle 找到死 session)。
    this._sessionIdToKey.delete(s.peerId)
  }
  // Always clear resume-map (handles both live and evicted sessions)
  if (this._resumeMap.has(sessionKey)) {
    this._resumeMap.delete(sessionKey)
    this._resumeMapTimestamps.delete(sessionKey)
    this._resumeMapLastCost.delete(sessionKey)
    this._resumeMapCostImprecise.delete(sessionKey)
    this._resumeMapProvider.delete(sessionKey)
    this._resumeMapHistory.delete(sessionKey)
    this._saveResumeMap()
  }
  // Medium#G1:让 server.ts 的 outboundRing 也清掉这个 key(两个 server.ts
  // 里现存的 destroySession 调用点已经显式 clear 过,这里再调一次是幂等;
  // 未来若有遗漏的路径,callback 能兜住)
  try {
    this.onSessionDestroyed?.(sessionKey)
  } catch {}
}

/**
 * Stop the warm runner and drop the live session, but keep resume-map so a
 * later getOrCreate(sessionKey) can native-resume. Awaited by resumable
 * delegate_task; fire-and-forget destroySession remains the one-shot path.
 */
export async function retireKeepResume(
  this: SessionLifecycleHost,
  sessionKey: string,
): Promise<void> {
  const s = this.sessions.get(sessionKey)
  if (s) {
    try {
      this.markPlannedServiceRestart(s)
      await s.runner.shutdown()
    } catch (err) {
      log.warn('retireKeepResume shutdown failed', { sessionKey }, err)
    }
    try {
      await this._flushTailFolding(s)
    } catch (err) {
      log.warn('retireKeepResume flush failed', { sessionKey }, err)
    }
    if (s.executionTarget.kind === 'remote' && s.userId) {
      await this._remoteTargetController
        ?.releaseMux(sessionKey, s.userId, s.executionTarget.hostId)
        .catch((err) =>
          log.warn('retireKeepResume releaseMux failed', { sessionKey, err: String(err) }),
        )
    }
    this.sessions.delete(sessionKey)
    this._sessionIdToKey.delete(s.peerId)
  }
  try {
    this.onSessionDestroyed?.(sessionKey)
  } catch {}
}

/**
 * Run durable idle work after the user turn released session.lock. Queued
 * behind the lock like recycle; from scheduling to release it is counted as
 * an internal turn (not a client turn and not _activeTurnCount, so the
 * prompt-queue admission invariant is untouched). Rereads disk state under
 * the lock, so a submit that took the lock first has already handled or
 * superseded it.
 */
export function scheduleIdleDrain(
  this: SessionLifecycleHost,
  session: AgentSession,
  attempt = 0,
): void {
  // Counted from the moment the drain joins the lock chain (like submit()
  // counts _activeTurnCount before `await prev`) until it releases, so
  // recycle / model switch / preheat never see this runner as idle while a
  // drain is waiting, reading proof, or running the idle turn.
  session._idleInternalTurns = (session._idleInternalTurns ?? 0) + 1
  void (async () => {
    const prev = session.lock
    let release!: () => void
    session.lock = new Promise<void>((resolve) => (release = resolve))
    let again = false
    try {
      await prev
      if (
        this.sessions.get(session.sessionKey) !== session ||
        session._plannedTeardown ||
        session._replacing
      )
        return
      const source = currentIdleSource(paths.home, session.sessionKey)
      if (!source) return
      await this.finishIdleUnderLock(session, source)
      again = currentIdleSource(paths.home, session.sessionKey) !== undefined
    } catch (err) {
      again = true
      if (!(err instanceof IdleCompactRejected)) {
        log.warn('idle background drain failed', { sessionKey: session.sessionKey }, err)
      }
    } finally {
      session._idleInternalTurns = Math.max(0, (session._idleInternalTurns ?? 0) - 1)
      release()
    }
    if (again && attempt < IDLE_DRAIN_RETRIES) {
      const timer = setTimeout(
        () => this.scheduleIdleDrain(session, attempt + 1),
        IDLE_DRAIN_RETRY_MS,
      )
      timer.unref?.()
    }
  })()
}

/** Operator exit (requestIdleReset): replace the native session, then
 * abandon this session's unfinished idle work. Caller owns session.lock. */
export async function applyIdleResetIfRequested(
  this: SessionLifecycleHost,
  session: AgentSession,
): Promise<void> {
  const marker = readIdleReset(paths.home, session.sessionKey)
  if (!marker) return
  if (marker === 'corrupt') {
    log.error('box idle reset marker invalid; ignored', { sessionKey: session.sessionKey })
    return
  }
  if (session.runner.isRunning) await session.runner.shutdown().catch(() => {})
  const sessionKey = session.sessionKey
  this._resumeMap.delete(sessionKey)
  this._resumeMapTimestamps.delete(sessionKey)
  this._resumeMapProvider.delete(sessionKey)
  this._resumeMapLastCost.delete(sessionKey)
  this._resumeMapCostImprecise.delete(sessionKey)
  this._resumeMapHistory.delete(sessionKey)
  session.ccbSessionId = null
  session.runner.clearSessionId?.()
  this._saveResumeMap()
  const abandoned = abandonAllIdle(paths.home, sessionKey)
  consumeIdleReset(paths.home, sessionKey)
  pruneIdleOps(paths.home, sessionKey)
  log.warn('box idle reset applied: native session replaced', { sessionKey, abandoned })
}

/** Whether a CCB session's JSONL file exists somewhere under
 *  `$CLAUDE_CONFIG_DIR/projects/*`. We don't try to replicate CCB's
 *  sanitizePath(cwd) projection — worktree switches, EnterWorktreeTool
 *  and the gap between CCB process cwd (= ccbDir) vs agent.cwd (=
 *  --add-dir) each rearrange where the file actually lands. Instead we
 *  scan every project directory under CLAUDE_CONFIG_DIR/projects and
 *  look for `<id>.jsonl` with non-zero size. In v3 containers this dir
 *  typically has ≤5 subdirs so the scan is cheap.
 *
 *  Conservative by design: errors, missing CLAUDE_CONFIG_DIR, or missing
 *  projects/ dir all return `true` (skip validation) — we'd rather let
 *  the old parser stale-detection fire than incorrectly evict a live
 *  resume entry. */
export function _ccbJsonlExists(this: SessionLifecycleHost, resumeId: string): boolean {
  try {
    const configDir = process.env.CLAUDE_CONFIG_DIR
    if (!configDir) return true
    const projectsDir = join(configDir, 'projects')
    if (!existsSync(projectsDir)) return true
    const entries = readdirSync(projectsDir, { withFileTypes: true })
    for (const ent of entries) {
      if (!ent.isDirectory()) continue
      const candidate = join(projectsDir, ent.name, `${resumeId}.jsonl`)
      try {
        const st = statSync(candidate)
        if (st.isFile() && st.size > 0) return true
      } catch {
        // ENOENT / permission denied — treat as not-here, keep scanning
      }
    }
    return false
  } catch {
    return true
  }
}

/** Same cwd projection CursorAdapter.spawnTurn uses: repo workspace when
 *  ready, otherwise the agent base dir. Wrapper --workspace is pwd -P of
 *  that cwd, so realpath when the path exists. */
export function _cursorWorkspacePath(
  this: SessionLifecycleHost,
  agentBaseDir: string,
  repoSessionId?: string,
  projectBound?: boolean,
): string {
  const snap = repoSessionId && this._getRepoSnapshot ? this._getRepoSnapshot(repoSessionId) : null
  const cwd = decideEngineCwd({
    agentBaseDir,
    repoSnapshot: snap,
    projectBound,
  }).cwd
  try {
    return realpathSync(cwd)
  } catch {
    return cwd
  }
}

/**
 * 切换 session 的执行目标 (local ⇄ remote)。
 *
 * 语义(与 boss 对齐):
 *   - 切换意味着**清空上下文** —— shutdown 当前 runner + 清 resume-map。用户
 *     在进入切换时已被 UI 明确告知此行为(前端侧)。
 *   - lock chain 保护:integrated 进 session.lock,跟 submit 相互串行,
 *     保证不会在 in-flight turn 中途偷偷换掉 target。
 *   - 切入 remote 先 acquireMux 成功再 swap,失败路径不碰 runner;切走 remote
 *     在 swap 成功后才 release 旧 mux(outside lock,避免持锁做 IO)。
 *   - 幂等:target.kind 与当前相同且(remote 时)hostId 相同 → noop 返回。
 *
 * 失败:
 *   - controller 未注入但 target.kind='remote' → RemoteTargetUnavailableError
 *   - session 不存在 → throw
 *   - session.userId 缺失(cron / 历史路径) → throw(remote 必须绑 user)
 *   - acquireMux 抛 → rethrow(已回滚,runner 未动)
 */
export async function setExecutionTarget(
  this: SessionLifecycleHost,
  sessionKey: string,
  target: { kind: 'local' } | { kind: 'remote'; hostId: string },
): Promise<void> {
  const session = this.sessions.get(sessionKey)
  if (!session) throw new Error(`session not found: ${sessionKey}`)

  const prev = session.lock
  let release!: () => void
  session.lock = new Promise<void>((r) => (release = r))
  try {
    await prev

    const current = session.executionTarget
    // 幂等短路:target 未变(remote 需 hostId 相同)
    if (current.kind === target.kind) {
      if (current.kind === 'local') return
      if (current.kind === 'remote' && target.kind === 'remote' && current.hostId === target.hostId)
        return
    }

    // 切入 remote 的前置校验
    let newTarget: ExecutionTarget
    if (target.kind === 'remote') {
      const ctrl = this._remoteTargetController
      if (!ctrl) throw new RemoteTargetUnavailableError('controller not injected')
      if (!session.userId) {
        // remote 必须绑 userId,做跨用户隔离;cron 风格 session 不允许远程执行
        throw new Error('session not switchable to remote: userId missing')
      }
      const userId = session.userId
      // 先 acquire,失败抛异常由外层 rethrow,不动 runner
      const handle = await ctrl.acquireMux(sessionKey, userId, target.hostId)
      newTarget = { kind: 'remote', hostId: target.hostId, hostMeta: handle }
    } else {
      newTarget = { kind: 'local' }
    }

    // Swap:到这里新目标资源已就绪(local 无资源,remote 已 hold mux)。
    // 下面做"清上下文 + 改 runner 配置":
    //   1. runner.shutdown 优雅停 CCB(graceful,in-flight turn 会被打断,
    //      但 session.crashed 不会触发 —— shuttingDown 标志位让 exit 归类
    //      为预期退出)。
    //   2. 清 resume-map 四张平行表 + session.ccbSessionId + runner sessionId
    //      —— 下次 submit 就会用新 env spawn 一个全新 CCB。
    //   3. runner.setExecutionTarget 在重启前就位,新 spawn 读到新 env。
    //
    // 任何一步抛 → release 新 mux 做 rollback;session.executionTarget 不提交。
    try {
      await session.runner.shutdown()
      this._resumeMap.delete(sessionKey)
      this._resumeMapTimestamps.delete(sessionKey)
      this._resumeMapProvider.delete(sessionKey)
      this._resumeMapLastCost.delete(sessionKey)
      this._resumeMapCostImprecise.delete(sessionKey)
      this._resumeMapHistory.delete(sessionKey)
      session.ccbSessionId = null
      session.runner.clearSessionId?.()
      this._saveResumeMap()
      await session.runner.setExecutionTarget(newTarget)
    } catch (err) {
      if (newTarget.kind === 'remote' && session.userId) {
        await this._remoteTargetController
          ?.releaseMux(sessionKey, session.userId, newTarget.hostId)
          .catch((e) => log.warn('rollback releaseMux failed', { sessionKey, err: String(e) }))
      }
      throw err
    }

    // 提交新 target。旧 mux(若之前是 remote)在锁外异步 release,别让 IO
    // 阻塞 lock chain;release 幂等,失败只告警。
    const oldTarget = session.executionTarget
    session.executionTarget = newTarget
    if (oldTarget.kind === 'remote' && session.userId) {
      const uid = session.userId
      const oldHostId = oldTarget.hostId
      queueMicrotask(() => {
        this._remoteTargetController
          ?.releaseMux(sessionKey, uid, oldHostId)
          .catch((err) =>
            log.warn('release old mux failed', { sessionKey, oldHostId, err: String(err) }),
          )
      })
    }
    log.info('execution target switched', {
      sessionKey,
      from: oldTarget.kind,
      to: newTarget.kind,
      hostId: newTarget.kind === 'remote' ? newTarget.hostId : undefined,
    })
  } finally {
    release()
  }
}

export async function prepareModelSwitch(
  this: SessionLifecycleHost,
  session: AgentSession,
  expectedSourceModel: string,
  targetModel: string,
  switchId: string,
): Promise<{ sourceModel: string; targetModel: string }> {
  if (!/^[A-Za-z0-9:_-]{8,128}$/.test(switchId)) throw new Error('MODEL_SWITCH_ID_INVALID')
  if (
    (session._activeTurnCount ?? 0) > 0 ||
    (session._activeClientTurnCount ?? 0) > 0 ||
    (session._idleInternalTurns ?? 0) > 0
  ) {
    throw new Error('MODEL_SWITCH_SESSION_BUSY')
  }
  const sourceModel = session.model ?? session.runner.model
  if (!sourceModel) throw new Error('MODEL_SWITCH_SOURCE_UNKNOWN')
  if (sourceModel !== expectedSourceModel) throw new Error('MODEL_SWITCH_SOURCE_CHANGED')
  if (sourceModel === targetModel) return { sourceModel, targetModel }
  if (session._modelSwitchTransition?.state === 'preparing') {
    throw new Error('MODEL_SWITCH_ALREADY_PREPARING')
  }
  const transition: NonNullable<AgentSession['_modelSwitchTransition']> = {
    id: switchId,
    sourceModel,
    targetModel,
    sourceEngine: session.providerTag,
    state: 'preparing',
  }
  session._modelSwitchTransition = transition
  try {
    // biome-ignore lint/suspicious/noImplicitAnyLet: moved verbatim from sessionManager.ts (OCV5-480); pre-existing there
    let artifact
    if (session.runner.compactForHandoff) {
      artifact = await session.runner.compactForHandoff()
    } else if (session.providerTag === 'ccb' || session.providerTag === 'grok') {
      const compactStartedAt = Date.now()
      session._lastNativeCompactionSummary = undefined
      await this.submit(
        session,
        '/compact preserve the user goal, decisions, constraints, current work, files, errors, and next steps',
        () => {},
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { modelSwitchInternal: switchId },
      )
      artifact =
        session.providerTag === 'grok'
          ? await session.runner.readCompactionHandoffSince?.(compactStartedAt)
          : session._lastNativeCompactionSummary
            ? {
                summaryText: session._lastNativeCompactionSummary,
                source: 'ccb' as const,
                compactStartedAt,
              }
            : undefined
    }
    if (!artifact?.summaryText?.trim())
      throw new Error('MODEL_SWITCH_NATIVE_COMPACTION_UNAVAILABLE')
    if (artifact.summaryText.length > NATIVE_MODEL_HANDOFF_MAX_CHARS) {
      throw new Error('MODEL_SWITCH_NATIVE_COMPACTION_TOO_LARGE')
    }
    if (session._modelSwitchTransition !== transition) throw new Error('MODEL_SWITCH_SUPERSEDED')
    transition.summaryText = artifact.summaryText.trim()
    transition.expiresAt = Date.now() + NATIVE_MODEL_SWITCH_TTL_MS
    transition.state = 'prepared'
    return { sourceModel, targetModel }
  } catch (error) {
    if (session._modelSwitchTransition === transition) session._modelSwitchTransition = undefined
    throw error
  }
}

/**
 * Arm the common submit gate, then synchronously inspect accepted turns.
 * A later submit sees the gate; an earlier submit has already incremented
 * `_activeTurnCount` before its first await.
 */
export function armRuntimeRecycleDrain(
  this: SessionLifecycleHost,
  ttlMs: number,
): { accepted: boolean; activeTurns: number } {
  const boundedTtlMs = Number.isFinite(ttlMs)
    ? Math.min(30_000, Math.max(1_000, Math.floor(ttlMs)))
    : 10_000
  this._runtimeRecycleDrainUntil = Date.now() + boundedTtlMs
  if (this._runtimeRecycleDrainTimer) clearTimeout(this._runtimeRecycleDrainTimer)
  this._runtimeRecycleDrainTimer = setTimeout(() => this.releaseRuntimeRecycleDrain(), boundedTtlMs)
  this._runtimeRecycleDrainTimer.unref?.()

  let activeTurns = 0
  for (const session of this.sessions.values()) {
    activeTurns += Math.max(0, session._activeTurnCount ?? 0)
    activeTurns += Math.max(0, session._activeClientTurnCount ?? 0)
    activeTurns += Math.max(0, session._idleInternalTurns ?? 0)
  }
  if (activeTurns > 0) this.releaseRuntimeRecycleDrain()
  return { accepted: activeTurns === 0, activeTurns }
}
