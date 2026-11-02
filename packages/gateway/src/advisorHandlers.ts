/**
 * Gateway advisor consult: consult HTTP, spawn (native/CCB), route override, billing projection, presentation
 *
 * Moved verbatim out of Gateway (server.ts) — FINDINGS §7.6, OCV5-479. The class
 * keeps one-line forwarders that call these with the instance as `this`, so behaviour, closures and
 * `this.x` reads/writes are unchanged. AdvisorHandlersHost lists exactly the Gateway members this code
 * touches (typed from the class itself).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { type DurableCodexBilling, ADVISOR_AGENT_ID } from '@openclaude/protocol'
import {
  CONSULT_INVOCATION_HEADER,
  DELEGATE_CONTEXT_HEADER,
  hashConsultTurnToken,
  inspectConsultTurnToken,
} from './delegateContext.js'
import type { AgentSession } from './sessionManager.js'
import { type AgentDef, paths, listTurnTapeRecords } from '@openclaude/storage'
import {
  advisorExecutionFromSnapshotJson,
  buildAdvisorSnapshot,
  collectAuthorizedArtifacts,
  formatAdvisorConsultPrompt,
  ADVISOR_CONSULT_PARENT_REASON,
  assertAdvisorModelAllowed,
  CCB_ADVISOR_PROFILE_VERSION,
  coerceHistoryMessages,
  historyFromSessionMessages,
  isAdvisorConsultParentEngine,
  isAdvisorEngineOpen,
  uniquePendingConsultInvocationId,
  isCcbAdvisorModelProven,
  listProvenAdvisorModels,
  matchConsultIdentity,
  openAdvisorEngines,
  parentAuthorizedArtifactTexts,
  type AdvisorConsultExecution,
} from './advisorMode.js'
import { AdvisorConsultStore, hashEvidence, mintConsultId } from './advisorConsultStore.js'
import { AdvisorConfigStore } from './advisorConfigStore.js'
import type { DelegateJobStore } from './delegateJobs.js'
import {
  defaultDelegateEngineBilling,
  type DelegateEngineBillingAdmission,
} from './delegateEngineBilling.js'
import { parseAdvisorAdmitRoute, type AdvisorAdmitRouteOk } from './advisorCodexRoute.js'
import { V3_CODEX_RELAY_PREFIX } from './v3CodexRelay.js'
import { resolveEngine } from './engine/registry.js'
import { isEngineLocalTurnExempt, isModelAuthorityRequired } from './modelAuthority.js'
import { getLocalCatalogView } from './modelCatalogClient.js'
import type { CodexProviderConfigOverride } from './engine/codexShared.js'
import {
  resolveLocalExecutionIfEnforced,
  localExecutionOverride,
  _buildSafeCodexRouteOverride,
} from './server.js'
import type { Gateway } from './server.js'

export interface AdvisorHandlersHost {
  _adviceFromConsult: Gateway['_adviceFromConsult']
  _advisorConfig: Gateway['_advisorConfig']
  _advisorConsultAborts: Gateway['_advisorConsultAborts']
  _advisorConsultRouteOverride: Gateway['_advisorConsultRouteOverride']
  _advisorConsults: Gateway['_advisorConsults']
  _closeStaleConsult: Gateway['_closeStaleConsult']
  _consultBillingProjecting: Gateway['_consultBillingProjecting']
  _consultBillingRetryMs: Gateway['_consultBillingRetryMs']
  _consultBillingRetryTimer: Gateway['_consultBillingRetryTimer']
  _consultJobFailedState: Gateway['_consultJobFailedState']
  _consultStillLive: Gateway['_consultStillLive']
  _consultWaitMs: Gateway['_consultWaitMs']
  _delegateEngineBilling: Gateway['_delegateEngineBilling']
  _delegateJobs: Gateway['_delegateJobs']
  _ensureConsultBillingProjection: Gateway['_ensureConsultBillingProjection']
  _ensureDelegateJobStore: Gateway['_ensureDelegateJobStore']
  _getAgentsConfig: Gateway['_getAgentsConfig']
  _invocationFromLiveConsultTool: Gateway['_invocationFromLiveConsultTool']
  _loadClientSession: Gateway['_loadClientSession']
  _loadConsultHistoryTape: Gateway['_loadConsultHistoryTape']
  _presentConsultBody: Gateway['_presentConsultBody']
  _presentExistingConsult: Gateway['_presentExistingConsult']
  _registerActiveDelegation: Gateway['_registerActiveDelegation']
  _releaseDelegateSlot: Gateway['_releaseDelegateSlot']
  _resolveAdvisorConsultExecution: Gateway['_resolveAdvisorConsultExecution']
  _spawnAdvisorConsult: Gateway['_spawnAdvisorConsult']
  _spawnCcbAdvisorConsult: Gateway['_spawnCcbAdvisorConsult']
  _waitForDelegateCapacity: Gateway['_waitForDelegateCapacity']
  advisorConfigStore: Gateway['advisorConfigStore']
  advisorConsultStore: Gateway['advisorConsultStore']
  deps: Gateway['deps']
  getUserId: Gateway['getUserId']
  log: Gateway['log']
  readBody: Gateway['readBody']
  sendError: Gateway['sendError']
  sendJson: Gateway['sendJson']
  sessions: Gateway['sessions']
}

export function advisorConsultStore(this: AdvisorHandlersHost): AdvisorConsultStore {
  const store = (this._advisorConsults ??= new AdvisorConsultStore())
  const billing = this._delegateEngineBilling ?? defaultDelegateEngineBilling
  this._ensureConsultBillingProjection(store, billing)
  return store
}

export function _ensureConsultBillingProjection(
  this: AdvisorHandlersHost,
  store: AdvisorConsultStore,
  billing: typeof defaultDelegateEngineBilling,
): void {
  if (this._consultBillingProjecting) return
  this._consultBillingProjecting = true
  const retryMsRaw = Number(this._consultBillingRetryMs)
  const retryMs = Number.isFinite(retryMsRaw) && retryMsRaw > 0 ? retryMsRaw : 250
  void Promise.resolve(billing.projectConsults?.(store))
    .catch((err) => {
      this.log.warn('advisor_consult_billing_projection_failed', {
        err: String((err as Error)?.message ?? err),
      })
      if (this._consultBillingRetryTimer) return
      this._consultBillingRetryTimer = setTimeout(() => {
        this._consultBillingRetryTimer = undefined
        this._consultBillingProjecting = false
        this._ensureConsultBillingProjection(store, billing)
      }, retryMs)
      this._consultBillingRetryTimer.unref?.()
    })
    .finally(() => {
      this._consultBillingProjecting = false
    })
}

export function advisorConfigStore(this: AdvisorHandlersHost): AdvisorConfigStore {
  return (this._advisorConfig ??= new AdvisorConfigStore())
}

export function _projectAdvisorConsultSettled(
  this: AdvisorHandlersHost,
  billing: { requestId?: string },
): void {
  const requestId = typeof billing.requestId === 'string' ? billing.requestId : ''
  if (!requestId || !this._advisorConsults) return
  this._advisorConsults.projectOneReceipt(requestId)
}

export type AdviceFromConsultRecord = {
    advice?: string | null
    jobId?: string | null
  }

export function _adviceFromConsult(
  this: AdvisorHandlersHost,
  record: AdviceFromConsultRecord,
): string {
  if (typeof record.advice === 'string' && record.advice) return record.advice
  if (!record.jobId) return ''
  const view = this._ensureDelegateJobStore().get(record.jobId)
  const body = view.status === 'done' || view.status === 'failed' ? view.body : undefined
  return typeof body?.advice === 'string' ? body.advice : ''
}

export function _advisorSessionKey(
  this: AdvisorHandlersHost,
  record: { originTurnKey: string; consultId: string },
): string {
  return `advisor:${record.originTurnKey}:${record.consultId}`
}

export function _closeStaleConsult(
  this: AdvisorHandlersHost,
  record: import('./advisorConsultStore.js').AdvisorConsultRecord,
): import('./advisorConsultStore.js').AdvisorConsultRecord {
  const terminal = new Set([
    'settled',
    'settle_pending',
    'completed',
    'failed',
    'cancelled',
    'admission_unknown',
  ])
  if (terminal.has(record.state)) return record
  if (this._consultStillLive(record)) return record
  const jobs = this._delegateJobs
  const view = record.jobId && jobs ? jobs.get(record.jobId) : undefined
  if (view && (view.status === 'running' || view.status === 'queued')) return record
  const advice = this._adviceFromConsult(record)
  const ccb = advisorExecutionFromSnapshotJson(record.snapshotJson)?.engine === 'ccb'
  if (ccb) {
    const failed = view ? this._consultJobFailedState(view) : 'failed'
    const state = failed ?? 'failed'
    return this.advisorConsultStore().update(record.consultId, { state, advice: advice || null })
  }
  if (view?.status === 'done' && !this._consultJobFailedState(view) && advice) {
    return this.advisorConsultStore().update(record.consultId, { state: 'settled', advice })
  }
  const failed = view ? this._consultJobFailedState(view) : 'failed'
  const state = failed ?? 'failed'
  return this.advisorConsultStore().update(record.consultId, { state, advice: advice || null })
}

export function _presentConsultBody(
  this: AdvisorHandlersHost,
  current: import('./advisorConsultStore.js').AdvisorConsultRecord,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const advice = this._adviceFromConsult(current)
  const ccb = advisorExecutionFromSnapshotJson(current.snapshotJson)?.engine === 'ccb'
  return {
    status: current.state,
    consultId: current.consultId,
    jobId: current.jobId,
    requestId: current.billingRequestId,
    invocationId: current.invocationId,
    advisorModel: current.advisorModel,
    advice: advice || undefined,
    reused: true,
    recoverable: true,
    ...(current.state === 'completed' || ccb ? { billingMode: 'proxy' } : {}),
    error:
      current.state === 'failed' || current.state === 'cancelled'
        ? current.state
        : current.state === 'settle_pending'
          ? 'settle_pending'
          : undefined,
    ...extra,
  }
}

export type PresentExistingConsultInput = {
    record: import('./advisorConsultStore.js').AdvisorConsultRecord
    question: string
    concern: string
  }

export async function _presentExistingConsult(
  this: AdvisorHandlersHost,
  input: PresentExistingConsultInput,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { record } = input
  if (!matchConsultIdentity(record, { question: input.question, concern: input.concern })) {
    return { status: 409, body: { error: 'invocation 与 question/concern 不一致' } }
  }
  if (record.state === 'admission_unknown') {
    return {
      status: 503,
      body: {
        error: '顾问准入不确定，不重复 admit',
        consultId: record.consultId,
        state: 'admission_unknown',
        reused: true,
      },
    }
  }
  const terminal = new Set(['settled', 'settle_pending', 'completed', 'failed', 'cancelled'])
  const ccbConsult = advisorExecutionFromSnapshotJson(record.snapshotJson)?.engine === 'ccb'
  const deadline = Date.now() + this._consultWaitMs()
  let current = record
  while (Date.now() <= deadline) {
    current = this.advisorConsultStore().findById(current.consultId) ?? current
    const advice = this._adviceFromConsult(current)
    if (terminal.has(current.state) || (advice && !ccbConsult)) {
      return { status: 200, body: this._presentConsultBody(current) }
    }
    if (current.jobId) {
      const jobs = this._ensureDelegateJobStore()
      const view = await jobs.wait(
        current.jobId,
        Math.min(5_000, Math.max(0, deadline - Date.now())),
      )
      current = this.advisorConsultStore().findById(current.consultId) ?? current
      const failed = this._consultJobFailedState(view)
      if (failed) {
        current = this.advisorConsultStore().update(current.consultId, {
          state: failed,
          advice: this._adviceFromConsult(current) || null,
        })
        return { status: 200, body: this._presentConsultBody(current) }
      }
      const waitedAdvice =
        this._adviceFromConsult(current) ||
        ((view.status === 'done' || view.status === 'failed') &&
        typeof view.body?.advice === 'string'
          ? view.body.advice
          : '')
      if (waitedAdvice || terminal.has(current.state)) {
        if (waitedAdvice && !terminal.has(current.state) && !ccbConsult) {
          current = this.advisorConsultStore().update(current.consultId, {
            state: 'settled',
            advice: waitedAdvice,
          })
        }
        return {
          status: 200,
          body: this._presentConsultBody(current, { advice: waitedAdvice || undefined }),
        }
      }
      if (view.status === 'expired') {
        current = this._closeStaleConsult(current)
        if (terminal.has(current.state)) {
          return { status: 200, body: this._presentConsultBody(current) }
        }
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  current = this.advisorConsultStore().findById(record.consultId) ?? record
  if (terminal.has(current.state) || (this._adviceFromConsult(current) && !ccbConsult)) {
    return { status: 200, body: this._presentConsultBody(current) }
  }
  if (!this._consultStillLive(current)) {
    current = this._closeStaleConsult(current)
    if (terminal.has(current.state) || (this._adviceFromConsult(current) && !ccbConsult)) {
      return { status: 200, body: this._presentConsultBody(current) }
    }
  }
  return {
    status: 202,
    body: {
      status: 'pending',
      consultId: current.consultId,
      jobId: current.jobId,
      requestId: current.billingRequestId,
      invocationId: current.invocationId,
      reused: true,
      recoverable: true,
    },
  }
}

export async function _freezeAdvisorTurn(
  this: AdvisorHandlersHost,
  requested: string,
): Promise<{ ok: true; advisorModel: string } | { ok: false; error: string }> {
  try {
    const collabDoc = this.advisorConfigStore().read()
    const proven = [...openAdvisorEngines(), ...(collabDoc.provenEngines ?? [])]
    const view = await (this.sessions.runtime?.catalog.getRoutingView() ?? getLocalCatalogView())
    const listed = listProvenAdvisorModels({
      catalog: view.models,
      provenEngines: proven,
      provenCcbModels: collabDoc.provenCcbModels,
    })
    const allowed = assertAdvisorModelAllowed({
      requested,
      advisorModels: listed.advisorModels,
      unavailableReason: listed.advisorUnavailableReason,
    })
    if (!allowed.ok) return allowed
    return { ok: true, advisorModel: allowed.model }
  } catch (err) {
    return {
      ok: false,
      error: `catalog unavailable: ${String((err as Error)?.message ?? err)}`,
    }
  }
}

export type InvocationFromLiveConsultToolParent = | {
        runner?: { getPartialSnapshot?: () => { completedTools?: unknown[] } }
      }
    | undefined

export async function _invocationFromLiveConsultTool(
  this: AdvisorHandlersHost,
  parent:
    InvocationFromLiveConsultToolParent,
): Promise<{ ok: true; invocationId: string } | { ok: false; reason: 'none' | 'ambiguous' }> {
  const read = () => {
    const tools = parent?.runner?.getPartialSnapshot?.()?.completedTools
    return uniquePendingConsultInvocationId(Array.isArray(tools) ? (tools as never) : [])
  }
  let found = read()
  for (let i = 0; !found.ok && found.reason === 'none' && i < 8; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    found = read()
  }
  return found
}

export async function handleConsultAdvisor(
  this: AdvisorHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!isEngineLocalTurnExempt())
    return this.sendError(res, 404, 'advisor consult is selfhost only')
  if (req.method !== 'POST') return this.sendError(res, 405, 'method not allowed')
  const body = await this.readBody(req)
  let parsed: { question?: unknown; concern?: unknown }
  try {
    parsed = JSON.parse(body) as { question?: unknown; concern?: unknown }
  } catch {
    return this.sendError(res, 400, 'invalid JSON')
  }
  const question = typeof parsed.question === 'string' ? parsed.question.trim() : ''
  const concern = typeof parsed.concern === 'string' ? parsed.concern.trim() : ''
  if (!question) return this.sendError(res, 400, 'question 必填')
  const contextRaw = req.headers[DELEGATE_CONTEXT_HEADER]
  const token = Array.isArray(contextRaw) ? contextRaw[0] : contextRaw
  const inspected = inspectConsultTurnToken(typeof token === 'string' ? token : undefined)
  if (!inspected) {
    return this.sendError(res, 401, 'advisor consult requires an immutable turn token')
  }
  const claims = inspected.claims
  const invocationRaw = req.headers[CONSULT_INVOCATION_HEADER]
  const headerInvocation =
    (Array.isArray(invocationRaw) ? invocationRaw[0] : invocationRaw)?.trim() ?? ''
  if (headerInvocation && !/^[A-Za-z0-9:_-]{8,128}$/.test(headerInvocation)) {
    return this.sendError(res, 400, 'x-openclaude-consult-invocation invalid')
  }
  let invocationId = headerInvocation
  if (!invocationId) {
    const liveParent = this.sessions?.getByKey(claims.sessionKey)
    const bound = await this._invocationFromLiveConsultTool(liveParent)
    if (!bound.ok) {
      const message =
        bound.reason === 'ambiguous'
          ? '这一轮有多次顾问提问叠在一起，请一次只问一个。主模型不会被切换。'
          : '这次顾问提问还没对上同一次调用，请再问一次。主模型不会被切换。'
      return this.sendError(res, 409, message)
    }
    invocationId = bound.invocationId
  }
  const userId = String(this.getUserId(req) ?? '')
  if (!userId) return this.sendError(res, 401, 'missing user')
  const store = this.advisorConsultStore()
  const existing = store.findByInvocation({
    userId,
    originTurnKey: claims.turnKey,
    invocationId,
  })
  if (existing) {
    if (
      existing.sessionKey !== claims.sessionKey ||
      existing.configVersion !== claims.configVersion
    ) {
      return this.sendError(res, 401, 'advisor consult requires an immutable turn token')
    }
    const presentedReceipt = hashConsultTurnToken(String(token))
    const storedReceipt =
      typeof existing.tokenReceipt === 'string' ? existing.tokenReceipt.trim() : ''
    const receiptMatches = storedReceipt.length > 0 && storedReceipt === presentedReceipt
    // HMAC-ok: live process may present a same-user row. If a receipt was
    // recorded, it must still be the exact original token hash (no remint).
    // HMAC-fail: only the exact stored receipt recovers; no-receipt rows 401.
    if (inspected.hmacOk) {
      if (storedReceipt && !receiptMatches) {
        return this.sendError(res, 401, 'advisor consult requires an immutable turn token')
      }
    } else if (!receiptMatches) {
      return this.sendError(res, 401, 'advisor consult requires an immutable turn token')
    }
    const presented = await this._presentExistingConsult({ record: existing, question, concern })
    return this.sendJson(res, presented.status, presented.body)
  }
  if (!inspected.hmacOk) {
    return this.sendError(res, 401, 'advisor consult requires an immutable turn token')
  }
  const parent = this.sessions?.getByKey(claims.sessionKey)
  if (
    !parent ||
    parent.agentId !== 'main' ||
    parent._collabModeTurn !== 'advisor' ||
    !parent._advisorTurn
  ) {
    return this.sendError(res, 409, '当前回合不是顾问模式，无法咨询')
  }
  if (!isAdvisorConsultParentEngine(parent.providerTag)) {
    return this.sendError(res, 409, ADVISOR_CONSULT_PARENT_REASON)
  }
  if (parent._currentTurnKey !== claims.turnKey) {
    return this.sendError(res, 409, '原回合已结束，不能再发起新的顾问咨询')
  }
  if (String(parent.userId ?? '') && String(parent.userId) !== userId) {
    return this.sendError(res, 401, 'missing user')
  }
  const snap = parent.runner.getPartialSnapshot()
  const currentTools = snap.completedTools?.map((tool) => ({
    name: tool.toolName,
    input: tool.inputJson,
    result: typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output ?? ''),
    completed: tool.completed !== false,
  }))
  const frozen = {
    userId,
    sessionKey: claims.sessionKey,
    originTurnKey: claims.turnKey,
    originTurnIndex: claims.turnIndex,
    configVersion: claims.configVersion,
    advisorModel: parent._advisorTurn.advisorModel,
    userTask: parent._currentTurnUserText ?? '',
    readOnly: parent._turnReadOnly === true,
    constraints: parent._injectedTurnConstraints,
    currentTools,
    peerId: parent.peerId,
  }
  const consultId = mintConsultId()
  const advisorSessionKey = `advisor:${frozen.originTurnKey}:${consultId}`
  const abort = new AbortController()
  ;(this._advisorConsultAborts ??= new Map()).set(advisorSessionKey, abort)
  const unregisterEarly = this._registerActiveDelegation(frozen.sessionKey, advisorSessionKey)
  const originIntact = (): boolean => {
    if (abort.signal.aborted) return false
    const live = this.sessions?.getByKey(frozen.sessionKey)
    if (!live) return false
    if (live._currentTurnKey !== frozen.originTurnKey) return false
    if (live._collabModeTurn !== 'advisor') return false
    return true
  }
  const releaseEarly = (): void => {
    this._advisorConsultAborts?.delete(advisorSessionKey)
    unregisterEarly?.()
  }
  let handedToSpawn = false
  let recordedConsultId: string | undefined
  try {
    let historyRecords: ReturnType<typeof historyFromSessionMessages>['records']
    let historyMissing: string[] = []
    try {
      const page = await this._loadConsultHistoryTape(
        frozen.peerId,
        frozen.userId,
        frozen.originTurnKey,
      )
      if (page?.records) {
        const hist = historyFromSessionMessages(page.records, { hasMore: page.nextCursor != null })
        historyRecords = hist.records
        historyMissing = hist.missing
      }
    } catch {
      /* sqlite stub returns null; PG errors fall through to client session */
    }
    if (!historyRecords) {
      try {
        const tape = await this._loadClientSession(frozen.peerId, frozen.userId)
        const hist = historyFromSessionMessages(coerceHistoryMessages(tape?.messages), {
          archivedThroughSeq: tape?.archivedThroughSeq,
          hasMore: tape?.timelineHasMore,
        })
        historyRecords = hist.records
        historyMissing = [...historyMissing, ...hist.missing]
      } catch {
        historyMissing = ['history_tape']
      }
    }
    if (!originIntact()) {
      releaseEarly()
      return this.sendJson(res, 409, {
        error: abort.signal.aborted ? 'parent Stop' : '原回合已结束，不能再发起新的顾问咨询',
        state: 'cancelled',
      })
    }
    const snapshot = buildAdvisorSnapshot({
      question,
      concern,
      advisorModel: frozen.advisorModel,
      source: {
        userTask: frozen.userTask,
        readOnly: frozen.readOnly,
        injectedConstraints: frozen.constraints,
        historyRecords,
        currentTools: frozen.currentTools,
        authorizedArtifacts: collectAuthorizedArtifacts({
          generatedRoot: paths.generatedDir,
          mentioned: parentAuthorizedArtifactTexts({
            userTask: frozen.userTask,
            currentTools: frozen.currentTools,
          }),
        }),
      },
    })
    for (const item of historyMissing) {
      if (!snapshot.missing.includes(item)) snapshot.missing.push(item)
    }
    const snapshotJson = JSON.stringify(snapshot)
    const inserted = store.insertNew({
      consultId,
      invocationId,
      userId: frozen.userId,
      sessionKey: frozen.sessionKey,
      clientSessionId: frozen.peerId,
      originTurnKey: frozen.originTurnKey,
      originTurnIndex: frozen.originTurnIndex,
      configVersion: frozen.configVersion,
      evidenceVersion: hashEvidence(snapshotJson),
      advisorModel: frozen.advisorModel,
      question,
      concern,
      snapshotJson,
      jobId: null,
      billingRequestId: null,
      state: 'accepted',
      tokenReceipt: hashConsultTurnToken(String(token)),
    })
    recordedConsultId = inserted.record.consultId
    if (inserted.reused) {
      releaseEarly()
      const presented = await this._presentExistingConsult({
        record: inserted.record,
        question,
        concern,
      })
      return this.sendJson(res, presented.status, presented.body)
    }
    const resolvedExec = await this._resolveAdvisorConsultExecution(frozen.advisorModel)
    if (!resolvedExec.ok) {
      releaseEarly()
      store.update(inserted.record.consultId, { state: 'failed' })
      return this.sendJson(res, resolvedExec.status, {
        error: resolvedExec.error,
        consultId: inserted.record.consultId,
      })
    }
    snapshot.execution = resolvedExec.value
    store.update(inserted.record.consultId, { snapshotJson: JSON.stringify(snapshot) })
    if (resolvedExec.value.engine === 'ccb') {
      if (!originIntact()) {
        releaseEarly()
        store.update(inserted.record.consultId, { state: 'cancelled' })
        return this.sendJson(res, 409, { error: 'parent Stop', state: 'cancelled', consultId })
      }
      handedToSpawn = true
      const spawned = await this._spawnCcbAdvisorConsult({
        consultId: inserted.record.consultId,
        parent,
        originTurnKey: frozen.originTurnKey,
        snapshot,
        execution: resolvedExec.value,
        abort,
        unregister: unregisterEarly,
      })
      return this.sendJson(res, 200, {
        status: spawned.state,
        consultId: inserted.record.consultId,
        jobId: spawned.jobId,
        advice: spawned.advice,
        advisorModel: frozen.advisorModel,
        billingMode: 'proxy',
        missing: snapshot.missing,
        truncated: snapshot.truncated,
        error: spawned.error,
      })
    }
    const proven = this.advisorConfigStore().read().provenEngines
    if (!isAdvisorEngineOpen('codex', process.env, proven)) {
      releaseEarly()
      store.update(inserted.record.consultId, { state: 'failed' })
      return this.sendJson(res, 503, {
        error: '顾问引擎尚未完成无工具证明，不能咨询',
        consultId: inserted.record.consultId,
      })
    }
    if (!originIntact()) {
      releaseEarly()
      store.update(inserted.record.consultId, { state: 'cancelled' })
      return this.sendJson(res, 409, { error: 'parent Stop', state: 'cancelled', consultId })
    }
    store.update(inserted.record.consultId, { state: 'admission_attempt' })
    const billingApi = this._delegateEngineBilling ?? defaultDelegateEngineBilling
    let admission: DelegateEngineBillingAdmission
    try {
      admission = await billingApi.admit({
        model: frozen.advisorModel,
        engine: 'codex',
        agentId: ADVISOR_AGENT_ID,
        delegateAgentId: ADVISOR_AGENT_ID,
        sessionKey: advisorSessionKey,
        parentSessionId: frozen.peerId,
        parentTurnKey: frozen.originTurnKey,
      })
    } catch (err) {
      releaseEarly()
      store.update(inserted.record.consultId, { state: 'admission_unknown' })
      return this.sendJson(res, 503, {
        error: `顾问准入不确定，不重复 admit: ${String((err as Error)?.message ?? err)}`,
        consultId: inserted.record.consultId,
        state: 'admission_unknown',
      })
    }
    if (!originIntact()) {
      try {
        await billingApi.abandon(admission.requestId)
        store.update(inserted.record.consultId, {
          state: 'cancelled',
          billingRequestId: admission.requestId,
        })
        releaseEarly()
        return this.sendJson(res, 409, {
          error: 'parent Stop',
          state: 'cancelled',
          consultId: inserted.record.consultId,
          requestId: admission.requestId,
        })
      } catch {
        store.update(inserted.record.consultId, {
          state: 'admission_unknown',
          billingRequestId: admission.requestId,
        })
        releaseEarly()
        return this.sendJson(res, 503, {
          error: '已准入但父回合已停止，abandon 不确定',
          consultId: inserted.record.consultId,
          state: 'admission_unknown',
          requestId: admission.requestId,
        })
      }
    }
    const parsedRoute = parseAdvisorAdmitRoute(admission.route)
    const codexRoute = parsedRoute.ok
      ? this._advisorConsultRouteOverride(parsedRoute.route, frozen.advisorModel)
      : null
    if (!codexRoute) {
      try {
        await billingApi.abandon(admission.requestId)
        store.update(inserted.record.consultId, {
          state: 'failed',
          billingRequestId: admission.requestId,
        })
        releaseEarly()
        return this.sendJson(res, 503, {
          error: '顾问路由不可用，已按原 requestId abandon',
          consultId: inserted.record.consultId,
          state: 'failed',
          requestId: admission.requestId,
        })
      } catch {
        store.update(inserted.record.consultId, {
          state: 'admission_unknown',
          billingRequestId: admission.requestId,
        })
        releaseEarly()
        return this.sendJson(res, 503, {
          error: '已准入但顾问路由不可用，abandon 不确定',
          consultId: inserted.record.consultId,
          state: 'admission_unknown',
          requestId: admission.requestId,
        })
      }
    }
    try {
      store.update(inserted.record.consultId, {
        state: 'admitted',
        billingRequestId: admission.requestId,
      })
    } catch (err) {
      try {
        await billingApi.abandon(admission.requestId)
      } catch {
        store.update(inserted.record.consultId, {
          state: 'admission_unknown',
          billingRequestId: admission.requestId,
        })
        releaseEarly()
        return this.sendJson(res, 503, {
          error: '已准入但绑定落盘失败，已尝试 abandon',
          consultId: inserted.record.consultId,
          state: 'admission_unknown',
        })
      }
      store.update(inserted.record.consultId, { state: 'failed' })
      releaseEarly()
      return this.sendError(res, 500, 'consult persist after admit failed')
    }
    handedToSpawn = true
    const spawned = await this._spawnAdvisorConsult({
      consultId: inserted.record.consultId,
      parent,
      originTurnKey: frozen.originTurnKey,
      snapshot,
      requestId: admission.requestId,
      billingApi,
      abort,
      unregister: unregisterEarly,
      codexRoute,
    })
    return this.sendJson(res, 200, {
      status: spawned.state,
      consultId: inserted.record.consultId,
      requestId: admission.requestId,
      jobId: spawned.jobId,
      advice: spawned.advice,
      advisorModel: frozen.advisorModel,
      ...(spawned.usage ? { usage: spawned.usage } : {}),
      missing: snapshot.missing,
      truncated: snapshot.truncated,
      error: spawned.error,
    })
  } catch (err) {
    if (recordedConsultId) {
      const rec = store.findById(recordedConsultId)
      if (
        rec &&
        !rec.billingRequestId &&
        (rec.state === 'accepted' || rec.state === 'admission_attempt')
      ) {
        try {
          store.update(recordedConsultId, { state: 'failed' })
        } catch {
          /* best-effort close of a never-admitted row */
        }
      }
    }
    return this.sendError(res, 500, String((err as Error)?.message ?? err))
  } finally {
    if (!handedToSpawn) releaseEarly()
  }
}

