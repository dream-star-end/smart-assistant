import { cancelDelegateTraceWait } from './delegateTrace.js'
/**
 * Gateway delegate guard: resource/concurrency gates, active-delegation registry and parent interrupts, collaboration engine/capability and consult liveness
 *
 * Moved verbatim out of Gateway (server.ts) — FINDINGS §7.6, OCV5-533. The class
 * keeps one-line forwarders that call these with the instance as `this`, so behaviour, closures and
 * `this.x` reads/writes are unchanged. DelegateGuardHost lists exactly the Gateway members this code
 * touches (typed from the class itself).
 */
import type { IncomingMessage } from 'node:http'
import { delegateConcurrencyCap, formatDelegateConcurrencyReject, getDelegateMaxPerParent } from './delegateCapacity.js'
import type { AgentSession } from './sessionManager.js'
import { getClientSession } from '@openclaude/storage'
import { ADVISOR_CONSULT_PARENT_ENGINES, ADVISOR_CONSULT_PARENT_REASON, advisorConsultParentGate } from './advisorMode.js'
import { parseTrustedCollabParentHeaders } from './bridgeApiAllowlist.js'
import { getLocalCatalogView } from './modelCatalogClient.js'
import { DELEGATE_QUEUE_MAX_WAITERS } from './delegatePolicy.js'
import type { Gateway } from './server.js'
import type { DelegateGateBlock } from './delegatePolicy.js'

export interface DelegateGuardHost {
  _activeDelegations: Gateway['_activeDelegations']
  _activeDelegationsByParent: Gateway['_activeDelegationsByParent']
  _advisorConsultAborts: Gateway['_advisorConsultAborts']
  _advisorConsultWaitMs: Gateway['_advisorConsultWaitMs']
  _advisorSessionKey: Gateway['_advisorSessionKey']
  _catalogEngineForModel: Gateway['_catalogEngineForModel']
  _delegateJobs: Gateway['_delegateJobs']
  _delegateQueueWaiters: Gateway['_delegateQueueWaiters']
  _interruptDelegationsForParent: Gateway['_interruptDelegationsForParent']
  _liveMainSessionForClient: Gateway['_liveMainSessionForClient']
  _loadClientSession: Gateway['_loadClientSession']
  _readDelegateMemoryPressure: Gateway['_readDelegateMemoryPressure']
  _runningDelegationsByParent: Gateway['_runningDelegationsByParent']
  checkBridgeBypass: Gateway['checkBridgeBypass']
  log: Gateway['log']
  sessions: Gateway['sessions']
}

const DELEGATE_MEMORY_PRESSURE_DEFAULT_RATIO = 0.85

function parseDelegateMemoryPressureRatio(): number {
  const raw = Number(process.env.OPENCLAUDE_DELEGATE_MEMORY_PRESSURE_RATIO)
  return Number.isFinite(raw) && raw > 0 && raw < 1
    ? raw
    : DELEGATE_MEMORY_PRESSURE_DEFAULT_RATIO
}

export type CheckDelegateResourceGateOpts = {
    parentBucketKey?: string
    isReview?: boolean
  }

/** 两道资源闸共用的判定。并发在前 —— 与历史行为的拒绝优先级一致
 *  (旧代码并发 429 判在内存 503 之前)。
 *
 *  P2 债C/3.5 — 分桶 + review 保留槽:
 *   - 全局:review 委派可用满 MAX;非 review 委派最多用到 MAX − 保留槽,给审查留位。
 *   - per-parent:非 review 委派按父分桶计数,单父超上限即 concurrency block(进排队);
 *     review 委派豁免此桶(它有独立保留槽,不受某父 fan-out 挤占)。
 *   缺 parentBucketKey(cron/webhook 父不在内存)→ 只受全局闸,不分桶(与既有行为一致)。 */
