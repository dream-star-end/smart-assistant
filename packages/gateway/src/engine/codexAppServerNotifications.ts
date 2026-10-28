/**
 * Codex app-server inbound stream: JSON-RPC line dispatch, server requests (approval / user input), notifications and item started/completed handling, collab-agent groups, and the per-call usage / tool-result / status / result emitters they drive.
 *
 * Moved verbatim out of CodexAppServerRunner (codexAppServerRunner.ts) — FINDINGS §7.6, OCV5-474. The class
 * keeps one-line forwarders that call these with the instance as `this`, so behaviour, closures and
 * `this.x` reads/writes are unchanged. CodexNotificationHost lists exactly the CodexAppServerRunner members this code
 * touches (typed from the class itself).
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type CallTokenUsageSnapshot,
  type ToolTerminationReason,
  type TurnTokenUsageSnapshot,
  isToolExitCode,
} from '@openclaude/protocol'
import { paths } from '@openclaude/storage'
import { _sanitizeThreadId, copyImagePathsToPublicDir } from './codexShared.js'
import { buildHermeticDenial, isHermeticExecutionMethod } from './codexHermeticPolicy.js'
import type { ClassifiedErrorCode } from '../errorClassify.js'
import type { CollabAgentPolicy } from './engineAdapter.js'
import {
  type CodexGoalBlock,
  normalizeCodexGoal,
  collabReceiverThreadIds,
  collabAgentsStates,
  collabTool,
  collabStatus,
  collabPrompt,
  shortThreadId,
  collabAgentInput,
  summarizeCollabControl,
  isTerminalCollabAgentStatus,
  isErrorCollabAgentStatus,
  codexToolOutcome,
  type JsonRpcCallError,
  type RunnerMessage,
  type CodexTokenBreakdown,
  _EMPTY_TOKEN_BREAKDOWN,
  _coerceTokenBreakdown,
  _subtractTokenBreakdown,
  _codexTurnUsageSnapshot,
  _SUPPRESSED_ITEM_TYPES,
  _normaliseCodexItemType,
  _isContextCompactionItem,
  _stringifyItemBounded,
  type RuntimeRateLimits,
  _parseCodexRateLimits,
  _classifyJsonRpcLine,
  jsonRpcResult,
  jsonRpcMethodNotFound,
  jsonRpcInvalidParams,
  asRecord,
  codexReverseRpcKey,
  normalizeCodexUserInput,
  buildMcpElicitationContent,
  summarizeCommandForDescription,
  stripShellWrapper,
} from './codexAppServerProtocol.js'
import { log } from './codexAppServerRunner.js'
import type { CodexAppServerRunner } from './codexAppServerRunner.js'

export interface CodexNotificationHost {
  nativeContext: CodexAppServerRunner['nativeContext']
  _handleChatgptAuthTokensRefresh: CodexAppServerRunner['_handleChatgptAuthTokensRefresh']
  activeTurnId: CodexAppServerRunner['activeTurnId']
  activeTurnTotal: CodexAppServerRunner['activeTurnTotal']
  attemptEmittedTerminal: CodexAppServerRunner['attemptEmittedTerminal']
  attemptHadObservableOutput: CodexAppServerRunner['attemptHadObservableOutput']
  attemptHadToolOrPermission: CodexAppServerRunner['attemptHadToolOrPermission']
  bindItemCallUsageEpoch: CodexAppServerRunner['bindItemCallUsageEpoch']
  bindItemCallUsageEpochFromItem: CodexAppServerRunner['bindItemCallUsageEpochFromItem']
  buildServerRequestAutoApproval: CodexAppServerRunner['buildServerRequestAutoApproval']
  callUsageByEpoch: CodexAppServerRunner['callUsageByEpoch']
  callUsageEpoch: CodexAppServerRunner['callUsageEpoch']
  callUsageRecord: CodexAppServerRunner['callUsageRecord']
  collabReceiverToSpawnId: CodexAppServerRunner['collabReceiverToSpawnId']
  collabSpawnReceivers: CodexAppServerRunner['collabSpawnReceivers']
  completedCollabSpawnResults: CodexAppServerRunner['completedCollabSpawnResults']
  currentAssistantBuf: CodexAppServerRunner['currentAssistantBuf']
  currentCollabAgentPolicy: CodexAppServerRunner['currentCollabAgentPolicy']
  currentPlanDraft: CodexAppServerRunner['currentPlanDraft']
  currentStructuredOutput: CodexAppServerRunner['currentStructuredOutput']
  currentTurnCompleter: CodexAppServerRunner['currentTurnCompleter']
  emit: CodexAppServerRunner['emit']
  emitAssistantToolUse: CodexAppServerRunner['emitAssistantToolUse']
  emitCallUsageEpoch: CodexAppServerRunner['emitCallUsageEpoch']
  emitGoalBlock: CodexAppServerRunner['emitGoalBlock']
  emitPlanBlock: CodexAppServerRunner['emitPlanBlock']
  emitToolResult: CodexAppServerRunner['emitToolResult']
  emitTurnStatus: CodexAppServerRunner['emitTurnStatus']
  emitUserInputWaitStatus: CodexAppServerRunner['emitUserInputWaitStatus']
  emittedToolUseIds: CodexAppServerRunner['emittedToolUseIds']
  handleCollabAgentToolCompleted: CodexAppServerRunner['handleCollabAgentToolCompleted']
  handleCollabAgentToolStarted: CodexAppServerRunner['handleCollabAgentToolStarted']
  handleContextCompactionItem: CodexAppServerRunner['handleContextCompactionItem']
  handleItemCompleted: CodexAppServerRunner['handleItemCompleted']
  handleItemStarted: CodexAppServerRunner['handleItemStarted']
  handleNotification: CodexAppServerRunner['handleNotification']
  handleRequestUserInput: CodexAppServerRunner['handleRequestUserInput']
  hasCurrentStructuredOutput: CodexAppServerRunner['hasCurrentStructuredOutput']
  inflightItemHandlers: CodexAppServerRunner['inflightItemHandlers']
  itemCallUsageEpoch: CodexAppServerRunner['itemCallUsageEpoch']
  lastEmittedRateLimitsJson: CodexAppServerRunner['lastEmittedRateLimitsJson']
  latestRateLimits: CodexAppServerRunner['latestRateLimits']
  maybeEmitCompletedCollabAgentGroups: CodexAppServerRunner['maybeEmitCompletedCollabAgentGroups']
  nextUserInputRequestId: CodexAppServerRunner['nextUserInputRequestId']
  opts: CodexAppServerRunner['opts']
  pending: CodexAppServerRunner['pending']
  pendingNativeCompaction: CodexAppServerRunner['pendingNativeCompaction']
  pendingUserInputIdsByRpc: CodexAppServerRunner['pendingUserInputIdsByRpc']
  pendingUserInputs: CodexAppServerRunner['pendingUserInputs']
  priorTurnTotal: CodexAppServerRunner['priorTurnTotal']
  reasoningItemState: CodexAppServerRunner['reasoningItemState']
  recordCallUsageSnapshot: CodexAppServerRunner['recordCallUsageSnapshot']
  recordCallUsageTarget: CodexAppServerRunner['recordCallUsageTarget']
  rememberCollabSpawnReceivers: CodexAppServerRunner['rememberCollabSpawnReceivers']
  sameTokenBreakdown: CodexAppServerRunner['sameTokenBreakdown']
  settlePendingUserInputsForTurn: CodexAppServerRunner['settlePendingUserInputsForTurn']
  syncedPlatformGoal: CodexAppServerRunner['syncedPlatformGoal']
  threadId: CodexAppServerRunner['threadId']
  writeRaw: CodexAppServerRunner['writeRaw']
}

/** 自动重试侧信道载荷(不进 tape)。字段与 protocol frames.ts OutboundTurnStatus
 *  的 retrying 分支 / ccbMessageParser TurnRetryMeta 逐字段对齐。 */
