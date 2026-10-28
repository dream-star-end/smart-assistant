/**
 * Session types: the AgentSession record
 *
 * Moved verbatim out of sessionManager.ts (FINDINGS §7.6, OCV5-480); sessionManager.ts re-exports
 * these names, so importers are unchanged.
 */
import type { IdentityCompatRuntimeContext } from '@openclaude/storage'
import type { EngineAdapter } from './engine/engineAdapter.js'
import type { DurableRuntimeEvent, EngineBillingEvent } from './engine/engineEvents.js'
import type {
  TurnWaiveReason,
  DurableGoalUsageRecord,
  GoalStateSnapshot,
  SessionWorkspaceMode,
} from '@openclaude/protocol'
import type { GatewayTurnPhase } from './ccbMessageParser.js'
import type { ExecutionTarget } from './remoteTarget.js'
import type { UsageAttributionTag } from './subprocessRunner.js'
import type {
  PendingExternalExchange,
  PendingAgentGroupEntry,
  TailFoldStreamState,
  TailPersistQueueItem,
  SessionManager,
} from './sessionManager.js'

// 一个 sessionKey 对应一个 EngineAdapter(CCB = CcbAdapter 组合 SubprocessRunner)
// + 一把 Mutex(同 session 串行)。跨 session 完全并行。
export interface AgentSession {
  /** In-memory execution identity only. Durable session/owner fields are untouched. */
  _identityCreationOpts?: Omit<
    Parameters<SessionManager['getOrCreate']>[0],
    'promptQueueExecutionFence' | 'modelSwitchId'
  >
  _identityAgentFingerprint?: string
  _identityCompat?: IdentityCompatRuntimeContext

