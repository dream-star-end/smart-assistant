/**
 * OCV5-22 R0/R1 EngineNotifier: pick InlinePush vs ResumeInject from the
 * parent-engine capability matrix. Completer still owns callback_state.
 * Notifier must not mint a second message id or a parallel failure_class.
 */
import {
  delegateNotifyId,
  isDelegateParentEngine,
  type DelegateFailureClass,
  type EngineNotifier,
  type JobTerminal,
  type NotifyLane,
  type NotifyResult,
} from '@openclaude/protocol'
import { ccbStdinUserContent } from './ccbNativeCompaction.js'
import { isDelegateInlinePushEnabled } from './delegateSmFlag.js'
import type { ParentTapeIngestState } from './delegateNotifyTape.js'
import { isHeartbeatSilentOutput, laneForCallback } from './jobTerminal.js'

/** Prefer not-lose: after this window of only-unknown tape reads, send B once. */
export const TAPE_ORACLE_UNKNOWN_HOLD_MS = 60_000

export type InlinePushWriteResult = {
  ok: boolean
  processAlive: boolean
  /** Chunk may still be in the kernel buffer; do not start B this generation. */
  unknown?: boolean
}

export type InlinePushPort = {
  write(event: JobTerminal): Promise<InlinePushWriteResult>
}

export type ResumeInjectPort = {
  inject(event: JobTerminal): Promise<{
    ok: boolean
    failureClass?: DelegateFailureClass
    busy?: boolean
    gone?: boolean
  }>
}

export type NotifySample = {
  jobId: string
  notifyId: string
  lane: NotifyLane
  ok: boolean
  degraded: boolean
  latencyMs: number
}

export type EngineNotifierOptions = {
  inlinePush?: InlinePushPort
  resumeInject: ResumeInjectPort
  isAlreadyDelivered?: (notifyId: string) => boolean
  markDelivered?: (notifyId: string) => void
  onSample?: (sample: NotifySample) => void
  now?: () => number
  /** Cursor/Grok/zcode: missing nativeId is transport (no silent empty chat). */
  requireNativeId?: boolean
  /**
   * Parent-session tape ingest oracle. `not_ingested` after a complete
   * authoritative read (including "session missing/deleted"). Query
   * failures and missing lookup identity stay `unknown`.
   */
  parentTapeIngestState?: (
    notifyId: string,
    event: JobTerminal,
  ) => ParentTapeIngestState | Promise<ParentTapeIngestState>
}

/** Per-notify claim fence attached by dispatchJobTerminalNotify. */
export const NOTIFY_CLAIM_FENCE = Symbol.for('openclaude.notifyClaimFence')

export type NotifyClaimFence = {
  isLive: () => boolean
  ackDelivered: () => boolean
  markAAttempted?: () => boolean
  hasAAttempted?: () => boolean
  /** Durable a_attempted stamp; unknown tape holds until this + TAPE_ORACLE_UNKNOWN_HOLD_MS. */
  aAttemptedAt?: () => number | undefined
}

export type InlinePushRuntime = {
  /** Live BeginCutover / recycle drain freeze — not the CUTOVER feature flag. */
  isCutoverWindowActive?: () => boolean
}

export class DefaultEngineNotifier implements EngineNotifier {
  private readonly delivered = new Set<string>()
  private readonly unknownSince = new Map<string, number>()
  private readonly opts: EngineNotifierOptions
  private readonly now: () => number

  constructor(opts: EngineNotifierOptions) {
    this.opts = opts
    this.now = opts.now ?? Date.now
  }

