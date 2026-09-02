/**
 * Optional resume for HTTP/MCP `delegate_task`.
 *
 * Default remains one-shot: omitting `resumeSessionKey` mints a new key.
 * Resume is allowed only for keys this process minted and bound to the same
 * (parentSessionKey, targetAgentId, sourceAgent) tuple. Occupancy is a
 * synchronous check-and-add so a second in-flight resume 409s before any
 * await. Taskboard's internal `input.sessionKey` is never registered here.
 */
import { randomBytes } from 'node:crypto'

export const DEFAULT_DELEGATE_RESUME_TTL_MS = 7 * 24 * 60 * 60_000
export const DEFAULT_DELEGATE_RESUME_MAX_BINDINGS = 256

export type DelegateResumeBinding = {
  sessionKey: string
  parentSessionKey: string
  targetAgentId: string
  sourceAgent: string
  createdAt: number
  lastUsedAt: number
}

export const DELEGATE_RESUME_OCCUPIED_MESSAGE =
  '该委派会话仍在运行或正在收尾,请用 delegate-wait 等待,不要重复 resume'

export type DelegateResumeClaim = {
  ok: true
  sessionKey: string
  minted: boolean
  evictedKeys: string[]
  /** False on idempotent replay: caller must not spawn a second child. */
  dispatchGranted: boolean
  replay: boolean
  /** Bound job for an in-flight replay; never an older session sibling. */
  jobId?: string
}

export type DelegateResumeReject = {
  ok: false
  httpStatus: 400 | 409 | 503
  message: string
  evictedKeys: string[]
  dispatchGranted: false
  replay: boolean
}

export type DelegateResumePreflight = DelegateResumeClaim | DelegateResumeReject

export type DelegateResumeRegistryOptions = {
  ttlMs?: number
  maxBindings?: number
  now?: () => number
  nonce?: () => string
}

export function mintDelegateSessionKey(
  targetAgentId: string,
  sourceAgent: string,
  now: number,
  nonce: string,
): string {
  return `agent:${targetAgentId}:delegate:${sourceAgent}:${now}:${nonce}`
}

