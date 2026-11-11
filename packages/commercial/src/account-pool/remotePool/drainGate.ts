/**
 * R1 Generation Drain Coordinator (`AC-5`).
 *
 * Ensures zero in-flight turns (legacy `cc5-interactive-v1`, `codex-app-server-v1`, or
 * `remote-driver-v4`) are killed during a release cutover:
 * 1. Closes new placement admissions (`REMOTE_POOL_DRAINING_RETRY_LATER`).
 * 2. Waits until every registered relay reports `idle === true` AND every remote-native
 *    `request_finalize_journal` row has exited `'inflight' | 'finalizing'`.
 * 3. If `timeoutMs` elapses before all turns settle, reopens admissions and throws
 *    `REMOTE_RELEASE_DRAIN_TIMEOUT` instead of force-killing active turns.
 */
import type { Pool } from 'pg'

export interface DrainableRelayHandle {
  readonly idle: boolean
}

export class RemoteReleaseDrainCoordinator {
  private draining = false
  private readonly relays = new Map<string, DrainableRelayHandle>()

  get isDraining(): boolean {
    return this.draining
  }

  get activeRelayCount(): number {
    let busy = 0
    for (const relay of this.relays.values()) {
      if (!relay.idle) busy += 1
    }
    return busy
  }

  registerRelay(id: string, relay: DrainableRelayHandle): () => void {
    this.relays.set(id, relay)
    return () => {
      if (this.relays.get(id) === relay) {
        this.relays.delete(id)
      }
    }
  }

  assertAdmissionOpen(): void {
    if (this.draining) {
      throw new Error('REMOTE_POOL_DRAINING_RETRY_LATER')
    }
  }

  reopen(): void {
    this.draining = false
  }

  async drainForCutover(
    pool: Pool,
    options: { readonly timeoutMs?: number; readonly pollIntervalMs?: number } = {},
  ): Promise<{ readonly drained: true; readonly elapsedMs: number }> {
    const timeoutMs = Math.max(50, Math.floor(options.timeoutMs ?? 60_000))
    const pollIntervalMs = Math.max(10, Math.min(1_000, Math.floor(options.pollIntervalMs ?? 100)))
    const startedAt = Date.now()
    this.draining = true

    try {
      while (true) {
        const allRelaysIdle = [...this.relays.values()].every((r) => r.idle)
        if (allRelaysIdle) {
          const res = await pool.query<{ cnt: string }>(
            `SELECT COUNT(*)::text AS cnt
               FROM request_finalize_journal
              WHERE ctx ? 'remoteNativeBillingRecovery'
                AND state IN ('inflight', 'finalizing')`,
          )
          if (Number(res.rows[0]?.cnt ?? '0') === 0 && [...this.relays.values()].every((r) => r.idle)) {
            return { drained: true, elapsedMs: Date.now() - startedAt }
          }
        }
        if (Date.now() - startedAt >= timeoutMs) {
          this.draining = false
          throw new Error('REMOTE_RELEASE_DRAIN_TIMEOUT')
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
      }
    } catch (err) {
      this.draining = false
      throw err
    }
  }
}