  async notify(event: JobTerminal): Promise<NotifyResult> {
    const committed = event.terminalCommittedAt
    const t0 = typeof committed === 'number' && committed > 0 ? committed : this.now()
    const notifyId = delegateNotifyId(event.jobId, event.callbackEpoch)
    const finish = (result: NotifyResult, degraded = false): NotifyResult => {
      const lane = result.ok ? result.lane : (result.degradedTo ?? classifySafe(event))
      this.opts.onSample?.({
        jobId: event.jobId,
        notifyId,
        lane,
        ok: result.ok,
        degraded,
        latencyMs: Math.max(0, this.now() - t0),
      })
      return result
    }

    if (this.opts.isAlreadyDelivered?.(notifyId) || this.delivered.has(notifyId)) {
      return finish({ ok: true, lane: classifySafe(event), notifyId })
    }

    if (event.callback === 'none' || isHeartbeatSilentOutput(event.resultRef)) {
      this.mark(notifyId)
      return finish({ ok: true, lane: 'skipped_silent', notifyId })
    }

    if (event.callback === 'stdout-wait') {
      this.mark(notifyId)
      return finish({ ok: true, lane: 'stdout-wait', notifyId })
    }

    if (!isDelegateParentEngine(event.parentEngine)) {
      return finish({ ok: false, failureClass: 'internal' })
    }

    const preferred = laneForCallback(event.callback, event.parentEngine)
    if (preferred === 'inline-push') {
      const pushed = await this.tryInlinePush(event)
      if (pushed === 'delivered') {
        this.mark(notifyId)
        return finish({ ok: true, lane: 'inline-push', notifyId })
      }
      if (pushed === 'hold') {
        // a_attempted with unknown consumption: do not B this generation.
        // Reclaim + tape ingest decide. Dispatch must leave the claim injecting.
        return finish({
          ok: false,
          failureClass: 'transport',
          degradedTo: 'resume-inject',
          hold: true,
        }, true)
      }
      const injected = await this.tryResumeInject(event)
      if (injected.ok) {
        this.mark(notifyId)
        return finish({ ok: true, lane: 'resume-inject', notifyId }, true)
      }
      return finish({
        ok: false,
        failureClass: injected.failureClass ?? 'transport',
        degradedTo: 'resume-inject',
      }, true)
    }

    if (this.opts.requireNativeId && !event.parentNativeId) {
      return finish({ ok: false, failureClass: 'transport' })
    }
    const injected = await this.tryResumeInject(event)
    if (injected.ok) {
      this.mark(notifyId)
      return finish({ ok: true, lane: 'resume-inject', notifyId })
    }
    return finish({ ok: false, failureClass: injected.failureClass ?? 'transport' })
  }

  private mark(notifyId: string): void {
    this.delivered.add(notifyId)
    this.opts.markDelivered?.(notifyId)
  }

  private async tapeIngest(event: JobTerminal, notifyId: string): Promise<ParentTapeIngestState> {
    const oracle = this.opts.parentTapeIngestState
    if (!oracle) return 'not_ingested'
    try {
      const state = await oracle(notifyId, event)
      if (state === 'ingested' || state === 'not_ingested' || state === 'unknown') return state
      return 'unknown'
    } catch {
      return 'unknown'
    }
  }

  /** First unknown always holds; later unknowns hold until a_attempted + window. */
  private unknownShouldHold(fence: NotifyClaimFence | undefined, notifyId: string): boolean {
    const t = this.now()
    const stamped = fence?.aAttemptedAt?.()
    if (typeof stamped === 'number' && stamped > 0) {
      return t - stamped < TAPE_ORACLE_UNKNOWN_HOLD_MS
    }
    // Durable a_attempted exists but this process cannot read the stamp
    // (restart dropped unknownSince; snapshot miss). Prefer not-lose: B.
    if (fence?.hasAAttempted?.()) return false
    const origin = this.unknownSince.get(notifyId)
    if (origin == null) {
      this.unknownSince.set(notifyId, t)
      return true
    }
    return t - origin < TAPE_ORACLE_UNKNOWN_HOLD_MS
  }

  private async decideFromTape(
    event: JobTerminal,
    notifyId: string,
    fence: NotifyClaimFence | undefined,
    absent: 'degrade' | 'hold',
  ): Promise<'delivered' | 'degrade' | 'hold'> {
    const state = await this.tapeIngest(event, notifyId)
    if (state === 'ingested') {
      this.ackDeliveredQuiet(fence)
      this.unknownSince.delete(notifyId)
      return 'delivered'
    }
    if (state === 'unknown') {
      return this.unknownShouldHold(fence, notifyId) ? 'hold' : 'degrade'
    }
    this.unknownSince.delete(notifyId)
    return absent
  }

