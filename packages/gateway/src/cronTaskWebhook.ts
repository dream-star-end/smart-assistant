/**
 * Gateway cron / task / webhook handlers and cron-origin session injection
 *
 * Moved verbatim out of Gateway (server.ts) — FINDINGS §7.6, OCV5-479. The class
 * keeps one-line forwarders that call these with the instance as `this`, so behaviour, closures and
 * `this.x` reads/writes are unchanged. CronTaskWebhookHost lists exactly the Gateway members this code
 * touches (typed from the class itself).
 */
import { resolveRuntimeExecutionAgent } from '@openclaude/storage'
import { clientSessionIsActive } from './routes/clientSessions.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { JobTerminal } from '@openclaude/protocol'
import { resolveChatRunWorkspace } from './projectWorkspace.js'
import { appendServerAuthoredMessage } from '@openclaude/storage'
import { filterUserVisibleByAgentField, isHiddenSystemAgentId } from './agentVisibility.js'
import type { CronDeliveryContext, CronJob } from './cron.js'
import { listCronDeliverChannels } from './cronChannels.js'
import {
  deriveFixedBoardProjectId,
  filterCronJobsForBoard,
  type CronProjectPorts,
} from './cronProject.js'
import {
  buildCronOriginResumeText,
  cronOriginClientMessageId,
  cronOriginIdempotencyKey,
  decideCronOriginDispatchAfterPersist,
  parseOriginWebchatSessionKey,
  resolveCronOriginInjectPayload,
  type CronOriginFireResult,
} from './cronOriginSession.js'
import { getProject } from './taskboard/db/projects.js'
import { postCronOriginInject, readV3CronOriginInjectConfig } from './v3CronOriginInject.js'
import { getTaskboardDb } from './taskboard/db/index.js'
import { isDelegateDurableEffective, isDelegateNotifierEffective } from './delegateSmFlag.js'
import { DefaultEngineNotifier } from './engineNotifier.js'
import { retryPendingNotifies } from './delegateNotifyDispatch.js'
import { formatJobTerminalMarkdown, isJobTerminalFailure } from './jobTerminal.js'
import {
  resolveSyntheticTurnModel,
  resolveLocalExecutionIfEnforced,
  localExecutionOverride,
} from './server.js'
import type { Gateway } from './server.js'

export interface CronTaskWebhookHost {
  _delegateJobs: Gateway['_delegateJobs']
  _getAgentsConfig: Gateway['_getAgentsConfig']
  _invalidateTaskCache: Gateway['_invalidateTaskCache']
  _notifyDispatchHooks: Gateway['_notifyDispatchHooks']
  _runLog: Gateway['_runLog']
  _taskStore: Gateway['_taskStore']
  _triggerTask: Gateway['_triggerTask']
  channels: Gateway['channels']
  cron: Gateway['cron']
  cronProjectPorts: Gateway['cronProjectPorts']
  deps: Gateway['deps']
  dispatchInbound: Gateway['dispatchInbound']
  injectCronOriginFromTerminal: Gateway['injectCronOriginFromTerminal']
  injectCronOriginSession: Gateway['injectCronOriginSession']
  log: Gateway['log']
  readBody: Gateway['readBody']
  sendError: Gateway['sendError']
  sendJson: Gateway['sendJson']
  sessions: Gateway['sessions']
  stampCronProject: Gateway['stampCronProject']
  webhookRouter: Gateway['webhookRouter']
}

/**
 * Notifier rolled back: Completer no longer consumes pending
 * cron-origin-inject rows. Drain them with the same dlgcb.* ResumeInject
 * path so BUSY leftovers are not stranded (review blocker 1 on→off).
 */