export interface TurnRetryMeta {
  attempt: number
  max: number
  delayMs: number
  retryAt: number
}

export function buildServerRequestAutoApproval(
  this: CodexNotificationHost,
  method: string,
  params: unknown,
): unknown | null {
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return { decision: 'acceptForSession' }
    case 'item/fileChange/requestApproval':
      return { decision: 'acceptForSession' }
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { decision: 'approved_for_session' }
    case 'item/permissions/requestApproval': {
      const requested = asRecord(asRecord(params).permissions)
      const permissions: Record<string, unknown> = {}
      if (requested.network !== undefined && requested.network !== null) {
        permissions.network = requested.network
      }
      if (requested.fileSystem !== undefined && requested.fileSystem !== null) {
        permissions.fileSystem = requested.fileSystem
      }
      return { permissions, scope: 'session', strictAutoReview: false }
    }
    case 'mcpServer/elicitation/request':
      return {
        action: 'accept',
        content: buildMcpElicitationContent(params),
        _meta: null,
      }
    default:
      return null
  }
}

export function handleRequestUserInput(
  this: CodexNotificationHost,
  id: number | string,
  paramsUnk: unknown,
): void {
  const params = normalizeCodexUserInput(paramsUnk)
  if (!params) {
    this.writeRaw(jsonRpcInvalidParams(id, 'item/tool/requestUserInput'))
    return
  }
  if (
    !this.currentTurnCompleter ||
    params.threadId !== this.threadId ||
    (this.activeTurnId !== null && params.turnId !== this.activeTurnId)
  ) {
    log.warn('codex requestUserInput does not match active thread/turn', {
      sessionKey: this.opts.sessionKey,
      requestThreadId: params.threadId,
      activeThreadId: this.threadId,
      requestTurnId: params.turnId,
      activeTurnId: this.activeTurnId,
    })
    this.writeRaw(jsonRpcInvalidParams(id, 'item/tool/requestUserInput'))
    return
  }

  // A reverse request can share the stdout chunk with the turn/start
  // response. Mirror notification handling's early-turn adoption so the
  // subsequent turn/completed cleanup is scoped correctly.
  if (this.activeTurnId === null && this.currentTurnCompleter) {
    this.activeTurnId = params.turnId
  }

  const rpcKey = codexReverseRpcKey(id)
  const duplicateRequestId = this.pendingUserInputIdsByRpc.get(rpcKey)
  if (duplicateRequestId) {
    log.warn('duplicate pending codex requestUserInput ignored', {
      sessionKey: this.opts.sessionKey,
      requestId: duplicateRequestId,
      rpcId: id,
    })
    return
  }

  // turnId + itemId are app-server generated and make this opaque id stable
  // and collision-resistant across runner respawns; the serial disambiguates
  // a protocol-violating duplicate item id without parsing the id later.
  const requestId = `codex-user-input:${params.turnId}:${params.itemId}:${++this.nextUserInputRequestId}`
  this.pendingUserInputs.set(requestId, {
    rpcId: id,
    rpcKey,
    turnId: params.turnId,
    itemId: params.itemId,
    questions: params.questions,
  })
  this.pendingUserInputIdsByRpc.set(rpcKey, requestId)
  this.emitUserInputWaitStatus()

  // turn-retry 台账:permission / requestUserInput 请求是对外 emit 边界 → 置位。
  this.attemptHadToolOrPermission = true
  // Reuse the exact CCB parser ingress. CcbMessageParser converts this
  // synthetic control_request into the canonical permission_request event,
  // so no Codex-specific frame or frontend card is introduced.
  this.emit('message', {
    type: 'control_request',
    request_id: requestId,
    request: {
      subtype: 'can_use_tool',
      tool_name: 'AskUserQuestion',
      tool_use_id: params.itemId,
      input: params.input,
    },
  } as unknown as RunnerMessage)
}

export function handleLine(this: CodexNotificationHost, line: string): void {
  const msg = _classifyJsonRpcLine(line)
  // Preserve the exact app-server JSON-RPC object before any UI projection,
  // filtering or normalization. The per-turn parser stores this opaque event
  // in the immutable tape, so command exit codes, full file-change objects,
  // collaboration payloads, reasoning items and future protocol fields all
  // survive refresh even when the compact UI card shows only a summary.
  //
  // patchUpdated is the one deliberate exception: every notification is a
  // cumulative copy of the same growing patch, so appending all copies would
  // make the tape O(N²). Its latest exact snapshot is retained separately by
  // CcbMessageParser for crash/interrupt persistence, and the native final
  // fileChange item remains in this raw tape.
  if (
    (this.currentTurnCompleter || this.activeTurnId) &&
    !(msg.kind === 'notification' && msg.method === 'item/fileChange/patchUpdated')
  ) {
    let payload: unknown
    try {
      payload = JSON.parse(line)
    } catch {
      payload = { rawLine: line, parseError: true }
    }
    this.emit('runtime_event', payload)
  }
  if (msg.kind === 'unknown') {
    this.emit('parse_error', { line, error: 'unknown JSON-RPC shape' })
    return
  }
  if (msg.kind === 'response') {
    const numId = typeof msg.id === 'number' ? msg.id : Number(msg.id)
    const p = this.pending.get(numId)
    if (!p) {
      log.warn('orphan JSON-RPC response', {
        sessionKey: this.opts.sessionKey,
        id: msg.id,
      })
      return
    }
    this.pending.delete(numId)
    if (msg.error) {
      // Structured reject: keep the human message for log/UI use, but also
      // attach `rpcCode` / `rpcMessage` / `rpcMethod` so callers can branch
      // on protocol-level fields without re-parsing the message string. The
      // self-heal in runTurn (attach → thread/resume → -32600 "no rollout
      // found") relies on these fields to avoid swallowing unrelated
      // -32600 Invalid Request errors (e.g. schema/protocol drift) as a
      // missing-rollout case (Codex review #019e0b72 BLOCKER 1).
      const err = new Error(
        `${p.method} -> ${msg.error.code}: ${msg.error.message}`,
      ) as JsonRpcCallError
      err.rpcCode = msg.error.code
      err.rpcMessage = msg.error.message
      err.rpcMethod = p.method
      p.reject(err)
    } else {
      p.resolve(msg.result)
    }
    return
  }
  if (msg.kind === 'server-request') {
    // Reverse-RPC methods we recognize:
    //   - `account/chatgptAuthTokens/refresh` (commercial codex
    //     401-recovery): forward to v3 master HTTP endpoint, reply with the
    //     new token. This MUST stay ahead of generic approval handling.
    //   - Approval / MCP elicitation requests: OpenClaude commercial runs
    //     codex app-server as a trusted autonomous agent, so answer with a
    //     session-scoped accept instead of hanging behind a browser prompt.
    if (msg.method === 'account/chatgptAuthTokens/refresh') {
      // Async fire-and-forget; we reply to codex in the callback. Errors
      // here become a JSON-RPC error frame back to codex.
      void this._handleChatgptAuthTokensRefresh(msg.id, msg.params)
      return
    }
    if (this.opts.hermeticNoTools && isHermeticExecutionMethod(msg.method)) {
      const denial = buildHermeticDenial(msg.method)
      if (denial) {
        this.attemptHadToolOrPermission = true
        log.info('codex app-server hermetic reverse-RPC denied', {
          sessionKey: this.opts.sessionKey,
          method: msg.method,
        })
        this.writeRaw(jsonRpcResult(msg.id, denial))
        return
      }
    }
    if (msg.method === 'item/tool/requestUserInput') {
      this.handleRequestUserInput(msg.id, msg.params)
      return
    }
    const autoApproval = this.buildServerRequestAutoApproval(msg.method, msg.params)
    if (autoApproval !== null) {
      // 审计 R2 — 自动批准 = 对当前 thread 的权限/命令/文件副作用,是本 attempt
      // 的对外 emit 边界。**必须在写批准响应之前**单调置位台账 flag:同一 stdout
      // chunk 内的 reverse-RPC 可能先于 turn/start 的 Promise resolve 到达,若不在此
      // 记账,后续 turn/start application error 时重试门会误判"零权限副作用"而重发,
      // 造成已批准的副作用重复执行。与 handleRequestUserInput 的记账点对称。
      this.attemptHadToolOrPermission = true
      // 若该 reverse-RPC 携带 turnId 且本 attempt 尚未 adopt(activeTurnId===null)
      // 且 turn 在飞(currentTurnCompleter),提前 adopt —— 与 handleRequestUserInput /
      // handleNotification 的 early-turn adoption 同语义,让重试门的 activeTurnId
      // 守卫也一并 fail-closed(双重封死),并把后继 turn/completed 清理正确定界。
      const approvalTurnId =
        msg.params && typeof msg.params === 'object'
          ? (msg.params as Record<string, unknown>).turnId
          : undefined
      if (
        typeof approvalTurnId === 'string' &&
        approvalTurnId.length > 0 &&
        this.activeTurnId === null &&
        this.currentTurnCompleter
      ) {
        this.activeTurnId = approvalTurnId
      }
      log.info('codex app-server server request auto-approved', {
        sessionKey: this.opts.sessionKey,
        method: msg.method,
      })
      this.writeRaw(jsonRpcResult(msg.id, autoApproval))
    } else {
      // Keep unknown server-initiated methods fail-fast so a future Codex
      // protocol addition doesn't hang this runner silently.
      this.writeRaw(jsonRpcMethodNotFound(msg.id, msg.method))
    }
    return
  }
  if (msg.kind === 'notification') {
    this.handleNotification(msg.method, msg.params)
    return
  }
}

