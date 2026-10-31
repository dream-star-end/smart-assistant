import { withUserError } from '@openclaude/protocol'
import { SYSTEM_HELP_CAPABILITY, takeSystemHelpBootstrap } from '@openclaude/protocol'
import { captureSystemHelpFrame } from './systemHelpFrames.js'
import { getSystemHelpRelay } from './systemHelpRelay.js'
/**
 * Gateway WebSocket connection: connection lifecycle, hello auto-resume, stop, delivery and stamped/status frames
 *
 * Moved verbatim out of Gateway (server.ts) — FINDINGS §7.6, OCV5-483. The class
 * keeps one-line forwarders that call these with the instance as `this`, so behaviour, closures and
 * `this.x` reads/writes are unchanged. WsConnectionHost lists exactly the Gateway members this code
 * touches (typed from the class itself).
 */
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import type { ChannelAdapter } from '@openclaude/plugin-sdk'
import {
  type InboundFrame,
  type OutboundCodexBilling,
  type OutboundExternalEngineBilling,
  type OutboundCallUsage,
  type OutboundError,
  type OutboundMessage,
  type OutboundTurnStatus,
  type OutboundTurnUsage,
  type SysContextRebuilt,
  type SessionContextPressure,
  type SysContextCompacted,
  isClientMessageId,
  type PromptQueueMutationFrame,
} from '@openclaude/protocol'
import { checkLocalBridge } from './localBridgeAuth.js'
import {
  PROMPT_QUEUE_DISPATCH_RESULT_TYPE,
  PROMPT_QUEUE_GRANT_FIELD,
  type PromptQueueDispatchControl,
} from './promptQueueCoordinator.js'
import type { PromptQueueExecutionFence } from './sessionManager.js'
import { readV3MasterSinkConfig } from './v3MasterSink.js'
import { isHiddenSystemAgentId } from './agentVisibility.js'
import { WebSocket } from 'ws'
import { rebindOutboundClientMessageId } from './terminalStreamFence.js'
import {
  wsConnectionsTotal,
  outboundRingReplayHitTotal,
  outboundRingReplayMissTotal,
  outboundRingSizeBytes,
} from './metrics.js'
import type { SessionRepoStatusOut } from './sessionRepoWorkspace.js'
import {
  lookupRecentTerminal,
  PRE_ADMISSION_STOP_TTL_MS,
  preStartStopKey,
  stopControlSendAttempt,
} from './sessionManager.js'
import {
  AuthorityRejected,
  MODEL_AUTHORITY_FIELD,
  attachTurnAuthority,
  buildContainerAttestFrame,
} from './modelAuthority.js'
import {
  durableTurnDispatchCapabilities,
  getDispatchContext,
  runDurableDispatchAdmission,
} from './turnDispatchInbox.js'
import { _pendingPermissionCatchupFrames } from './pendingPermissionSnapshot.js'
import { resolveLocalExecutionIfEnforced, localExecutionOverride, makePeerKey, _parseConnectionTraceIdFromUpgrade, _stripPrivateRoutingFields, _turnStatusWireFields, _helloTurnStatusResendPhase, preparedModelSwitchCatchupFrame, _matchActiveTurnReplayCandidate, _unservedActiveTurnReplay, _noteActiveTurnReplayServed, _shouldPushTurnInterruptedFinal, _shouldInterruptUnknownInFlight } from './server.js'
import type { Gateway } from './server.js'

const MODEL_SWITCH_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/

export interface WsConnectionHost {
  _activeTurnReplaysServed: Gateway['_activeTurnReplaysServed']
  _admittedClientTurns: Gateway['_admittedClientTurns']
  _authorityConns: Gateway['_authorityConns']
  _bridgeConnections: Gateway['_bridgeConnections']
  _consumeDispatchAuthority: Gateway['_consumeDispatchAuthority']
  _consumeFrameAuthority: Gateway['_consumeFrameAuthority']
  _dispatchAdmittedClientTurn: Gateway['_dispatchAdmittedClientTurn']
  _dispatchAuthority: Gateway['_dispatchAuthority']
  _durableTurnDispatchReady: Gateway['_durableTurnDispatchReady']
  _flushPendingRepoBinds: Gateway['_flushPendingRepoBinds']
  _getAgentsConfig: Gateway['_getAgentsConfig']
  _handleSessionRepoBind: Gateway['_handleSessionRepoBind']
  _handleSessionRepoUnbind: Gateway['_handleSessionRepoUnbind']
  _interruptDelegationsForParent: Gateway['_interruptDelegationsForParent']
  _modelAuthority: Gateway['_modelAuthority']
  _outboundRing: Gateway['_outboundRing']
  _pendingPermissions: Gateway['_pendingPermissions']
  _pendingRepoBinds: Gateway['_pendingRepoBinds']
  _promptQueueContext: Gateway['_promptQueueContext']
  _promptQueueCoordinator: Gateway['_promptQueueCoordinator']
  _promptQueueExecutionFenceByFrame: Gateway['_promptQueueExecutionFenceByFrame']
  _promptQueueLifecycleByFrame: Gateway['_promptQueueLifecycleByFrame']
  _recentHelloPeers: Gateway['_recentHelloPeers']
  _recordRingEvictions: Gateway['_recordRingEvictions']
  _registerPromptQueueClient: Gateway['_registerPromptQueueClient']
  _rejectAuthority: Gateway['_rejectAuthority']
  _sendPromptQueueGrantCancellation: Gateway['_sendPromptQueueGrantCancellation']
  _sendStampedSessionFrame: Gateway['_sendStampedSessionFrame']
  _sendTurnDispatchReceipt: Gateway['_sendTurnDispatchReceipt']
  _settlePendingPermissionsForStop: Gateway['_settlePendingPermissionsForStop']
  _shuttingDown: Gateway['_shuttingDown']
  autoResumeFromHello: Gateway['autoResumeFromHello']
  checkHttpAuth: Gateway['checkHttpAuth']
  clientsByPeer: Gateway['clientsByPeer']
  deps: Gateway['deps']
  getUserId: Gateway['getUserId']
  getWsUserId: Gateway['getWsUserId']
  handlePermissionResponse: Gateway['handlePermissionResponse']
  handleStop: Gateway['handleStop']
  lastActiveChannel: Gateway['lastActiveChannel']
  log: Gateway['log']
  router: Gateway['router']
  sessions: Gateway['sessions']
  trustedGoalFrames: Gateway['trustedGoalFrames']
  wsClients: Gateway['wsClients']
}

const CONTROL_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/

const isControlId = (value: unknown): value is string =>
  typeof value === 'string' && CONTROL_ID_RE.test(value)

