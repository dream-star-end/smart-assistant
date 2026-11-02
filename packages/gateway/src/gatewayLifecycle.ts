import { createTaskboardPreflight } from './taskboard/stagePreflight.js'
import { startLogTimingReporter } from '@openclaude/protocol/nodeLogTiming'
/**
 * Gateway lifecycle: start-up, shutdown, boot auto-resume, turn-dispatch inbox recovery, notifier and scheduler ticks
 *
 * Moved verbatim out of Gateway (server.ts) — FINDINGS §7.6, OCV5-493. The class
 * keeps one-line forwarders that call these with the instance as `this`, so behaviour, closures and
 * `this.x` reads/writes are unchanged. GatewayLifecycleHost lists exactly the Gateway members this code
 * touches (typed from the class itself).
 */
import { mkdirSync, readdirSync, realpathSync, statSync, unlinkSync } from 'node:fs'
import { startUploadRetention, stopUploadRetention } from './uploadRetention.js'
import type { LogContext } from './logger.js'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import type { ChannelContext } from '@openclaude/plugin-sdk'
import type { OutboundMessage } from '@openclaude/protocol'
import { resolveGatewayListen } from './gatewayBind.js'
import { type AgentDef, paths, getClientSession, turnDispatchInboxStats } from '@openclaude/storage'
import { readV3MasterSinkConfig } from './v3MasterSink.js'
import { isHiddenSystemAgentId } from './agentVisibility.js'
import { WebSocketServer } from 'ws'
import { CronScheduler } from './cron.js'
import { deliverCronOutput, type CronDeliverDeps } from './cronDeliver.js'
import { recoverInterruptedSendToAgentIntents } from './sendToAgentIntentStore.js'
import { setPatrolExecutionHandler } from './taskboard/http.js'
import { getTaskboardDb } from './taskboard/db/index.js'
import { isTaskboardEnabled } from './taskboard/feature.js'
import { PatrolEngine } from './taskboard/patrol.js'
import { TaskboardNotifier } from './taskboard/notify.js'
import { sendV3WechatProactive, readV3WechatProactiveConfig } from './v3WechatProactive.js'
import { sendV3QqProactive, readV3QqProactiveConfig } from './v3QqProactive.js'
import { postInboxMessageDurable } from './v3InboxPost.js'
import { postInboxAlertDurable } from './v3InboxAlert.js'
import {
  isDelegateDurableEffective,
  isDelegateNotifierEffective,
  isDelegateSmEnabled,
  resolveDelegateCallbackOwner,
} from './delegateSmFlag.js'
import {
  DefaultEngineNotifier,
  writeInlinePushForSession,
  type InlinePushSession,
} from './engineNotifier.js'
import { resolveParentTapeIngestState, type ParentTapeIngestState } from './delegateNotifyTape.js'
import { delayUntilNextNotifyRetry } from './delegateNotifyDispatch.js'
import { formatJobTerminalMarkdown, injectPayloadFromJobTerminal } from './jobTerminal.js'
import { delegateCallbackMessageId, restoreDelegateJobSnapshots } from './delegateCompleter.js'
import { eventBus } from './eventBus.js'
import { startEventPersistence } from './eventPersist.js'
import { startMemoryTurnObserver } from './memoryTurnObserver.js'
import { startMemoryUsageReporter } from './memoryUsageReporter.js'
import {
  startMetricsCollection,
  outboundRingSizeBytes,
  delegateNotifyTotal,
  delegateNotifyLatencyMs,
} from './metrics.js'
import { WebhookRouter } from './webhooks.js'
import { startToolFailureReporter } from './v3ToolFailureReporter.js'
import { startSkillUsageReporter } from './skillUsageReporter.js'
import { startSkillShadowReporter } from './skillShadowReporter.js'
import {
  buildSyntheticCrashedTapePayload,
  inboxSinkStageFailedByDispatch,
  inboxSinkStagedByDispatch,
  isTurnDispatchLive,
  queryMasterTapeState,
  recoverTurnDispatchInboxOnBoot,
  resolveInboxTerminalAck,
} from './turnDispatchInbox.js'
import { localExecutionRejectCode } from './modelCatalogClient.js'
import {
  resolveLocalExecutionIfEnforced,
  localExecutionOverride,
  resolveSyntheticTurnModel,
} from './localExecution.js'
import { makePeerKey, PENDING_PERMISSION_SWEEP_MS } from './server.js'
import type { Gateway } from './server.js'
import { handedOffDelegateRetryDelay, retryHandedOffDelegateNotifies } from './delegateWaitHandoff.js'

export interface GatewayLifecycleHost {
  _activeSendToAgentCallbacks: Gateway['_activeSendToAgentCallbacks']
  _armNotifyRetryScheduler: Gateway['_armNotifyRetryScheduler']
  _containerPreview: Gateway['_containerPreview']
  _delegateJobs: Gateway['_delegateJobs']
  _deliverInterruptedSendToAgentIntent: Gateway['_deliverInterruptedSendToAgentIntent']
  _doShutdown: Gateway['_doShutdown']
  _drainFlagOffCronOriginNotifies: Gateway['_drainFlagOffCronOriginNotifies']
  _durableTurnDispatchReady: Gateway['_durableTurnDispatchReady']
  _engineNotifier: Gateway['_engineNotifier']
  _ensureDelegateJobStore: Gateway['_ensureDelegateJobStore']
  _ensureDurableSendToAgentCallback: Gateway['_ensureDurableSendToAgentCallback']
  _getAgentsConfig: Gateway['_getAgentsConfig']
  _getCachedTasks: Gateway['_getCachedTasks']
  _invalidateTaskCache: Gateway['_invalidateTaskCache']
  _kickV3RetryDrainer: Gateway['_kickV3RetryDrainer']
  _notifyRetryTimer: Gateway['_notifyRetryTimer']
  _oauthRefreshTimer: Gateway['_oauthRefreshTimer']
  _outboundRing: Gateway['_outboundRing']
  _pendingPermissionSweepTimer: Gateway['_pendingPermissionSweepTimer']
  _persistAndCloseDelegateJobs: Gateway['_persistAndCloseDelegateJobs']
  _promptQueueCoordinator: Gateway['_promptQueueCoordinator']
  _reapCrashedSessionPendingPermissions: Gateway['_reapCrashedSessionPendingPermissions']
  _recoverTurnDispatchInbox: Gateway['_recoverTurnDispatchInbox']
  _retryDelegateNotifies: Gateway['_retryDelegateNotifies']
  _runLog: Gateway['_runLog']
  _runTaskboardDelegate: Gateway['_runTaskboardDelegate']
  _runTurnDispatchRecoverySweep: Gateway['_runTurnDispatchRecoverySweep']
  _shutdownPromise: Gateway['_shutdownPromise']
  _shuttingDown: Gateway['_shuttingDown']
  _skillShadowReporter: Gateway['_skillShadowReporter']
  _startTurnDispatchRecoveryLoop: Gateway['_startTurnDispatchRecoveryLoop']
  _stopEviction: Gateway['_stopEviction']
  _stopV3RetryDrainer: Gateway['_stopV3RetryDrainer']
  _sweepStalePendingPermissions: Gateway['_sweepStalePendingPermissions']
  _taskSchedulerTimer: Gateway['_taskSchedulerTimer']
  _taskStore: Gateway['_taskStore']
  _taskboardPatrol: Gateway['_taskboardPatrol']
  _taskboardTickTimer: Gateway['_taskboardTickTimer']
  _tickScheduledTasks: Gateway['_tickScheduledTasks']
  _toolFailureReporter: Gateway['_toolFailureReporter']
  _triggerTask: Gateway['_triggerTask']
  _turnDispatchQueue: Gateway['_turnDispatchQueue']
  _turnDispatchRecoveryInFlight: Gateway['_turnDispatchRecoveryInFlight']
  _turnDispatchRecoveryTimer: Gateway['_turnDispatchRecoveryTimer']
  _wsKeepaliveTimer: Gateway['_wsKeepaliveTimer']
  bootAutoResume: Gateway['bootAutoResume']
  channels: Gateway['channels']
  clientsByPeer: Gateway['clientsByPeer']
  cron: Gateway['cron']
  cronProjectPorts: Gateway['cronProjectPorts']
  deliver: Gateway['deliver']
  deps: Gateway['deps']
  dispatchInbound: Gateway['dispatchInbound']
  handleHttp: Gateway['handleHttp']
  handleWsConnection: Gateway['handleWsConnection']
  httpServer: Gateway['httpServer']
  injectCronOriginFromTerminal: Gateway['injectCronOriginFromTerminal']
  injectCronOriginSession: Gateway['injectCronOriginSession']
  injectSendToAgentCallback: Gateway['injectSendToAgentCallback']
  lastActiveChannel: Gateway['lastActiveChannel']
  log: Gateway['log']
  rateLimiter: Gateway['rateLimiter']
  refreshClaudeOAuthIfNeeded: Gateway['refreshClaudeOAuthIfNeeded']
  sessions: Gateway['sessions']
  shutdown: Gateway['shutdown']
  webhookRouter: Gateway['webhookRouter']
  wss: Gateway['wss']
}