export async function _drainFlagOffCronOriginNotifies(
  this: CronTaskWebhookHost,
  opts: { dueOnly?: boolean } = {},
): Promise<void> {
  const store = this._delegateJobs
  if (!store || isDelegateNotifierEffective() || !isDelegateDurableEffective()) return
  const notifier = new DefaultEngineNotifier({
    resumeInject: {
      inject: async (event) => {
        const result = await this.injectCronOriginFromTerminal(event)
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
  })
  try {
    const summary = await retryPendingNotifies(store, notifier, this._notifyDispatchHooks(), {
      ...opts,
      callbacks: ['cron-origin-inject'],
    })
    if (summary.scanned > 0) this.log.info('flag-off cron-origin drain', summary)
  } catch (err) {
    this.log.warn('flag-off cron-origin drain threw', undefined, err as Error)
  }
}

export async function _handleWebhook(
  this: CronTaskWebhookHost,
  req: IncomingMessage,
  res: ServerResponse,
  whId: string,
): Promise<void> {
  if (req.method === 'POST') {
    const wh = this.webhookRouter?.find(whId)
    if (!wh) {
      this.sendError(res, 404, 'webhook not found')
      return
    }
    if (isHiddenSystemAgentId(wh.agent)) {
      this.sendError(res, 404, 'webhook not found')
      return
    }
    const body = await this.readBody(req)
    const sig = (req.headers['x-hub-signature-256'] || req.headers['x-signature'] || '') as string
    const result = await this.webhookRouter!.process(wh, body, sig)
    this.sendJson(res, result.ok ? 200 : 403, result)
    return
  }
  if (req.method === 'DELETE') {
    const removed = await this.webhookRouter?.remove(whId)
    this.sendJson(res, removed ? 200 : 404, { ok: !!removed })
    return
  }
  this.sendError(res, 405, 'method not allowed')
}

export async function _handleTasksApi(
  this: CronTaskWebhookHost,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method === 'GET') {
    const tasks = filterUserVisibleByAgentField(await this._taskStore.list())
    this.sendJson(res, 200, { tasks })
    return
  }
  if (req.method === 'POST') {
    const body = await this.readBody(req)
    let parsed: any
    try {
      parsed = JSON.parse(body)
    } catch {
      return this.sendError(res, 400, 'invalid JSON')
    }
    const { id, title, agent, prompt, trigger, schedule, webhookId, eventType, maxRuns } = parsed
    if (!title || !prompt) return this.sendError(res, 400, 'title and prompt required')
    const taskAgent = typeof agent === 'string' && agent ? agent : 'main'
    if (isHiddenSystemAgentId(taskAgent)) return this.sendError(res, 404, 'agent not found')
    const task = await this._taskStore.create({
      id: id || `task-${Date.now().toString(36)}`,
      title,
      agent: taskAgent,
      prompt,
      trigger: trigger || 'manual',
      schedule,
      webhookId,
      eventType,
      maxRuns,
    })
    this._invalidateTaskCache()
    this.sendJson(res, 201, { ok: true, task })
    return
  }
  this.sendError(res, 405, 'method not allowed')
}

export async function _handleTaskItem(
  this: CronTaskWebhookHost,
  req: IncomingMessage,
  res: ServerResponse,
  taskId: string,
): Promise<void> {
  if (req.method === 'GET') {
    const task = await this._taskStore.get(taskId)
    if (!task) return this.sendError(res, 404, 'task not found')
    if (isHiddenSystemAgentId(task.agent)) return this.sendError(res, 404, 'task not found')
    this.sendJson(res, 200, { task })
    return
  }
  if (req.method === 'PUT') {
    const body = await this.readBody(req)
    let parsed: any
    try {
      parsed = JSON.parse(body)
    } catch {
      return this.sendError(res, 400, 'invalid JSON')
    }
    if (parsed.agent !== undefined && isHiddenSystemAgentId(parsed.agent)) {
      return this.sendError(res, 404, 'agent not found')
    }
    const existing = await this._taskStore.get(taskId)
    if (existing && isHiddenSystemAgentId(existing.agent)) {
      return this.sendError(res, 404, 'task not found')
    }
    const ok = await this._taskStore.update(taskId, parsed)
    if (ok) this._invalidateTaskCache()
    this.sendJson(res, ok ? 200 : 404, { ok })
    return
  }
  if (req.method === 'DELETE') {
    const task = await this._taskStore.get(taskId)
    if (task && isHiddenSystemAgentId(task.agent)) {
      return this.sendError(res, 404, 'task not found')
    }
    const ok = await this._taskStore.remove(taskId)
    if (ok) this._invalidateTaskCache()
    this.sendJson(res, ok ? 200 : 404, { ok })
    return
  }
  // POST → manually trigger the task (uses shared _triggerTask with RunLog)
  if (req.method === 'POST') {
    const task = await this._taskStore.get(taskId)
    if (!task) return this.sendError(res, 404, 'task not found')
    if (isHiddenSystemAgentId(task.agent)) return this.sendError(res, 404, 'task not found')
    if (task.status === 'disabled')
      return this.sendError(res, 409, 'task is disabled (maxRuns reached)')
    this._triggerTask(taskId).catch((err) =>
      this.log.error('task manual trigger failed', { taskId }, err),
    )
    this.sendJson(res, 202, { ok: true, message: 'task triggered' })
    return
  }
  this.sendError(res, 405, 'method not allowed')
}

/** Trigger a task by ID (shared by schedule tick, webhook, and manual API) */
export async function _triggerTask(this: CronTaskWebhookHost, taskId: string): Promise<void> {
  const task = await this._taskStore.get(taskId)
  if (!task || task.status === 'disabled') return
  if (isHiddenSystemAgentId(task.agent)) {
    this.log.warn('task hidden system agent rejected', { taskId, agent: task.agent })
    return
  }
  const cfg = await this._getAgentsConfig()
  const requestedAgent = cfg.agents.find((a) => a.id === task.agent)
  if (!requestedAgent) return
  const agent = (await resolveRuntimeExecutionAgent(requestedAgent, cfg)).agent
  const sessionKey = `agent:${task.agent}:task:${taskId}:${Date.now()}`
  // 合成首帧路由字段补齐(同 cron):定时任务的会话首帧绕过 master bridge 计费编排,
  // 落 codex 会被 CODEX_BILLING_GUARD 拒 → 解析为非 codex 执行模型。
  const _taskRoute = resolveSyntheticTurnModel(agent, this.deps.config.defaults.model)
  // 模型权威 §3(无 envelope 的本地路径):flag 开 → 判定源换成 master catalog 投影。
  // 投影不可用 → 抛 → 由 _triggerTask 的调用方 .catch 记录(任务本次不执行,不回落 baked)。
  const _taskExec = await resolveLocalExecutionIfEnforced({
    catalog: this.sessions.runtime?.catalog,
    agent,
    kind: 'synthetic',
    model: _taskRoute?.model,
    defaultModel: this.deps.config.defaults.model,
  })
  const _taskModel = _taskExec?.canonicalModel ?? _taskRoute?.model
  const session = await this.sessions.getOrCreate({
    sessionKey,
    agent,
    ...(_taskModel ? { model: _taskModel } : {}),
    ...localExecutionOverride(_taskExec),
    channel: 'task',
    peerId: taskId,
    title: `[task] ${task.title}`,
  })
  // MAJOR-2 透明化:effective_model 落 runLog(doctor 面)+ 下方 recordExecution(执行台账)。
  const runEntry = this._runLog.start({
    agentId: task.agent,
    sessionKey,
    taskType: 'task',
    ...(_taskRoute ? { effectiveModel: _taskRoute.model } : {}),
  })
  let output = ''
  let error = ''
  try {
    await this.sessions.submit(
      session,
      task.prompt,
      (e) => {
        if (e.kind === 'block' && e.block.kind === 'text') output += (e.block as any).text
        if (e.kind === 'error') error = e.error
      },
      undefined,
      _taskModel,
    )
  } catch (err: any) {
    error = String(err)
  }
  this._runLog.complete(runEntry, {
    status: error ? 'failed' : 'completed',
    error: error || undefined,
  })
  await this._taskStore.recordExecution({
    taskId,
    startedAt: runEntry.startedAt,
    completedAt: Date.now(),
    status: error ? 'failed' : 'completed',
    output: output.slice(0, 2000),
    error: error || undefined,
    ...(_taskRoute ? { effectiveModel: _taskRoute.model } : {}),
  })
}

/**
 * Stage 2: EngineNotifier ResumeInject for cron-origin-inject. Uses the
 * same persist+dispatch path as Completer origin-session fire, with
 * dlgcb.{jobId}.{epoch} as the message id.
 */
export async function injectCronOriginFromTerminal(
  this: CronTaskWebhookHost,
  event: JobTerminal,
): Promise<CronOriginFireResult> {
  const fallbackText =
    event.state === 'completed' && !isJobTerminalFailure(event) && event.resultRef?.trim()
      ? event.resultRef
      : formatJobTerminalMarkdown(event)
  const payload = resolveCronOriginInjectPayload(event, fallbackText)
  if (!payload) return { kind: 'fallback' }
  return this.injectCronOriginSession(payload.job, payload.delivery, payload.override)
}

export async function injectCronOriginSession(
  this: CronTaskWebhookHost,
  job: CronJob,
  delivery: CronDeliveryContext,
  override?: { text?: string; clientMessageId?: string; idempotencyKey?: string },
): Promise<CronOriginFireResult> {
  const origin = parseOriginWebchatSessionKey(job.sourceSessionKey || '')
  if (!origin) return { kind: 'fallback' }
  const text = override?.text ?? buildCronOriginResumeText(job)
  const clientMessageId =
    override?.clientMessageId ?? cronOriginClientMessageId(delivery.deliveryId)
  const masterCfg = readV3CronOriginInjectConfig()
  if (masterCfg) {
    const posted = await postCronOriginInject(
      {
        sessionId: origin.peerId,
        text,
        clientMessageId,
        agentId: origin.agentId,
      },
      { config: masterCfg },
    )
    if (posted.kind === 'injected') return { kind: 'injected' }
    if (posted.kind === 'gone') return { kind: 'fallback' }
    if (posted.kind === 'in_flight') {
      return { kind: 'retryable_failure', code: 'ORIGIN_SESSION_IN_FLIGHT' }
    }
    return { kind: 'retryable_failure', code: posted.code }
  }
  const userId =
    (typeof job.sourceUserId === 'string' && job.sourceUserId.trim()) ||
    process.env.OC_USER_ID?.trim() ||
    'default'
  // biome-ignore lint/suspicious/noImplicitAnyLet: moved verbatim from server.ts (OCV5-479); pre-existing there
  let existing
  try {
    existing = await clientSessionIsActive(origin.peerId, userId)
  } catch (err) {
    this.log.warn('origin-session lookup failed', { jobId: job.id }, err as Error)
    return { kind: 'retryable_failure', code: 'ORIGIN_SESSION_LOOKUP_FAILED' }
  }
  if (!existing) return { kind: 'fallback' }
  const liveParent = this.sessions.getByKey(origin.sessionKey)
  if ((liveParent?._activeTurnCount ?? 0) > 0 || (liveParent?._activeClientTurnCount ?? 0) > 0) {
    return { kind: 'retryable_failure', code: 'ORIGIN_SESSION_BUSY' }
  }
  try {
    const persisted = await appendServerAuthoredMessage(origin.peerId, userId, {
      id: clientMessageId,
      role: 'user',
      text,
      ts: Date.now(),
    })
    if (!persisted.applied) {
      const decision = decideCronOriginDispatchAfterPersist(persisted)
      if (decision === 'ack_injected') {
        // Durable consumer-side idempotency: same clientMessageId already
        // in sessions.db. ACK and do not dispatch a second turn. The
        // process Map in dispatchInbound is not restart-safe.
        return { kind: 'injected' }
      }
      if (decision === 'fallback') return { kind: 'fallback' }
      return { kind: 'retryable_failure', code: 'ORIGIN_SESSION_PERSIST_FAILED' }
    }
  } catch (err) {
    this.log.warn('origin-session persist failed', { jobId: job.id }, err as Error)
    return { kind: 'retryable_failure', code: 'ORIGIN_SESSION_PERSIST_FAILED' }
  }
  try {
    const cronBoard =
      job.projectMode === 'fixed' && typeof job.boardProjectId === 'string'
        ? job.boardProjectId
        : undefined
    await this.dispatchInbound({
      type: 'inbound.message',
      channel: origin.channel,
      peer: { id: origin.peerId, kind: origin.peerKind },
      agentId: origin.agentId,
      content: { text },
      ts: Date.now(),
      idempotencyKey:
        override?.idempotencyKey ?? cronOriginIdempotencyKey(job.id, delivery.deliveryId),
      clientMessageId,
      _userId: userId,
      ...(cronBoard ? { _cronBoardProjectId: cronBoard, _cronProjectMode: 'fixed' } : {}),
    } as any)
  } catch (err) {
    this.log.warn('origin-session dispatch failed', { jobId: job.id }, err as Error)
    return { kind: 'retryable_failure', code: 'ORIGIN_SESSION_DISPATCH_FAILED' }
  }
  return { kind: 'injected' }
}

// ── Cron/Reminder API handlers ──
export function cronProjectPorts(this: CronTaskWebhookHost): CronProjectPorts {
  return {
    getBoardProject: async (id) => {
      const p = getProject(getTaskboardDb(), id)
      return p ? { id: p.id, archivedAt: p.archivedAt } : null
    },
    getSessionBoardProject: async (sessionId) => {
      const ws = await resolveChatRunWorkspace({ sessionId })
      return ws.bound ? ws.projectId : null
    },
  }
}

export async function stampCronProject(
  this: CronTaskWebhookHost,
  parsed: { projectMode?: unknown; boardProjectId?: unknown },
  originPeerId?: string,
): Promise<
  { projectMode: 'follow_session' | 'fixed'; boardProjectId: string | null } | { error: string }
> {
  const wantFixed = parsed.projectMode === 'fixed'
  if (!wantFixed) return { projectMode: 'follow_session', boardProjectId: null }
  let candidate = typeof parsed.boardProjectId === 'string' ? parsed.boardProjectId : ''
  if (!candidate && originPeerId) {
    const live = await resolveChatRunWorkspace({ sessionId: originPeerId })
    candidate = live.bound && live.projectId ? live.projectId : ''
  }
  const derived = await deriveFixedBoardProjectId(this.cronProjectPorts(), candidate)
  if (!derived) return { error: 'fixed project must be a live unarchived board project' }
  return { projectMode: 'fixed', boardProjectId: derived }
}

export async function handleCronChannels(
  this: CronTaskWebhookHost,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'GET') return this.sendError(res, 405, 'method not allowed')
  this.sendJson(res, 200, { channels: listCronDeliverChannels(this.channels.keys()) })
}

