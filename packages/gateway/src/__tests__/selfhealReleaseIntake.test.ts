import * as assert from 'node:assert/strict'
/**
 * Behavior tests for the batch1b release intake seam: the durable v5 release
 * webhook (§3.1), the fuse-clear webhook (§3.3), the release-job cancel state
 * machine (§3.2), the break-glass enqueue mechanism (§11), and the pump phase→
 * action mapping (§5.3). Fresh selfheal.db under a temp OPENCLAUDE_HOME.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/selfhealReleaseIntake.test.ts
 */
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, describe, it } from 'node:test'

const testHome = await mkdtemp(join(tmpdir(), 'oc-selfheal-ri-'))
process.env.OPENCLAUDE_HOME = testHome

const storage = await import('@openclaude/storage')
const {
  closeSelfhealDb,
  getSelfhealDb,
  finalizeBrokerAction,
  tryClaimBrokerAction,
  getReleaseJob,
  getReleaseFuse,
  engageReleaseFuse,
  cancelReleaseJob,
  claimReleaseJob,
  insertReleaseJobReceived,
  terminalizeReleaseJobWithCallback,
} = storage
const receiver = await import('../selfheal/receiver.js')
const { readCommittedCutoverPlan, enqueueReleaseJob, releasePayloadHash } = await import(
  '../selfheal/releaseIntake.js'
)
const { phaseToAction } = await import('../selfheal/callbackPump.js')

after(async () => {
  await closeSelfhealDb()
})

const SECRET = 'test-secret-release'
const cfg = receiver.getSelfhealReceiverConfig({
  OC_SELFHEAL_WEBHOOK_HMAC: SECRET,
} as NodeJS.ProcessEnv)!
const RELEASE_PATH = receiver.SELFHEAL_RELEASE_WEBHOOK_PATH
const FUSE_PATH = receiver.SELFHEAL_FUSE_CLEAR_WEBHOOK_PATH

const SHA = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const PLAN = 'c'.repeat(64)
const MAN = 'd'.repeat(64)

function sign(path: string, repairId: string, ts: string, nonce: string, body: Buffer): string {
  const bodySha256 = createHash('sha256').update(body).digest('hex')
  const signed = `POST.${path}.${ts}.${nonce}.${repairId}.${bodySha256}`
  return createHmac('sha256', SECRET).update(signed).digest('hex')
}

function signedInput(path: string, sigRepairId: string, bodyObj: Record<string, unknown>) {
  const body = Buffer.from(JSON.stringify(bodyObj))
  const ts = String(Date.now())
  const nonce = randomBytes(8).toString('hex')
  return {
    remoteAddress: '127.0.0.1',
    method: 'POST',
    path,
    ts,
    nonce,
    sig: sign(path, sigRepairId, ts, nonce, body),
    rawBody: body,
  }
}

/** Seed a committed `${repairId}:cutover` broker action with a plan detail. */
async function seedCutover(
  repairId: string,
  detail: Record<string, unknown> = {
    sha: SHA,
    baseSha: BASE,
    deployPlanHash: PLAN,
    manifestHash: MAN,
    classification: { surfaces: ['web'], deployArgs: ['--dist'], manual: [], verifyLayers: [] },
    changedFiles: { paths: [], total: 0 },
  },
) {
  const key = `${repairId}:cutover`
  await tryClaimBrokerAction({ claimKey: key, repairId, actionKind: 'cutover', paramsHash: 'ph' })
  await finalizeBrokerAction(key, JSON.stringify({ ok: false, status: 'pending_release', detail }))
}

function releaseBody(repairId: string, rrid: string, over: Record<string, unknown> = {}) {
  return {
    repairId,
    incidentId: 'inc-1',
    releaseRequestId: rrid,
    approvedSha: SHA,
    baseSha: BASE,
    deployPlanHash: PLAN,
    manifestHash: MAN,
    ...over,
  }
}

beforeEach(async () => {
  const db = await getSelfhealDb()
  db.exec(`
    DELETE FROM selfheal_release_jobs;
    DELETE FROM selfheal_callback_outbox;
    DELETE FROM broker_actions;
    DELETE FROM selfheal_release_fuse_cleared_epochs;
    UPDATE selfheal_release_fuse
    SET engaged = 0, reason = NULL, release_request_id = NULL,
        engaged_at = NULL, cleared_at = NULL, cleared_by = NULL
    WHERE id = 1;
  `)
})

