import { setTimeout as delay } from 'node:timers/promises'
import type { Queryable } from '../dispatch/turnDispatchStore.js'
import { containerLinkRebuilt, containerLinkReconnect } from '../admin/metrics.js'
import { readContainerLinkDispatches, scanContainerLinkCarriers, type LinkCarrier, type LinkDispatch } from './containerLinkRecoveryStore.js'

type Entry = { attempts: number; queued: boolean; again: boolean; exhausted: boolean; keepAlive: boolean }
export interface ContainerLinkRecoveryOptions {
  pool: Queryable
  channel: string
  attach(carrier: LinkCarrier, rows: LinkDispatch[], signal: AbortSignal, keepAlive?: boolean): Promise<'rebuilt' | 'attached' | 'vanished' | 'pending'>
  drain(): Promise<void>
  log?: { info?(message: string, fields?: Record<string, unknown>): void; warn?(message: string, fields?: Record<string, unknown>): void } | null
  retryMs?: number
  spacingMs?: number
  maxAttempts?: number
  paused?: boolean
}

/** One serial recovery queue; attempts are bounded across transport flapping and fenced per activation epoch. */
export class ContainerLinkRecovery {
  private readonly abort = new AbortController()
  private readonly entries = new Map<string, Entry>()
  private tail: Promise<void> = Promise.resolve()
  private scan: Promise<void> | null = null
  private active: boolean
  private activationEpoch = 0
  private runAbort: AbortController | null = null
  constructor(private readonly options: ContainerLinkRecoveryOptions) {
    this.active = !options.paused
    if (this.active) this.runAbort = new AbortController()
  }

  private currentSignal(): AbortSignal {
    if (!this.runAbort) this.runAbort = new AbortController()
    return this.runAbort.signal
  }
  private isCurrent(epoch: number, signal: AbortSignal): boolean {
    return !this.abort.signal.aborted && this.active && this.activationEpoch === epoch && !signal.aborted
  }

  /** Dual-master activation/step-down gate: deactivating aborts in-flight dials/delays and awaits drain. */
  async setActive(active: boolean): Promise<void> {
    if (active) {
      if (this.abort.signal.aborted) return
      this.activationEpoch += 1
      this.runAbort = new AbortController()
      this.active = true
      void this.rescan()
      return
    }
    this.active = false
    this.activationEpoch += 1
    this.runAbort?.abort()
    this.runAbort = null
    await this.drain()
  }

  start(): Promise<void> {
    if (!this.active || this.abort.signal.aborted) return Promise.resolve()
    const epoch = this.activationEpoch
    const signal = this.currentSignal()
    this.scan ??= this.scanOpen(epoch, signal).catch(error => {
      if (this.isCurrent(epoch, signal)) this.options.log?.warn?.('container-link: startup scan failed', { error })
    })
    return this.scan
  }
  /** Re-scan open carriers on leader re-acquisition (resets prior scan cache & exhausted flags). */
  rescan(): Promise<void> {
    if (!this.active || this.abort.signal.aborted) return Promise.resolve()
    this.scan = null
    for (const entry of this.entries.values()) {
      entry.exhausted = false
      entry.attempts = 0
    }
    return this.start()
  }
  private async scanOpen(epoch: number, signal: AbortSignal): Promise<void> {
    let after: LinkCarrier | null = null
    while (this.isCurrent(epoch, signal)) {
      const page = await scanContainerLinkCarriers(this.options.pool, this.options.channel, after)
      if (!this.isCurrent(epoch, signal)) return
      for (const carrier of page) {
        if (!this.isCurrent(epoch, signal)) return
        await this.enqueue(carrier, false, false, epoch, signal)
      }
      if (page.length < 100) return
      after = page[page.length - 1]!
    }
  }
  lost(uid: bigint, containerId: number): void {
    if (!this.active || this.abort.signal.aborted) return
    void this.enqueue({ uid: String(uid), containerId }, true)
  }
  /** Durable work may need a carrier even when no dispatch is still open. */
  wake(carrier: LinkCarrier): Promise<void> {
    if (!this.active || this.abort.signal.aborted) return Promise.resolve()
    return this.enqueue(carrier, false, true)
  }
  private enqueue(
    carrier: LinkCarrier,
    retry: boolean,
    keepAlive = false,
    epoch = this.activationEpoch,
    signal = this.currentSignal(),
  ): Promise<void> {
    if (!this.isCurrent(epoch, signal)) return Promise.resolve()
    const key = `${carrier.uid}:${carrier.containerId}`
    let entry = this.entries.get(key)
    if (!entry) {
      entry = { attempts: 0, queued: false, again: false, exhausted: false, keepAlive: false }
      this.entries.set(key, entry)
    }
    entry.keepAlive ||= keepAlive
    if (entry.exhausted) return Promise.resolve()
    if (entry.queued) { entry.again ||= retry; return this.tail }
    if (retry && entry.attempts >= (this.options.maxAttempts ?? 5)) {
      entry.exhausted = true
      this.report('exhausted', carrier, entry.attempts)
      return Promise.resolve()
    }
    entry.queued = true
    const current = entry
    let counted = false
    const countAttempt = () => {
      if (retry && !counted) { counted = true; current.attempts++; this.report('attempt', carrier, current.attempts) }
    }
    const work = this.tail.then(async () => {
      if (!this.isCurrent(epoch, signal)) return
      await delay(retry ? (this.options.retryMs ?? 1000) * 2 ** current.attempts : (this.options.spacingMs ?? 100), undefined, { signal })
      if (!this.isCurrent(epoch, signal)) return
      await this.options.drain()
      if (!this.isCurrent(epoch, signal)) return
      const rows = await readContainerLinkDispatches(this.options.pool, carrier)
      if (!this.isCurrent(epoch, signal) || (rows.length === 0 && !current.keepAlive)) return
      const result = await this.options.attach(carrier, rows, signal, current.keepAlive)
      if (!this.isCurrent(epoch, signal)) return
      // A live desktop may register its tunnel after startup. Keep its dial budget.
      if (result === 'pending') { current.again = true; return }
      if (result === 'vanished') { current.again = false; this.report('vanished', carrier, current.attempts); return }
      countAttempt()
      if (result === 'rebuilt') containerLinkRebuilt.inc({})
      if (retry) this.report('success', carrier, current.attempts)
      this.options.log?.info?.('container-link: rebuilt', { ...carrier, result, container_link_rebuilt_total: result === 'rebuilt' ? 1 : 0 })
    }).catch(error => {
      if (!this.isCurrent(epoch, signal)) return
      countAttempt()
      current.again = true
      this.report('error', carrier, current.attempts)
      this.options.log?.warn?.('container-link: recovery failed', { ...carrier, error })
    }).finally(() => {
      current.queued = false
      if (current.again) {
        current.again = false
        if (this.isCurrent(epoch, signal)) void this.enqueue(carrier, true, false, epoch, signal)
      }
    })
    this.tail = work
    return work
  }
  private report(outcome: string, carrier: LinkCarrier, attempt: number): void {
    containerLinkReconnect.inc({ outcome })
    this.options.log?.info?.('container-link: reconnect', { ...carrier, outcome, attempt, container_link_reconnect_total: 1 })
  }
  stop(): void {
    this.active = false
    this.activationEpoch += 1
    this.runAbort?.abort()
    this.runAbort = null
    this.abort.abort()
  }
  async drain(): Promise<void> { await Promise.allSettled([this.scan, this.tail]) }
}