// ───────── WS ─────────
export function handleWsConnection(
  this: WsConnectionHost,
  ws: WebSocket,
  req: IncomingMessage,
): void {
  if (this._shuttingDown) {
    try {
      ws.close(1001, 'shutting down')
    } catch {}
    return
  }
  // v3 commercial 容器内信任 docker bridge gateway IP 直连。commercial 侧 userChatBridge
  // 经 docker bridge 网络转发的 ws → /ws 不带 bearer(容器随机生成的 accessToken supervisor
  // 没回传)。仅当 commercial supervisor 显式注入 OPENCLAUDE_TRUST_BRIDGE_IP=<本机 bridge
  // 网关 .1>(self host=172.30.0.1,远端 host 由 v3supervisor.gatewayIpFromV3Cidr 按
  // host.bridge_cidr 算)时生效;个人版 / 任何未配置该 env 的场景下
  // process.env.OPENCLAUDE_TRUST_BRIDGE_IP 为空,旁路恒为 false,checkHttpAuth 行为完全不变。
  const remoteIp = req.socket.remoteAddress || ''
  const TRUST_BRIDGE_IP = process.env.OPENCLAUDE_TRUST_BRIDGE_IP || ''
  const isFromBridge =
    !!TRUST_BRIDGE_IP && (remoteIp === TRUST_BRIDGE_IP || remoteIp === `::ffff:${TRUST_BRIDGE_IP}`)
  if (!isFromBridge && !checkLocalBridge(req) && !this.checkHttpAuth(req)) {
    ws.close(1008, 'unauthorized')
    return
  }
  if (isFromBridge)
    this._bridgeConnections.add(ws)
    // Stash authenticated userId on the WS so every subsequent broadcast lookup
    // can scope peerKey by user, preventing cross-account delivery when two
    // users happen to share the same client-generated peerId (see makePeerKey
    // helper). Legacy-token auth returns 'default'.
  ;(ws as any)._userId = this.getUserId(req)
  // V3 S12e CG6 — connection-level trace stash. Read X-Connection-Trace-Id
  // upgrade header(由 master 在 mTLS WS dial 时写入,CG4),失败 fallback
  // newTraceId() + warn(不含 raw value 防 log injection)。Stash 到 ws 上
  // 供 CG7 后续 dispatchInbound stamp 4 类 outbound 使用,以及 ws.connect /
  // disconnect log 关联。
  const connectionTraceId = _parseConnectionTraceIdFromUpgrade(req.headers, this.log)
  ;(ws as any)._connectionTraceId = connectionTraceId
  wsConnectionsTotal.inc()
  this.log.info('ws.connect', { connectionTraceId })
  ws.once('close', () => this.log.debug('ws.disconnect', { connectionTraceId }))

  // Keepalive pong tracking
  ;(ws as any)._isAlive = true
  ws.on('pong', () => {
    ;(ws as any)._isAlive = true
  })

  this.wsClients.add(ws)
  ws.once('close', () => this.wsClients.delete(ws))

  // ── 模型执行权威 attestation(方案 §7 步 3/4)────────────────────────────
  // **只对 bridge 连接发**:isFromBridge 是「对端是 master」的唯一权威判据(容器内
  // 的本地/个人版 WS 客户端拿不到这条旁路)。个人版前端因此永远看不到这帧,零影响。
  //
  // 帧内容 = { capabilities, connectionChallenge }:
  //   - capabilities 含 model_authority_v1 ⟺ 本容器**真的能验签**(有 keyring + 身份 env);
  //     旧 env 的新镜像容器不会骗到 bridge(见 ModelAuthorityConsumer.enabled)。
  //   - connectionChallenge 每连接现铸,bridge 必须把它签进 authority payload
  //     (R4-m4)。连接关闭 / gateway 重启后 challenge 变更 → 旧 envelope 天然失效,
  //     replay cache 不需要跨进程共享。
  // 连接一建立就发(先于任何用户帧到达):bridge 侧的 attestation 门在收到本帧前会
  // 缓冲用户帧,收到即放行 —— 早到帧竞态由缓冲覆盖,不靠时序运气。
  if (isFromBridge) {
    const authorityConn = this._modelAuthority.newConnection()
    this._authorityConns.set(ws, authorityConn)
    ws.once('close', () => this._modelAuthority.closeConnection(authorityConn))
    try {
      const attestFrame = buildContainerAttestFrame(
        this._modelAuthority,
        authorityConn,
        Number(process.env.OC_CONTAINER_ID) || null,
      )
      // RFC-v5-durable-turn-dispatch §3/§B5 — durable-turn-dispatch-v1 runtime capability
      // 并入 attest 广播(与 model_authority_v1 同一 capabilities 集合;bridge 的 admission
      // 门据此分流:无此 capability → legacy 路径不建 dispatch 行)。**绑定完整 readiness**:
      // 验签能力 ∧ sink 装配 ∧ boot recovery 首跑成功,任一不满足 → 不申报(fail-closed)。
      attestFrame.capabilities = [
        ...attestFrame.capabilities,
        ...durableTurnDispatchCapabilities(
          this._dispatchAuthority.enabled,
          this._durableTurnDispatchReady,
        ),
      ]
      if (this._dispatchAuthority.enabled && this._durableTurnDispatchReady && getSystemHelpRelay(this.sessions)) attestFrame.capabilities.push(SYSTEM_HELP_CAPABILITY)
      ws.send(JSON.stringify(attestFrame))
    } catch (err) {
      this.log.warn('model_authority.attest_send_failed', {
        err: (err as Error)?.message ?? String(err),
      })
    }
  }

  // Phase 4 — ws close 时清 pending bind 队列(WeakMap recentHelloPeers 自动 GC)
  ws.once('close', () => {
    for (const [key, entry] of this._pendingRepoBinds) {
      if (entry.ws === ws) {
        clearTimeout(entry.timer)
        this._pendingRepoBinds.delete(key)
      }
    }
  })
  ws.on('message', async (raw) => {
    try {
      let frame: InboundFrame
      try {
        frame = JSON.parse(raw.toString()) as InboundFrame
      } catch {
        ws.send(JSON.stringify(withUserError({ type: 'error', error: 'invalid json' })))
        return
      }
      const systemHelpBootstrap = takeSystemHelpBootstrap(frame)
      // Client-side application-level ping. Echo a pong (preserving the
      // optional id) so the client's watchdog can distinguish a live socket
      // from one that's still readyState=1 but frozen by an iOS Safari
      // backgrounded-tab.  Old clients that don't carry `id` get a plain
      // `{type:'pong', ts}` and silently ignore it; new clients require
      // matching id to clear their pending probe.
      if ((frame as any).type === 'ping') {
        try {
          const pingId = (frame as any).id
          ws.send(
            JSON.stringify({
              type: 'pong',
              ...(pingId !== undefined ? { id: pingId } : {}),
              ts: Date.now(),
            }),
          )
        } catch {}
        return
      }

      // Hello frame: client identifies its sessions so we can auto-resume.
      // We register the WS into clientsByPeer only for peers that have an
      // active session in the session manager (validated server-side).
      if ((frame as any).type === 'inbound.hello') {
        const hello = frame as any
        // Phase 0.3: peers may carry `lastFrameSeq` — the highest frameSeq
        // this tab successfully processed before the disconnect. 0 = never
        // received one (first connect / localStorage wiped / legacy client).
        const peers: Array<{
          peerId: string
          agentId: string
          inFlight?: boolean
          lastFrameSeq?: number
          resumeActiveTurnCandidateMessageIds?: unknown
          /** RFC-v5-durable-turn-dispatch §4 — 前端 _activeClientMessageId:该 tab
           *  自认为仍在飞的那条 user 行 id。带上 → autoResume 走精确身份对账决策表;
           *  缺失(legacy)→ 旧 inFlight 布尔行为。 */
          inFlightClientMessageId?: string
        }> = hello.peers || []
        // Phase 4 — 把这些 peerId 记下来,bind 帧用 5s grace window 校验
        const peerIdSet = new Set<string>()
        for (const p of peers) {
          if (typeof p?.peerId === 'string') peerIdSet.add(p.peerId)
        }
        this._recentHelloPeers.set(ws, { peerIds: peerIdSet, recordedAt: Date.now() })
        // Queue-enabled hello has a strict ordering contract: ring replay first,
        // then one fresh PG snapshot even when no AgentSession exists yet.
        // Flag-off keeps the legacy fire-and-forget path unchanged.
        if (this._promptQueueCoordinator && isFromBridge) {
          try {
            await this.autoResumeFromHello(peers, ws)
          } catch (err) {
            this.log.error('auto-resume failed', undefined, err as Error)
          }
          const helloUserId = this.getWsUserId(ws)
          for (const peer of peers) {
            const queueAgentId =
              typeof peer?.agentId === 'string' && peer.agentId ? peer.agentId : 'main'
            if (
              typeof peer?.peerId !== 'string' ||
              !peer.peerId ||
              isHiddenSystemAgentId(queueAgentId)
            )
              continue
            const context = this._promptQueueContext(helloUserId, peer.peerId, queueAgentId)
            this._registerPromptQueueClient(ws, context)
            try {
              await this._promptQueueCoordinator.hello(context, ws)
            } catch (err) {
              this.log.error(
                'prompt queue hello failed',
                {
                  sessionKey: context.owner.sessionKey,
                },
                err as Error,
              )
            }
          }
        } else {
          // Auto-resume: check if any peer has a resumable session that is NOT already active
          this.autoResumeFromHello(peers, ws).catch((err) =>
            this.log.error('auto-resume failed', undefined, err),
          )
        }
        // 检查 pending bind 队列:有匹配 sessionId 的就 dequeue 处理
        this._flushPendingRepoBinds(ws, peerIdSet)
        return
      }

      if ((frame as any).type === PROMPT_QUEUE_DISPATCH_RESULT_TYPE) {
        if (!this._promptQueueCoordinator || !isFromBridge) return
        const owner = (frame as any).owner
        if (
          !owner ||
          typeof owner !== 'object' ||
          typeof owner.clientSessionId !== 'string' ||
          !owner.clientSessionId ||
          typeof owner.agentId !== 'string' ||
          !owner.agentId ||
          isHiddenSystemAgentId(owner.agentId)
        )
          return
        const context = this._promptQueueContext(
          this.getWsUserId(ws),
          owner.clientSessionId,
          owner.agentId,
        )
        const accepted = await this._promptQueueCoordinator.rejectGrant(context, frame)
        if (!accepted) {
          this.log.warn('prompt queue late or mismatched rejection dropped', {
            sessionKey: context.owner.sessionKey,
          })
        }
        return
      }

      if (
        typeof (frame as any).type === 'string' &&
        (frame as any).type.startsWith('inbound.prompt_queue.')
      ) {
        if (!this._promptQueueCoordinator || !isFromBridge) return
        const queueFrame = frame as unknown as PromptQueueMutationFrame
        const peer = (queueFrame as any).peer
        const agentId = (queueFrame as any).agentId
        if (
          !peer ||
          typeof peer !== 'object' ||
          typeof peer.id !== 'string' ||
          !peer.id ||
          peer.kind !== 'dm' ||
          typeof agentId !== 'string' ||
          !agentId ||
          isHiddenSystemAgentId(agentId)
        )
          return
        const context = this._promptQueueContext(this.getWsUserId(ws), peer.id, agentId)
        this._registerPromptQueueClient(ws, context)
        await this._promptQueueCoordinator.mutate(context, queueFrame, ws)
        return
      }

      // Phase 4 — GitHub session repo bind/unbind 控制帧
      if ((frame as any).type === 'inbound.control.session_repo_bind') {
        // v1.0.95 诊断 instrument:确认容器 gateway 真收到了 master forward 来的 bind 帧
        this.log.info('repo_bind_received', {
          sessionId: (frame as any).sessionId,
          selectionVersion: (frame as any).selectionVersion,
          userId: this.getWsUserId(ws),
        })
        await this._handleSessionRepoBind(ws, frame as any)
        return
      }
      if ((frame as any).type === 'inbound.control.session_repo_unbind') {
        await this._handleSessionRepoUnbind(ws, frame as any)
        return
      }

      if (frame.type === 'inbound.message') {
        const queueGrant = (frame as any)[PROMPT_QUEUE_GRANT_FIELD]
        // ── 模型执行权威消费(方案 §2)───────────────────────────────────────
        // 顺序铁律:**先消费(需要读 wire 字段),再 strip**。strip 由 dispatchInbound
        // 入口统一兜底(一切入口无条件 strip),descriptor 经 WeakMap 旁路挂载 ——
        // 客户端在 wire 上伪造不出 WeakMap key,故没有「伪造 descriptor」这个面。
        if (!this._consumeFrameAuthority(ws, frame as any, isFromBridge)) {
          if (queueGrant !== undefined && this._promptQueueCoordinator && isFromBridge) {
            const queueAgentId =
              typeof frame.agentId === 'string' && frame.agentId ? frame.agentId : 'main'
            const context = this._promptQueueContext(
              this.getWsUserId(ws),
              frame.peer.id,
              queueAgentId,
            )
            this._sendPromptQueueGrantCancellation(ws, context, queueGrant, 'AUTHORITY_REJECTED')
          }
          return
        }
        // dispatch 票据消费(同顺序铁律:先消费再 strip)。带票据即 master 已建 dispatch,
        // 消费失败必须拒帧 —— legacy 降级会造成"error 行与真回复并存"的双终态分裂
        // (master 侧 dispatch 无 receipt → reconciler tombstone → not_accepted,而 legacy
        // 执行照跑出真回复)。fail-closed:master 权威由 reconciler 收敛成可见失败。
        // 无票据(非 durable / 非 webchat-DM / 未 enabled)→ return true 放行 legacy;
        // dispatch 票据与 prompt-queue grant 互斥,故此门失败无 queue grant 需取消。
        if (!this._consumeDispatchAuthority(ws, frame as any, isFromBridge)) return
        captureSystemHelpFrame(frame as object, systemHelpBootstrap, isFromBridge)
        if (isFromBridge) (this.trustedGoalFrames ??= new WeakSet()).add(frame as object)
        // biome-ignore lint/performance/noDelete: moved verbatim from server.ts (OCV5-483); pre-existing there
        else delete (frame as any)._goalState

        delete (frame as any)[PROMPT_QUEUE_GRANT_FIELD]
        if (queueGrant !== undefined) {
          if (!this._promptQueueCoordinator || !isFromBridge) return
          const queueAgentId =
            typeof frame.agentId === 'string' && frame.agentId ? frame.agentId : 'main'
          const context = this._promptQueueContext(
            this.getWsUserId(ws),
            frame.peer.id,
            queueAgentId,
          )
          const lifecycle = this._promptQueueCoordinator.acceptGrant(
            context,
            queueGrant,
            (control: PromptQueueDispatchControl) => {
              if (!this._bridgeConnections.has(ws) || ws.readyState !== WebSocket.OPEN) return false
              try {
                ws.send(JSON.stringify(control))
                return true
              } catch {
                return false
              }
            },
          )
          if (!lifecycle) {
            this._sendPromptQueueGrantCancellation(ws, context, queueGrant, 'GRANT_NOT_ACCEPTED')
            this.log.warn('prompt queue late or mismatched grant dropped', {
              sessionKey: context.owner.sessionKey,
            })
            return
          }
          let executionFence: PromptQueueExecutionFence
          try {
            executionFence = this.sessions.beginPromptQueueExecutionFence(context.owner.sessionKey)
          } catch (err) {
            await lifecycle.onPreflightRejected('retryable', 'EXECUTION_OWNER_BUSY')
            this.log.info('prompt queue grant deferred by live runtime owner', {
              sessionKey: context.owner.sessionKey,
              error: err instanceof Error ? err.message : String(err),
            })
            return
          }
          this._promptQueueLifecycleByFrame.set(frame as object, lifecycle)
          this._promptQueueExecutionFenceByFrame.set(frame as object, executionFence)
        }
        // Stash userId on the frame so downstream dispatchInbound/deliver
        // paths that don't have the WS in scope can still build the correct
        // per-user peerKey. Private field (leading _), never sent over wire.
        ;(frame as any)._userId = this.getWsUserId(ws)
        // 把 ws client 关联到这个 (channel, peer)
        const peerKey = makePeerKey(this.getWsUserId(ws), frame.channel, frame.peer.id)
        let set = this.clientsByPeer.get(peerKey)
        if (!set) {
          set = new Set()
          this.clientsByPeer.set(peerKey, set)
        }
        if (!set.has(ws)) {
          set.add(ws)
          ws.once('close', () => {
            set?.delete(ws)
            if (set?.size === 0) {
              this.clientsByPeer.delete(peerKey)
              // Browser/bridge disconnect is transport loss, not a user's
              // permission decision. Keep pending authority + ring replay so
              // a reconnect can answer the exact same request.
            }
          })
        }
        // ── durable inbox 准入(RFC-v5-durable-turn-dispatch §3.b)───────────
        // 有 descriptor(webchat-DM 已验签):INSERT queued;已有行 → 回执帧给
        // bridge,不执行;inserted → 走 dispatchInbound,finally 兜底 CAS rejected
        // (行仍 queued = 从未进入执行 → 不留孤儿给 boot)。dispatch 票据与 prompt-queue
        // grant 互斥(durable webchat-DM turn 不带 queueGrant),故此分支无 queue lifecycle
        // 需清理;queue lifecycle 清理只挂在下方非 dctx 路径。
        const dctx = getDispatchContext(frame as object)
        if (dctx) {
          // 单一生产 helper 锁住 mark→INSERT→首次 receipt→dispatch→finally unmark
          // 全顺序;周期 sweep 的压缩 tick 回归直接走同一条接线。
          await runDurableDispatchAdmission({
            ctx: dctx,
            sendReceipt: (row) => this._sendTurnDispatchReceipt(ws, dctx, row),
            dispatch: () => this._dispatchAdmittedClientTurn(frame),
            onAdmitError: (err) => {
              // 受理事务异常 = 拒轮(可重试),不半受理。不建 inbox 行 → 无孤儿。
              this.log.error(
                'turn dispatch admit failed',
                { dispatchId: dctx.dispatchId },
                err as Error,
              )
            },
            onOrphanRejectError: (err) => {
              this.log.warn(
                'turn dispatch orphan reject failed',
                { dispatchId: dctx.dispatchId },
                err,
              )
            },
          })
          return
        }
        try {
          await this._dispatchAdmittedClientTurn(frame)
        } finally {
          const unusedQueueLifecycle = this._promptQueueLifecycleByFrame.get(frame as object)
          const unusedQueueFence = this._promptQueueExecutionFenceByFrame.get(frame as object)
          if (unusedQueueLifecycle) {
            this._promptQueueLifecycleByFrame.delete(frame as object)
            this._promptQueueExecutionFenceByFrame.delete(frame as object)
            const rejection = (frame as any).__oc_prompt_queue_preflight_rejection as
              | { disposition?: unknown; reasonCode?: unknown }
              | undefined
            const disposition =
              rejection?.disposition === 'user_action_required'
                ? 'user_action_required'
                : 'retryable'
            const reasonCode =
              typeof rejection?.reasonCode === 'string'
                ? rejection.reasonCode
                : 'PREPROCESS_REJECTED'
            try {
              await unusedQueueLifecycle.onPreflightRejected(disposition, reasonCode)
            } finally {
              unusedQueueFence?.release()
            }
          }
        }
      } else if (frame.type === 'inbound.goal_sync') {
        if (!isFromBridge) return
        await this.sessions.syncGoalState(frame.goal.sessionId, frame.goal)
      } else if ((frame as any).type === 'inbound.control.goal') {
        const goalFrame = frame as any
        const goalAction = goalFrame.action
        if (
          goalAction !== 'set' &&
          goalAction !== 'pause' &&
          goalAction !== 'resume' &&
          goalAction !== 'clear'
        )
          return
        const goalPeer = goalFrame.peer
        if (!goalPeer || typeof goalPeer.id !== 'string' || typeof goalFrame.channel !== 'string')
          return
        const goalAgentId =
          typeof goalFrame.agentId === 'string' && goalFrame.agentId ? goalFrame.agentId : 'main'
        const goalKind = typeof goalPeer.kind === 'string' && goalPeer.kind ? goalPeer.kind : 'dm'
        const goalSessionKey = `agent:${goalAgentId}:${goalFrame.channel}:${goalKind}:${goalPeer.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`
        const goalSession = this.sessions.getByKey(goalSessionKey)
        if (!goalSession || goalSession.userId !== this.getWsUserId(ws)) return
        const goalObjective =
          typeof goalFrame.objective === 'string' ? goalFrame.objective : undefined
        await this.sessions.applyUserGoalAction(goalSessionKey, goalAction, goalObjective)
      } else if (frame.type === 'inbound.control.stop') {
        const applied = await this.handleStop(frame)
        const controlId = (frame as unknown as { controlId?: unknown }).controlId
        if (isControlId(controlId)) {
          try {
            ws.send(
              JSON.stringify({
                type: 'outbound.control.receipt',
                controlId,
                controlKind: 'stop',
                status: applied ? 'applied' : 'terminal',
                peer: frame.peer,
                ...(isClientMessageId(frame.clientMessageId)
                  ? { clientMessageId: frame.clientMessageId }
                  : {}),
                ...(applied ? {} : { errorCode: 'TURN_NOT_ACTIVE' }),
              }),
            )
          } catch {}
        }
      } else if ((frame as any).type === 'inbound.permission_response') {
        // Stash userId so handlePermissionResponse can rebuild per-user
        // peerKey on the late-duplicate no-pending-entry fallback path
        // (the only path where we have no server-trusted user identity).
        ;(frame as any)._userId = this.getWsUserId(ws)
        await this.handlePermissionResponse(frame as any)
        const controlId = (frame as unknown as { controlId?: unknown }).controlId
        if (isControlId(controlId)) {
          try {
            ws.send(
              JSON.stringify({
                type: 'outbound.control.receipt',
                controlId,
                controlKind: 'permission',
                status: 'terminal',
                peer: (frame as any).peer,
                requestId: (frame as any).requestId,
              }),
            )
          } catch {}
        }
      } else if ((frame as any).type === 'inbound.control.reset') {
        // Reset: kill the CCB subprocess AND remove session from manager,
        // so next message creates an entirely fresh session with no history
        const f = frame as any
        const agentId =
          f.agentId ||
          this.router.route({
            type: 'inbound.message',
            idempotencyKey: '',
            channel: f.channel,
            peer: f.peer,
            content: { text: '' },
            ts: Date.now(),
          }).agent.id
        const sessionKey = `agent:${agentId}:${f.channel}:${f.peer.kind}:${f.peer.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`
        await this.sessions.destroySession(sessionKey)
        // Drop the outbound ring when the session is reset. Keeping stale
        // frames around for a now-meaningless sessionKey would be wasteful
        // and could mislead a future reconnect.
        this._outboundRing.clear(sessionKey)
        outboundRingSizeBytes.value = this._outboundRing.totalBytes()
        this.log.info('reset destroyed session', { sessionKey })
      } else if ((frame as any).type === 'control.session.cancel_model_switch') {
        const sessionKey = (frame as any).sessionKey
        const requestId = (frame as any).requestId
        if (
          typeof sessionKey !== 'string' ||
          typeof requestId !== 'string' ||
          !/^[A-Za-z0-9:_-]{8,128}$/.test(requestId)
        )
          return
        const session = this.sessions.getByKey(sessionKey)
        if (!session || session.userId !== this.getWsUserId(ws)) return
        this.sessions.cancelModelSwitch(session, requestId)
      } else if ((frame as any).type === 'control.session.prepare_model_switch') {
        const sessionKey = (frame as any).sessionKey
        const requestId = (frame as any).requestId
        const sourceModel = (frame as any).sourceModel
        const targetModel = (frame as any).targetModel
        if (
          typeof sessionKey !== 'string' ||
          typeof requestId !== 'string' ||
          typeof sourceModel !== 'string' ||
          typeof targetModel !== 'string' ||
          // Not the baked ALLOWED_INBOUND_MODELS: it drifts from the catalog
          // (box-api-claude-* are missing), and a silently dropped request
          // left the picker on 切换中… for 16 minutes. The source must equal
          // the session's model; the target is only recorded here and is
          // admitted by the turn's model authority when it is used.
          !MODEL_SWITCH_MODEL_ID_RE.test(sourceModel) ||
          !MODEL_SWITCH_MODEL_ID_RE.test(targetModel)
        )
          return
        const session = this.sessions.getByKey(sessionKey)
        const userId = this.getWsUserId(ws)
        const ownsSession = session?.userId === userId
        const peerId = sessionKey.split(':').slice(4).join(':')
        const peerKey = makePeerKey(userId, 'webchat', peerId)
        const reply = (payload: Record<string, unknown>) => {
          // Compact can outlive the requesting socket (mobile 1.5s visibility
          // probe, proxy idle, tab freeze). Stamp + fan out + ring-store so a
          // reconnecting hello can still consume the exact generation.
          const frame = {
            type: 'outbound.model_switch.prepared',
            requestId,
            sessionKey,
            targetModel,
            ...payload,
          }
          this._sendStampedSessionFrame(sessionKey, peerKey, frame)
          if (ws.readyState === WebSocket.OPEN) {
            const live = this.clientsByPeer.get(peerKey)
            if (!live?.has(ws)) {
              try {
                ws.send(JSON.stringify({ ...frame, ts: Date.now() }))
              } catch {
                /* originating transport already gone */
              }
            }
          }
        }
        if (!session || !ownsSession) {
          reply({
            sourceModel: '',
            status: 'failed',
            errorCode: 'SESSION_NOT_FOUND',
            message: '会话尚未运行，无法压缩',
          })
          return
        }
        try {
          const prepared = await this.sessions.prepareModelSwitch(
            session,
            sourceModel,
            targetModel,
            requestId,
          )
          reply({ ...prepared, status: 'completed' })
        } catch (err) {
          // E5 — err.message 只在形如受控大写码时才作为 errorCode 下发;任意
          // 运行时错误文本(可能含路径/栈)收敛为固定码,原文进日志。
          const rawCode = err instanceof Error ? err.message : ''
          const code = /^[A-Z][A-Z0-9_]{2,64}$/.test(rawCode)
            ? rawCode
            : 'MODEL_SWITCH_PREPARE_FAILED'
          if (code === 'MODEL_SWITCH_PREPARE_FAILED') {
            this.log.error('model switch prepare failed', { sessionKey }, err as Error)
          }
          const failure = {
            sourceModel: session.model ?? session.runner.model ?? '',
            errorCode: code,
            message:
              code === 'MODEL_SWITCH_SESSION_BUSY'
                ? '当前回复尚未结束，请稍后再切换模型'
                : code === 'MODEL_SWITCH_SOURCE_CHANGED'
                  ? '会话当前模型已变化，请刷新后重试'
                  : '上下文压缩失败，仍保留原模型',
          }
          session._modelSwitchFailure = { id: requestId, targetModel, at: Date.now(), ...failure }
          reply({ ...failure, status: 'failed' })
        }
      } else if ((frame as any).type === 'control.session.compact') {
        // Compact: send a compaction request to the agent as a user message
        const sessionKey = (frame as any).sessionKey
        if (!sessionKey) return
        const session = this.sessions.getByKey(sessionKey)
        if (!session) {
          ws.send(JSON.stringify(withUserError({ type: 'error', error: 'session not found' })))
          return
        }
        this.log.info('compact session', { sessionKey })
        try {
          await this.sessions.submit(
            session,
            '/compact — 请压缩当前对话上下文,保留关键信息,删除冗余细节。',
            (e) => {
              if (e.kind === 'block') {
                const out = {
                  type: 'outbound.message',
                  sessionKey,
                  channel: 'webchat',
                  peer: { id: sessionKey.split(':')[4] || '__compact__', kind: 'dm' },
                  blocks: [e.block],
                  isFinal: false,
                }
                // Single-ws send (compact progress goes only to the requester),
                // so deliver() isn't appropriate here — stamp ts inline instead
                // so the client's stale-final guard has a monotonic timestamp.
                ws.send(JSON.stringify({ ...out, ts: Date.now() }))
              } else if (e.kind === 'final') {
                ws.send(
                  JSON.stringify({
                    type: 'outbound.message',
                    sessionKey,
                    channel: 'webchat',
                    peer: { id: '__compact__', kind: 'dm' },
                    blocks: [{ kind: 'text', text: '✅ 上下文压缩完成' }],
                    isFinal: true,
                    meta: e.meta,
                    ts: Date.now(),
                  }),
                )
              }
            },
          )
        } catch (err: any) {
          // E5 — 原文进日志,ws 控制面错误帧只发受控文案。
          this.log.error('compact session failed', { sessionKey }, err)
          ws.send(JSON.stringify(withUserError({ type: 'error', error: '上下文压缩失败，请稍后重试' })))
        }
      }
    } catch (err: any) {
      this.log.error('ws-message unhandled error', undefined, err)
      try {
        // E5 — 同上:err.message 可能含内部路径/栈,只回受控文案。
        ws.send(JSON.stringify(withUserError({ type: 'error', error: '服务内部错误，请稍后重试' })))
      } catch {
        /* ws may already be closed */
      }
    }
  })
}