export function _checkDelegateResourceGate(this: DelegateGuardHost, opts?: CheckDelegateResourceGateOpts): DelegateGateBlock | null {
  const isReview = opts?.isReview === true
  const globalCap = delegateConcurrencyCap(isReview)
  if (this._activeDelegations >= globalCap) {
    return { kind: 'concurrency' }
  }
  if (!isReview && opts?.parentBucketKey) {
    const running = (this._runningDelegationsByParent ??= new Map()).get(opts.parentBucketKey) ?? 0
    if (running >= getDelegateMaxPerParent()) {
      return { kind: 'concurrency' }
    }
  }
  const pressure = this._readDelegateMemoryPressure()
  const limit = parseDelegateMemoryPressureRatio()
  if (pressure && pressure.ratio >= limit) {
    return {
      kind: 'memory',
      pct: Math.round(pressure.ratio * 100),
      limitPct: Math.round(limit * 100),
    }
  }
  return null
}

export type FormatDelegateConcurrencyRejectOpts = {
    isReview: boolean
    parentBucketKey?: string
    waitedS?: number
    queueFull?: boolean
  }

export function _formatDelegateConcurrencyReject(this: DelegateGuardHost, opts: FormatDelegateConcurrencyRejectOpts): string {
  const perParentMax = getDelegateMaxPerParent()
  const perParentInUse =
    !opts.isReview && opts.parentBucketKey
      ? (this._runningDelegationsByParent ??= new Map()).get(opts.parentBucketKey) ?? 0
      : undefined
  return formatDelegateConcurrencyReject({
    isReview: opts.isReview,
    inUse: this._activeDelegations,
    perParentInUse,
    perParentMax,
    waitedS: opts.waitedS,
    queueFull: opts.queueFull,
    queueMaxWaiters: DELEGATE_QUEUE_MAX_WAITERS,
  })
}

export function _registerActiveDelegation(this: DelegateGuardHost, parentSessionKey: string | undefined, childSessionKey: string): (() => void) | null {
  if (!parentSessionKey) return null
  let set = this._activeDelegationsByParent.get(parentSessionKey)
  if (!set) {
    set = new Set<string>()
    this._activeDelegationsByParent.set(parentSessionKey, set)
  }
  set.add(childSessionKey)
  return () => {
    const current = this._activeDelegationsByParent.get(parentSessionKey)
    if (!current) return
    current.delete(childSessionKey)
    if (current.size === 0) this._activeDelegationsByParent.delete(parentSessionKey)
  }
}

export function _interruptDelegationsForParent(this: DelegateGuardHost, parentSessionKey: string, visited = new Set<string>()): boolean {
  if (visited.has(parentSessionKey)) return false
  visited.add(parentSessionKey)
  const childSessionKeys = this._activeDelegationsByParent.get(parentSessionKey)
  if (!childSessionKeys || childSessionKeys.size === 0) return false

  let interrupted = false
  let attempted = 0
  for (const childSessionKey of [...childSessionKeys]) {
    attempted++
    const descendantInterrupted = this._interruptDelegationsForParent(childSessionKey, visited)
    interrupted = cancelDelegateTraceWait(this, childSessionKey) || interrupted
    this._advisorConsultAborts?.get(childSessionKey)?.abort()
    // 还在资源闸排队等待的委派(尚未 spawn,session 不存在):唤醒并中止其等待,
    // 否则 Stop 级联对它不可达,要干等到排队超时。
    const abortQueuedWait = this._delegateQueueWaiters?.get(childSessionKey)
    if (abortQueuedWait) {
      abortQueuedWait()
      interrupted = true
      if (!this.sessions.getByKey(childSessionKey)) {
        childSessionKeys.delete(childSessionKey)
        continue
      }
    }
    if (!this.sessions.getByKey(childSessionKey)) {
      childSessionKeys.delete(childSessionKey)
      interrupted = descendantInterrupted || interrupted
      continue
    }
    interrupted = this.sessions.interrupt(childSessionKey, 'user') || descendantInterrupted || interrupted
  }
  if (childSessionKeys.size === 0) this._activeDelegationsByParent.delete(parentSessionKey)
  this.log.info('interrupt_delegations', {
    parentSessionKey,
    attempted,
    ok: interrupted,
  })
  return interrupted
}

export function _liveMainSessionForClient(this: DelegateGuardHost, sessionId: string, userId: string): AgentSession | undefined {
  const live = this.sessions.getByKey(`agent:main:webchat:dm:${sessionId}`)
  if (!live || live.agentId !== 'main') return undefined
  if (String(live.userId ?? '') !== String(userId)) return undefined
  return live
}