export function emitPlanBlock(
  this: CodexNotificationHost,
  plan: {
    text?: string
    explanation?: string
    steps?: Array<{ step: string; status: 'pending' | 'inProgress' | 'completed' }>
    partial?: boolean
  },
  callTargetId?: string,
): void {
  // Scope the plan card identity to the current Codex turn. The frontend
  // uses blockId as the stable update key; a process-wide "codex-plan"
  // key made separate turns fight over one card and made multi-client
  // persistence preserve duplicate random-id plan rows.
  const planBlockId = `codex-plan-${this.activeTurnId ?? 'pending'}`
  // turn-retry 台账:plan 块是对外可观测输出边界 → 置位。
  this.attemptHadObservableOutput = true
  this.emit('message', {
    type: 'openclaude_plan',
    session_id: this.threadId,
    ...(callTargetId ? { openclaude_call_target_id: callTargetId } : {}),
    plan: {
      blockId: planBlockId,
      ...plan,
    },
  } as unknown as RunnerMessage)
  if (callTargetId) this.recordCallUsageTarget(callTargetId)
}

export function emitGoalBlock(this: CodexNotificationHost, goal: CodexGoalBlock): void {
  // turn-retry 台账:goal 块是对外可观测输出边界 → 置位。
  this.attemptHadObservableOutput = true
  const platformGoal = this.syncedPlatformGoal
  this.emit('message', {
    type: 'openclaude_goal',
    session_id: this.threadId,
    goal: {
      ...goal,
      ...(platformGoal
        ? {
            platformGoalId: platformGoal.goalId,
            platformStateRevision: platformGoal.stateRevision,
          }
        : {}),
    },
  } as unknown as RunnerMessage)
}

