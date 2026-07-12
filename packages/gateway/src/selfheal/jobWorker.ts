// Self-heal job worker (slice ② / block B2a, contract §派单/§短期capability).
//
// The durable executor behind the receiver. A single background loop leases one
// `received` (or crash-orphaned) job at a time and drives it to a terminal
// state:
//
//   claim(lease)  →  fetch short-lived capability from v5  →  persist on job
//                 →  getOrCreate(deterministic session)     →  persist session key
//                 →  submitWithExecutionId (at-most-once)    →  succeeded/failed
//
// At-most-once is enforced one layer down (enqueueExecution / claimQueuedTurn in
// selfhealStore): a re-driven job (crash recovery via lease expiry) never
// double-submits. The lease + deterministic session key make recovery a plain
// re-run of this same sequence.
//
// The capability is fetched with the gateway's own credential (webhook HMAC over
// the reverse tunnel) and persisted ONTO the job row only — it is never placed
// in the prompt or the model env. The codex agent reaches it exclusively through
// its restricted callback tool (block B2b/C), so the model never sees plaintext.

import { createHash, createHmac, randomBytes } from 'node:crypto'
import type { AgentDef } from '@openclaude/storage'
import {
  type SelfhealJob,
  claimNextJob,
  getExecution,
  reclaimOrphanedLeases,
  releaseJobLeasesForOwner,
  renewJobLease,
  setJobCapability,
  setJobSessionKey,
  setJobStatus,
} from '@openclaude/storage'
import { createLogger } from '../logger.js'
import type { SessionManager } from '../sessionManager.js'
import {
  SELFHEAL_AGENT_ID,
  buildRepairPrompt,
  createRepairTurnSink,
  selfhealSessionKey,
} from './executionLedger.js'

const log = createLogger({ module: 'selfheal-jobworker' })

const POLL_INTERVAL_MS = 5_000
const LEASE_MS = 10 * 60_000
const LEASE_RENEW_MS = 2 * 60_000
const CAPABILITY_FETCH_TIMEOUT_MS = 15_000

export interface SelfhealJobWorkerDeps {
  sessions: SessionManager
  /** Resolve an agent def by id (server.ts adapts its agents-config cache). */
  resolveAgent: (id: string) => Promise<AgentDef | null>
  /** OC_SELFHEAL_CALLBACK_URL — forward tunnel base to the v5 master. */
  callbackBaseUrl: string
  /** OC_SELFHEAL_WEBHOOK_HMAC — shared secret for signing the capability fetch. */
  hmacSecret: string
}

/** Build worker deps from env, or null when the feature is not fully configured. */
export function getSelfhealJobWorkerDeps(
  base: { sessions: SessionManager; resolveAgent: (id: string) => Promise<AgentDef | null> },
  env: NodeJS.ProcessEnv = process.env,
): SelfhealJobWorkerDeps | null {
  const callbackBaseUrl = env.OC_SELFHEAL_CALLBACK_URL?.trim()
  const hmacSecret = env.OC_SELFHEAL_WEBHOOK_HMAC?.trim()
  if (!callbackBaseUrl || !hmacSecret) return null
  return { ...base, callbackBaseUrl, hmacSecret }
}

/** Sign an outbound self-heal request the same way the receiver verifies inbound. */
export function signSelfhealRequest(
  hmacSecret: string,
  repairId: string,
  rawBody: Buffer,
  now = Date.now(),
): { ts: string; nonce: string; sig: string } {
  const ts = String(now)
  const nonce = randomBytes(16).toString('hex')
  const bodySha256 = createHash('sha256').update(rawBody).digest('hex')
  const sig = createHmac('sha256', hmacSecret)
    .update(`${ts}.${nonce}.${repairId}.${bodySha256}`)
    .digest('hex')
  return { ts, nonce, sig }
}

export class SelfhealJobWorker {
  private readonly deps: SelfhealJobWorkerDeps
  private readonly owner: string
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private stopped = false
  private ticking = false

  constructor(deps: SelfhealJobWorkerDeps) {
    this.deps = deps
    // Owner tag distinguishes lease holders (per-process). Random suffix avoids
    // two restarts colliding on the same owner string mid-lease.
    this.owner = `gw:${process.pid}:${randomBytes(4).toString('hex')}`
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.stopped = false
    log.info('selfheal jobWorker started', { owner: this.owner })
    // Crash recovery: expire orphaned leases from a hard-crashed prior process
    // so any in-flight repair is re-driven immediately (idempotent), not after a
    // full lease timeout. Best-effort — the poll loop still recovers on expiry.
    reclaimOrphanedLeases()
      .then((n) => {
        if (n > 0) log.info('reclaimed orphaned repair leases', { count: n })
      })
      .catch((err) => log.warn('orphan lease reclaim failed', undefined, err))
    this.scheduleNext(0)
  }

  stop(): void {
    this.stopped = true
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    // Graceful-shutdown fast recovery: release the leases we still hold so the
    // next process re-claims our in-flight repairs immediately instead of waiting
    // out the lease window. Best-effort — a hard crash falls back to lease expiry.
    // (Codex HIGH #10 companion to the expired-only reclaim.)
    releaseJobLeasesForOwner(this.owner)
      .then((n) => {
        if (n > 0)
          log.info('released in-flight repair leases on shutdown', { count: n, owner: this.owner })
      })
      .catch((err) => log.warn('lease release on shutdown failed', undefined, err))
  }

