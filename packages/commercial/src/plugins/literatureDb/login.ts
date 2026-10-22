/** In-process login operation lifecycle; a restart expires operations, it never replays submits. */
import { randomUUID } from 'node:crypto'
import {
  type CaptchaBudget,
  type CaptchaImage,
  type LiteratureCaptchaSolver,
  captchaAnswer,
  normalizeCaptchaImage,
} from './captcha.js'
import { LiteratureError, type LiteratureErrorCode, abortable } from './errors.js'
import { LITERATURE_SITE } from './policy.js'

export type LoginOutcome =
  | 'authenticated'
  | 'captcha_invalid'
  | 'credentials_invalid'
  | 'blocked'
  | 'unknown'
export interface LiteratureLoginSession {
  challenge(signal: AbortSignal): Promise<CaptchaImage>
  submit(answer: string, signal: AbortSignal): Promise<LoginOutcome>
  probe(signal: AbortSignal): Promise<boolean>
  snapshot(signal: AbortSignal): Promise<unknown>
  close(): Promise<void>
}
export type LoginOwner =
  | { userId: number; accountId: string; kind?: 'account' }
  | { userId: number; kind: 'setup'; site: typeof LITERATURE_SITE }
export type OperationSolverFactory = (
  context: Readonly<{
    owner: Readonly<LoginOwner>
    operationId: string
  }>,
) => LiteratureCaptchaSolver