export async function _catalogEngineForModel(this: DelegateGuardHost, modelId: string | undefined): Promise<string | undefined> {
  if (!modelId) return undefined
  try {
    const view = await (this.sessions.runtime?.catalog.getRoutingView() ?? getLocalCatalogView())
    const canonical = view.canonicalize(modelId)
    return view.models.find((row) => row.modelId === canonical || row.modelId === modelId)?.engine
  } catch {
    return undefined
  }
}

export async function _loadClientSession(this: DelegateGuardHost, sessionId: string, userId: string) {
  return getClientSession(sessionId, userId)
}

export type ParentEngineForCollabSessionInput = {
    sessionId: string
    userId: string
    req: IncomingMessage
    url: URL
  }

export async function _parentEngineForCollabSession(this: DelegateGuardHost, input: ParentEngineForCollabSessionInput): Promise<{ missing: boolean; agentId?: string; engine?: string }> {
  const bridgeVerified = this.checkBridgeBypass(input.req, input.url)
  if (bridgeVerified) {
    const trusted = parseTrustedCollabParentHeaders(input.req.headers as Record<string, unknown>)
    if (!trusted || trusted.sessionId !== input.sessionId) return { missing: true }
    const fromCatalog = await this._catalogEngineForModel(trusted.modelId)
    return { missing: false, agentId: trusted.agentId, engine: fromCatalog }
  }
  const live = this._liveMainSessionForClient(input.sessionId, input.userId)
  let stored: { agentId?: string; modelId?: string } | null | undefined
  try {
    stored = await this._loadClientSession(input.sessionId, input.userId)
  } catch {
    stored = undefined
  }
  if (!stored && !live) return { missing: true }
  const agentId = stored?.agentId || live?.agentId
  if (agentId !== 'main') {
    return { missing: false, agentId, engine: undefined }
  }
  const storedModel = typeof stored?.modelId === 'string' ? stored.modelId.trim() : ''
  const modelId = storedModel || (typeof live?.model === 'string' ? live.model : undefined)
  const fromCatalog = await this._catalogEngineForModel(modelId)
  const engine = fromCatalog || (!storedModel ? live?.providerTag : undefined) || undefined
  return { missing: false, agentId, engine }
}

export type CollaborationCapabilityFieldsInput = {
    sessionId?: string
    engine?: string
  }

export function _collaborationCapabilityFields(this: DelegateGuardHost, input: CollaborationCapabilityFieldsInput): Record<string, unknown> {
  const gate = advisorConsultParentGate(input.engine)
  return {
    advisorConsultParents: [...ADVISOR_CONSULT_PARENT_ENGINES],
    advisorConsultParentReason: ADVISOR_CONSULT_PARENT_REASON,
    ...(input.engine ? { parentEngine: input.engine } : {}),
    ...(input.sessionId
      ? { advisorConsultAllowed: gate.allowed }
      : {}),
  }
}

export function _consultWaitMs(this: DelegateGuardHost): number {
  const raw = Number(this._advisorConsultWaitMs)
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000
}

export type ConsultJobFailedStateView = {
    status: string
    state?: string
    failure_class?: string
    httpStatus?: number
  }

export function _consultJobFailedState(this: DelegateGuardHost, view: ConsultJobFailedStateView): 'failed' | 'cancelled' | null {
  if (view.status === 'expired') return 'failed'
  if (view.status === 'failed') {
    return view.state === 'cancelled' || view.failure_class === 'cancelled' ? 'cancelled' : 'failed'
  }
  if (view.status === 'done' && (view.failure_class || (typeof view.httpStatus === 'number' && view.httpStatus >= 400))) {
    return view.failure_class === 'cancelled' ? 'cancelled' : 'failed'
  }
  return null
}

export function _consultStillLive(this: DelegateGuardHost, record: { originTurnKey: string; consultId: string; jobId?: string | null }): boolean {
  const key = this._advisorSessionKey(record)
  if (this._advisorConsultAborts?.has(key)) return true
  const children = this._activeDelegationsByParent
  if (children) {
    for (const set of children.values()) {
      if (set.has(key)) return true
    }
  }
  const view = record.jobId && this._delegateJobs ? this._delegateJobs.get(record.jobId) : undefined
  return view?.status === 'running' || view?.status === 'queued'
}