  sessionKey: string
  agentId: string
  channel: string
  peerId: string
  /**
   * The authenticated userId that owns the client_sessions row this
   * AgentSession writes to. Set by the first `getOrCreate({ userId })`
   * call (webchat: from the WS auth JWT; other channels usually 'default').
   * Used by the Phase 0.2/0.4 durable-append path so we can persist
   * server-authored assistant text even when the client_sessions row
   * hasn't been upserted yet (first-turn race). `undefined` means we
   * never had a userId (cron-style pre-warm or legacy code path); callers
   * fall back to the old `getClientSession` lookup in that case.
   */
  userId?: string
  /**
   * Repo/workspace lookup key used by runner getRepoSnapshot(). Delegate
   * sessions keep their real peerId for identity, but inherit the originating
   * webchat peerId here so nested delegate_task calls stay in the same repo.
   */
  repoSessionId?: string
  /** Server-persisted default cwd policy. Delegates inherit their root web
   * session's value so the whole task tree shares one isolated directory. */
  workspaceMode: SessionWorkspaceMode
  /**
   * Exact cwd handed to the engine adapter as `agentBaseDir` (pinned
   * `agent.cwd`, or `resolveDefaultWorkspaceCwd`). Cursor chat-store hashes
   * are keyed by this path after the repo-snapshot overlay and realpath, so
   * stale-resume detection must read it back instead of recomputing.
   *
   * Bound chat sessions pass the project workspace here. A ready session-repo
   * overlay is applied later in adapters via decideEngineCwd (allowed).
   */
  workspaceCwd: string
  /** tb_project.id when this session is bound to a work project. null = unbound. */
  projectId?: string | null
  /** projectId + contextVersion + assetsRevision + manifest hashes. */
  contextFingerprint?: string
  /**
   * Chat project the running turn resolved at its start (server.ts); its
   * output assets are registered there. Set by submit() under the turn lock,
   * so a queued next message cannot replace it mid-turn. undefined = not
   * resolved (flag off): the master infers.
   */
  turnChatProjectId?: string | null
  runContext?: import('./runContextPersist.js').RunContextDescriptor
  frozenProjectContext?: import('@openclaude/storage').FrozenProjectContext | null
  /**
   * 直接父会话键。仅 delegate 子会话在创建时物化(handleDelegateTask 传入已校验的
   * 直接父 sessionKey);webchat 根会话为 undefined。用于委派进度**沿父链向上追溯**到
   * 最近的 webchat 祖先(resolveDelegateProgressRouting)——把二级+嵌套委派的进度路由
   * 回用户可见的一级委派卡。只增不改的父指针,使会话委派图可导航。
   */
  parentSessionKey?: string
  /**
   * 本(delegate)会话进度卡的 runId(handleDelegateTask 生成后回填)。嵌套子委派沿父链
   * 追溯到**一级**委派会话后复用其该值作为进度帧 runId,从而把嵌套进度 append 到同一张
   * 一级委派卡。webchat / 普通会话为 undefined。
   */
  progressRunId?: string
  title: string
  startedAt: number
  /** M0 engine 适配层:底座差异收口在 EngineAdapter(CCB = CcbAdapter 组合
   *  SubprocessRunner)。字段名保留 `runner` —— server.ts 等引用面零扩散。 */
  runner: EngineAdapter
  ccbSessionId: string | null
  /**
   * P2 债A — 本 turn 内已完成的委派(团队卡)server-authored durable 缓冲。
   *
   * 委派跑在**独立子会话**,但 agent-group 卡属于**本(队长)会话/turn**:
   * handleDelegateTask 收尾时经 `bufferPendingAgentGroup` 按父 sessionKey 推入
   * 这里。turn 收尾(persistServerAuthoredTurn 调用点)drain 本数组并清空,
   * 随同一 POST 下发给 master 落库为 role 'agent-group' 行。
   *
   * OCV5-180 B1 — 缓冲改为 exact-owner 准入:每条 entry 记录冻结的 owner
   * turnKey(启动时定位);只有**仍处于打开状态的本 owner turn** 可入内存缓冲,
   * owner turn 已 seal(drain 同步临界段封口)后一律走持久晚到通路
   * (`deliverLateDelegateAgentGroup`),不再跨时段滞留内存数组。
   *
   * 只在 webchat 队长会话上累积(buffering 走 progressTarget,webchat-only,与
   * MASTER_SINK_PERSIST_CHANNELS 一致)。嵌套 delegate 的完整 transcript 先写入
   * 直接父 delegate 的 `_durableDelegateTranscript`,最终随一级团队卡一起入本缓冲。
   */
  _pendingAgentGroups?: PendingAgentGroupEntry[]
  /** Turn-wide monotonic sequence shared by engine output and delegation cards. */
  _nextDurableEventOrdinal?: number
  /**
   * Remaining spendable credits (fen) for the in-flight turn, injected by
   * master at admission. Engine-reported adapters abort once running cost
   * reaches this budget.
   */
  _turnCreditBudgetFen?: bigint
  /** Active turn's fail-safe tape finalizer. The outer liveness watchdog uses
   * this instead of emitting an unpersisted error and abandoning the parser. */
  _persistActiveTurn?: (
    status: 'interrupted' | 'crashed',
    reason: string,
    errorCode: string,
    waiveReason?: TurnWaiveReason,
  ) => Promise<void>
  /** Root user-visible turn that owns this delegate session's billed work.
   * Every nested delegate inherits the same key instead of re-parenting cost
   * to an ephemeral delegate turn that is never persisted as a chat tape. */
  _billingParentTurnKey?: string
  /** Trusted session-scoped billing attribution copied from getOrCreate().
   * CCB consumes the same tag through its process environment; Codex needs it
   * on each EngineTurn so the engine-reported billing frame can preserve the
   * delegate parent locator as well. */
  _usageAttribution?: UsageAttributionTag
  /** Live, uncapped collector for a delegate session's complete transcript.
   * Nested delegates append their full transcript here in execution order so
   * the first-level durable team card survives reload with every descendant. */
  _durableDelegateTranscript?: unknown[]
  /** Exact live taskboard activity timestamp; not persisted or inferred from polling. */
  _taskboardLastActivityAt?: number
  /** Complete raw event stream for this one-shot delegate turn. The delegate
   * channel is not persisted as its own chat session, so handleDelegateTask
   * moves this collector into the parent DurableAgentGroup. */
  _durableDelegateRuntimeEvents?: DurableRuntimeEvent[]
  /** A1 — post-terminal bash_output_tail 折叠状态(per session,懒建)。键 =
   *  `${ownerTurnKey}\0${parentToolUseId}\0${toolUseId}`。见
   *  SessionManager._foldPostTerminalTail:把 CCB bg bash 在 turn 终态后每秒不变的
   *  tail 洪泛压成"内容变化才落 / 5s 限频 / 每流 24 条 + 每 turn 64 条封顶"。
   *  session 销毁时 flush pending 后清空(见 _flushTailFolding)。 */
  _tailFoldStreams?: Map<string, TailFoldStreamState>
  /** A1 — 折叠抑制计数(会话销毁时汇总 log 一次,不引入新监控机制)。 */
  _tailFoldMetrics?: { unchangedSuppressed: number; rateCoalesced: number; capped: number }
  /** A1 — 折叠 tail 与非折叠 post-terminal 事件共享的 **per-session** 串行持久化链。
   *  定时器 flush 与事件回调都经它串行化,杜绝并发双 flush;含义即原 per-turn
   *  postTerminalRuntimeChain 提升到 session 维度。 */
  _postTerminalRuntimeChain?: Promise<void>
  /** A2 — 正在等 master ACK 时新到的 tail 先进队列,下一次用一个
   *  continuation tape 批量持久化。避免长任务终态后串行等 64 次
   *  network/finalize ACK,同时仍保持“先持久化、后转发”。 */
  _postTerminalTailQueue?: TailPersistQueueItem[]
  _postTerminalTailWorkerScheduled?: boolean
  /** Complete engine-reported billing frames for this delegate subtree.
   * handleDelegateTask moves them into the parent DurableAgentGroup. */
  _durableDelegateEngineBillings?: EngineBillingEvent[]
  /** Platform-authoritative goal captured under this session's lock. It is
   * immutable for the complete logical turn, including retries. */
  _platformGoal?: GoalStateSnapshot | null
  /** Delegate-subtree usage records rolled up without aggregation. */
  _durableDelegateGoalUsageRecords?: DurableGoalUsageRecord[]
  lock: Promise<void>
  lastUsedAt: number
  // 跨 turn 累积
  totalCostUSD: number
  /** Monotonic: any estimated/unpriced turn makes the resumed aggregate imprecise. */
  costImprecise?: boolean
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheCreationTokens: number
  turns: number
  // CCB 报告的进程累计 cost（getTotalCost()）的上一次取值。
  // _handleResult 里用来算 per-turn cost = cumulative - _lastCcbCumulativeCost。
  // CCB 子进程重启时会被重置为 0,parser 通过 cumulative<prev 检测到,
  // 把新的 cumulative 直接当作本轮 cost。
  _lastCcbCumulativeCost: number
  // 跨 turn 的 tool_use id → name 映射(用于 tool_result 关联)
  toolUseIdToName: Map<string, string>
  // 当前 turn 的文本累积器(用于 FTS5 索引)
  currentUserText?: string
  currentAssistantBuf?: string
  /** Per-turn efficiency linter state (tool_use_detected hook). */
  _efficiencyTurn?: import('./agentEfficiencyGuard.js').TurnGuardState
  _efficiencyPendingHits?: import('./agentEfficiencyGuard.js').LintHit[]
  _efficiencyBudget?: import('./agentEfficiencyGuard.js').VerificationBudget
  // Model name for cost attribution
  model?: string
  /** Native-compaction transition fences every old-model submit until the
   * exact target model + generation consumes the prepared handoff. */
  _modelSwitchTransition?: {
    id: string
    sourceModel: string
    targetModel: string
    sourceEngine: string
    state: 'preparing' | 'prepared' | 'consuming'
    summaryText?: string
    summaryInjected?: boolean
    expiresAt?: number
  }
  /** Last failed prepare, replayed on reconnect so a phone that dropped its
   *  socket mid-compaction still learns the switch failed. */
  _modelSwitchFailure?: {
    id: string
    sourceModel: string
    targetModel: string
    errorCode: string
    message: string
    at: number
  }
  _lastNativeCompactionSummary?: string
  /** Signed context owner for the turn that currently holds session.lock. */
  _boxContextOwner?: string
  /** Set while the lock-held idle path is inside runner.submitTurn. */
  _idleRunning?: boolean
  /** OCV5-297: internal idle compact turns currently using the runner. Not a
   * client turn and not _activeTurnCount (prompt-queue admission asserts that
   * one); lifecycle gates (recycle drain, model switch, preheat) read it. */
  _idleInternalTurns?: number
  // CCB CronCreate bridge: maps tool_use_id/content_key → gateway cron job ID
  _cronBridgeMap?: Map<string, string>
  /** Set by onFinish when the CCB result row signals a stale --resume session
   *  id (file no longer exists). Read by the runner.exit handler to evict the
   *  sessionKey's resume-map entry instead of re-persisting it. See
   *  ccbMessageParser.ts TurnResult.staleResumeId. */
  _pendingStaleResumeClear?: boolean
  /**
   * 当前执行目标(local = 容器内本地,remote = ssh ControlMaster 到远程机)。
   * 默认 { kind:'local' }。切换走 `SessionManager.setExecutionTarget`,整个
   * swap 过程受 `lock` 保护,保证 in-flight turn 看到的是一个一致的 target。
   */
  executionTarget: ExecutionTarget
  /**
   * Phase 5 G.0 → M1a 泛化:本 session 的 **engine id**('ccb' / 'codex',
   * = getOrCreate 时 resolveEngine 的固化结果;字段名保留 providerTag 以免
   * 引用面扩散)。resume-map 按此维度隔离(防 codex thread_id 与 CCB
   * session_id 互喂),recyclePeerForRepoChange / pickIdleTimeoutMs 用它走
   * codex 专属分支(避免 instanceof,见 Plan v3 G.0)。
   */
  providerTag: string
  /**
   * Phase 5 G.0:agent.provider 原始值('claude-subscription' /
   *  'codex-native' / 'minimax' 等)。诊断日志用,辅助排查 recycle 行为
   *  与 provider 路由是否对齐;不参与判断逻辑(判断逻辑用 providerTag)。
   *  agents.yaml 允许 provider 字段缺省,所以这里也允许 undefined。
   */
  agentProvider?: string
  /** Set after we prepend persisted chat history to the first provider-switch
   *  turn. Prevents re-sending the whole transcript on every follow-up. */
  _historicalContextInjected?: boolean
  /** Stable key for the last master-history transcript preamble injected.
   *  Lets Codex native receive newly-produced DeepSeek/CCB turns after the
   *  user switches away and later returns to GPT, while avoiding a repeated
   *  full transcript on ordinary same-provider follow-ups. */
  _historicalContextInjectedKey?: string
  /** User-visible rebuild notices are exceptional. Cursor uses native-resume;
   * set this for an engine switch or a lost native id so the fallback replay
   * can announce a rebuild. Do not set it on a successful native resume. */
  _contextRebuildNotice?: 'engine-switch' | 'native-resume-loss'
  /** One notice per continuous fallback episode; a usable native resume resets it. */
  _contextRebuildNoticeSent?: boolean
  /** A same-engine resume-map entry existed, but the newly selected transport
   * cannot consume it (for example Cursor Sand CCB -> official CC). Preheat may
   * mint a fresh native id before the first real turn; that empty id must not
   * suppress bounded history reconstruction. */
  _forceHistoricalContextOnFirstTurn?: boolean
  /**
   * getOrCreate 跨 engine / workspace 替换期间置位:旧 session 在 runner.shutdown()
   * 完成前仍留在 sessions map。无票 inbound 取样到此标记则不得沿用其 model。
   */
  _replacing?: boolean
  /**
   * Set immediately before a platform-initiated runner.shutdown()
   * (deploy shutdownAll / destroySession / retireKeepResume / LRU).
   * handleExit/handleError then persist SERVICE_RESTART (yellow/waived)
   * instead of RUNNER_CRASHED (red). Unexpected crashes leave this unset.
   */
  _plannedTeardown?: 'service_restart'
  /** Platform-executed exchanges not yet observed in master history. A
   * transient master-sink failure can durably queue the assistant row while
   * the very next user turn arrives first; this session-local tail keeps that
   * paid result in the rebuilt provider context until master acknowledges it. */
  _pendingExternalExchanges?: PendingExternalExchange[]
  /**
   * 当前 turn 的 backend-side 非流式阶段状态。
   *
   * 非 null 值有两类:`'compacting'`(CCB auto/manual compact 期间走单独 LLM
   * 调用,这段时间不产生 assistant token)与 `{status:'retrying', retry}`
   * (codex 自动重试等待期)。两者都是"turn 仍在工作但暂无 token"的阶段态,
   * 前端如果只看流量会以为卡死。server.ts 在收到 `kind:'turn_status'` 事件时
   * 更新此 cache 并 deliver 帧;turn 终态(final/error)清回 null。
   * autoResumeFromHello 在 ring replay 之后,如果 runner 仍在跑且 cache 非空,
   * 补发一帧给重连的客户端(兜底 ring eviction 导致原阶段帧已被冲掉的情况;
   * retrying 补发时按缓存的 retry.retryAt 让前端重算剩余倒计时)。
   *
   * 不持久化、不跨进程 —— gateway 重启后默认 null(下次阶段帧自然把它推回对应
   * 状态,不依赖任何持久状态)。
   */
  currentTurnStatus?: GatewayTurnPhase
  /**
   * Active turn count — number of in-flight `submit()` promises for this session.
   *
   * 进入 `submit()` 后(`session.lock` 新建那一刻)++,**`submit()` promise
   * settled**(即 try/finally 走到 finally,无论正常 return 还是 throw)前 --。
   * 故意覆盖比 runner 进程生命周期更宽的语义:
   *   - `await prev` 等队列中前一个 turn,counter 已计入(用户视角已"按了发送")
   *   - effort/model swap 期间 `runner.shutdown()` 后窗口(proc 已死,turn 还在)
   *   - phantom-turn / auth-refresh retry 内的 shutdown + respawn 窗口
   *   - liveness timeout race 抛错时 — 直到上层 catch 完才 --
   * 所有这些都在 `submit()` try/finally 内,counter 不归零。
   *
   * **这是 turn-level 的 inFlight 真值源**,优于 `runner.isRunning`(进程级,
   * 由 `subprocessRunner.ts: proc!==null && !closed || starting` 定义,turn 内
   * subprocess respawn 窗口会短暂 false)。`autoResumeFromHello` 用它决定是否
   * 推 synthetic turn-interrupted isFinal:counter > 0 意味着 turn 还活着,
   * 绝不应该误推终结帧让前端清状态。
   *
   * 用 counter 而非 boolean:虽然同 session `session.lock` 串行,理论上最多
   * 一个真正执行的 turn,但"in-flight submit 数"包含排队在 `await prev`
   * 后面的 submit。counter 对未来重叠/重入路径鲁棒,且 `Math.max(0, n - 1)`
   * 避免双 finally 或字段缺失导致负数;boolean 会被第二个 submit 的 finally
   * 错误清掉第一个的 active 状态。
   *
   * 不持久化、不跨进程 — gateway 重启后默认 undefined → 读 `?? 0`,下一次
   * `submit()` 自然恢复。Optional 让历史内存对象 / 测试 fake / 其它 provider
   * 注入的 session 不被 TS 波及。
   */
  _activeTurnCount?: number

