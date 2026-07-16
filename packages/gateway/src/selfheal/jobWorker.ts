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
  getJob,
  reclaimOrphanedLeases,
  releaseJobLeasesForOwner,
  renewJobLease,
  claimJobTier1,
  setJobCapability,
  setJobFrozenRouting,
  setJobSessionKey,
  setJobStatus,
  setJobTier1Receipt,
  terminalizeTier1WithCallback,
} from '@openclaude/storage'
import { createLogger } from '../logger.js'
import type { SessionManager } from '../sessionManager.js'
import {
  CONDITION_OPCODE_MAP,
  type HostActionConfig,
  type HostActionReceipt,
  executeHostOpcode,
  hostActionConfigFromEnv,
} from './hostAction.js'
import {
  SELFHEAL_AGENT_ID,
  buildRepairPrompt,
  createRepairTurnSink,
  selfhealSessionKey,
  withRepairLock,
} from './executionLedger.js'
import { selfhealSignedString } from './receiver.js'
import {
  type PrepareCloneOpts,
  type PrepareCloneResult,
  prepareClone as defaultPrepareClone,
} from './verifier.js'

const log = createLogger({ module: 'selfheal-jobworker' })

const POLL_INTERVAL_MS = 5_000
const LEASE_MS = 10 * 60_000
const LEASE_RENEW_MS = 2 * 60_000
const CAPABILITY_FETCH_TIMEOUT_MS = 15_000
const REPORT_TIMEOUT_MS = 10_000

export interface SelfhealJobWorkerDeps {
  sessions: SessionManager
  /** Resolve an agent def by id (server.ts adapts its agents-config cache). */
  resolveAgent: (id: string) => Promise<AgentDef | null>
  /** OC_SELFHEAL_CALLBACK_URL — forward tunnel base to the v5 master. */
  callbackBaseUrl: string
  /** OC_SELFHEAL_WEBHOOK_HMAC — shared secret for signing the capability fetch. */
  hmacSecret: string
  /** Canonical v5 checkout the per-repair clone is built FROM (block C2). */
  canonicalRepo: string
  /** Branch checked out in the per-repair clone. */
  canonicalBranch: string
  /** OC_SELFHEAL_OCHEAL_UID / _GID — the de-privileged owner of the clone.
   *  Absent ⇒ clone preparation fails closed (job → failed). */
  ochealUid?: number
  ochealGid?: number
  /** Injectable clone builder (tests). Defaults to verifier.prepareClone. */
  prepareClone?: (opts: PrepareCloneOpts) => Promise<PrepareCloneResult>
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Injectable Tier1 host-action config resolver (tests). `undefined` ⇒ read
   *  from env; an explicit `null` ⇒ not provisioned (fail-closed). */
  hostActionConfig?: HostActionConfig | null
  /** Injectable Tier1 opcode transport (tests). Defaults to the real SSH. */
  executeHostOpcode?: typeof executeHostOpcode
}

/** Build worker deps from env, or null when the feature is not fully configured. */
export function getSelfhealJobWorkerDeps(
  base: { sessions: SessionManager; resolveAgent: (id: string) => Promise<AgentDef | null> },
  env: NodeJS.ProcessEnv = process.env,
): SelfhealJobWorkerDeps | null {
  const callbackBaseUrl = env.OC_SELFHEAL_CALLBACK_URL?.trim()
  const hmacSecret = env.OC_SELFHEAL_WEBHOOK_HMAC?.trim()
  if (!callbackBaseUrl || !hmacSecret) return null
  const uid = Number(env.OC_SELFHEAL_OCHEAL_UID)
  const gid = Number(env.OC_SELFHEAL_OCHEAL_GID)
  return {
    ...base,
    callbackBaseUrl,
    hmacSecret,
    canonicalRepo: env.OC_SELFHEAL_CANONICAL_DIR?.trim() || '/opt/openclaude/openclaude-v5-aurora',
    canonicalBranch: env.OC_SELFHEAL_CANONICAL_BRANCH?.trim() || 'feat/v5-aurora-rewrite',
    ochealUid: Number.isInteger(uid) ? uid : undefined,
    ochealGid: Number.isInteger(gid) ? gid : undefined,
  }
}