describe('receiveSelfhealRelease — §3.1 durable intake', () => {
  it('happy path: committed record matches webhook → 202 accepted + job on disk', async () => {
    await seedCutover('r1')
    const rrid = 'rrid-1'
    const res = await receiver.receiveSelfhealRelease(signedInput(RELEASE_PATH, 'r1', releaseBody('r1', rrid)), cfg)
    assert.equal(res.status, 202)
    assert.equal(res.body.status, 'accepted')
    assert.equal(res.body.releaseRequestId, rrid)
    const job = await getReleaseJob(rrid)
    assert.equal(job?.status, 'received')
    assert.equal(job?.origin, 'v5')
    assert.equal(job?.approvedSha, SHA, 'frozen from the LOCAL record')
  })

  it('local fuse engaged → 423 release_fuse_engaged (no job created)', async () => {
    await seedCutover('r2')
    await engageReleaseFuse({ reason: 'halt', releaseRequestId: 'fuse-r2' })
    const res = await receiver.receiveSelfhealRelease(signedInput(RELEASE_PATH, 'r2', releaseBody('r2', 'rrid-2')), cfg)
    assert.equal(res.status, 423)
    assert.equal(res.body.error, 'release_fuse_engaged')
    assert.equal(await getReleaseJob('rrid-2'), null)
  })

  it('no committed cutover record → 409 authority_mismatch', async () => {
    const res = await receiver.receiveSelfhealRelease(signedInput(RELEASE_PATH, 'r3', releaseBody('r3', 'rrid-3')), cfg)
    assert.equal(res.status, 409)
    assert.equal(res.body.error, 'authority_mismatch')
  })

  it('webhook deployPlanHash != local record → 409 authority_mismatch', async () => {
    await seedCutover('r4')
    const body = releaseBody('r4', 'rrid-4', { deployPlanHash: 'e'.repeat(64) })
    const res = await receiver.receiveSelfhealRelease(signedInput(RELEASE_PATH, 'r4', body), cfg)
    assert.equal(res.status, 409)
    assert.equal(res.body.error, 'authority_mismatch')
    assert.equal(await getReleaseJob('rrid-4'), null)
  })

  it('webhook baseSha != local record baseSha → 409 authority_mismatch (§F11)', async () => {
    await seedCutover('r-base')
    const body = releaseBody('r-base', 'rrid-base', { baseSha: 'e'.repeat(40) })
    const res = await receiver.receiveSelfhealRelease(signedInput(RELEASE_PATH, 'r-base', body), cfg)
    assert.equal(res.status, 409)
    assert.equal(res.body.error, 'authority_mismatch')
    assert.equal(await getReleaseJob('rrid-base'), null)
  })

  it('a null webhook baseSha skips the baseSha binding (still accepted) (§F11)', async () => {
    await seedCutover('r-basenull')
    const res = await receiver.receiveSelfhealRelease(
      signedInput(RELEASE_PATH, 'r-basenull', releaseBody('r-basenull', 'rrid-basenull', { baseSha: null })),
      cfg,
    )
    assert.equal(res.status, 202)
  })

  it('idempotent: same rrid re-delivered → 202 (duplicate)', async () => {
    await seedCutover('r5')
    const input1 = signedInput(RELEASE_PATH, 'r5', releaseBody('r5', 'rrid-5'))
    const input2 = signedInput(RELEASE_PATH, 'r5', releaseBody('r5', 'rrid-5'))
    assert.equal((await receiver.receiveSelfhealRelease(input1, cfg)).status, 202)
    const again = await receiver.receiveSelfhealRelease(input2, cfg)
    assert.equal(again.status, 202, 'a re-delivery of the same frozen plan is an idempotent 202')
  })

  it('a bad signature is rejected before any state change (401)', async () => {
    await seedCutover('r6')
    const input = signedInput(RELEASE_PATH, 'r6', releaseBody('r6', 'rrid-6'))
    input.sig = `${input.sig.slice(0, -2)}00`
    const res = await receiver.receiveSelfhealRelease(input, cfg)
    assert.equal(res.status, 401)
    assert.equal(await getReleaseJob('rrid-6'), null)
  })
})

