import { randomUUID } from 'node:crypto'
import type { Pool, QueryResult } from 'pg'
import { WebSocket } from 'ws'
import { containerLinkControlDelivered } from '../admin/metrics.js'
import { claimDueTurnControls, releaseTurnControlForRetry } from '../dispatch/turnControlStore.js'
import type { ContainerLinkRegistry } from './containerLink.js'
import type { LinkCarrier } from './containerLinkRecoveryStore.js'

type Target = { control_id: string; container_id: number }
interface Options {
  pool: Pool
  channel: string
  links: ContainerLinkRegistry | null
  legacy: Map<string, Set<WebSocket>>
  wake?: (carrier: LinkCarrier) => Promise<void>
  log?: { warn(message: string, fields?: Record<string, unknown>): void } | null
}

/** The PG lease owns delivery. Link handles and browser subscriptions do not. */
export class ContainerLinkControls {
  private readonly owner = `master:${randomUUID()}`
  private readonly running = new Map<string, Promise<void>>()
  private scanning: Promise<void> | null = null
  private stopped = false
  private readonly timer: ReturnType<typeof setInterval>
  constructor(private readonly options: Options) {
    this.timer = setInterval(() => { void this.scan() }, 1000)
    this.timer.unref()
  }

  scan(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.scanning) return this.scanning
    this.scanning = this.scanUsers().catch(error => {
      this.options.log?.warn('container-link: control scan failed', { error })
    }).finally(() => { this.scanning = null })
    return this.scanning
  }

  private async scanUsers(): Promise<void> {
    if (!this.options.links) {
      for (const uid of this.options.legacy.keys()) await this.drain(BigInt(uid))
      return
    }
    let after: string | null = null
    while (!this.stopped) {
      const page: QueryResult<{ user_id: string }> = await this.options.pool.query<{ user_id: string }>(
        `SELECT DISTINCT user_id FROM turn_control_requests
          WHERE status IN ('pending','leased') AND next_attempt_at<=NOW()
            AND (status='pending' OR lease_until<NOW())
            AND ($1::bigint IS NULL OR user_id>$1::bigint)
          ORDER BY user_id LIMIT 100`, [after],
      )
      for (const row of page.rows) {
        if (this.stopped) return
        await this.drain(BigInt(row.user_id))
      }
      if (page.rows.length < 100) return
      after = String(page.rows.at(-1)!.user_id)
    }
  }

  drain(uid: bigint): Promise<void> {
    if (this.stopped) return Promise.resolve()
    const key = String(uid)
    const prior = this.running.get(key)
    if (prior) return prior
    const work = this.deliver(uid).catch(error => {
      this.options.log?.warn('container-link: durable control drain failed', { uid: key, error })
    }).finally(() => { this.running.delete(key) })
    this.running.set(key, work)
    return work
  }

  /** Prefer the exact turn's carrier. A prompt without a dispatch can use
   * the sole active carrier, but never guess between desktop and docker. */
  private async targets(uid: bigint, after: string | null): Promise<Target[]> {
    const result = await this.options.pool.query<Target>(
      `SELECT c.control_id,ac.id::int AS container_id
         FROM turn_control_requests c
         JOIN client_sessions s ON s.id=c.session_id AND s.user_id='c:' || c.user_id::text AND s.deleted_at IS NULL
         LEFT JOIN LATERAL (
           SELECT d.agent_container_id FROM turn_dispatches d
            WHERE d.user_id=c.user_id AND d.session_id=c.session_id
            ORDER BY (d.client_message_id=COALESCE(c.payload_json->>'clientMessageId',c.root_client_message_id)) DESC NULLS LAST,
                     d.admitted_at DESC,d.dispatch_id DESC LIMIT 1
         ) d ON true
         JOIN agent_containers ac ON ac.user_id=c.user_id AND ac.state='active' AND ac.runtime_channel=$2
          AND (ac.id=d.agent_container_id OR (d.agent_container_id IS NULL AND NOT EXISTS (
            SELECT 1 FROM agent_containers other WHERE other.user_id=c.user_id AND other.state='active'
              AND other.runtime_channel=$2 AND other.id<>ac.id)))
        WHERE c.user_id=$1 AND c.status IN ('pending','leased') AND c.next_attempt_at<=NOW()
          AND (c.status='pending' OR c.lease_until<NOW())
          AND ($3::text IS NULL OR c.control_id>$3)
        ORDER BY c.control_id LIMIT 100`, [String(uid), this.options.channel, after],
    )
    return result.rows
  }

  private legacyTransport(uid: bigint): WebSocket | null {
    return [...(this.options.legacy.get(String(uid)) ?? [])].find(socket => socket.readyState === WebSocket.OPEN) ?? null
  }

  private async deliver(uid: bigint): Promise<void> {
    let after: string | null = null
    do {
      const targets: Target[] = this.options.links ? await this.targets(uid, after) : []
      if (this.stopped) return
      const carriers = new Map(targets.map(target => [target.control_id, target.container_id]))
      const ready = targets.filter(target => this.options.links!.controlTransport(uid, target.container_id))
      for (const cid of new Set(targets.filter(target => !ready.includes(target)).map(target => target.container_id))) {
        void this.options.wake?.({ uid: String(uid), containerId: cid }).catch(error => {
          this.options.log?.warn('container-link: control wake failed', { uid: String(uid), containerId: cid, error })
        })
      }
      if (this.options.links ? ready.length > 0 : this.legacyTransport(uid) !== null) {
        const controls = await claimDueTurnControls(this.options.pool, {
          userId: uid, ownerId: this.owner, leaseMs: 15_000,
          ...(this.options.links ? { controlIds: ready.map(target => target.control_id), limit: 100 } : {}),
        })
        for (const control of controls) {
          const live = this.stopped ? null : this.options.links
            ? this.options.links.controlTransport(uid, carriers.get(control.controlId)!) : this.legacyTransport(uid)
          if (!live) { await releaseTurnControlForRetry(this.options.pool, control); continue }
          try {
            await new Promise<void>((resolve, reject) => live.send(
              JSON.stringify({ ...control.payload, controlId: control.controlId }), { binary: false },
              error => error ? reject(error) : resolve(),
            ))
            containerLinkControlDelivered.inc({ via: this.options.links ? 'link' : 'legacy' })
          } catch { await releaseTurnControlForRetry(this.options.pool, control) }
        }
      }
      if (!this.options.links || targets.length < 100) return
      after = targets.at(-1)!.control_id
    } while (!this.stopped)
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearInterval(this.timer)
    await Promise.allSettled([this.scanning, ...this.running.values()])
  }
}