export async function _loadConsultHistoryTape(
  this: AdvisorHandlersHost,
  peerId: string,
  userId: string,
  turnKey: string,
) {
  return listTurnTapeRecords(peerId, userId, turnKey, 0, 80)
}

export type ResolveAdvisorConsultExecutionResult = { ok: true; value: AdvisorConsultExecution } | { ok: false; error: string; status: number }

export async function _resolveAdvisorConsultExecution(
  this: AdvisorHandlersHost,
  advisorModel: string,
): Promise<
  ResolveAdvisorConsultExecutionResult
> {
  const store = this.advisorConfigStore().read()
  if (!isModelAuthorityRequired()) {
    const baked = resolveEngine(advisorModel, { id: ADVISOR_AGENT_ID })
    if (baked === 'codex' && isAdvisorEngineOpen('codex', process.env, store.provenEngines)) {
      return {
        ok: true,
        value: { modelId: advisorModel, engine: 'codex', providerId: 'codex' },
      }
    }
  }
  try {
    const view = await (this.sessions.runtime?.catalog.getRoutingView() ?? getLocalCatalogView())
    const row = view.resolve(view.canonicalize(advisorModel))
    if (!row || row.available === false) {
      return { ok: false, status: 400, error: '顾问型号不在当前 catalog' }
    }
    if (row.engine === 'ccb') {
      const providerId = (row.providerId ?? '').trim()
      if (
        !isCcbAdvisorModelProven({
          modelId: row.modelId,
          providerId,
          provenCcbModels: store.provenCcbModels,
        })
      ) {
        return { ok: false, status: 503, error: '该 CCB 顾问型号尚未完成无工具证明' }
      }
      return {
        ok: true,
        value: {
          modelId: row.modelId,
          engine: 'ccb',
          providerId,
          profileVersion: CCB_ADVISOR_PROFILE_VERSION,
        },
      }
    }
    if (row.engine === 'codex') {
      if (!isAdvisorEngineOpen('codex', process.env, store.provenEngines)) {
        return { ok: false, status: 503, error: '顾问引擎尚未完成无工具证明，不能咨询' }
      }
      return {
        ok: true,
        value: {
          modelId: row.modelId,
          engine: 'codex',
          providerId: (row.providerId ?? 'codex').trim() || 'codex',
        },
      }
    }
    return { ok: false, status: 409, error: '顾问型号引擎不是已证明的 Codex 或 CCB' }
  } catch (err) {
    // Authority mode: catalog failure is always fail-closed.
    // Non-authority Codex already returned via baked resolveEngine above;
    // CCB/unknown must not inherit a proven Codex engine.
    return {
      ok: false,
      status: 503,
      error: `catalog unavailable: ${String((err as Error)?.message ?? err)}`,
    }
  }
}