describe('receiveSelfhealFuseClear — §3.3', () => {
  it('clears only the exact engaged epoch and returns an epoch-bound 200', async () => {
    await engageReleaseFuse({ reason: 'stuck', releaseRequestId: 'rr-fuse-A' })
    assert.equal((await getReleaseFuse()).engaged, true)
    const body = {
      repairId: 'fuse',
      reason: 'boss cleared after audit',
      clearedBy: 'boss',
      expectedReleaseRequestId: 'rr-fuse-A',
    }
    const res = await receiver.receiveSelfhealFuseClear(signedInput(FUSE_PATH, 'fuse', body), cfg)
    assert.equal(res.status, 200)
    assert.equal(res.body.cleared, true)
    assert.equal(res.body.releaseRequestId, 'rr-fuse-A')
    assert.equal(res.body.outcome, 'cleared')
    assert.equal((await getReleaseFuse()).engaged, false)
  })

  it('rejects a missing expected epoch before state change (400)', async () => {
    await engageReleaseFuse({ reason: 'stuck', releaseRequestId: 'rr-fuse-missing' })
    const body = { repairId: 'fuse', reason: 'x', clearedBy: 'boss' }
    const res = await receiver.receiveSelfhealFuseClear(signedInput(FUSE_PATH, 'fuse', body), cfg)
    assert.equal(res.status, 400)
    assert.equal((await getReleaseFuse()).engaged, true)
    assert.equal((await getReleaseFuse()).releaseRequestId, 'rr-fuse-missing')
  })

  it('tombstones an absent exact V5 epoch with 200 and preserves the current epoch', async () => {
    await engageReleaseFuse({ reason: 'stuck', releaseRequestId: 'rr-fuse-current' })
    const body = {
      repairId: 'fuse',
      reason: 'x',
      clearedBy: 'boss',
      expectedReleaseRequestId: 'rr-fuse-wrong',
    }
    const res = await receiver.receiveSelfhealFuseClear(signedInput(FUSE_PATH, 'fuse', body), cfg)
    assert.equal(res.status, 200)
    assert.equal(res.body.cleared, true)
    assert.equal(res.body.outcome, 'cleared')
    assert.equal(res.body.releaseRequestId, 'rr-fuse-wrong')
    assert.equal((await getReleaseFuse()).engaged, true)
    assert.equal((await getReleaseFuse()).releaseRequestId, 'rr-fuse-current')
    assert.equal(
      await engageReleaseFuse({ reason: 'late wrong epoch', releaseRequestId: 'rr-fuse-wrong' }),
      false,
    )
  })

  it('response-loss retry of a cleared epoch is 200 already_cleared and cannot clear epoch B', async () => {
    await engageReleaseFuse({ reason: 'A', releaseRequestId: 'rr-fuse-A' })
    const clearA = {
      repairId: 'fuse',
      reason: 'audited A',
      clearedBy: 'boss',
      expectedReleaseRequestId: 'rr-fuse-A',
    }
    assert.equal(
      (await receiver.receiveSelfhealFuseClear(signedInput(FUSE_PATH, 'fuse', clearA), cfg)).body.outcome,
      'cleared',
    )
    await engageReleaseFuse({ reason: 'B', releaseRequestId: 'rr-fuse-B' })

    const retry = await receiver.receiveSelfhealFuseClear(
      signedInput(FUSE_PATH, 'fuse', clearA),
      cfg,
    )
    assert.equal(retry.status, 200)
    assert.equal(retry.body.cleared, true)
    assert.equal(retry.body.releaseRequestId, 'rr-fuse-A')
    assert.equal(retry.body.outcome, 'already_cleared')
    assert.equal((await getReleaseFuse()).engaged, true)
    assert.equal((await getReleaseFuse()).releaseRequestId, 'rr-fuse-B')
  })

  it('rejects a body whose repairId is not the fixed literal "fuse" (400)', async () => {
    const body = {
      repairId: 'not-fuse',
      reason: 'x',
      clearedBy: 'y',
      expectedReleaseRequestId: 'rr-fuse-x',
    }
    const res = await receiver.receiveSelfhealFuseClear(signedInput(FUSE_PATH, 'not-fuse', body), cfg)
    assert.equal(res.status, 400)
  })
})