/**
 * Sign an outbound self-heal request the same way the v5 master verifies it —
 * the route-bound HMAC contract shared with the receiver (design §A6/M3):
 * `${METHOD}.${path}.${ts}.${nonce}.${repairId}.${bodySha256}`.
 */
export function signSelfhealRequest(
  hmacSecret: string,
  input: { method: string; path: string; repairId: string; rawBody: Buffer },
  now = Date.now(),
): { ts: string; nonce: string; sig: string } {
  const ts = String(now)
  const nonce = randomBytes(16).toString('hex')
  const bodySha256 = createHash('sha256').update(input.rawBody).digest('hex')
  const sig = createHmac('sha256', hmacSecret)
    .update(
      selfhealSignedString({
        method: input.method,
        path: input.path,
        ts,
        nonce,
        repairId: input.repairId,
        bodySha256,
      }),
    )
    .digest('hex')
  return { ts, nonce, sig }
}

/** The master EXPLICITLY refused to issue a capability for this repair
 *  (unknown / terminal) — a permanent condition callers must not retry. */
export class CapabilityClaimRejectedError extends Error {
  constructor(public readonly httpStatus: number) {
    super(`claim-capability explicitly refused: HTTP ${httpStatus}`)
    this.name = 'CapabilityClaimRejectedError'
  }
}

/** HTTP statuses that mean the master will NEVER issue a capability for this
 *  repair (repair unknown, or already terminal) — everything else is transient. */
const CAPABILITY_REJECT_STATUSES = new Set([404, 409, 410])

/**
 * POST ${callbackBaseUrl}/internal/v5/repairs/:id/claim-capability, authed with
 * the webhook HMAC scheme (route-bound signature — the shared contract with the
 * receiver). Single authority for capability claims: used by the jobWorker
 * (initial claim before a repair turn) AND by the callbackPump (a FRESH
 * capability per durable callback send — the 90min TTL would otherwise 401 any
 * late one-click release).
 *
 * Throws {@link CapabilityClaimRejectedError} on an explicit master refusal
 * (repair unknown/terminal); a plain Error on transient failures (retryable).
 */