  /** Wake the loop immediately (e.g. right after the receiver commits a job). */
  kick(): void {
    if (!this.running || this.ticking) return
    this.scheduleNext(0)
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
    let claimedSomething = false
    try {
      const job = await claimNextJob({ owner: this.owner, leaseMs: LEASE_MS })
      if (job) {
        claimedSomething = true
        await this.processJob(job)
      }
    } catch (err) {
      log.error('selfheal jobWorker tick error', undefined, err as Error)
    } finally {
      this.ticking = false
      // Drain quickly while work remains; otherwise fall back to the poll cadence.
      this.scheduleNext(claimedSomething ? 0 : POLL_INTERVAL_MS)
    }
  }

  private async processJob(job: SelfhealJob): Promise<void> {
    const { repairId } = job
    log.info('processing repair', { repairId, incidentId: job.incidentId, attempt: job.attempt })

    // 1. Fetch the short-lived capability from v5 and persist it on the job.
    //    On failure we leave the job in 'starting'; the lease expires and a later
    //    tick re-claims and retries (capability issuance is idempotent per repair).
    let capability: string
    try {
      capability = await this.fetchCapability(repairId)
    } catch (err) {
      log.warn('capability fetch failed — will retry after lease expiry', { repairId }, err)
      return
    }
    await setJobCapability(repairId, capability)

    // 2. Resolve the repair agent (block C provisions `codex-v5ops`).
    const agent = await this.deps.resolveAgent(SELFHEAL_AGENT_ID)
    if (!agent) {
      log.error('repair agent not found — cannot execute', { repairId, agentId: SELFHEAL_AGENT_ID })
      await setJobStatus(repairId, 'failed', ['starting', 'running'])
      return
    }

    // 3. Deterministic session (stable across restarts → idempotent recovery).
    const sessionKey = selfhealSessionKey(repairId)
    const session = await this.deps.sessions.getOrCreate({
      sessionKey,
      agent,
      channel: 'selfheal',
      peerId: repairId,
      title: `[selfheal] ${repairId}`,
    })
    await setJobSessionKey(repairId, sessionKey)

    // 4. Drive the turn under a renewed lease. submitWithExecutionId is the
    //    at-most-once收口: enqueue(accepted+queued) then CAS-consume then submit.
    await setJobStatus(repairId, 'running', ['starting', 'running'])
    const leaseTimer = this.startLeaseRenew(repairId)
    const sink = createRepairTurnSink()
    try {
      const result = await this.deps.sessions.submitWithExecutionId(
        session,
        buildRepairPrompt(repairId),
        repairId,
        sink.onEvent,
      )
      await this.finalizeJob(repairId, result, sink.getError())
    } catch (err) {
      log.error('repair turn threw', { repairId }, err as Error)
      await setJobStatus(repairId, 'failed', ['starting', 'running'])
    } finally {
      clearInterval(leaseTimer)
    }
  }

  /**
   * Map the execution outcome onto a terminal job status.
   *   - ran here + no error   → succeeded
   *   - ran here + error      → failed
   *   - deduped (didn't run)  → mirror the execution's own status:
   *       done → succeeded, else → failed.
   * With reopenExecutionForRedrive, a crash-mid-turn re-drive now RE-RUNS
   * (ranHere=true) rather than landing here, so the deduped path is reached only
   * by a genuine concurrent completion (which the job lease makes rare); mapping
   * a still-'running' dedupe to failed is a defensive fallback (the job fuse /
   * re-dispatch covers a truly stuck repair).
   */
  private async finalizeJob(
    repairId: string,
    result: { ranHere: boolean; status: string },
    turnError: string | undefined,
  ): Promise<void> {
    if (result.ranHere) {
      const status = turnError ? 'failed' : 'succeeded'
      await setJobStatus(repairId, status, ['starting', 'running'])
      return
    }
    // Deduped: another drive already consumed the turn. Reach a terminal job
    // state that reflects the execution ledger so the job is not re-claimed.
    const exec = await getExecution(repairId)
    const execStatus = exec?.status ?? 'failed'
    const jobStatus = execStatus === 'done' ? 'succeeded' : 'failed'
    log.info('repair turn deduped', { repairId, execStatus, jobStatus })
    await setJobStatus(repairId, jobStatus, ['starting', 'running'])
  }

  private startLeaseRenew(repairId: string): ReturnType<typeof setInterval> {
    const t = setInterval(() => {
      renewJobLease({ repairId, owner: this.owner, leaseMs: LEASE_MS }).catch((err) =>
        log.warn('lease renew failed', { repairId }, err),
      )
    }, LEASE_RENEW_MS)
    t.unref?.()
    return t
  }

  /**
   * POST ${callbackBaseUrl}/internal/v5/repairs/:id/claim-capability, authed with
   * the webhook HMAC scheme. Returns the capability string. Throws on non-200 /
   * timeout / malformed response so the caller can retry via lease expiry.
   */
  private async fetchCapability(repairId: string): Promise<string> {
    const url = `${this.deps.callbackBaseUrl.replace(/\/$/, '')}/internal/v5/repairs/${encodeURIComponent(repairId)}/claim-capability`
    const rawBody = Buffer.from('{}', 'utf8')
    const { ts, nonce, sig } = signSelfhealRequest(this.deps.hmacSecret, repairId, rawBody)
    const ctrl = new AbortController()
    const timeout = setTimeout(() => ctrl.abort(), CAPABILITY_FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Selfheal-Ts': ts,
          'X-Selfheal-Nonce': nonce,
          'X-Selfheal-Sig': sig,
        },
        body: rawBody,
        signal: ctrl.signal,
      })
      if (!res.ok) {
        throw new Error(`claim-capability HTTP ${res.status}`)
      }
      const data = (await res.json()) as { capability?: unknown }
      if (typeof data.capability !== 'string' || !data.capability) {
        throw new Error('claim-capability response missing capability')
      }
      return data.capability
    } finally {
      clearTimeout(timeout)
    }
  }
}