/** Entering the callback starts the save phase; cancellation thereafter waits for its result. */
export type LoginPersistenceContext = LoginOwner & {
  operationId: string
  signal: AbortSignal
  isCurrent(): boolean
}
export interface LiteratureLoginView {
  operationId: string
  status: 'running' | 'manual_required' | 'authenticated' | 'failed' | 'cancelled' | 'expired'
  automaticSubmissions: number
  challengeId?: string
  challengeExpiresAt?: number
  errorCode?: LiteratureErrorCode
}
interface Operation {
  owner: LoginOwner
  view: LiteratureLoginView
  controller: AbortController
  session?: LiteratureLoginSession
  opening?: Promise<LiteratureLoginSession>
  solving?: Promise<string>
  cleanupFailed?: boolean
  challenge?: { id: string; image: CaptchaImage; expiresAt: number }
  persist(state: unknown, context: LoginPersistenceContext): Promise<void>
  done: Promise<void>
  timer: ReturnType<typeof setTimeout>
  manualUsed: boolean
  closing?: Promise<void>
  sessionClosing?: Promise<void>
  completing?: Promise<void>
  finishedAt?: number
  expiresAt: number
}
export interface LiteratureLoginOptions {
  maxStartsPerHour?: number
  maxAutomaticSubmissions?: number
  maxCloudCalls?: number
  capacity?: number
  manualTtlMs?: number
  operationTtlMs?: number
  autoBudgetMs?: number
  now?: () => number
}
function loginOwner(input: LoginOwner): LoginOwner {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype)
    throw new LiteratureError('INVALID_INPUT')
  const descriptors = Object.getOwnPropertyDescriptors(input)
  if (
    Reflect.ownKeys(descriptors).some(
      (key) => typeof key !== 'string' || !('value' in descriptors[key]),
    )
  )
    throw new LiteratureError('INVALID_INPUT')
  const owner = Object.fromEntries(Object.entries(descriptors).map(([k, v]) => [k, v.value]))
  if (!Number.isSafeInteger(owner.userId) || owner.userId < 1)
    throw new LiteratureError('INVALID_INPUT')
  if (owner.kind === 'setup') {
    if (
      owner.site !== LITERATURE_SITE ||
      Object.keys(owner).sort().join(',') !== 'kind,site,userId'
    )
      throw new LiteratureError('INVALID_INPUT')
    return { userId: owner.userId, kind: 'setup', site: LITERATURE_SITE }
  }
  if (
    (owner.kind !== undefined && owner.kind !== 'account') ||
    typeof owner.accountId !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(owner.accountId) ||
    Object.keys(owner).some((key) => !['userId', 'accountId', 'kind'].includes(key))
  )
    throw new LiteratureError('INVALID_INPUT')
  return { userId: owner.userId, accountId: owner.accountId, kind: 'account' }
}
function ownerKey(owner: LoginOwner): string {
  return owner.kind === 'setup'
    ? `${owner.userId}:setup:${owner.site}`
    : `${owner.userId}:account:${owner.accountId}`
}
function bounded(value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new LiteratureError('INVALID_INPUT')
  return value
}
export class LiteratureLoginManager {
  private readonly operations = new Map<string, Operation>()
  private readonly accounts = new Set<string>()
  private readonly starts = new Map<string, number[]>()
  private readonly hourlyMaximum: number
  private readonly maximum: number
  private readonly cloudMaximum: number
  private readonly capacity: number
  private readonly manualTtl: number
  private readonly lifetime: number
  private readonly autoBudget: number
  private readonly now: () => number
  private closed = false
  constructor(
    private readonly createSolver: OperationSolverFactory,
    options: LiteratureLoginOptions = {},
  ) {
    this.hourlyMaximum = bounded(options.maxStartsPerHour ?? 6, 1, 60)
    this.maximum = bounded(options.maxAutomaticSubmissions ?? 4, 1, 4)
    this.cloudMaximum = bounded(options.maxCloudCalls ?? 2, 0, 4)
    this.capacity = bounded(options.capacity ?? 16, 1, 64)
    this.manualTtl = bounded(options.manualTtlMs ?? 120_000, 1, 300_000)
    this.lifetime = bounded(options.operationTtlMs ?? 300_000, 1, 600_000)
    this.autoBudget = bounded(options.autoBudgetMs ?? 60_000, 1, 60_000)
    this.now = options.now ?? Date.now
  }
  start(
    owner: LoginOwner,
    open: (signal: AbortSignal) => Promise<LiteratureLoginSession>,
    persist: Operation['persist'],
  ): LiteratureLoginView {
    owner = loginOwner(owner)
    const key = ownerKey(owner)
    if (this.closed) throw new LiteratureError('CANCELLED')
    for (const [id, op] of this.operations) {
      if (op.finishedAt !== undefined && this.now() - op.finishedAt >= 120_000)
        this.operations.delete(id)
    }
    if (this.accounts.has(key)) throw new LiteratureError('ACCOUNT_BUSY')
    if (this.accounts.size >= this.capacity || this.operations.size >= 256)
      throw new LiteratureError('CAPACITY')
    for (const [account, history] of this.starts) {
      const recent = history.filter((time) => this.now() - time < 3_600_000)
      if (recent.length) this.starts.set(account, recent)
      else this.starts.delete(account)
    }
    const starts = this.starts.get(key) ?? []
    if (starts.length >= this.hourlyMaximum) throw new LiteratureError('RATE_LIMITED')
    if (!this.starts.has(key) && this.starts.size >= 4096) throw new LiteratureError('CAPACITY')
    this.starts.set(key, [...starts, this.now()])
    const id = randomUUID()
    const op: Operation = {
      owner: { ...owner },
      view: { operationId: id, status: 'running', automaticSubmissions: 0 },
      controller: new AbortController(),
      persist,
      done: Promise.resolve(),
      timer: setTimeout(() => {
        void this.expire(op)
      }, this.lifetime),
      manualUsed: false,
      expiresAt: this.now() + this.lifetime,
    }
    this.operations.set(id, op)
    this.accounts.add(key)
    op.done = this.run(op, open).catch(async (error) => {
      await this.fail(
        op,
        error instanceof LiteratureError && error.code === 'CLEANUP_FAILED'
          ? 'CLEANUP_FAILED'
          : 'LOGIN_FAILED',
      )
    })
    return this.view(op)
  }
  private get(userId: number, id: string): Operation {
    const op = this.operations.get(id)
    if (!op || op.owner.userId !== userId) throw new LiteratureError('NOT_FOUND')
    return op
  }
  private view(op: Operation): LiteratureLoginView {
    return { ...op.view }
  }
  status(userId: number, id: string): LiteratureLoginView {
    return this.view(this.get(userId, id))
  }
  async settled(userId: number, id: string): Promise<LiteratureLoginView> {
    const op = this.get(userId, id)
    await op.done
    return this.view(op)
  }
  private current(op: Operation): boolean {
    return !op.controller.signal.aborted && ['running', 'manual_required'].includes(op.view.status)
  }
  private async run(
    op: Operation,
    open: (signal: AbortSignal) => Promise<LiteratureLoginSession>,
  ): Promise<void> {
    const signal = op.controller.signal
    // Preserve a cancellation boundary before constructing any per-owner readers.
    await Promise.resolve()
    if (!this.current(op)) return
    if (this.now() >= op.expiresAt) {
      await this.expire(op)
      return
    }
    const solver = this.createSolver(
      Object.freeze({
        owner: Object.freeze({ ...op.owner }),
        operationId: op.view.operationId,
      }),
    )
    if (!this.current(op)) return
    if (this.now() >= op.expiresAt) {
      await this.expire(op)
      return
    }
    // Publish every returned handle before checking cancellation. The one closing
    // barrier below owns cleanup, including late openers and cleanup failures.
    const opening = Promise.resolve()
      .then(() => open(signal))
      .then((session) => {
        op.session = session
        if (signal.aborted) throw new LiteratureError('CANCELLED')
        return session
      })
    op.opening = opening
    const session = await abortable(opening, signal)
    const deadline = this.now() + this.autoBudget
    const automatic = new AbortController()
    const stopAutomatic = () => automatic.abort()
    signal.addEventListener('abort', stopAutomatic, { once: true })
    const timer = setTimeout(stopAutomatic, this.autoBudget)
    const budget: CaptchaBudget = {
      cloudCalls: 0,
      maxCloudCalls: this.cloudMaximum,
    }
    try {
      for (let i = 0; i < this.maximum && this.now() < deadline; i++) {
        let answer: string
        try {
          const image = await abortable(session.challenge(automatic.signal), automatic.signal)
          const solving = solver.solve(image, budget, automatic.signal)
          op.solving = solving
          try {
            answer = await solving
          } finally {
            if (op.solving === solving) op.solving = undefined
          }
        } catch (error) {
          if (error instanceof LiteratureError && error.code === 'CLEANUP_FAILED') {
            // Latch in this same continuation, before run.catch or cancel can race.
            op.cleanupFailed = true
            throw error
          }
          if (!this.current(op)) return
          if (
            automatic.signal.aborted ||
            (error instanceof LiteratureError && error.code === 'MODEL_UNAVAILABLE')
          )
            break
          throw error
        }
        if (!this.current(op) || this.now() >= deadline) break
        op.view.automaticSubmissions++
        const result = await this.submit(op, answer, automatic.signal)
        if (await this.handle(op, result)) return
      }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', stopAutomatic)
    }
    if (this.current(op)) await this.manual(op)
  }
  private async submit(
    op: Operation,
    answer: string,
    signal: AbortSignal = op.controller.signal,
  ): Promise<LoginOutcome> {
    try {
      return await abortable(op.session!.submit(answer, signal), signal)
    } catch {
      if (!this.current(op)) throw new LiteratureError('CANCELLED')
      return 'unknown'
    }
  }
  private async handle(op: Operation, outcome: LoginOutcome): Promise<boolean> {
    if (!this.current(op)) return true
    if (outcome === 'unknown') {
      // A POST may have reached the site. Probe once, never blindly submit it again.
      let authenticated = false
      try {
        authenticated = await abortable(
          op.session!.probe(op.controller.signal),
          op.controller.signal,
        )
      } catch {
        /* An unverifiable outcome remains unknown. */
      }
      if (!this.current(op)) return true
      if (!authenticated) {
        await this.fail(op, 'SUBMISSION_UNCERTAIN')
        return true
      }
      outcome = 'authenticated'
    }
    if (outcome === 'authenticated') {
      const signal = op.controller.signal
      const state = await abortable(op.session!.snapshot(signal), signal)
      if (!this.current(op)) return true
      await this.closeSession(op)
      if (!this.current(op)) return true
      if (this.now() >= op.expiresAt) {
        await this.expire(op)
        return true
      }
      clearTimeout(op.timer)
      // Publish the cancellation barrier before invoking the persistence callback.
      // AbortSignal cannot undo a COMMIT that the callback may already have sent.
      op.completing = Promise.resolve().then(async () => {
        try {
          await op.persist(state, {
            ...op.owner,
            operationId: op.view.operationId,
            signal,
            isCurrent: () => this.current(op),
          })
          await this.finish(op, 'authenticated')
        } catch {
          await this.fail(op, 'PERSISTENCE_UNCERTAIN')
        }
      })
      await op.completing
      return true
    }
    if (outcome === 'credentials_invalid') {
      await this.fail(op, 'CREDENTIALS_INVALID')
      return true
    }
    if (outcome === 'blocked') {
      await this.fail(op, 'UPSTREAM_BLOCKED')
      return true
    }
    if (outcome !== 'captcha_invalid') {
      await this.fail(op, 'LOGIN_FAILED')
      return true
    }
    return false
  }
  private async manual(op: Operation): Promise<void> {
    if (this.now() >= op.expiresAt) {
      await this.expire(op)
      return
    }
    const signal = op.controller.signal
    const image = await abortable(
      normalizeCaptchaImage(await abortable(op.session!.challenge(signal), signal)),
      signal,
    )
    if (!this.current(op)) return
    const id = randomUUID()
    const expiresAt = Math.min(op.expiresAt, this.now() + this.manualTtl)
    op.challenge = { id, image, expiresAt }
    op.view = {
      operationId: op.view.operationId,
      status: 'manual_required',
      automaticSubmissions: op.view.automaticSubmissions,
      challengeId: id,
      challengeExpiresAt: expiresAt,
    }
    clearTimeout(op.timer)
    op.timer = setTimeout(
      () => {
        void this.expire(op)
      },
      Math.max(1, expiresAt - this.now()),
    )
  }
  image(userId: number, id: string, challengeId: string): CaptchaImage {
    const op = this.get(userId, id)
    if (
      op.view.status !== 'manual_required' ||
      op.challenge?.id !== challengeId ||
      this.now() >= op.challenge.expiresAt
    )
      throw new LiteratureError('CHALLENGE_STALE')
    return {
      mediaType: op.challenge.image.mediaType,
      data: Buffer.from(op.challenge.image.data),
    }
  }
  answer(
    userId: number,
    id: string,
    challengeId: string,
    value: string,
  ): Promise<LiteratureLoginView> {
    const answer = captchaAnswer(value)
    const op = this.get(userId, id)
    this.image(userId, id, challengeId) // Owner, current challenge and expiry check before consumption.
    if (op.manualUsed) throw new LiteratureError('CHALLENGE_STALE')
    op.manualUsed = true
    op.challenge = undefined
    op.view = {
      operationId: id,
      status: 'running',
      automaticSubmissions: op.view.automaticSubmissions,
    }
    op.done = (async () => {
      const handled = await this.handle(op, await this.submit(op, answer))
      if (!handled && this.current(op)) await this.fail(op, 'LOGIN_FAILED')
    })().catch(async () => {
      await this.fail(op, 'LOGIN_FAILED')
    })
    return this.settled(userId, id)
  }
  private closeSession(op: Operation): Promise<void> {
    return (op.sessionClosing ??= Promise.resolve().then(() => op.session?.close()))
  }
  private async finish(
    op: Operation,
    status: LiteratureLoginView['status'],
    errorCode?: LiteratureErrorCode,
  ): Promise<void> {
    if (op.closing) {
      await op.closing
      return
    }
    clearTimeout(op.timer)
    op.challenge = undefined
    const solving = op.solving
    op.controller.abort()
    op.view = {
      operationId: op.view.operationId,
      status: status === 'authenticated' ? 'running' : status,
      automaticSubmissions: op.view.automaticSubmissions,
      ...(errorCode ? { errorCode } : {}),
    }
    op.closing = (async () => {
      try {
        if (op.opening) {
          try {
            await op.opening
          } catch {
            /* Any returned handle is still closed below. */
          }
        }
        const drained = await Promise.allSettled([
          this.closeSession(op),
          solving ?? Promise.resolve(),
        ])
        if (
          op.cleanupFailed ||
          drained.some(
            (result, index) =>
              result.status === 'rejected' &&
              (index === 0 ||
                (result.reason instanceof LiteratureError &&
                  result.reason.code === 'CLEANUP_FAILED')),
          )
        )
          throw new LiteratureError('CLEANUP_FAILED')
        if (status === 'authenticated') op.view.status = 'authenticated'
      } catch {
        op.view.status = 'failed'
        op.view.errorCode = 'CLEANUP_FAILED'
      } finally {
        if (op.view.errorCode !== 'CLEANUP_FAILED') {
          this.accounts.delete(ownerKey(op.owner))
          op.finishedAt = this.now()
        }
      }
    })()
    await op.closing
  }
  private async fail(op: Operation, code: LiteratureErrorCode): Promise<void> {
    if (!op.closing) await this.finish(op, 'failed', code)
  }
  private async expire(op: Operation): Promise<void> {
    if (op.completing) {
      await op.completing
      return
    }
    await this.finish(op, 'expired', 'TIMEOUT')
  }
  async cancel(userId: number, id: string): Promise<LiteratureLoginView> {
    const op = this.get(userId, id)
    if (op.completing) await op.completing
    else if (op.closing) await op.closing
    else if (this.current(op)) await this.finish(op, 'cancelled', 'CANCELLED')
    return this.view(op)
  }
  async close(): Promise<void> {
    this.closed = true
    await Promise.all(
      [...this.operations.values()].map(
        (op) =>
          op.completing ??
          op.closing ??
          (this.current(op) ? this.finish(op, 'cancelled', 'CANCELLED') : Promise.resolve()),
      ),
    )
    if ([...this.operations.values()].some((op) => op.view.errorCode === 'CLEANUP_FAILED'))
      throw new LiteratureError('CLEANUP_FAILED')
  }
}