export type AutoResumeFromHelloPeers = Array<{
    peerId: string
    agentId: string
    inFlight?: boolean
    lastFrameSeq?: number
    resumeActiveTurnCandidateMessageIds?: unknown
    inFlightClientMessageId?: string
  }>

export async function autoResumeFromHello(
  this: WsConnectionHost,
  peers: AutoResumeFromHelloPeers,
  ws: WebSocket,
): Promise<void> {
  // Register the reconnected WS client for each peer that has an active/resumable session.
  // Security note: the same trust model applies as inbound.message — the gateway
  // access token is the auth boundary; we validate that a session actually exists
  // (active or in resume-map) before registering.
  const registeredPeerKeys: string[] = []
  const helloUserId = this.getWsUserId(ws)

  for (const peer of peers) {
    const { peerId, agentId } = peer
    // turn-alive-heartbeat (Plan 1, follow-up):destructure all hello-peer
    // fields from the loop iter directly. Previous code did
    // `peers.find(p => p.peerId === peerId)` to re-read `lastFrameSeq` /
    // `inFlight`, but a single hello can legally carry the same peerId
    // against multiple agentIds — that find would match the wrong record
    // and the synthetic-isFinal / replay judgment would silently read the
    // wrong tuple. Reading directly from the loop item is correct by
    // construction.
    const peerLastFrameSeq = peer.lastFrameSeq
    const peerInFlight = peer.inFlight
    const aid = agentId || 'main'
    if (isHiddenSystemAgentId(aid)) {
      this.log.warn('auto-resume hello skipped hidden system agent session', { agentId: aid })
      continue
    }
    const safeId = peerId.replace(/[^a-zA-Z0-9_-]/g, '_')
    const sessionKey = `agent:${aid}:webchat:dm:${safeId}`

    // Check active session first
    let session = this.sessions.getByKey(sessionKey)

    // If not active yet, check resume-map and trigger pre-warm (handles boot race)
    if (!session) {
      const resumableKeys = this.sessions.getResumableKeys((k) => k === sessionKey)
      if (resumableKeys.length > 0) {
        try {
          const cfg = await this._getAgentsConfig()
          const agent = cfg.agents.find((a) => a.id === aid) ?? ({ id: aid } as any)
          // 模型权威 §3:预热的 engine/model 取 catalog 投影(不查 baked);预热非 turn
          // → 不套 codex 真值表。投影拉不到 → 抛 → 下方既有 catch:跳过预热(不回落 baked),
          // 真正的 turn 到来时带 envelope 走 §2 判定。
          const preExec = await resolveLocalExecutionIfEnforced({
            agent,
            kind: 'prewarm',
            defaultModel: this.deps.config.defaults.model,
          })
          session = await this.sessions.getOrCreate({
            sessionKey,
            agent,
            ...localExecutionOverride(preExec),
            channel: 'webchat',
            peerId,
            // Pre-warm path still knows the authenticated userId from the
            // reconnected WS (hello). Pass it through so any turn that
            // fires before a fresh inbound.message can still persist via
            // the direct-userId path instead of short-circuiting on
            // getClientSession(peerId).
            userId: helloUserId,
          })
          this.lastActiveChannel.set(aid, {
            channel: 'webchat',
            peerId,
            sessionKey,
            userId: helloUserId,
            at: Date.now(),
          })
          this.log.info('auto-resume on-demand pre-warmed', { sessionKey })
        } catch (err) {
          this.log.error('auto-resume failed to pre-warm', { sessionKey }, err)
          continue
        }
      } else {
        continue // Not in resume-map either — skip
      }
    }

    const peerKey = makePeerKey(helloUserId, 'webchat', peerId)
    let set = this.clientsByPeer.get(peerKey)
    if (!set) {
      set = new Set()
      this.clientsByPeer.set(peerKey, set)
    }
    if (!set.has(ws)) {
      set.add(ws)
      registeredPeerKeys.push(peerKey)
    }
    this.log.info('auto-resume re-registered WS', { peerKey, sessionKey })
    // lastFrameSeq=0 must not dump the ring (duplicate assistant bubbles).
    // A prepared model-switch is a single idempotent control frame, so catch
    // it up onto this socket even when ring replay is no_buffer.
    const preparedSwitch = session ? preparedModelSwitchCatchupFrame(session) : null
    if (preparedSwitch && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(preparedSwitch))
      } catch {
        /* new socket already gone */
      }
    }

    // ── Phase 0.3: ring-buffer replay on hello.lastFrameSeq ──
    // If the client supplied a cursor, serve anything we still have buffered
    // for this sessionKey. If the ring can't satisfy (pruned / restart /
    // bogus cursor), emit `outbound.resume_failed` so the client triggers
    // a REST force-sync. This is ONLY a short-term optimisation; the
    // durable server-side persistence from Phase 0.1/0.2 remains the
    // authoritative backstop for any duration of disconnect.
    const clientLastSeq = typeof peerLastFrameSeq === 'number' ? peerLastFrameSeq : 0
    const matchedActiveReplay = _matchActiveTurnReplayCandidate(
      session?._runningClientMessageId,
      peer.resumeActiveTurnCandidateMessageIds,
    )
    // OCV5-427: one exact-turn replay per socket and turn. A second hello on
    // the same socket for the same running turn (page-load hello + post-sync
    // registration hello) gets the cursor replay instead of the whole turn
    // again, so the browser does not chew the same frames twice.
    const activeReplayClientMessageId = _unservedActiveTurnReplay(
      this._activeTurnReplaysServed,
      ws,
      sessionKey,
      matchedActiveReplay,
    )
    if (clientLastSeq >= 0) {
      const replay = activeReplayClientMessageId
        ? this._outboundRing.peekActiveTurnReplay(sessionKey, activeReplayClientMessageId)
        : this._outboundRing.peekReplay(sessionKey, clientLastSeq)
      // Read-path pruning may have evicted age-aged frames — record those
      // in metrics regardless of hit/miss outcome, otherwise the `age`
      // cause is severely under-counted for idle sessions whose ring is
      // only ever pruned on resume.
      this._recordRingEvictions(replay.evicted)
      if (replay.ok) {
        if (activeReplayClientMessageId) {
          _noteActiveTurnReplayServed(
            this._activeTurnReplaysServed,
            ws,
            sessionKey,
            activeReplayClientMessageId,
          )
        }
        if (activeReplayClientMessageId) {
          try {
            ws.send(
              JSON.stringify({
                type: 'outbound.active_turn_replay_start',
                sessionKey,
                channel: 'webchat',
                peer: { id: peerId, kind: 'dm' },
                clientMessageId: activeReplayClientMessageId,
              }),
            )
          } catch {
            continue
          }
        }
        // Only count as "hit" when the ring actually rescued frames.
        // `ok` with empty sent means the client was already caught up
        // (fromSeq===currentLast) — the ring did nothing useful, and
        // counting it would inflate hit-rate against ordinary fresh
        // hellos and skew the replay-effectiveness signal.
        if (replay.sent.length > 0) {
          outboundRingReplayHitTotal.inc()
          for (const f of replay.sent) {
            try {
              const parsed = JSON.parse(f.data) as { type?: unknown; clientMessageId?: unknown }
              if (
                !isClientMessageId(parsed.clientMessageId) &&
                (parsed.type === 'outbound.message' || parsed.type === 'outbound.error')
              ) {
                continue
              }
            } catch {
              /* non-JSON ring payload still delivered */
            }
            try {
              ws.send(f.data)
            } catch {
              break
            }
          }
          this.log.info('resume replay served', {
            sessionKey,
            from: activeReplayClientMessageId ? 'active-turn-start' : clientLastSeq,
            to: replay.to,
            sent: replay.sent.length,
          })
        }
      } else {
        outboundRingReplayMissTotal.inc({ reason: replay.reason })
        try {
          ws.send(
            JSON.stringify({
              type: 'outbound.resume_failed',
              sessionKey,
              channel: 'webchat',
              peer: { id: peerId, kind: 'dm' },
              from: clientLastSeq,
              to: replay.to,
              reason: replay.reason,
              ts: Date.now(),
            }),
          )
          this.log.warn('resume replay miss — signalled resume_failed', {
            sessionKey,
            from: activeReplayClientMessageId ? 'active-turn-start' : clientLastSeq,
            to: replay.to,
            reason: replay.reason,
          })
        } catch {}
      }
    }

    // Plan 2 (compact-progress-frame) — 在 ring replay 之后,如果 runner 仍在跑
    // 且 session.currentTurnStatus !== null,补发一帧 outbound.turn_status 给本次
    // 重连的 ws。覆盖 "压缩进行中客户端断网 + ring 已冲掉原 compact_start 帧"
    // 这种 ring-replay 兜不住的边角:
    //   - 正常短暂断网:ring 仍持有 compact_start,replay 就够了 → cache 这帧
    //     会被前端识别成幂等(已在 compacting,再来一帧仍 compacting,无副作用)
    //   - 长 compact + 长断网 + ring 满:replay 拿不回 compact_start,这里兜底
    //   - runner 已停:不发(turn 已结束,前端会收到 ring 里的 isFinal 或者
    //     紧跟着的 turn-interrupted isFinal,自行清空 UI 状态)
    //   - runner 在跑且 phase 为 null 也发(status:null):启动态的清态帧可能
    //     发生在无浏览器连接期间,不补发前端会一直停在「正在启动引擎」
    //     (INC-20261028-STALE-ENGINE-STARTING)
    // 单 ws send(只给本次 hello 的 client 看,不是所有 peerKey),与下方
    // synthetic isFinal 同模式 —— 不走 deliver(),避免把同一帧再 ring + 广播。
    const resendPhase = session
      ? _helloTurnStatusResendPhase(session.runner.isRunning, session.currentTurnStatus)
      : undefined
    if (resendPhase !== undefined) {
      try {
        const phase = resendPhase
        // retrying 补发展平为 status:'retrying' + 平级 retry(前端按 retry.retryAt
        // 重算剩余倒计时,不从完整 delayMs 重头显示);compacting/null 照旧。
        const turnStatusFrame = JSON.stringify({
          type: 'outbound.turn_status',
          sessionKey,
          channel: 'webchat',
          peer: { id: peerId, kind: 'dm' },
          ..._turnStatusWireFields(phase),
          ts: Date.now(),
        })
        ws.send(turnStatusFrame)
        this.log.info('auto-resume rebroadcast turn_status', {
          sessionKey,
          status: phase && typeof phase === 'object' ? phase.status : phase,
        })
      } catch {}
    }

    // INC-20260903-PENDING-PERMISSION-LOST — a prompt emitted while this
    // socket was not yet registered is otherwise never re-sent, and the
    // engine waits in waitingForUserInput indefinitely. Replay the still
    // answerable pending prompts scoped to this exact sessionKey+peerKey to
    // the newly registered socket only (no ring/frameSeq, no other tabs).
    if (ws.readyState === WebSocket.OPEN) {
      const catchup = _pendingPermissionCatchupFrames(this._pendingPermissions, sessionKey, peerKey)
      let sentCount = 0
      for (const frame of catchup) {
        try {
          ws.send(JSON.stringify(frame))
          sentCount += 1
        } catch {
          break
        }
      }
      if (sentCount > 0) {
        this.log.info('auto-resume replayed pending permission prompts', {
          sessionKey,
          count: sentCount,
        })
      }
    }

    // Push a synthetic isFinal to the reconnected client for sessions that the client
    // reports as in-flight (had _sendingInFlight=true) but whose subprocess is not
    // currently running. This clears the client's stuck _sendingInFlight state from
    // the interrupted turn. Without this, the client shows a permanent typing indicator
    // and the resumed subprocess sits idle — neither side moves first.
    //
    // turn-alive-heartbeat (Plan 1) — 判据走 `_shouldPushTurnInterruptedFinal`
    // 纯函数 helper,根治"phantom-turn retry / auth-refresh restart / effort+
    // model swap shutdown 等 turn 内部 subprocess respawn 窗口被误判为 turn 已
    // 结束"的 bug。判据细节 + 真值源对比见 helper 注释。`peerInFlight` 取自
    // 当前 hello-peer iter 项(顶部 destructure),不再用 find(peerId) — 那条
    // 同型债已在循环入口修掉。
    //
    // 当前 scope 限于 `submit()` 内的 subprocess respawn 窗口。dispatchInbound
    // 预处理(mkdir / writeFile / parseDocument 等异步阶段,getOrCreate 后、
    // submit 前)是另一类同症状窗口,留作 Plan 1 follow-up 单独评估
    // (涉及 idempotency / rate-limit 失败路径要不要 counter-- 的语义)。
    // RFC-v5-durable-turn-dispatch §4 — reconcile 身份对称决策表。
    //
    // 前端带 inFlightClientMessageId(_activeClientMessageId)时走**精确身份对账**:
    // 不再拿"上一轮 outcome"冒充这一轮终态(R3 根因)。字段缺失(legacy 客户端)
    // 回落旧 _shouldPushTurnInterruptedFinal 布尔判据,行为完全不变。
    const inFlightCmid = peer.inFlightClientMessageId
    if (session && typeof inFlightCmid === 'string' && inFlightCmid !== '') {
      // running 匹配 → 现有 status 重播 / ring replay 已覆盖(上方),不推合成终态。
      if (session._runningClientMessageId === inFlightCmid) {
        // no-op:该 turn 仍在飞,前端会收到重播的流式帧。
      } else {
        const outcome = lookupRecentTerminal(session, inFlightCmid, {
          masterAuthoritative: readV3MasterSinkConfig() !== null,
        })
        // 合成帧一律携带 clientMessageId(reducer 按 exact id 归属;绝不误清别的 user 行)。
        const basePeer = { id: peerId, kind: 'dm' as const }
        try {
          if (outcome === 'completed') {
            // ring 命中 completed → turn_completed reconcile(空 blocks,前端清发送态 +
            // force-sync 拉 REST 权威内容;绝不用"被中断请重发"诱导重复付费)。
            ws.send(
              JSON.stringify({
                type: 'outbound.message',
                sessionKey,
                channel: 'webchat',
                peer: basePeer,
                agentId: aid,
                blocks: [],
                clientMessageId: inFlightCmid,
                meta: { reconcile: 'turn_completed', clientMessageId: inFlightCmid } as any,
                isFinal: true,
                ts: Date.now(),
              }),
            )
            this.log.info('auto-resume reconcile turn_completed (id-bound)', {
              sessionKey,
              clientMessageId: inFlightCmid,
            })
          } else if (outcome === 'interrupted' || outcome === 'crashed') {
            // ring 命中中断类 → interrupted reconcile(带 id)。
            ws.send(
              JSON.stringify({
                type: 'outbound.message',
                sessionKey,
                channel: 'webchat',
                peer: basePeer,
                agentId: aid,
                blocks: [],
                clientMessageId: inFlightCmid,
                meta: {
                  reconcile: 'turn_interrupted',
                  interrupted: 'service_restart',
                  clientMessageId: inFlightCmid,
                } as any,
                isFinal: true,
                ts: Date.now(),
              }),
            )
            this.log.info('auto-resume reconcile turn_interrupted (id-bound)', {
              sessionKey,
              clientMessageId: inFlightCmid,
            })
          } else if (
            _shouldInterruptUnknownInFlight({
              runningClientMessageId: session._runningClientMessageId,
              admittingClientMessageId: session._admittingClientMessageId,
              inFlightClientMessageId: inFlightCmid,
              engineTurnCount: session._activeTurnCount,
              clientTurnCount: session._activeClientTurnCount,
            })
          ) {
            // V5 master-authoritative lookup 在容器侧恒为 unknown。若本进程
            // 已不在跑该 cmid（重启后 liveSkipped / Grok 子进程已死 / 已换新 recover），
            // 再发非 final turn_state_unknown 会让前端按 RFC §4 永远留「思考中」。
            // 计数器都是 0 时生产者已不在本进程，合成 interrupted 终态清发送态。
            ws.send(
              JSON.stringify({
                type: 'outbound.message',
                sessionKey,
                channel: 'webchat',
                peer: basePeer,
                agentId: aid,
                blocks: [],
                clientMessageId: inFlightCmid,
                meta: {
                  reconcile: 'turn_interrupted',
                  interrupted: 'service_restart',
                  clientMessageId: inFlightCmid,
                } as any,
                isFinal: true,
                ts: Date.now(),
              }),
            )
            this.log.info('auto-resume reconcile unknown-in-flight as interrupted (id-bound)', {
              sessionKey,
              clientMessageId: inFlightCmid,
            })
          } else {
            // 未知身份(ring 未命中 且 非 running)→ **非 final** turn_state_unknown。
            // 不冒充终态:前端立即 reconcileSession(force-sync)+ 缩短 safety 定时,
            // 由 REST 权威内容决定该 user 行的真实归宿。
            ws.send(
              JSON.stringify({
                type: 'outbound.message',
                sessionKey,
                channel: 'webchat',
                peer: basePeer,
                agentId: aid,
                blocks: [],
                clientMessageId: inFlightCmid,
                meta: { reconcile: 'turn_state_unknown', clientMessageId: inFlightCmid } as any,
                isFinal: false,
                ts: Date.now(),
              }),
            )
            this.log.info('auto-resume reconcile turn_state_unknown (id-bound)', {
              sessionKey,
              clientMessageId: inFlightCmid,
            })
          }
        } catch {}
      }
    } else if (
      session &&
      _shouldPushTurnInterruptedFinal(
        peerInFlight,
        session._activeTurnCount,
        session._activeClientTurnCount,
      )
    ) {
      try {
        // Single-ws send (only the hello-ing client should see this notice),
        // so deliver() isn't appropriate here — stamp ts inline.
        //
        // team-durability — 按最近客户 turn 的收尾方式分流:
        //   - 'completed':turn 已在服务端正常完成,客户端只是错过了终态帧
        //     (断连窗口 + ring 冲穿)。推**静默 reconcile final**(空 blocks +
        //     meta.reconcile),前端清发送态并 force-sync 拉回 REST 权威内容。
        //     绝不能用"被中断请重发"文案 —— turn 已计费,诱导重发=重复付费。
        //   - 'errored'/undefined(重启后 warm session 丢字段等):维持
        //     service_restart 中断语义。
        //
        // 【对称性根治 2026-07-11】两支**统一为空 blocks + 纯 meta 标记**,只差 meta 键。
        // 旧实现的不对称(completed→空 blocks 静默 / interrupted→带 ⚠️ **text 块**)是
        // phantom 中断卡的服务端根因:重启后 warm session 的 turn 计数恒为 0,只要客户端
        // 上报 inFlight(含 tool-only 在途 / 卡死残留 / 已完成轮的 stale flag)就补推这帧,
        // 而 text 块会在前端 §7 block 循环里被 findOrCreateStreamingRow 落成一条**新 assistant
        // 气泡**并持久化(生产实证)。合成 final 是**清扫在途发送态**的带外信号,绝不该注入
        // 持久正文 —— 「是否真被掐断/要不要提示续写」的权威在 client(它才知道本地有没有在途
        // 流式内容),故此处只发标记,由 reducer §11 按本地在途流决定续写 vs 静默收口。
        const completedNormally = session._lastClientTurnOutcome === 'completed'
        const reconcileFrame = JSON.stringify({
          type: 'outbound.message',
          sessionKey,
          channel: 'webchat',
          peer: { id: peerId, kind: 'dm' },
          agentId: aid,
          blocks: [],
          meta: (completedNormally
            ? { reconcile: 'turn_completed' }
            : { interrupted: 'service_restart' }) as any,
          isFinal: true,
          ts: Date.now(),
        })
        ws.send(reconcileFrame)
        this.log.info(
          completedNormally
            ? 'auto-resume pushed turn-completed reconcile isFinal'
            : 'auto-resume pushed turn-interrupted isFinal',
          { sessionKey },
        )
      } catch {}
    }
  }

  // Single close handler for all peers registered via this hello (avoids listener accumulation)
  if (registeredPeerKeys.length > 0) {
    ws.once('close', () => {
      for (const peerKey of registeredPeerKeys) {
        const set = this.clientsByPeer.get(peerKey)
        if (set) {
          set.delete(ws)
          if (set.size === 0) this.clientsByPeer.delete(peerKey)
        }
      }
    })
  }
}

