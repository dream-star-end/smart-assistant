/**
 * Self-heal callback pump — durable broker→master callback delivery (BLOCKER2).
 *
 * The broker's two deterministic master callbacks (the `pending_release`
 * progress marker that arms the v5 admin release gate, and the `deployed` done
 * that closes the loop after a cutover/release) used to be best-effort POSTs:
 * one network failure permanently broke the v5-side state machine, and a
 * one-click release later than the 90min capability TTL was guaranteed a 401.
 *
 * Now the broker ENQUEUES (durable SQLite outbox, idempotent on
 * repairId+phase) and this pump owns delivery:
 *
 *   claimDue (id-ascending; a repair's done is held back while its
 *   pending_release is still queued)
 *     → claim a FRESH capability per send (shared HMAC-signed
 *       claim-capability primitive — same env/receiver contract as the
 *       jobWorker), so TTL expiry can never strand a callback
 *     → POST /internal/v5/repairs/:id/{progress|done}
 *     → 2xx  ⇒ sent
 *        409  ⇒ sent   (master already applied it / jti consumed — idempotent)
 *        401  ⇒ re-claim capability once and retry; still failing ⇒ backoff
 *        404  ⇒ abandoned (repair unknown on the master)
 *        explicit claim-capability refusal ⇒ abandoned
 *        anything else / network error ⇒ exponential backoff, NEVER give up
 *
 * Single-process premise matches the rest of the selfheal gateway (better-
 * sqlite3 in-process); the outbox row states make a crashed pump resumable.
 */

import {
  type SelfhealCallbackRow,
  bumpCallbackAttempt,
  claimDueCallbacks,
  markCallbackAbandoned,
  markCallbackSent,
} from '@openclaude/storage'
import { type Logger, createLogger } from '../logger.js'
import { CapabilityClaimRejectedError, claimSelfhealCapability } from './jobWorker.js'

const rootLog = createLogger({ module: 'selfheal-callback-pump' })

const DEFAULT_INTERVAL_MS = 5_000
const DEFAULT_BATCH_LIMIT = 16
const SEND_TIMEOUT_MS = 20_000
const CAPABILITY_TIMEOUT_MS = 15_000

/**
 * Pure send primitive (the de-privileged remainder of the broker's old
 * postMasterCallback): POST one callback to the v5 master with an EXPLICIT
 * capability. No retries, no outcome coupling — durability is the pump's job.
 * Returns the HTTP status; throws only on transport errors/timeouts.
 */
export async function postMasterCallback(input: {
  callbackBaseUrl: string
  capability: string
  repairId: string
  action: 'progress' | 'done' | 'failed'
  message: string
  /** JSON OBJECT — the master's callback schema requires an object detail. */
  detail: Record<string, unknown>
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<number> {
  const f = input.fetchImpl ?? fetch
  const base = input.callbackBaseUrl.replace(/\/$/, '')
  const res = await f(
    `${base}/internal/v5/repairs/${encodeURIComponent(input.repairId)}/${input.action}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.capability}`,
      },
      body: JSON.stringify({ message: input.message, detail: input.detail }),
      redirect: 'manual',
      signal: AbortSignal.timeout(input.timeoutMs ?? SEND_TIMEOUT_MS),
    },
  )
  return res.status
}

/** Outbox surface the pump drains. Defaults to the durable SQLite store. */
export interface CallbackOutboxStore {
  claimDue(now: number, limit: number): Promise<SelfhealCallbackRow[]>
  markSent(id: number, now: number): Promise<void>
  markAbandoned(id: number, now: number): Promise<void>
  bumpAttempt(id: number, now: number): Promise<void>
}

const durableOutboxStore: CallbackOutboxStore = {
  claimDue: (now, limit) => claimDueCallbacks(now, limit),
  markSent: (id, now) => markCallbackSent(id, now),
  markAbandoned: (id, now) => markCallbackAbandoned(id, now),
  bumpAttempt: (id, now) => bumpCallbackAttempt(id, now),
}

export interface SelfhealCallbackPumpOpts {
  /** OC_SELFHEAL_CALLBACK_URL — forward tunnel base to the v5 master. */
  callbackBaseUrl: string
  /** OC_SELFHEAL_WEBHOOK_HMAC — signs the fresh claim-capability per send. */
  hmacSecret: string
  intervalMs?: number
  batchLimit?: number
  store?: CallbackOutboxStore
  fetchImpl?: typeof fetch
  /** Injectable capability claim (tests). Defaults to the shared HMAC-signed
   *  claim-capability call ({@link claimSelfhealCapability}). */
  claimCapability?: (repairId: string) => Promise<string>
  log?: Logger
  /** Injectable clock (tests). */
  now?: () => number
}

export class SelfhealCallbackPump {
  private readonly log: Logger
  private readonly store: CallbackOutboxStore
  private readonly intervalMs: number
  private readonly batchLimit: number
  private readonly claimCapability: (repairId: string) => Promise<string>
  private readonly now: () => number
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private stopped = false
  private ticking = false

