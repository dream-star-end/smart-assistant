import { randomUUID } from 'node:crypto'
import { isDelegateBackgroundEnabled } from '@openclaude/protocol'
import type { DelegateContextClaims } from './delegateContext.js'
import { DELEGATE_CONTEXT_TTL_MS } from './delegateContext.js'
import type { DelegateOwnerTurnLocator } from './delegateLateCompletion.js'
import type { AgentSession } from './sessionManager.js'
import { TaskboardCancelledError } from './taskboard/runControl.js'
import { getV3MasterSinkOrNull, readV3MasterSinkConfig } from './v3MasterSink.js'

/** Personal managed runtime only: standalone gateways have no durable result sink. */
export function isDelegateBackgroundEffective(env: NodeJS.ProcessEnv = process.env): boolean {
  return isDelegateBackgroundEnabled(env) && !!env.OC_RUNTIME_CHANNEL?.trim() &&
    readV3MasterSinkConfig(env) !== null
}

export interface BackgroundDelegateOwner {
  sessionKey: string
  clientMessageId: string
  userId: string
  traceId: string
  locator: DelegateOwnerTurnLocator
}

/** Freeze before HTTP body/config awaits. A stale signed turn cannot adopt a new owner. */
export function freezeBackgroundDelegateOwner(
  claims: DelegateContextClaims | null,
  parent: AgentSession | undefined,
): BackgroundDelegateOwner | undefined {
  if (!isDelegateBackgroundEffective() || !getV3MasterSinkOrNull() || !claims || !parent ||
      claims.depth !== 0 || parent.channel !== 'webchat' || parent.sessionKey !== claims.sessionKey ||
      parent.executionTarget?.kind === 'remote' ||
      parent.agentId !== claims.agentId || !claims.traceId || claims.traceId !== parent._currentTurnTraceId ||
      !parent._currentTurnKey || !parent._runningClientMessageId || !parent.userId) return undefined
  return {
    sessionKey: parent.sessionKey, clientMessageId: parent._runningClientMessageId,
    userId: parent.userId, traceId: claims.traceId,
    locator: { parentSessionId: parent.peerId, parentTurnKey: parent._currentTurnKey,
      turnIndex: parent._currentTurnIndex ?? Math.max(1, parent.turns + 1) },
  }
}

type Member = { parent?: string; active: boolean; sealed: boolean; traceId?: string }

/** Owns whole delegate promises, including preparation and awaited resource cleanup.
 * It is deliberately separate from taskboardControl and never changes billing roots. */
export class BackgroundDelegateScope {
  readonly id = `preparing-${randomUUID()}`
  readonly controller = new AbortController()
  readonly signal = this.controller.signal
  readonly members = new Map<string, Member>()
  private readonly waiters = new Set<() => void>()
  private readonly pendingCleanup = new Set<Promise<void>>()
  jobId?: string
  private finished = false
  constructor(readonly owner: BackgroundDelegateOwner) {}
  assertOpen(parent?: string): void {
    if (this.finished || this.signal.aborted || (parent && this.members.get(parent)?.sealed)) throw new TaskboardCancelledError()
  }
  /** Read-only preparation is interruptible even when its dependency never settles.
   * Resource acquisition callers supply a compensating cleanup for a late receipt. */
  wait<T>(pending: Promise<T>, releaseLate?: (value: T) => void | Promise<void>): Promise<T> {
    const retainCleanup = () => {
      if (!releaseLate) return
      const cleanup = pending.then(value => releaseLate(value), () => {}).then(() => {})
      this.pendingCleanup.add(cleanup)
      void cleanup.catch(() => {})
    }
    if (this.signal.aborted) {
      retainCleanup()
      return Promise.reject(new TaskboardCancelledError())
    }
    return new Promise((resolve, reject) => {
      let aborted = false
      const stop = () => { aborted = true; retainCleanup(); reject(new TaskboardCancelledError()) }
      this.signal.addEventListener('abort', stop, { once: true })
      pending.then(async value => {
        this.signal.removeEventListener('abort', stop)
        if (aborted) return
        resolve(value)
      }, error => {
        this.signal.removeEventListener('abort', stop)
        if (!aborted) reject(error)
      }).catch(() => {})
    })
  }
  /** A late resource receipt is not evidence of release until compensation finishes.
   * Unknown acquisition stays stopping rather than reporting a false cancelled terminal. */
  async waitForCleanup(): Promise<void> {
    while (this.pendingCleanup.size) {
      const batch = [...this.pendingCleanup]
      await Promise.all(batch)
      for (const cleanup of batch) this.pendingCleanup.delete(cleanup)
    }
  }
  enter(key: string, parent?: string): () => void {
    this.assertOpen(parent)
    this.members.set(key, { parent, active: true, sealed: false })
    let left = false
    return () => {
      if (left) return
      left = true
      const member = this.members.get(key)!
      member.active = false
      member.sealed = true
      for (const wake of [...this.waiters]) wake()
    }
  }
  bindTrace(key: string, traceId: string | undefined): void {
    const member = this.members.get(key)
    if (member) member.traceId = traceId
  }
  acceptsCaller(key: string, traceId: string | undefined): boolean {
    return !!traceId && this.members.get(key)?.traceId === traceId && !this.signal.aborted && !this.finished
  }
  enterPending(parent: string): () => void {
    return this.enter(`pending-${randomUUID()}`, this.members.has(parent) ? parent : undefined)
  }
  finish(): void { this.finished = true }
  stop(): boolean {
    if (this.finished || this.signal.aborted) return false
    this.controller.abort(new TaskboardCancelledError())
    return true
  }
  waitForDescendants(parent: string): Promise<void> {
    const node = this.members.get(parent)
    if (node) node.sealed = true
    const active = () => [...this.members].some(([key, member]) => {
      if (!member.active || key === parent) return false
      const seen = new Set<string>()
      let ancestor = member.parent
      while (ancestor && !seen.has(ancestor)) {
        if (ancestor === parent) return true
        seen.add(ancestor)
        ancestor = this.members.get(ancestor)?.parent
      }
      return false
    })
    if (!active()) return Promise.resolve()
    return new Promise(resolve => {
      const wake = () => { if (!active()) { this.waiters.delete(wake); resolve() } }
      this.waiters.add(wake)
    })
  }
}