export function handleNotification(
  this: CodexNotificationHost,
  method: string,
  params: unknown,
): void {
  if (!params || typeof params !== 'object') return
  const p = params as Record<string, unknown>
  const turnId = typeof p.turnId === 'string' ? p.turnId : undefined
  const native = this.nativeContext.notification(method, p)
  if (native === 'usage') {
    handleTokenUsage.call(this, p)
    return
  }
  if (native === 'handled') return

  if (
    this.pendingNativeCompaction &&
    method === 'item/completed' &&
    _isContextCompactionItem(p.item) &&
    (typeof p.threadId !== 'string' || p.threadId === this.threadId)
  ) {
    const pending = this.pendingNativeCompaction
    this.pendingNativeCompaction = null
    clearTimeout(pending.timer)
    pending.resolve()
    return
  }

  // Codex exposes auto-compaction as a ThreadItem (`contextCompaction`).
  // In the app-server protocol it may belong to a short internal turn whose
  // turnId differs from the user-visible turn. Personal-edition Codex shows
  // that item as a normal tool card, so commercial must not drop it merely
  // because the turnId is internal. Surface only while a user turn is
  // actually in flight; otherwise it is background noise from app-server
  // housekeeping.
  if (
    (method === 'item/started' || method === 'item/completed') &&
    _isContextCompactionItem(p.item) &&
    p.threadId === this.threadId &&
    this.currentTurnCompleter
  ) {
    this.nativeContext.automaticItem(method, p, this.threadId)
    this.handleContextCompactionItem(method, p.item)
    return
  }

  // Filter turn-scoped notifications. codex may emit notifications for
  // system-internal turns (compaction, hooks) that the client should ignore.
  //
  // Subtle ordering issue (Codex review #019dde20 MAJOR 3): turn/start is a
  // request whose Promise resolution is a microtask, but stdout `data`
  // events deliver subsequent notifications synchronously inside the same
  // chunk. So a notification carrying the turnId can arrive (and run
  // through handleNotification) BEFORE runTurn assigns activeTurnId from
  // the resolved request. To avoid dropping early tokens/items, when a turn
  // is in flight (`currentTurnCompleter` set) and `activeTurnId` is still
  // null, we adopt the first turnId we see.
  if (turnId) {
    if (this.activeTurnId === null) {
      if (this.currentTurnCompleter) {
        this.activeTurnId = turnId
      } else {
        // No turn in flight → server-internal turn we don't track. Drop.
        return
      }
    } else if (turnId !== this.activeTurnId) {
      return
    }
  }

  if (method === 'thread/goal/updated') {
    this.emitGoalBlock(
      normalizeCodexGoal(p.goal, false, `codex-goal-${this.activeTurnId ?? 'pending'}`),
    )
    return
  }
  if (method === 'thread/goal/cleared') {
    this.emitGoalBlock(
      normalizeCodexGoal(undefined, true, `codex-goal-${this.activeTurnId ?? 'pending'}`),
    )
    return
  }
  if (method === 'item/agentMessage/delta') {
    const delta = typeof p.delta === 'string' ? p.delta : ''
    if (!delta) return
    const itemId = typeof p.itemId === 'string' ? p.itemId : ''
    if (itemId) this.bindItemCallUsageEpoch(itemId)
    // turn-retry 台账:assistant 正文 delta 是对外可观测输出边界 → 置位。
    this.attemptHadObservableOutput = true
    this.currentAssistantBuf += delta
    this.emit('message', {
      type: 'stream_event',
      session_id: this.threadId,
      ...(itemId ? { openclaude_call_target_id: itemId } : {}),
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: delta },
      },
    } as unknown as RunnerMessage)
    if (itemId) this.recordCallUsageTarget(itemId)
    return
  }
  if (method === 'item/plan/delta') {
    const delta = typeof p.delta === 'string' ? p.delta : ''
    if (!delta) return
    const itemId = typeof p.itemId === 'string' ? p.itemId : ''
    if (itemId) this.bindItemCallUsageEpoch(itemId)
    this.currentPlanDraft += delta
    this.emitPlanBlock({ text: this.currentPlanDraft, partial: true }, itemId || undefined)
    return
  }
  if (method === 'turn/plan/updated') {
    const explanation = typeof p.explanation === 'string' ? p.explanation : undefined
    const rawSteps = Array.isArray(p.plan) ? p.plan : []
    const steps = rawSteps
      .map((s) => {
        const obj = s && typeof s === 'object' ? (s as Record<string, unknown>) : {}
        const step = typeof obj.step === 'string' ? obj.step : ''
        const status = obj.status
        if (!step) return null
        return {
          step,
          status:
            status === 'inProgress' || status === 'completed' || status === 'pending'
              ? status
              : 'pending',
        } as const
      })
      .filter((s): s is { step: string; status: 'pending' | 'inProgress' | 'completed' } =>
        Boolean(s),
      )
    const planBlockId = `codex-plan-${this.activeTurnId ?? 'pending'}`
    this.emitPlanBlock({ explanation, steps, partial: true }, planBlockId)
    return
  }
  // Reasoning streaming: codex emits raw `textDelta` (chain-of-thought) OR
  // `summaryTextDelta` (model-distilled summary). Both map to CCB
  // `thinking_delta` so the frontend renders a 💭 thinking row — same
  // surface claude-code uses. Turn-level persistence is owned by
  // CcbMessageParser's `thinkingBuf`; the runner only routes packets.
  //
  // Lossless policy: if codex emits both raw text and a distilled summary
  // for the same item, preserve both in wire arrival order. They may be
  // redundant, but choosing one would irreversibly discard paid output.
  if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
    const delta = typeof p.delta === 'string' ? p.delta : ''
    if (!delta) return
    // turn-retry 台账:reasoning/thinking delta 是对外可观测输出边界 → 置位。
    this.attemptHadObservableOutput = true
    const itemId = typeof p.itemId === 'string' ? p.itemId : ''
    if (itemId) {
      this.bindItemCallUsageEpoch(itemId)
      const st = this.reasoningItemState.get(itemId) ?? { sawContent: false }
      st.sawContent = true
      this.reasoningItemState.set(itemId, st)
    }
    this.emit('message', {
      type: 'stream_event',
      session_id: this.threadId,
      ...(itemId ? { openclaude_call_target_id: itemId } : {}),
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: delta },
      },
    } as unknown as RunnerMessage)
    if (itemId) this.recordCallUsageTarget(itemId)
    return
  }
  // Summary parts are structural model events. Avoid only a leading empty
  // paragraph; once any content exists, retain every part boundary.
  if (method === 'item/reasoning/summaryPartAdded') {
    const itemId = typeof p.itemId === 'string' ? p.itemId : ''
    if (!itemId) return
    const st = this.reasoningItemState.get(itemId) ?? { sawContent: false }
    if (!st.sawContent) {
      this.reasoningItemState.set(itemId, st)
      return
    }
    // turn-retry 台账:summary part boundary(💭 段落分隔)也是对外输出 → 置位。
    this.attemptHadObservableOutput = true
    this.emit('message', {
      type: 'stream_event',
      session_id: this.threadId,
      openclaude_call_target_id: itemId,
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '\n\n' },
      },
    } as unknown as RunnerMessage)
    this.recordCallUsageTarget(itemId)
    return
  }
  if (method === 'item/fileChange/patchUpdated') {
    const notificationThreadId = typeof p.threadId === 'string' ? p.threadId : ''
    const itemId = typeof p.itemId === 'string' ? p.itemId : ''
    const changes = Array.isArray(p.changes)
      ? p.changes.filter(
          (change): change is Record<string, unknown> =>
            Boolean(change) && typeof change === 'object' && !Array.isArray(change),
        )
      : []
    if (
      !this.currentTurnCompleter ||
      !this.threadId ||
      notificationThreadId !== this.threadId ||
      !itemId ||
      changes.length === 0
    ) {
      return
    }
    const first = changes[0]
    const kind =
      first.kind && typeof first.kind === 'object' && !Array.isArray(first.kind)
        ? (first.kind as Record<string, unknown>).type
        : undefined
    const toolName = kind === 'add' ? 'Write' : 'Edit'
    const filePath = typeof first.path === 'string' ? first.path : ''
    const input = {
      file_path: filePath,
      kind: typeof kind === 'string' ? kind : undefined,
      changes,
    }
    // This is an observable tool boundary, so a rejected turn/start must
    // never retry and duplicate content the user has already seen. It also
    // counts as an emitted tool_use for orphan-result pairing, while the
    // parser's dedicated snapshot path deliberately avoids formal pending
    // tool counts/bridges until Codex emits the native final item.
    this.attemptHadToolOrPermission = true
    this.emittedToolUseIds.add(itemId)
    this.bindItemCallUsageEpoch(itemId)
    this.emit('message', {
      type: 'openclaude_tool_snapshot',
      session_id: this.threadId,
      tool: {
        id: itemId,
        name: toolName,
        input,
        inputPreview: JSON.stringify({ file_path: filePath, kind }),
      },
    } as unknown as RunnerMessage)
    this.recordCallUsageTarget(itemId)
    return
  }
  if (method === 'item/started') {
    this.bindItemCallUsageEpochFromItem(p.item)
    this.handleItemStarted(p.item)
    return
  }
  if (method === 'item/completed') {
    // Track the async handler so `runTurn` can drain pending file IO /
    // emits before snapshotting `currentAssistantBuf` and emitting result.
    // codex sends item/completed before turn/completed; without this,
    // imageGeneration's base64 writeFile (or any other async item path)
    // can race past the result frame, leaving the UI with empty output.
    const itemUnk = p.item
    this.bindItemCallUsageEpochFromItem(itemUnk)
    const itemId =
      itemUnk && typeof itemUnk === 'object'
        ? typeof (itemUnk as Record<string, unknown>).id === 'string'
          ? ((itemUnk as Record<string, unknown>).id as string)
          : '<no-id>'
        : '<no-id>'
    const itemType =
      itemUnk && typeof itemUnk === 'object'
        ? typeof (itemUnk as Record<string, unknown>).type === 'string'
          ? ((itemUnk as Record<string, unknown>).type as string)
          : '<no-type>'
        : '<no-type>'
    const handler = this.handleItemCompleted(itemUnk)
      .catch((err) => {
        // Belt + suspenders: handleItemCompleted's per-branch logic already
        // logs+falls back on business errors (image copy/write failures emit
        // a "[image copy failed: ...]" note). Anything escaping here is an
        // unexpected throw — log enough to triage but don't poison runner
        // state (don't reject the turn, don't disturb the next item).
        log.warn('codex handleItemCompleted threw', {
          sessionKey: this.opts.sessionKey,
          itemType,
          itemId,
          err: (err as Error).message,
        })
        this.emit('runtime_event', {
          type: 'openclaude_handler_error',
          handler: 'handleItemCompleted',
          item: structuredClone(itemUnk),
          error:
            err instanceof Error
              ? { name: err.name, message: err.message, stack: err.stack }
              : { value: String(err) },
        })
      })
      .finally(() => {
        this.inflightItemHandlers.delete(handler)
      })
    // turn-retry 台账:item handler 注册即代表本 attempt 已产出工具/输出侧效果
    // (handler 内部 emitToolResult / text_delta 也会置位,但注册点先于其异步体
    // 执行 —— 提前置位保证 fail-closed,即便 handler 尚未 flush)。
    this.attemptHadToolOrPermission = true
    this.inflightItemHandlers.add(handler)
    return
  }
  if (method === 'turn/completed') {
    // Per schema: { threadId, turn: { id, status, durationMs, error? } }.
    // turn-retry 批:turn.error 除 message 外还带 codexErrorInfo(实测值形如
    // "other");这里把整个 turn(含 error 全字段)wholesale 透传给 completer,
    // runTurn 的 failed 分支据此读 codexErrorInfo 进内部日志(不进用户面)。
    const turn = p.turn as Record<string, unknown> | undefined
    if (!turn) return
    // Defensive: even though we already filtered turnId above (via top-level
    // p.turnId), turn.id is the authoritative id on this notification —
    // re-check.
    const tid = typeof turn.id === 'string' ? turn.id : undefined
    if (tid && this.activeTurnId && tid !== this.activeTurnId) return
    // A normal requestUserInput keeps the turn open until the browser
    // answers. This fallback covers app-server auto-resolution, interrupt,
    // and protocol races: echo the schema-valid no-answer result once and
    // remove both pending indexes before the next turn can start.
    const completedTurnId = tid ?? this.activeTurnId
    if (completedTurnId) {
      this.settlePendingUserInputsForTurn(completedTurnId, 'turn completed')
    }
    if (this.currentTurnCompleter) {
      this.currentTurnCompleter.resolve(
        turn as Parameters<typeof this.currentTurnCompleter.resolve>[0],
      )
      this.currentTurnCompleter = null
    }
    return
  }
  if (method === 'thread/tokenUsage/updated') {
    handleTokenUsage.call(this, p)
    return
  }
  if (method === 'account/rateLimits/updated') {
    // Issue A v1.0.108 — schema 强制 params.rateLimits = RateLimitSnapshot;
    // 兼容早期 codex 版本可能把 snapshot 直接放在 params 顶层(spike 实测见过),
    // hit 顶层 fallback 时 debug log 一次方便后续协议漂移诊断(Codex review MINOR 5)。
    let rl: unknown = p.rateLimits
    if ((!rl || typeof rl !== 'object') && (p.primary || p.secondary)) {
      rl = p
      log.debug('codex account/rateLimits/updated: top-level snapshot fallback', {
        sessionKey: this.opts.sessionKey,
      })
    }
    const parsed = _parseCodexRateLimits(rl)
    if (parsed) this.latestRateLimits = parsed
    return
  }
  // Other notifications (turn/started, plan/delta, config-warning, etc.)
  // are dropped — they are observability/UI hints that don't gate the
  // turn lifecycle.
}