describe('cancelReleaseJob — §3.2 three-state', () => {
  it('received & unclaimed → cancelled', async () => {
    await enqueue('cx-1')
    assert.equal(await cancelReleaseJob('cx-1'), 'cancelled')
    assert.equal((await getReleaseJob('cx-1'))?.status, 'cancelled')
  })

  it('claimed (deploying) → too_late (receipt adjudicates)', async () => {
    await enqueue('cx-2')
    await claimReleaseJob({ releaseRequestId: 'cx-2', scopeUnit: 's' })
    assert.equal(await cancelReleaseJob('cx-2'), 'too_late')
  })

  it('already terminal → idempotent; unknown rrid → not_found', async () => {
    await enqueue('cx-3')
    await cancelReleaseJob('cx-3')
    assert.equal(await cancelReleaseJob('cx-3'), 'idempotent')
    assert.equal(await cancelReleaseJob('nope'), 'not_found')
  })

  async function enqueue(rrid: string) {
    await insertReleaseJobReceived({
      releaseRequestId: rrid,
      repairId: `r-${rrid}`,
      incidentId: 'i',
      payloadHash: 'p',
      approvedSha: SHA,
      planJson: '{}',
    })
  }
})

describe('resolveReleaseJobCancel — §3.2 + §F11 rrid↔repair binding', () => {
  async function seedJob(rrid: string, repairId: string) {
    await insertReleaseJobReceived({
      releaseRequestId: rrid,
      repairId,
      incidentId: 'i',
      payloadHash: 'p',
      approvedSha: SHA,
      planJson: '{}',
    })
  }

  it('unknown rrid → 200 not_found', async () => {
    const r = await receiver.resolveReleaseJobCancel('no-such-rrid', 'r-x')
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.releaseCancel, 'not_found')
  })

  it('rrid belongs to a DIFFERENT repair → 409 repair_mismatch (job untouched)', async () => {
    await seedJob('rc-mm', 'r-owner')
    const r = await receiver.resolveReleaseJobCancel('rc-mm', 'r-attacker')
    assert.equal(r.status, 409)
    assert.equal(r.body.ok, false)
    assert.equal(r.body.releaseCancel, 'repair_mismatch')
    assert.equal((await getReleaseJob('rc-mm'))?.status, 'received', 'the job is never cancelled')
  })

  it('rrid matches its repair, received & unclaimed → 200 cancelled', async () => {
    await seedJob('rc-ok', 'r-ok')
    const r = await receiver.resolveReleaseJobCancel('rc-ok', 'r-ok')
    assert.equal(r.status, 200)
    assert.equal(r.body.releaseCancel, 'cancelled')
    assert.equal((await getReleaseJob('rc-ok'))?.status, 'cancelled')
  })

  it('claimed (deploying) → 409 too_late', async () => {
    await seedJob('rc-late', 'r-late')
    await claimReleaseJob({ releaseRequestId: 'rc-late', scopeUnit: 's' })
    const r = await receiver.resolveReleaseJobCancel('rc-late', 'r-late')
    assert.equal(r.status, 409)
    assert.equal(r.body.ok, false)
    assert.equal(r.body.releaseCancel, 'too_late')
  })

  it('already terminal → 200 idempotent', async () => {
    await seedJob('rc-idem', 'r-idem')
    await cancelReleaseJob('rc-idem')
    const r = await receiver.resolveReleaseJobCancel('rc-idem', 'r-idem')
    assert.equal(r.status, 200)
    assert.equal(r.body.releaseCancel, 'idempotent')
  })
})