const logTimingStops = new WeakMap<object, () => void>()

export async function start(this: GatewayLifecycleHost): Promise<void> {
  const { config } = this.deps

  // Phase 0.2: replay any server-authored messages queued to the outbox
  // while the previous gateway instance was unable to reach SQLite (disk
  // full, crash mid-write, etc.). Runs before the WS endpoint opens so
  // catch-up writes precede live traffic. Failures here must not block
  // startup — we'd rather serve with a retryable queue than refuse boot.
  try {
    const { replayMsgOutbox } = await import('@openclaude/storage')
    const summary = await replayMsgOutbox()
    if (summary.processed > 0) {
      this.log.info('msg-outbox replay', summary)
    }
  } catch (err) {
    this.log.error('msg-outbox replay failed (continuing startup)', undefined, err as Error)
  }

  try {
    if (isDelegateSmEnabled()) {
      const store = this._ensureDelegateJobStore()
      if (!isDelegateDurableEffective()) {
        await restoreDelegateJobSnapshots(store)
      }
    }
    const summary = await recoverInterruptedSendToAgentIntents(
      (intent) => this._deliverInterruptedSendToAgentIntent(intent),
      process.env,
      {
        callbackOwner: resolveDelegateCallbackOwner(),
        resolveJob: (jobId) => this._delegateJobs?.snapshotOf(jobId),
        ensureCallback: (job, intent) => this._ensureDurableSendToAgentCallback(job, intent),
      },
    )
    if (summary.recovered > 0 || summary.retained > 0 || summary.malformed > 0) {
      this.log.info('send_to_agent intent recovery', summary)
    }
  } catch (err) {
    this.log.error(
      'send_to_agent intent recovery failed (continuing startup)',
      undefined,
      err as Error,
    )
  }

  // V3 commercial: container → master sink for server-authored messages.
  // Wire only if env is configured (set by v3supervisor when spawning
  // commercial containers). Personal version + dev sandbox don't set
  // these envs and the sink stays null — sessionManager falls back to
  // the legacy local-SQLite durable path. This block is no-op for
  // non-commercial deployments.
  //
  // Order matters:
  //   1. read config (env-driven; null → skip).
  //   2. create retry queue WITHOUT a sink reference (queue calls a
  //      function we'll close over).
  //   3. create sink with queue injected.
  //   4. wire the queue's attemptSend to call sink.attemptOnce.
  //   5. set the global getter so sessionManager picks it up before
  //      any turn-end callback fires.
  //   6. kick a drain pass + start periodic timer so any entries
  //      from a prior gateway crash get retried.
  try {
    const { makeV3MasterSink, readV3MasterSinkConfig, setV3MasterSinkSingleton } = await import(
      './v3MasterSink.js'
    )
    const { makeV3MasterRetryQueue } = await import('./v3MasterRetryQueue.js')
    const sinkCfg = readV3MasterSinkConfig()
    if (sinkCfg) {
      // Two-phase wire to break the cycle: queue.attemptSend wants the
      // sink's single-attempt path, sink.persistOrQueue wants the queue
      // for fallback. Box `sinkRef` so the queue can call it via late-
      // binding when sink is constructed below.
      let sinkAttemptOnce:
        | ((p: import('./v3MasterSink.js').V3MasterSinkWirePayload) => Promise<void>)
        | null = null
      const queue = makeV3MasterRetryQueue({
        attemptSend: async (p) => {
          if (!sinkAttemptOnce) {
            throw new Error('v3MasterRetryQueue: drainer fired before sink wired (impossible)')
          }
          return sinkAttemptOnce(p)
        },
        // RFC-v5-durable-turn-dispatch §3/§B6 + M-R1-1 ①(R3)— 延迟送达 ACK 驱动 inbox terminal。
        // 返回终态是否确认:resolveInboxTerminalAck 内 CAS 成功 / 已幂等终态(同 outcome)→ true,drainer
        // 删文件;CAS 落空且行非目标终态(缺失 / 仍非终态 / 异 outcome)→ false,**保留文件**退避重试,
        // 绝不"文件已删、行永停 sink_staged"。写失败(抛)→ false(同样保留)。
        onDispatchAck: async (dispatchId, attemptNo, status): Promise<boolean> => {
          try {
            const ok = await resolveInboxTerminalAck(dispatchId, attemptNo, status)
            if (!ok) {
              this.log.warn(
                'inbox terminal (deferred ack) CAS did not apply and row not target-terminal; retaining entry',
                { dispatchId, attemptNo, status },
              )
            }
            return ok
          } catch (err) {
            this.log.error(
              'inbox terminal (deferred ack) write failed; retaining entry for retry',
              { dispatchId },
              err as Error,
            )
            return false
          }
        },
      })
      const sink = makeV3MasterSink({
        config: sinkCfg,
        retryQueue: queue,
        // RFC-v5-durable-turn-dispatch §3/§B6 — sink 生命周期钩子驱动 inbox 状态机。
        // **await durable 迁移(去 best-effort)**:钩子返回 = 状态迁移已尝试落库并确认;
        // 迁移失败一律 error log + 依赖周期 recovery 兜底,绝不静默停在旧态。
        inboxHooks: {
          onStaged: async (dispatchId, attemptNo) => {
            try {
              await inboxSinkStagedByDispatch(dispatchId, attemptNo)
            } catch (err) {
              // running→sink_staged 写失败:tape 已 fsync 进 retry queue,boot ①路径
              // (retryQueueHasDispatch→sink_staged)会收敛。仅 error log。
              this.log.error('inbox sink_staged write failed', { dispatchId }, err as Error)
            }
          },
          // M-R1-1 ①(R3)— 同步 ACK 后**先**确认 terminal CAS 再删 entry。返回终态是否确认:
          // resolveInboxTerminalAck 成功 / 已幂等终态 → true(persistOrQueue 随后 ackDurable 删 entry);
          // CAS 落空且行非目标终态 / 写失败 → false(保留 entry + kick drainer 重试,幂等)。
          onAck: async (dispatchId, attemptNo, status): Promise<boolean> => {
            try {
              const ok = await resolveInboxTerminalAck(dispatchId, attemptNo, status)
              if (!ok) {
                this.log.warn(
                  'inbox terminal (sync ack) CAS did not apply and row not target-terminal; retaining entry',
                  { dispatchId, attemptNo, status },
                )
              }
              return ok
            } catch (err) {
              this.log.error(
                'inbox terminal (sync ack) write failed; retaining entry for retry',
                { dispatchId },
                err as Error,
              )
              return false
            }
          },
          onStageFailed: async (dispatchId, attemptNo) => {
            this.log.error('turn dispatch tape stage failed', { dispatchId, attemptNo })
            // B6:stageDurable 失败 → 行仍 running(从未 stage)。sink_stage_failed 写入
            // **必须同步确认**;写入也失败 → error log,行留 running 由周期 recovery
            // (running→recovery 协议)兜底重试,不许静默停在 running。
            try {
              const row = await inboxSinkStageFailedByDispatch(dispatchId, attemptNo)
              if (!row) {
                this.log.error(
                  'inbox sink_stage_failed CAS did not apply; leaving to periodic recovery',
                  { dispatchId, attemptNo },
                )
              }
            } catch (err) {
              this.log.error('inbox sink_stage_failed write failed', { dispatchId }, err as Error)
            }
          },
        },
      })
      sinkAttemptOnce = (p) => sink.attemptOnce(p)
      setV3MasterSinkSingleton(sink)
      // Boot drain — best-effort, never blocks listen().
      queue.kick()
      queue.startPeriodic()
      this._stopV3RetryDrainer = () => queue.stopPeriodic()
      this._kickV3RetryDrainer = () => queue.kick()
      // RFC-v5-durable-turn-dispatch §3/§B4/§B5 — durable inbox boot recovery。**在开放新
      // ingress 前单飞跑完**:queued→rejected;running→三态收敛。阻塞于 sink 就绪之后
      // (需 retry queue 查同 dispatch + 合成 tape 走同一 queue)。
      this._turnDispatchQueue = queue
      // _runTurnDispatchRecoverySweep 成功一轮 → 自置 _durableTurnDispatchReady(B5);
      // 首跑失败仅 log(不置 ready → capability 不申报 → legacy),周期 recovery 会自愈。
      try {
        await this._runTurnDispatchRecoverySweep(queue)
      } catch (err) {
        this.log.error('turn dispatch boot recovery failed', undefined, err as Error)
      }
      // B4:启动首跑之后挂周期 single-flight 重试(收敛 recovery_pending / 不可达行)。
      this._startTurnDispatchRecoveryLoop(queue)
      this.log.info('v3 master sink wired', {
        baseUrl: sinkCfg.baseUrl,
        durableTurnDispatchReady: this._durableTurnDispatchReady,
      })
    }
  } catch (err) {
    // Non-fatal — fall back to legacy local durable path. Ops will see
    // turn texts going to local SQLite (which is permanently empty in
    // v3 commercial) so the symptom is "client_sessions empty" — same
    // as pre-fix; loud enough to detect via dashboards.
    this.log.error(
      'v3 master sink wire failed (falling back to legacy path)',
      undefined,
      err as Error,
    )
  }

  // Plan B (2026-05-09): clean up orphan `.tmp-*` files left in uploadsDir
  // by handleUpload runs that crashed mid-stream (or were aborted by the
  // client and the cleanup unlink raced past us). One-shot at startup —
  // intentionally no periodic sweep; abort/error paths in handleUpload
  // already unlink eagerly. Codex Plan B v2 review confirmed.
  //
  // V3 multi-tenant extension (2026-05-12): handleUpload writes land in
  // per-user docker volume host paths, not the global paths.uploadsDir.
  // We sweep both:
  //   1. paths.uploadsDir (personal-version / legacy 'default' uploads)
  //   2. /var/lib/docker/volumes/oc-v3-data-u<uid>/_data/uploads/* (commercial)
  // Each block is wrapped in its own try/catch so a docker host without
  // `/var/lib/docker/volumes` (e.g. dev box) doesn't fail the legacy sweep.
  const cutoff = Date.now() - 60 * 60 * 1000 // 1h
  const sweepTmpInDir = (dir: string): number => {
    let cleaned = 0
    try {
      const baseReal = realpathSync(dir)
      for (const fname of readdirSync(baseReal)) {
        if (!fname.startsWith('.tmp-')) continue
        try {
          const st = statSync(join(baseReal, fname))
          if (st.mtimeMs < cutoff) {
            unlinkSync(join(baseReal, fname))
            cleaned++
          }
        } catch {}
      }
    } catch {
      // Directory missing or unreadable — caller decides whether to log.
      return -1
    }
    return cleaned
  }
  try {
    mkdirSync(paths.uploadsDir, { recursive: true })
    const cleaned = sweepTmpInDir(paths.uploadsDir)
    if (cleaned > 0) this.log.info('upload .tmp orphan cleanup', { cleaned, dir: 'legacy' })
  } catch (err) {
    this.log.warn('upload .tmp orphan cleanup (legacy) failed', undefined, err)
  }
  if (this.deps.commercial?.isUserVolumeMediaPath) {
    // Multi-tenant mode — iterate /var/lib/docker/volumes/oc-v3-data-u*.
    // No DB lookup needed; we accept stale uid dirs (e.g. volume deleted)
    // because readdirSync skips them naturally.
    // We only sweep uploads/, NOT generated/: gateway 自身上传走 .tmp-
    // 协议(rename-after-fsync),codex image_gen 用 writeFile 直接落盘,
    // 不会留 .tmp- 残留,所以 generated/ 没有 orphan 需要清。
    // TODO: 若 generated/ 写入将来切到 .tmp-* publish 语义(例如 codex
    // image_gen 改成 rename-after-fsync),把 generated/ 也加进 sweep 列表。
    try {
      const volsRoot = '/var/lib/docker/volumes'
      let totalCleaned = 0
      let dirsSwept = 0
      for (const entry of readdirSync(volsRoot)) {
        if (!/^oc-(v3|v5)-data-u[1-9][0-9]{0,18}$/.test(entry)) continue
        const userUploads = join(volsRoot, entry, '_data', 'uploads')
        const r = sweepTmpInDir(userUploads)
        if (r >= 0) {
          dirsSwept++
          totalCleaned += r
        }
      }
      if (totalCleaned > 0 || dirsSwept > 0) {
        this.log.info('upload .tmp orphan cleanup', {
          cleaned: totalCleaned,
          dirsSwept,
          dir: 'per-user',
        })
      }
    } catch (err) {
      // /var/lib/docker/volumes typically requires root (gateway runs as
      // root in v3 commercial); ENOENT just means docker isn't installed
      // (CI / dev). Log warn but don't fail startup.
      this.log.warn('upload .tmp orphan cleanup (per-user) failed', undefined, err)
    }
  }
  try {
    startUploadRetention({
      info: (msg, ctx) => {
        this.log.info(msg, ctx as LogContext | undefined)
      },
      warn: (msg, ctx, err) => {
        this.log.warn(msg, ctx as LogContext | undefined, err)
      },
    })
  } catch (err) {
    this.log.warn('upload retention arm failed', undefined, err)
  }

  this.httpServer = createServer((req, res) => this.handleHttp(req, res))
  // V3 2H: 改用 noServer + 手动 upgrade dispatch,以便商业化模块的 /ws/user-chat-bridge
  // 与 /ws/agent 路径在 gateway 自身的 /ws 之前优先匹配。原 `path: '/ws'` 模式下
  // ws lib 会对所有非 /ws 请求 socket.destroy(),把商业化路径吃掉。
  // 商用 v3:容器内 gateway 作为 server 接收 bridge client 转发的 user 帧。
  // 用户允许单附件 200 MiB / 总 300 MiB,base64 后 ≈ 400 MiB + envelope → 448 MiB。
  // ws 默认 maxPayload=100 MiB 会让 Receiver 对大附件帧直接 RangeError 关连接。
  this.wss = new WebSocketServer({ noServer: true, maxPayload: 448 * 1024 * 1024 })
  this.httpServer.on('upgrade', (req, socket, head) => {
    // 1) 商业化模块优先(/ws/user-chat-bridge / /ws/agent / 未来私有路径)
    try {
      if (this.deps.commercial?.handleWsUpgrade(req, socket, head)) return
    } catch (err) {
      this.log.error('commercial.handleWsUpgrade threw', undefined, err)
      try {
        socket.destroy()
      } catch {}
      return
    }
    // 2) V5 container-only Chromium preview. The handler itself requires a
    // signed master assertion + exact trusted bridge IP before accepting.
    try {
      if (this._containerPreview.handleUpgrade(req, socket, head)) return
    } catch (err) {
      this.log.error('containerPreview.handleUpgrade threw', undefined, err)
      try {
        socket.destroy()
      } catch {}
      return
    }
    // 3) gateway 自身 /ws(浏览器 ↔ gateway 的 ChannelAdapter 协议)
    const url = req.url ?? '/'
    // 只接受 exact `/ws` 或 `/ws?…` 路径,剩余的 4xx + close
    const path = (() => {
      try {
        return new URL(url, 'http://x').pathname
      } catch {
        return url
      }
    })()
    if (path === '/ws') {
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req))
      return
    }
    // 4) 不认识的 ws path:401 + close(对齐 ws lib 默认对未匹配路径的处理)
    try {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
    } catch {}
  })

  // WS keepalive: ping every 25s, terminate if no pong in 35s
  this._wsKeepaliveTimer = setInterval(() => {
    for (const ws of this.wss.clients) {
      if ((ws as any)._isAlive === false) {
        ws.terminate()
        continue
      }
      ;(ws as any)._isAlive = false
      ws.ping()
    }
  }, 25_000)

  this.wss.on('connection', (ws, req) => this.handleWsConnection(ws, req))

  // 启动渠道
  for (const factory of this.deps.channelFactories ?? []) {
    const adapter = factory({ config })
    const ctx: ChannelContext = {
      dispatch: (frame) => this.dispatchInbound(frame, adapter),
      log: {
        // Channel name last so adapter-supplied meta.channel can't spoof it.
        info: (m, meta) => this.log.info(m, { ...(meta ?? {}), channel: adapter.name }),
        error: (m, meta) => this.log.error(m, { ...(meta ?? {}), channel: adapter.name }),
      },
      config: (config.channels as any)[adapter.name] ?? {},
      // Reset session keyed by (channel, peer). Used by channel /new handlers.
      // Destroys every session the router could route this (channel, peer) to.
      resetSession: async (channel, peerId, peerKind) => {
        const safePeer = peerId.replace(/[^a-zA-Z0-9_-]/g, '_')
        // biome-ignore lint/style/noUnusedTemplateLiteral: moved verbatim from server.ts (OCV5-493); behaviour-neutral split keeps the original literal
        const prefix = `agent:`
        const suffix = `:${channel}:${peerKind}:${safePeer}`
        const keys: string[] = []
        for (const s of this.sessions.list()) {
          if (s.sessionKey.startsWith(prefix) && s.sessionKey.endsWith(suffix)) {
            keys.push(s.sessionKey)
          }
        }
        for (const k of keys) {
          try {
            await this.sessions.destroySession(k)
          } catch {}
          this._outboundRing.clear(k)
        }
        // Refresh size_bytes gauge — without this, a Prometheus scrape
        // after a wipe still reports the pre-clear bytes until the next
        // store/peek path runs.
        outboundRingSizeBytes.value = this._outboundRing.totalBytes()
      },
    }
    try {
      await adapter.init(ctx)
      this.channels.set(adapter.name, adapter)
      this.log.info('channel ready', { channel: adapter.name })
    } catch (err) {
      this.log.error('channel failed to init', { channel: adapter.name }, err)
    }
  }

  this._stopEviction = this.sessions.startEvictionLoop()
  process.once('SIGINT', () => {
    this.shutdown().catch((err) => this.log.error('shutdown error (SIGINT)', undefined, err))
  })
  process.once('SIGTERM', () => {
    this.shutdown().catch((err) => this.log.error('shutdown error (SIGTERM)', undefined, err))
  })

  // Start cron scheduler for reflection jobs (L3)
  // Smart delivery: push to last active channel, fallback to all webchat clients
  const wechatProactiveCfg = readV3WechatProactiveConfig()
  const qqProactiveCfg = readV3QqProactiveConfig()
  this.cron = new CronScheduler(
    config,
    this.sessions,
    async (text, job, delivery) => {
      await deliverCronOutput(text, job, delivery, {
        lastActiveChannel: this.lastActiveChannel,
        clientsByPeer: this.clientsByPeer as CronDeliverDeps['clientsByPeer'],
        channels: this.channels as CronDeliverDeps['channels'],
        deliver: (msg) => this.deliver(msg as OutboundMessage),
        makePeerKey: (userId, channel, peerId) => makePeerKey(userId, channel, peerId),
        qqProactiveCfg,
        wechatProactiveCfg,
        sendQqProactive: sendV3QqProactive,
        sendWechatProactive: sendV3WechatProactive,
        postInboxDurable: postInboxMessageDurable,
      })
    },
    (job, delivery) => this.injectCronOriginSession(job, delivery),
  )
  this.cron.setProjectPorts(this.cronProjectPorts())
  this.cron.lastActiveChannel = this.lastActiveChannel
  this.cron.getRegisteredDeliverChannels = () => this.channels.keys()
  this.cron.start().catch((err) => this.log.error('cron start failed', undefined, err))
  if (isDelegateSmEnabled()) {
    this.cron.delegateJobs = this._ensureDelegateJobStore()
  }

  // Start event persistence (writes all events to SQLite event_log)
  startEventPersistence()

  // Exact memory usage + current-fact freshness shadow. Fail-open observers
  // never alter turn execution or user-visible memory results.
  startMemoryTurnObserver()
  startMemoryUsageReporter()

  // Start metrics collection (eventBus → prometheus counters)
  startMetricsCollection()

  // Commercial container telemetry: privacy-safe call rollups + failure rows.
  this._toolFailureReporter = startToolFailureReporter()

  // Commercial container product signal: hub skill_view → master marketplace usage.
  // 默认开(OC_MARKET_SKILL_USAGE!='0');resolveTraceId 从活跃 session 读本 turn 的
  // canonical traceId 作评分归因键(engine 中立、只透传不铸造)。
  startSkillUsageReporter({
    resolveTraceId: (sessionKey) => this.sessions.getByKey(sessionKey)?._currentTurnTraceId ?? null,
  })

  // Retrieval quality shadow: strict opt-in via OC_SKILL_SHADOW_SAMPLE_RATE.
  // The observer never mutates prompt/tool state and never blocks dispatchInbound;
  // it only reads the same agent-visible metadata used by the SKILLS slot.
  this._skillShadowReporter = startSkillShadowReporter({
    resolveTraceId: (sessionKey) => this.sessions.getByKey(sessionKey)?._currentTurnTraceId ?? null,
  })

  // Start rate limiter cleanup
  this.rateLimiter.startCleanup()

  // EventBus: bridge CCB CronCreate/CronDelete to gateway CronScheduler
  eventBus.on('task.created', (ev) => {
    if (!this.cron || ev.source !== 'cron-bridge') return
    if (isHiddenSystemAgentId(ev.agentId)) {
      this.log.warn('eventBus task.created hidden system agent rejected', {
        taskId: ev.taskId,
        agentId: ev.agentId,
      })
      return
    }
    // Use taskId directly — sessionManager already generates unique ccb-xxx IDs
    this.cron
      .addJob({
        id: ev.taskId,
        schedule: ev.schedule || '* * * * *',
        agent: ev.agentId,
        prompt: ev.prompt,
        deliver: 'webchat',
        enabled: true,
        oneshot: ev.oneshot ?? true,
        label: ev.prompt.slice(0, 50),
        // Same creation stamp as the /api/cron path — every user-facing cron
        // entry point must set createdAt so catch-up can't backfire pre-creation.
        createdAt: Date.now(),
      })
      .then(() => this.log.info('eventBus task.created → gateway job', { taskId: ev.taskId }))
      .catch((err) => this.log.warn('eventBus task.created failed', { taskId: ev.taskId }, err))
  })
  eventBus.on('task.deleted', (ev) => {
    if (!this.cron) return
    this.cron
      .removeJob(ev.taskId)
      .then((ok) =>
        this.log.info('eventBus task.deleted', {
          taskId: ev.taskId,
          result: ok ? 'removed' : 'not found',
        }),
      )
      .catch((err) => this.log.warn('eventBus task.deleted failed', { taskId: ev.taskId }, err))
  })

  // Start webhook router
  this.webhookRouter = new WebhookRouter()
  await this.webhookRouter.load()
  this.log.info('webhooks loaded', { count: this.webhookRouter.list().length })

  // EventBus: route webhook.received → agent execution + delivery
  eventBus.on('webhook.received', (ev) => {
    const { webhookId, agentId, payload } = ev
    if (isHiddenSystemAgentId(agentId)) {
      this.log.warn('webhook hidden system agent rejected', { agentId, webhookId })
      return
    }
    const { resolvedPrompt } = payload as any
    ;(async () => {
      const cfg = await this._getAgentsConfig()
      const agent = cfg.agents.find((a) => a.id === agentId)
      if (!agent) {
        this.log.warn('webhook agent not found', { agentId, webhookId })
        return
      }
      const sessionKey = `agent:${agentId}:webhook:${webhookId}:${Date.now()}`
      // 合成首帧路由字段补齐(同 cron):webhook 触发的会话首帧绕过 master bridge
      // 计费编排,落 codex 会被 CODEX_BILLING_GUARD 拒 → 解析为非 codex 执行模型。
      const _whRoute = resolveSyntheticTurnModel(agent, this.deps.config.defaults.model)
      // 模型权威 §3(无 envelope 的本地路径):flag 开 → 判定源换成 master catalog 投影
      // (归一 / 可用性 / engine 全取投影;拉不到 → 抛 → 本次 webhook 执行失败并记日志,
      // 不回落 baked)。flag 未开 → undefined,沿用上面的 baked 合成降级,零变化。
      const _whExec = await resolveLocalExecutionIfEnforced({
        catalog: this.sessions.runtime?.catalog,
        agent,
        kind: 'synthetic',
        model: _whRoute?.model,
        defaultModel: this.deps.config.defaults.model,
      })
      const _whModel = _whExec?.canonicalModel ?? _whRoute?.model
      const session = await this.sessions.getOrCreate({
        sessionKey,
        agent,
        ...(_whModel ? { model: _whModel } : {}),
        ...localExecutionOverride(_whExec),
        channel: 'webhook',
        peerId: webhookId,
        title: `[webhook] ${webhookId}`,
      })
      // MAJOR-2 透明化:降级不静默 —— effective_model 落 runLog(doctor 面可见)。
      const _whRun = this._runLog.start({
        agentId,
        sessionKey,
        taskType: 'webhook',
        ...(_whRoute ? { effectiveModel: _whRoute.model } : {}),
      })
      let output = ''
      let _whError = ''
      try {
        await this.sessions.submit(
          session,
          resolvedPrompt,
          (e) => {
            if (e.kind === 'block' && e.block.kind === 'text') output += (e.block as any).text
            if (e.kind === 'error') _whError = e.error
          },
          undefined,
          _whModel,
        )
        this._runLog.complete(_whRun, {
          status: _whError ? 'failed' : 'completed',
          error: _whError || undefined,
        })
      } catch (err: any) {
        _whError = _whError || String(err)
        this._runLog.complete(_whRun, { status: 'failed', error: _whError })
      }
      // Deliver to last active webchat
      if (output.trim()) {
        const lastActive = this.lastActiveChannel.get(agentId) || this.lastActiveChannel.get('main')
        if (lastActive) {
          // Route through deliver() so the server-assigned ts gets stamped —
          // otherwise the web client's stale-final guard has nothing to compare
          // against and every webhook-delivered isFinal bypasses the guard.
          this.deliver({
            type: 'outbound.message' as const,
            sessionKey: lastActive.sessionKey,
            channel: 'webchat' as const,
            peer: { id: lastActive.peerId, kind: 'dm' as const },
            blocks: [
              { kind: 'text' as const, text: `🔔 **Webhook ${webhookId}**\n\n${output.trim()}` },
            ],
            isFinal: true,
            _userId: lastActive.userId,
          } as OutboundMessage)
        }
      }
    })().catch((err) => this.log.error('webhook execution failed', { webhookId, agentId }, err))
  })

  // TaskStore: schedule-triggered tasks run alongside cron (check every 60s)
  this._taskSchedulerTimer = setInterval(() => {
    this._tickScheduledTasks().catch((err) =>
      this.log.error('task-scheduler tick failed', undefined, err),
    )
  }, 60_000)

  // 商业版容器由 master 注入 OC_TASKBOARD_ENABLED=0(taskboardEnv.ts):不起巡检、不发简报。
  // 只关后台自动化,/api/board/* 仍在(project-context / MCP 复用)。
  if (isTaskboardEnabled()) {
    // Taskboard 统一巡检 tick:一个 60s 定时器扫全部 stage,不按 stage 建 cron job。
    // 通知复用 onDeliver 瀑布(微信接管则不再推站内信);熔断 warning 走 createInboxMessage。
    const taskboardNotify = new TaskboardNotifier({
      getDb: () => getTaskboardDb(),
      log: (msg, extra) => this.log.warn(msg, extra),
      transport: {
        sendWechat: async ({ text, outboundId }) => {
          const cfg = readV3WechatProactiveConfig()
          if (!cfg) return { kind: 'fallback' as const, marked: false }
          return sendV3WechatProactive({ config: cfg, text, outboundId })
        },
        postInbox: async ({ title, bodyMd, deliveryKey }) => {
          try {
            return await postInboxMessageDurable({ title, bodyMd, deliveryKey })
          } catch (err) {
            this.log.warn('taskboard inbox durable failed', {
              deliveryKey,
              err: String(err),
            })
            return false
          }
        },
        createInboxMessage: async (args) => {
          try {
            return await postInboxAlertDurable(args)
          } catch (err) {
            this.log.warn('taskboard inbox-alert durable failed', {
              deliveryKey: args.deliveryKey,
              err: String(err),
            })
            return false
          }
        },
      },
    })
    this._taskboardPatrol = new PatrolEngine({
      preflightStages: (stages) => createTaskboardPreflight({ getAgentsConfig: () => this._getAgentsConfig(), defaultModel: this.deps.config.defaults.model, catalog: this.sessions.runtime.catalog })(stages),
      getDb: () => getTaskboardDb(),
      delegate: (input) => this._runTaskboardDelegate(input),
      log: (msg, extra) => this.log.info(msg, extra),
      notify: taskboardNotify,
      onAlert: (alert) => {
        this.log.warn('taskboard guardrail', {
          kind: alert.kind,
          outboundId: alert.outboundId,
          message: alert.message,
          stageId: alert.stageId,
          ticketId: alert.ticketId,
        })
        void taskboardNotify.onGuardrailAlert(alert)
      },
    })
    setPatrolExecutionHandler((job) => {
      void this._taskboardPatrol
        ?.executeJob(job)
        .catch((err) => this.log.error('taskboard patrol job failed', undefined, err))
    })
    this._taskboardTickTimer = setInterval(() => {
      this._taskboardPatrol
        ?.tick()
        .catch((err) => this.log.error('taskboard tick failed', undefined, err))
    }, 60_000)
    this._taskboardTickTimer.unref()
  } else {
    this.log.info('taskboard automation disabled (OC_TASKBOARD_ENABLED=0)')
  }

  // Invalidate task cache when tasks are created or deleted
  eventBus.on('task.created', () => this._invalidateTaskCache())
  eventBus.on('task.deleted', () => this._invalidateTaskCache())

  // EventBus: webhook.received can also trigger webhook-type tasks
  eventBus.on('webhook.received', (ev) => {
    this._getCachedTasks()
      .then((tasks) => {
        for (const t of tasks) {
          if (t.trigger === 'webhook' && t.webhookId === ev.webhookId && t.status !== 'disabled') {
            this._triggerTask(t.id).catch(() => {})
          }
        }
      })
      .catch(() => {})
  })

  // EventBus: catch-all listener for event-triggered tasks (uses cached task list)
  eventBus.on('*', (ev) => {
    this._getCachedTasks()
      .then((tasks) => {
        for (const t of tasks) {
          if (t.trigger === 'event' && t.eventType === ev.type && t.status !== 'disabled') {
            this._triggerTask(t.id).catch(() => {})
          }
        }
      })
      .catch(() => {})
  })

  // Handle subprocess crashes: push a system message to the client so they know
  // the session will auto-recover on the next message they send
  eventBus.on('session.crashed', (ev) => {
    // Route through deliver() so the ts-stamp path is the single source of truth
    // for stale-final ordering. Preserves original semantics (no-op if no
    // clients are connected — deliver() bails early on empty peer set).
    // Cast keeps the legacy `agentId` field the crash notification has always
    // carried; OutboundMessage schema doesn't define it but the client reads
    // it, and the wire format tolerates extra keys.
    this.deliver({
      type: 'outbound.message',
      sessionKey: ev.sessionKey,
      channel: 'webchat',
      peer: { id: ev.peerId, kind: 'dm' },
      agentId: ev.agentId,
      blocks: [
        {
          kind: 'text',
          text: '⚠️ AI 进程异常退出，下一条消息将自动恢复上下文。',
        },
      ],
      isFinal: true,
    } as OutboundMessage)
    this.log.info('pushed crash notification', { peerId: ev.peerId })

    // Ordinary pending permissions die with the subprocess. Detached
    // ask_user cards do not — see `_reapCrashedSessionPendingPermissions`.
    this._reapCrashedSessionPendingPermissions(ev.sessionKey)
  })

  // Periodic OAuth token refresh (every 10 min). Running subprocesses keep
  // the old token until restarted; 401 detection in sessionManager handles
  // the restart + retry when the old token expires mid-conversation.
  this._oauthRefreshTimer = setInterval(
    () => this.refreshClaudeOAuthIfNeeded().catch(() => {}),
    10 * 60_000,
  )
  // Periodic pending-permission janitor: TTL-based auto-deny + orphan cleanup.
  this._pendingPermissionSweepTimer = setInterval(() => {
    try {
      this._sweepStalePendingPermissions()
    } catch (err) {
      this.log.warn('pending permission sweep failed', undefined, err)
    }
  }, PENDING_PERMISSION_SWEEP_MS)
  // Check immediately on boot
  this.refreshClaudeOAuthIfNeeded().catch(() => {})

  // Converge orphan live streams BEFORE listen: clients that connect the
  // instant the port opens would otherwise page the stale live snapshot and
  // replay frames whose authoritative tape already finalized. One idempotent
  // UPDATE; failure is logged and must not block startup.
  try {
    const { convergeFinalizedTapeLiveStreams } = await import('@openclaude/storage')
    const { converged } = await convergeFinalizedTapeLiveStreams()
    if (converged > 0) {
      this.log.info('converged finalized live streams to tape', { converged })
    }
  } catch (err) {
    this.log.warn('live stream convergence failed', undefined, err)
  }

  const listenOpts = resolveGatewayListen(config.gateway.bind, config.gateway.port)
  await new Promise<void>((res) => {
    if (listenOpts.exclusive) {
      this.httpServer.listen(
        { port: listenOpts.port, host: listenOpts.host, exclusive: true },
        () => res(),
      )
    } else {
      this.httpServer.listen(listenOpts.port, listenOpts.host, () => res())
    }
  })
  if (!logTimingStops.has(this)) logTimingStops.set(this, startLogTimingReporter(this.log))
  this.log.info('server started', { bind: listenOpts.host, port: listenOpts.port })
  if (process.env.OPENCLAUDE_TRUST_BRIDGE_IP) {
    this.log.info('container_boot_timing', { stage: 'gateway_listening', processUptimeMs: process.uptime() * 1000 })
  }

  // Auto-resume: proactively continue interrupted webchat sessions after gateway restart
  this.bootAutoResume().catch((err) => this.log.error('auto-resume boot failed', undefined, err))
}