export function handleContextCompactionItem(
  this: CodexNotificationHost,
  method: string,
  itemUnk: unknown,
): void {
  if (!itemUnk || typeof itemUnk !== 'object') return
  const item = itemUnk as Record<string, unknown>
  const itemId = typeof item.id === 'string' ? item.id : `codex-compact-${Date.now()}`
  const visibleItem = { ...item, type: 'contextCompaction' }
  if (method === 'item/started') {
    this.emitTurnStatus('compacting')
    this.emitAssistantToolUse(itemId, 'codex:contextCompaction', visibleItem)
    return
  }
  this.emitToolResult(itemId, _stringifyItemBounded(visibleItem), false)
  this.emitTurnStatus(null)
}

export function rememberCollabSpawnReceivers(
  this: CodexNotificationHost,
  spawnId: string,
  receiverThreadIds: string[],
): void {
  if (receiverThreadIds.length === 0) return
  let receivers = this.collabSpawnReceivers.get(spawnId)
  if (!receivers) {
    receivers = new Set<string>()
    this.collabSpawnReceivers.set(spawnId, receivers)
  }
  for (const receiverId of receiverThreadIds) {
    receivers.add(receiverId)
    this.collabReceiverToSpawnId.set(receiverId, spawnId)
  }
}

export function handleCollabAgentToolStarted(
  this: CodexNotificationHost,
  itemId: string,
  item: Record<string, unknown>,
  policy?: CollabAgentPolicy,
): void {
  const tool = collabTool(item)
  if (tool === 'spawnAgent') {
    const receivers = collabReceiverThreadIds(item)
    this.rememberCollabSpawnReceivers(itemId, receivers)
    const prompt = collabPrompt(item)
    this.emitAssistantToolUse(
      itemId,
      'Agent',
      collabAgentInput(item, prompt || '启动 Codex 子 Agent', policy),
    )
    return
  }

  this.emitAssistantToolUse(
    itemId,
    'Codex:multiAgent',
    collabAgentInput(item, `Codex multi-agent: ${tool}`, policy),
  )
}

export function maybeEmitCompletedCollabAgentGroups(
  this: CodexNotificationHost,
  item: Record<string, unknown>,
): void {
  const states = collabAgentsStates(item)
  if (Object.keys(states).length === 0) return

  const touchedReceivers = new Set([...collabReceiverThreadIds(item), ...Object.keys(states)])
  const touchedSpawnIds = new Set<string>()
  for (const receiverId of touchedReceivers) {
    const spawnId = this.collabReceiverToSpawnId.get(receiverId)
    if (spawnId) touchedSpawnIds.add(spawnId)
  }

  for (const spawnId of touchedSpawnIds) {
    if (this.completedCollabSpawnResults.has(spawnId)) continue
    const receivers = this.collabSpawnReceivers.get(spawnId)
    if (!receivers || receivers.size === 0) continue
    const receiverList = [...receivers]
    const allTerminal = receiverList.every((receiverId) =>
      isTerminalCollabAgentStatus(states[receiverId]?.status || ''),
    )
    if (!allTerminal) continue

    const isError = receiverList.some((receiverId) =>
      isErrorCollabAgentStatus(states[receiverId]?.status || ''),
    )
    const lines = receiverList.map((receiverId) => {
      const state = states[receiverId]
      const msg = state?.message ? ` — ${state.message}` : ''
      return `${shortThreadId(receiverId)}: ${state?.status || 'unknown'}${msg}`
    })
    this.completedCollabSpawnResults.add(spawnId)
    this.emitToolResult(spawnId, lines.join('\n') || 'Codex child agent completed', isError)
  }
}

export function handleCollabAgentToolCompleted(
  this: CodexNotificationHost,
  itemId: string,
  item: Record<string, unknown>,
): void {
  const tool = collabTool(item)
  const status = collabStatus(item)

  if (tool === 'spawnAgent') {
    this.rememberCollabSpawnReceivers(itemId, collabReceiverThreadIds(item))
    if (status === 'failed' || status === 'errored') {
      this.completedCollabSpawnResults.add(itemId)
      this.emitToolResult(itemId, summarizeCollabControl(item), true)
    } else {
      this.maybeEmitCompletedCollabAgentGroups(item)
    }
    return
  }

  this.emitToolResult(
    itemId,
    summarizeCollabControl(item),
    status === 'failed' || status === 'errored',
  )
  this.maybeEmitCompletedCollabAgentGroups(item)
}

