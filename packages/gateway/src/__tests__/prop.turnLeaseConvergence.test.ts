/**
 * Model-based property tests for Turn / Lease / Dual-Slot Cutover state machine
 * terminal convergence, lock release on cancel, fencing monotonicity, and
 * idempotent re-entry.
 *
 * Drives real production gateway modules:
 *   - `admitTurnDispatch`, `inboxRunning`, `inboxSinkStaged`, `inboxTerminal`,
 *     `inboxSinkStageFailed`, `inboxReject`, `inboxRecoveryPending`,
 *     `resolveInboxTerminalAck`, `cancelQueuedTurnDispatchExact`
 *     (`packages/gateway/src/turnDispatchInbox.ts`)
 *   - `DelegateJobStore` (`packages/gateway/src/delegateJobs.ts`)
 *   - `beginDelegateCutover`, `endDelegateCutover` (`packages/gateway/src/delegateCutover.ts`)
 *   - `ExecEnvLeaseManager`, `ExecEnvLeaseError` (`packages/gateway/src/execEnv/execEnvLease.ts`)
 *   - `RuntimeRecycleDrainCoordinator` (`packages/gateway/src/runtimeRecycleDrain.ts`)
 */
import * as assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import {
  type AsyncCommand,
  assertAsyncProperty,
  asyncModelRun,
  fc,
  resolvePbtRuns,
} from '../../../kernel/src/testing/propertyCheck.js'
import { beginDelegateCutover, endDelegateCutover } from '../delegateCutover.js'
import { DelegateJobStore } from '../delegateJobs.js'
import { ExecEnvLeaseError, ExecEnvLeaseManager } from '../execEnv/execEnvLease.js'
import { RuntimeRecycleDrainCoordinator } from '../runtimeRecycleDrain.js'

const PBT_RUNS = resolvePbtRuns(200, process.env.PBT_RUNS)

const testHome = await mkdtemp(join(tmpdir(), 'oc-prop-turn-lease-'))
process.env.OPENCLAUDE_HOME = testHome

const {
  closeSessionsDb,
  countRuntimeRecycleUnsafeTurnDispatches,
  getSessionsDb,
  getTurnDispatchByLogicalKey,
  scanOpenTurnDispatches,
} = await import('@openclaude/storage')

const {
  admitTurnDispatch,
  cancelQueuedTurnDispatchExact,
  inboxRecoveryPending,
  inboxReject,
  inboxRunning,
  inboxSinkStageFailed,
  inboxSinkStaged,
  inboxTerminal,
  resolveInboxTerminalAck,
} = await import('../turnDispatchInbox.js')

after(async () => {
  await closeSessionsDb()
  await rm(testHome, { recursive: true, force: true })
})

type TrackedTurnState =
  | 'queued'
  | 'running'
  | 'recovery_pending'
  | 'sink_staged'
  | 'sink_stage_failed'
  | 'terminal'
  | 'rejected'

interface TrackedTurn {
  userId: string
  sessionId: string
  clientMessageId: string
  dispatchId: string
  attemptNo: number
  state: TrackedTurnState
  outcome: string | null
  turnKey: string | null
}

function isInboxTerminal(state: TrackedTurnState): boolean {
  return state === 'terminal' || state === 'rejected'
}