describe('resolveDualCancel — R2-1 release-job + repair-level dual cancel merge', () => {
  async function seedJob(rrid: string, repairId: string) {
    await insertReleaseJobReceived({
      releaseRequestId: rrid,
      repairId,
      incidentId: 'i',
      payloadHash: 'p',
      approvedSha: SHA,
      planJson: '{}',
    })
  }
  // A repair-level cancel outcome (executeSelfhealCancel's shape), plus a spy so
  // the tests can assert whether the repair cancel actually RAN.
  function repairThunk(
    outcome: { repairId: string; terminated: boolean; accepted: boolean; status: string },
    ran: { called: number },
  ) {
    return async () => {
      ran.called++
      return outcome
    }
  }

  it('repair_mismatch → 409, runs NEITHER cancel (suspicious request)', async () => {
    await seedJob('rd-mm', 'r-owner')
    const rel = await receiver.resolveReleaseJobCancel('rd-mm', 'r-attacker')
    const ran = { called: 0 }
    const dual = await receiver.resolveDualCancel(
      rel,
      repairThunk({ repairId: 'r-attacker', terminated: true, accepted: true, status: 'cancelled' }, ran),
    )
    assert.equal(dual.status, 409)
    assert.equal(dual.body.ok, false)
    assert.equal(dual.body.releaseCancel, 'repair_mismatch')
    assert.equal(ran.called, 0, 'the repair-level cancel is NEVER invoked on a mismatch')
    assert.equal((await getReleaseJob('rd-mm'))?.status, 'received', 'job untouched')
  })

  it('cancelled + repair terminated → 200 body merges BOTH field groups', async () => {
    await seedJob('rd-ok', 'r-ok')
    const rel = await receiver.resolveReleaseJobCancel('rd-ok', 'r-ok') // → cancelled
    const ran = { called: 0 }
    const dual = await receiver.resolveDualCancel(
      rel,
      repairThunk({ repairId: 'r-ok', terminated: true, accepted: true, status: 'cancelled' }, ran),
    )
    assert.equal(ran.called, 1, 'the repair-level cancel runs')
    assert.equal(dual.status, 200)
    // Repair-level fields — the R2-1 regression that was being DROPPED.
    assert.equal(dual.body.ok, true)
    assert.equal(dual.body.repairId, 'r-ok')
    assert.equal(dual.body.terminated, true)
    assert.equal(dual.body.accepted, true)
    assert.equal(dual.body.status, 'cancelled')
    // Release-job fields ride along.
    assert.equal(dual.body.releaseCancel, 'cancelled')
    assert.equal(dual.body.releaseRequestId, 'rd-ok')
  })

  it('too_late — 200, repair cancel SKIPPED (deploy owns the repair), terminated=false', async () => {
    await seedJob('rd-late', 'r-late')
    await claimReleaseJob({ releaseRequestId: 'rd-late', scopeUnit: 's' })
    const rel = await receiver.resolveReleaseJobCancel('rd-late', 'r-late') // → 409 too_late
    assert.equal(rel.status, 409, 'the resolver alone still reports 409 for too_late')
    const ran = { called: 0 }
    // R3-1: the deploy is IN FLIGHT — running the repair-level cancel here could
    // report terminated=true and let v5 terminal-cancel a repair whose code is about
    // to be live. The dual path must SKIP the repair cancel entirely.
    const dual = await receiver.resolveDualCancel(
      rel,
      repairThunk({ repairId: 'r-late', terminated: true, accepted: true, status: 'cancelled' }, ran),
    )
    assert.equal(ran.called, 0, 'repair cancel must NOT run while the deploy is in flight')
    assert.equal(dual.status, 200, 'never a bare 409 for too_late')
    assert.equal(dual.body.releaseCancel, 'too_late')
    assert.equal(dual.body.terminated, false)
    assert.equal(dual.body.status, 'release_deploying')
    assert.equal(dual.body.releaseRequestId, 'rd-late')
  })

  it('idempotent over deployed → repair cancel SKIPPED; over cancelled → repair cancel runs (R3-1)', async () => {
    // deployed terminal: the deploy effect EXISTS — receipt/probe owns the repair.
    await seedJob('rd-dep', 'r-dep')
    await claimReleaseJob({ releaseRequestId: 'rd-dep', scopeUnit: 's' })
    await terminalizeReleaseJobWithCallback({
      releaseRequestId: 'rd-dep', repairId: 'r-dep', fromStatuses: ['deploying'],
      toStatus: 'deployed', message: 'm', detail: { releaseRequestId: 'rd-dep', releasePhase: 'deployed' },
    })
    const relDep = await receiver.resolveReleaseJobCancel('rd-dep', 'r-dep')
    assert.equal(relDep.body.releaseCancel, 'idempotent')
    assert.equal(relDep.body.releaseJobStatus, 'deployed')
    const ranDep = { called: 0 }
    const dualDep = await receiver.resolveDualCancel(
      relDep,
      repairThunk({ repairId: 'r-dep', terminated: true, accepted: true, status: 'cancelled' }, ranDep),
    )
    assert.equal(ranDep.called, 0, 'deployed terminal → repair cancel must not run')
    assert.equal(dualDep.body.terminated, false)
    assert.equal(dualDep.body.status, 'release_deployed')

    // cancelled terminal: nothing was deployed — the repair cancel proceeds normally.
    await seedJob('rd-can', 'r-can')
    await cancelReleaseJob('rd-can')
    const relCan = await receiver.resolveReleaseJobCancel('rd-can', 'r-can')
    assert.equal(relCan.body.releaseCancel, 'idempotent')
    assert.equal(relCan.body.releaseJobStatus, 'cancelled')
    const ranCan = { called: 0 }
    const dualCan = await receiver.resolveDualCancel(
      relCan,
      repairThunk({ repairId: 'r-can', terminated: true, accepted: true, status: 'cancelled' }, ranCan),
    )
    assert.equal(ranCan.called, 1, 'cancelled terminal → repair cancel runs')
    assert.equal(dualCan.body.terminated, true)
  })

  it('not_found (release job gone) → 200, still settles the repair', async () => {
    const rel = await receiver.resolveReleaseJobCancel('rd-ghost', 'r-ghost') // → not_found
    const ran = { called: 0 }
    const dual = await receiver.resolveDualCancel(
      rel,
      repairThunk({ repairId: 'r-ghost', terminated: true, accepted: true, status: 'cancelled' }, ran),
    )
    assert.equal(ran.called, 1)
    assert.equal(dual.status, 200)
    assert.equal(dual.body.releaseCancel, 'not_found')
    assert.equal(dual.body.terminated, true)
  })
})