export type HandleStopFrame = {
    type: 'inbound.control.stop'
    channel: string
    peer: { id: string; kind: 'dm' | 'group' }
    agentId?: string
    sessionKey?: string
    clientMessageId?: string
  }

export async function handleStop(
  this: WsConnectionHost,
  frame: HandleStopFrame,
): Promise<boolean> {
  let sessionKey = frame.sessionKey
  const explicitStopAgentId = sessionKey?.split(':')[1] ?? frame.agentId
  if (explicitStopAgentId && isHiddenSystemAgentId(explicitStopAgentId)) {
    this.log.warn('interrupt hidden system agent rejected', { agentId: explicitStopAgentId })
    return false
  }
  const safePeerId = frame.peer.id.replace(/[^a-zA-Z0-9_-]/g, '_')
  const suffix = `:${frame.channel}:${frame.peer.kind}:${safePeerId}`
  const clientMessageId = isClientMessageId(frame.clientMessageId)
    ? frame.clientMessageId
    : undefined

  // Exact browser identity is authoritative across assistant switches. Scan
  // the peer's live agent sessions and interrupt only the matching owner,
  // then cascade through the captain's delegate/reviewer tree.
  if (clientMessageId) {
    for (const live of this.sessions.list()) {
      if (!live.sessionKey.endsWith(suffix)) continue
      const selfInterrupted = this.sessions.interruptClientTurn(live.sessionKey, clientMessageId)
      if (!selfInterrupted) continue
      const delegateInterrupted = this._interruptDelegationsForParent(live.sessionKey)
      const ok = selfInterrupted || delegateInterrupted
      // The turn is gone; any permission it was blocked on must not
      // outlive it as a dead card (browser) / pending row (master).
      this._settlePendingPermissionsForStop(live.sessionKey, clientMessageId)
      this.log.info('interrupt', {
        sessionKey: live.sessionKey,
        clientMessageId,
        ok,
      })
      return ok
    }
    // OCV5-435: accepted but its engine run does not exist yet (cold start,
    // lock wait). Bind the Stop to that exact turn instead of answering
    // TURN_NOT_ACTIVE and letting it run unseen.
    if (this._admittedClientTurns?.has(preStartStopKey(frame.peer.id, clientMessageId))) {
      this.sessions.fencePreStartStop(frame.peer.id, clientMessageId)
      this.log.info('interrupt', {
        sessionKey: `*${suffix}`,
        clientMessageId,
        ok: true,
        preStart: true,
      })
      return true
    }
    // Not admitted here yet: the Stop may have overtaken its own message
    // (Master acks admission before forwarding it). Arm a short fence for
    // that send attempt; admission of the same attempt extends it, another
    // attempt drops it. Nothing is active now, so the receipt stays
    // TURN_NOT_ACTIVE.
    this.sessions.fencePreStartStop(
      frame.peer.id,
      clientMessageId,
      PRE_ADMISSION_STOP_TTL_MS,
      stopControlSendAttempt((frame as { controlId?: unknown }).controlId, clientMessageId),
    )
    this.log.info('interrupt', {
      sessionKey: `*${suffix}`,
      clientMessageId,
      ok: false,
    })
    return false
  }
  if (!sessionKey) {
    if (frame.agentId) {
      sessionKey = `agent:${frame.agentId}:${frame.channel}:${frame.peer.kind}:${frame.peer.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`
    } else {
      let interrupted = false
      for (const live of this.sessions.list()) {
        if (!live.sessionKey.endsWith(suffix)) continue
        const selfInterrupted = this.sessions.interrupt(live.sessionKey, 'user')
        const delegateInterrupted = this._interruptDelegationsForParent(live.sessionKey)
        if (selfInterrupted) this._settlePendingPermissionsForStop(live.sessionKey)
        interrupted = selfInterrupted || delegateInterrupted || interrupted
      }
      if (interrupted) {
        this.log.info('interrupt', { sessionKey: `*${suffix}`, ok: true })
        return true
      }
      const routed = this.router.route({
        type: 'inbound.message',
        idempotencyKey: '',
        channel: frame.channel,
        peer: frame.peer,
        content: {},
        ts: Date.now(),
      } as any)
      sessionKey = routed.sessionKey
    }
  }
  const selfInterrupted = this.sessions.interrupt(sessionKey, 'user')
  const delegateInterrupted = this._interruptDelegationsForParent(sessionKey)
  if (selfInterrupted) this._settlePendingPermissionsForStop(sessionKey)
  let ok = selfInterrupted || delegateInterrupted
  // Compatibility containment for already-open clients: if their selector
  // changed before Stop, the legacy frame names the new agent. Only on a
  // direct miss do we fall back to the existing peer-wide stop behavior.
  if (!ok && frame.agentId) {
    for (const live of this.sessions.list()) {
      if (!live.sessionKey.endsWith(suffix)) continue
      const fallbackSelf = this.sessions.interrupt(live.sessionKey, 'user')
      const fallbackDelegates = this._interruptDelegationsForParent(live.sessionKey)
      if (fallbackSelf) this._settlePendingPermissionsForStop(live.sessionKey)
      ok = fallbackSelf || fallbackDelegates || ok
    }
  }
  this.log.info('interrupt', { sessionKey, ok })
  return ok
}