  /** team-durability(2026-07-07)— **客户 turn** 级 in-flight 计数,scope 比
   * `_activeTurnCount`(engine submit 级)更宽:由 server.ts dispatchInbound 在
   * 首次 submit 前 ++、整个 turn 编排(含 hidden-reviewer 硬编排的 review 委派 +
   * continuation 再 submit)收尾的 finally 里 --。修的洞:团队模式下 engine turn
   * 完成(_activeTurnCount 归零)后 gateway 编排还要跑数分钟审查,期间 hello 重连
   * 若只看 engine 计数会误判"turn 已结束"。判定 turn 是否在飞必须两个计数都看
   * (`_shouldPushTurnInterruptedFinal`)。语义细节同 `_activeTurnCount`:counter
   * 而非 boolean、不持久化、重启后 undefined 读 ?? 0。 */
  _activeClientTurnCount?: number
  /** Abort controller for a platform-executed external turn (Image 2). */
  _externalTurnAbort?: AbortController

  /** team-durability — 最近一次客户 turn 的收尾方式(dispatchInbound finally 记录)。
   * hello 重连对账用:客户端报 inFlight 而两个 turn 计数均为 0 时,'completed' →
   * 推静默 reconcile final(turn 已正常完成,客户端只是错过了终态帧,不该提示
   * "被中断请重发"——那会诱导用户重发重付费);'errored'/undefined → 维持原
   * service_restart 中断文案语义。 */
  _lastClientTurnOutcome?: 'completed' | 'errored'