export async function _doShutdown(this: GatewayLifecycleHost, exit: boolean): Promise<void> {
  logTimingStops.get(this)?.()
  logTimingStops.delete(this)
  this.log.info('shutting down')

  // ── Stage 1: stop accepting new traffic ──
  // `httpServer.close()` stops accepting new HTTP connections but lets
  // in-flight requests finish. WS upgrade happens via the HTTP server so
  // new WS connections are also refused. Existing handlers additionally
  // check `_shuttingDown` to short-circuit.
  // We capture the close-completion Promise here and await it in Stage 5
  // so the full close lifecycle is awaited before exit.
  let httpCloseDone: Promise<void> = Promise.resolve()
  if (this.httpServer) {
    httpCloseDone = new Promise<void>((resolveClose) => {
      try {
        this.httpServer.close((err) => {
          if (err) this.log.warn('httpServer.close error', undefined, err)
          resolveClose()
        })
      } catch (err) {
        this.log.warn('httpServer.close threw', undefined, err)
        resolveClose()
      }
    })
  }

  // ── Stage 2: stop all background timers ──
  try {
    this._stopEviction?.()
  } catch {}
  this._stopEviction = null
  try {
    await this._persistAndCloseDelegateJobs()
  } catch (err) {
    this.log.error(
      'delegate job snapshot persist failed; keeping in-memory jobs',
      undefined,
      err as Error,
    )
  }
  this._skillShadowReporter?.stop()
  this._skillShadowReporter = null
  if (this._wsKeepaliveTimer !== null) {
    clearInterval(this._wsKeepaliveTimer)
    this._wsKeepaliveTimer = null
  }
  if (this._taskSchedulerTimer !== null) {
    clearInterval(this._taskSchedulerTimer)
    this._taskSchedulerTimer = null
  }
  try {
    stopUploadRetention()
  } catch {}
  if (this._taskboardTickTimer !== null) {
    clearInterval(this._taskboardTickTimer)
    this._taskboardTickTimer = null
  }
  setPatrolExecutionHandler(null)
  this._taskboardPatrol = null
  if (this._oauthRefreshTimer !== null) {
    clearInterval(this._oauthRefreshTimer)
    this._oauthRefreshTimer = null
  }
  if (this._pendingPermissionSweepTimer !== null) {
    clearInterval(this._pendingPermissionSweepTimer)
    this._pendingPermissionSweepTimer = null
  }
  try {
    this.cron?.stop()
  } catch (err) {
    this.log.warn('cron stop error', undefined, err)
  }
  // v3 master sink retry queue periodic timer ONLY here. The sink
  // singleton itself MUST stay set until after sessions.shutdownAll()
  // drains turn-end / handleExit-flush callbacks (stage 4) — clearing
  // it now would send late partial-flush writes through the legacy
  // local SQLite path that's permanently empty in v3 commercial,
  // recreating the original data-loss bug. Stopping the periodic timer
  // is fine: it's purely additive (drains entries already on disk
  // from prior boot), and `kick()` is idempotent.
  // Codex R2 BLOCK-2.
  try {
    this._stopV3RetryDrainer?.()
  } catch (err) {
    this.log.warn('v3 retry drainer stop error', undefined, err)
  }
  this._stopV3RetryDrainer = null
  // RFC-v5-durable-turn-dispatch §B4 — 停周期 recovery 定时器(纯附加,清干净不留句柄)。
  if (this._turnDispatchRecoveryTimer) {
    clearInterval(this._turnDispatchRecoveryTimer)
    this._turnDispatchRecoveryTimer = null
  }

  // ── Stage 3: drain channel adapters (Telegram etc.) ──
  for (const ch of this.channels.values()) {
    try {
      await ch.shutdown()
    } catch (err) {
      this.log.warn('channel shutdown error', { channel: ch.name }, err)
    }
  }

  // ── Stage 3.5: V3 2H — drain 商业化模块(close redis/pricing/anthropic proxy/ws bridge) ──
  if (this.deps.commercial) {
    try {
      await this.deps.commercial.shutdown()
    } catch (err) {
      this.log.warn('commercial shutdown error', undefined, err)
    }
  }

  // ── Stage 3.75: close isolated preview Chromium/CDP sessions ──
  try {
    await this._containerPreview.shutdown()
  } catch (err) {
    this.log.warn('container preview shutdown error', undefined, err)
  }

  // ── Stage 4: drain sessions (kill CCB subprocesses, flush resume map) ──
  try {
    await this.sessions.shutdownAll()
  } catch (err) {
    this.log.warn('sessions shutdownAll error', undefined, err)
  }
  try {
    await this.sessions.awaitResumeMapFlush()
  } catch (err) {
    this.log.warn('resume map flush error', undefined, err)
  }
  this._promptQueueCoordinator?.shutdown()
  this._promptQueueCoordinator = null

  // ── Stage 4.25: persist the final tool-call rollup ──
  // Keep the reporter subscribed until every runner has stopped so late
  // tool_result events are included. shutdown() atomically queues+fsyncs the
  // final batch; HTTP delivery may resume from disk on the next boot.
  try {
    await this._toolFailureReporter?.shutdown()
  } catch (err) {
    this.log.warn('tool failure reporter shutdown error', undefined, err)
  }
  this._toolFailureReporter = null

  // ── Stage 4.5: clear v3 master sink singleton ──
  // shutdownAll above internally awaits awaitPendingPersistence(), so
  // every turn-end / handleExit-flush has either landed on master via
  // the sink HTTP POST or has been durably enqueued on disk for
  // retry-on-next-boot. Now safe to disable the write path.
  // Codex R2 BLOCK-2 — kept the kill-switch out of stage 2 and put it
  // here after sessions are fully drained.
  try {
    const { setV3MasterSinkSingleton } = await import('./v3MasterSink.js')
    setV3MasterSinkSingleton(null)
    this._kickV3RetryDrainer = null
  } catch (err) {
    this.log.warn('v3 master sink singleton clear error', undefined, err)
  }

  // ── Stage 5: force-close remaining sockets ──
  // WS: terminate remaining clients so `wss.close()` callback fires promptly.
  // HTTP: `closeAllConnections()` destroys active sockets (e.g. SSE streams)
  //       that would otherwise block the Stage 1 `close()` callback.
  if (this.httpServer) {
    try {
      const closeAll = (this.httpServer as any).closeAllConnections
      if (typeof closeAll === 'function') closeAll.call(this.httpServer)
    } catch (err) {
      this.log.warn('closeAllConnections error', undefined, err)
    }
  }
  const wssCloseDone = new Promise<void>((resolveClose) => {
    if (!this.wss) return resolveClose()
    try {
      for (const ws of this.wss.clients) {
        try {
          ws.terminate()
        } catch {}
      }
      this.wss.close((err) => {
        if (err) this.log.warn('wss.close error', undefined, err)
        resolveClose()
      })
    } catch (err) {
      this.log.warn('wss.close threw', undefined, err)
      resolveClose()
    }
  })
  await Promise.allSettled([httpCloseDone, wssCloseDone])
  this.log.info('shutdown complete')
  if (exit) process.exit(0)
}