  private ackDeliveredQuiet(fence: NotifyClaimFence | undefined): void {
    if (!fence) return
    try {
      fence.ackDelivered()
    } catch {
      /* stale token or durable write failed; dispatch retries complete */
    }
  }

  /**
   * InlinePush outcomes:
   * - delivered: A consumed (write+alive receipt, or tape ingest)
   * - degrade: A failed; caller may send B with the same notifyId
   * - hold: a_attempted, consumption unknown; do not B this generation
   */
  private async tryInlinePush(event: JobTerminal): Promise<'delivered' | 'degrade' | 'hold'> {
    if (!this.opts.inlinePush) return 'degrade'
    const fence = notifyClaimFenceOf(event)
    const notifyId = delegateNotifyId(event.jobId, event.callbackEpoch)
    try {
      if (fence && !fence.isLive()) return 'degrade'
      if (fence?.hasAAttempted?.()) {
        // Reclaim: never rewrite stdin. B iff a complete tape read shows absence.
        return this.decideFromTape(event, notifyId, fence, 'degrade')
      }
      if (fence?.markAAttempted) {
        if (!fence.markAAttempted()) return 'degrade'
      }
      if (fence && !fence.isLive()) return 'degrade'
      const result = await this.opts.inlinePush.write(event)
      if (fence && !fence.isLive()) {
        this.ackDeliveredQuiet(fence)
        // Another owner reclaimed. Never start B from this generation.
        return 'delivered'
      }
      if (result?.unknown) {
        // Process may still be alive: absence is not proof yet. Unknown tape holds.
        return this.decideFromTape(event, notifyId, fence, 'hold')
      }
      if (!result?.ok || !result.processAlive) {
        // stdin dies with the process. B only after a complete tape absence read.
        return this.decideFromTape(event, notifyId, fence, 'degrade')
      }
      this.ackDeliveredQuiet(fence)
      return 'delivered'
    } catch {
      if (fence?.hasAAttempted?.()) {
        // Write threw after a_attempted: consumption unknown. Hold unless ingested
        // or the unknown window has elapsed (prefer not-lose → B).
        return this.decideFromTape(event, notifyId, fence, 'hold')
      }
      return 'degrade'
    }
  }

  private async tryResumeInject(event: JobTerminal): Promise<{
    ok: boolean
    failureClass?: DelegateFailureClass
  }> {
    try {
      const result = await this.opts.resumeInject.inject(event)
      if (result.ok) return { ok: true }
      if (result.gone) return { ok: false, failureClass: result.failureClass ?? 'transport' }
      if (result.busy) return { ok: false, failureClass: result.failureClass ?? 'internal' }
      return { ok: false, failureClass: result.failureClass ?? 'transport' }
    } catch {
      return { ok: false, failureClass: 'transport' }
    }
  }
}

function classifySafe(event: JobTerminal): NotifyLane {
  return laneForCallback(
    event.callback,
    isDelegateParentEngine(event.parentEngine) ? event.parentEngine : undefined,
  )
}

export type InlinePushSession = {
  _activeTurnCount?: number
  _activeClientTurnCount?: number
  runner?: {
    engineId?: string
    isRunning?: boolean
    writeDelegateTerminal?: (
      event: JobTerminal,
      body: string,
    ) => Promise<InlinePushWriteResult>
    writeRaw?: (line: string) => void | Promise<void>
    proc?: {
      killed?: boolean
      exitCode?: number | null
      stdin?: { writable?: boolean; write: (chunk: string, cb?: (err?: Error | null) => void) => boolean }
    }
  }
}

/** Official CCB stdin user JSONL (same shape as SubprocessRunner.submit). */
export function buildCcbInlinePushUserLine(body: string): string {
  const userMsg = {
    type: 'user',
    message: {
      role: 'user',
      content: ccbStdinUserContent(body),
    },
    parent_tool_use_id: null,
  }
  return `${JSON.stringify(userMsg)}\n`
}

/** Official Codex JSON-RPC notification. Gateway writes it; no engine binary patch. */
export function buildCodexDelegateTerminalNotification(event: JobTerminal, body: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'delegate/terminal',
    params: {
      jobId: event.jobId,
      notifyId: delegateNotifyId(event.jobId, event.callbackEpoch),
      state: event.state,
      body,
    },
  })
}

