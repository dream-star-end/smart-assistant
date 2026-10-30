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
}

/** One serial recovery queue; attempts are bounded across transport flapping. */
export class ContainerLinkRecovery {
  private readonly abort = new AbortController()
  private readonly entries = new Map<string, Entry>()
  private tail: Promise<void> = Promise.resolve()
  private scan: Promise<void> | null = null
  constructor(private readonly options: ContainerLinkRecoveryOptions) {}

  start(): Promise<void> {
    this.scan ??= this.scanOpen().catch(error => {
      if (!this.abort.signal.aborted) this.options.log?.warn?.('container-link: startup scan failed', { error })
    })
    return this.scan
  }
  private async scanOpen(): Promise<void> {
    let after: LinkCarrier | null = null
    while (!this.abort.signal.aborted) {
      const page = await scanContainerLinkCarriers(this.options.pool, this.options.channel, after)
      for (const carrier of page) {
        if (this.abort.signal.aborted) return
        await this.enqueue(carrier, false)
      }
      if (page.length < 100) return
      after = page[page.length - 1]!
    }
  }
  lost(uid: bigint, containerId: number): void {
    void this.enqueue({ uid: String(uid), containerId }, true)
  }
  /** Durable work may need a carrier even when no dispatch is still open. */
  wake(carrier: LinkCarrier): Promise<void> {
    return this.enqueue(carrier, false, true)
  }
  private enqueue(carrier: LinkCarrier, retry: boolean, keepAlive = false): Promise<void> {
    if (this.abort.signal.aborted) return Promise.resolve()
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
      if (this.abort.signal.aborted) return
      await delay(retry ? (this.options.retryMs ?? 1000) * 2 ** current.attempts : (this.options.spacingMs ?? 100), undefined, { signal: this.abort.signal })
      await this.options.drain()
      if (this.abort.signal.aborted) return
      const rows = await readContainerLinkDispatches(this.options.pool, carrier)
      if (this.abort.signal.aborted || (rows.length === 0 && !current.keepAlive)) return
      const result = await this.options.attach(carrier, rows, this.abort.signal, current.keepAlive)
      if (this.abort.signal.aborted) return
      // A live desktop may register its tunnel after startup. Keep its dial budget.
      if (result === 'pending') { current.again = true; return }
      if (result === 'vanished') { current.again = false; this.report('vanished', carrier, current.attempts); return }
      countAttempt()
      if (result === 'rebuilt') containerLinkRebuilt.inc({})
      if (retry) this.report('success', carrier, current.attempts)
      this.options.log?.info?.('container-link: rebuilt', { ...carrier, result, container_link_rebuilt_total: result === 'rebuilt' ? 1 : 0 })
    }).catch(error => {
      if (this.abort.signal.aborted) return
      countAttempt()
      current.again = true
      this.report('error', carrier, current.attempts)
      this.options.log?.warn?.('container-link: recovery failed', { ...carrier, error })
    }).finally(() => {
      current.queued = false
      if (current.again) { current.again = false; void this.enqueue(carrier, true) }
    })
    this.tail = work
    return work
  }
  private report(outcome: string, carrier: LinkCarrier, attempt: number): void {
    containerLinkReconnect.inc({ outcome })
    this.options.log?.info?.('container-link: reconnect', { ...carrier, outcome, attempt, container_link_reconnect_total: 1 })
  }
  stop(): void { this.abort.abort() }
  async drain(): Promise<void> { await Promise.allSettled([this.scan, this.tail]) }
}