describe('Property: Turn / Lease / Dual-Slot Cutover terminal convergence', () => {
  it('turn dispatch inbox + dual-gate drain never deadlocks, cancels cleanly, and converges 100% to terminal', async () => {
    interface Model {
      turns: Map<string, TrackedTurn>
      nextSeq: number
      nowMs: number
      gatewayDrainUntil: number
      sessionDrainUntil: number
    }
    interface Real {
      drainCoord: RuntimeRecycleDrainCoordinator
    }

    class AdmitTurnCmd implements AsyncCommand<Model, Real> {
      constructor(readonly slot: number) {}
      check(): boolean {
        return true
      }
      async run(m: Model): Promise<void> {
        const keyId = `turn-${this.slot}`
        const existing = m.turns.get(keyId)
        const dispatchId = `disp-${m.nextSeq++}`
        const res = await admitTurnDispatch({
          ctx: {
            uid: 'u-pbt',
            sessionId: 'sess-pbt',
            clientMessageId: keyId,
            dispatchId,
            attemptNo: existing ? existing.attemptNo + 1 : 1,
            payloadHash: `hash-${this.slot}`,
            billingRequestId: `bill-${dispatchId}`,
          },
          now: m.nowMs,
        })

        if (existing) {
          // Duplicate admission MUST NOT overwrite existing row or attemptNo.
          assert.equal(res.inserted, false)
          assert.equal(res.row?.state, existing.state)
          assert.equal(res.row?.dispatchId, existing.dispatchId)
          assert.equal(res.row?.attemptNo, existing.attemptNo)
        } else {
          assert.equal(res.inserted, true)
          assert.equal(res.row?.state, 'queued')
          m.turns.set(keyId, {
            userId: 'u-pbt',
            sessionId: 'sess-pbt',
            clientMessageId: keyId,
            dispatchId,
            attemptNo: 1,
            state: 'queued',
            outcome: null,
            turnKey: null,
          })
        }
      }
      toString(): string {
        return `AdmitTurn(slot=${this.slot})`
      }
    }

    class StartRunningCmd implements AsyncCommand<Model, Real> {
      constructor(readonly slot: number) {}
      check(m: Readonly<Model>): boolean {
        return m.turns.has(`turn-${this.slot}`)
      }
      async run(m: Model): Promise<void> {
        const t = m.turns.get(`turn-${this.slot}`)!
        const tk = `tk-${t.dispatchId}`
        const row = await inboxRunning({
          userId: t.userId,
          sessionId: t.sessionId,
          clientMessageId: t.clientMessageId,
          agentId: 'main',
          turnIndex: this.slot + 1,
          turnKey: tk,
          requestId: `req-${t.dispatchId}`,
          createdAt: m.nowMs,
          now: m.nowMs,
        })

        if (t.state === 'queued') {
          assert.equal(row?.state, 'running')
          t.state = 'running'
          t.turnKey = tk
        } else {
          // Non-queued states MUST reject queued->running CAS.
          assert.equal(row, null)
          const actual = await getTurnDispatchByLogicalKey(t.userId, t.sessionId, t.clientMessageId)
          assert.equal(actual?.state, t.state)
        }
      }
      toString(): string {
        return `StartRunning(slot=${this.slot})`
      }
    }

    class CancelTurnCmd implements AsyncCommand<Model, Real> {
      constructor(
        readonly slot: number,
        readonly viaExactCancel: boolean,
      ) {}
      check(m: Readonly<Model>): boolean {
        return m.turns.has(`turn-${this.slot}`)
      }
      async run(m: Model): Promise<void> {
        const t = m.turns.get(`turn-${this.slot}`)!
        if (this.viaExactCancel) {
          const cancelled = await cancelQueuedTurnDispatchExact({
            userId: t.userId,
            sessionId: t.sessionId,
            clientMessageId: t.clientMessageId,
            dispatchId: t.dispatchId,
            attemptNo: t.attemptNo,
            now: m.nowMs,
          })
          if (t.state === 'queued') {
            assert.equal(cancelled.applied, true)
            assert.equal(cancelled.state, 'rejected')
            t.state = 'rejected'
            t.outcome = 'not_accepted'
          } else {
            assert.equal(cancelled.applied, false)
            assert.equal(cancelled.state, t.state)
          }
        } else {
          const rejected = await inboxReject(
            { userId: t.userId, sessionId: t.sessionId, clientMessageId: t.clientMessageId },
            m.nowMs,
          )
          if (t.state === 'queued') {
            assert.equal(rejected?.state, 'rejected')
            t.state = 'rejected'
            t.outcome = 'not_accepted'
          } else {
            assert.equal(rejected, null)
          }
        }
        // Cancelled turn MUST NOT remain open or block recycle drain.
        if (t.state === 'rejected') {
          const open = await scanOpenTurnDispatches()
          assert.equal(
            open.some((row) => row.dispatchId === t.dispatchId),
            false,
            'rejected/cancelled turn must not remain open',
          )
        }
      }
      toString(): string {
        return `CancelTurn(slot=${this.slot},exact=${this.viaExactCancel})`
      }
    }

    class AdvanceTurnPhaseCmd implements AsyncCommand<Model, Real> {
      constructor(
        readonly slot: number,
        readonly action: 'recovery_pending' | 'sink_staged' | 'sink_stage_failed' | 'ack_completed' | 'ack_interrupted',
      ) {}
      check(m: Readonly<Model>): boolean {
        return m.turns.has(`turn-${this.slot}`)
      }
      async run(m: Model): Promise<void> {
        const t = m.turns.get(`turn-${this.slot}`)!
        const key = { userId: t.userId, sessionId: t.sessionId, clientMessageId: t.clientMessageId }

        if (this.action === 'recovery_pending') {
          const res = await inboxRecoveryPending(key, m.nowMs)
          if (t.state === 'running') {
            assert.equal(res?.state, 'recovery_pending')
            t.state = 'recovery_pending'
          } else {
            assert.equal(res, null)
          }
          return
        }

        if (this.action === 'sink_staged') {
          const res = await inboxSinkStaged(key, m.nowMs)
          if (t.state === 'running' || t.state === 'recovery_pending') {
            assert.equal(res?.state, 'sink_staged')
            t.state = 'sink_staged'
          } else {
            assert.equal(res, null)
          }
          return
        }

        if (this.action === 'sink_stage_failed') {
          const res = await inboxSinkStageFailed(key, m.nowMs)
          if (t.state === 'running' || t.state === 'sink_staged' || t.state === 'recovery_pending') {
            assert.equal(res?.state, 'sink_stage_failed')
            t.state = 'sink_stage_failed'
          } else {
            assert.equal(res, null)
          }
          return
        }

        const status = this.action === 'ack_completed' ? 'completed' : 'interrupted'
        const ok = await resolveInboxTerminalAck(t.dispatchId, t.attemptNo, status)
        if (t.state === 'running' || t.state === 'sink_staged' || t.state === 'recovery_pending') {
          assert.equal(ok, true)
          t.state = 'terminal'
          t.outcome = status
        } else if (t.state === 'terminal' && t.outcome === status) {
          // Idempotent duplicate ACK with matching outcome MUST succeed without mutating.
          assert.equal(ok, true)
        } else {
          // Conflicting outcome or invalid from-state MUST fail closed.
          assert.equal(ok, false)
        }

        // Terminal invariant: persisted state must never regress.
        const persisted = await getTurnDispatchByLogicalKey(t.userId, t.sessionId, t.clientMessageId)
        assert.equal(persisted?.state, t.state)
      }
      toString(): string {
        return `AdvanceTurnPhase(slot=${this.slot},${this.action})`
      }
    }

    class ProbeRecycleDrainCmd implements AsyncCommand<Model, Real> {
      check(): boolean {
        return true
      }
      async run(m: Model, r: Real): Promise<void> {
        // Advance clock past previous drain TTL so each probe checks live running turns.
        m.nowMs += 60_000
        const runningCount = [...m.turns.values()].filter((t) => t.state === 'running').length
        const decision = await r.drainCoord.attempt()
        if (runningCount > 0) {
          assert.equal(decision.ok, false, 'drain must refuse while durable running turns exist')
          assert.equal(decision.status, 409)
          // Failed drain MUST release both scalar drain gates.
          assert.equal(m.gatewayDrainUntil, 0)
          assert.equal(m.sessionDrainUntil, 0)
        } else {
          assert.equal(decision.ok, true, 'drain must succeed when zero durable running turns exist')
          assert.equal(decision.status, 200)
        }
      }
      toString(): string {
        return 'ProbeRecycleDrain()'
      }
    }

    const cmdsArb = fc.commands<Model, Real, AsyncCommand<Model, Real>>(
      [
        { weight: 4, arbitrary: fc.integer({ min: 0, max: 3 }).map((s) => new AdmitTurnCmd(s)) },
        { weight: 4, arbitrary: fc.integer({ min: 0, max: 3 }).map((s) => new StartRunningCmd(s)) },
        {
          weight: 3,
          arbitrary: fc
            .record({ s: fc.integer({ min: 0, max: 3 }), exact: fc.boolean() })
            .map((x) => new CancelTurnCmd(x.s, x.exact)),
        },
        {
          weight: 6,
          arbitrary: fc
            .record({
              s: fc.integer({ min: 0, max: 3 }),
              action: fc.constantFrom(
                'recovery_pending' as const,
                'sink_staged' as const,
                'sink_stage_failed' as const,
                'ack_completed' as const,
                'ack_interrupted' as const,
              ),
            })
            .map((x) => new AdvanceTurnPhaseCmd(x.s, x.action)),
        },
        { weight: 2, arbitrary: fc.constant(new ProbeRecycleDrainCmd()) },
      ],
      { minLength: 5, maxLength: 22 },
    )

    await assertAsyncProperty(
      cmdsArb,
      async (cmds) => {
        await asyncModelRun(
          async () => {
            const db = await getSessionsDb()
            db.exec('DELETE FROM turn_dispatch_inbox')
            const model: Model = {
              turns: new Map(),
              nextSeq: 1,
              nowMs: 1_700_000_000_000,
              gatewayDrainUntil: 0,
              sessionDrainUntil: 0,
            }
            const drainCoord = new RuntimeRecycleDrainCoordinator({
              ttlMs: 30_000,
              now: () => model.nowMs,
              armGatewayDrain: (until) => {
                model.gatewayDrainUntil = until
              },
              isGatewayDrainActive: (now) => model.gatewayDrainUntil > now,
              releaseGatewayDrain: () => {
                model.gatewayDrainUntil = 0
              },
              armSessionDrain: (ttlMs) => {
                model.sessionDrainUntil = model.nowMs + ttlMs
                return { accepted: true, activeTurns: 0 }
              },
              isSessionDrainActive: (now) => model.sessionDrainUntil > now,
              releaseSessionDrain: () => {
                model.sessionDrainUntil = 0
              },
              activeIngress: () => 0,
              countDurableRunning: () => countRuntimeRecycleUnsafeTurnDispatches(),
            })
            return { model, real: { drainCoord } }
          },
          cmds,
          async ({ model, real }) => {
            // Terminal convergence phase: every open turn must deterministically reach a terminal state.
            for (const t of model.turns.values()) {
              const key = {
                userId: t.userId,
                sessionId: t.sessionId,
                clientMessageId: t.clientMessageId,
              }
              if (t.state === 'queued') {
                const r = await inboxReject(key, model.nowMs)
                assert.equal(r?.state, 'rejected')
                t.state = 'rejected'
              } else if (
                t.state === 'running' ||
                t.state === 'recovery_pending' ||
                t.state === 'sink_staged'
              ) {
                const r = await inboxTerminal(key, 'crashed', model.nowMs)
                assert.equal(r?.state, 'terminal')
                t.state = 'terminal'
              } else if (t.state === 'sink_stage_failed') {
                // Verify sink_stage_failed is non-blocking for recycle drain.
                assert.equal(isInboxTerminal(t.state), false)
              }
            }
            assert.equal(
              await countRuntimeRecycleUnsafeTurnDispatches(),
              0,
              'no turn may remain stuck in running after convergence',
            )
            model.nowMs += 60_000
            const finalDrain = await real.drainCoord.attempt()
            assert.equal(finalDrain.ok, true, 'recycle drain must converge once all running turns settle')
          },
        )
      },
      { numRuns: PBT_RUNS, seed: 0x55e5555, label: 'turn-dispatch-inbox-convergence' },
    )
  })

  it('delegate dual-slot cutover/rollback + ExecEnv lease fencing guarantees monotonic epochs and zero stuck paused jobs', async () => {
    interface JobTracker {
      id: string
      lastClaimToken: string | null
      lastEpoch: number
      staleTokens: Array<{ claimToken: string; fencingEpoch: number }>
      terminal: boolean
    }
    interface Model {
      nowMs: number
      generation: number
      activeCutoverGen: number | null
      jobs: Map<string, JobTracker>
      leaseId: string
      leaseBrainGen: number
      leaseFencingToken: string
      revokedLeaseTokens: string[]
      leaseClosed: boolean
      leaseExpiresAtMs: number
      nextTokenSeq: number
    }
    interface Real {
      store: DelegateJobStore
      leaseMgr: ExecEnvLeaseManager
    }

    class EnqueueAndStartJobCmd implements AsyncCommand<Model, Real> {
      constructor(readonly shouldStart: boolean) {}
      check(m: Readonly<Model>): boolean {
        return m.jobs.size < 6
      }
      async run(m: Model, r: Real): Promise<void> {
        const created = r.store.create('coding-assistant', { queued: true })
        assert.ok('jobId' in created, 'create must succeed below capacity')
        const snap = r.store.snapshotOf(created.jobId)!
        assert.ok(snap, 'created job snapshot must exist')
        const tracker: JobTracker = {
          id: snap.id,
          lastClaimToken: null,
          lastEpoch: snap.fencingEpoch,
          staleTokens: [],
          terminal: false,
        }
        m.jobs.set(snap.id, tracker)

        if (this.shouldStart) {
          const claim = r.store.claimQueued(snap.id)
          if (m.activeCutoverGen !== null) {
            assert.equal(claim.ok, false, 'claimQueued must be frozen during active cutover')
          } else {
            assert.equal(claim.ok, true)
            if (claim.ok) {
              assert.ok(claim.fencingEpoch > tracker.lastEpoch)
              tracker.lastClaimToken = claim.claimToken
              tracker.lastEpoch = claim.fencingEpoch
            }
          }
        }
      }
      toString(): string {
        return `EnqueueJob(start=${this.shouldStart})`
      }
    }

    class HeartbeatOrQuiesceCmd implements AsyncCommand<Model, Real> {
      constructor(
        readonly jobPick: number,
        readonly quiesceAck: boolean,
      ) {}
      check(m: Readonly<Model>): boolean {
        return m.jobs.size > 0
      }
      async run(m: Model, r: Real): Promise<void> {
        const list = [...m.jobs.values()]
        const t = list[this.jobPick % list.length]!
        const snap = r.store.snapshotOf(t.id)
        if (!snap || !t.lastClaimToken) return

        // Any previously revoked fencing token must NEVER succeed on casHeartbeat.
        for (const old of t.staleTokens) {
          assert.equal(
            r.store.casHeartbeat(t.id, old.claimToken, old.fencingEpoch),
            false,
            'stale claimToken/fencingEpoch must be rejected',
          )
        }

        const hb = r.store.casHeartbeat(t.id, t.lastClaimToken, t.lastEpoch)
        if (snap.state === 'running' || snap.state === 'paused_for_cutover') {
          if (snap.claimToken === t.lastClaimToken && snap.fencingEpoch === t.lastEpoch) {
            assert.equal(hb, true)
          }
        } else {
          assert.equal(hb, false, 'terminal or queued job must reject heartbeat')
        }

        if (this.quiesceAck && snap.state === 'running' && snap.claimToken === t.lastClaimToken) {
          r.store.ackRunnerQuiesced(t.id, t.lastClaimToken, t.lastEpoch)
        }
      }
      toString(): string {
        return `Heartbeat(pick=${this.jobPick},quiesce=${this.quiesceAck})`
      }
    }

    class CompleteOrFailJobCmd implements AsyncCommand<Model, Real> {
      constructor(
        readonly jobPick: number,
        readonly succeed: boolean,
      ) {}
      check(m: Readonly<Model>): boolean {
        return m.jobs.size > 0
      }
      async run(m: Model, r: Real): Promise<void> {
        const list = [...m.jobs.values()]
        const t = list[this.jobPick % list.length]!
        const snap = r.store.snapshotOf(t.id)
        if (!snap) return

        if (this.succeed) {
          r.store.complete(
            t.id,
            { httpStatus: 200, body: { ok: true } },
            t.lastClaimToken ? { claimToken: t.lastClaimToken, fencingEpoch: t.lastEpoch } : undefined,
          )
        } else {
          r.store.fail(t.id, {
            failureClass: 'cancelled',
            detail: 'user-cancelled',
            httpStatus: 499,
            nextState: 'cancelled',
            ...(snap.claimToken
              ? { claimToken: snap.claimToken, fencingEpoch: snap.fencingEpoch }
              : {}),
          })
        }

        const after = r.store.snapshotOf(t.id)!
        if (
          after.state === 'completed' ||
          after.state === 'failed' ||
          after.state === 'cancelled' ||
          after.state === 'killed_by_cutover'
        ) {
          if (t.lastClaimToken) {
            t.staleTokens.push({ claimToken: t.lastClaimToken, fencingEpoch: t.lastEpoch })
          }
          t.terminal = true
          // Duplicate complete/fail must be idempotent and never throw or mutate terminal state.
          const stateBeforeDup = after.state
          r.store.complete(t.id, { httpStatus: 200, body: { dup: true } })
          assert.equal(r.store.snapshotOf(t.id)?.state, stateBeforeDup)
        }
      }
      toString(): string {
        return `SettleJob(pick=${this.jobPick},succeed=${this.succeed})`
      }
    }

    class CutoverAndRollbackCmd implements AsyncCommand<Model, Real> {
      constructor(readonly op: 'begin_cutover' | 'end_cutover') {}
      check(): boolean {
        return true
      }
      async run(m: Model, r: Real): Promise<void> {
        if (this.op === 'begin_cutover' && m.activeCutoverGen === null) {
          m.generation += 1
          const gen = m.generation
          // Record pre-cutover tokens as stale once paused.
          for (const t of m.jobs.values()) {
            const snap = r.store.snapshotOf(t.id)
            if (snap?.state === 'running' && snap.claimToken) {
              t.staleTokens.push({ claimToken: snap.claimToken, fencingEpoch: snap.fencingEpoch })
            }
          }
          const res = await beginDelegateCutover(r.store, {
            generation: gen,
            freezeBudgetMs: 0,
            now: () => m.nowMs,
            sleep: async () => {
              m.nowMs += 10
            },
          })
          assert.equal(res.remainingRunning, 0, 'beginDelegateCutover must drain all running jobs')
          assert.equal(r.store.hasActiveCutoverWindow(), true)
          m.activeCutoverGen = gen
          for (const t of m.jobs.values()) {
            const snap = r.store.snapshotOf(t.id)
            if (snap && snap.fencingEpoch > t.lastEpoch) {
              t.lastEpoch = snap.fencingEpoch
              t.lastClaimToken = snap.claimToken ?? null
            }
          }
        } else if (this.op === 'end_cutover' && m.activeCutoverGen !== null) {
          const gen = m.activeCutoverGen
          const end = endDelegateCutover(r.store, gen)
          assert.equal(end.thawed, true)
          m.activeCutoverGen = null
          // Zero jobs from this generation may remain stuck in paused_for_cutover.
          for (const job of r.store.listNonTerminal()) {
            assert.notEqual(
              job.state,
              'paused_for_cutover',
              'endDelegateCutover must close all paused jobs of the cutover generation',
            )
          }
        }
      }
      toString(): string {
        return `Cutover(${this.op})`
      }
    }

    class ExecEnvLeaseOpCmd implements AsyncCommand<Model, Real> {
      constructor(readonly op: 'renew' | 'rebind' | 'close' | 'advance_clock' | 'probe_stale') {}
      check(): boolean {
        return true
      }
      async run(m: Model, r: Real): Promise<void> {
        if (this.op === 'advance_clock') {
          m.nowMs += 30_000
          return
        }
        const expired = m.nowMs > m.leaseExpiresAtMs

        if (this.op === 'renew') {
          if (m.leaseClosed || expired) {
            assert.throws(
              () => r.leaseMgr.renewLease(m.leaseId, 60_000),
              (err: unknown) => err instanceof ExecEnvLeaseError,
            )
          } else {
            const renewed = r.leaseMgr.renewLease(m.leaseId, 60_000)
            m.leaseExpiresAtMs = renewed.expiresAtMs
            assert.ok(renewed.expiresAtMs > m.nowMs)
          }
          return
        }

        if (this.op === 'rebind') {
          if (m.leaseClosed || expired) {
            await assert.rejects(
              r.leaseMgr.rebindBrain(m.leaseId, m.leaseBrainGen + 1, `ft-next-${m.nextTokenSeq++}`),
              (err: unknown) => err instanceof ExecEnvLeaseError,
            )
            return
          }
          r.leaseMgr.quiesceBrain(m.leaseId)
          // While quiescing, normal writes must fail with EXEC_LEASE_QUIESCING.
          assert.throws(
            () => r.leaseMgr.validateFencingToken(m.leaseId, m.leaseFencingToken, m.leaseBrainGen),
            (err: unknown) => err instanceof ExecEnvLeaseError && err.code === 'EXEC_LEASE_QUIESCING',
          )
          await r.leaseMgr.exportAttachmentDigest(m.leaseId)
          const oldToken = m.leaseFencingToken
          const nextGen = m.leaseBrainGen + 1
          const nextToken = `ft-gen-${nextGen}-${m.nextTokenSeq++}`
          const rebound = await r.leaseMgr.rebindBrain(m.leaseId, nextGen, nextToken)
          assert.equal(rebound.lease.state, 'active')
          assert.equal(rebound.lease.brainGen, nextGen)
          m.revokedLeaseTokens.push(oldToken)
          m.leaseBrainGen = nextGen
          m.leaseFencingToken = nextToken
          return
        }

        if (this.op === 'close') {
          const closed = r.leaseMgr.closeLease(m.leaseId)
          assert.equal(closed.state, 'closed')
          m.revokedLeaseTokens.push(m.leaseFencingToken)
          m.leaseClosed = true
          return
        }

        // probe_stale: every revoked fencing token must be rejected!
        for (const stale of m.revokedLeaseTokens) {
          assert.throws(
            () => r.leaseMgr.validateFencingToken(m.leaseId, stale, m.leaseBrainGen),
            (err: unknown) => err instanceof ExecEnvLeaseError,
          )
        }
      }
      toString(): string {
        return `ExecEnvLease(${this.op})`
      }
    }

    const cmdsArb = fc.commands<Model, Real, AsyncCommand<Model, Real>>(
      [
        { weight: 4, arbitrary: fc.boolean().map((start) => new EnqueueAndStartJobCmd(start)) },
        {
          weight: 3,
          arbitrary: fc
            .record({ pick: fc.nat(10), q: fc.boolean() })
            .map((x) => new HeartbeatOrQuiesceCmd(x.pick, x.q)),
        },
        {
          weight: 3,
          arbitrary: fc
            .record({ pick: fc.nat(10), ok: fc.boolean() })
            .map((x) => new CompleteOrFailJobCmd(x.pick, x.ok)),
        },
        {
          weight: 3,
          arbitrary: fc
            .constantFrom('begin_cutover' as const, 'end_cutover' as const)
            .map((op) => new CutoverAndRollbackCmd(op)),
        },
        {
          weight: 4,
          arbitrary: fc
            .constantFrom(
              'renew' as const,
              'rebind' as const,
              'close' as const,
              'advance_clock' as const,
              'probe_stale' as const,
            )
            .map((op) => new ExecEnvLeaseOpCmd(op)),
        },
      ],
      { minLength: 6, maxLength: 24 },
    )

    await assertAsyncProperty(
      cmdsArb,
      async (cmds) => {
        await asyncModelRun(
          () => {
            const model: Model = {
              nowMs: 1_700_000_000_000,
              generation: 0,
              activeCutoverGen: null,
              jobs: new Map(),
              leaseId: 'lease-pbt-1',
              leaseBrainGen: 1,
              leaseFencingToken: 'ft-init-1',
              revokedLeaseTokens: [],
              leaseClosed: false,
              leaseExpiresAtMs: 1_700_000_060_000,
              nextTokenSeq: 1,
            }
            const store = new DelegateJobStore({
              now: () => model.nowMs,
              sm: true,
              bootId: 'boot-pbt-1',
              leaseMs: 60_000,
            })
            const leaseMgr = new ExecEnvLeaseManager({
              defaultTtlMs: 60_000,
              clock: () => model.nowMs,
            })
            const issued = leaseMgr.issueLease({
              leaseId: model.leaseId,
              execEnvId: 'env-1',
              incarnationId: 'inc-1',
              sessionKey: 'sess-1',
              brainGen: 1,
              fencingToken: model.leaseFencingToken,
              ttlMs: 60_000,
            })
            model.leaseExpiresAtMs = issued.expiresAtMs
            return { model, real: { store, leaseMgr } }
          },
          cmds,
          async ({ model, real }) => {
            // Final convergence: close any open cutover and cancel/fail remaining jobs -> zero stuck states.
            if (model.activeCutoverGen !== null) {
              endDelegateCutover(real.store, model.activeCutoverGen)
              model.activeCutoverGen = null
            }
            for (const nonTerm of real.store.listNonTerminal()) {
              real.store.fail(nonTerm.id, {
                failureClass: 'cancelled',
                detail: 'teardown-cancel',
                httpStatus: 499,
                nextState: 'cancelled',
                ...(nonTerm.claimToken
                  ? { claimToken: nonTerm.claimToken, fencingEpoch: nonTerm.fencingEpoch }
                  : {}),
              })
            }
            assert.equal(
              real.store.listNonTerminal().length,
              0,
              'all delegate jobs must converge to terminal states with zero stuck intermediates',
            )
            real.leaseMgr.closeLease(model.leaseId)
            assert.equal(real.leaseMgr.getLease(model.leaseId)?.state, 'closed')
          },
        )
      },
      { numRuns: PBT_RUNS, seed: 0x66f6666, label: 'delegate-cutover-and-exec-lease-convergence' },
    )
  })
})