export type SpawnCcbAdvisorConsultResult = {
  state: string
  advice: string
  jobId?: string
  error?: string
}

export type SpawnCcbAdvisorConsultInput = {
    consultId: string
    parent: AgentSession
    originTurnKey: string
    snapshot: ReturnType<typeof buildAdvisorSnapshot>
    execution: AdvisorConsultExecution
    abort?: AbortController
    unregister?: (() => void) | null
  }

export async function _spawnCcbAdvisorConsult(
  this: AdvisorHandlersHost,
  input: SpawnCcbAdvisorConsultInput,
): Promise<SpawnCcbAdvisorConsultResult> {
  const consultStore = this.advisorConsultStore()
  const advisorSessionKey = `advisor:${input.originTurnKey}:${input.consultId}`
  const slotOpts = { parentBucketKey: input.parent.sessionKey, isReview: false }
  const unregister =
    input.unregister ?? this._registerActiveDelegation(input.parent.sessionKey, advisorSessionKey)
  const abort = input.abort ?? new AbortController()
  ;(this._advisorConsultAborts ??= new Map()).set(advisorSessionKey, abort)
  let slotHeld = false
  let jobId: string | undefined
  let jobs: DelegateJobStore | undefined
  let advice = ''
  let toolViolation = false
  const cancelIfAborted = async (): Promise<{
    state: string
    advice: string
    jobId?: string
    error?: string
  } | null> => {
    const liveParent = this.sessions?.getByKey(input.parent.sessionKey)
    const originGone =
      abort.signal.aborted || !liveParent || liveParent._currentTurnKey !== input.originTurnKey
    if (!originGone) return null
    consultStore.update(input.consultId, {
      state: 'cancelled',
      advice: advice || null,
    })
    if (jobs && jobId) {
      const spawnFailSnap = jobs.snapshotOf(jobId)
      const spawnFailFence = spawnFailSnap?.claimToken
        ? { claimToken: spawnFailSnap.claimToken, fencingEpoch: spawnFailSnap.fencingEpoch }
        : undefined
      jobs.fail(jobId, {
        failureClass: 'cancelled',
        detail: 'parent Stop',
        httpStatus: 409,
        body: { ok: false, error: 'parent Stop', advice, consultId: input.consultId },
        nextState: 'cancelled',
        ...(spawnFailFence ?? {}),
      })
    }
    return { state: 'cancelled', advice, jobId, error: 'parent Stop' }
  }
  try {
    const cfg = await this._getAgentsConfig()
    const abortedBeforeSpawn = await cancelIfAborted()
    if (abortedBeforeSpawn) return abortedBeforeSpawn
    const sourceAgent =
      cfg.agents.find((row) => row.id === 'main') ??
      cfg.agents.find((row) => row.id === cfg.default)
    if (!sourceAgent) throw new Error('advisor source agent missing')
    const agent: AgentDef = {
      ...sourceAgent,
      id: ADVISOR_AGENT_ID,
      model: input.execution.modelId,
      provider: undefined,
      runnerKind: undefined,
      persona: undefined,
      cwd: undefined,
      mcpServers: [],
      toolsets: [],
    }
    const execution = await resolveLocalExecutionIfEnforced({
      catalog: this.sessions.runtime?.catalog,
      agent,
      kind: 'turn',
      model: input.execution.modelId,
      defaultModel: this.deps.config.defaults.model,
    })
    const engine = execution?.engine ?? 'ccb'
    if (engine !== 'ccb' || input.execution.engine !== 'ccb') {
      throw new Error('顾问引擎未开放或型号不是已证明的 CCB 顾问')
    }
    jobs = this._ensureDelegateJobStore()
    const gate = await this._waitForDelegateCapacity({
      sessionKey: advisorSessionKey,
      parentBucketKey: input.parent.sessionKey,
      isReview: false,
    })
    if (gate.status !== 'ok') {
      const state = gate.status === 'aborted' ? 'cancelled' : 'failed'
      consultStore.update(input.consultId, { state })
      return {
        state,
        advice: '',
        error: `顾问资源闸未放行: ${gate.status}`,
      }
    }
    slotHeld = true
    const abortedAfterQueue = await cancelIfAborted()
    if (abortedAfterQueue) return abortedAfterQueue
    const created = jobs.create(ADVISOR_AGENT_ID, {
      sessionKey: advisorSessionKey,
      parentSessionKey: input.parent.sessionKey,
      queued: false,
      kind: 'advisor',
      callback: 'stdout-wait',
      idempotencyKey: input.consultId,
    })
    if ('error' in created) {
      throw new Error('too many in-flight advisor jobs')
    }
    jobId = created.jobId
    consultStore.update(input.consultId, { jobId, state: 'spawned' })
    const abortedBeforeCreate = await cancelIfAborted()
    if (abortedBeforeCreate) return abortedBeforeCreate
    const session = await this.sessions.getOrCreate({
      sessionKey: advisorSessionKey,
      agent,
      ...localExecutionOverride(execution),
      channel: 'advisor',
      peerId: input.parent.peerId,
      userId: input.parent.userId,
      hermeticNoTools: true,
      advisorExecutionLock: input.execution,
      usageAttribution: {
        mode: 'delegate',
        delegateAgentId: ADVISOR_AGENT_ID,
        parentSessionId: input.parent.peerId,
        parentTurnKey: input.originTurnKey,
      },
    })
    const abortedAfterCreate = await cancelIfAborted()
    if (abortedAfterCreate) return abortedAfterCreate
    let error: string | undefined
    let cancelCode: string | undefined
    const originConsultId = input.consultId
    const lockToolViolation = (): void => {
      if (toolViolation) return
      toolViolation = true
      try {
        session.runner.interrupt()
      } catch {
        /* interrupt is best-effort; finally still destroys the session */
      }
    }
    try {
      await this.sessions.submit(
        session,
        formatAdvisorConsultPrompt(input.snapshot),
        (e) => {
          const latest = consultStore.findById(originConsultId)
          if (
            latest &&
            (latest.state === 'completed' ||
              latest.state === 'failed' ||
              latest.state === 'cancelled' ||
              latest.originTurnKey !== input.originTurnKey)
          ) {
            return
          }
          if (e.kind === 'error') {
            error = e.error
            const code = (e as { errorCode?: string }).errorCode
            if (code === 'USER_CANCELLED') cancelCode = code
          }
          if (toolViolation) return
          const eventKind = (e as { kind?: string }).kind
          if (eventKind === 'tool_use_detected' || eventKind === 'permission_request') {
            lockToolViolation()
            return
          }
          if (
            e.kind === 'block' &&
            (e.block.kind === 'tool_use' || e.block.kind === 'tool_result')
          ) {
            lockToolViolation()
            return
          }
          if (e.kind === 'block' && e.block.kind === 'text') advice += e.block.text ?? ''
        },
        undefined,
        input.execution.modelId,
        undefined,
        undefined,
        undefined,
        {
          automaticRetryState: {
            rootClientMessageId: input.consultId,
            attempt: 0,
            max: 0,
          },
        },
      )
    } catch (err) {
      const code = (err as { errorCode?: string })?.errorCode
      if (code === 'USER_CANCELLED') cancelCode = code
      error = String((err as Error)?.message ?? err)
    }
    const cancelled = !toolViolation && (cancelCode === 'USER_CANCELLED' || abort.signal.aborted)
    const jobSnap = jobs.snapshotOf(jobId)
    const fence = jobSnap?.claimToken
      ? { claimToken: jobSnap.claimToken, fencingEpoch: jobSnap.fencingEpoch }
      : undefined
    if (cancelled) {
      consultStore.update(input.consultId, { state: 'cancelled', advice: advice || null })
      jobs.fail(jobId, {
        failureClass: 'cancelled',
        detail: 'parent Stop',
        httpStatus: 409,
        body: { ok: false, error: 'parent Stop', advice, consultId: input.consultId },
        nextState: 'cancelled',
        ...(fence ?? {}),
      })
      return { state: 'cancelled', advice, jobId, error: 'parent Stop' }
    }
    if (toolViolation || error || !advice.trim()) {
      const detail = toolViolation
        ? '顾问发出了工具或权限事件，不能作为无工具完成'
        : error || '顾问未返回非空建议'
      consultStore.update(input.consultId, { state: 'failed', advice: advice || null })
      jobs.fail(jobId, {
        failureClass: 'child_error',
        detail,
        httpStatus: 500,
        body: { ok: false, error: detail, advice, consultId: input.consultId },
        ...(fence ?? {}),
      })
      return { state: 'failed', advice, jobId, error: detail }
    }
    consultStore.update(input.consultId, { state: 'completed', advice })
    jobs.complete(
      jobId,
      {
        httpStatus: 200,
        body: { ok: true, advice, consultId: input.consultId, billingMode: 'proxy' },
      },
      fence,
    )
    return { state: 'completed', advice, jobId }
  } catch (err) {
    const detail = String((err as Error)?.message ?? err)
    consultStore.update(input.consultId, { state: 'failed', advice: advice || null })
    if (jobs && jobId) {
      const spawnFailSnap = jobs.snapshotOf(jobId)
      jobs.fail(jobId, {
        failureClass: 'child_error',
        detail,
        httpStatus: 500,
        body: { ok: false, error: detail, advice, consultId: input.consultId },
        ...(spawnFailSnap?.claimToken
          ? { claimToken: spawnFailSnap.claimToken, fencingEpoch: spawnFailSnap.fencingEpoch }
          : {}),
      })
    }
    return { state: 'failed', advice, jobId, error: detail }
  } finally {
    this._advisorConsultAborts?.delete(advisorSessionKey)
    unregister?.()
    if (slotHeld) this._releaseDelegateSlot(slotOpts)
    await this.sessions.destroySession(advisorSessionKey).catch(() => {})
  }
}