/**
 * Public, idempotent shutdown. Safe to call from signal handlers, fatal
 * error handlers, or external orchestration. Concurrent calls share the
 * same in-flight shutdown promise.
 *
 * Pass `exit=false` to skip the terminal `process.exit(0)` — the caller
 * is then responsible for exiting (used by emergency exit handlers that
 * want to exit with code 1 after graceful flush).
 */
export function shutdown(this: GatewayLifecycleHost, exit = true): Promise<void> {
  if (this._shutdownPromise) return this._shutdownPromise
  // Set ingress guard FIRST so handlers reject new requests immediately
  this._shuttingDown = true
  this._shutdownPromise = this._doShutdown(exit).catch((err) => {
    try {
      this.log.error('shutdown failed', undefined, err)
    } catch {}
    if (exit) process.exit(1)
  })
  return this._shutdownPromise
}

/** Pre-warm webchat sessions on boot so they respond instantly to the first user message */
export async function bootAutoResume(this: GatewayLifecycleHost): Promise<void> {
  const resumableKeys = this.sessions.getResumableKeys((k) => k.includes(':webchat:'))
  if (resumableKeys.length === 0) return

  for (const sessionKey of resumableKeys) {
    // OCV5-428: yield a macrotask per session. The loop runs right after listen();
    // without this the readiness probe (/healthz + WS upgrade) waited ~29s on a
    // 145-session cold start, holding every queued user message.
    await new Promise<void>((resolve) => setImmediate(resolve))
    if (this.sessions.getByKey(sessionKey)) continue

    const parts = sessionKey.split(':')
    const agentId = parts[1]
    if (isHiddenSystemAgentId(agentId)) {
      this.log.warn('auto-resume skipped hidden system agent session', { sessionKey })
      continue
    }
    const peerId = parts.slice(4).join(':')

    this.log.info('auto-resume pre-warming', { sessionKey })
    const cfg = await this._getAgentsConfig()
    const agent = cfg.agents.find((a) => a.id === agentId) ?? ({ id: agentId } as AgentDef)
    // 模型权威 §3:预热也不许查 baked 表(engine/model 取投影)。但预热**不是 turn**——
    // 不执行、不计费 → 不套 codex 真值表(见 decideLocalExecution 的 'prewarm' 语义)。
    // 投影拉不到 → **跳过本次预热**(best-effort:预热失败不该炸 boot 循环;真正的 turn
    // 到来时会重新判定)。绝不回落 baked spawn。
    try {
      const preExec = await resolveLocalExecutionIfEnforced({
        catalog: this.sessions.runtime?.catalog,
        agent,
        kind: 'prewarm',
        defaultModel: this.deps.config.defaults.model,
      })
      await this.sessions.getOrCreate({
        sessionKey,
        agent,
        ...localExecutionOverride(preExec),
        channel: 'webchat',
        peerId,
      })
    } catch (err) {
      this.log.warn(
        'auto-resume pre-warm skipped',
        { sessionKey, code: localExecutionRejectCode(err) ?? 'unknown' },
        err as Error,
      )
      continue
    }
    this.lastActiveChannel.set(agentId, {
      channel: 'webchat',
      peerId,
      sessionKey,
      userId: 'default',
      at: Date.now(),
    })
    this.log.info('auto-resume pre-warmed', { sessionKey })
  }
}

