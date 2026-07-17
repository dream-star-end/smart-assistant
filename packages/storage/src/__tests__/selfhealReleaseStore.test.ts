import * as assert from 'node:assert/strict'
/**
 * Tests for the batch1b release-deployment ledger (selfheal_release_jobs +
 * selfheal_release_fuse) and the callback-outbox release extension.
 *
 * Covers: intake idempotency (inserted/duplicate/conflict); pre-claim CAS +
 * GLOBAL singleflight + atomic deploying callback; set-once double-write
 * rejection (checkpoint / receipt read-back / canonical push); terminalize CAS
 * miss → NO callback enqueued (behavioral outbox assertion); cancel three-state
 * (+ not_found); fuse idempotent engage/clear; the outbox rebuild guard
 * (legacy schema pre-seeded BEFORE import → migrated in place, data preserved,
 * new column + the two PARTIAL unique indexes enforcing repair-vs-release
 * dedup); and per-repair ordering of release callbacks in claimDueCallbacks.
 *
 * The LEGACY outbox schema is created BEFORE the store module is first imported
 * (singleton per process) so the on-open guard is exercised — mirroring
 * selfhealStoreMigration.test.ts.
 *
 * Run: npx tsx --test packages/storage/src/__tests__/selfhealReleaseStore.test.ts
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import Database from 'better-sqlite3'

const testHome = await mkdtemp(join(tmpdir(), 'oc-selfheal-release-'))
process.env.OPENCLAUDE_HOME = testHome

// Pre-create the LEGACY (batch1a) callback outbox schema + rows so the on-open
// ensureReleaseCallbackSchema guard migrates it in place.
{
  const db = new Database(join(testHome, 'selfheal.db'))
  db.exec(`
    CREATE TABLE selfheal_callback_outbox (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      repair_id       TEXT NOT NULL,
      phase           TEXT NOT NULL CHECK (phase IN ('pending_release','done','failed')),
      message         TEXT NOT NULL,
      detail_json     TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','sent','abandoned')),
      attempts        INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      UNIQUE(repair_id, phase)
    );
    CREATE INDEX idx_selfheal_cb_outbox_due ON selfheal_callback_outbox(status, next_attempt_at);
    INSERT INTO selfheal_callback_outbox
      (repair_id, phase, message, detail_json, status, attempts, next_attempt_at, created_at, updated_at)
      VALUES ('legacy-rp', 'pending_release', 'held', '{"a":1}', 'queued', 0, 500, 100, 100),
             ('legacy-rp', 'done', 'ok', '{"b":2}', 'sent', 3, 600, 100, 200);
  `)
  db.close()
}

const {
  claimDueCallbacks,
  claimReleaseJob,
  cancelReleaseJob,
  clearReleaseFuse,
  closeSelfhealDb,
  engageReleaseFuse,
  enqueueCallback,
  getReleaseFuse,
  getReleaseJob,
  getSelfhealDb,
  insertReleaseJobReceived,
  listCallbacksForRepair,
  listReleaseJobsByStatus,
  markCallbackSent,
  markReleaseJobCanonicalPushed,
  setReleaseJobCheckpoint,
  setReleaseJobFailureReason,
  setReleaseJobReceipt,
  terminalizeReleaseJobWithCallback,
} = await import('../selfhealStore.js')

after(async () => {
  await closeSelfhealDb()
})

function baseInsert(rrid: string, repairId: string, payloadHash = 'ph') {
  return insertReleaseJobReceived({
    releaseRequestId: rrid,
    repairId,
    incidentId: 'inc',
    payloadHash,
    approvedSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    deployPlanHash: 'p'.repeat(64),
    manifestHash: 'm'.repeat(64),
    planJson: '{"surfaces":["master"]}',
  })
}

describe('insertReleaseJobReceived — idempotency & conflict', () => {
  it('inserts a fresh release request and freezes its fields', async () => {
    const r = await baseInsert('rr1', 'rep1')
    assert.equal(r.outcome, 'inserted')
    assert.equal(r.job.status, 'received')
    assert.equal(r.job.origin, 'v5')
    assert.equal(r.job.approvedSha, 'a'.repeat(40))
    assert.equal(r.job.planJson, '{"surfaces":["master"]}')
    assert.equal(r.job.claimedAt, null)
  })

  it('is idempotent for the same payload hash', async () => {
    const r = await baseInsert('rr1', 'rep1')
    assert.equal(r.outcome, 'duplicate')
  })

  it('conflicts on the same rrid with a different payload hash', async () => {
    const r = await baseInsert('rr1', 'rep1', 'different')
    assert.equal(r.outcome, 'conflict')
  })
})

describe('claimReleaseJob — CAS pre-claim + global singleflight', () => {
  it('claims a received job, sets deploying + claimed_at + scope_unit, enqueues deploying callback', async () => {
    await baseInsert('rrA', 'repA')
    await baseInsert('rrB', 'repB')
    const res = await claimReleaseJob({
      releaseRequestId: 'rrA',
      scopeUnit: 'oc-release-rrA.scope',
      deployingCallback: {
        repairId: 'repA',
        message: 'deploying',
        detail: { releaseRequestId: 'rrA', releasePhase: 'deploying' },
      },
    })
    assert.equal(res.outcome, 'claimed')
    if (res.outcome !== 'claimed') return
    assert.equal(res.job.status, 'deploying')
    assert.equal(res.job.scopeUnit, 'oc-release-rrA.scope')
    assert.ok(res.job.claimedAt)
    const cbs = await listCallbacksForRepair('repA')
    const deploying = cbs.find((c) => c.phase === 'deploying')
    assert.ok(deploying, 'deploying callback enqueued in the claim transaction')
    assert.equal(deploying?.releaseRequestId, 'rrA')
  })

  it('rejects a second concurrent claim host-wide (singleflight → busy)', async () => {
    const res = await claimReleaseJob({ releaseRequestId: 'rrB', scopeUnit: 's' })
    assert.equal(res.outcome, 'busy')
    // rrB was NOT mutated.
    assert.equal((await getReleaseJob('rrB'))?.status, 'received')
  })

  it('re-claiming the already-deploying job is a noop (CAS lost, not busy)', async () => {
    const res = await claimReleaseJob({ releaseRequestId: 'rrA', scopeUnit: 'other' })
    assert.equal(res.outcome, 'noop')
    // set-once scope_unit unchanged.
    assert.equal((await getReleaseJob('rrA'))?.scopeUnit, 'oc-release-rrA.scope')
  })

  it('after the in-flight deploy terminalizes, the next claim wins', async () => {
    assert.equal(
      await terminalizeReleaseJobWithCallback({
        releaseRequestId: 'rrA',
        repairId: 'repA',
        fromStatuses: ['deploying'],
        toStatus: 'deployed',
        message: 'deployed',
        detail: { releaseRequestId: 'rrA', releasePhase: 'deployed' },
      }),
      true,
    )
    const res = await claimReleaseJob({ releaseRequestId: 'rrB', scopeUnit: 's2' })
    assert.equal(res.outcome, 'claimed')
    // Clean up: leave no 'deploying' row for later tests.
    await terminalizeReleaseJobWithCallback({
      releaseRequestId: 'rrB',
      repairId: 'repB',
      fromStatuses: ['deploying'],
      toStatus: 'deployed',
      message: 'deployed',
      detail: { releaseRequestId: 'rrB', releasePhase: 'deployed' },
    })
  })
})

describe('set-once writes reject the second write', () => {
  it('checkpoint / receipt (read-back) / canonical push are set-once', async () => {
    await baseInsert('rrSO', 'repSO')
    assert.equal(await setReleaseJobCheckpoint('rrSO', '{"cp":1}'), true)
    assert.equal(await setReleaseJobCheckpoint('rrSO', '{"cp":2}'), false)
    assert.equal((await getReleaseJob('rrSO'))?.checkpointJson, '{"cp":1}')

    const first = await setReleaseJobReceipt('rrSO', '{"r":1}')
    assert.deepEqual(first, { applied: true, receiptJson: '{"r":1}' })
    // The loser learns the AUTHORITATIVE landed value, not its own rejected write.
    const second = await setReleaseJobReceipt('rrSO', '{"r":2}')
    assert.deepEqual(second, { applied: false, receiptJson: '{"r":1}' })

    assert.equal(await markReleaseJobCanonicalPushed('rrSO'), true)
    assert.equal(await markReleaseJobCanonicalPushed('rrSO'), false)
  })
})

describe('terminalizeReleaseJobWithCallback — CAS miss enqueues nothing', () => {
  it('a CAS miss (wrong fromStatuses) writes no outbox row; a hit enqueues once', async () => {
    await baseInsert('rrT', 'repT')
    // Miss: job is 'received', not 'deploying'.
    assert.equal(
      await terminalizeReleaseJobWithCallback({
        releaseRequestId: 'rrT',
        repairId: 'repT',
        fromStatuses: ['deploying'],
        toStatus: 'deploy_failed',
        message: 'x',
        detail: { releaseRequestId: 'rrT', releasePhase: 'deploy_failed' },
        failureReason: 'boom',
      }),
      false,
    )
    assert.equal((await listCallbacksForRepair('repT')).length, 0, 'no callback on CAS miss')
    assert.equal((await getReleaseJob('rrT'))?.status, 'received')

    // Hit: terminalize from 'received' → manual_required, enqueue once.
    assert.equal(
      await terminalizeReleaseJobWithCallback({
        releaseRequestId: 'rrT',
        repairId: 'repT',
        fromStatuses: ['received', 'deploying'],
        toStatus: 'manual_required',
        message: 'authority mismatch',
        detail: { releaseRequestId: 'rrT', releasePhase: 'manual_required' },
        failureReason: 'authority_mismatch',
      }),
      true,
    )
    const cbs = await listCallbacksForRepair('repT')
    assert.equal(cbs.length, 1)
    assert.equal(cbs[0]?.phase, 'manual_required')
    assert.equal(cbs[0]?.releaseRequestId, 'rrT')
    const job = await getReleaseJob('rrT')
    assert.equal(job?.status, 'manual_required')
    assert.equal(job?.failureReason, 'authority_mismatch')

    // Second terminalize is a CAS miss (already terminal) → still one row.
    assert.equal(
      await terminalizeReleaseJobWithCallback({
        releaseRequestId: 'rrT',
        repairId: 'repT',
        fromStatuses: ['received', 'deploying'],
        toStatus: 'deploy_failed',
        message: 'x',
        detail: {},
      }),
      false,
    )
    assert.equal((await listCallbacksForRepair('repT')).length, 1)
  })

  it('setReleaseJobFailureReason updates the observability field post-terminal', async () => {
    assert.equal(await setReleaseJobFailureReason('rrT', 'canonical_push_pending'), true)
    assert.equal((await getReleaseJob('rrT'))?.failureReason, 'canonical_push_pending')
  })
})

describe('cancelReleaseJob — three states + not_found', () => {
  it('unknown rrid → not_found', async () => {
    assert.equal(await cancelReleaseJob('nope'), 'not_found')
  })

  it('received & not pre-claimed → cancelled', async () => {
    await baseInsert('rrC1', 'repC1')
    assert.equal(await cancelReleaseJob('rrC1'), 'cancelled')
    assert.equal((await getReleaseJob('rrC1'))?.status, 'cancelled')
  })

  it('pre-claimed (deploying) → too_late', async () => {
    await baseInsert('rrC2', 'repC2')
    assert.equal((await claimReleaseJob({ releaseRequestId: 'rrC2', scopeUnit: 's' })).outcome, 'claimed')
    assert.equal(await cancelReleaseJob('rrC2'), 'too_late')
    // Clean up the deploying row.
    await terminalizeReleaseJobWithCallback({
      releaseRequestId: 'rrC2',
      repairId: 'repC2',
      fromStatuses: ['deploying'],
      toStatus: 'deployed',
      message: 'd',
      detail: {},
    })
  })

  it('terminal → idempotent', async () => {
    await baseInsert('rrC3', 'repC3')
    await terminalizeReleaseJobWithCallback({
      releaseRequestId: 'rrC3',
      repairId: 'repC3',
      fromStatuses: ['received'],
      toStatus: 'deployed',
      message: 'd',
      detail: {},
    })
    assert.equal(await cancelReleaseJob('rrC3'), 'idempotent')
  })

  it('listReleaseJobsByStatus surfaces terminal cohorts', async () => {
    const deployed = await listReleaseJobsByStatus(['deployed'])
    assert.ok(deployed.some((j) => j.releaseRequestId === 'rrC3'))
    assert.equal(await (async () => (await listReleaseJobsByStatus([])).length)(), 0)
  })
})

describe('selfheal_release_fuse — idempotent engage/clear', () => {
  it('starts disengaged, engages once, ignores re-engage, clears, re-engages fresh', async () => {
    assert.equal((await getReleaseFuse()).engaged, false)

    assert.equal(
      await engageReleaseFuse({ reason: 'deploy_unknown', releaseRequestId: 'rrF', now: '2026-01-01T00:00:00.000Z' }),
      true,
    )
    let f = await getReleaseFuse()
    assert.equal(f.engaged, true)
    assert.equal(f.reason, 'deploy_unknown')
    assert.equal(f.releaseRequestId, 'rrF')
    assert.equal(f.engagedAt, '2026-01-01T00:00:00.000Z')

    // Idempotent: an already-engaged fuse keeps the ORIGINAL cause.
    assert.equal(await engageReleaseFuse({ reason: 'other', releaseRequestId: 'rrX' }), false)
    f = await getReleaseFuse()
    assert.equal(f.reason, 'deploy_unknown')
    assert.equal(f.releaseRequestId, 'rrF')

    assert.equal(await clearReleaseFuse({ clearedBy: 'boss' }), true)
    f = await getReleaseFuse()
    assert.equal(f.engaged, false)
    assert.equal(f.clearedBy, 'boss')

    // Idempotent clear.
    assert.equal(await clearReleaseFuse({ clearedBy: 'boss2' }), false)

    // Re-engage after clear resets the clear stamp.
    assert.equal(await engageReleaseFuse({ reason: 'again' }), true)
    f = await getReleaseFuse()
    assert.equal(f.engaged, true)
    assert.equal(f.clearedAt, null)
    assert.equal(f.clearedBy, null)
    await clearReleaseFuse({ clearedBy: 'cleanup' })
  })
})

describe('callback outbox rebuild guard + partial unique indexes', () => {
  it('migrated the legacy schema in place, preserving rows verbatim', async () => {
    const rows = await listCallbacksForRepair('legacy-rp')
    assert.equal(rows.length, 2)
    const held = rows.find((r) => r.phase === 'pending_release')
    const done = rows.find((r) => r.phase === 'done')
    assert.equal(held?.releaseRequestId, null)
    assert.equal(held?.status, 'queued')
    assert.equal(held?.detailJson, '{"a":1}')
    assert.equal(done?.releaseRequestId, null)
    assert.equal(done?.status, 'sent')
    assert.equal(done?.attempts, 3)
  })

  it('added release_request_id and the two partial unique indexes', async () => {
    const db = await getSelfhealDb()
    const cols = (db.prepare('PRAGMA table_info(selfheal_callback_outbox)').all() as { name: string }[]).map(
      (c) => c.name,
    )
    assert.ok(cols.includes('release_request_id'))
    const idx = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='selfheal_callback_outbox'")
        .all() as { name: string }[]
    ).map((i) => i.name)
    assert.ok(idx.includes('ux_cb_repair_phase'))
    assert.ok(idx.includes('ux_cb_release_phase'))
  })

  it('repair-level dedup on (repair_id, phase) when rrid is NULL', async () => {
    assert.equal(await enqueueCallback({ repairId: 'gp', phase: 'done', message: 'm', detail: {} }), true)
    assert.equal(await enqueueCallback({ repairId: 'gp', phase: 'done', message: 'm', detail: {} }), false)
  })

  it('release rows: same repair+phase, different rrid coexist; same rrid+phase dedups', async () => {
    assert.equal(
      await enqueueCallback({ repairId: 'gp2', phase: 'deployed', message: 'm', detail: {}, releaseRequestId: 'gA' }),
      true,
    )
    assert.equal(
      await enqueueCallback({ repairId: 'gp2', phase: 'deployed', message: 'm', detail: {}, releaseRequestId: 'gB' }),
      true,
    )
    assert.equal(
      await enqueueCallback({ repairId: 'gp2', phase: 'deployed', message: 'm', detail: {}, releaseRequestId: 'gA' }),
      false,
    )
    assert.equal((await listCallbacksForRepair('gp2')).length, 2)
  })
})

describe('claimDueCallbacks — per-repair ordering for release rows', () => {
  it('holds a terminal release callback behind its still-queued deploying', async () => {
    await enqueueCallback({
      repairId: 'rord',
      phase: 'deploying',
      message: 'deploying',
      detail: { releaseRequestId: 'rid1', releasePhase: 'deploying' },
      releaseRequestId: 'rid1',
      now: 1000,
    })
    await enqueueCallback({
      repairId: 'rord',
      phase: 'deployed',
      message: 'deployed',
      detail: { releaseRequestId: 'rid1', releasePhase: 'deployed' },
      releaseRequestId: 'rid1',
      now: 1000,
    })
    const due1 = (await claimDueCallbacks(1000, 100)).filter((r) => r.repairId === 'rord')
    assert.equal(due1.length, 1)
    assert.equal(due1[0]?.phase, 'deploying')

    await markCallbackSent(due1[0]!.id)
    const due2 = (await claimDueCallbacks(1000, 100)).filter((r) => r.repairId === 'rord')
    assert.equal(due2.length, 1)
    assert.equal(due2[0]?.phase, 'deployed')
  })
})
