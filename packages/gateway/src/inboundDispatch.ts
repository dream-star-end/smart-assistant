import { takeSystemHelpBootstrap } from '@openclaude/protocol'
import { getSystemHelpBootstrap } from './systemHelpFrames.js'
/**
 * Gateway inbound dispatch: the per-frame chat dispatch path (dispatchInbound)
 *
 * Moved verbatim out of Gateway (server.ts) — FINDINGS §7.6, OCV5-483. The class
 * keeps one-line forwarders that call these with the instance as `this`, so behaviour, closures and
 * `this.x` reads/writes are unchanged. InboundDispatchHost lists exactly the Gateway members this code
 * touches (typed from the class itself).
 */
import { fetchIdentityCompatProjection, resolveRuntimeExecutionAgent } from '@openclaude/storage'
import { resolveIdentityCompat, assertIdentityCompatReady } from '@openclaude/protocol'
import { existsSync, readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import sharp from 'sharp'
import {
  isOutpaintAspect,
  normalizeImageEditMask,
  type OutpaintAspect,
  orientedImageDimensions,
  outpaintTargetDimensions,
} from './imageEdit.js'
import type { ChannelAdapter } from '@openclaude/plugin-sdk'
import {
  type InboundFrame,
  type OutboundCodexBilling,
  type OutboundExternalEngineBilling,
  type OutboundCallUsage,
  type OutboundError,
  type OutboundMessage,
  type OutboundTurnUsage,
  parseSessionWorkspaceMode,
  PLATFORM_REASONING_EFFORTS,
  AGENT_MODEL_AUTO,
  normalizeCollabMode,
  collabConfigVersionOf,
  MAX_ATTACHMENTS_PER_MESSAGE,
  AUTOMATIC_TURN_RETRY_MAX,
  isCodexEngineModel,
  isCursorEngineModel,
  isClientMessageId,
  formatMessageReplyPrompt,
  normalizeMessageReplyQuote,
  stripDispatchAuthorityField,
} from '@openclaude/protocol'
import { classifyRunError } from './errorClassify.js'
import { parseCreditBudgetFen } from './creditExhaustion.js'
import { resolveChatRunWorkspace } from './projectWorkspace.js'
import { createRunContextDescriptor, webchatRunId } from './runContextPersist.js'
import {
  type AgentDef,
  paths,
  syncMarketplaceHub,
  recordAutoDreamSuccessfulSession,
} from '@openclaude/storage'
import { isHiddenSystemAgentId } from './agentVisibility.js'
import { listCollaboratorAgents } from './collaboratorAgents.js'
import {
  advisorPreamble,
  ADVISOR_CONSULT_PARENT_REASON,
  isAdvisorConsultParentEngine,
  stripAdvisorPreambleFromInjected,
} from './advisorMode.js'
import type { GatewayStreamEvent } from './ccbMessageParser.js'
import { noteForegroundBashToolResult } from './ccbLocalAgentCallback.js'
import { parseDocument } from './documentParser.js'
import { EMPTY_COMPLETED_TURN_NOTICE, hasPlatedAssistantOutput } from './emptyCompletedTurn.js'
import type { PromptQueueExternalTurnReservation } from './sessionManager.js'
import { inferAgentForModel } from './inferAgentForModel.js'
import { capMarketplaceToolsets, mergeOnDemandToolsets } from './toolsetIntent.js'
import { projectCcbExecutionDescriptor } from './subprocessRunner.js'
import { readV3CodexRelayConfig, V3_CODEX_RELAY_PREFIX } from './v3CodexRelay.js'
import { resolveEngine } from './engine/registry.js'
import {
  getTurnAuthority,
  isEngineLocalTurnExempt,
  isModelAuthorityRequired,
  stripModelAuthorityField,
  type TurnExecutionDescriptor,
} from './modelAuthority.js'
import { getDispatchContext } from './turnDispatchInbox.js'
import { getLocalCatalogView } from './modelCatalogClient.js'
import {
  buildTeamPreamble,
  pickDeliberationPanel,
  type DeliberationPanelMember,
} from './teamMode.js'
import { buildImageAttachmentHint } from './imageAttachmentHint.js'
import { isAutoDreamSuccessfulTurn } from './autoDream.js'
import {
  _isBlockingUserInputTool,
  _permissionRequestExpiresAt,
} from './pendingPermissionSnapshot.js'
import { buildContextObservationFrame } from './contextObservationFrames.js'
import { V3_WECHAT_OUTBOUND_ADAPTER_ID, V3_QQBOT_OUTBOUND_ADAPTER_ID, liveSessionReuseSkipReason, readLiveRunnerModel, resolveLocalExecutionIfEnforced, localExecutionOverride, collectAvailableMcpToolNames, _buildSafeCodexRouteOverride, _buildSafeGrokRouteOverride, _buildSafeZcodeRouteOverride, _buildSafeAntigravityRouteOverride, makePeerKey, _buildTurnTraceContext, _inheritOutboundRouting, _buildEngineErrorFrame, _buildTurnStatusFrame, _earlyRejectErrorFrames, _buildContextRebuiltFrame, isUploadMimeAllowed, uploadExtForMime } from './server.js'
import { ALLOWED_INBOUND_MODELS } from './delegatePolicy.js'
import { MAX_UPLOAD_SINGLE, MAX_UPLOAD_TOTAL, mimeFor } from './httpUploadStatic.js'
import type { Gateway, LocalExecutionDecision } from './server.js'

export interface InboundDispatchHost {
  _adoptOrphanedStdoutWaitDelegates: Gateway['_adoptOrphanedStdoutWaitDelegates']
  _freezeAdvisorTurn: Gateway['_freezeAdvisorTurn']
  _getAgentsConfig: Gateway['_getAgentsConfig']
  _hiddenDelegateGuard: Gateway['_hiddenDelegateGuard']
  _isIdempotencyDuplicate: Gateway['_isIdempotencyDuplicate']
  _mapLocalExecutionError: Gateway['_mapLocalExecutionError']
  _markIdempotencyKey: Gateway['_markIdempotencyKey']
  _memberDelegateGuard: Gateway['_memberDelegateGuard']
  _outboundRing: Gateway['_outboundRing']
  _pendingPermissions: Gateway['_pendingPermissions']
  _promptQueueExecutionFenceByFrame: Gateway['_promptQueueExecutionFenceByFrame']
  _promptQueueLifecycleByFrame: Gateway['_promptQueueLifecycleByFrame']
  _recordRingEvictions: Gateway['_recordRingEvictions']
  _runLog: Gateway['_runLog']
  _runtimeRecycleDrainUntil: Gateway['_runtimeRecycleDrainUntil']
  _runtimeRecycleIngressActive: Gateway['_runtimeRecycleIngressActive']
  _seenIdempotencyKeys: Gateway['_seenIdempotencyKeys']
  _sendAdapterOutboundMessage: Gateway['_sendAdapterOutboundMessage']
  _sendStampedSessionFrame: Gateway['_sendStampedSessionFrame']
  _shuttingDown: Gateway['_shuttingDown']
  _skillShadowReporter: Gateway['_skillShadowReporter']
  _syntheticTurnBarriers: Gateway['_syntheticTurnBarriers']
  _turnDelegatedNonHiddenByParent: Gateway['_turnDelegatedNonHiddenByParent']
  _updateWechatIdempotency: Gateway['_updateWechatIdempotency']
  autoDream: Gateway['autoDream']
  autoDreamOptimizer: Gateway['autoDreamOptimizer']
  clientsByPeer: Gateway['clientsByPeer']
  deliver: Gateway['deliver']
  deps: Gateway['deps']
  flushCcbLocalAgentPendingOnFinalize: Gateway['flushCcbLocalAgentPendingOnFinalize']
  handleCcbLocalAgentDelivered: Gateway['handleCcbLocalAgentDelivered']
  handleCcbLocalAgentNotification: Gateway['handleCcbLocalAgentNotification']
  lastActiveChannel: Gateway['lastActiveChannel']
  log: Gateway['log']
  rateLimiter: Gateway['rateLimiter']
  router: Gateway['router']
  sessions: Gateway['sessions']
  trustedGoalFrames: Gateway['trustedGoalFrames']
}

const WECHAT_FINAL_EMPTY_TEXT =
  '✅ 任务已完成，但这轮没有生成可直接发送到微信的文本结果。请打开实时过程链接查看详细过程。'

function teamMemberCapabilityHint(agent: AgentDef): string {
  let hint = ''
  try {
    const personaPath = agent.persona || paths.agentClaudeMd(agent.id)
    if (existsSync(personaPath)) {
      hint =
        readFileSync(personaPath, 'utf8')
          .split('\n')
          .map((line) => line.trim())
          .find((line) => line && !line.startsWith('#')) ?? ''
    }
  } catch {}
  if (!hint && typeof agent.greeting === 'string') hint = agent.greeting
  hint = hint.replace(/\s+/g, ' ').trim()
  return hint ? ` — 能力: ${hint.slice(0, 100)}` : ''
}

const ALLOWED_REASONING_EFFORTS = new Set<string>(PLATFORM_REASONING_EFFORTS)

export async function dispatchInbound(
  this: InboundDispatchHost,
  frame: InboundFrame,
  adapter?: ChannelAdapter,
): Promise<void> {
  // A few compatibility tests invoke this method with a minimal Gateway-shaped
  // object. Keep the flag-off/non-queue path independent of coordinator state.
  takeSystemHelpBootstrap(frame)
  const gatewayReceivedAt = performance.now()
  const promptQueueLifecycle = this._promptQueueLifecycleByFrame?.get(frame as object)
  const promptQueueExecutionFence = this._promptQueueExecutionFenceByFrame?.get(frame as object)
  // ── 一切入口无条件 strip `__oc_model_authority`(方案 §2 铁律)──────────────
  // dispatchInbound 是**所有** inbound 的唯一汇流点(bridge WS / 本地 WS / HTTP
  // inbound / cron / delegate / channel adapter),故 strip 收口在这里一处:
  //   - bridge WS 路径:_consumeFrameAuthority 已在此之前读完并把 descriptor 挂进
  //     WeakMap,wire 字段的使命已尽 → 删掉,绝不让它流进 runner / 日志 / 持久化;
  //   - 其余路径:该字段只可能来自客户端伪造 → 删掉,永不被信任。
  // descriptor 走 WeakMap 而不是 frame 上的私有属性,正是为了让「strip 干净」与
  // 「descriptor 可用」两件事互不冲突(见 modelAuthority.ts 的 authorityByFrame)。
  stripModelAuthorityField(frame as unknown as Record<string, unknown>)
  // 成对无条件 strip `__oc_dispatch`(RFC-v5-durable-turn-dispatch §3 铁律):bridge
  // WS 路径已在 _consumeDispatchAuthority 读完并挂进 WeakMap,wire 字段使命已尽;其余
  // 入口该字段只可能来自客户端伪造 → 删掉,永不被信任 / 流进 runner / 日志 / 持久化。
  stripDispatchAuthorityField(frame as unknown as Record<string, unknown>)
  // biome-ignore lint/performance/noDelete: moved verbatim from server.ts (OCV5-483); pre-existing there
  if (!this.trustedGoalFrames?.has(frame as object)) delete (frame as any)._goalState

  // Ingress guard: drop new messages once shutdown begins so we don't spin
  // up work that `shutdownAll()` then has to tear back down.
  if (this._shuttingDown) return
  if (frame.type !== 'inbound.message') {
    // TODO: 权限响应处理
    return
  }
  const syntheticBarrierKey = `agent:${frame.agentId}:${frame.channel}:${frame.peer.kind}:${frame.peer.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`
  const syntheticBarrier = this._syntheticTurnBarriers?.get(syntheticBarrierKey)
  if (syntheticBarrier && (frame as any)._syntheticBarrierOwner !== syntheticBarrier.owner) {
    await syntheticBarrier.done
  }
  if (this._runtimeRecycleDrainUntil > Date.now()) {
    this.log.info('runtime recycle drain rejected inbound turn')
    return
  }
  this._runtimeRecycleIngressActive += 1
  let admitCmid: string | undefined
  let admitSession: { _admittingClientMessageId?: string } | undefined
  try {
    // ── Idempotency dedup (read-only check): skip already-processed messages ──
    // Checked first so duplicates don't consume rate-limit budget
    const idempotencyPreReserved = (frame as any)._idempotencyPreReserved === true
    if (
      frame.idempotencyKey &&
      !idempotencyPreReserved &&
      this._isIdempotencyDuplicate(frame.idempotencyKey)
    ) {
      this.log.debug('duplicate idempotencyKey', { key: frame.idempotencyKey })
      const dupUserId: string =
        typeof (frame as any)._userId === 'string' ? (frame as any)._userId : 'default'
      const peerKey = makePeerKey(dupUserId, frame.channel, frame.peer.id)
      const clients = this.clientsByPeer.get(peerKey)
      if (clients) {
        const ack = JSON.stringify({
          type: 'outbound.ack',
          idempotencyKey: frame.idempotencyKey,
          deduplicated: true,
          peer: frame.peer,
          ...(isClientMessageId((frame as any).clientMessageId)
            ? { clientMessageId: (frame as any).clientMessageId }
            : {}),
        })
        for (const ws of clients) {
          try {
            ws.send(ack)
          } catch {}
        }
      }
      return
    }

    const masterHistoricalMessages = Array.isArray((frame as any)._masterHistoricalMessages)
      ? ((frame as any)._masterHistoricalMessages as unknown[])
      : undefined

    // ── V3 S12e CG7 — 采用本 turn 的 trace id(traceId 双权威源收口)──
    // Placed AFTER duplicate idempotency return(dup doesn't open a new turn → no
    // turnTraceId concept)but BEFORE rate-limit so that the rate-limit early-
    // return outbound also carries this turn's trace id.
    //
    // 权威 = master 注入的 frame.traceId(commercial userChatBridge CG2a 在 inbound
    // 入口 rewrite 注入,且是登记 PG turn_traces 的唯一持久落点)。此处**优先采用**
    // frame.traceId(经 parseTraceIdCandidate 校验合法),不存在/非法才回落自铸 ——
    // 保证前端底部展示的请求ID 与运维 turn_traces 登记一致。clientTraceId 仍是纯
    // observation echo,永不参与 turnTraceId 选取。详见 _buildTurnTraceContext docblock。
    const { traceId: turnTraceId } = _buildTurnTraceContext(
      (frame as any).traceId,
      (frame as any).clientTraceId,
      this.log,
    )

    // ── Rate limiting: per-peer sliding window ──
    // Only non-duplicate messages consume rate-limit budget
    const rateLimitChannel: string =
      typeof (frame as any)._rateLimitChannel === 'string'
        ? (frame as any)._rateLimitChannel
        : frame.channel
    if (
      !(frame as any)._skipRateLimit &&
      !this.rateLimiter.check(frame.peer.id, rateLimitChannel)
    ) {
      const rlUserId: string =
        typeof (frame as any)._userId === 'string' ? (frame as any)._userId : 'default'
      const rateLimitOut = {
        type: 'outbound.message' as const,
        sessionKey: '',
        channel: frame.channel,
        peer: frame.peer,
        blocks: [{ kind: 'text' as const, text: '请求过于频繁，请稍后再试。' }],
        isFinal: true,
        traceId: turnTraceId,
        _userId: rlUserId,
      }
      // Route WebSocket broadcast through deliver() so ts-stamp is consistent
      // with regular turn finals; keep the adapter path separate for non-ws
      // channels (Telegram etc.) — adapter.send expects a plain OutboundMessage.
      this.deliver(rateLimitOut)
      if (adapter) {
        // Strip the private `_userId` stamp before handing to non-ws adapters —
        // they have their own wire format and shouldn't see gateway internals.
        const { _userId: _strip, ...adapterOut } = rateLimitOut
        adapter.send(adapterOut).catch(() => {})
      }
      return
    }

    // Mark idempotency key eagerly so concurrent/reconnect replays are dropped during processing.
    // If processing fails the key is deleted, allowing the client to retry.
    if (frame.idempotencyKey && !idempotencyPreReserved) {
      this._markIdempotencyKey(frame.idempotencyKey)
    }

    // Pre-resolution marketplace sync: reconcile installed skills+agents into
    // hub/skills + agents.yaml BEFORE reading agents.yaml, so a freshly-installed
    // market agent is present at resolution time (not merely after a later spawn).
    // No-op outside a commercial container; bounded + fail-soft so it never blocks
    // the turn. The agents.yaml mtime change auto-invalidates _getAgentsConfig's cache.
    try {
      await syncMarketplaceHub({ timeoutMs: 4000 })
    } catch {
      /* fail-soft: sync must never block or fail the turn */
    }

    // Explicit agentId override (web UI per-session selection)
    let sessionKey: string
    let agent: AgentDef
    const cfg = await this._getAgentsConfig()
    if (frame.agentId && isHiddenSystemAgentId(frame.agentId)) {
      const hiddenAgentUserId: string =
        typeof (frame as any)._userId === 'string' ? (frame as any)._userId : 'default'
      const safePeerId = frame.peer.id.replace(/[^a-zA-Z0-9_-]/g, '_')
      this.deliver(
        {
          type: 'outbound.message' as const,
          sessionKey: `agent:${frame.agentId}:${frame.channel}:${frame.peer.kind}:${safePeerId}`,
          channel: frame.channel,
          peer: frame.peer,
          blocks: [{ kind: 'text' as const, text: '[error] agent not found' }],
          isFinal: true,
          traceId: turnTraceId,
          _userId: hiddenAgentUserId,
        } as OutboundMessage,
        adapter,
      )
      return
    }
    const executionIdentityProjection = await fetchIdentityCompatProjection()
    const frameIdentity =
      frame.agentId && executionIdentityProjection
        ? resolveIdentityCompat(frame.agentId, executionIdentityProjection)
        : undefined
    if (frameIdentity) assertIdentityCompatReady(frameIdentity)
    if (
      frameIdentity?.profile &&
      !cfg.agents.some((a) => a.id === frameIdentity.executionAgentId)
    ) {
      throw new Error('COMPAT_CONFIG_CONFLICT: canonical agent missing')
    }
    if (frame.agentId) {
      // Unknown agentId → demote to the default agent (全能助手), NEVER a personaless
      // {id} (which would run with no persona/toolsets/model). After the sync above a
      // genuinely-installed market agent is present; anything still unknown is treated
      // as not-installed and safely resolved to the least-privileged default.
      const ag = cfg.agents.find(
        (a) => a.id === (frameIdentity?.executionAgentId ?? frame.agentId),
      ) ??
        cfg.agents.find((a) => a.id === cfg.default) ??
        cfg.agents.find((a) => a.id === 'main') ?? { id: 'main' }
      agent = ag
      // Include agentId in sessionKey so different agents get isolated subprocesses
      sessionKey = `agent:${frame.agentId}:${frame.channel}:${frame.peer.kind}:${frame.peer.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`
    } else {
      const routed = this.router.route(frame)
      sessionKey = routed.sessionKey
      agent = routed.agent
    }
    agent = (await resolveRuntimeExecutionAgent(agent, cfg, executionIdentityProjection)).agent
    if (isHiddenSystemAgentId(agent.id)) {
      const hiddenAgentUserId: string =
        typeof (frame as any)._userId === 'string' ? (frame as any)._userId : 'default'
      this.deliver(
        {
          type: 'outbound.message' as const,
          sessionKey,
          channel: frame.channel,
          peer: frame.peer,
          blocks: [{ kind: 'text' as const, text: '[error] agent not found' }],
          isFinal: true,
          traceId: turnTraceId,
          _userId: hiddenAgentUserId,
        } as OutboundMessage,
        adapter,
      )
      return
    }

    // ── model→agent 路由(M1a engine registry 语义)──
    // 把 inferAgentForModel 接到生产 message 链路。M1a 起底座选择不再由 agent 承载:
    //   - engine 由 sessionManager.getOrCreate 经 engine/registry 的 resolveEngine
    //     按 model 判定(gpt-5.5 → 'codex',其余 → 'ccb';codex-native pin 例外),
    //     **agent 不换** —— 任何 agent 都能以 gpt-5.5 跑 codex 底座,persona/skills/
    //     记忆随 agent 保持不变;
    //   - 本 helper 只回答"哪个 agent":requested agent 存在则用之,否则回落
    //     default(或首个)agent;完全无 agent 可用才 fail closed
    //     (error='no_compatible_agent',立刻回 error 帧并 return,不进 sessionManager)。
    // 模型准入由 ALLOWED_INBOUND_MODELS(入站帧)+ resolveExecutionModel
    // (agent.model 绕过口)收口;canUseModel 在 ws bridge 层已先于此路径拦截,
    // 这是 belt-and-suspenders。
    // ── 模型执行权威(方案 §2):有 descriptor 的 turn,model 判定**只**认 descriptor ──
    // baked 白名单(ALLOWED_INBOUND_MODELS)是容器镜像里的第二信任源,与 master 的
    // catalog 快照必然漂移(catalog 里新 active 的模型,旧镜像的白名单不认识 → 帧被
    // 静默降级 → master 按 A 计费、容器跑 B)。descriptor 存在时它已是 master 唯一判定
    // 的产物(active + 有价 + capability schema 可理解),不再过第二道审判。
    const turnAuthority: TurnExecutionDescriptor | undefined = getTurnAuthority(frame)
    const _frameModelRaw = (frame as any).model
    const safeModelForRouting: string | undefined =
      turnAuthority !== undefined
        ? turnAuthority.canonicalModel
        : typeof _frameModelRaw === 'string' && ALLOWED_INBOUND_MODELS.has(_frameModelRaw)
          ? _frameModelRaw
          : undefined
    if (safeModelForRouting) {
      // 用 router/explicit 已解析出的 agent.id,而不是 frame.agentId ?? cfg.default。
      // 否则如果 router 通过 routes 规则选了一个非 default 的 claude agent,这里会把它
      // 错误地 "降级" 回 cfg.default,造成路由回归(Codex review v2 finding 2)。
      const decision = inferAgentForModel({
        model: safeModelForRouting,
        requestedAgentId: agent.id,
        defaultAgentId: cfg.default,
        agents: cfg.agents,
      })
      if ('error' in decision) {
        const _errUserId: string =
          typeof (frame as any)._userId === 'string' ? (frame as any)._userId : 'default'
        // 结构化双帧:先 outbound.error(模型路由拒绝 → upstream_failed,新客户端红卡),
        // 再兼容 [error] final(终止器,内文不变;不泄漏 decision.reason 内部线索)。
        const rejectFrames = _earlyRejectErrorFrames({
          sessionKey,
          channel: frame.channel,
          peer: frame.peer,
          userId: _errUserId,
          traceId: turnTraceId,
          code: 'upstream_failed',
          message: '模型服务暂时不可用，请稍后重试或切换模型',
          legacyErrorText: `[error] model routing rejected (${decision.error})`,
        })
        // 不要泄漏 decision.reason 内文(可能含 agent provider 等内部线索),
        // 仅给前端 error code,内部细节走 log。
        this.log.warn('inferAgentForModel rejected', {
          model: safeModelForRouting,
          requestedAgentId: agent.id,
          error: decision.error,
          reason: decision.reason,
        })
        for (const f of rejectFrames) this.deliver(f, adapter)
        return
      }
      if (decision.agentId !== agent.id) {
        const overrideAgent = cfg.agents.find((a) => a.id === decision.agentId)
        if (overrideAgent) {
          agent = overrideAgent
          // 模型路由换了 agent → 强制 per-agent 隔离 sessionKey,避免 codex 与
          // 其他 agent 的 subprocess 污染同一 SessionManager 槽。
          sessionKey = `agent:${agent.id}:${frame.channel}:${frame.peer.kind}:${frame.peer.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`
        } else {
          // inferAgentForModel 已校验 codex agent 存在,这里不应到达;防御性 log。
          this.log.error('inferAgentForModel returned unknown agentId', {
            decisionAgentId: decision.agentId,
          })
        }
      }
    }

    // Track last active channel for proactive push
    const activeUserId: string =
      typeof (frame as any)._userId === 'string' ? (frame as any)._userId : 'default'
    const lastActiveChannel: string =
      typeof (frame as any)._lastActiveChannel === 'string'
        ? (frame as any)._lastActiveChannel
        : frame.channel
    const lastActivePeerId: string =
      typeof (frame as any)._lastActivePeerId === 'string'
        ? (frame as any)._lastActivePeerId
        : frame.peer.id
    this.lastActiveChannel.set(agent.id, {
      channel: lastActiveChannel,
      peerId: lastActivePeerId,
      sessionKey,
      userId: activeUserId,
      at: Date.now(),
    })

    // Defensive sanitize: WS frames are JSON-cast (no typebox runtime check),
    // so an attacker could put arbitrary strings in effortLevel. Whitelist
    // mirrors protocol/frames.ts InboundMessage.effortLevel + CCB EFFORT_LEVELS.
    //   - 合法 string → 透传
    //   - null      → 透传(显式清除已有 effort,让 runner 回到模型默认)
    //   - 其它(包括字段缺省) → 不传给 sessionManager,保持现有 runner 不动
    //
    // effort 的判定权威同样上移 descriptor(方案 §2:engine/capability/context/effort/
    // vision 全取自 descriptor):allowlist 用 descriptor.supportedEfforts(该模型真实
    // 支持的档位),而不是平台全集 —— 平台全集会把「模型不支持的档位」放进 runner。
    // 帧未带 effort 且 descriptor 有 codexDefaultEffort → 用模型默认档(仅新建 session
    // 生效,既存 session 的切换由 submit 处理,语义与旧实现一致)。
    // OCV5-434 GPT Fast (turn-level). WS frames are JSON-cast: only 'fast' passes; anything
    // else — including an absent field — is explicit standard, so Fast is never implied or
    // carried over from an earlier turn. Runners act on it only for Fast-capable models.
    const safeServiceTier: 'fast' | null = (frame as any).serviceTier === 'fast' ? 'fast' : null
    const _frameEffort = (frame as any).effortLevel
    const allowedEfforts: ReadonlySet<string> =
      turnAuthority !== undefined
        ? new Set(turnAuthority.supportedEfforts)
        : ALLOWED_REASONING_EFFORTS
    let safeEffortLevel: string | null | undefined
    if (_frameEffort === null) {
      safeEffortLevel = null
    } else if (typeof _frameEffort === 'string' && allowedEfforts.has(_frameEffort)) {
      safeEffortLevel = _frameEffort
    } else if (_frameEffort === undefined && turnAuthority?.codexDefaultEffort !== undefined) {
      safeEffortLevel = turnAuthority.codexDefaultEffort
    } else {
      safeEffortLevel = undefined
    }

    // Defensive sanitize for InboundMessage.model (2026-04-26 v1.0.4):
    //   - 合法 model id(ALLOWED_INBOUND_MODELS) → 透传给 sessionManager.submit,
    //     在那里比对 runner.model 决定是否 setModel + shutdown(下次 submit 自动 spawn 新模型)
    //   - 缺省 / 非法 → undefined,sessionManager 不动 runner 当前 model
    //   allowlist 抽到文件顶部 export 便于 unit test + 后续加模型集中改一处。
    // 已在 inferAgentForModel 路由前算过(safeModelForRouting),此处复用避免重复。
    const safeModel: string | undefined = safeModelForRouting
    const _frameModelSwitchId = (frame as any).modelSwitchId
    const safeModelSwitchId: string | undefined =
      typeof _frameModelSwitchId === 'string' && /^[A-Za-z0-9:_-]{8,128}$/.test(_frameModelSwitchId)
        ? _frameModelSwitchId
        : undefined

    const _frameConversationMode = (frame as any).conversationMode
    const safeConversationMode: 'default' | 'plan' | undefined =
      _frameConversationMode === 'default' || _frameConversationMode === 'plan'
        ? _frameConversationMode
        : undefined

    // PR2 v1.0.66 — 提取 server-owned requestId(master 强制写入)。
    // 容器侧不验证、不生成、也不回退:不带 → undefined,sessionManager 透传给
    // CodexAppServerRunner queue entry,emitResult 时若不带 requestId 则不发
    // codex_billing 帧,master 端没 inflight 行也无所谓(不进入真扣费链路)。
    // 类型 cast 用 (frame as any),与下方 _frameEffort / _frameModelRaw 同模式 ——
    // typebox runtime 不在 ws 帧入口跑(JSON cast),用 typeof 防御。
    const _frameRequestId = (frame as any).requestId
    const safeRequestId: string | undefined =
      typeof _frameRequestId === 'string' && _frameRequestId.length > 0
        ? _frameRequestId
        : undefined
    const safeClientMessageId: string | undefined =
      frame.channel === 'webchat' && isClientMessageId((frame as any).clientMessageId)
        ? (frame as any).clientMessageId
        : undefined
    const safeWorkspaceMode = parseSessionWorkspaceMode((frame as any)._workspaceMode) ?? undefined
    // 团队模式(v5 轻量组队):turn 级 flag,仅 main 队长生效。ws 帧无 typebox runtime
    // 校验(JSON cast),用 === true 防御(与 _frameRequestId 同模式)。
    const teamMode = (frame as any).teamMode === true
    const inboundCollabMode = !isEngineLocalTurnExempt()
      ? normalizeCollabMode({ teamMode })
      : normalizeCollabMode({
          collabMode: (frame as { collabMode?: unknown }).collabMode,
          teamMode,
        })

    // v5 codex route 消费链(A1):master bridge 注入的 `__oc_codex_route` →
    // 严格校验(_buildSafeCodexRouteOverride)→ submit opts.codexRoute →
    // runner.setCodexRoute(spawn 时拼 -c provider override,签名变化触发
    // codex app-server 重启的既有逻辑复用)。非 codex engine / 校验失败 → null,
    // submit 每 turn 都显式 set(null 即清除 stale route)。
    const safeCodexRoute = _buildSafeCodexRouteOverride({
      agent,
      model: safeModelForRouting,
      rawRoute: (frame as any).__oc_codex_route,
      officialRelayPort: this.deps.config.gateway.port,
      // engine 判定与 getOrCreate 同源:descriptor 说 codex 就是 codex,不看 baked 表
      // (否则 catalog 新增的 codex 系模型在旧镜像里判成 ccb → route override 被丢 →
      //  codex turn 无路由)。
      ...(turnAuthority !== undefined
        ? {
            authority: {
              canonicalModel: turnAuthority.canonicalModel,
              engine: turnAuthority.engine,
            },
          }
        : {}),
    })
    const safeGrokRoute = _buildSafeGrokRouteOverride({
      agent,
      model: safeModelForRouting,
      rawRoute: (frame as any).__oc_grok_route,
      officialRelayPort: this.deps.config.gateway.port,
      ...(turnAuthority !== undefined
        ? {
            authority: {
              canonicalModel: turnAuthority.canonicalModel,
              engine: turnAuthority.engine,
            },
          }
        : {}),
    })
    const safeZcodeRoute = _buildSafeZcodeRouteOverride({
      agent,
      model: safeModelForRouting,
      rawRoute: (frame as any).__oc_zcode_route,
      officialRelayPort: this.deps.config.gateway.port,
      ...(turnAuthority !== undefined
        ? {
            authority: {
              canonicalModel: turnAuthority.canonicalModel,
              engine: turnAuthority.engine,
            },
          }
        : {}),
    })
    const safeAntigravityRoute = _buildSafeAntigravityRouteOverride({
      agent,
      model: safeModelForRouting,
      rawRoute: (frame as any).__oc_antigravity_route,
      officialRelayPort: this.deps.config.gateway.port,
      ...(turnAuthority !== undefined
        ? {
            authority: {
              canonicalModel: turnAuthority.canonicalModel,
              engine: turnAuthority.engine,
            },
          }
        : {}),
    })

    const baseToolsets = agent.toolsets ?? this.deps.config.defaults.toolsets
    let effectiveToolsets = mergeOnDemandToolsets(
      baseToolsets,
      this.deps.config,
      frame.content.text ?? '',
    )
    // Marketplace agents are HARD-CAPPED to their declared manifest toolsets:
    // on-demand intent expansion must never grant a capability the manifest didn't
    // declare (RFC D2 — manifest toolsets are the total-reachable ceiling, not just
    // for delegation). Platform/user agents (no source marker) keep on-demand expand.
    effectiveToolsets = capMarketplaceToolsets(agent.source, agent.toolsets, effectiveToolsets)
    const effectiveAgent =
      effectiveToolsets === undefined ? agent : { ...agent, toolsets: effectiveToolsets }

    // ── 无 envelope 的 inbound(方案 §3)────────────────────────────────────────
    // dispatchInbound 是**所有** inbound 的汇流点,其中一部分不经 bridge 签发 authority:
    // v3 WeChat broker 直投(/internal/v3/wechat-inbound)、个人版本地 WS。这些 turn 在
    // flag 开启后同样不许查 baked 表 —— 判定源换成 master catalog 投影(kind='turn':
    // codex 意图**结构化拒**而不是静默换模型;现状是同样跑不了 —— 晚期被 CODEX_BILLING_GUARD
    // 拒,本批把它提前到创建 runner 之前)。bridge turn(turnAuthority 在场)不进本分支。
    let localExec: LocalExecutionDecision | undefined
    if (turnAuthority === undefined) {
      try {
        localExec = await resolveLocalExecutionIfEnforced({
          agent: effectiveAgent,
          kind: 'turn',
          model: safeModel,
          // 无票且帧上没有合法 model:catalog 拉完后再读存活 runner,沿用其 model/engine。
          // 有 safeModel(用户换模型 / 普通带 model 消息)时不取样 —— 行为与原来一致。
          resolveLiveSessionModel:
            safeModel === undefined
              ? () => readLiveRunnerModel(this.sessions.getByKey(sessionKey))
              : undefined,
          resolveLiveSessionSkipReason:
            safeModel === undefined
              ? () => liveSessionReuseSkipReason(this.sessions.getByKey(sessionKey))
              : undefined,
          defaultModel: this.deps.config.defaults.model,
          warn: (message, fields) => this.log.warn(message, { sessionKey, ...fields }),
        })
      } catch (err) {
        const mapped = this._mapLocalExecutionError(err)
        if (!mapped) throw err
        // 用户可见:回 error 帧收尾本 turn(与 inferAgentForModel 拒帧同形),不 spawn runner。
        // mapped.code 是 MODEL_NOT_AVAILABLE / MODEL_CATALOG_UNAVAILABLE 类,wire
        // OutboundError.code 无对应枚举 → 统一走 'upstream_failed'(红卡 + 重试引导);
        // 裸 [error] final 保留原样 mapped.code(旧客户端终止器)。
        const rejectFrames = _earlyRejectErrorFrames({
          sessionKey,
          channel: frame.channel,
          peer: frame.peer,
          userId: activeUserId,
          traceId: turnTraceId,
          code: 'upstream_failed',
          message: '模型服务暂时不可用，请稍后重试或切换模型',
          legacyErrorText: `[error] ${mapped.code}`,
        })
        for (const f of rejectFrames) this.deliver(f, adapter)
        return
      }
    }
    // 本 turn 的执行模型:catalog 判定在场则以它为准(alias 已归一),否则沿用入站 safeModel。
    // getOrCreate(spawn)与 submit(路由字段)**同源** —— 不允许 spawn 用 A、路由用 B。
    const turnExecutionModel: string | undefined = localExec?.canonicalModel ?? safeModel

    const cronRaw = (frame as unknown as { _cronBoardProjectId?: unknown })._cronBoardProjectId
    const cronBoardOverride = typeof cronRaw === 'string' ? cronRaw : undefined
    const chatWorkspace = await resolveChatRunWorkspace({
      sessionId: frame.peer.id,
      ...(cronBoardOverride ? { boardProjectId: cronBoardOverride } : {}),
    })
    if (chatWorkspace.unavailable) {
      // The master could not tell us this session's project. Running anyway
      // would drop its instructions, files and cwd without anyone noticing,
      // so the turn is held before anything is spawned or billed.
      this.log.warn('project context unavailable; turn held', {
        sessionKey,
        reason: chatWorkspace.unavailable,
        traceId: turnTraceId,
      })
      const heldFrames = _earlyRejectErrorFrames({
        sessionKey,
        channel: frame.channel,
        peer: frame.peer,
        userId: activeUserId,
        traceId: turnTraceId,
        code: 'project_context_unavailable',
        message:
          '项目信息暂时没有加载出来，这一轮还没有开始，也不会计费。请稍后用下方按钮重新发送。',
        legacyErrorText: '[error] PROJECT_CONTEXT_UNAVAILABLE',
      })
      for (const f of heldFrames) this.deliver(f, adapter)
      return
    }
    const webchatRunContext = createRunContextDescriptor({
      runId: webchatRunId(frame.peer.id, turnTraceId),
      boardProjectId: chatWorkspace.projectId,
      channel: frame.channel,
      agentId: effectiveAgent.id,
      sessionKey,
      cwdSource: chatWorkspace.cwdSource,
      workspaceSpec: chatWorkspace.spec,
      workspaceCwd: chatWorkspace.workspaceCwd ?? null,
      persistSnapshot: Boolean(chatWorkspace.projectId && chatWorkspace.bound),
    })

    const session = await this.sessions.getOrCreate({
      sessionKey,
      agent: effectiveAgent,
      channel: frame.channel,
      peerId: frame.peer.id,
      // Phase 0.4 P1-3: carry the authenticated userId onto the session so
      // the durable-append path can persist server-authored text even
      // before the client's debounced PUT lands (first-turn race). Without
      // this the handleResult hook calls `getClientSession(peerId)`, gets
      // null, and silently drops the reply.
      userId: activeUserId,
      workspaceMode: safeWorkspaceMode,
      ...(chatWorkspace.workspaceCwd ? { workspaceCwd: chatWorkspace.workspaceCwd } : {}),
      projectId: chatWorkspace.projectId,
      contextFingerprint: chatWorkspace.contextFingerprint,
      assetsRevision: chatWorkspace.assetsRevision,
      runContext: webchatRunContext,
      title: (frame.content.text ?? '').slice(0, 50).trim() || undefined,
      // 仅用于**新建** runner 时初始化 effort;既存 session 的切换由 submit() 处理
      // (在那里和 turn 入队原子串行,避免并发 submit 之间互相覆盖)。
      effortLevel: safeEffortLevel,
      // M1a 跨 engine 切模型:入站 desired model 参与 getOrCreate 的 engine 判定
      // (resolveEngine 单一权威)。同 sessionKey 上 glm-5.2 ↔ gpt-5.5 切换在此
      // 触发 engine teardown + compact transcript preamble;同 engine 内的模型
      // 切换仍由 submit() 的 setModel + shutdown 处理。
      model: safeModel,
      ...(safeModelSwitchId ? { modelSwitchId: safeModelSwitchId } : {}),
      // 无 envelope 的本地 inbound:catalog 投影就是本 turn 的权威(canonicalModel + engine)。
      // flag 未开 → localExec 恒 undefined → 展开为 {},行为零变化。
      ...localExecutionOverride(localExec),
      // 方案 §2:有签名 descriptor 的 turn,engine + canonicalModel 直接落地,
      // sessionManager 内的两张 baked 表(白名单 / MODEL_ENGINE_MAP)不参与判定。
      ...(turnAuthority !== undefined
        ? {
            executionAuthority: {
              canonicalModel: turnAuthority.canonicalModel,
              engine: turnAuthority.engine,
              source: 'bridge_signed' as const,
            },
          }
        : {}),
      ...(promptQueueExecutionFence ? { promptQueueExecutionFence } : {}),
    })
    admitCmid =
      typeof safeClientMessageId === 'string' && safeClientMessageId !== ''
        ? safeClientMessageId
        : undefined
    admitSession = session
    if (admitCmid) session._admittingClientMessageId = admitCmid
    const wechatDispatchStarted = (frame as any)._wechatDispatchStarted
    if (typeof wechatDispatchStarted === 'function') {
      try {
        wechatDispatchStarted({
          traceId: turnTraceId,
          sessionKey,
          agentId: effectiveAgent.id,
        })
      } catch {}
      // biome-ignore lint/performance/noDelete: moved verbatim from server.ts (OCV5-483); pre-existing there
      delete (frame as any)._wechatDispatchStarted
    }
    const out: OutboundMessage = {
      type: 'outbound.message',
      sessionKey,
      channel: frame.channel,
      peer: frame.peer,
      ...(safeClientMessageId ? { clientMessageId: safeClientMessageId } : {}),
      blocks: [],
      isFinal: false,
      // V3 S12e CG7 — turn-level trace id. Stamped on the main `out` so every
      // streamed block / final frame derived from `out` carries it; derived
      // frames(error / permission_request / codex_billing)copy it via
      // `_inheritOutboundRouting(out)`.
      traceId: turnTraceId,
    }
    // Private userId stamp for deliver() — must be stripped before sending.
    // Fixed in deliver() via destructure so this never reaches the wire.
    ;(out as any)._userId = activeUserId
    // Most adapters (Telegram / Feishu / legacy WeChat) can't take 30 small
    // messages per second, so they keep the historical "aggregate and send on
    // final" behavior.  The v3 WeChat broker is now deliberately different:
    // the WeChat/iLink reply surface is treated as non-streaming because it
    // empirically stalls around the 10th reply under one context_token.  For a
    // WeChat-originated turn we stream full process to the linked Web session
    // (normal webchat channel/ring) and send only the final/error text back
    // through the v3-wechat-outbound adapter.
    const aggregatedBlocks: typeof out.blocks = []
    const liveWechatAdapter =
      adapter?.id === V3_WECHAT_OUTBOUND_ADAPTER_ID || adapter?.id === V3_QQBOT_OUTBOUND_ADAPTER_ID
    let liveWechatSendQueue: Promise<void> = Promise.resolve()
    let liveWechatSeq = 0
    const liveOutboundBase =
      turnTraceId.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 80) ||
      `wechat${Date.now().toString(36)}`

    const addAggregatedBlock = (block: (typeof out.blocks)[number]) => {
      const blockWithId = block as any
      if (blockWithId.blockId) {
        const idx = aggregatedBlocks.findIndex((x: any) => x.blockId === blockWithId.blockId)
        if (idx >= 0) aggregatedBlocks[idx] = block
        else aggregatedBlocks.push(block)
      } else {
        aggregatedBlocks.push(block)
      }
    }

    const nextLiveWechatOutboundId = (kind: string): string => {
      const safeKind = kind.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'msg'
      return `${liveOutboundBase}.wxlive.${(++liveWechatSeq).toString(36)}.${safeKind}`
    }

    const enqueueLiveWechatMessage = (
      blocks: typeof out.blocks,
      isFinal: boolean,
      kind: string,
      meta?: any,
    ): boolean => {
      if (!adapter || blocks.length === 0) return false
      const msg = {
        ...out,
        blocks: blocks.slice(),
        isFinal,
        ...(meta !== undefined ? { meta } : {}),
        outboundId: nextLiveWechatOutboundId(kind),
      } as OutboundMessage & { outboundId: string }
      // `deliver(..., adapter)` is intentionally fire-and-forget.  Live WeChat
      // sends need stronger ordering: process₁ → process₂ → final must enqueue
      // at master in that order, otherwise the old "final then replay process"
      // symptom can still happen under HTTP/DB scheduling jitter.
      liveWechatSendQueue = liveWechatSendQueue.then(async () => {
        try {
          await this._sendAdapterOutboundMessage(msg, adapter)
        } catch (err) {
          this.log.error('adapter send failed', { channel: adapter.name }, err)
        }
      })
      return true
    }

    // ── Multimodal handling ──
    // Save all uploaded media to local disk and inject descriptive prompt hints
    // so the agent knows how to access them via MCP tools or Read.
    const text = formatMessageReplyPrompt(
      frame.content.text ?? '',
      normalizeMessageReplyQuote(frame.content.replyTo),
    )
    const media = frame.content.media ?? []
    const rawImageEdit = frame.content.imageEdit
    const externalTurnGuard = rawImageEdit
      ? await this.sessions.beginExternalTurn(session, {
          queueTurn: Boolean(promptQueueLifecycle),
          ...(promptQueueExecutionFence ? { queueExecutionFence: promptQueueExecutionFence } : {}),
          ...(safeClientMessageId ? { clientMessageId: safeClientMessageId } : {}),
        })
      : null
    let externalTurnCompleted = false
    let externalQueueReservation: PromptQueueExternalTurnReservation | undefined
    let externalQueueLifecycleOwned = false
    let externalQueuePersistAttempted = false
    let externalQueueTerminalText: string | undefined
    let externalQueueError: unknown | undefined
    let imageEditJobId: string | null = null
    let imageEditOutputPath: string | null = null
    try {
      // Server-side upload validation. MIME is untrusted metadata and all formats
      // are admitted; size limits remain shared with handleUpload (POST /api/uploads).
      // 件数上限走 protocol 单一权威源 MAX_ATTACHMENTS_PER_MESSAGE(=前端 Composer
      // 同源),消除历史"前端 8 / 后端 5"漂移导致的"上传成功却被拒"。
      const MAX_FILES_PER_FRAME = MAX_ATTACHMENTS_PER_MESSAGE
      // text-kind attachments 在前端 buildMessageText() 阶段就拼进 content.text,
      // 绕过了下面基于 m.base64 的 per-file 校验。给 content.text 整体上限兜底,
      // 防止 (a) 绕前端构造巨 text 帧 (b) 大 text 附件 + 大正文叠加超 300 MB 契约。
      const textByteLen = Buffer.byteLength(text, 'utf8')
      if (textByteLen > MAX_UPLOAD_TOTAL) {
        if (promptQueueLifecycle) {
          ;(frame as any).__oc_prompt_queue_preflight_rejection = {
            disposition: 'user_action_required',
            reasonCode: 'CONTENT_TOO_LARGE',
          }
        }
        const errMsg = `消息文本超过 ${MAX_UPLOAD_TOTAL / 1024 / 1024}MB 限制 (${(textByteLen / 1024 / 1024).toFixed(1)}MB)`
        this.log.warn('upload rejected: text too large', {
          reason: errMsg,
          textByteLen,
          sessionKey,
        })
        this.deliver(
          {
            type: 'outbound.message',
            sessionKey: sessionKey!,
            channel: frame.channel,
            peer: frame.peer,
            blocks: [{ kind: 'text', text: `⚠️ 上传失败: ${errMsg}` }],
            isFinal: true,
            traceId: turnTraceId,
          },
          adapter,
        )
        return
      }
      const rejectFrame = (reason: string, ctx?: Record<string, unknown>) => {
        if (promptQueueLifecycle) {
          ;(frame as any).__oc_prompt_queue_preflight_rejection = {
            disposition: 'user_action_required',
            reasonCode: 'ATTACHMENT_INVALID',
          }
        }
        this.log.warn('upload rejected', { reason, sessionKey, ...ctx })
        this.deliver(
          {
            type: 'outbound.message',
            sessionKey: sessionKey!,
            channel: frame.channel,
            peer: frame.peer,
            blocks: [{ kind: 'text', text: `⚠️ 上传失败: ${reason}` }],
            isFinal: true,
            traceId: turnTraceId,
          },
          adapter,
        )
      }
      if (media.length > MAX_FILES_PER_FRAME) {
        rejectFrame(`附件数量超过 ${MAX_FILES_PER_FRAME} 个限制 (${media.length})`)
        return
      }
      let totalMediaSize = 0
      // First pass — validate base64 (legacy) entries the same way as before so
      // old web bundles still get correct 4xx-style WS error frames.
      for (const m of media) {
        if (!m.base64) continue
        const rawLen = m.base64.length
        const byteLen = Math.ceil(rawLen * 0.75) // base64 → bytes approx
        if (byteLen > MAX_UPLOAD_SINGLE) {
          rejectFrame(
            `附件超过 ${MAX_UPLOAD_SINGLE / 1024 / 1024}MB 限制 (${(byteLen / 1024 / 1024).toFixed(1)}MB)`,
            { byteLen },
          )
          return
        }
        totalMediaSize += byteLen
        if (totalMediaSize > MAX_UPLOAD_TOTAL) {
          rejectFrame(`总附件超过 ${MAX_UPLOAD_TOTAL / 1024 / 1024}MB 限制`, { totalMediaSize })
          return
        }
        const mime = m.mimeType || ''
        if (mime && !isUploadMimeAllowed(mime)) {
          rejectFrame(`不支持的文件类型: ${mime}`, { mime })
          return
        }
      }

      type SavedMedia = {
        mediaIndex: number
        kind: string
        path: string
        name: string
        mimeType: string
        sizeHint: string
      }
      const savedMedia: SavedMedia[] = []

      // Resolve uploadsDir realpath once, after ensuring it exists. Any url-only
      // resolution must land inside this canonical path (symlink escape guard).
      let baseReal: string | null = null
      try {
        await mkdir(paths.uploadsDir, { recursive: true })
        baseReal = realpathSync(paths.uploadsDir)
      } catch (err) {
        this.log.error('dispatchInbound: uploadsDir setup failed', undefined, err)
        rejectFrame('存储目录不可用')
        return
      }

      for (const [mediaIndex, m] of media.entries()) {
        // ── New url-only path (Plan B) ──
        if (!m.base64 && m.url) {
          const match = m.url.match(/^\/api\/media\/(.+)$/)
          if (!match) {
            rejectFrame(`非法媒体引用: ${m.url}`)
            return
          }
          let filename: string
          try {
            filename = decodeURIComponent(match[1])
          } catch {
            rejectFrame('媒体引用编码错误')
            return
          }
          if (filename.includes('..') || filename.startsWith('/') || filename.startsWith('\\')) {
            rejectFrame('非法媒体路径')
            return
          }
          const candidate = resolve(baseReal, filename)
          // biome-ignore lint/style/useTemplate: moved verbatim from server.ts (OCV5-483); pre-existing there
          if (!candidate.startsWith(baseReal + '/') && candidate !== baseReal) {
            rejectFrame('媒体路径越界')
            return
          }
          let realPath: string
          try {
            realPath = realpathSync(candidate)
          } catch {
            rejectFrame('媒体不存在或不可读')
            return
          }
          // biome-ignore lint/style/useTemplate: moved verbatim from server.ts (OCV5-483); pre-existing there
          if (!realPath.startsWith(baseReal + '/')) {
            rejectFrame('媒体路径越界')
            return
          }
          let stat: ReturnType<typeof statSync>
          try {
            stat = statSync(realPath)
          } catch {
            rejectFrame('媒体不可读')
            return
          }
          // Codex B1 review fix: ensure it's a regular file. uploadsDir could
          // theoretically contain directories, fifos, sockets, or device nodes
          // (e.g. if an admin extracted a tarball there). Same guard the GET
          // /api/media path applies via fstatSync().isFile().
          if (!stat.isFile()) {
            rejectFrame('媒体类型非文件')
            return
          }
          // Aggregate against MAX_UPLOAD_TOTAL — same budget the legacy base64
          // path uses, so a malicious frame referencing many already-uploaded
          // /api/media URLs can't bypass the per-frame ceiling.
          totalMediaSize += stat.size
          if (totalMediaSize > MAX_UPLOAD_TOTAL) {
            rejectFrame(`总附件超过 ${MAX_UPLOAD_TOTAL / 1024 / 1024}MB 限制`, { totalMediaSize })
            return
          }
          const mimeType = m.mimeType || mimeFor(realPath) || 'application/octet-stream'
          savedMedia.push({
            mediaIndex,
            kind: m.kind,
            path: realPath,
            name: m.filename ?? basename(realPath),
            mimeType,
            sizeHint: `${(stat.size / 1024).toFixed(1)}KB`,
          })
          continue
        }
        // ── Legacy base64 path (compat window for old web bundles) ──
        let base64 = m.base64 ?? ''
        if (!base64) continue
        const prefixMatch = base64.match(/^data:([^;]+);base64,(.*)$/)
        const mimeType = prefixMatch ? prefixMatch[1] : (m.mimeType ?? 'application/octet-stream')
        if (prefixMatch) base64 = prefixMatch[2]
        const ext = uploadExtForMime(mimeType, m.filename)
        const defaultName =
          m.kind === 'image'
            ? 'image'
            : m.kind === 'audio'
              ? 'audio'
              : m.kind === 'video'
                ? 'video'
                : 'file'
        const safeBase = (m.filename ?? defaultName).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40)
        const fname = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeBase}.${ext}`
        const fpath = join(baseReal, fname)
        try {
          await writeFile(fpath, Buffer.from(base64, 'base64'))
          const sizeKb = (Buffer.byteLength(base64, 'base64') / 1024).toFixed(1)
          savedMedia.push({
            mediaIndex,
            kind: m.kind,
            path: fpath,
            name: m.filename ?? fname,
            mimeType,
            sizeHint: `${sizeKb}KB`,
          })
        } catch (err) {
          this.log.warn('dispatchInbound failed to save upload', { kind: m.kind }, err)
        }
      }

      if (rawImageEdit !== undefined) {
        const rejectEdit = (reason: string) => {
          rejectFrame(`图片标注无效: ${reason}`)
        }
        if (
          rawImageEdit === null ||
          typeof rawImageEdit !== 'object' ||
          typeof rawImageEdit.clientJobId !== 'string' ||
          !/^[0-9a-f]{32}$/.test(rawImageEdit.clientJobId)
        ) {
          rejectEdit('任务标识无效')
          return
        }
        const effectiveModel = safeModel ?? effectiveAgent.model ?? ''
        if (!isCodexEngineModel(effectiveModel)) {
          rejectEdit('当前模型不支持 Image 2 精确修改')
          return
        }
        // Two paid image-edit shapes share this deterministic delivery path:
        //   - annotated (default / comment): user-drawn mask, media=[source,mask,guide]
        //   - outpaint (resize aspect):      no user mask,   media=[source,guide]
        // The relay bills both as annotated_edit (50 credits) — only the prepare/
        // composite geometry differs. mode omitted ⇒ annotated (old-client compat).
        const isOutpaint = rawImageEdit.mode === 'outpaint'
        const resolveImageMedia = (mediaIndex: number) =>
          savedMedia.find((m) => m.mediaIndex === mediaIndex)
        let source: SavedMedia | undefined
        let mask: SavedMedia | undefined
        let guide: SavedMedia | undefined
        let outpaintAspect: OutpaintAspect | null = null
        if (isOutpaint) {
          if (!isOutpaintAspect(rawImageEdit.targetAspect)) {
            rejectEdit('目标比例无效')
            return
          }
          outpaintAspect = rawImageEdit.targetAspect
          const indices = [rawImageEdit.sourceIndex, rawImageEdit.guideIndex]
          if (
            !indices.every((n) => Number.isInteger(n) && n >= 0 && n < media.length) ||
            new Set(indices).size !== 2
          ) {
            rejectEdit('媒体索引错误')
            return
          }
          source = resolveImageMedia(rawImageEdit.sourceIndex)
          guide = resolveImageMedia(rawImageEdit.guideIndex)
          if (!source || !guide || source.kind !== 'image' || guide.kind !== 'image') {
            rejectEdit('源图或标注图缺失')
            return
          }
        } else {
          const maskIndex = rawImageEdit.maskIndex
          if (typeof maskIndex !== 'number' || !Number.isInteger(maskIndex)) {
            rejectEdit('遮罩索引缺失')
            return
          }
          const indices = [rawImageEdit.sourceIndex, maskIndex, rawImageEdit.guideIndex]
          if (
            !indices.every((n) => Number.isInteger(n) && n >= 0 && n < media.length) ||
            new Set(indices).size !== 3
          ) {
            rejectEdit('媒体索引错误')
            return
          }
          source = resolveImageMedia(rawImageEdit.sourceIndex)
          mask = resolveImageMedia(maskIndex)
          guide = resolveImageMedia(rawImageEdit.guideIndex)
          if (!source || !mask || !guide || [source, mask, guide].some((m) => m.kind !== 'image')) {
            rejectEdit('源图、遮罩或标注图缺失')
            return
          }
        }
        if (!source || !guide) {
          rejectEdit('媒体解析失败')
          return
        }
        let imageRuntimeStarted = false
        try {
          const [sourceMeta, orientedSource, guideMeta, sourceBytes] = await Promise.all([
            sharp(source.path).metadata(),
            orientedImageDimensions(source.path),
            sharp(guide.path).metadata(),
            readFile(source.path),
          ])
          if (!['png', 'jpeg', 'webp'].includes(sourceMeta.format ?? ''))
            throw new Error('源图格式不受支持')
          if (!['png', 'jpeg', 'webp'].includes(guideMeta.format ?? ''))
            throw new Error('标注预览格式不受支持')
          if (
            orientedSource.width !== rawImageEdit.width ||
            orientedSource.height !== rawImageEdit.height
          ) {
            throw new Error('源图尺寸不一致')
          }
          if (rawImageEdit.width * rawImageEdit.height > 16_777_216) throw new Error('图片像素过大')
          // annotated 才有用户 mask;outpaint 无 mask(relay 按 targetAspect 合成)。
          let normalizedMaskBytes: Buffer | null = null
          if (!isOutpaint) {
            const [maskMeta, maskBytes] = await Promise.all([
              sharp(mask!.path).metadata(),
              readFile(mask!.path),
            ])
            if (maskMeta.format !== 'png') throw new Error('遮罩必须为 PNG')
            normalizedMaskBytes = await normalizeImageEditMask(maskBytes, orientedSource)
          }
          // 最终输出尺寸:annotated 与源图同尺寸;outpaint 按目标比例外扩(单一权威)。
          const expectedDims = isOutpaint
            ? outpaintTargetDimensions(rawImageEdit.width, rawImageEdit.height, outpaintAspect!)
            : { width: rawImageEdit.width, height: rawImageEdit.height }
          imageEditJobId = rawImageEdit.clientJobId
          const outputPath = resolve(paths.generatedDir, `image2-edit-${imageEditJobId}.png`)
          if (dirname(outputPath) !== resolve(paths.generatedDir)) throw new Error('输出路径越界')
          if (existsSync(outputPath)) {
            try {
              const existingMeta = await sharp(outputPath, { failOn: 'error' }).metadata()
              if (
                existingMeta.format === 'png' &&
                existingMeta.width === expectedDims.width &&
                existingMeta.height === expectedDims.height
              )
                imageEditOutputPath = outputPath
            } catch {
              // A partial/corrupt local artifact is not a successful recovery;
              // the trusted relay cache below remains the source of truth.
            }
          }
          let relayRequest: {
            masterBaseUrl: string
            containerToken: string
            body: string
          } | null = null
          if (!imageEditOutputPath) {
            const relayCfg = readV3CodexRelayConfig(process.env)
            if (!relayCfg) throw new Error('商业版图片计费通道未配置')
            relayRequest = {
              masterBaseUrl: relayCfg.masterBaseUrl,
              containerToken: relayCfg.containerToken,
              body: JSON.stringify({
                jobId: imageEditJobId,
                prompt: text,
                width: rawImageEdit.width,
                height: rawImageEdit.height,
                sourceBase64: sourceBytes.toString('base64'),
                ...(isOutpaint
                  ? { outpaint: { aspect: outpaintAspect } }
                  : { maskBase64: normalizedMaskBytes!.toString('base64') }),
              }),
            }
          }

          // Queue ImageEdit stays a turn-boundary execution. Activate the exact
          // durable turn before either a paid relay request or cached delivery;
          // from here on every exit persists this reservation and settles it.
          if (promptQueueLifecycle) {
            externalQueueReservation = await this.sessions.reservePromptQueueExternalTurn(
              session,
              promptQueueLifecycle,
              turnTraceId,
            )
            externalQueueLifecycleOwned = true
            this._promptQueueLifecycleByFrame.delete(frame as object)
            this._promptQueueExecutionFenceByFrame.delete(frame as object)
          }

          if (relayRequest) {
            const relayUrl = `${relayRequest.masterBaseUrl}${V3_CODEX_RELAY_PREFIX}/backend-api/codex/images/annotated-edits`
            let lastDeliveryError: unknown = null
            imageRuntimeStarted = true
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                const generated = await fetch(relayUrl, {
                  method: 'POST',
                  headers: {
                    authorization: `Bearer ${relayRequest.containerToken}`,
                    'content-type': 'application/json',
                    'x-openclaude-image-job': imageEditJobId,
                  },
                  body: relayRequest.body,
                  signal: externalTurnGuard?.signal,
                })
                const generatedBody = (await generated.json()) as {
                  data?: Array<{ b64_json?: string }>
                  error?: { code?: string; message?: string }
                }
                const encoded = generatedBody.data?.[0]?.b64_json
                if (
                  !generated.ok ||
                  generatedBody.data?.length !== 1 ||
                  typeof encoded !== 'string'
                ) {
                  throw Object.assign(
                    new Error(
                      generatedBody.error?.message ?? `Image 2 生成失败 (${generated.status})`,
                    ),
                    {
                      imageCode: generatedBody.error?.code,
                      imageStatus: generated.status,
                      noRetry: generated.status !== 409 && generated.status < 500,
                    },
                  )
                }
                const finalImage = Buffer.from(encoded, 'base64')
                const finalMeta = await sharp(finalImage, { failOn: 'error' }).metadata()
                if (
                  finalMeta.format !== 'png' ||
                  finalMeta.width !== expectedDims.width ||
                  finalMeta.height !== expectedDims.height
                ) {
                  throw new Error('Image 2 返回图片尺寸异常')
                }
                const tmpOutputPath = `${outputPath}.${process.pid}.tmp`
                try {
                  await writeFile(tmpOutputPath, finalImage, { mode: 0o600 })
                  await rename(tmpOutputPath, outputPath)
                } catch (err) {
                  try {
                    unlinkSync(tmpOutputPath)
                  } catch {}
                  throw err
                }
                imageEditOutputPath = outputPath
                break
              } catch (err) {
                if (externalTurnGuard?.signal.aborted) throw err
                if ((err as { noRetry?: boolean }).noRetry) throw err
                lastDeliveryError = err
              }
            }
            if (!imageEditOutputPath) throw lastDeliveryError ?? new Error('Image 2 服务连接失败')
          }
        } catch (err) {
          externalQueueError = err
          if (externalTurnGuard?.signal.aborted) {
            externalQueueTerminalText = '[error] 图片任务已中断。'
            return
          }
          const imageCode = (err as { imageCode?: string }).imageCode
          if (imageRuntimeStarted) {
            const rateLimited =
              (err as { imageStatus?: number }).imageStatus === 429 ||
              imageCode === 'IMAGE_DAILY_LIMIT' ||
              imageCode === 'IMAGE_ATTEMPT_LIMIT' ||
              imageCode === 'IMAGE_SERVER_BUSY'
            const insufficient = imageCode === 'ERR_INSUFFICIENT_CREDITS'
            // 失败原因透传(relay 已把上游失败归类成稳定 code,这里本地化成人话)。
            const rejectionMessage =
              imageCode === 'IMAGE_UPSTREAM_REJECTED_FORMAT'
                ? '图片服务拒绝了请求格式，请稍后重试。'
                : imageCode === 'IMAGE_UPSTREAM_REJECTED_IMAGE'
                  ? '图片数据无法被识别，请更换图片后重试。'
                  : imageCode === 'IMAGE_UPSTREAM_REJECTED_MODERATION'
                    ? '图片内容被安全策略拦截，请更换图片。'
                    : imageCode === 'IMAGE_UPSTREAM_REJECTED'
                      ? '图片服务拒绝了本次请求，请更换图片或稍后重试。'
                      : null
            const message = insufficient
              ? '积分不足，Image 2 每张需要 50 积分。'
              : rateLimited
                ? 'Image 2 当前繁忙或已达使用上限，请稍后重试。'
                : (rejectionMessage ?? 'Image 2 服务暂时不可用，请稍后重试。')
            externalQueueTerminalText = `[error] ${message}`
            // E4.3/E5 — detail 不再携带上游原始错误串(只留 traceId);原文进日志。
            this.log.warn('image job failed (raw detail logged here only)', {
              sessionKey: out.sessionKey,
              error: err instanceof Error ? err.message : String(err),
              ...(out.traceId ? { traceId: out.traceId } : {}),
            })
            const errorFrame: OutboundError & { _userId?: string } = {
              type: 'outbound.error',
              ..._inheritOutboundRouting(out),
              code: insufficient
                ? 'insufficient_credits'
                : rateLimited
                  ? 'rate_limited'
                  : 'upstream_failed',
              message,
              ...(out.traceId ? { detail: out.traceId } : {}),
              isFinal: false,
            }
            this.deliver(errorFrame, adapter)
            this.deliver(
              {
                ...out,
                blocks: [{ kind: 'text', text: `[error] ${message}` }],
                isFinal: true,
              } as OutboundMessage,
              adapter,
            )
          } else {
            rejectEdit(err instanceof Error ? err.message : '图片校验失败')
          }
          return
        }
      }

      // Paid image edits are delivered deterministically by the gateway. Do not
      // start a second Codex turn: model failure could hide an already-charged
      // image, and model non-compliance could invoke imagegen a second time.
      if (imageEditOutputPath && imageEditJobId) {
        const responseText =
          rawImageEdit?.mode === 'outpaint'
            ? `已完成画面比例调整（Image 2 · 50 积分）。\n\n${imageEditOutputPath}`
            : `已完成圈选区域的精确修改（Image 2 · 50 积分）。\n\n${imageEditOutputPath}`
        externalQueueTerminalText = responseText
        externalQueuePersistAttempted = Boolean(externalQueueReservation)
        const externalTurn = await this.sessions.recordExternalTurn(
          session,
          {
            userText: text,
            assistantText: responseText,
            requestId:
              typeof frame.requestId === 'string' && /^[0-9a-f]{32}$/.test(frame.requestId)
                ? frame.requestId
                : imageEditJobId,
            traceId: turnTraceId,
            model: 'gpt-image-2',
            ...(chatWorkspace.chatProjectId !== undefined
              ? { chatProjectId: chatWorkspace.chatProjectId }
              : {}),
          },
          externalQueueReservation,
        )
        const delivered = {
          type: 'outbound.message' as const,
          sessionKey,
          channel: frame.channel,
          peer: frame.peer,
          blocks: [
            { kind: 'text' as const, text: responseText, messageId: externalTurn.messageId },
          ],
          isFinal: true,
          // 回带 clientJobId(=占位卡 _genPlaceholder.jobId),前端据此把「生成中」
          // 粒子占位卡原位替换为结果图。annotated / outpaint 走同一交付口径。
          imageEditJobId,
          traceId: turnTraceId,
          _userId: activeUserId,
        }
        externalTurnCompleted = true
        this.deliver(delivered as OutboundMessage, adapter)
        return
      }

      let finalText = text
      if (savedMedia.length > 0) {
        const images = savedMedia.filter((m) => m.kind === 'image')
        const audios = savedMedia.filter((m) => m.kind === 'audio')
        const videos = savedMedia.filter((m) => m.kind === 'video')
        const files = savedMedia.filter((m) => m.kind === 'file')

        const lines = [text]

        if (images.length > 0) {
          lines.push(
            '',
            '---',
            buildImageAttachmentHint({
              paths: images.map((ip) => ({
                path: ip.path,
                mimeType: ip.mimeType,
                sizeHint: ip.sizeHint,
                name: ip.name,
              })),
            }),
          )
        }

        if (audios.length > 0) {
          lines.push('', '---', '用户附带了以下音频文件(已保存到服务器本地):')
          for (const a of audios) {
            lines.push(`- \`${a.path}\` (${a.mimeType}, ${a.sizeHint}, 原名: ${a.name})`)
          }
          lines.push(
            '',
            '如果有 STT (语音转文字) 工具可用,请帮用户转录音频内容;否则告知用户音频文件已保存。',
          )
        }

        if (videos.length > 0) {
          lines.push('', '---', '用户附带了以下视频文件(已保存到服务器本地):')
          for (const v of videos) {
            lines.push(`- \`${v.path}\` (${v.mimeType}, ${v.sizeHint}, 原名: ${v.name})`)
          }
          lines.push('', '当前没有视频理解工具。告知用户视频文件已保存,路径如上。')
        }

        if (files.length > 0) {
          // 对 .docx / .pdf 在 gateway 端预解析为 markdown 直接塞进 prompt;
          // 失败/不支持的格式回退到原来的"路径告知 + Read"。alice 的痛点是上传
          // .doc 失败被迫粘 60KB,即便上传成功 agent 也读不了二进制 —— 这里先解析。
          //
          // 并发上限 3:多 PDF 串行会让首字延迟到 ~30s × N。完全 Promise.all 又
          // 会同时开 N 个 pdfjs worker 撑爆内存(科研用户偶尔丢 5+ 篇论文)。
          // 折中:每批 3 个并行,顺序保留(parsedDocs/unparsedFiles 按 files 顺序排)。
          const PARSE_CONCURRENCY = 3
          type ParsedDoc = {
            file: SavedMedia
            markdown: string
            truncated: boolean
            parser: string
          }
          const parsedDocs: ParsedDoc[] = []
          const unparsedFiles: SavedMedia[] = []
          for (let i = 0; i < files.length; i += PARSE_CONCURRENCY) {
            const batch = files.slice(i, i + PARSE_CONCURRENCY)
            const results = await Promise.all(
              batch.map(async (f) => ({
                file: f,
                result: await parseDocument(f.path, f.mimeType),
              })),
            )
            for (const { file: f, result } of results) {
              if (result) parsedDocs.push({ file: f, ...result })
              else unparsedFiles.push(f)
            }
          }

          for (const doc of parsedDocs) {
            lines.push(
              '',
              '---',
              `**用户上传的文档**:\`${doc.file.name}\` (${doc.file.mimeType}, ${doc.file.sizeHint})`,
              `_已由 ${doc.parser} 在服务端预解析为 markdown,内容如下_${doc.truncated ? ' **(已截断)**' : ''}:`,
              '',
              doc.markdown,
              '',
              `_(原文件保存在服务器:\`${doc.file.path}\`,如需访问图片/附件可用 Read)_`,
            )
          }

          if (unparsedFiles.length > 0) {
            lines.push(
              '',
              '---',
              '用户还附带了以下文档(已保存到服务器本地,gateway 没能预解析 ——',
              '可能因为格式不支持、解析失败或解析超时):',
            )
            for (const f of unparsedFiles) {
              lines.push(`- \`${f.path}\` (${f.mimeType}, ${f.sizeHint}, 原名: ${f.name})`)
            }
            lines.push(
              '',
              '可以用 Read 工具读取文档内容(对纯文本、CSV、源码、PDF 等都有效',
              '—— 大 PDF 即便预解析超时,Read 也可能能拿到部分文本)。',
              '若是 .doc 老格式 Word 二进制,Read 会看到乱码 —— 礼貌地请用户转存为 .docx 重传。',
            )
          }
        }

        finalText = lines.join('\n')
      }
      const requestedAdvisorModel =
        typeof (frame as { advisorModel?: unknown }).advisorModel === 'string'
          ? (frame as { advisorModel: string }).advisorModel.trim()
          : ''
      let frozenAdvisorModel = requestedAdvisorModel
      let advisorTurnAllowed = false
      if (inboundCollabMode === 'advisor' && agent.id === 'main' && !adapter) {
        const freeze = requestedAdvisorModel
          ? await this._freezeAdvisorTurn(requestedAdvisorModel)
          : { ok: false as const, error: 'advisorModel required' }
        if (freeze.ok) {
          const parentEngine = resolveEngine(
            safeModelForRouting ?? agent.model,
            agent,
            turnAuthority !== undefined
              ? { canonicalModel: turnAuthority.canonicalModel, engine: turnAuthority.engine }
              : undefined,
          )
          if (!isAdvisorConsultParentEngine(parentEngine)) {
            const _engineUserId: string =
              typeof (frame as any)._userId === 'string' ? (frame as any)._userId : 'default'
            this.log.warn('advisor_parent_engine_unsupported', {
              sessionKey,
              parentEngine,
            })
            const rejectFrames = _earlyRejectErrorFrames({
              sessionKey,
              channel: frame.channel,
              peer: frame.peer,
              userId: _engineUserId,
              traceId: turnTraceId,
              code: 'upstream_failed',
              message: ADVISOR_CONSULT_PARENT_REASON,
              legacyErrorText: `[error] advisor parent engine unsupported: ${parentEngine}`,
            })
            for (const f of rejectFrames) this.deliver(f, adapter)
            return
          }
          advisorTurnAllowed = true
          frozenAdvisorModel = freeze.advisorModel
          finalText = advisorPreamble('advisor') + finalText
        } else {
          const _errUserId: string =
            typeof (frame as any)._userId === 'string' ? (frame as any)._userId : 'default'
          this.log.warn('advisor_model_rejected', {
            sessionKey,
            requested: requestedAdvisorModel,
            error: freeze.error,
          })
          const rejectFrames = _earlyRejectErrorFrames({
            sessionKey,
            channel: frame.channel,
            peer: frame.peer,
            userId: _errUserId,
            traceId: turnTraceId,
            code: 'upstream_failed',
            message: `顾问模式无法启动：${freeze.error}`,
            legacyErrorText: `[error] advisor mode rejected: ${freeze.error}`,
          })
          for (const f of rejectFrames) this.deliver(f, adapter)
          return
        }
      }
      // 团队模式(v5 轻量组队):main 队长这一轮前置"组队引导"——列出可委派的已安装 agent
      // + 让它自主判断是否 delegate_task 组队(简单任务自己答)。turn 级,开关中途切立即生效;
      // 放在 media 拼接之后,确保带附件时引导也在。委派本身走内置 delegate_task,无需改工具。
      if (teamMode && agent.id === 'main') {
        const teamCfg = await this._getAgentsConfig()
        // 成员 = 市场安装集(source==='marketplace'),与 AgentPicker(master 市场安装权威)
        // 对齐、对存量容器的幽灵平台 seed 免疫。队长是 main 自己,故 includeMain:false。
        const members = listCollaboratorAgents(teamCfg, { selfId: 'main', includeMain: false })
        // 2026-09-04 团队模式重构(teamMode.ts):一个开关、两条策略。
        //   审议策略 = 同一问题并行派给多个**不同家族**型号(panel)+ 审查员当 analyst 做
        //   结构化对比;执行策略 = 领域拆分 + 审查员拿成员证据验收。panel 从 catalog 投影
        //   按家族多样性挑,排除队长本轮型号(队长自己已是一份视角)。投影拿不到 → 空 panel,
        //   preamble 自动降级成"审议不可用",不影响执行策略。
        const leaderModelForTeam =
          safeModelForRouting ?? agent.model ?? this.deps.config.defaults.model
        let panel: DeliberationPanelMember[] = []
        if (isModelAuthorityRequired()) {
          try {
            const view = await getLocalCatalogView()
            panel = pickDeliberationPanel(view, {
              excludeModel: leaderModelForTeam,
              requireLocalEngines: !isEngineLocalTurnExempt(process.env),
            })
          } catch (err) {
            this.log.warn('team_panel_catalog_unavailable', {
              sessionKey,
              error: (err as Error)?.message ?? String(err),
            })
          }
        }
        const cursorEngine =
          typeof leaderModelForTeam === 'string' && isCursorEngineModel(leaderModelForTeam)
        const teamPreamble = buildTeamPreamble({
          members,
          memberHint: teamMemberCapabilityHint,
          autoModelToken: AGENT_MODEL_AUTO,
          panel,
          leaderModel: leaderModelForTeam,
          cursorEngine,
        })
        this.log.info('team_mode_turn', {
          sessionKey,
          leaderModel: leaderModelForTeam,
          panel: panel.map((p) => p.modelId),
          members: members.map((m) => m.id),
        })
        finalText = teamPreamble + finalText
      }
      // Pass as plain text. No image content blocks — safer for non-multimodal providers.
      const payload: string = finalText
      const taskType = sessionKey.includes(':cron:')
        ? ('cron' as const)
        : sessionKey.includes(':delegate:')
          ? ('delegate' as const)
          : sessionKey.includes(':inter:')
            ? ('inter-agent' as const)
            : ('chat' as const)
      // 新用户 turn 开启 → 清零本会话的两个 per-turn 委派计数(hidden 审查员串行熔断 +
      // 普通成员每 turn 上限)。delegate 请求只带 parentSessionKey(没有 turn 级标识),
      // 所以"每 turn 上限"的 turn 边界由这里定义:同一 sessionKey 收到下一条入站用户消息
      // 即视为新 turn。
      this._hiddenDelegateGuard.resetForParent(sessionKey)
      this._memberDelegateGuard?.resetForParent(sessionKey)
      // P2 债C — 新 turn 起始清零"本 turn 是否发生过非隐藏委派"跟踪(与上面的熔断重置同点)。
      ;(this._turnDelegatedNonHiddenByParent ??= new Set()).delete(sessionKey)
      // 队长自主送审(2026-07-07 boss 裁决,取代 P2 债C 的 gateway 硬编排):审查触发权
      // 交还队长(preamble 纪律:除明显简单任务外都应经 request_review 送审),平台只提供
      // 送审通道 + 熔断(hidden guard ≤3/turn)+ 团队门(非团队 turn 拒绝)。final 不再被
      // 扣住,审查状态机/continuation/修订标记帧全部退役 —— 审查回到 turn
      // 内部后,"审查成本晚一轮归因"与"迟到团队卡补 drain"两笔债自然消失(审查委派在
      // engine persist 之前完成,走正常归因/drain)。此处只 stash 两个服务端权威快照,
      // 供 _runDelegateTask 的审查门与审查任务书包装读取:
      session._teamModeTurn = teamMode && agent.id === 'main' && !adapter
      session._collabModeTurn = agent.id === 'main' && !adapter ? inboundCollabMode : 'solo'
      const inboundConfigVersion = collabConfigVersionOf({
        mode: advisorTurnAllowed ? 'advisor' : session._collabModeTurn,
        advisorModel: frozenAdvisorModel,
      })
      session._advisorTurn = advisorTurnAllowed
        ? { advisorModel: frozenAdvisorModel, configVersion: inboundConfigVersion }
        : undefined
      session._currentTurnUserText = text ?? ''
      {
        const userText = text ?? ''
        let injected = payload
        if (userText && payload.endsWith(userText)) {
          injected = payload.slice(0, payload.length - userText.length)
        } else if (payload === userText) {
          injected = ''
        }
        session._injectedTurnConstraints =
          stripAdvisorPreambleFromInjected(injected).trim() || undefined
      }
      // Fire-and-forget shadow hook. It receives the turn's already-resolved agent,
      // canonical trace id and raw text only long enough to hash/rank them; no result
      // is fed back into prompt assembly or execution.
      this._skillShadowReporter?.observeTurn({
        traceId: turnTraceId,
        sessionKey,
        agentId: effectiveAgent.id,
        userMessage: text ?? '',
      })
      const currentRun = this._runLog.start({ agentId: session.agentId, sessionKey, taskType })
      let turnErrored = false
      let leaderFinalCount = 0
      let replayTerminalizedUnhandledError = false
      let autoDreamAssistantText = ''
      let autoDreamHasCanonicalApiError = false
      // P1-3 续 — CCB 用 createAssistantAPIErrorMessage 把 API 调用错误包成
      // "API Error: ..." 文本作为正常 assistant text 流出(不抛 process error),
      // 因此走的是 e.kind === 'block' + 'final' 的正常 turn 路径,绕开了下面
      // `e.kind === 'error'` 分支的 classifyRunError。这里在 turn 状态层补一次
      // 识别:任一 text block 整段以 "API Error: " 开头,且 classify 命中非
      // unknown(insufficient_credits / rate_limited / upstream_failed),就把
      // 这个 turn 当成已识别错误,转走与 e.kind === 'error' 分支一致的双帧 UX
      // (outbound.error + [error] text final),前端红卡 + 「去充值」CTA 同链路。
      // 不限 "turn 内首块" — sub-agent (Task) 路径下,主 agent 的 Agent tool_use
      // block 会先进 aggregatedBlocks,带这层守卫会让 sub-agent INSUFFICIENT_CREDITS
      // 永远拦不到。
      let _apiErrorIntercepted = false
      let _apiErrorText = ''
      let _pendingApiErrorFrame: (OutboundError & { _userId?: string }) | null = null
      let _pendingApiErrorFinalized = false
      const discardPendingApiErrorAttempt = () => {
        _apiErrorIntercepted = false
        _apiErrorText = ''
        _pendingApiErrorFrame = null
        _pendingApiErrorFinalized = false
      }
      const deliverPendingApiErrorTerminal = (): boolean => {
        if (!_pendingApiErrorFrame || !_pendingApiErrorFinalized) return false
        turnErrored = true
        session.currentTurnStatus = null
        this._runLog.complete(currentRun, { status: 'failed', error: _apiErrorText })
        if (frame.idempotencyKey && (frame as any)._idempotencyPreReserved) {
          this._updateWechatIdempotency(frame.idempotencyKey, { completed: true })
        }
        if (frame.idempotencyKey && !(frame as any)._idempotencyPreReserved) {
          this._seenIdempotencyKeys.delete(frame.idempotencyKey)
        }
        this.deliver(_pendingApiErrorFrame, liveWechatAdapter ? undefined : adapter)
        if (liveWechatAdapter) {
          const errBlocks = [{ kind: 'text', text: `[error] ${_apiErrorText}` } as any]
          this.deliver({ ...out, blocks: errBlocks, isFinal: true }, undefined)
          enqueueLiveWechatMessage(errBlocks, true, 'error')
        } else {
          this.deliver(
            { ...out, blocks: [{ kind: 'text', text: `[error] ${_apiErrorText}` }], isFinal: true },
            adapter,
          )
        }
        out.blocks.length = 0
        aggregatedBlocks.length = 0
        discardPendingApiErrorAttempt()
        return true
      }
      // 参数类型加宽为 GatewayStreamEvent(见 ccbMessageParser):error 事件可带
      // runner 预分类的 errorClass,turn_status 的 status 可为 retrying 形态。
      // SessionStreamEvent ⊆ GatewayStreamEvent,故本 handler 仍可下传给要求
      // SessionStreamEvent handler 的 sessions.submit()(函数参数逆变)。
      const onLeaderEvent = (e: GatewayStreamEvent) => {
        if (e.kind === 'block') {
          const b = e.block as any
          // tool_output_tail 是替换语义的快照(1Hz),且 sessionManager 现在让
          // bg-bash 在 turn 结束后跨 turn 继续 emit。如果累积到 out.blocks /
          // aggregatedBlocks 里,旧 turn 闭包会随 bash 生命周期持续增长内存。
          // 直接派送(WebChat)/丢弃(adapter,非流式不需要快照)即可。
          // 必须放在 _apiErrorIntercepted guard 之前:本 turn 先启动 bg bash 再
          // 命中 API_ERROR 时,parser 已允许 finalized 后的 bash_output_tail 进来,
          // 这里若被 API_ERROR 吞掉,前端会再次卡在第一行——回归到修复前的症状。
          if (b?.kind === 'tool_result') {
            noteForegroundBashToolResult({
              sessionKey,
              toolUseId: typeof b.toolUseBlockId === 'string' ? b.toolUseBlockId : '',
              toolName: typeof b.toolName === 'string' ? b.toolName : undefined,
              output: typeof b.output === 'string' ? b.output : '',
              parentToolUseId:
                typeof b.parentToolUseId === 'string' ? b.parentToolUseId : undefined,
            })
          }
          const isTail = b?.kind === 'tool_output_tail'
          if (isTail) {
            if (liveWechatAdapter) {
              this.deliver({ ...out, blocks: [e.block], isFinal: false }, undefined)
              return
            }
            if (adapter) return
            this.deliver({ ...out, blocks: [e.block], isFinal: false }, undefined)
            return
          }

          // turn 已被 API_ERROR 拦截 → 后续非 tail block 一律吞掉,等 final 关闭
          if (_apiErrorIntercepted) return

          // 检查 block 是否是可分类 API Error。
          // 故意不限定 "turn 必须为空":CCB 的 createAssistantAPIErrorMessage
          // 会作为独立 assistant message 流出,不会与正常 text 混在同一消息里;
          // 而 sub-agent (Task) 路径下,主 agent 的 Agent tool_use block 通常
          // 已先于 sub-agent 的 API Error text block 进入 aggregatedBlocks ——
          // 限"turn 空"会让 sub-agent 场景永远拦不到 (boss 决策 2B)。前端
          // _suppressLegacyErrorText 只 suppress 替代 final 帧本身的 [error] text,
          // 之前已 deliver 的正常 block 会保留显示(部分上下文 + 红卡的合理 UX)。
          const _b0 = e.block as { kind?: string; text?: string }
          if (
            _b0.kind === 'text' &&
            typeof _b0.text === 'string' &&
            _b0.text.startsWith('API Error:')
          ) {
            // Auto-Dream cadence is stricter than the user-facing classifier:
            // every canonical CCB API error is a failed source turn, including
            // unknown 4xx variants that intentionally keep the legacy UX.
            autoDreamHasCanonicalApiError = true
            const _cls = classifyRunError(_b0.text)
            _apiErrorIntercepted = true
            _apiErrorText = _b0.text
            // Every canonical API error gets the structured UX. Unknown
            // provider text is deliberately mapped to the generic retryable
            // category; the exact string remains available only in `detail`.
            _pendingApiErrorFrame = {
              type: 'outbound.error',
              ..._inheritOutboundRouting(out),
              code: _cls.code === 'unknown' ? 'upstream_failed' : _cls.code,
              message:
                _cls.code === 'unknown' ? '任务执行暂时中断，请直接重试本条消息' : _cls.message,
              detail: _b0.text,
              isFinal: false,
            }
            // Balance exhaustion is not retryable. Kill the rest of the agent
            // loop immediately instead of waiting for CCB to wind down.
            if (_cls.code === 'insufficient_credits') {
              try {
                session.runner.interrupt()
              } catch {
                /* */
              }
            }
            return
          }

          if (b.kind === 'text' && typeof b.text === 'string') {
            autoDreamAssistantText += b.text
          }

          if (liveWechatAdapter) {
            // WeChat itself only gets final/error text.  The linked Web session
            // receives the full detailed stream (thinking/tool/tool_result/text)
            // through the normal webchat path and outbound ring, so multi-hour
            // tasks remain observable without exercising iLink as an event log.
            if (b.kind === 'text') {
              addAggregatedBlock(e.block)
            }
            this.deliver({ ...out, blocks: [e.block], isFinal: false }, undefined)
          } else if (adapter) {
            addAggregatedBlock(e.block)
          } else {
            // WebChat: stream each block immediately via WS
            out.blocks.push(e.block)
            this.deliver({ ...out, blocks: [e.block], isFinal: false }, undefined)
          }
        } else if (e.kind === 'usage') {
          // Exact browser-turn progress only. Without the browser-authored
          // clientMessageId there is no safe card/turn owner, so do not emit an
          // ambiguous session-wide counter.
          if (!out.clientMessageId) return
          const usageFrame: OutboundTurnUsage & { _userId?: string } = {
            type: 'outbound.turn_usage',
            ..._inheritOutboundRouting(out),
            clientMessageId: out.clientMessageId,
            usage: e.usage,
          }
          this.deliver(usageFrame, adapter)
        } else if (e.kind === 'call_usage') {
          if (!out.clientMessageId) return
          const usageFrame: OutboundCallUsage & { _userId?: string } = {
            type: 'outbound.call_usage',
            ..._inheritOutboundRouting(out),
            clientMessageId: out.clientMessageId,
            call: e.call,
          }
          this.deliver(usageFrame, adapter)
        } else if (e.kind === 'final') {
          this.flushCcbLocalAgentPendingOnFinalize(session)
          leaderFinalCount++
          // Plan 2 — turn 终态前先清 turn_status cache。CCB 正常关 compact 会先
          // emit setSDKStatus(null)(parser → kind:'turn_status' status:null),
          // cache 在那一帧已经清空;这里是兜底:如果 CCB 因任何原因没发 status:null
          // 就直接到 final(异常退出 / parse error 跳过 status 帧),也保证 cache
          // 不会粘住。前端拿到 isFinal=true 自然回到空闲态,不依赖额外帧。
          session.currentTurnStatus = null
          if (_apiErrorIntercepted) {
            // SessionManager 只有在完整 attempt 收尾后才能判定是否安全自动重试。
            // 先暂存终态；若随后收到 retrying 就丢弃本次中间错误，只有整个 submit
            // 真正结束时才向用户下发红卡和兼容 final。
            _pendingApiErrorFinalized = true
            out.blocks.length = 0
            aggregatedBlocks.length = 0
            return
          }
          this._runLog.complete(currentRun, {
            status: 'completed',
            cost: e.meta?.cost,
            inputTokens: e.meta?.inputTokens,
            outputTokens: e.meta?.outputTokens,
            turn: e.meta?.turn,
          })
          if (frame.idempotencyKey && (frame as any)._idempotencyPreReserved) {
            this._updateWechatIdempotency(frame.idempotencyKey, { completed: true })
          }
          if (liveWechatAdapter) {
            // Web gets the normal stream above, then an empty final terminator.
            // WeChat gets exactly one final text message.  If the agent completed
            // with no assistant text (tools-only/interrupted edge), still send a
            // terminal marker so the user is not left with only the start link.
            const plated = hasPlatedAssistantOutput({
              blocks: [...aggregatedBlocks, ...out.blocks],
              extraText: autoDreamAssistantText,
            })
            if (!plated) {
              this.deliver(
                {
                  ...out,
                  blocks: [{ kind: 'text', text: EMPTY_COMPLETED_TURN_NOTICE } as any],
                  isFinal: false,
                },
                undefined,
              )
            }
            this.deliver({ ...out, blocks: [], isFinal: true, meta: e.meta }, undefined)
            const wechatFinalBlocks =
              aggregatedBlocks.length > 0
                ? aggregatedBlocks.slice()
                : ([{ kind: 'text', text: WECHAT_FINAL_EMPTY_TEXT } as any] as typeof out.blocks)
            enqueueLiveWechatMessage(wechatFinalBlocks, true, 'final', e.meta)
          } else if (adapter) {
            // adapter.send() 是 async,内部可能在 await 之后才读 wire.blocks。
            // 如果直接传 aggregatedBlocks,接着同步清空数组,adapter 读到的就是空。
            // 拷贝一份脱钩本地引用。
            this.deliver(
              { ...out, blocks: aggregatedBlocks.slice(), isFinal: true, meta: e.meta },
              adapter,
            )
          } else {
            const plated = hasPlatedAssistantOutput({
              blocks: [...aggregatedBlocks, ...out.blocks],
              extraText: autoDreamAssistantText,
            })
            if (!plated) {
              this.deliver(
                {
                  ...out,
                  blocks: [{ kind: 'text', text: EMPTY_COMPLETED_TURN_NOTICE } as any],
                  isFinal: false,
                },
                undefined,
              )
            }
            this.deliver({ ...out, blocks: [], isFinal: true, meta: e.meta }, undefined)
          }
          // 释放本轮聚合数组的内存。本闭包跨 turn 仍会被 sessionManager 的
          // 跨 turn message listener 调用(转发 bg-bash bash_output_tail);
          // 不清空的话 out.blocks / aggregatedBlocks 引用的旧 block 实例
          // 会被钉到下一轮 listener 替换之前。
          out.blocks.length = 0
          aggregatedBlocks.length = 0
        } else if (e.kind === 'permission_request') {
          // Forward permission prompt to WebSocket clients for user approval.
          // userId is stashed on the frame by the WS handler (see handleWsConnection)
          // so adapter-dispatched frames fall back to 'default'. On personal-edition
          // (single-user) this is always 'default' in practice.
          const dispatchUserId: string =
            typeof (frame as any)._userId === 'string' ? (frame as any)._userId : 'default'
          const peerKey = makePeerKey(dispatchUserId, frame.channel, frame.peer.id)
          // CG7 — derived frame inherits routing + traceId from main `out`.
          // Note: legacy code wrote `sessionKey`(local var)= main `out.sessionKey`
          // and `frame.channel/peer`= main `out.channel/peer`. The helper unifies
          // both to read from `out`, which is correct: `out` is the source of
          // truth for this turn's routing tuple after model-routing has settled
          // any agent-override sessionKey.
          // ccbAdapter registers the requestId before emitting, so for CCB this
          // getter is already true here; Codex exposes its own blocking state.
          const blockingUserInput =
            _isBlockingUserInputTool(e.request.toolName) &&
            session.runner.waitingForUserInput === true
          const permissionExpiresAt = _permissionRequestExpiresAt(blockingUserInput)
          const permFrame = {
            type: 'outbound.permission_request' as const,
            ..._inheritOutboundRouting(out),
            requestId: e.request.requestId,
            toolName: e.request.toolName,
            toolUseId: e.request.toolUseId,
            inputPreview: JSON.stringify(e.request.input).slice(0, 400),
            inputJson: e.request.input,
            expiresAt: permissionExpiresAt,
          }
          // Permission requests only make sense for interactive clients (WebChat)
          // Non-interactive adapters auto-deny.
          if (adapter && !liveWechatAdapter) {
            session.runner.sendPermissionResponse(e.request.requestId, {
              behavior: 'deny',
              message: 'Permission prompts not supported on this channel',
              toolUseID: e.request.toolUseId,
            })
          } else {
            // Register regardless of current websocket presence. A brief mobile
            // suspend or Master restart must not be interpreted as a denial; the
            // stamped ring replays this exact request after reconnect.
            this._pendingPermissions.set(e.request.requestId, {
              sessionKey,
              toolName: e.request.toolName,
              input: e.request.input,
              toolUseId: e.request.toolUseId,
              ...(isClientMessageId(out.clientMessageId)
                ? { clientMessageId: out.clientMessageId }
                : {}),
              peerKey,
              userId: dispatchUserId,
              channel: frame.channel,
              peer: frame.peer,
              expiresAt: permissionExpiresAt,
              ...(blockingUserInput ? { blockingUserInput: true } : {}),
            })
            this._sendStampedSessionFrame(sessionKey, peerKey, permFrame)
          }
        } else if (e.kind === 'task_notification') {
          void this.handleCcbLocalAgentNotification(session, {
            taskId: e.taskId,
            status: e.status,
            outputFile: e.outputFile,
            summary: e.summary,
            toolUseId: e.toolUseId,
          })
        } else if (e.kind === 'task_notification_delivered') {
          this.handleCcbLocalAgentDelivered(session.sessionKey, e.taskId)
        } else if (e.kind === 'context_pressure' || e.kind === 'context_compacted') {
          this.deliver(buildContextObservationFrame(out, session.agentId, e), adapter)
        } else if (e.kind === 'turn_status') {
          // Plan 2 (compact-progress-frame) — CCB setSDKStatus 侧信道。CcbMessageParser
          // 把 stdout `{type:'system', subtype:'status', status:'compacting'|null}` 转成
          // 这条事件,server.ts 包装成 outbound.turn_status 走 deliver() 路径下发,顺手
          // 更新 session-level cache(autoResumeFromHello 兜底用)。
          //
          // 协议要点(对应 protocol/frames.ts OutboundTurnStatus 注释):
          //   - 受控枚举:CCB 当前只 emit 'compacting' | null,parser 已做 normalize
          //   - **入 outboundRing**:走 deliver() 默认路径,让 ring replay 自然覆盖
          //     "compact 中客户端短暂断网" 场景;长 compact 导致 ring 冲掉的边角由
          //     autoResumeFromHello 的 cache 兜底补发
          //   - 与 codex_billing 同模式:routing tuple + traceId 都从 main `out` 继承,
          //     deliver() 的 _userId 路由也走 _inheritOutboundRouting 自动带上
          // e.status 是 GatewayTurnPhase('compacting' | null | retrying 形态)。
          // session cache 直接存 phase;wire 帧按 protocol OutboundTurnStatus 判别
          // 联合展平(retrying → status:'retrying' + 平级 retry;其余 → status)。
          if (e.status && typeof e.status === 'object' && e.status.status === 'retrying') {
            discardPendingApiErrorAttempt()
          }
          session.currentTurnStatus = e.status
          const turnStatusFrame = _buildTurnStatusFrame(_inheritOutboundRouting(out), e.status)
          // ts / frameSeq 由 deliver() 在 ring 落地时一并 stamp,这里不预填
          // (与 outbound.codex_billing / outbound.error 同 wire stamp 模式)。
          this.deliver(turnStatusFrame, adapter)
        } else if (e.kind === 'codex_billing' && e.engine === 'cursor') {
          // Cursor durable billing rides the tape (engine_billings) only. Master
          // has no request_finalize_journal row for cursor turns, so the live
          // codex_billing frame would just be dropped with a warning; the live
          // low-latency path for cursor is the separate external_billing frame.
        } else if (e.kind === 'codex_billing') {
          // M1a 复活(原 PR2 v1.0.66)— codex turn 终态侧信道。CodexAdapter 在内核
          // result 帧上经 'billing' 通道 emit,sessionManager 包装成 'codex_billing'
          // 事件,server.ts 这里发 outbound.codex_billing 帧给 master(走 deliver()
          // 同样路径,落到 userChatBridge 的 onContainerMessage,master 拦截 settle,
          // 真扣费接线在 M2)。
          //
          // 不影响 turn 流式 UX:这帧与 outbound.message/error 并存,前端不识别此 type
          // 在 default case 静默忽略。master 拦截后不 forward 到 user。
          //
          // 用 deliver() 是因为它已经处理 frameSeq + ring + per-peer 路由。路由三件套
          // 从 out 复制(同 OutboundError 模式);billing 只去 master,master 从
          // requestId 找 inflight,不读这三字段做 settle。CG7 — traceId 随
          // _inheritOutboundRouting 从 main `out` 继承(billing 行可按 traceId 反查
          // 产生它的 turn)。
          //
          // M2 — engineSessionId 进 wire 帧:EngineBillingEvent.engineSessionId
          // (adapter 构造时经唯一 helper engineSessionId(sessionKey) 派生)是 master
          // settle 落 usage_records.session_id 的权威值。逻辑 turn 的免单归因单独使用
          // turnKey / parentTurnKey，不再依赖会话时间窗口。
          const billingFrame: OutboundCodexBilling & { _userId?: string } = {
            type: 'outbound.codex_billing',
            ..._inheritOutboundRouting(out),
            requestId: e.requestId,
            ...(e.turnKey ? { turnKey: e.turnKey } : {}),
            ...(e.parentTurnKey ? { parentTurnKey: e.parentTurnKey } : {}),
            ...(e.parentSessionId ? { parentSessionId: e.parentSessionId } : {}),
            ...(e.delegateAgentId ? { delegateAgentId: e.delegateAgentId } : {}),
            engineSessionId: e.engineSessionId,
            status: e.status,
            ...(e.terminalCode ? { terminalCode: e.terminalCode } : {}),
            durationMs: e.durationMs,
            ...(e.usage ? { usage: e.usage } : {}),
            // Issue A v1.0.108 — codex rateLimits 快照,master.userChatBridge 落库到
            // claude_accounts.quota_*。optional 字段缺省时自然不带。
            ...(e.rateLimits ? { rateLimits: e.rateLimits } : {}),
          }
          this.deliver(billingFrame, adapter)
        } else if (e.kind === 'external_billing') {
          const cursorStableIdentity:
            | {
                cursorAccountId: string
                cursorPoolGeneration: string
                cursorKeyFingerprint: string
              }
            | {
                cursorAccountId?: never
                cursorPoolGeneration?: never
                cursorKeyFingerprint?: never
              } =
            e.cursorAccountId && e.cursorPoolGeneration && e.cursorKeyFingerprint
              ? {
                  cursorAccountId: e.cursorAccountId,
                  cursorPoolGeneration: e.cursorPoolGeneration,
                  cursorKeyFingerprint: e.cursorKeyFingerprint,
                }
              : {}
          // biome-ignore lint/complexity/useOptionalChain: moved verbatim from server.ts (OCV5-483); pre-existing there
          const billingFrame: OutboundExternalEngineBilling & { _userId?: string } = {
            type: 'outbound.external_engine_billing',
            ..._inheritOutboundRouting(out),
            requestId: e.requestId,
            engine: e.engine,
            status: e.status,
            ...(e.terminalCode ? { terminalCode: e.terminalCode } : {}),
            durationMs: e.durationMs,
            ...(e.usage ? { usage: e.usage } : {}),
            // biome-ignore lint/complexity/useOptionalChain: moved verbatim from server.ts (OCV5-483); pre-existing there
            ...(e.cursorSlotResults && e.cursorSlotResults.length
              ? { cursorSlotResults: e.cursorSlotResults }
              : {}),
            ...cursorStableIdentity,
          }
          this.deliver(billingFrame, adapter)
        } else if (e.kind === 'error') {
          // Plan 2 — turn 终态前清 turn_status cache,语义同 final 分支。
          session.currentTurnStatus = null
          // P2 债C — turn 报错 = 终态错误帧自投递,硬编排 review pass 不介入。
          turnErrored = true
          this._runLog.complete(currentRun, { status: 'failed', error: e.error })
          if (frame.idempotencyKey && (frame as any)._idempotencyPreReserved) {
            this._updateWechatIdempotency(frame.idempotencyKey, { completed: true })
          }
          // Remove idempotency key on normal Web failures to allow client retry.
          // WeChat early-ACK turns keep their metadata for the TTL so a lost
          // Step1 response can be deduplicated instead of re-dispatching.
          if (frame.idempotencyKey && !(frame as any)._idempotencyPreReserved) {
            this._seenIdempotencyKeys.delete(frame.idempotencyKey)
          }
          // P1-3 — 已识别错误(余额/限流/上游)发结构化 outbound.error 帧 + 紧跟
          // 老的 [error] text bubble (turn 终止器,frameSeq 单调,新客户端按 seq
          // 抑制重复气泡,旧客户端无视 outbound.error,只看到 [error] 文本降级 UX)。
          // runner 已把错误预分类(errorClass)时优先用之,文案按码取(与
          // classifyRunError 同源);否则回落到对原始错误串做正则粗分类。
          // 'model_capacity' 是新增 wire code(容量满载),直接透传。
          // Always emit the structured error card.  Older clients still get
          // the compatibility `[error]` final below; modern clients suppress
          // that raw bubble and keep the technical string folded in `detail`.
          const errFrame = _buildEngineErrorFrame(_inheritOutboundRouting(out), e)
          this.deliver(errFrame, liveWechatAdapter ? undefined : adapter)
          // E2 — 兼容 [error] 气泡只携带分类后的受控中文文案(errFrame.message)。
          // 上游原始错误原文(可能含 API JSON、路径)不再直达微信/Telegram 等渠道
          // 用户,只进结构化日志(下)与 _runLog(上方 complete 已记 e.error)。
          // "[error] " 前缀保留:新前端按 _suppressErrorBubbleAtSeq + 该前缀抑制
          // 双帧重复气泡,旧客户端靠它识别终止器。
          this.log.warn('turn terminal error (raw detail logged here only)', {
            sessionKey: out.sessionKey,
            code: errFrame.code,
            error: e.error,
            ...(out.traceId ? { traceId: out.traceId } : {}),
          })
          const compatErrorText = `[error] ${errFrame.message}`
          if (liveWechatAdapter) {
            const errBlocks = [{ kind: 'text', text: compatErrorText } as any]
            this.deliver(
              {
                ...out,
                blocks: errBlocks,
                isFinal: true,
              },
              undefined,
            )
            enqueueLiveWechatMessage(errBlocks, true, 'error')
          } else {
            this.deliver(
              {
                ...out,
                blocks: [{ kind: 'text', text: compatErrorText }],
                isFinal: true,
              },
              adapter,
            )
          }
        }
      }
      // RFC-v5-durable-turn-dispatch §3 — durable inbox 准入身份透传:runOneTurnWithRetry
      // 据此在**模型调用前**把 inbox queued→running(同事务落 finalize 元数据),turn-end
      // tape 带 dispatchId/attemptNo。无 descriptor(本地/legacy)→ undefined,现状语义。
      const turnDispatchContext = getDispatchContext(frame as object)
      const inboundRecovery = frame.content.recovery
      const automaticRetryState =
        inboundRecovery?.automatic === true
          ? {
              rootClientMessageId:
                'rootClientMessageId' in inboundRecovery
                  ? inboundRecovery.rootClientMessageId
                  : inboundRecovery.sourceClientMessageId,
              attempt: 'attempt' in inboundRecovery ? inboundRecovery.attempt : 1,
              max: AUTOMATIC_TURN_RETRY_MAX,
            }
          : safeClientMessageId
            ? {
                rootClientMessageId: safeClientMessageId,
                attempt: 0,
                max: AUTOMATIC_TURN_RETRY_MAX,
              }
            : undefined
      const leaderSubmitOpts = {
        systemHelpBootstrap: getSystemHelpBootstrap(frame as object),
        historicalMessages: masterHistoricalMessages,
        codexRoute: safeCodexRoute,
        grokRoute: safeGrokRoute,
        zcodeRoute: safeZcodeRoute,
        antigravityRoute: safeAntigravityRoute,
        serviceTier: safeServiceTier,
        ...(automaticRetryState ? { automaticRetryState } : {}),
        ...(inboundRecovery?.automatic === true &&
        'resetNativeSession' in inboundRecovery &&
        inboundRecovery.resetNativeSession === true
          ? { resetNativeSession: true }
          : {}),
        ...(safeModelSwitchId ? { modelSwitchId: safeModelSwitchId } : {}),
        // DispatchTurnContext(uid/…)→ sessionManager 逻辑键形状(userId/…)。
        ...(turnDispatchContext
          ? {
              dispatchContext: {
                userId: turnDispatchContext.uid,
                sessionId: turnDispatchContext.sessionId,
                clientMessageId: turnDispatchContext.clientMessageId,
                dispatchId: turnDispatchContext.dispatchId,
                attemptNo: turnDispatchContext.attemptNo,
              },
            }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(frame, '_goalState')
          ? { platformGoal: frame._goalState ?? null }
          : {}),
        ...(chatWorkspace.chatProjectId !== undefined
          ? { turnChatProjectId: chatWorkspace.chatProjectId }
          : {}),
        // 模型权威批次 §4 —— bridge turn 的上游请求凭据。
        //
        // descriptor 是**验签产物**(_consumeAuthority → attachTurnAuthority),它原样保留了
        // 两张 envelope 串。短 authority 已在开始执行前验签 + 单次消费;CCB runner 只把
        // 长 lease 透传到 ANTHROPIC_CUSTOM_HEADERS → 每个 `/v1/messages`。**不重签、不改写**:
        // egress 的验签根是 master 私钥,容器只是搬运工。
        //
        // 无 descriptor(本地路径 / flag 未开)→ 不传 → runner 写空串清位 + (flag 开时)自取
        // local_catalog token。清位判定收在 runner 单点,任何 submit 入口都漏不掉。
        ...(turnAuthority !== undefined
          ? {
              modelAuthority: {
                authorityEnvelope: turnAuthority.authorityEnvelope,
                leaseEnvelope: turnAuthority.leaseEnvelope,
                executionDescriptor: projectCcbExecutionDescriptor({
                  canonicalModel: turnAuthority.canonicalModel,
                  contextWindow: turnAuthority.contextWindow,
                  supportsVision: turnAuthority.supportsVision,
                  supportedEfforts: turnAuthority.supportedEfforts,
                  capabilityProfile: turnAuthority.capabilityProfile,
                }),
              },
            }
          : {}),
        ...(teamMode && agent.id === 'main'
          ? { collabAgentPolicy: 'team-mode-prefer-delegate' as const }
          : {}),
        ...(effectiveToolsets !== undefined ? { toolsets: effectiveToolsets } : {}),
        // Master overwrites `_creditBudget` after spreading the client frame, so
        // a browser-forged value cannot survive commercial admission.
        ...(() => {
          const budget = parseCreditBudgetFen((frame as { _creditBudget?: unknown })._creditBudget)
          return budget !== undefined ? { creditBudgetFen: budget } : {}
        })(),
        ...(promptQueueLifecycle ? { queueLifecycle: promptQueueLifecycle } : {}),
        ...(promptQueueExecutionFence ? { queueExecutionFence: promptQueueExecutionFence } : {}),
        // §2.3 boss 硬指标 3:sessionManager 走"最近 N 条历史"兜底注入成功后回调,
        // gateway 发 sys.context_rebuilt 提示帧告知用户上下文被重建。仅 webchat leader
        // turn 传本回调(delegate/cron/train submit 不传 → 无用户可见提示,正确:那些
        // 内部子 turn 没有前台用户看)。gateway-authored 决策直接 deliver(),不绕 engine
        // event 流(那是底座上报通道)。frame 路由继承主 out(_inheritOutboundRouting)。
        emitContextRebuilt: (info: { messageCount: number }) => {
          this.deliver(_buildContextRebuiltFrame(out, agent.id, info.messageCount), adapter)
        },
        ...(safeClientMessageId
          ? {
              replayLifecycle: {
                clientMessageId: safeClientMessageId,
                onStart: () => {
                  this._outboundRing.beginActiveTurn(sessionKey, safeClientMessageId)
                },
                onBeforeRelease: (unhandledError: unknown | undefined) => {
                  if (unhandledError === undefined || turnErrored || leaderFinalCount > 0) {
                    return
                  }
                  const detail =
                    unhandledError instanceof Error
                      ? unhandledError.message
                      : String(unhandledError)
                  onLeaderEvent({ kind: 'error', error: detail })
                  replayTerminalizedUnhandledError = true
                },
                onEnd: () => {
                  this._recordRingEvictions(
                    this._outboundRing.endActiveTurn(sessionKey, safeClientMessageId),
                  )
                },
              },
            }
          : {}),
      }
      // team-durability — 客户 turn 级 in-flight 计数(与 engine 级 _activeTurnCount 双计数,
      // hello 重连对账据此判 turn 是否在飞)。历史上审查硬编排在 submit 之后还要跑数分钟,
      // 这层计数覆盖了那段窗口;硬编排退役(2026-07-07 队长自主送审)后 client turn 与
      // engine turn 范围重合,保留计数是对账判据的稳定契约(未来任何 post-submit 编排
      // 复活时也无需再改 hello 判据)。
      // Ownership moves from preflight to SessionManager at this exact boundary.
      // The websocket wrapper releases any queue claim still present in the
      // WeakMap; after deletion, onSettled owns activation/completion instead.
      if (promptQueueLifecycle?.signal.aborted) {
        ;(frame as any).__oc_prompt_queue_preflight_rejection = {
          disposition: 'retryable',
          reasonCode: 'LEASE_LOST',
        }
        return
      }
      if (promptQueueLifecycle) {
        this._promptQueueLifecycleByFrame.delete(frame as object)
        this._promptQueueExecutionFenceByFrame.delete(frame as object)
      }
      this.sessions.beginClientTurn(session)
      const clientTurnStartedAt = Date.now()
      let clientTurnThrew = false
      let clientTurnError: unknown | undefined
      try {
        this.log.info('turn_pipeline_timing', {
          traceId: turnTraceId, stage: 'gateway_to_submit', elapsedMs: performance.now() - gatewayReceivedAt,
        })
        const submitPromise = this.sessions.submit(
          session,
          payload,
          onLeaderEvent,
          safeEffortLevel,
          // 与 getOrCreate 同源(见 turnExecutionModel):flag 未开时恒等于 safeModel。
          turnExecutionModel,
          safeRequestId,
          turnTraceId,
          safeConversationMode,
          leaderSubmitOpts,
        )
        try {
          ;(frame as any)._onSyntheticQueued?.()
        } catch {}
        await submitPromise
        deliverPendingApiErrorTerminal()
      } catch (err) {
        clientTurnThrew = true
        clientTurnError = err
        if (deliverPendingApiErrorTerminal()) replayTerminalizedUnhandledError = true
        if (!replayTerminalizedUnhandledError) throw err
        this.log.warn(
          'accepted turn failed after replay-safe terminal delivery',
          {
            sessionKey,
            clientMessageId: safeClientMessageId,
          },
          err as Error,
        )
      } finally {
        this.sessions.endClientTurn(
          session,
          turnErrored || clientTurnThrew ? 'errored' : 'completed',
          safeClientMessageId,
        )
        // Parent turn is over. Any `delegate_task` (stdout-wait) job this turn
        // spawned and did not wait out has no one left to read it — hand it to
        // the Notifier so a later terminal wakes this webchat session.
        this._adoptOrphanedStdoutWaitDelegates(sessionKey, {
          userId: activeUserId,
          turnStartedAt: clientTurnStartedAt,
        })
        if (promptQueueLifecycle) {
          try {
            await promptQueueLifecycle.onSettled(clientTurnError)
          } catch (err) {
            this.log.error('prompt queue settlement failed', { sessionKey }, err as Error)
          } finally {
            promptQueueExecutionFence?.release()
          }
        }
      }
      // 2026-09-04 团队模式可观测:本 turn 组队了(有非隐藏委派)却没送审 → 记一条 warn。
      // 不硬拦(审查触发权仍在队长),只让「送审纪律是否被执行」可度量,再决定要不要收紧。
      if (session._teamModeTurn && !turnErrored) {
        const delegated = this._turnDelegatedNonHiddenByParent?.has(sessionKey) === true
        const reviewed = this._hiddenDelegateGuard.countFor(sessionKey) > 0
        if (delegated && !reviewed) {
          this.log.warn('team_review_skipped', { sessionKey, leaderModel: session.model })
        } else if (delegated) {
          this.log.info('team_review_done', {
            sessionKey,
            reviews: this._hiddenDelegateGuard.countFor(sessionKey),
          })
        }
      }
      if (
        (frame.channel === 'webchat' ||
          frame.channel === 'wechat' ||
          frame.channel === 'telegram') &&
        isAutoDreamSuccessfulTurn({
          signed: turnAuthority !== undefined,
          turnErrored,
          clientTurnThrew,
          leaderFinalCount,
          assistantText: autoDreamAssistantText,
          hasCanonicalApiError: autoDreamHasCanonicalApiError,
        })
      ) {
        const autoDreamTrigger = {
          agentId: agent.id,
          userId: activeUserId,
          sessionKey,
          channel: frame.channel,
          userText: text ?? '',
          assistantText: autoDreamAssistantText,
          projectId: session.projectId ?? undefined,
        }
        // Durably await the success-only marker before detaching background scan.
        // This prevents process shutdown from losing an untracked insertion and
        // makes its database-generated sequence visible to the captured watermark.
        let markerPersisted = false
        try {
          await recordAutoDreamSuccessfulSession({
            agentId: agent.id,
            sessionId: sessionKey,
            channel: frame.channel,
            completedAt: Date.now(),
          })
          markerPersisted = true
        } catch (err) {
          this.log.warn('auto_dream_background_failed', { agentId: agent.id }, err)
        }
        if (markerPersisted) {
          void this.autoDream.maybeSchedule(autoDreamTrigger).catch((err) => {
            this.log.warn('auto_dream_background_failed', { agentId: agent.id }, err)
          })
          void this.autoDreamOptimizer
            .maybeSchedule({
              agentId: agent.id,
              userId: activeUserId,
              sessionKey,
              channel: frame.channel,
            })
            .catch((err) => {
              this.log.warn('auto_dream_optimizer_background_failed', { agentId: agent.id }, err)
            })
        }
      }
      if (liveWechatAdapter) {
        await liveWechatSendQueue
      }
    } finally {
      // Once a queue ImageEdit is activated, every post-activation exit owns
      // one exact tape — including relay rejection, stop, and thrown delivery
      // errors. Completion may still wait for the normal lossless ACK barrier.
      if (
        externalQueueLifecycleOwned &&
        externalQueueReservation &&
        !externalQueuePersistAttempted
      ) {
        externalQueuePersistAttempted = true
        try {
          await this.sessions.recordExternalTurn(
            session,
            {
              userText: text,
              assistantText: externalQueueTerminalText ?? '[error] 图片任务执行失败。',
              requestId:
                typeof frame.requestId === 'string' && /^[0-9a-f]{32}$/.test(frame.requestId)
                  ? frame.requestId
                  : (imageEditJobId ?? externalQueueReservation.turnKey.slice(0, 32)),
              traceId: turnTraceId,
              model: 'gpt-image-2',
              ...(chatWorkspace.chatProjectId !== undefined
                ? { chatProjectId: chatWorkspace.chatProjectId }
                : {}),
            },
            externalQueueReservation,
          )
        } catch (err) {
          externalQueueError ??= err
          this.log.warn(
            'prompt queue ImageEdit tape is awaiting durable ACK',
            {
              sessionKey,
              turnKey: externalQueueReservation.turnKey,
            },
            err as Error,
          )
        }
      }
      externalTurnGuard?.finish(externalTurnCompleted ? 'completed' : 'errored')
      if (externalQueueLifecycleOwned && promptQueueLifecycle) {
        try {
          await promptQueueLifecycle.onSettled(externalQueueError)
        } catch (err) {
          this.log.error('prompt queue ImageEdit settlement failed', { sessionKey }, err as Error)
        } finally {
          promptQueueExecutionFence?.release()
        }
      }
    }
  } finally {
    this._runtimeRecycleIngressActive = Math.max(0, this._runtimeRecycleIngressActive - 1)
    if (admitCmid && admitSession && admitSession._admittingClientMessageId === admitCmid) {
      admitSession._admittingClientMessageId = undefined
    }
  }
}