export type DeliverOut = | OutboundMessage
    | OutboundError
    | OutboundCodexBilling
    | OutboundExternalEngineBilling
    | OutboundTurnStatus
    | OutboundTurnUsage
    | OutboundCallUsage
    | SysContextRebuilt
    | SessionContextPressure
    | SysContextCompacted

/**
 * Outbound frame egress — WS broadcast + outboundRing + optional adapter fan-out.
 *
 * 入参 union 反映协议演化:历史上只发 OutboundMessage,后续加了 OutboundError /
 * OutboundCodexBilling / OutboundTurnStatus(后两个是 sideband:不带 .blocks,
 * adapter (Telegram / 微信) 假设的 OutboundMessage 形状)。union 起来后:
 *   - sideband type literal 比较 (`wire.type === 'outbound.turn_status'`) 合法
 *   - caller 不再需要 `as unknown as OutboundMessage` 强转(那是协议演化债,
 *     现在统一清掉,deliver 类型签名直接承认所有合法 deliverable shape)
 *
 * 内部访问的只是 `.type / .channel / .peer / .sessionKey`,这些字段在 union 的
 * 四个成员上都有(交集字段),所以 narrowing 不需要,直接读即可。
 */
export function deliver(
  this: WsConnectionHost,
  out:
    DeliverOut,
  adapter?: ChannelAdapter,
): void {
  // V3 S12e CG6 — strip ALL private routing fields up-front (`_userId`,
  // `_traceId`, `_connectionTraceId`, `_peerId`)so BOTH adapter and WS
  // branches only ever see the clean wire shape. CG7 will start writing
  // `_traceId` / `_connectionTraceId` on outbound frames in
  // dispatchInbound stamp; doing the strip via a shared helper now
  // (rather than only `_userId`)means CG7 doesn't have to revisit this
  // strip site every time it adds a new private field. Keeping stripped
  // values locally lets WS branch still route per-user.
  const { wire: strippedWire, userId: stampedUserId } = _stripPrivateRoutingFields(out)
  const wire = withUserError(strippedWire)
  if (wire.type === 'outbound.message' || wire.type === 'outbound.error') {
    const sessionKey =
      typeof (wire as { sessionKey?: unknown }).sessionKey === 'string'
        ? (wire as { sessionKey: string }).sessionKey
        : undefined
    const current = (wire as { clientMessageId?: unknown }).clientMessageId
    const rebound = rebindOutboundClientMessageId({
      clientMessageId: typeof current === 'string' ? current : undefined,
      sessionKey,
      isFenced: (sk, cmid) => this._outboundRing?.isTurnFenced(sk, cmid) === true,
      openTurnClientMessageId: sessionKey
        ? this._outboundRing?.activeTurnClientMessageId(sessionKey)
        : undefined,
    })
    if (rebound) (wire as { clientMessageId?: string }).clientMessageId = rebound
    // biome-ignore lint/performance/noDelete: moved verbatim from server.ts (OCV5-483); pre-existing there
    else delete (wire as { clientMessageId?: string }).clientMessageId
  }
  // Plan 2 (compact-progress-frame) — sideband frame 跳过 adapter,只走 WS。
  // 背景:adapter (Telegram / 微信等) 的契约是 `OutboundMessage` 形状(.blocks
  // 必存,见 channels/telegram/src/index.ts:96 `for (const b of out.blocks)`),
  // 但 outbound.turn_status 没有 blocks,强发会让 adapter 在迭代 .blocks 时抛
  // TypeError,被 catch 后只留下日志噪声。turn_status 本身就是给 webchat
  // typing-indicator UX 用的 sideband,Telegram 用户不会看 "压缩中" 提示。
  //
  // 注:OutboundCodexBilling / OutboundError 同型问题(都没 .blocks),adapter
  // 分支同样会因 `for (const b of out.blocks)` 抛错被 catch。codex_billing 当前
  // 不实际触发(没有 codex+telegram 生产组合);OutboundError 在 telegram 路径
  // 上 insufficient_credits / rate_limited / upstream_failed 时会触发,但已存在
  // 历史,被 telegram.send 的 catch 静默成 error log。本 PR 不顺手修这条线,留
  // 作独立 "non-message outbound vs adapter contract" 清理(届时 isSideband 白
  // 名单一并扩到 outbound.codex_billing / outbound.error,或重新设计 adapter
  // 协议让它能 dispatch 非 message 帧)。
  // sideband = 无 .blocks 的帧,强发给 adapter(Telegram/微信,假设 OutboundMessage
  // 形状 for (b of out.blocks))会抛。sys.context_rebuilt 同 turn_status:webchat-only
  // UX 提示帧,跳过 adapter 只走 WS(非 webchat channel 找不到 ws client → noop)。
  const isSideband =
    wire.type === 'outbound.turn_status' ||
    wire.type === 'outbound.turn_usage' ||
    wire.type === 'outbound.call_usage' ||
    wire.type === 'sys.context_rebuilt' ||
    wire.type === 'session.context_pressure' ||
    wire.type === 'sys.context_compacted'
  if (adapter && !isSideband) {
    adapter
      .send(wire as OutboundMessage)
      .catch((err) => this.log.error('adapter send failed', { channel: adapter.name }, err))
    return
  }
  // adapter && isSideband:fall-through 到 WS 广播路径。peerKey 用 channel +
  // peer.id 索引,Telegram 来源的 turn_status 找不到 ws client → noop,符合
  // "sideband 对非 webchat channel 不可见" 的语义。ring 仍会 store(本帧带
  // sessionKey),但因为 telegram channel 不走 hello-resume,store 不消费,
  // 略浪费但无害,不值得为此再分一条 ring 路径。
  // WebChat: broadcast to all ws clients at the same (userId, channel, peer).
  // userId is read from the `_userId` stamp that callers put on the out
  // frame when they know it. If absent (legacy cron / shutdown paths),
  // fall back to 'default' — personal edition is single-user, so every
  // connected ws registers under userId='default' anyway. On v2 cherry-pick
  // all non-stamped call sites will need updating to route correctly.
  const deliverUserId: string = typeof stampedUserId === 'string' ? stampedUserId : 'default'
  const peerKey = makePeerKey(deliverUserId, wire.channel, wire.peer.id)
  // ── Phase 0.3: stamp frameSeq + push to ring buffer ──
  // We stamp + store even if no clients are currently connected — that's
  // the whole point: a later autoResumeFromHello for this sessionKey needs
  // the frames to be in the buffer regardless of whether anyone was
  // listening at the moment of the original deliver.
  // Stamp a server-assigned monotonic timestamp on every outbound frame so
  // the web client can reject stale / out-of-order frames after reconnect
  // or agent switches. Schema keeps `ts` unvalidated (extra field is
  // tolerated), so no protocol version bump is required.
  const now = Date.now()
  const sessionKey = (wire as { sessionKey?: string }).sessionKey
  let data: string
  if (sessionKey) {
    const frameSeq = this._outboundRing.nextSeq(sessionKey)
    data = JSON.stringify({ ...wire, ts: now, frameSeq })
    // team-durability 帧分级:delegate_progress-only 的 outbound.message 与
    // turn_status sideband 是易失 UX 帧(REST 权威副本不含、也不需要),归
    // 'progress' 级 —— ring 超限时先淘它们,保住正文/终态帧的回放窗口。团队模式
    // review/嵌套委派以 >15 帧/s 刷进度帧,不分级时 2 分钟就冲穿整个 ring。
    const blocks = (wire as { blocks?: Array<{ kind?: string }> }).blocks
    const isProgressFrame =
      wire.type === 'session.context_pressure' ||
      wire.type === 'outbound.turn_status' ||
      wire.type === 'outbound.turn_usage' ||
      wire.type === 'outbound.call_usage' ||
      (wire.type === 'outbound.message' &&
        Array.isArray(blocks) &&
        blocks.length > 0 &&
        !(wire as { isFinal?: boolean }).isFinal &&
        blocks.every((b) => b?.kind === 'delegate_progress'))
    const evicted = this._outboundRing.store(
      sessionKey,
      frameSeq,
      now,
      data,
      isProgressFrame ? 'progress' : 'content',
    )
    this._recordRingEvictions(evicted)
  } else {
    data = JSON.stringify({ ...wire, ts: now })
  }
  const set = this.clientsByPeer.get(peerKey)
  if (!set) return
  for (const ws of set) {
    try {
      ws.send(data)
    } catch {}
  }
}