  constructor(private readonly opts: SelfhealCallbackPumpOpts) {
    this.log = opts.log ?? rootLog
    this.store = opts.store ?? durableOutboxStore
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
    this.batchLimit = opts.batchLimit ?? DEFAULT_BATCH_LIMIT
    this.now = opts.now ?? (() => Date.now())
    this.claimCapability =
      opts.claimCapability ??
      ((repairId) =>
        claimSelfhealCapability({
          callbackBaseUrl: opts.callbackBaseUrl,
          hmacSecret: opts.hmacSecret,
          repairId,
          fetchImpl: opts.fetchImpl,
          timeoutMs: CAPABILITY_TIMEOUT_MS,
        }))
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.stopped = false
    this.log.info('selfheal callback pump started', { intervalMs: this.intervalMs })
    this.scheduleNext(0)
  }

  stop(): void {
    this.stopped = true
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void this.tick()
    }, delayMs)
    this.timer.unref?.()
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.ticking) return
    this.ticking = true
    try {
      await this.pumpOnce()
    } catch (err) {
      this.log.error('selfheal callback pump tick error', undefined, err as Error)
    } finally {
      this.ticking = false
      this.scheduleNext(this.intervalMs)
    }
  }

  /** Drain one due batch. Public for tests (deterministic, no timers). */
  async pumpOnce(): Promise<void> {
    let rows: SelfhealCallbackRow[]
    try {
      rows = await this.store.claimDue(this.now(), this.batchLimit)
    } catch (err) {
      this.log.error('selfheal callback outbox read failed', undefined, err as Error)
      return
    }
    for (const row of rows) {
      if (this.stopped) return
      await this.deliver(row)
    }
  }

  private async deliver(row: SelfhealCallbackRow): Promise<void> {
    const action: 'progress' | 'done' | 'failed' =
      row.phase === 'pending_release' ? 'progress' : row.phase === 'failed' ? 'failed' : 'done'
    const ctx = { id: row.id, repairId: row.repairId, phase: row.phase, attempts: row.attempts }

    // Fresh capability per send (the 90min TTL would otherwise 401 a late
    // release's done). An EXPLICIT claim refusal is permanent → abandon.
    let capability: string
    try {
      capability = await this.claimCapability(row.repairId)
    } catch (err) {
      if (err instanceof CapabilityClaimRejectedError) {
        this.log.error('selfheal callback abandoned — capability claim refused', ctx, err)
        await this.store.markAbandoned(row.id, this.now())
        return
      }
      this.log.warn('selfheal callback capability claim failed — will retry', ctx, err)
      await this.store.bumpAttempt(row.id, this.now())
      return
    }

    let detail: Record<string, unknown>
    try {
      detail = JSON.parse(row.detailJson) as Record<string, unknown>
    } catch {
      // Never representable via enqueueCallback, but fail safe: still an object.
      detail = { raw: row.detailJson }
    }

    let status: number
    try {
      status = await this.send(row, action, capability, detail)
    } catch (err) {
      this.log.warn('selfheal callback send failed — will retry', ctx, err)
      await this.store.bumpAttempt(row.id, this.now())
      return
    }

    if (status === 401) {
      // The capability may have been rotated between the claim and the send —
      // refresh ONCE and retry immediately; a second failure backs off.
      try {
        capability = await this.claimCapability(row.repairId)
        status = await this.send(row, action, capability, detail)
      } catch (err) {
        if (err instanceof CapabilityClaimRejectedError) {
          this.log.error('selfheal callback abandoned — capability claim refused', ctx, err)
          await this.store.markAbandoned(row.id, this.now())
          return
        }
        this.log.warn('selfheal callback 401-refresh retry failed — will retry', ctx, err)
        await this.store.bumpAttempt(row.id, this.now())
        return
      }
    }

    if ((status >= 200 && status < 300) || status === 409) {
      // 409 = the master already applied this transition (jti consumed /
      // idempotent replay) — the callback IS delivered.
      await this.store.markSent(row.id, this.now())
      this.log.info('selfheal callback delivered', { ...ctx, httpStatus: status })
      return
    }
    if (status === 404) {
      this.log.error('selfheal callback abandoned — repair unknown on master', {
        ...ctx,
        httpStatus: status,
      })
      await this.store.markAbandoned(row.id, this.now())
      return
    }
    // Everything else (401 after refresh, 5xx, weird 4xx): durable — back off
    // and try again forever.
    this.log.warn('selfheal callback not accepted — will retry', { ...ctx, httpStatus: status })
    await this.store.bumpAttempt(row.id, this.now())
  }

  private send(
    row: SelfhealCallbackRow,
    action: 'progress' | 'done' | 'failed',
    capability: string,
    detail: Record<string, unknown>,
  ): Promise<number> {
    return postMasterCallback({
      callbackBaseUrl: this.opts.callbackBaseUrl,
      capability,
      repairId: row.repairId,
      action,
      message: row.message,
      detail,
      fetchImpl: this.opts.fetchImpl,
    })
  }
}