/**
 * RFC-v5-durable-turn-dispatch §3 — durable inbox boot recovery 编排。
 *
 * 注入三个 dep 到协议实现(recoverTurnDispatchInboxOnBoot):本地 retry queue 查同
 * dispatch、master 三态查询、synthetic crashed tape staging(走同一 retry queue,
 * 确定性 payload 来自 inbox 持久化字段)。
 */
export async function _recoverTurnDispatchInbox(
  this: GatewayLifecycleHost,
  queue: import('./v3MasterRetryQueue.js').V3MasterRetryQueue,
): Promise<void> {
  await recoverTurnDispatchInboxOnBoot({
    retryQueueHasDispatch: (dispatchId, attemptNo) =>
      queue.hasEntryForDispatch(dispatchId, attemptNo),
    queryMasterTapeState: (dispatchId, attemptNo) => queryMasterTapeState(dispatchId, attemptNo),
    // 活执行行一律跳过(§B4 周期 sweep 防误杀在飞 turn);boot 首跑注册表恒空,语义不变。
    isDispatchLive: (dispatchId, attemptNo) => isTurnDispatchLive(dispatchId, attemptNo),
    stageSyntheticCrashedTape: async (row) => {
      const payload = buildSyntheticCrashedTapePayload(row)
      // stageDurable 只需 wire payload;tape 分片在 drain 时由 attemptSend 现算。
      // createdAt 用 inbox 持久化值 → 确定性(多次恢复同 tapeId/hash)。
      await queue.stageDurable({
        schemaVersion: 1,
        payload: { ...payload },
        firstSeenAt: row.createdAt,
        attempts: 0,
      })
      // stage 成功后立即 kick,让 crashed tape 尽快送达 master。
      queue.kick()
    },
    onManualReconcile: (row, reason) => {
      this.log.error('turn dispatch boot recovery: manual reconcile required', {
        dispatchId: row.dispatchId,
        reason,
      })
    },
  })
}