export async function handleCronApi(
  this: CronTaskWebhookHost,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!this.cron) return this.sendError(res, 503, 'cron not initialized')
  if (req.method === 'GET') {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    let jobs = filterUserVisibleByAgentField(await this.cron.listJobsWithMeta())
    const boardRaw = url.searchParams.get('boardProjectId')
    if (boardRaw && boardRaw !== 'all') {
      jobs = await filterCronJobsForBoard(jobs, boardRaw, this.cronProjectPorts())
    }
    this.sendJson(res, 200, { jobs })
    return
  }
  if (req.method === 'POST') {
    const body = await this.readBody(req)
    let parsed: any
    try {
      parsed = JSON.parse(body)
    } catch {
      return this.sendError(res, 400, 'invalid JSON')
    }
    const { schedule, prompt, deliver, oneshot, label, agent } = parsed
    if (!schedule || !prompt) return this.sendError(res, 400, 'schedule and prompt required')
    const cronAgent = typeof agent === 'string' && agent ? agent : 'main'
    if (isHiddenSystemAgentId(cronAgent)) return this.sendError(res, 404, 'agent not found')
    const id = `remind-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const job: CronJob = {
      id,
      schedule,
      agent: cronAgent,
      prompt,
      deliver: deliver || 'webchat',
      enabled: true,
      oneshot: oneshot ?? true,
      label: label || prompt.slice(0, 50),
      // Stamp creation time so bounded catch-up never "makes up" a missed fire
      // for a schedule point that predates this job (see cron.ts resolveDueMinute).
      createdAt: Date.now(),
    }
    if (parsed.resume === 'origin-session') {
      const origin = parseOriginWebchatSessionKey(
        typeof parsed.originSessionKey === 'string' ? parsed.originSessionKey : '',
      )
      const live = origin ? this.sessions.getByKey(origin.sessionKey) : undefined
      const containerUser = process.env.OC_USER_ID?.trim()
      if (!origin || !live) {
        return this.sendError(
          res,
          400,
          'origin-session requires the current live webchat conversation; do not pass a session id',
        )
      }
      if (
        containerUser &&
        typeof live.userId === 'string' &&
        live.userId !== containerUser &&
        live.userId !== 'default'
      ) {
        return this.sendError(res, 403, 'origin-session does not belong to this user')
      }
      job.resume = 'origin-session'
      job.sourceSessionKey = origin.sessionKey
      job.sourceUserId =
        (typeof live.userId === 'string' && live.userId) || containerUser || 'default'
    }
    const stamped = await this.stampCronProject(
      parsed,
      parseOriginWebchatSessionKey(job.sourceSessionKey || '')?.peerId,
    )
    if ('error' in stamped) return this.sendError(res, 400, stamped.error)
    job.projectMode = stamped.projectMode
    job.boardProjectId = stamped.boardProjectId
    await this.cron.addJob(job)
    this.sendJson(res, 201, { ok: true, job })
    return
  }
  this.sendError(res, 405, 'method not allowed')
}

export async function handleCronItem(
  this: CronTaskWebhookHost,
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): Promise<void> {
  if (!this.cron) return this.sendError(res, 503, 'cron not initialized')
  if (req.method === 'DELETE') {
    const existing = (await this.cron.listJobsWithMeta()).find((job) => job.id === id)
    if (existing && isHiddenSystemAgentId(existing.agent)) {
      return this.sendError(res, 404, 'cron job not found')
    }
    const removed = await this.cron.removeJob(id)
    this.sendJson(res, removed ? 200 : 404, { ok: removed })
    return
  }
  if (req.method === 'PUT') {
    const body = await this.readBody(req)
    let parsed: any
    try {
      parsed = JSON.parse(body)
    } catch {
      return this.sendError(res, 400, 'invalid JSON')
    }
    if (parsed.agent !== undefined && isHiddenSystemAgentId(parsed.agent)) {
      return this.sendError(res, 404, 'agent not found')
    }
    const existing = (await this.cron.listJobsWithMeta()).find((job) => job.id === id)
    if (existing && isHiddenSystemAgentId(existing.agent)) {
      return this.sendError(res, 404, 'cron job not found')
    }
    if (parsed.projectMode !== undefined || parsed.boardProjectId !== undefined) {
      const originPeer = parseOriginWebchatSessionKey(existing?.sourceSessionKey || '')?.peerId
      const stamped = await this.stampCronProject(parsed, originPeer)
      if ('error' in stamped) return this.sendError(res, 400, stamped.error)
      parsed.projectMode = stamped.projectMode
      parsed.boardProjectId = stamped.boardProjectId
    }
    const updated = await this.cron.updateJob(id, parsed)
    this.sendJson(res, updated ? 200 : 404, { ok: updated })
    return
  }
  this.sendError(res, 405, 'method not allowed')
}