export async function claimSelfhealCapability(input: {
  callbackBaseUrl: string
  hmacSecret: string
  repairId: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<string> {
  const url = `${input.callbackBaseUrl.replace(/\/$/, '')}/internal/v5/repairs/${encodeURIComponent(input.repairId)}/claim-capability`
  const rawBody = Buffer.from('{}', 'utf8')
  // Route-bound signature: METHOD + the exact pathname the master sees.
  const { ts, nonce, sig } = signSelfhealRequest(input.hmacSecret, {
    method: 'POST',
    path: new URL(url).pathname,
    repairId: input.repairId,
    rawBody,
  })
  const ctrl = new AbortController()
  const timeout = setTimeout(() => ctrl.abort(), input.timeoutMs ?? CAPABILITY_FETCH_TIMEOUT_MS)
  try {
    const f = input.fetchImpl ?? fetch
    const res = await f(url, {
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
      if (CAPABILITY_REJECT_STATUSES.has(res.status)) {
        throw new CapabilityClaimRejectedError(res.status)
      }
      throw new Error(`claim-capability HTTP ${res.status}`)
    }
    const data = (await res.json()) as { token?: unknown }
    if (typeof data.token !== 'string' || !data.token) {
      throw new Error('claim-capability response missing token')
    }
    return data.token
  } finally {
    clearTimeout(timeout)
  }
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

    // 1.5 Freeze the authoritative ROUTING (condition key + executionClass +
    //     actionOpcode) from the master context BEFORE any action or turn. The
    //     master is the single authority on how a class is repaired — the
    //     execution side never guesses tier. Fail-closed like the capability:
    //     leave 'starting', retry next tick after the lease expires. Set-once,
    //     so a replayed/late context cannot reclassify tier or swap the opcode.
    if (job.conditionKey === null || job.executionClass === null) {
      try {
        const fetched = await this.fetchRouting(repairId, capability)
        // ONE atomic set-once write (BLOCKER1): condition + class + opcode
        // together, so a crash can never mix two context versions.
        await setJobFrozenRouting(
          repairId,
          fetched.conditionKey,
          fetched.executionClass,
          fetched.actionOpcode,
        )
      } catch (err) {
        log.warn('routing freeze failed — will retry after lease expiry', { repairId }, err)
        return
      }
    }
    // Read the AUTHORITATIVE frozen values back from the row (never the
    // in-memory fetch result) — everything downstream uses the durable freeze.
    const frozen = await getJob(repairId)
    if (!frozen || frozen.conditionKey === null || frozen.executionClass === null) {
      log.warn('routing not frozen after write — will retry', { repairId })
      return
    }
    const routing = {
      conditionKey: frozen.conditionKey,
      executionClass: frozen.executionClass,
      actionOpcode: frozen.actionOpcode,
    }

    // 1.6 Machine-authored ack: "the execution side accepted this job" is a
    //     TRANSPORT fact, so the worker signs it — never the model (the retired
    //     contract expected `oc-selfheal ack` from the agent; the CLI never had
    //     it, so repairs sat in 'dispatched' forever and every later `done`
    //     409'd against the master CAS while the ack-budget watchdog counted
    //     down to cancel). Fail-closed like the freeze: without a confirmed
    //     acked state the terminal report cannot land, so don't start work.
    try {
      await this.postAck(repairId, capability)
    } catch (err) {
      log.warn('ack callback failed — will retry after lease expiry', { repairId }, err)
      return
    }

    // 1.7 Tier1 = deterministic ops action, PURE MACHINE PATH: no clone, no
    //     ocheal turn, no codex session (the model has zero decision value for a
    //     fixed restart/prune, and adds latency + an injection/mis-edit surface).
    //     The done callback is signed by the root executor bound to the real SSH
    //     exit, which is exactly the trusted-attestation shape "model-authored
    //     done ≠ evidence" demands. Everything below (agent/clone/turn) is Tier2
    //     only and stays lazy.
    if (routing.executionClass === 'tier1') {
      await this.executeTier1(repairId, capability, routing.conditionKey, routing.actionOpcode)
      return
    }

    // 2. Resolve the repair agent (block C provisions `codex-v5ops`).
    const agent = await this.deps.resolveAgent(SELFHEAL_AGENT_ID)
    if (!agent) {
      log.error('repair agent not found — cannot execute', { repairId, agentId: SELFHEAL_AGENT_ID })
      await this.markFailedAndReport(repairId, capability, 'repair agent not found')
      return
    }

    // 3. Independent, de-privileged clone BEFORE any submit (block C2): the
    //    codex works only inside /home/ocheal/selfheal/<repairId>. Root prepares
    //    it here (verifier.prepareClone is idempotent for crash re-drives).
    //    Failure ⇒ job failed + best-effort failed-callback to v5.
    let clonePath: string
    try {
      clonePath = await this.ensureRepairClone(repairId)
    } catch (err) {
      log.error('repair clone preparation failed', { repairId }, err as Error)
      await this.markFailedAndReport(repairId, capability, 'prepare clone failed')
      return
    }

    // 4. Deterministic session (stable across restarts → idempotent recovery).
    const sessionKey = selfhealSessionKey(repairId)
    const session = await this.deps.sessions.getOrCreate({
      sessionKey,
      agent,
      channel: 'selfheal',
      peerId: repairId,
      title: `[selfheal] ${repairId}`,
    })
    await setJobSessionKey(repairId, sessionKey)

    // 5. Execution-side fence (design §A2): the starting→running CAS and the
    //    turn initiation happen inside the per-repair mutex — the SAME lock the
    //    cancel path holds for its CAS + teardown. Cancel-first ⇒ the guarded
    //    CAS below loses (its return value is CHECKED), the session is destroyed
    //    and ZERO turns are submitted. Worker-first ⇒ cancel serializes behind
    //    us, finds the live session and tears it down. The residual sliver
    //    between lock release and runner registration is closed by the
    //    SQLite-transaction guards (enqueue/claim re-check job status in-txn).
    const sink = createRepairTurnSink()
    type TurnResult = { executionId: string; status: string; ranHere: boolean }
    // The critical section returns a WRAPPED promise handle (never the bare
    // promise — async flattening would make the lock wait for the whole turn,
    // deadlocking the cancel path that needs this same lock for teardown).
    const started = await withRepairLock(
      repairId,
      async (): Promise<{ turn: Promise<TurnResult> } | null> => {
        // Guarded CAS *is* the fresh-state terminal check: one atomic UPDATE
        // that only applies while the job is still executable. A cancel that
        // already moved the job to cancelling/cancelled makes this return false.
        const cas = await setJobStatus(repairId, 'running', ['starting', 'running'])
        if (!cas) {
          const now = await getJob(repairId)
          log.info('repair CAS lost to cancel — destroying session, zero submit', {
            repairId,
            status: now?.status,
          })
          await this.teardownSessionQuiet(sessionKey, repairId)
          return null
        }
        // Initiate the turn INSIDE the lock (do not await the full turn here —
        // cancel must be able to take this lock to tear a live turn down).
        return {
          turn: this.deps.sessions.submitWithExecutionId(
            session,
            buildRepairPrompt(repairId, clonePath),
            repairId,
            sink.onEvent,
          ),
        }
      },
    )
    if (!started) return // cancelled — the cancel path owns the job status

    // 6. Await the turn under a renewed lease and settle the job status.
    const leaseTimer = this.startLeaseRenew(repairId)
    try {
      const result = await started.turn
      const finalStatus = await this.finalizeJob(repairId, result, sink.getError())
      if (finalStatus === 'failed') {
        await this.reportFailed(repairId, capability, sink.getError() ?? 'repair execution failed')
      }
    } catch (err) {
      log.error('repair turn threw', { repairId }, err as Error)
      await this.markFailedAndReport(repairId, capability, 'repair turn failed')
    } finally {
      clearInterval(leaseTimer)
    }
  }

  /** Build (or reuse) the per-repair de-privileged clone. Fails closed when the
   *  ocheal uid/gid are not configured (the clone MUST be ocheal-owned). */
  private async ensureRepairClone(repairId: string): Promise<string> {
    const { ochealUid, ochealGid, canonicalRepo, canonicalBranch } = this.deps
    if (ochealUid === undefined || ochealGid === undefined) {
      throw new Error(
        'OC_SELFHEAL_OCHEAL_UID/OC_SELFHEAL_OCHEAL_GID not configured — refusing to build a root-owned repair clone',
      )
    }
    const prepare = this.deps.prepareClone ?? defaultPrepareClone
    const { clonePath } = await prepare({
      repairId,
      canonicalRepo,
      canonicalBranch,
      ochealUid,
      ochealGid,
    })
    return clonePath
  }

  /** Best-effort teardown of a session we must not run (cancel won the fence). */
  private async teardownSessionQuiet(sessionKey: string, repairId: string): Promise<void> {
    try {
      this.deps.sessions.interrupt(sessionKey)
    } catch {
      /* no live turn — fine */
    }
    try {
      await this.deps.sessions.destroySession(sessionKey)
    } catch (err) {
      log.warn('post-cancel session teardown failed', { repairId, sessionKey }, err)
    }
  }

  /** Best-effort failed-callback to the v5 master (capability-authenticated). */
  private async reportFailed(repairId: string, capability: string, message: string): Promise<void> {
    const f = this.deps.fetchImpl ?? fetch
    const url = `${this.deps.callbackBaseUrl.replace(/\/$/, '')}/internal/v5/repairs/${encodeURIComponent(repairId)}/failed`
    try {
      await f(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${capability}`,
        },
        body: JSON.stringify({ message }),
        redirect: 'manual',
        signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
      })
    } catch (err) {
      log.warn('failed-callback to v5 did not go through', { repairId }, err)
    }
  }

  /** Terminalize locally and notify the master only when this worker actually
   *  won the failed CAS. A concurrent cancel owns both status and callbacks. */
  private async markFailedAndReport(
    repairId: string,
    capability: string,
    message: string,
  ): Promise<void> {
    const changed = await setJobStatus(repairId, 'failed', ['starting', 'running'])
    if (changed) await this.reportFailed(repairId, capability, message)
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
  ): Promise<'succeeded' | 'failed' | 'unchanged'> {
    if (result.ranHere) {
      const status = turnError ? 'failed' : 'succeeded'
      const changed = await setJobStatus(repairId, status, ['starting', 'running'])
      return changed ? status : 'unchanged'
    }
    // Deduped: another drive already consumed the turn. Reach a terminal job
    // state that reflects the execution ledger so the job is not re-claimed.
    const exec = await getExecution(repairId)
    const execStatus = exec?.status ?? 'failed'
    const jobStatus = execStatus === 'done' ? 'succeeded' : 'failed'
    log.info('repair turn deduped', { repairId, execStatus, jobStatus })
    const changed = await setJobStatus(repairId, jobStatus, ['starting', 'running'])
    return changed ? jobStatus : 'unchanged'
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
   * Claim the short-lived capability via the shared HMAC-signed primitive
   * ({@link claimSelfhealCapability}). Throws on failure so the caller retries
   * via lease expiry (an EXPLICIT refusal also lands here — the job then keeps
   * failing its claim until the fuse/re-dispatch resolves it, which is correct:
   * the master says this repair must not run).
   */
  private async fetchCapability(repairId: string): Promise<string> {
    return claimSelfhealCapability({
      callbackBaseUrl: this.deps.callbackBaseUrl,
      hmacSecret: this.deps.hmacSecret,
      repairId,
      fetchImpl: this.deps.fetchImpl,
      timeoutMs: CAPABILITY_FETCH_TIMEOUT_MS,
    })
  }

  /**
   * Machine-authored ack callback (capability auth): flips the master-side
   * repair dispatched→acked. Idempotent on the master (an already-acked/active
   * repair re-acks as an event append). Must succeed before the turn starts —
   * the master's progress/done CAS and the ack-budget watchdog both key off
   * the acked state.
   */
  private async postAck(repairId: string, capability: string): Promise<void> {
    await this.postCallback(repairId, capability, 'ack', '执行侧已接单(jobWorker 机器签发)', true)
  }

  /** Machine-authored capability callback (ack/progress/done/failed). Throws on
   *  non-2xx only when `strict` (ack must land before work; done/failed callers
   *  handle their own retry via lease). */
  private async postCallback(
    repairId: string,
    capability: string,
    outcome: 'ack' | 'progress' | 'done' | 'failed',
    message: string,
    strict: boolean,
  ): Promise<void> {
    const url = `${this.deps.callbackBaseUrl.replace(/\/$/, '')}/internal/v5/repairs/${encodeURIComponent(repairId)}/${outcome}`
    const ctrl = new AbortController()
    const timeout = setTimeout(() => ctrl.abort(), CAPABILITY_FETCH_TIMEOUT_MS)
    try {
      const f = this.deps.fetchImpl ?? fetch
      const res = await f(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${capability}` },
        body: JSON.stringify({ message }),
        redirect: 'manual',
        signal: ctrl.signal,
      })
      if (!res.ok && strict) throw new Error(`${outcome} HTTP ${res.status}`)
    } finally {
      clearTimeout(timeout)
    }
  }

  /**
   * Tier1 PURE MACHINE PATH (no clone / no ocheal / no codex). Three-layer
   * intersection: master-frozen opcode == local exact map == remote wrapper's
   * accepted set; any drift fails closed. The SSH is at-most-once via the
   * set-once tier1_receipt (and the opcodes are idempotent, so a crash-replay is
   * harmless). Outcome routing: completed/unknown → machine done (master →
   * verifying, the probe fence adjudicates real recovery); failed → machine
   * failed (action explicitly failed → fuse counts up → human).
   */
  private async executeTier1(
    repairId: string,
    capability: string,
    conditionKey: string,
    actionOpcode: string | null,
  ): Promise<void> {
    // Preflight refusals (never authorized to run) — atomic terminal+outbox,
    // still cancel-safe (the CAS loses if a cancel already terminalized).
    const expected = CONDITION_OPCODE_MAP[conditionKey]
    if (!expected || expected !== actionOpcode) {
      log.error('tier1 opcode drift — refusing', { repairId, conditionKey, actionOpcode, expected })
      await this.tier1Terminal(repairId, ['starting', 'running'], 'failed', {
        opcode: actionOpcode,
        reason: `opcode drift (local map=${expected ?? 'none'} frozen=${actionOpcode ?? 'none'})`,
      })
      return
    }
    const cfg =
      this.deps.hostActionConfig !== undefined ? this.deps.hostActionConfig : hostActionConfigFromEnv()
    if (!cfg) {
      log.error('tier1 host action not provisioned (OC_SELFHEAL_ACTION_HOST/KEY)', { repairId })
      await this.tier1Terminal(repairId, ['starting', 'running'], 'failed', {
        opcode: actionOpcode,
        reason: 'host action host/key not configured',
      })
      return
    }

    // The SSH path runs INSIDE the per-repair lock — the SAME lock a cancel
    // holds (BLOCKER: a cancel must not terminalize between the running CAS and
    // the SSH and still let the action fire). Host actions cannot be remotely
    // cancelled, so we hold the lock through the SSH return and the atomic
    // local settle; a concurrent cancel waits (bounded by the action timeout).
    await withRepairLock(repairId, async () => {
      const cas = await setJobStatus(repairId, 'running', ['starting', 'running'])
      if (!cas) {
        log.info('tier1 CAS lost to cancel — zero action', { repairId })
        return
      }
      // AT-MOST-ONCE (BLOCKER): durable pre-claim gates a single SSH; a crash
      // after claim but before receipt settles as 'unknown' (never re-sent).
      const receipt = await this.resolveTier1Receipt(repairId, actionOpcode as string, cfg)
      // 'rejected' = never authorized to run ⇒ FAILED. Everything the host
      // actually attempted (completed/action_failed/unknown) ⇒ DONE → verifying;
      // only a fresh master probe decides real recovery.
      const phase: 'done' | 'failed' = receipt.outcome === 'rejected' ? 'failed' : 'done'
      await this.tier1Terminal(repairId, ['running'], phase === 'done' ? 'succeeded' : 'failed', {
        opcode: actionOpcode,
        host: receipt.host,
        outcome: receipt.outcome,
        exit: receipt.exit,
        durationMs: receipt.durationMs,
        receipt: receipt.detail,
      })
      log.info('tier1 settled', { repairId, opcode: actionOpcode, outcome: receipt.outcome, phase })
    })
  }

  /** Atomic Tier1 terminal: CAS job → terminal AND enqueue the outbox callback
   *  in ONE transaction. The CAS gates the enqueue (a cancel that terminalized
   *  first makes it lose → no stale callback). Every Tier1 terminal path goes
   *  through here — no best-effort fire-and-forget remains. */
  private async tier1Terminal(
    repairId: string,
    fromStatuses: ('starting' | 'running')[],
    toStatus: 'succeeded' | 'failed',
    detail: Record<string, unknown>,
  ): Promise<void> {
    const phase: 'done' | 'failed' = toStatus === 'succeeded' ? 'done' : 'failed'
    const message = `[tier1 ${String(detail.opcode ?? '?')}] ${String(detail.outcome ?? detail.reason ?? phase)}`
    const won = await terminalizeTier1WithCallback({
      repairId,
      fromStatuses,
      toStatus,
      phase,
      message,
      detail,
    })
    if (!won) log.info('tier1 terminal CAS lost (cancel won) — no callback enqueued', { repairId })
  }

  /**
   * Durable at-most-once resolution of the Tier1 receipt:
   *  - a receipt already on the row  → committed earlier; reuse (idempotent).
   *  - won the pre-claim             → transmit ONCE, persist the receipt.
   *  - lost the pre-claim, no receipt → a prior claim crashed before settling;
   *    treat as 'unknown' (the action MAY have run — never re-transmit).
   */
  private async resolveTier1Receipt(
    repairId: string,
    opcode: string,
    cfg: HostActionConfig,
  ): Promise<HostActionReceipt> {
    const existing = await getJob(repairId)
    if (existing?.tier1Receipt) {
      return JSON.parse(existing.tier1Receipt) as HostActionReceipt
    }
    const won = await claimJobTier1(repairId)
    if (!won) {
      const j = await getJob(repairId)
      if (j?.tier1Receipt) return JSON.parse(j.tier1Receipt) as HostActionReceipt
      // Pre-claim held by a prior (crashed) attempt, no receipt → ambiguous.
      // Persist an 'unknown' receipt (set-once) so re-claims are idempotent; a
      // concurrent real receipt, if any, wins the set-once and is reused.
      log.warn('tier1 pre-claim held without receipt — settling unknown (no replay)', { repairId })
      const unknownReceipt: HostActionReceipt = {
        opcode,
        outcome: 'unknown',
        exit: -1,
        host: cfg.host,
        startedAt: 0,
        finishedAt: 0,
        durationMs: 0,
        detail: { reason: 'crashed after pre-claim before receipt — not re-transmitted' },
      }
      await setJobTier1Receipt(repairId, JSON.stringify(unknownReceipt))
      const j2 = await getJob(repairId)
      return j2?.tier1Receipt ? (JSON.parse(j2.tier1Receipt) as HostActionReceipt) : unknownReceipt
    }
    const exec = this.deps.executeHostOpcode ?? executeHostOpcode
    const receipt = await exec(opcode, cfg)
    await setJobTier1Receipt(repairId, JSON.stringify(receipt))
    // Read the PERSISTED receipt back and use it (MAJOR): under a graceful
    // shutdown a re-claim may have written a synthetic 'unknown' while this
    // (old-owner) SSH was in flight; set-once picks ONE evidence, and every
    // competitor must settle from that single SQLite winner — never its own
    // in-memory copy — so the receipt, the terminal status and the outbox
    // detail can never diverge into two authorities.
    const persisted = await getJob(repairId)
    const winner = persisted?.tier1Receipt
      ? (JSON.parse(persisted.tier1Receipt) as HostActionReceipt)
      : receipt
    log.info('tier1 opcode executed', {
      repairId,
      opcode,
      outcome: winner.outcome,
      exit: winner.exit,
      durationMs: winner.durationMs,
    })
    return winner
  }

  /**
   * Fetch the AUTHORITATIVE condition key from the v5 master context (capability
   * auth). This is the value the broker's drill authorization reads — it must be
   * frozen onto the job row BEFORE any repair turn starts (fail-closed: a repair
   * whose key cannot be frozen does not run this tick). Only the condition key
   * is extracted; the full context stays a model-side pull via `oc-selfheal
   * context` so no free-text detour opens here.
   */
  private async fetchRouting(
    repairId: string,
    capability: string,
  ): Promise<{ conditionKey: string; executionClass: 'tier1' | 'tier2'; actionOpcode: string | null }> {
    const url = `${this.deps.callbackBaseUrl.replace(/\/$/, '')}/internal/v5/repairs/${encodeURIComponent(repairId)}/context`
    const ctrl = new AbortController()
    const timeout = setTimeout(() => ctrl.abort(), CAPABILITY_FETCH_TIMEOUT_MS)
    try {
      const f = this.deps.fetchImpl ?? fetch
      const res = await f(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${capability}` },
        redirect: 'manual',
        signal: ctrl.signal,
      })
      if (!res.ok) throw new Error(`context HTTP ${res.status}`)
      // Master returns the RepairContext object directly (v5
      // http/internal/selfhealRepairs.ts `context` route): conditionKey +
      // executionClass + actionOpcode are top-level fields.
      const body = (await res.json()) as {
        conditionKey?: unknown
        executionClass?: unknown
        actionOpcode?: unknown
        tier?: unknown
      }
      const key = body?.conditionKey
      if (typeof key !== 'string' || key.length === 0 || key.length > 256) {
        throw new Error('context response carries no usable conditionKey')
      }
      // STRICT (BLOCKER1): unknown/absent executionClass is REJECTED, never
      // silently defaulted to tier2. tier and executionClass must agree (both
      // derive from the frozen r.tier on the master); tier1⇔opcode consistency
      // is enforced. Any inconsistency fails closed → lease retry.
      const executionClass = body?.executionClass
      if (executionClass !== 'tier1' && executionClass !== 'tier2') {
        throw new Error(`context executionClass invalid: ${String(executionClass)}`)
      }
      // tier is REQUIRED and must agree (master contract always returns it).
      if (body?.tier !== executionClass) {
        throw new Error(`context tier/executionClass mismatch: ${String(body?.tier)} vs ${executionClass}`)
      }
      const actionOpcode = typeof body?.actionOpcode === 'string' ? body.actionOpcode : null
      if (executionClass === 'tier1' && !actionOpcode) {
        throw new Error('tier1 routing missing actionOpcode')
      }
      if (executionClass === 'tier2' && actionOpcode) {
        throw new Error('tier2 routing must not carry an actionOpcode')
      }
      return { conditionKey: key, executionClass, actionOpcode }
    } finally {
      clearTimeout(timeout)
    }
  }
}
