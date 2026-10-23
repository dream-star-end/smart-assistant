import { randomUUID } from 'node:crypto'
import { DELEGATE_CONTEXT_TTL_MS } from '../delegateContext.js'

export class TaskboardCancelledError extends Error {
  readonly code = 'USER_CANCELLED'
  constructor() { super('USER_CANCELLED: task execution has stopped'); this.name = 'TaskboardCancelledError' }
}

export interface TaskboardExecutionResult {
  executionId: string
  sessionKey: string
  agentId: string
  actualModel?: string
  output: string
  error?: string
  cancelled?: boolean
  tokensIn?: number | null
  tokensOut?: number | null
  costUsd?: number | null
  costImprecise?: boolean
}

type Member = { parent: string | null; active: number; sealed: boolean }
type Waiter = { parent: string; resolve: () => void }

/** Tracks complete delegate promises, independently of the progress display graph. */
export class TaskboardRunControl {
  private readonly controller = new AbortController()
  private readonly members = new Map<string, Member>()
  private readonly waiters = new Set<Waiter>()
  private readonly results = new Map<string, TaskboardExecutionResult>()
  private complete = false
  readonly signal = this.controller.signal

  constructor(
    readonly runId: string,
    readonly ticketId: string,
    readonly leaseOwner: string,
    readonly rootSessionKey: string,
    private readonly registerSession: (key: string) => void = () => {},
  ) {
    this.members.set(rootSessionKey, { parent: null, active: 0, sealed: false })
    registerSession(rootSessionKey)
  }

  assertOpen(parent?: string): void {
    if (this.complete || this.signal.aborted) throw new TaskboardCancelledError()
    if (parent && (!this.members.has(parent) || this.members.get(parent)!.sealed)) throw new TaskboardCancelledError()
  }

  /** Must execute before the first await in a delegate wrapper or HTTP entry. */
  enter(sessionKey: string, parent?: string): () => void {
    this.assertOpen(parent)
    if (sessionKey === this.rootSessionKey) {
      if (parent) throw new Error('taskboard root cannot be its own descendant')
    } else if (!parent) {
      throw new Error('taskboard descendant requires its real parent')
    }
    const existing = this.members.get(sessionKey)
    if (existing?.active) throw new TaskboardCancelledError()
    const node = existing ?? { parent: parent ?? null, active: 0, sealed: false }
    if (node.parent !== (parent ?? null)) throw new Error('taskboard parent mismatch')
    this.registerSession(sessionKey)
    node.active = 1
    node.sealed = false
    this.members.set(sessionKey, node)
    let left = false
    return () => {
      if (left) return
      left = true
      node.active = 0
      node.sealed = true
      this.notify()
    }
  }

  /** Signed HTTP requests are tracked even while their body/config is loading. */
  enterPending(parent: string): () => void {
    this.assertOpen(parent)
    const key = `taskboard-pending:${randomUUID()}`
    const node: Member = { parent, active: 1, sealed: false }
    this.members.set(key, node)
    let left = false
    return () => {
      if (left) return
      left = true
      this.members.delete(key)
      this.notify()
    }
  }

  recordResult(result: TaskboardExecutionResult): void {
    if (this.complete || !this.members.has(result.sessionKey)) throw new Error('taskboard result has no execution owner')
    if (result.sessionKey !== this.rootSessionKey) this.results.set(result.executionId, { ...result })
  }

  childResults(): readonly TaskboardExecutionResult[] { return [...this.results.values()] }

  requestStop(): boolean {
    if (this.complete || this.signal.aborted) return false
    this.controller.abort(new TaskboardCancelledError())
    return true
  }

  private hasDescendants(parent: string): boolean {
    for (const [key, node] of this.members) {
      if (!node.active || key === parent) continue
      let ancestor = node.parent
      const seen = new Set<string>()
      while (ancestor && !seen.has(ancestor)) {
        if (ancestor === parent) return true
        seen.add(ancestor)
        ancestor = this.members.get(ancestor)?.parent ?? null
      }
    }
    return false
  }

  /** Seal new direct admissions, then await every descendant's complete finally. */
  waitForDescendants(parent: string): Promise<void> {
    const member = this.members.get(parent)
    if (!member) throw new Error('unknown taskboard execution member')
    member.sealed = true
    if (!this.hasDescendants(parent)) return Promise.resolve()
    return new Promise((resolve) => this.waiters.add({ parent, resolve }))
  }

  private notify(): void {
    for (const waiter of this.waiters) {
      if (!this.hasDescendants(waiter.parent)) {
        this.waiters.delete(waiter)
        waiter.resolve()
      }
    }
  }

  finish(): void {
    if ([...this.members.values()].some((node) => node.active)) throw new Error('taskboard execution still has active promises')
    this.complete = true
    this.members.clear()
    this.results.clear()
    this.notify()
  }
}

type Binding = { control: TaskboardRunControl | null; closed: boolean }

export class TaskboardRunControls {
  private readonly sessions = new Map<string, Binding>()
  private readonly runs = new Map<string, TaskboardRunControl>()

  begin(runId: string, ticketId: string, leaseOwner: string, rootSessionKey: string): TaskboardRunControl {
    if (this.runs.has(runId) || this.sessions.has(rootSessionKey)) throw new Error('taskboard run control already exists')
    const binding: Binding = { control: null, closed: false }
    const control = new TaskboardRunControl(runId, ticketId, leaseOwner, rootSessionKey, (key) => {
      const previous = this.sessions.get(key)
      if (previous && previous !== binding) throw new Error('taskboard session already has another owner')
      this.sessions.set(key, binding)
    })
    binding.control = control
    this.runs.set(runId, control)
    return control
  }

  lookup(sessionKey: string): Readonly<Binding> | undefined { return this.sessions.get(sessionKey) }

  get(runId: string, ticketId: string, leaseOwner: string): TaskboardRunControl | undefined {
    const control = this.runs.get(runId)
    return control?.ticketId === ticketId && control.leaseOwner === leaseOwner ? control : undefined
  }

  finish(control: TaskboardRunControl): void {
    if (this.runs.get(control.runId) !== control) throw new Error('taskboard control belongs to another registry')
    control.finish()
    this.runs.delete(control.runId)
    const binding = this.sessions.get(control.rootSessionKey)
    if (!binding || binding.control !== control) return
    binding.control = null
    binding.closed = true
    // Retain only closed identity bindings until every issued context token has
    // expired. A late signed request can never turn into an unowned delegation.
    const timer = setTimeout(() => {
      for (const [key, current] of this.sessions) if (current === binding) this.sessions.delete(key)
    }, DELEGATE_CONTEXT_TTL_MS)
    timer.unref?.()
  }
}

export const taskboardRunControls = new TaskboardRunControls()