export function handleItemStarted(this: CodexNotificationHost, itemUnk: unknown): void {
  if (!itemUnk || typeof itemUnk !== 'object') return
  const item = itemUnk as Record<string, unknown>
  const itemId = typeof item.id === 'string' ? item.id : `codex-${Date.now()}`
  const itemType = _normaliseCodexItemType(item.type)
  const visibleItem = itemType === item.type ? item : { ...item, type: itemType }
  if (itemType === 'commandExecution') {
    const cmd = typeof item.command === 'string' ? item.command : ''
    const stripped = stripShellWrapper(cmd)
    // LOW-1(2026-07-03):description 曾硬编码 'codex commandExecution',直接
    // 泄到前端 Bash 卡片副标题。改为命令首行摘要(≤60 字符);空命令不带该字段。
    const summary = summarizeCommandForDescription(stripped)
    this.emitAssistantToolUse(itemId, 'Bash', {
      command: stripped,
      ...(summary !== '' ? { description: summary } : {}),
    })
    return
  }
  if (itemType === 'fileChange') {
    const changes = Array.isArray(item.changes) ? (item.changes as unknown[]) : []
    const first = (changes[0] ?? {}) as Record<string, unknown>
    const kind = (first.kind as { type?: string } | undefined)?.type
    const name = kind === 'add' ? 'Write' : 'Edit'
    this.emitAssistantToolUse(itemId, name, {
      file_path: typeof first.path === 'string' ? first.path : '',
      kind,
      changes,
    })
    return
  }
  if (itemType === 'collabAgentToolCall') {
    this.handleCollabAgentToolStarted(itemId, item, this.currentCollabAgentPolicy)
    return
  }
  // agentMessage / reasoning are streamed via deltas; nothing to surface
  // here. userMessage / hookPrompt are server-internal echoes — also
  // suppressed (otherwise they emit as ugly "CODEX:USERMESSAGE" tool
  // cards). Other types (mcpToolCall, webSearch, imageGeneration, plan,
  // dynamicToolCall, collabAgentToolCall, contextCompaction, etc.)
  // surface as `codex:<type>` tool_use so the frontend's
  // _CODEX_TYPE_META table can render them with friendly icons +
  // labels.
  if (itemType === null) return
  if (_SUPPRESSED_ITEM_TYPES.has(itemType)) return
  if (itemType === 'agentMessage' || itemType === 'reasoning') return
  if (itemType === 'contextCompaction') this.emitTurnStatus('compacting')
  this.emitAssistantToolUse(itemId, `codex:${itemType}`, visibleItem)
}

export async function handleItemCompleted(
  this: CodexNotificationHost,
  itemUnk: unknown,
): Promise<void> {
  if (!itemUnk || typeof itemUnk !== 'object') return
  const item = itemUnk as Record<string, unknown>
  const itemId = typeof item.id === 'string' ? item.id : `codex-${Date.now()}`
  const itemType = _normaliseCodexItemType(item.type)
  const visibleItem = itemType === item.type ? item : { ...item, type: itemType }
  // Mirror handleItemStarted suppression — userMessage/hookPrompt have no
  // tool_use card to attach a result to, and the generic JSON.stringify
  // fallback at the bottom of this function would dump the echo content
  // into a pseudo-tool-result.
  if (typeof itemType === 'string' && _SUPPRESSED_ITEM_TYPES.has(itemType)) return
  if (itemType === 'commandExecution') {
    const out = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : ''
    const exit = typeof item.exitCode === 'number' ? item.exitCode : undefined
    const safeExit = isToolExitCode(exit) ? exit : undefined
    const outcome = codexToolOutcome(item)
    const failedExit = exit != null && exit !== 0
    const isError = failedExit || outcome.isError
    let engineMeta: { exitCode?: number; terminationReason?: ToolTerminationReason } | undefined
    if (failedExit) {
      engineMeta =
        safeExit === undefined ? undefined : { exitCode: safeExit, terminationReason: 'exit_code' }
    } else if (outcome.isError) {
      engineMeta = {
        ...(safeExit !== undefined ? { exitCode: safeExit } : {}),
        ...(outcome.terminationReason !== undefined
          ? { terminationReason: outcome.terminationReason }
          : {}),
      }
    } else if (safeExit !== undefined) {
      engineMeta = { exitCode: safeExit, terminationReason: 'exit_code' }
    }
    this.emitToolResult(itemId, out, isError, undefined, engineMeta)
    return
  }
  if (itemType === 'fileChange') {
    const outcome = codexToolOutcome(item)
    const changes = Array.isArray(item.changes) ? (item.changes as unknown[]) : []
    const summary = changes
      .map((c) => {
        const o = c as Record<string, unknown>
        const k = (o.kind as { type?: string } | undefined)?.type
        return `${k ?? 'change'}: ${o.path ?? ''}`
      })
      .join('\n')
    this.emitToolResult(
      itemId,
      outcome.isError ? _stringifyItemBounded(item) : summary || 'file changes applied',
      outcome.isError,
      undefined,
      outcome.terminationReason === undefined
        ? undefined
        : { terminationReason: outcome.terminationReason },
    )
    return
  }
  if (itemType === 'collabAgentToolCall') {
    this.handleCollabAgentToolCompleted(itemId, item)
    return
  }
  if (itemType === 'imageGeneration') {
    const outcome = codexToolOutcome(item)
    if (outcome.isError) {
      this.emitToolResult(itemId, 'imageGeneration failed', true, undefined, {
        terminationReason: outcome.terminationReason ?? 'tool_error',
      })
      return
    }
    // codex's image_gen tool emits two notification shapes depending on the
    // upstream auth mode (verified 2026-05-03 via JSON-RPC spike vs codex
    // 0.125.0):
    //   - auth_mode=chatgpt (full OAuth + refresh_token): item carries BOTH
    //     `savedPath` (absolute path under <CODEX_HOME>/generated_images/...)
    //     AND `result` (base64 PNG bytes).
    //   - auth_mode=chatgptAuthTokens (commercial pool, token-only): item
    //     carries `result` only — `savedPath` is absent. Codex still writes
    //     the PNG to the same on-disk location, but the path is not surfaced
    //     in the protocol frame.
    // Without the base64 fallback, commercial-pool users see imageGeneration
    // stuck at the started event's `status: in_progress`, no image rendered.
    const saved = typeof item.savedPath === 'string' ? item.savedPath : ''
    const resultB64 = typeof item.result === 'string' ? item.result : ''
    if (!this.threadId || (!saved && !resultB64)) {
      this.emitToolResult(itemId, _stringifyItemBounded(item), true, undefined, {
        terminationReason: outcome.terminationReason ?? 'tool_error',
      })
      return
    }
    let publicPaths: string[] = []
    let failedNames: string[] = []
    let localFailure = false
    try {
      if (saved) {
        const { copied, failedNames: f } = await copyImagePathsToPublicDir(
          this.threadId,
          [saved],
          paths.generatedDir,
        )
        publicPaths = copied.map((c) => c.publicPath)
        failedNames = f
      } else {
        // Decode base64 PNG bytes from item.result and write to public dir
        // directly. Mirrors copyImagePathsToPublicDir's naming pattern
        // (`codex-<sanitizedThreadId>-<basename>`) so the file appears in the
        // same place as the savedPath path.
        const safeThread = _sanitizeThreadId(this.threadId)
        // Sanitize itemId before using as filename — it arrives over the wire
        // and must not introduce path separators or shell metacharacters even
        // though codex's observed form is `ig_<hex>`.
        const safeItemId = itemId.replace(/[^A-Za-z0-9._-]/g, '')
        const baseName = `${safeItemId || `image-${Date.now()}`}.png`
        const dst = join(paths.generatedDir, `codex-${safeThread}-${baseName}`)
        try {
          await mkdir(paths.generatedDir, { recursive: true })
          await writeFile(dst, Buffer.from(resultB64, 'base64'))
          publicPaths = [dst]
        } catch (err) {
          log.warn('codex image base64 write failed', {
            sessionKey: this.opts.sessionKey,
            dst,
            err: (err as Error).message,
          })
          failedNames = [baseName]
          localFailure = true
        }
      }
      const newEmits = publicPaths.filter((p) => !this.currentAssistantBuf.includes(p))
      if (newEmits.length > 0) {
        // Surrounding blank lines so frontend's "absolute path on its own
        // line → render attachment" recognizer matches each path.
        const text = `\n\n${newEmits.join('\n')}\n`
        this.currentAssistantBuf += text
        this.emit('message', {
          type: 'stream_event',
          session_id: this.threadId,
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text },
          },
        } as unknown as RunnerMessage)
      }
      if (failedNames.length > 0) {
        const note = `\n\n[image copy failed: ${failedNames.join(', ')}]\n`
        this.currentAssistantBuf += note
        this.emit('message', {
          type: 'stream_event',
          session_id: this.threadId,
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: note },
          },
        } as unknown as RunnerMessage)
      }
    } catch (err) {
      log.warn('codex app-server image copy failed', {
        sessionKey: this.opts.sessionKey,
        err: (err as Error).message,
      })
      localFailure = true
    }
    // Also emit the original tool_result for the imageGeneration card so
    // the UI's tool-call panel reflects the call. Prefer the codex on-disk
    // path when available, otherwise the public path we just wrote.
    const summary = saved || publicPaths[0] || '<base64>'
    const isError = outcome.isError || localFailure || failedNames.length > 0
    this.emitToolResult(
      itemId,
      isError
        ? `imageGeneration failed: ${failedNames.join(', ') || 'tool reported an error'}`
        : `imageGeneration → ${summary}`,
      isError,
      undefined,
      isError ? { terminationReason: outcome.terminationReason ?? 'tool_error' } : undefined,
    )
    return
  }
  if (itemType === 'agentMessage') {
    if (this.opts.structuredOutputSchema) {
      this.hasCurrentStructuredOutput = false
      this.currentStructuredOutput = undefined
      if (typeof item.text === 'string') {
        try {
          this.currentStructuredOutput = JSON.parse(item.text)
          this.hasCurrentStructuredOutput = true
        } catch {
          // Final result omits structured_output; the caller's structured
          // output collector then fails closed instead of parsing deltas.
        }
      }
    }
    // Already streamed via deltas; no separate tool_result needed.
    return
  }
  if (itemType === 'reasoning') {
    // Already streamed via deltas; no separate tool_result needed.
    return
  }
  if (itemType === 'contextCompaction') {
    const outcome = codexToolOutcome(item)
    this.emitToolResult(
      itemId,
      _stringifyItemBounded(visibleItem),
      outcome.isError,
      undefined,
      outcome.terminationReason === undefined
        ? undefined
        : { terminationReason: outcome.terminationReason },
    )
    this.emitTurnStatus(null)
    return
  }
  // Generic completion for unknown item types (mcpToolCall / webSearch /
  // dynamicToolCall / plan / error / subAgentActivity / …):内层截断 + 完整
  // stringify,保证前端 pickCodexItem 永远拿到可 parse 的 JSON。
  //
  // V5 CG(2026-07-10)— 传 orphanPairing:这些类型里有的(尤其 subAgentActivity)
  // codex 只发 item/completed 不发 item/started(见 emittedToolUseIds 注释),
  // emitToolResult 会据此先补一帧 `codex:<type>` tool_use 再发 result,消掉前端
  // 的孤儿 'unknown' 裸 JSON 卡。itemType 为 null(item.type 非字符串)时退回
  // codex:unknown。
  const pairName = itemType ? `codex:${itemType}` : 'codex:unknown'
  const outcome = codexToolOutcome(item)
  this.emitToolResult(
    itemId,
    _stringifyItemBounded(item),
    outcome.isError,
    {
      name: pairName,
      input: visibleItem,
    },
    outcome.terminationReason === undefined
      ? undefined
      : { terminationReason: outcome.terminationReason },
  )
}