/**
 * Production 档 A dispatch. Flag-on uses EngineAdapter.writeDelegateTerminal.
 * Flag-off keeps the R0/R1 duck-type probe (653ef6339 equivalent).
 * An active cutover/drain freeze window forces fail so Notifier degrades to
 * ResumeInject. The CUTOVER feature flag alone is not a window.
 */
export async function writeInlinePushForSession(
  session: InlinePushSession | undefined,
  event: JobTerminal,
  body: string,
  env: NodeJS.ProcessEnv = process.env,
  runtime: InlinePushRuntime = {},
): Promise<InlinePushWriteResult> {
  if (!isDelegateInlinePushEnabled(event.parentEngine, env)) {
    return tryWriteInlinePush(session, event, body)
  }
  const runner = session?.runner
  const processAlive = Boolean(runner?.isRunning)
  const fence = notifyClaimFenceOf(event)
  if (fence && !fence.isLive()) {
    return { ok: false, processAlive }
  }
  if (runtime.isCutoverWindowActive?.() === true) {
    return { ok: false, processAlive }
  }
  const write = runner?.writeDelegateTerminal
  if (typeof write !== 'function') {
    return { ok: false, processAlive }
  }
  if (fence && !fence.isLive()) {
    return { ok: false, processAlive }
  }
  try {
    const result = await write.call(runner, event, body)
    return {
      ok: Boolean(result?.ok && result.processAlive),
      processAlive: Boolean(result?.processAlive),
      unknown: Boolean(result?.unknown),
    }
  } catch {
    // Write started (a_attempted already stamped). Outcome unknown.
    return { ok: false, processAlive: false, unknown: true }
  }
}

export function notifyClaimFenceOf(event: JobTerminal): NotifyClaimFence | undefined {
  const fence = (event as JobTerminal & { [NOTIFY_CLAIM_FENCE]?: NotifyClaimFence })[NOTIFY_CLAIM_FENCE]
  return fence
}

/**
 * Flag-off 档 A write. Duck-types `runner.proc` / `runner.writeRaw` so
 * 653ef6339 tests and Completer paths stay equivalent. Production adapters
 * hide those fields; live 档 A is `writeDelegateTerminal` behind the R3 flags.
 */
export async function tryWriteInlinePush(
  session: InlinePushSession | undefined,
  event: JobTerminal,
  body: string,
): Promise<{ ok: boolean; processAlive: boolean }> {
  const runner = session?.runner
  if (!runner) return { ok: false, processAlive: false }
  const proc = runner.proc
  if (proc && (proc.killed || proc.exitCode != null)) {
    return { ok: false, processAlive: false }
  }
  if ((session?._activeTurnCount ?? 0) > 0 || (session?._activeClientTurnCount ?? 0) > 0) {
    // Mid-turn: do not barge in; Completer/R1 degrades to ResumeInject.
    return { ok: false, processAlive: true }
  }
  if (event.parentEngine === 'ccb') {
    const stdin = proc?.stdin
    if (!stdin?.writable) return { ok: false, processAlive: Boolean(proc) }
    const userMsg = {
      type: 'user',
      message: { role: 'user', content: body },
      parent_tool_use_id: null,
    }
    try {
      await writeStdinLine(stdin, `${JSON.stringify(userMsg)}\n`)
      return { ok: true, processAlive: true }
    } catch {
      return { ok: false, processAlive: false }
    }
  }
  if (event.parentEngine === 'codex' && typeof runner.writeRaw === 'function') {
    try {
      await runner.writeRaw(`${buildCodexDelegateTerminalNotification(event, body)}\n`)
      return { ok: true, processAlive: true }
    } catch {
      return { ok: false, processAlive: false }
    }
  }
  return { ok: false, processAlive: Boolean(proc || runner) }
}

function writeStdinLine(
  stdin: { write: (chunk: string, cb?: (err?: Error | null) => void) => boolean },
  line: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = stdin.write(line, (err) => {
      if (err) reject(err)
      else resolve()
    })
    if (ok === false) {
      // Backpressure: the callback still fires.
    }
  })
}