class BackgroundDelegateRegistry {
  readonly scopes = new Set<BackgroundDelegateScope>()
  private readonly jobCleanups = new Map<string, BackgroundDelegateScope>()
  private readonly retiredSessions = new Map<string, { expires: number; scope: BackgroundDelegateScope }>()
  private readonly stopSnapshots = new Map<string, { expires: number; scopes: Set<BackgroundDelegateScope> }>()
  private readonly closedOwners = new Map<string, number>()
  private key(owner: BackgroundDelegateOwner): string { return `${owner.sessionKey}\0${owner.locator.parentTurnKey}` }
  sealOwner(sessionKey: string, turnKey: string): void {
    this.closedOwners.set(`${sessionKey}\0${turnKey}`, Date.now() + DELEGATE_CONTEXT_TTL_MS)
  }
  begin(owner: BackgroundDelegateOwner): BackgroundDelegateScope {
    const now = Date.now()
    for (const [key, retired] of this.retiredSessions) if (retired.expires <= now) this.retiredSessions.delete(key)
    for (const [key, expires] of this.closedOwners) if (expires <= now) this.closedOwners.delete(key)
    if (this.closedOwners.has(this.key(owner))) throw new TaskboardCancelledError()
    const scope = new BackgroundDelegateScope(owner)
    this.scopes.add(scope)
    return scope
  }
  beginJob(scope: BackgroundDelegateScope, jobId: string): void { this.jobCleanups.set(jobId, scope) }
  endJob(scope: BackgroundDelegateScope, jobId: string): void {
    if (this.jobCleanups.get(jobId) === scope) this.jobCleanups.delete(jobId)
  }
  ownsActiveJob(jobId: string): boolean { return this.jobCleanups.has(jobId) }
  forSession(key: string): BackgroundDelegateScope | undefined {
    const active = [...this.scopes].find(scope => scope.members.get(key)?.active)
    if (active) return active
    const retired = this.retiredSessions.get(key)
    if (retired && retired.expires > Date.now()) return retired.scope
    this.retiredSessions.delete(key)
    return undefined
  }
  finish(scope: BackgroundDelegateScope): void {
    this.scopes.delete(scope)
    for (const [jobId, owner] of this.jobCleanups) if (owner === scope) this.jobCleanups.delete(jobId)
    for (const [key] of scope.members) {
      this.retiredSessions.set(key, { expires: Date.now() + DELEGATE_CONTEXT_TTL_MS, scope })
    }
    // Signed descendant contexts can arrive after the root promise completed.
    scope.finish()
  }
  ownsProgress(input: { sessionKey?: string; clientMessageId?: string; userId?: string; jobIds: string[] }): boolean {
    return !!input.sessionKey && !!input.clientMessageId && !!input.userId && input.jobIds.length > 0 &&
      input.jobIds.every(jobId => [...this.scopes,
        ...[...this.retiredSessions.values()].filter(entry => entry.expires > Date.now()).map(entry => entry.scope),
      ].some(scope => scope.jobId === jobId &&
        scope.owner.sessionKey === input.sessionKey && scope.owner.clientMessageId === input.clientMessageId &&
        scope.owner.userId === input.userId))
  }
  stop(input: { peerId: string; userId?: string; clientMessageId?: string; jobIds?: string[]; captureCurrentTurn?: boolean }): boolean {
    if (!input.userId) return false
    const ids = new Set((input.jobIds ?? []).slice(0, 32))
    let captured: Set<BackgroundDelegateScope> | undefined
    if (input.captureCurrentTurn && input.clientMessageId) {
      const key = `${input.userId}\0${input.peerId}\0${input.clientMessageId}`
      for (const [old, snapshot] of this.stopSnapshots) if (snapshot.expires <= Date.now()) this.stopSnapshots.delete(old)
      let snapshot = this.stopSnapshots.get(key)
      if (!snapshot) {
        snapshot = { expires: Date.now() + DELEGATE_CONTEXT_TTL_MS, scopes: new Set(this.scopes) }
        this.stopSnapshots.set(key, snapshot)
      }
      captured = snapshot.scopes
    }
    let stopped = false
    for (const scope of this.scopes) {
      const owner = scope.owner
      if (owner.userId !== input.userId || owner.locator.parentSessionId !== input.peerId) continue
      const exactTurn = !!input.clientMessageId && owner.clientMessageId === input.clientMessageId
      if (!exactTurn && !captured?.has(scope) && (!scope.jobId || !ids.has(scope.jobId))) continue
      if (exactTurn) this.closedOwners.set(this.key(owner), Date.now() + DELEGATE_CONTEXT_TTL_MS)
      stopped = scope.stop() || stopped
    }
    return stopped
  }
}

const registries = new WeakMap<object, BackgroundDelegateRegistry>()
export function backgroundDelegates(host: object): BackgroundDelegateRegistry {
  let registry = registries.get(host)
  if (!registry) { registry = new BackgroundDelegateRegistry(); registries.set(host, registry) }
  return registry
}