export function emitAssistantToolUse(
  this: CodexNotificationHost,
  id: string,
  name: string,
  input: unknown,
): void {
  // turn-retry 台账:tool_use 是对外 emit 边界 → 置位,封死 turn/start 窄路径重试。
  this.attemptHadToolOrPermission = true
  // 登记本 turn 已发 tool_use 的 item id —— emitToolResult 据此判断是否孤儿。
  this.emittedToolUseIds.add(id)
  this.emit('message', {
    type: 'assistant',
    session_id: this.threadId,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input }],
    },
  } satisfies RunnerMessage)
  this.recordCallUsageTarget(id)
}

export function bindItemCallUsageEpochFromItem(this: CodexNotificationHost, item: unknown): void {
  if (!item || typeof item !== 'object') return
  const id = (item as Record<string, unknown>).id
  if (typeof id === 'string' && id) this.bindItemCallUsageEpoch(id)
}

export function bindItemCallUsageEpoch(this: CodexNotificationHost, itemId: string): number {
  const existing = this.itemCallUsageEpoch.get(itemId)
  if (existing !== undefined) return existing
  const epoch = this.callUsageEpoch
  this.itemCallUsageEpoch.set(itemId, epoch)
  return epoch
}

export function callUsageRecord(
  this: CodexNotificationHost,
  epoch: number,
): {
  callId: string
  targetIds: Set<string>
  usage?: TurnTokenUsageSnapshot
} {
  let record = this.callUsageByEpoch.get(epoch)
  if (!record) {
    record = { callId: `codex-${epoch + 1}`, targetIds: new Set() }
    this.callUsageByEpoch.set(epoch, record)
  }
  return record
}

export function emitCallUsageEpoch(this: CodexNotificationHost, epoch: number): void {
  const record = this.callUsageByEpoch.get(epoch)
  if (!record?.usage || record.targetIds.size === 0) return
  const call: CallTokenUsageSnapshot = {
    callId: record.callId,
    targetIds: [...record.targetIds],
    usage: { ...record.usage },
  }
  this.emit('call_usage', call)
}

export function recordCallUsageTarget(this: CodexNotificationHost, itemId: string): void {
  const epoch = this.bindItemCallUsageEpoch(itemId)
  const record = this.callUsageRecord(epoch)
  const before = record.targetIds.size
  record.targetIds.add(itemId)
  if (record.targetIds.size !== before) this.emitCallUsageEpoch(epoch)
}

export function recordCallUsageSnapshot(
  this: CodexNotificationHost,
  last: CodexTokenBreakdown,
  duplicateTotal: boolean,
): void {
  const epoch = duplicateTotal ? Math.max(0, this.callUsageEpoch - 1) : this.callUsageEpoch
  const record = this.callUsageRecord(epoch)
  record.usage = _codexTurnUsageSnapshot(last)
  this.emitCallUsageEpoch(epoch)
  if (!duplicateTotal) this.callUsageEpoch++
}

export function sameTokenBreakdown(
  this: CodexNotificationHost,
  a: CodexTokenBreakdown,
  b: CodexTokenBreakdown,
): boolean {
  return (
    a.cachedInputTokens === b.cachedInputTokens &&
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.reasoningOutputTokens === b.reasoningOutputTokens &&
    a.totalTokens === b.totalTokens
  )
}

/** V5 CG(2026-07-10)— tool_use/tool_result 成对不变量的唯一守卫点(见
 *  {@link emittedToolUseIds} 注释)。`orphanPairing` 由「本会兜底出孤儿 result」
 *  的调用点(handleItemCompleted 通用兜底)传入,给补发的 tool_use 一个像样的
 *  `codex:<type>` 名字与原始 item 载荷;不传时退化为 `codex:unknown`/`{}`,仍
 *  保证成对(防御任何未预料的孤儿路径,总比裸 result 体面)。 */