  /** 队长自主送审(2026-07-07)— 本 turn 是否为团队模式队长回合(dispatchInbound 每
   *  turn 刷新)。_runDelegateTask 的审查门读它:目标为隐藏审查员的委派仅在 true 时放行。 */
  _teamModeTurn?: boolean
  /** Frozen collaboration mode for this inbound turn (main only). */
  _collabModeTurn?: 'solo' | 'advisor' | 'team'
  _advisorTurn?: { advisorModel: string; configVersion: string }

  /** 本 turn 入站用户文本的服务端权威快照(≤8000 字,dispatchInbound 每 turn 刷新)。
   *  审查任务书(buildTeamReviewContext)的"用户原始需求"取此,不采信模型自报。 */
  _currentTurnUserText?: string
  /** Prefix actually prepended to this turn after stripping advisor tool preamble. */
  _injectedTurnConstraints?: string
  /** 本 turn 的 master canonical traceId(submit 每 turn 刷新,含 undefined 清除残留)。
   *  市场使用信号(skillUsageReporter)在 tool.called(hub skill_view)派发时经
   *  SessionManager.getByKey 同步读取,作为评分归因键。单一铸造权威在 master,此处只
   *  中转 submit 已确定的 turnTraceId,不参与铸造。engine 中立(runner.traceId 是 CCB/
   *  codex 私有、不在 EngineAdapter 契约上,故落到 session 提供统一读点)。 */
  _currentTurnTraceId?: string
  /** Stable logical turn key used by lossless persistence and cost joins. */
  _currentTurnKey?: string
  /** Turn index of the turn that owns `_currentTurnKey` (seeded together at
   * turn start). OCV5-180 B1 — exact-owner delegate cards freeze this so a
   * late completion lands as a continuation of the same turn number. */
  _currentTurnIndex?: number
  /** OCV5-180 B1 — owner turns whose turn-end payload is already frozen
   * (drain ran in the same synchronous critical section). A delegate group
   * arriving after its owner key is sealed must go to the persistent late
   * path, never back into `_pendingAgentGroups`. Bounded LRU. */
  _sealedOwnerTurnKeys?: Map<string, number>
  /** OCV5-180 B1 — runId → identity for groups that already rode the root
   * tape (acked/queued drain). Lives on the owner session next to the sealed
   * turn keys so FIFO eviction of `_exactOwnerRuns` cannot forget a frozen
   * root payload. Bounded by the sealed-turn cap. */
  _ackedExactOwnerRuns?: Map<string, Map<string, string>>
  /** Browser user-row id bound to the submit that currently owns session.lock.
   * Unlike _activeTurnCount, this never describes queued submits. */
  _runningClientMessageId?: string
  /** Browser user-row id of the inbound currently inside dispatchInbound
   * after getOrCreate and before that function's outer finally. Covers the
   * mkdir/writeFile/parseDocument window where turn counters are still 0. */
  _admittingClientMessageId?: string

  /** RFC-v5-durable-turn-dispatch §4 — per-session recent-terminal ring
   * (cap 8: clientMessageId → outcome). autoResumeFromHello 用 hello 携带的
   * inFlightClientMessageId 精确对账:命中 completed → turn_completed reconcile
   * 帧带 id;命中中断类 → interrupted 帧带 id;未知 → turn_state_unknown。
   * 非持久化(重启后空 → 未知身份 → forceSync,不冒充终态)。 */
  _recentTerminalRing?: Array<{
    clientMessageId: string
    outcome: 'completed' | 'interrupted' | 'crashed'
  }>

  /** RFC-v5-durable-turn-dispatch §3 — 本 turn 的 durable inbox 准入身份
   * (server.ts dispatchInbound 从验签 descriptor 取出并在 submit 前挂上)。
   * runOneTurnWithRetry 用它在**模型调用前**落 inbox running;turn-end 持久化
   * 用它把 dispatchId/attemptNo 带进 tape payload,ACK 回调据此驱动 terminal。
   * 仅 webchat-DM durable turn 有;legacy/本地路径恒 undefined。 */
  _currentDispatch?: {
    userId: string
    sessionId: string
    clientMessageId: string
    dispatchId: string
    attemptNo: number
  }
}
