/**
 * OCV5-22 R0/R1 EngineNotifier: pick InlinePush vs ResumeInject from the
 * parent-engine capability matrix. Completer still owns callback_state.
 * Notifier must not mint a second message id or a parallel failure_class.
 */
import {
  classifyNotifyLane,
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
import { isHeartbeatSilentOutput } from './jobTerminal.js'

export type InlinePushPort = {
  write(event: JobTerminal): Promise<{ ok: boolean; processAlive: boolean }>
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
   * Parent-session tape ingest oracle. True iff the model-visible tape already
   * holds this notifyId (or its paired dlgcb.* clientMessageId).
   */
  hasParentTapeIngested?: (notifyId: string, event: JobTerminal) => boolean | Promise<boolean>
}

/** Per-notify claim fence attached by dispatchJobTerminalNotify. */
export const NOTIFY_CLAIM_FENCE = Symbol.for('openclaude.notifyClaimFence')

export type NotifyClaimFence = {
  isLive: () => boolean
  ackDelivered: () => boolean
  markAAttempted?: () => boolean
  hasAAttempted?: () => boolean
}

export type InlinePushRuntime = {
  /** Live BeginCutover / recycle drain freeze — not the CUTOVER feature flag. */
  isCutoverWindowActive?: () => boolean
}

export class DefaultEngineNotifier implements EngineNotifier {
  private readonly delivered = new Set<string>()
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

    const preferred = classifyNotifyLane(event.parentEngine)
    if (preferred === 'inline-push') {
      const pushed = await this.tryInlinePush(event)
      if (pushed === 'delivered') {
        this.mark(notifyId)
        return finish({ ok: true, lane: 'inline-push', notifyId })
      }
      if (pushed === 'hold') {
        // a_attempted with unknown consumption: do not B this generation.
        // Reclaim + tape ingest decide.
        return finish({
          ok: false,
          failureClass: 'transport',
          degradedTo: 'resume-inject',
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

  private async tapeHas(event: JobTerminal, notifyId: string): Promise<boolean> {
    try {
      return Boolean(await this.opts.hasParentTapeIngested?.(notifyId, event))
    } catch {
      return false
    }
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
    const deliveredIfTaped = async (): Promise<'delivered' | 'degrade'> => {
      if (await this.tapeHas(event, notifyId)) {
        this.ackDeliveredQuiet(fence)
        return 'delivered'
      }
      return 'degrade'
    }
    try {
      if (fence && !fence.isLive()) return 'degrade'
      if (fence?.hasAAttempted?.()) {
        // Reclaim: never rewrite stdin. B iff tape has not ingested notifyId.
        const taped = await deliveredIfTaped()
        return taped === 'delivered' ? 'delivered' : 'degrade'
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
      if (!result?.ok || !result.processAlive) {
        // stdin dies with the process. B is allowed only when tape has no ingest.
        return deliveredIfTaped()
      }
      this.ackDeliveredQuiet(fence)
      return 'delivered'
    } catch {
      if (fence?.hasAAttempted?.()) {
        if (await this.tapeHas(event, notifyId)) {
          this.ackDeliveredQuiet(fence)
          return 'delivered'
        }
        return 'hold'
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
  if (event.callback === 'none') return 'skipped_silent'
  if (event.callback === 'stdout-wait') return 'stdout-wait'
  if (!isDelegateParentEngine(event.parentEngine)) return 'resume-inject'
  return classifyNotifyLane(event.parentEngine)
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
    ) => Promise<{ ok: boolean; processAlive: boolean }>
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
): Promise<{ ok: boolean; processAlive: boolean }> {
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
    }
  } catch {
    return { ok: false, processAlive: false }
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