export function emitToolResult(
  this: CodexNotificationHost,
  toolUseId: string,
  content: string,
  isError: boolean,
  orphanPairing?: { name: string; input: unknown },
  engineMeta?: { exitCode?: number; terminationReason?: ToolTerminationReason },
): void {
  // turn-retry 台账:tool_result 是对外 emit 边界 → 置位。
  this.attemptHadToolOrPermission = true
  if (!this.emittedToolUseIds.has(toolUseId)) {
    // 孤儿 result:先补一帧配对 tool_use(emitAssistantToolUse 内部会登记 id,
    // 故同 id 的后续 result 不再重复补发)。
    this.emitAssistantToolUse(
      toolUseId,
      orphanPairing?.name ?? 'codex:unknown',
      orphanPairing?.input ?? {},
    )
  }
  this.emit('message', {
    type: 'user',
    session_id: this.threadId,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content,
          is_error: isError,
          ...(engineMeta?.exitCode !== undefined ? { exit_code: engineMeta.exitCode } : {}),
          ...(engineMeta?.terminationReason !== undefined
            ? { termination_reason: engineMeta.terminationReason }
            : {}),
        },
      ],
    },
  } satisfies RunnerMessage)
}

export function emitTurnStatus(
  this: CodexNotificationHost,
  status: 'compacting' | 'waiting_for_user' | null,
): void {
  this.emit('message', {
    type: 'system',
    subtype: 'status',
    session_id: this.threadId,
    status,
  } as unknown as RunnerMessage)
}

/** turn-retry 批 — 发射 fake-SDK `retrying` 状态帧(与 compacting 同 stdout 形状,
 *  ccbMessageParser 的 subtype:'status' 分支消费 retry 载荷并映射成 gateway
 *  turn_status.retrying)。**本帧自身不置台账 flag**(侧信道,不算 turn 输出)。
 *  清除走 emitTurnStatus(null)。 */
export function emitRetryingStatus(this: CodexNotificationHost, retry: TurnRetryMeta): void {
  this.emit('message', {
    type: 'system',
    subtype: 'status',
    session_id: this.threadId,
    status: 'retrying',
    retry,
  } as unknown as RunnerMessage)
}

/** Issue A v1.0.108 round-2 — 决定本次 emitResult 是否带 rateLimits。
 *  规则:latestRateLimits 为 null → 没快照,返 undefined。
 *  否则与 lastEmittedRateLimitsJson 比较:
 *   - 不同(包括首次)→ 带,且更新 lastEmittedRateLimitsJson 记忆
 *   - 相同 → 不带(避免下游 quota_updated_at 假刷新)
 *  JSON 序列化对比要求 _parseCodexRateLimits 输出 key 顺序稳定 — 当前实现按
 *  primary→secondary、字段按写入顺序固定,序列化稳定。 */
export function _consumeRateLimitsForEmit(
  this: CodexNotificationHost,
): RuntimeRateLimits | undefined {
  if (this.latestRateLimits === null) return undefined
  const json = JSON.stringify(this.latestRateLimits)
  if (json === this.lastEmittedRateLimitsJson) return undefined
  this.lastEmittedRateLimitsJson = json
  return this.latestRateLimits
}

export function emitResult(
  this: CodexNotificationHost,
  opts: {
    durationMs: number
    ok: boolean
    text?: string
    error?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
      reasoning_output_tokens?: number
      total_tokens?: number
    }
    /** PR2 v1.0.66 — caller(runTurn)从 closure 拿;不读 instance 字段防 race。 */
    requestId?: string
    /** Issue A v1.0.108 — runTurn 在 emitResult 现场从 instance 字段拿最新已知
     *  rateLimits 快照传进来。null/undefined → 不带本字段。 */
    rateLimits?: RuntimeRateLimits
    /** LOW-2(2026-07-03)— caller 按 turn status 映射(见 RunnerMessage.stop_reason
     *  注释);不传 → result 行不带 stop_reason(failed / 异常路径)。 */
    stopReason?: string
    terminalCode?: 'USER_CANCELLED' | 'CODEX_ERROR'
    /** turn-retry 批 — 非 'unknown' 的结构化错误码(classifyRunError 产物)。 */
    errorClass?: ClassifiedErrorCode
  },
): void {
  // turn-retry 台账:任何 result 终态帧发出即封死本 attempt 的 turn/start 重试。
  this.attemptEmittedTerminal = true
  const msg: RunnerMessage = {
    type: 'result',
    subtype: opts.ok ? 'success' : 'error_during_execution',
    session_id: this.threadId,
    total_cost_usd: 0,
    duration_ms: opts.durationMs,
    is_error: !opts.ok,
    result: opts.ok ? (opts.text ?? '') : (opts.error ?? 'codex error'),
    usage: opts.usage,
    requestId: opts.requestId,
    ...(opts.ok && this.hasCurrentStructuredOutput
      ? { structured_output: this.currentStructuredOutput }
      : {}),
    ...(opts.rateLimits ? { rateLimits: opts.rateLimits } : {}),
    ...(opts.stopReason ? { stop_reason: opts.stopReason } : {}),
    ...(!opts.ok ? { billing_terminal_code: opts.terminalCode ?? ('CODEX_ERROR' as const) } : {}),
    ...(opts.errorClass ? { errorClass: opts.errorClass } : {}),
  }
  this.emit('message', msg)
}

/** Existing billing delta calculation, shared with the native compact turn. */
function handleTokenUsage(this: CodexNotificationHost, p: Record<string, unknown>): void {
  if (typeof p.threadId === 'string' && p.threadId !== this.threadId) return
  this.nativeContext.observeUsage(this.threadId, p)
  // Schema: ThreadTokenUsageUpdatedNotification — { threadId, turnId,
  // tokenUsage: { last, total, modelContextWindow? } }. Both `last` and
  // `total` are TokenUsageBreakdown (cachedInputTokens, inputTokens,
  // outputTokens, reasoningOutputTokens, totalTokens).
  //
  // Strategy (per Codex review v2): use `total` for idempotent snapshots
  // — it's monotonically growing across the thread, so overwriting our
  // activeTurnTotal on every notification is safe even if codex emits
  // duplicate frames. Per-turn delta = activeTurnTotal − priorTurnTotal
  // is computed at turn/completed time, decoupling notification-frame
  // count from the billed amount.
  const tu = p.tokenUsage as Record<string, unknown> | undefined
  if (!tu) return
  const total = _coerceTokenBreakdown(tu.total)
  const duplicateTotal =
    this.activeTurnTotal !== null && this.sameTokenBreakdown(this.activeTurnTotal, total)
  const last = _coerceTokenBreakdown(tu.last)
  this.recordCallUsageSnapshot(last, duplicateTotal)
  // Bootstrap baseline on the FIRST notification of a fresh runner
  // instance attached to a thread with prior history (e.g. server hot-
  // reload mid-conversation, sessionManager constructs a new
  // CodexAppServerRunner with resumeSessionId). Without this, priorTurnTotal
  // would be null and the next turn's delta = full thread total → massive
  // over-bill. `tokenUsage.last` is "tokens used by the most recent LLM
  // call", so `total - last` ≈ "everything before this most recent call"
  // ≈ correct baseline IF this is the first call of the turn. Multi-call
  // turns whose runner happens to be constructed mid-turn (essentially
  // impossible given current sessionManager wiring) would undercount;
  // accepted defensive trade-off.
  if (this.priorTurnTotal === null && this.activeTurnTotal === null) {
    this.priorTurnTotal = _subtractTokenBreakdown(total, last)
  }
  this.activeTurnTotal = total
  const baseline = this.priorTurnTotal ?? _EMPTY_TOKEN_BREAKDOWN
  const delta = _subtractTokenBreakdown(total, baseline)
  if (delta.totalTokens > 0) this.emit('usage', _codexTurnUsageSnapshot(delta))
}