export function normalizeResumeSessionKey(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function defaultNonce(): string {
  return randomBytes(8).toString('hex')
}

function attemptId(sessionKey: string, idempotencyKey: string): string {
  return `${sessionKey}\0${idempotencyKey}`
}

const DEFAULT_ATTEMPT_TTL_MS = 2 * 60 * 60_000
const DEFAULT_MAX_ATTEMPTS = 256

type ResumeAttempt = {
  sessionKey: string
  idempotencyKey: string
  jobId?: string
  createdAt: number
}

export class DelegateResumeRegistry {
  private readonly bindings = new Map<string, DelegateResumeBinding>()
  /** Occupancy fence: active = running, retiring = shutdown in progress. */
  private readonly reserved = new Map<string, 'active' | 'retiring'>()
  /**
   * In-flight accepted requests only. Occupancy 409 is never cached, so a
   * later legal retry after release can dispatch. Bound to an exact jobId.
   */
  private readonly attempts = new Map<string, ResumeAttempt>()
  private readonly ttlMs: number
  private readonly maxBindings: number
  private readonly now: () => number
  private readonly nonce: () => string
  /** Test hook: increments only when occupancy is newly granted. */
  dispatchGrants = 0

  constructor(opts: DelegateResumeRegistryOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_DELEGATE_RESUME_TTL_MS
    this.maxBindings = opts.maxBindings ?? DEFAULT_DELEGATE_RESUME_MAX_BINDINGS
    this.now = opts.now ?? Date.now
    this.nonce = opts.nonce ?? defaultNonce
  }

  /**
   * Synchronous mint-or-resume. Must run before any await and before creating
   * an async job handle so running responses already carry the authoritative key.
   */
  preflight(input: {
    resumeSessionKey?: string
    parentSessionKey?: string
    targetAgentId: string
    sourceAgent: string
    /** Client/request idempotency key. Same key + same resume session never dispatches twice. */
    idempotencyKey?: string
  }): DelegateResumePreflight {
    const evictedKeys = this.pruneExpired()
    const parentSessionKey =
      typeof input.parentSessionKey === 'string' ? input.parentSessionKey : ''
    const sourceAgent = input.sourceAgent || 'system'
    const targetAgentId = input.targetAgentId
    const resumeKey = normalizeResumeSessionKey(input.resumeSessionKey)
    const idempotencyKey = normalizeResumeSessionKey(input.idempotencyKey)

    this.pruneAttempts()
    if (resumeKey && idempotencyKey) {
      const existing = this.attempts.get(attemptId(resumeKey, idempotencyKey))
      if (existing && this.reserved.has(resumeKey)) {
        return {
          ok: true,
          sessionKey: resumeKey,
          minted: false,
          evictedKeys,
          dispatchGranted: false,
          replay: true,
          jobId: existing.jobId,
        }
      }
      if (existing && !this.reserved.has(resumeKey)) {
        this.attempts.delete(attemptId(resumeKey, idempotencyKey))
      }
    }

    if (resumeKey) {
      const binding = this.bindings.get(resumeKey)
      if (!binding) {
        return this.reject(resumeKey, idempotencyKey, 400, 'resumeSessionKey 无效或已过期', evictedKeys)
      }
      if (
        binding.parentSessionKey !== parentSessionKey ||
        binding.targetAgentId !== targetAgentId ||
        binding.sourceAgent !== sourceAgent
      ) {
        return this.reject(
          resumeKey,
          idempotencyKey,
          400,
          'resumeSessionKey 与当前父会话/目标 agent 不匹配',
          evictedKeys,
        )
      }
      if (this.reserved.has(resumeKey)) {
        return this.reject(resumeKey, idempotencyKey, 409, DELEGATE_RESUME_OCCUPIED_MESSAGE, evictedKeys)
      }
      this.reserved.set(resumeKey, 'active')
      binding.lastUsedAt = this.now()
      this.grantDispatch(resumeKey, idempotencyKey)
      return {
        ok: true,
        sessionKey: resumeKey,
        minted: false,
        evictedKeys,
        dispatchGranted: true,
        replay: false,
      }
    }

    const capEvicted = this.evictOldestInactiveForCapacity()
    evictedKeys.push(...capEvicted)
    if (this.bindings.size >= this.maxBindings) {
      return {
        ok: false,
        httpStatus: 503,
        message: 'delegate resume 绑定已满且没有可驱逐的空闲项,请稍后重试',
        evictedKeys,
        dispatchGranted: false,
        replay: false,
      }
    }

    let sessionKey = mintDelegateSessionKey(
      targetAgentId,
      sourceAgent,
      this.now(),
      this.nonce(),
    )
    while (this.bindings.has(sessionKey) || this.reserved.has(sessionKey)) {
      sessionKey = mintDelegateSessionKey(
        targetAgentId,
        sourceAgent,
        this.now(),
        this.nonce(),
      )
    }
    const ts = this.now()
    this.bindings.set(sessionKey, {
      sessionKey,
      parentSessionKey,
      targetAgentId,
      sourceAgent,
      createdAt: ts,
      lastUsedAt: ts,
    })
    this.reserved.set(sessionKey, 'active')
    this.grantDispatch(sessionKey, idempotencyKey)
    return {
      ok: true,
      sessionKey,
      minted: true,
      evictedKeys,
      dispatchGranted: true,
      replay: false,
    }
  }

  private reject(
    _sessionKey: string,
    _idempotencyKey: string | undefined,
    httpStatus: 400 | 409 | 503,
    message: string,
    evictedKeys: string[],
  ): DelegateResumeReject {
    // Occupancy/validation rejects are not cached: a later legal retry after
    // release or a corrected request must not be permanently 409'd.
    return { ok: false, httpStatus, message, evictedKeys, dispatchGranted: false, replay: false }
  }

  private grantDispatch(sessionKey: string, idempotencyKey: string | undefined): void {
    this.dispatchGrants += 1
    if (!idempotencyKey) return
    this.evictAttemptsForCapacity()
    this.attempts.set(attemptId(sessionKey, idempotencyKey), {
      sessionKey,
      idempotencyKey,
      createdAt: this.now(),
    })
  }

  /**
   * Stage 1: rehydrate occupancy after a durable restart. Does not increment
   * dispatchGrants (that counter is process-local).
   */
  restoreInFlight(input: {
    sessionKey: string
    parentSessionKey: string
    targetAgentId: string
    sourceAgent: string
    jobId: string
    idempotencyKey?: string
  }): void {
    const ts = this.now()
    const existing = this.bindings.get(input.sessionKey)
    if (!existing) {
      this.bindings.set(input.sessionKey, {
        sessionKey: input.sessionKey,
        parentSessionKey: input.parentSessionKey,
        targetAgentId: input.targetAgentId,
        sourceAgent: input.sourceAgent,
        createdAt: ts,
        lastUsedAt: ts,
      })
    } else {
      existing.lastUsedAt = ts
    }
    this.reserved.set(input.sessionKey, 'active')
    this.bindJob(input.sessionKey, input.idempotencyKey, input.jobId)
  }

  bindJob(sessionKey: string, idempotencyKey: string | undefined, jobId: string): void {
    if (!idempotencyKey) return
    const id = attemptId(sessionKey, idempotencyKey)
    const existing = this.attempts.get(id)
    if (existing) existing.jobId = jobId
    else {
      this.attempts.set(id, {
        sessionKey,
        idempotencyKey,
        jobId,
        createdAt: this.now(),
      })
    }
  }

  markRetiring(sessionKey: string): void {
    if (this.reserved.has(sessionKey)) this.reserved.set(sessionKey, 'retiring')
  }

  /** Drop occupancy, keep the binding so a later turn can resume. */
  release(sessionKey: string): void {
    this.reserved.delete(sessionKey)
    this.clearAttemptsForSession(sessionKey)
  }

  /**
   * Early reject after preflight: drop occupancy and, if this claim minted the
   * key, drop the binding so unused keys do not consume the cap.
   */
  abort(sessionKey: string, dropBinding: boolean): void {
    this.reserved.delete(sessionKey)
    this.clearAttemptsForSession(sessionKey)
    if (dropBinding) this.bindings.delete(sessionKey)
  }

  private clearAttemptsForSession(sessionKey: string): void {
    for (const [key, attempt] of this.attempts) {
      if (attempt.sessionKey === sessionKey) this.attempts.delete(key)
    }
  }

  private pruneAttempts(now = this.now()): void {
    for (const [key, attempt] of this.attempts) {
      if (this.reserved.has(attempt.sessionKey)) continue
      if (now - attempt.createdAt <= DEFAULT_ATTEMPT_TTL_MS) continue
      this.attempts.delete(key)
    }
  }

  private evictAttemptsForCapacity(): void {
    while (this.attempts.size >= DEFAULT_MAX_ATTEMPTS) {
      let oldestKey: string | undefined
      let oldestAt = Infinity
      for (const [key, attempt] of this.attempts) {
        if (this.reserved.has(attempt.sessionKey)) continue
        if (attempt.createdAt < oldestAt) {
          oldestAt = attempt.createdAt
          oldestKey = key
        }
      }
      if (!oldestKey) break
      this.attempts.delete(oldestKey)
    }
  }

  get(sessionKey: string): DelegateResumeBinding | undefined {
    return this.bindings.get(sessionKey)
  }

  isReserved(sessionKey: string): boolean {
    return this.reserved.has(sessionKey)
  }

  size(): number {
    return this.bindings.size
  }

  reservedSize(): number {
    return this.reserved.size
  }

  pruneExpired(now = this.now()): string[] {
    const evicted: string[] = []
    for (const [key, binding] of this.bindings) {
      if (this.reserved.has(key)) continue
      if (now - binding.lastUsedAt <= this.ttlMs) continue
      this.bindings.delete(key)
      this.clearAttemptsForSession(key)
      evicted.push(key)
    }
    return evicted
  }

  private evictOldestInactiveForCapacity(): string[] {
    const evicted: string[] = []
    while (this.bindings.size >= this.maxBindings) {
      let oldestKey: string | undefined
      let oldestAt = Infinity
      for (const [key, binding] of this.bindings) {
        if (this.reserved.has(key)) continue
        if (binding.lastUsedAt < oldestAt) {
          oldestAt = binding.lastUsedAt
          oldestKey = key
        }
      }
      if (!oldestKey) break
      this.bindings.delete(oldestKey)
      this.clearAttemptsForSession(oldestKey)
      evicted.push(oldestKey)
    }
    return evicted
  }
}
