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
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname } from 'node:path'
import type { Pool } from 'pg'

export const DEFAULT_REMOTE_V4_DRAIN_SOCKET = '/run/openclaude-v5-selfhost/remote-v4-drain.sock'

export interface DrainableRelayHandle {
  readonly idle: boolean
}

export interface RemoteReleaseDrainStatus {
  readonly draining: boolean
  readonly activeRelayCount: number
  readonly registeredRelayCount: number
  readonly releaseRunId: string | null
  readonly admissionClosedAt: string | null
  readonly drainedAt: string | null
}

export class RemoteReleaseDrainCoordinator {
  private draining = false
  private currentReleaseRunId: string | null = null
  private closedAtIso: string | null = null
  private drainedAtIso: string | null = null
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

  get registeredRelayCount(): number {
    return this.relays.size
  }

  status(): RemoteReleaseDrainStatus {
    return {
      draining: this.draining,
      activeRelayCount: this.activeRelayCount,
      registeredRelayCount: this.relays.size,
      releaseRunId: this.currentReleaseRunId,
      admissionClosedAt: this.closedAtIso,
      drainedAt: this.drainedAtIso,
    }
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
    this.drainedAtIso = null
  }

  async drainForCutover(
    pool: Pool,
    options: {
      readonly timeoutMs?: number
      readonly pollIntervalMs?: number
      readonly releaseRunId?: string
      readonly keepClosedForRestart?: boolean
    } = {},
  ): Promise<{
    readonly drained: true
    readonly elapsedMs: number
    readonly releaseRunId: string
    readonly admissionClosedAt: string
    readonly drainedAt: string
  }> {
    const timeoutMs = Math.max(50, Math.floor(options.timeoutMs ?? 60_000))
    const pollIntervalMs = Math.max(10, Math.min(1_000, Math.floor(options.pollIntervalMs ?? 100)))
    const startedAt = Date.now()
    const runId =
      typeof options.releaseRunId === 'string' && options.releaseRunId.trim().length > 0
        ? options.releaseRunId.trim()
        : `r1-drain-${randomUUID()}`
    const closedAt = this.draining && this.closedAtIso ? this.closedAtIso : new Date(startedAt).toISOString()
    this.draining = true
    this.currentReleaseRunId = runId
    this.closedAtIso = closedAt
    this.drainedAtIso = null

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
            const drainedAt = new Date().toISOString()
            this.drainedAtIso = drainedAt
            if (options.keepClosedForRestart === false) {
              this.draining = false
            }
            return {
              drained: true,
              elapsedMs: Date.now() - startedAt,
              releaseRunId: runId,
              admissionClosedAt: closedAt,
              drainedAt,
            }
          }
        }
        if (Date.now() - startedAt >= timeoutMs) {
          this.draining = false
          this.drainedAtIso = null
          throw new Error('REMOTE_RELEASE_DRAIN_TIMEOUT')
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
      }
    } catch (err) {
      this.draining = false
      this.drainedAtIso = null
      throw err
    }
  }
}

let masterDrainSingleton: RemoteReleaseDrainCoordinator | undefined

export function getMasterRemoteReleaseDrainCoordinator(): RemoteReleaseDrainCoordinator {
  masterDrainSingleton ??= new RemoteReleaseDrainCoordinator()
  return masterDrainSingleton
}

export interface RemoteReleaseDrainSocketHandle {
  readonly socketPath: string
  readonly server: Server
  readonly close: () => Promise<void>
}

const activeDrainServers = new Map<string, RemoteReleaseDrainSocketHandle>()

async function readSmallJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const c of req) {
    total += c.length
    if (total > 65_536) throw new Error('DRAIN_REQUEST_TOO_LARGE')
    chunks.push(c)
  }
  if (total === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {}
}

export function startRemoteReleaseDrainSocketServer(
  gate: RemoteReleaseDrainCoordinator,
  options: { readonly pool: () => Pool; readonly socketPath?: string },
): RemoteReleaseDrainSocketHandle {
  const socketPath = options.socketPath ?? DEFAULT_REMOTE_V4_DRAIN_SOCKET
  const existing = activeDrainServers.get(socketPath)
  if (existing?.server.listening) {
    return existing
  }
  const parent = dirname(socketPath)
  try {
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true, mode: 0o755 })
    }
    rmSync(socketPath, { force: true })
  } catch {
    // Handled asynchronously by `server.on('error')` on `listen()` below.
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = req.url ?? '/'
      if (url === '/status' && (req.method === 'GET' || req.method === 'POST')) {
        let unsettledJournals = 0
        try {
          const q = await options.pool().query<{ cnt: string }>(
            `SELECT COUNT(*)::text AS cnt
               FROM request_finalize_journal
              WHERE ctx ? 'remoteNativeBillingRecovery'
                AND state IN ('inflight', 'finalizing')`,
          )
          unsettledJournals = Number(q.rows[0]?.cnt ?? '0')
        } catch {
          unsettledJournals = -1
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, unsettledJournals, ...gate.status() }))
        return
      }
      if (url === '/drain' && req.method === 'POST') {
        const body = await readSmallJson(req)
        try {
          const out = await gate.drainForCutover(options.pool(), {
            timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
            pollIntervalMs: typeof body.pollIntervalMs === 'number' ? body.pollIntervalMs : undefined,
            releaseRunId: typeof body.releaseRunId === 'string' ? body.releaseRunId : undefined,
            keepClosedForRestart:
              typeof body.keepClosedForRestart === 'boolean' ? body.keepClosedForRestart : true,
          })
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, ...out, ...gate.status() }))
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          res.writeHead(msg === 'REMOTE_RELEASE_DRAIN_TIMEOUT' ? 409 : 500, {
            'content-type': 'application/json',
          })
          res.end(JSON.stringify({ ok: false, error: msg, ...gate.status() }))
        }
        return
      }
      if (url === '/reopen' && req.method === 'POST') {
        gate.reopen()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, ...gate.status() }))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'NOT_FOUND' }))
    })().catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
        )
      }
    })
  })

  server.on('error', (err) => {
    activeDrainServers.delete(socketPath)
    console.warn('[selfhost] remote-v4 drain socket unavailable; falling back to PG drain probe', {
      socketPath,
      error: err instanceof Error ? err.message : String(err),
    })
  })

  server.listen(socketPath, () => {
    try {
      chmodSync(socketPath, 0o600)
    } catch {
      // Best-effort socket chmod on listen
    }
  })
  server.unref()

  const handle: RemoteReleaseDrainSocketHandle = {
    socketPath,
    server,
    close: async () => {
      activeDrainServers.delete(socketPath)
      if (server.listening) {
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      }
      try {
        rmSync(socketPath, { force: true })
      } catch {
        // Ignore cleanup errors on non-existent or invalid socket paths.
      }
    },
  }
  activeDrainServers.set(socketPath, handle)
  return handle
}