export function _advisorConsultRouteOverride(
  this: AdvisorHandlersHost,
  route: AdvisorAdmitRouteOk,
  model: string,
): import('./engine/codexShared.js').CodexProviderConfigOverride | null {
  const port = this.deps.config.gateway.port
  if (route.kind === 'official_oauth') {
    return _buildSafeCodexRouteOverride({
      agent: { id: ADVISOR_AGENT_ID },
      model,
      rawRoute: { kind: 'official_oauth' },
      officialRelayPort: port,
    })
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  return _buildSafeCodexRouteOverride({
    agent: { id: ADVISOR_AGENT_ID },
    model,
    rawRoute: {
      baseUrl: `http://127.0.0.1:${port}${V3_CODEX_RELAY_PREFIX}/route/${route.token}`,
      modelProvider: route.modelProvider,
      providerName: route.providerName ?? null,
      wireApi: route.wireApi ?? 'responses',
      preferredAuthMethod: route.preferredAuthMethod ?? 'apikey',
      disableResponseStorage: route.disableResponseStorage ?? true,
    },
    officialRelayPort: port,
  })
}

export type SpawnAdvisorConsultResult = {
  state: string
  advice: string
  jobId?: string
  error?: string
  usage?: DurableCodexBilling['usage']
}

export type SpawnAdvisorConsultInput = {
    consultId: string
    parent: AgentSession
    originTurnKey: string
    snapshot: ReturnType<typeof buildAdvisorSnapshot>
    requestId: string
    billingApi: typeof defaultDelegateEngineBilling
    abort?: AbortController
    unregister?: (() => void) | null
    codexRoute: import('./engine/codexShared.js').CodexProviderConfigOverride
  }

export async function _spawnAdvisorConsult(
  this: AdvisorHandlersHost,
  input: SpawnAdvisorConsultInput,
): Promise<SpawnAdvisorConsultResult> {
  const consultStore = this.advisorConsultStore()
  const advisorSessionKey = `advisor:${input.originTurnKey}:${input.consultId}`
  const slotOpts = { parentBucketKey: input.parent.sessionKey, isReview: false }
  const unregister =
    input.unregister ?? this._registerActiveDelegation(input.parent.sessionKey, advisorSessionKey)
  const abort = input.abort ?? new AbortController()
  ;(this._advisorConsultAborts ??= new Map()).set(advisorSessionKey, abort)
  let slotHeld = false
  let jobId: string | undefined
  let jobs: DelegateJobStore | undefined
  let liveBilling: DurableCodexBilling | null = null
  let advice = ''
  let settleError: string | undefined
  const cancelIfAborted = async (): Promise<{
    state: string
    advice: string
    jobId?: string
    error?: string
  } | null> => {
    const liveParent = this.sessions?.getByKey(input.parent.sessionKey)
    const originGone =
      abort.signal.aborted || !liveParent || liveParent._currentTurnKey !== input.originTurnKey
    if (!originGone) return null
    if (!liveBilling) await input.billingApi.abandon(input.requestId).catch(() => {})
    consultStore.update(input.consultId, {
      state: liveBilling ? 'settle_pending' : 'cancelled',
      advice: advice || null,
    })
    if (jobs && jobId) {
      const spawnFailSnap = jobs.snapshotOf(jobId)
      const spawnFailFence = spawnFailSnap?.claimToken
        ? { claimToken: spawnFailSnap.claimToken, fencingEpoch: spawnFailSnap.fencingEpoch }
        : undefined
      jobs.fail(jobId, {
        failureClass: 'cancelled',
        detail: 'parent Stop',
        httpStatus: 409,
        body: { ok: false, error: 'parent Stop', advice, consultId: input.consultId },
        nextState: 'cancelled',
        ...(spawnFailFence ?? {}),
      })
    }
    return {
      state: liveBilling ? 'settle_pending' : 'cancelled',
      advice,
      jobId,
      error: 'parent Stop',
    }
  }
  try {
    const cfg = await this._getAgentsConfig()
    const abortedBeforeSpawn = await cancelIfAborted()
    if (abortedBeforeSpawn) return abortedBeforeSpawn
    const sourceAgent =
      cfg.agents.find((row) => row.id === 'main') ??
      cfg.agents.find((row) => row.id === cfg.default)
    if (!sourceAgent) throw new Error('advisor source agent missing')
    const agent: AgentDef = {
      ...sourceAgent,
      id: ADVISOR_AGENT_ID,
      model: input.snapshot.advisorModel,
      provider: undefined,
      runnerKind: undefined,
      persona: undefined,
      cwd: undefined,
      mcpServers: [],
      toolsets: [],
    }
    const execution = await resolveLocalExecutionIfEnforced({
      catalog: this.sessions.runtime?.catalog,
      agent,
      kind: 'turn',
      model: input.snapshot.advisorModel,
      defaultModel: this.deps.config.defaults.model,
    })
    const engine = execution?.engine ?? 'codex'
    if (
      engine !== 'codex' ||
      !isAdvisorEngineOpen('codex', process.env, this.advisorConfigStore().read().provenEngines)
    ) {
      throw new Error('顾问引擎未开放或型号不是已证明的 Codex 顾问')
    }
    jobs = this._ensureDelegateJobStore()
    const gate = await this._waitForDelegateCapacity({
      sessionKey: advisorSessionKey,
      parentBucketKey: input.parent.sessionKey,
      isReview: false,
    })
    if (gate.status !== 'ok') {
      await input.billingApi.abandon(input.requestId).catch(() => {})
      const state = gate.status === 'aborted' ? 'cancelled' : 'failed'
      consultStore.update(input.consultId, { state })
      return {
        state,
        advice: '',
        error: `顾问资源闸未放行: ${gate.status}`,
      }
    }
    slotHeld = true
    const abortedAfterQueue = await cancelIfAborted()
    if (abortedAfterQueue) return abortedAfterQueue
    const created = jobs.create(ADVISOR_AGENT_ID, {
      sessionKey: advisorSessionKey,
      parentSessionKey: input.parent.sessionKey,
      queued: false,
      kind: 'advisor',
      callback: 'stdout-wait',
      idempotencyKey: input.consultId,
    })
    if ('error' in created) {
      throw new Error('too many in-flight advisor jobs')
    }
    jobId = created.jobId
    consultStore.update(input.consultId, { jobId, state: 'admitted' })
    const abortedBeforeCreate = await cancelIfAborted()
    if (abortedBeforeCreate) return abortedBeforeCreate
    const session = await this.sessions.getOrCreate({
      sessionKey: advisorSessionKey,
      agent,
      ...localExecutionOverride(execution),
      channel: 'advisor',
      peerId: input.parent.peerId,
      userId: input.parent.userId,
      hermeticNoTools: true,
      usageAttribution: {
        mode: 'delegate',
        delegateAgentId: ADVISOR_AGENT_ID,
        parentSessionId: input.parent.peerId,
        parentTurnKey: input.originTurnKey,
      },
    })
    const abortedAfterCreate = await cancelIfAborted()
    if (abortedAfterCreate) return abortedAfterCreate
    consultStore.update(input.consultId, { state: 'spawned', jobId })
    let error: string | undefined
    let cancelCode: string | undefined
    let settleTask: Promise<void> | undefined
    const originConsultId = input.consultId
    try {
      await this.sessions.submit(
        session,
        formatAdvisorConsultPrompt(input.snapshot),
        (e) => {
          if (e.kind === 'codex_billing') {
            const billing = { ...e } as DurableCodexBilling & { kind?: string }
            // biome-ignore lint/performance/noDelete: moved verbatim from server.ts (OCV5-479); pre-existing there
            delete billing.kind
            liveBilling = billing
            settleTask = input.billingApi.settle(billing).catch((settleErr) => {
              settleError = String((settleErr as Error)?.message ?? settleErr)
              this.log.warn('advisor_engine_billing_settle_failed', {
                consultId: input.consultId,
                requestId: billing.requestId,
                err: settleError,
              })
            })
            return
          }
          const latest = consultStore.findById(originConsultId)
          if (
            latest &&
            (latest.state === 'settled' ||
              latest.state === 'failed' ||
              latest.state === 'cancelled' ||
              latest.originTurnKey !== input.originTurnKey)
          ) {
            return
          }
          if (e.kind === 'block' && e.block.kind === 'text') advice += e.block.text ?? ''
          if (e.kind === 'error') {
            error = e.error
            const code = (e as { errorCode?: string }).errorCode
            if (code === 'USER_CANCELLED') cancelCode = code
          }
        },
        undefined,
        input.snapshot.advisorModel,
        input.requestId,
        undefined,
        undefined,
        { codexRoute: input.codexRoute },
      )
    } catch (err) {
      const code = (err as { errorCode?: string })?.errorCode
      if (code === 'USER_CANCELLED') cancelCode = code
      error = String((err as Error)?.message ?? err)
    }
    if (advice) {
      try {
        consultStore.update(input.consultId, { advice })
      } catch {
        /* projection retries from settledReceipts once advice is durable */
      }
    }
    if (settleTask) await settleTask
    // Only project after an authoritative 2xx for this requestId. Advice or
    // observed usage is not payment evidence.
    if (!settleError && liveBilling && advice) {
      try {
        consultStore.projectOneReceipt(input.requestId)
      } catch {
        /* keep settle_pending / spawned until receipt-driven auto-retry */
      }
    }
    const jobSnap = jobs.snapshotOf(jobId)
    const fence = jobSnap?.claimToken
      ? { claimToken: jobSnap.claimToken, fencingEpoch: jobSnap.fencingEpoch }
      : undefined
    const cancelled = cancelCode === 'USER_CANCELLED'
    const usage = (liveBilling as DurableCodexBilling | null)?.usage
    if (!liveBilling) {
      await input.billingApi.abandon(input.requestId).catch(() => {})
      const state = cancelled ? 'cancelled' : 'failed'
      consultStore.update(input.consultId, { state, advice: advice || null })
      jobs.fail(jobId, {
        failureClass: cancelled ? 'cancelled' : 'child_error',
        detail: error || 'missing billing frame',
        httpStatus: cancelled ? 409 : 500,
        body: { ok: false, error, advice, consultId: input.consultId },
        ...(cancelled ? { nextState: 'cancelled' as const } : {}),
        ...(fence ?? {}),
      })
      return {
        state,
        advice,
        jobId,
        error: error || '顾问未产生计费帧（401 或未完成推理不算无工具 PASS）',
      }
    }
    if (settleError) {
      consultStore.update(input.consultId, {
        state: 'settle_pending',
        billingRequestId: input.requestId,
        advice,
      })
      jobs.complete(
        jobId,
        {
          httpStatus: 200,
          body: { ok: true, advice, consultId: input.consultId, settlePending: true },
        },
        fence,
      )
      return {
        state: 'settle_pending',
        advice,
        jobId,
        ...(usage ? { usage } : {}),
        error: `计费 settle 失败，保留 pending 与原 owner: ${settleError}`,
      }
    }
    const state = cancelled ? 'cancelled' : error ? 'failed' : 'settled'
    consultStore.update(input.consultId, { state, advice })
    if (cancelled || error) {
      jobs.fail(jobId, {
        failureClass: cancelled ? 'cancelled' : 'child_error',
        detail: error || 'cancelled',
        httpStatus: cancelled ? 409 : 500,
        body: { ok: false, error, advice, consultId: input.consultId },
        ...(cancelled ? { nextState: 'cancelled' as const } : {}),
        ...(fence ?? {}),
      })
    } else {
      jobs.complete(
        jobId,
        { httpStatus: 200, body: { ok: true, advice, consultId: input.consultId } },
        fence,
      )
    }
    return { state, advice, jobId, error, ...(usage ? { usage } : {}) }
  } catch (err) {
    const detail = String((err as Error)?.message ?? err)
    const observed = Boolean(liveBilling)
    const current = consultStore.findById(input.consultId)
    if (observed || current?.state === 'settled' || current?.state === 'settle_pending') {
      const inheritSettled = current?.state === 'settled' && !settleError
      try {
        consultStore.update(input.consultId, {
          state: inheritSettled ? 'settled' : 'settle_pending',
          billingRequestId: input.requestId,
          advice: advice || current?.advice || null,
        })
      } catch {
        /* keep HTTP advice even if the local projection write fails again */
      }
      if (jobs && jobId) {
        const spawnFailSnap = jobs.snapshotOf(jobId)
        const spawnFailFence = spawnFailSnap?.claimToken
          ? { claimToken: spawnFailSnap.claimToken, fencingEpoch: spawnFailSnap.fencingEpoch }
          : undefined
        try {
          jobs.complete(
            jobId,
            {
              httpStatus: 200,
              body: {
                ok: true,
                advice,
                consultId: input.consultId,
                settlePending: !inheritSettled,
              },
            },
            spawnFailFence,
          )
        } catch {
          /* job already terminal */
        }
      }
      return {
        state: inheritSettled ? 'settled' : 'settle_pending',
        advice,
        jobId,
        error: detail,
      }
    }
    await input.billingApi.abandon(input.requestId).catch(() => {})
    try {
      consultStore.update(input.consultId, { state: 'failed', advice: advice || null })
    } catch {
      /* persist best-effort */
    }
    if (jobs && jobId) {
      const spawnFailSnap = jobs.snapshotOf(jobId)
      const spawnFailFence = spawnFailSnap?.claimToken
        ? { claimToken: spawnFailSnap.claimToken, fencingEpoch: spawnFailSnap.fencingEpoch }
        : undefined
      jobs.fail(jobId, {
        failureClass: 'child_error',
        detail,
        httpStatus: 500,
        body: { ok: false, error: detail, consultId: input.consultId },
        ...(spawnFailFence ?? {}),
      })
    }
    return { state: 'failed', advice: '', jobId, error: detail }
  } finally {
    this._advisorConsultAborts?.delete(advisorSessionKey)
    unregister?.()
    if (slotHeld) this._releaseDelegateSlot(slotOpts)
    await this.sessions.destroySession(advisorSessionKey).catch(() => {})
  }
}
