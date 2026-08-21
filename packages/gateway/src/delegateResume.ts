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

export type DelegateResumeClaim = {
  ok: true
  sessionKey: string
  minted: boolean
  evictedKeys: string[]
}

export type DelegateResumeReject = {
  ok: false
  httpStatus: 400 | 409 | 503
  message: string
  evictedKeys: string[]
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

export class DelegateResumeRegistry {
  private readonly bindings = new Map<string, DelegateResumeBinding>()
  /** Occupancy fence: active = running, retiring = shutdown in progress. */
  private readonly reserved = new Map<string, 'active' | 'retiring'>()
  private readonly ttlMs: number
  private readonly maxBindings: number
  private readonly now: () => number
  private readonly nonce: () => string

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
  }): DelegateResumePreflight {
    const evictedKeys = this.pruneExpired()
    const parentSessionKey =
      typeof input.parentSessionKey === 'string' ? input.parentSessionKey : ''
    const sourceAgent = input.sourceAgent || 'system'
    const targetAgentId = input.targetAgentId
    const resumeKey = normalizeResumeSessionKey(input.resumeSessionKey)

    if (resumeKey) {
      const binding = this.bindings.get(resumeKey)
      if (!binding) {
        return {
          ok: false,
          httpStatus: 400,
          message: 'resumeSessionKey 无效或已过期',
          evictedKeys,
        }
      }
      if (
        binding.parentSessionKey !== parentSessionKey ||
        binding.targetAgentId !== targetAgentId ||
        binding.sourceAgent !== sourceAgent
      ) {
        return {
          ok: false,
          httpStatus: 400,
          message: 'resumeSessionKey 与当前父会话/目标 agent 不匹配',
          evictedKeys,
        }
      }
      if (this.reserved.has(resumeKey)) {
        return {
          ok: false,
          httpStatus: 409,
          message: '该委派会话仍在运行或正在收尾,请用 delegate-wait 等待,不要重复 resume',
          evictedKeys,
        }
      }
      this.reserved.set(resumeKey, 'active')
      binding.lastUsedAt = this.now()
      return { ok: true, sessionKey: resumeKey, minted: false, evictedKeys }
    }

    const capEvicted = this.evictOldestInactiveForCapacity()
    evictedKeys.push(...capEvicted)
    if (this.bindings.size >= this.maxBindings) {
      return {
        ok: false,
        httpStatus: 503,
        message: 'delegate resume 绑定已满且没有可驱逐的空闲项,请稍后重试',
        evictedKeys,
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
    return { ok: true, sessionKey, minted: true, evictedKeys }
  }

  markRetiring(sessionKey: string): void {
    if (this.reserved.has(sessionKey)) this.reserved.set(sessionKey, 'retiring')
  }

  /** Drop occupancy, keep the binding so a later turn can resume. */
  release(sessionKey: string): void {
    this.reserved.delete(sessionKey)
  }

  /**
   * Early reject after preflight: drop occupancy and, if this claim minted the
   * key, drop the binding so unused keys do not consume the cap.
   */
  abort(sessionKey: string, dropBinding: boolean): void {
    this.reserved.delete(sessionKey)
    if (dropBinding) this.bindings.delete(sessionKey)
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
      evicted.push(oldestKey)
    }
    return evicted
  }
}