describe('releasePayloadHash — §F11 rrid↔repair binding', () => {
  const base = { sha: SHA, baseSha: BASE, deployPlanHash: PLAN, manifestHash: MAN }
  it('binds repairId + incidentId into the frozen-plan hash', () => {
    const h1 = releasePayloadHash({ repairId: 'ra', incidentId: 'ia', ...base })
    assert.notEqual(h1, releasePayloadHash({ repairId: 'rb', incidentId: 'ia', ...base }), 'repairId bound')
    assert.notEqual(h1, releasePayloadHash({ repairId: 'ra', incidentId: 'ib', ...base }), 'incidentId bound')
    assert.equal(h1, releasePayloadHash({ repairId: 'ra', incidentId: 'ia', ...base }), 'deterministic')
  })
})

describe('break-glass enqueue mechanism (§11) — readCommittedCutoverPlan + enqueueReleaseJob', () => {
  it('freezes the plan from the committed record and enqueues a breakglass job', async () => {
    await seedCutover('bg-1')
    const plan = await readCommittedCutoverPlan('bg-1')
    assert.ok(plan, 'plan resolved from the committed cutover record')
    assert.equal(plan?.sha, SHA)
    assert.equal(plan?.deployPlanHash, PLAN)
    const enq = await enqueueReleaseJob({
      repairId: 'bg-1',
      incidentId: 'inc-bg',
      releaseRequestId: 'breakglass-bg-1-1',
      origin: 'breakglass',
      plan: plan!,
    })
    assert.equal(enq.outcome, 'inserted')
    const job = await getReleaseJob('breakglass-bg-1-1')
    assert.equal(job?.origin, 'breakglass')
    assert.equal(job?.approvedSha, SHA)
  })

  it('returns null when there is no committed cutover record (fail-closed)', async () => {
    assert.equal(await readCommittedCutoverPlan('absent'), null)
  })
})

describe('pump phase→action mapping (§5.3)', () => {
  it('maps every phase onto the progress|done|failed wire action', () => {
    assert.equal(phaseToAction('pending_release'), 'progress')
    assert.equal(phaseToAction('deploying'), 'progress')
    assert.equal(phaseToAction('deployed'), 'done')
    assert.equal(phaseToAction('done'), 'done')
    assert.equal(phaseToAction('deploy_failed'), 'failed')
    assert.equal(phaseToAction('deploy_unknown'), 'failed')
    assert.equal(phaseToAction('manual_required'), 'failed')
    assert.equal(phaseToAction('failed'), 'failed')
  })
})