/**
 * RFC-v5-durable-turn-dispatch §B4 — 周期 single-flight recovery 重试。
 *
 * boot 首跑只处理"启动瞬间"的 open 行;不可达(recovery_pending)/瞬时写失败留下的
 * 未终局行需要周期重试才能最终收敛(I1 永不静默)。每 60s 一轮:先看是否存在 open 行
 * (无 → 跳过,不空扫),再走单飞 sweep。timer unref 不挡进程退出;shutdown 里清。
 */
export function _startTurnDispatchRecoveryLoop(
  this: GatewayLifecycleHost,
  queue: import('./v3MasterRetryQueue.js').V3MasterRetryQueue,
): void {
  if (this._turnDispatchRecoveryTimer) return
  // e2e 用 OC_TURN_DISPATCH_SWEEP_MS 压缩 tick 周期复现"sweep 撞在飞 turn"场景;
  // 生产不设 → 60s。clamp 防误配(过小空转,过大失去收敛时效)。
  const envMs = Number(process.env.OC_TURN_DISPATCH_SWEEP_MS)
  const RETRY_MS =
    Number.isFinite(envMs) && envMs > 0 ? Math.min(Math.max(envMs, 1_000), 600_000) : 60_000
  this._turnDispatchRecoveryTimer = setInterval(() => {
    void (async () => {
      try {
        if (this._turnDispatchRecoveryInFlight) return
        const stats = await turnDispatchInboxStats()
        if (stats.openJobs === 0) return
        await this._runTurnDispatchRecoverySweep(queue)
      } catch (err) {
        this.log.error('turn dispatch periodic recovery sweep failed', undefined, err as Error)
      }
    })()
  }, RETRY_MS)
  this._turnDispatchRecoveryTimer.unref?.()
}