/** Phase 4 — send outbound.control.session_repo_status to a single ws,容错 closed/error。 */
export function _sendStatusFrame(
  this: WsConnectionHost,
  ws: WebSocket,
  frame: SessionRepoStatusOut,
): void {
  try {
    if (ws.readyState !== ws.OPEN) {
      // v1.0.95 诊断 instrument:这是最可能的 silent swallow 点 — 容器侧
      // emit 了 status 但 ws 已闪断,master 永远收不到。Codex NIT:统一字段。
      this.log.warn('repo_status_send_swallowed_ws_closed', {
        sessionId: frame.sessionId,
        selectionVersion: frame.selectionVersion,
        status: frame.status,
        readyState: ws.readyState,
      })
      return
    }
    ws.send(JSON.stringify(frame))
    // v1.0.95 诊断 instrument:status 帧成功推到 ws.send;若 master log 看到这个
    // 但没看到 repo_status_forwarded,根因就在 mTLS tunnel / master bridge 解析侧。
    this.log.info('repo_status_sent', {
      sessionId: frame.sessionId,
      selectionVersion: frame.selectionVersion,
      status: frame.status,
      readyState: ws.readyState,
    })
  } catch (err) {
    this.log.warn('send_repo_status_failed', {
      sessionId: frame.sessionId,
      selectionVersion: frame.selectionVersion,
      status: frame.status,
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Send a session-scoped wire frame to all WS clients at a peerKey, stamping
 *  it with `frameSeq` + `ts` and storing it in `_outboundRing` so a later
 *  `autoResumeFromHello` reconnect can replay it. WS-only equivalent of
 *  `deliver()` for non-message frames (permission_request / permission_settled).
 *  Adapter dispatch is not applicable — these frames are interactive-only.
 *
 *  When `sessionKey` is empty (legacy fallback path with no server-side
 *  pending entry to look up), we skip ring storage and only broadcast — the
 *  same `else` branch deliver() uses for frames without a sessionKey. */
export function _sendStampedSessionFrame(
  this: WsConnectionHost,
  sessionKey: string,
  peerKey: string,
  wireFrame: Record<string, unknown>,
): void {
  // V3 S12e CG7 — strip private routing fields before WS broadcast / ring
  // store. Mirrors what `deliver()` does, so `_inheritOutboundRouting(out)`
  // callers(e.g. permFrame builder)can safely include private stamps like
  // `_userId` without leaking on wire. Audit pair with `_stripPrivateRoutingFields`
  // in deliver() — both paths converge through the same known-fields helper.
  const { wire } = _stripPrivateRoutingFields(wireFrame)
  const now = Date.now()
  let data: string
  if (sessionKey) {
    const frameSeq = this._outboundRing.nextSeq(sessionKey)
    data = JSON.stringify({ ...wire, ts: now, frameSeq })
    const evicted = this._outboundRing.store(sessionKey, frameSeq, now, data)
    this._recordRingEvictions(evicted)
  } else {
    data = JSON.stringify({ ...wire, ts: now })
  }
  const set = this.clientsByPeer.get(peerKey)
  if (!set) return
  for (const ws of set) {
    try {
      ws.send(data)
    } catch {}
  }
}

/**
 * 消费一条 bridge inbound.message 上的模型执行权威(方案 §2)。
 *
 * @returns true = 放行(descriptor 已挂载 / 本地路径无需 authority);
 *          false = **拒帧**(已回 error 帧,调用方必须 return,不得 dispatch)
 *
 * 真值表(fail-closed 优先):
 *   | 来源      | 帧带 envelope | 容器能验签 | required | 结果                    |
 *   |-----------|---------------|-----------|----------|-------------------------|
 *   | 本地 WS   | —             | —         | —        | 放行(baked 判定,零变化)|
 *   | bridge    | 否            | —         | 否       | 放行(flag 未开的旧行为) |
 *   | bridge    | 否            | —         | **是**   | **拒**(flag 开 = 必须带)|
 *   | bridge    | 是            | 否        | —        | **拒**(验不了就不许信)  |
 *   | bridge    | 是            | 是        | —        | 验签 + 全断言,过 → 挂载 |
 *
 * 「带 envelope 但容器验不了签」为什么必须拒而不是回落 baked:master 已按 descriptor
 * 完成计费编排(codex 预扣 / journal),容器若改用自己的 baked 判定跑,就是**计费与执行
 * 分裂**。宁可拒帧让用户重发(桥会把这类容器 recycle 掉)。
 */
export function _consumeFrameAuthority(
  this: WsConnectionHost,
  ws: WebSocket,
  frame: Record<string, unknown>,
  isFromBridge: boolean,
): boolean {
  // 本地路径(个人版前端 / 容器内自连):不消费 authority。wire 字段由
  // dispatchInbound 入口无条件 strip(客户端塞的同名字段永不被信任)。
  if (!isFromBridge) return true

  const hasEnvelope =
    frame[MODEL_AUTHORITY_FIELD] !== undefined && frame[MODEL_AUTHORITY_FIELD] !== null
  const conn = this._authorityConns.get(ws)

  if (!hasEnvelope) {
    if (this._modelAuthority.required) {
      this._rejectAuthority(ws, 'missing', 'inbound frame carries no model authority', frame)
      return false
    }
    return true
  }

  try {
    if (!conn) {
      throw new AuthorityRejected('not_configured', 'no authority context for this connection')
    }
    const descriptor = this._modelAuthority.consume(frame, conn)
    attachTurnAuthority(frame, descriptor)
    return true
  } catch (err) {
    const rejection =
      err instanceof AuthorityRejected
        ? err
        : new AuthorityRejected('bad_shape', (err as Error)?.message ?? String(err))
    this._rejectAuthority(ws, rejection.code, rejection.message, frame)
    return false
  }
}
