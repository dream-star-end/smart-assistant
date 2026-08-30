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
    const t0 = this.now()
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
      if (pushed) {
        this.mark(notifyId)
        return finish({ ok: true, lane: 'inline-push', notifyId })
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

  private async tryInlinePush(event: JobTerminal): Promise<boolean> {
    if (!this.opts.inlinePush) return false
    try {
      const result = await this.opts.inlinePush.write(event)
      return Boolean(result?.ok && result.processAlive)
    } catch {
      return false
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
    writeRaw?: (line: string) => void | Promise<void>
    proc?: {
      killed?: boolean
      exitCode?: number | null
      stdin?: { writable?: boolean; write: (chunk: string, cb?: (err?: Error | null) => void) => boolean }
    }
  }
}

/**
 * Best-effort 档 A write. Duck-types the live parent runner so tests can
 * stub it and production can degrade to ResumeInject when stdin is gone.
 * Does not add methods to engine adapters (R3).
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
      await runner.writeRaw(
        `${JSON.stringify({
          jsonrpc: '2.0',
          method: 'delegate/terminal',
          params: {
            jobId: event.jobId,
            notifyId: delegateNotifyId(event.jobId, event.callbackEpoch),
            state: event.state,
            body,
          },
        })}\n`,
      )
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