/**
 * RFC-v5-durable-turn-dispatch §B4/§B5 — recovery 单飞一轮(boot 首跑 + 周期共用)。
 *
 * single-flight 门闩 `_turnDispatchRecoveryInFlight` 防重入(boot 与周期、周期各轮之间)。
 * 成功跑完一轮 → 置 `_durableTurnDispatchReady`(B5:即便 boot 首跑曾失败,某轮周期成功即自愈)。
 * 检查+置位同步发生(await 前),JS 单线程下并发调用第二个必早退,无竞态。
 */
export async function _runTurnDispatchRecoverySweep(
  this: GatewayLifecycleHost,
  queue: import('./v3MasterRetryQueue.js').V3MasterRetryQueue,
): Promise<void> {
  if (this._turnDispatchRecoveryInFlight) return
  this._turnDispatchRecoveryInFlight = true
  try {
    await this._recoverTurnDispatchInbox(queue)
    this._durableTurnDispatchReady = true
  } finally {
    this._turnDispatchRecoveryInFlight = false
  }
}

export function _ensureEngineNotifier(
  this: GatewayLifecycleHost,
): DefaultEngineNotifier | undefined {
  if (!isDelegateNotifierEffective()) return undefined
  if (this._engineNotifier) return this._engineNotifier
  this._engineNotifier = new DefaultEngineNotifier({
    inlinePush: {
      write: async (event) => {
        const session = this.sessions?.getByKey?.(event.parentSessionKey) as
          | InlinePushSession
          | undefined
        return writeInlinePushForSession(
          session,
          event,
          formatJobTerminalMarkdown(event),
          process.env,
          {
            isCutoverWindowActive: () => this._delegateJobs?.hasActiveCutoverWindow() === true,
          },
        )
      },
    },
    parentTapeIngestState: async (notifyId, event): Promise<ParentTapeIngestState> =>
      resolveParentTapeIngestState({
        notifyId,
        parentSessionKey: event.parentSessionKey,
        clientMessageId: delegateCallbackMessageId(event.jobId, event.callbackEpoch),
        callbackOriginUserId: event.callbackOriginUserId,
        liveSessionUserId: this.sessions?.getByKey?.(event.parentSessionKey)?.userId,
        envUserId: process.env.OC_USER_ID,
        loadSession: (peerId, userId) => getClientSession(peerId, userId),
      }),
    resumeInject: {
      inject: async (event) => {
        const result =
          event.callback === 'cron-origin-inject'
            ? await this.injectCronOriginFromTerminal(event)
            : await this.injectSendToAgentCallback({
                parentSessionKey: event.parentSessionKey,
                jobId: event.jobId,
                agentId: event.agentId || 'unknown',
                goal: event.goal || '',
                ...injectPayloadFromJobTerminal(event),
                userId: event.callbackOriginUserId,
                clientMessageId: delegateCallbackMessageId(event.jobId, event.callbackEpoch),
                once: true,
              })
        if (result.kind === 'injected') return { ok: true }
        if (result.kind === 'retryable_failure' && result.code === 'ORIGIN_SESSION_BUSY') {
          return { ok: false, failureClass: 'internal' as const, busy: true }
        }
        if (result.kind === 'fallback') {
          return { ok: false, failureClass: 'transport' as const, gone: true }
        }
        return { ok: false, failureClass: 'transport' as const }
      },
    },
    onSample: (sample) => {
      delegateNotifyTotal.inc({
        lane: sample.lane,
        ok: sample.ok ? '1' : '0',
        degraded: sample.degraded ? '1' : '0',
      })
      delegateNotifyLatencyMs.observe(sample.latencyMs, { lane: sample.lane })
    },
  })
  return this._engineNotifier
}

export function _armNotifyRetryScheduler(this: GatewayLifecycleHost): void {
  if (this._notifyRetryTimer) {
    clearTimeout(this._notifyRetryTimer)
    this._notifyRetryTimer = undefined
  }
  if (!this._delegateJobs) return
  const notifierOn = isDelegateNotifierEffective()
  const handoffDelay = notifierOn ? undefined : handedOffDelegateRetryDelay(this._delegateJobs)
  const cronDelay = !notifierOn && isDelegateDurableEffective()
    ? delayUntilNextNotifyRetry(this._delegateJobs, Date.now(), {
        callbacks: ['cron-origin-inject'],
        skipLegacyCron: true,
      })
    : undefined
  const delay = notifierOn
    ? delayUntilNextNotifyRetry(this._delegateJobs)
    : [handoffDelay, cronDelay].filter((value): value is number => value !== undefined).sort((a, b) => a - b)[0]
  if (delay == null) return
  this._notifyRetryTimer = setTimeout(() => {
    this._notifyRetryTimer = undefined
    const work = notifierOn
      ? this._retryDelegateNotifies({ dueOnly: true })
      : Promise.all([
          this._drainFlagOffCronOriginNotifies({ dueOnly: true }),
          retryHandedOffDelegateNotifies(this),
        ])
    void work.finally(() => this._armNotifyRetryScheduler())
  }, delay)
  this._notifyRetryTimer.unref()
}

/** Check schedule-triggered tasks and fire if cron matches */
export async function _tickScheduledTasks(this: GatewayLifecycleHost): Promise<void> {
  const tasks = await this._taskStore.list()
  const now = new Date()
  for (const t of tasks) {
    if (t.trigger !== 'schedule' || !t.schedule || t.status === 'disabled') continue
    // Simple minute-level dedup: skip if ran in this minute
    const minuteKey = Math.floor(now.getTime() / 60_000)
    if (t.lastRunAt && Math.floor(t.lastRunAt / 60_000) === minuteKey) continue
    // Import cronMatches from cron.ts is complex — use a simple check
    // Delegate to CronScheduler's cronMatches by re-importing
    try {
      const { cronMatches } = await import('./cron.js')
      if (cronMatches(t.schedule, now)) {
        this._triggerTask(t.id).catch(() => {})
      }
    } catch {}
  }
}
