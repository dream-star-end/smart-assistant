import * as assert from 'node:assert/strict'
/**
 * Behavior tests for the Tier2 release worker (batch1b §8/§9). A fake
 * ReleaseWorkerPrimitives stands in for systemd-run/git so NO real deploy runs;
 * every assertion is on durable DB state (release-job terminal status, the
 * callback outbox, the fuse) — never on internal calls.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/selfhealReleaseWorker.test.ts
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, describe, it } from 'node:test'

const testHome = await mkdtemp(join(tmpdir(), 'oc-selfheal-rw-'))
process.env.OPENCLAUDE_HOME = testHome

const storage = await import('@openclaude/storage')
const {
  closeSelfhealDb,
  getSelfhealDb,
  insertJobReceived,
  insertReleaseJobReceived,
  getReleaseJob,
  getReleaseFuse,
  engageReleaseFuse,
  clearReleaseFuse,
  claimReleaseJob,
  setReleaseJobReceipt,
  setReleaseJobCheckpoint,
  setJobFrozenRouting,
  setJobReleaseRevoked,
} = storage
const { SelfhealReleaseWorker, classifyScopeState } = await import('../selfheal/releaseWorker.js')
type LaneEvent = import('../selfheal/releaseWorker.js').LaneEvent
type Primitives = import('../selfheal/releaseWorker.js').ReleaseWorkerPrimitives

after(async () => {
  await closeSelfhealDb()
})

const SHA = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const PLAN = 'c'.repeat(64)
const MAN = 'd'.repeat(64)

function planDetail(opts: { surfaces?: string[]; manual?: { path: string; reason: string }[] } = {}) {
  const surfaces = opts.surfaces ?? ['web']
  const manual = opts.manual ?? []
  return {
    sha: SHA,
    baseSha: BASE,
    deployPlanHash: PLAN,
    manifestHash: MAN,
    classification: {
      surfaces: manual.length ? [] : surfaces,
      deployArgs: manual.length ? [] : surfaces.includes('web') ? ['--dist'] : [],
      manual,
      verifyLayers: [],
    },
    changedFiles: { paths: [], total: 0 },
  }
}

async function insertJob(
  rrid: string,
  opts: {
    origin?: 'v5' | 'auto' | 'breakglass'
    surfaces?: string[]
    manual?: { path: string; reason: string }[]
  } = {},
) {
  await insertReleaseJobReceived({
    releaseRequestId: rrid,
    repairId: `r-${rrid}`,
    incidentId: `inc-${rrid}`,
    payloadHash: `ph-${rrid}`,
    approvedSha: SHA,
    baseSha: BASE,
    deployPlanHash: PLAN,
    manifestHash: MAN,
    planJson: JSON.stringify(planDetail(opts)),
    origin: opts.origin ?? 'v5',
  })
}

function receiptEvt(rrid: string, outcome: string, extra: Record<string, unknown> = {}): LaneEvent {
  return {
    evt: 'receipt',
    rrid,
    sha: SHA,
    outcome,
    exit: 0,
    reason: 'r',
    proofs: { master: { ok: true, detail: 'ok' } },
    canonicalPush: 'pushed',
    ...extra,
  } as LaneEvent
}

function checkpointEvt(rrid: string): LaneEvent {
  return {
    evt: 'checkpoint',
    kind: 'deploy_effect_applied',
    rrid,
    sha: SHA,
    planHash: PLAN,
    manifestHash: MAN,
    // R2-3: must equal candidateRefFor(job.repairId, sha) — insertJob uses
    // repairId = `r-${rrid}` and approvedSha = SHA.
    candidateRef: `refs/heads/selfheal/candidates/r-${rrid}-${SHA.slice(0, 12)}`,
    // R3-2: proofs must COVER the frozen plan — default fixture plan surfaces are
    // ['web'] (a staging surface), so the expected face set is {web, slot}.
    proofs: { web: { ok: true }, slot: { ok: true } },
  } as LaneEvent
}

/** A primitives stub with a scripted lane event stream + injectable helpers.
 *  scopeLiveness is three-state (R2-2): `activeScopes`/`unknownScopes` accept a
 *  '*' sentinel (any scope), `livenessThrows` simulates a probe exception, and
 *  `dieOnKill` makes killScope flip the scope to 'inactive' (SIGKILL took). */
function primitives(
  events: LaneEvent[],
  opts: {
    timedOut?: boolean
    activeScopes?: Set<string>
    unknownScopes?: Set<string>
    livenessThrows?: boolean
    dieOnKill?: boolean
    push?: 'pushed' | 'pending'
    onLane?: (input: { scopeUnit: string }) => void
  } = {},
): { p: Primitives; laneRuns: string[]; killRuns: string[] } {
  const laneRuns: string[] = []
  const killRuns: string[] = []
  const has = (s: Set<string> | undefined, scope: string) => !!s && (s.has('*') || s.has(scope))
  const p: Primitives = {
    async runLane(input) {
      laneRuns.push(input.scopeUnit)
      opts.onLane?.({ scopeUnit: input.scopeUnit })
      for (const e of events) await input.onEvent(e)
      return { timedOut: opts.timedOut ?? false }
    },
    async scopeLiveness(scopeUnit) {
      if (opts.livenessThrows) throw new Error('probe boom (injected)')
      if (has(opts.unknownScopes, scopeUnit)) return 'unknown'
      return has(opts.activeScopes, scopeUnit) ? 'active' : 'inactive'
    },
    async killScope(scopeUnit) {
      killRuns.push(scopeUnit)
      if (opts.dieOnKill) {
        opts.activeScopes?.delete('*')
        opts.activeScopes?.delete(scopeUnit)
        opts.unknownScopes?.delete('*')
        opts.unknownScopes?.delete(scopeUnit)
      }
    },
    async pushCanonical() {
      return opts.push ?? 'pushed'
    },
  }
  return { p, laneRuns, killRuns }
}

function makeWorker(
  p: Primitives,
  extra: { killGraceMs?: number; notify?: (t: string) => void } = {},
): InstanceType<typeof SelfhealReleaseWorker> {
  return new SelfhealReleaseWorker({
    canonicalRepo: '/canon',
    canonicalBranch: 'feat/x',
    laneScriptPath: '/unused/lane.sh',
    primitives: p,
    notify: extra.notify ?? (() => {}),
    now: () => 1_700_000_000_000,
    env: {},
    ...(extra.killGraceMs !== undefined ? { killGraceMs: extra.killGraceMs } : {}),
  })
}

async function outbox(rrid: string): Promise<{ phase: string; detail: Record<string, unknown> }[]> {
  const db = await getSelfhealDb()
  const rows = db
    .prepare(
      'SELECT phase, detail_json FROM selfheal_callback_outbox WHERE release_request_id = ? ORDER BY id',
    )
    .all(rrid) as { phase: string; detail_json: string }[]
  return rows.map((r) => ({ phase: r.phase, detail: JSON.parse(r.detail_json) }))
}

beforeEach(async () => {
  // Reset shared singletons (fuse + tables) between tests.
  const db = await getSelfhealDb()
  db.exec('DELETE FROM selfheal_release_jobs; DELETE FROM selfheal_callback_outbox; DELETE FROM selfheal_jobs;')
  await clearReleaseFuse({ clearedBy: 'test-reset' })
})

describe('release worker — claim → lane → adjudicate', () => {
  it('deployed receipt: deploying callback then deployed terminal + callback (proofs+surfaces)', async () => {
    await insertJob('dep-1')
    const { p, laneRuns } = primitives([checkpointEvt('dep-1'), receiptEvt('dep-1', 'deployed')])
    await makeWorker(p).pumpOnce()
    assert.equal(laneRuns.length, 1)
    const job = await getReleaseJob('dep-1')
    assert.equal(job?.status, 'deployed')
    assert.ok(job?.checkpointJson, 'checkpoint streamed + persisted set-once')
    assert.ok(job?.receiptJson, 'receipt persisted')
    assert.ok(job?.canonicalPushedAt, 'canonical push marked')
    const ob = await outbox('dep-1')
    const phases = ob.map((r) => r.phase)
    assert.ok(phases.includes('deploying'), 'deploying progress enqueued in the claim txn')
    assert.ok(phases.includes('deployed'), 'deployed terminal callback enqueued')
    const dep = ob.find((r) => r.phase === 'deployed')!
    assert.equal(dep.detail.releasePhase, 'deployed')
    assert.equal(dep.detail.sha, SHA)
    assert.deepEqual(dep.detail.surfaces, ['web'])
    assert.ok(dep.detail.proofs, 'proofs carried in the deployed detail')
  })

  it('deploy_failed receipt → deploy_failed terminal (no fuse)', async () => {
    await insertJob('fail-1')
    const { p } = primitives([receiptEvt('fail-1', 'deploy_failed')])
    await makeWorker(p).pumpOnce()
    assert.equal((await getReleaseJob('fail-1'))?.status, 'deploy_failed')
    assert.equal((await getReleaseFuse()).engaged, false, 'deploy_failed does NOT engage the fuse')
    const ob = await outbox('fail-1')
    assert.equal(ob.find((r) => r.phase === 'deploy_failed')?.detail.releasePhase, 'deploy_failed')
  })

  it('manual receipt → manual_required terminal', async () => {
    await insertJob('man-1')
    const { p } = primitives([receiptEvt('man-1', 'manual', { reason: 'canonical_advanced' })])
    await makeWorker(p).pumpOnce()
    assert.equal((await getReleaseJob('man-1'))?.status, 'manual_required')
    assert.equal((await getReleaseFuse()).engaged, false)
  })

  it('deploy_unknown receipt → deploy_unknown terminal + local fuse engaged', async () => {
    await insertJob('unk-1')
    const { p } = primitives([receiptEvt('unk-1', 'deploy_unknown')])
    await makeWorker(p).pumpOnce()
    assert.equal((await getReleaseJob('unk-1'))?.status, 'deploy_unknown')
    assert.equal((await getReleaseFuse()).engaged, true, 'deploy_unknown engages the fuse')
  })

  it('strong binding: a receipt whose rrid mismatches is deploy_unknown (+fuse)', async () => {
    await insertJob('bind-1')
    // receipt claims a DIFFERENT rrid → malformed → unknown.
    const { p } = primitives([receiptEvt('WRONG-rrid', 'deployed')])
    await makeWorker(p).pumpOnce()
    assert.equal((await getReleaseJob('bind-1'))?.status, 'deploy_unknown')
    assert.equal((await getReleaseFuse()).engaged, true)
  })

  it('no receipt at all (lane emitted nothing) → deploy_unknown (+fuse)', async () => {
    await insertJob('none-1')
    const { p } = primitives([])
    await makeWorker(p).pumpOnce()
    assert.equal((await getReleaseJob('none-1'))?.status, 'deploy_unknown')
    assert.equal((await getReleaseFuse()).engaged, true)
  })

  it('timeout: lane killed, no receipt honored → deploy_unknown (+fuse)', async () => {
    await insertJob('to-1')
    // Even though a (late) receipt is emitted, timedOut discards it → unknown.
    const { p } = primitives([receiptEvt('to-1', 'deployed')], { timedOut: true })
    await makeWorker(p).pumpOnce()
    assert.equal((await getReleaseJob('to-1'))?.status, 'deploy_unknown')
    assert.equal((await getReleaseFuse()).engaged, true)
  })

  it('canonical push pending → deployed terminal kept, failure_reason + fuse engaged (F12)', async () => {
    await insertJob('push-1')
    const { p } = primitives([checkpointEvt('push-1'), receiptEvt('push-1', 'deployed', { canonicalPush: 'pending' })], {
      push: 'pending',
    })
    await makeWorker(p).pumpOnce()
    const job = await getReleaseJob('push-1')
    assert.equal(job?.status, 'deployed', 'deployed terminal stands even if push is pending')
    assert.equal(job?.failureReason, 'canonical_push_pending')
    assert.equal(job?.canonicalPushedAt, null, 'push not marked complete')
    // F12: exhausted canonical-push retries pull the local Tier2 fuse.
    const fuse = await getReleaseFuse()
    assert.equal(fuse.engaged, true, 'canonical_push_pending engages the fuse')
    assert.equal(fuse.reason, 'canonical_push_pending')
  })
})

describe('release worker — F5: timeout/crash honor durable checkpoint + strong binding', () => {
  it('timeout AFTER a streamed+persisted checkpoint → deployed (retry push), NOT unknown', async () => {
    await insertJob('to-cp')
    // A checkpoint is streamed (persisted set-once) and THEN the lane times out.
    const { p, laneRuns } = primitives([checkpointEvt('to-cp')], { timedOut: true })
    await makeWorker(p).pumpOnce()
    assert.equal(laneRuns.length, 1)
    const job = await getReleaseJob('to-cp')
    assert.equal(job?.status, 'deployed', 'a persisted checkpoint on timeout recovers deployed')
    assert.equal((await getReleaseFuse()).engaged, false, 'checkpoint honored → no fuse')
    const dep = (await outbox('to-cp')).find((r) => r.phase === 'deployed')
    assert.ok(dep?.detail.proofs, 'deployed callback carries the checkpoint proofs')
  })

  it('timeout with a MIS-BOUND checkpoint (wrong planHash) → checkpoint ignored → deploy_unknown + fuse', async () => {
    await insertJob('to-mb')
    const bad = { ...checkpointEvt('to-mb'), planHash: 'wrong-plan-hash' } as LaneEvent
    const { p } = primitives([bad], { timedOut: true })
    await makeWorker(p).pumpOnce()
    assert.equal((await getReleaseJob('to-mb'))?.status, 'deploy_unknown')
    assert.equal((await getReleaseFuse()).engaged, true)
    // The mis-bound checkpoint was never persisted (strong-binding gate).
    assert.equal((await getReleaseJob('to-mb'))?.checkpointJson, null)
  })

  it('crash recovery: a persisted-but-MIS-BOUND checkpoint is treated as absent → deploy_unknown + fuse', async () => {
    await insertJob('rc-mb')
    await claimReleaseJob({ releaseRequestId: 'rc-mb', scopeUnit: 'scope-rc-mb' })
    // Persist a checkpoint whose sha does NOT match the job's frozen sha (bypass
    // the streaming gate by writing storage directly) → strong binding must reject.
    await setReleaseJobCheckpoint(
      'rc-mb',
      JSON.stringify({ ...checkpointEvt('rc-mb'), sha: 'e'.repeat(40) }),
    )
    const { p, laneRuns } = primitives([]) // dead lane, no receipt
    await makeWorker(p).pumpOnce()
    assert.equal(laneRuns.length, 0, 'recovery never re-runs deploy')
    assert.equal((await getReleaseJob('rc-mb'))?.status, 'deploy_unknown')
    assert.equal((await getReleaseFuse()).engaged, true)
  })
})

describe('classifyScopeState — R2-2 three-state liveness mapping', () => {
  it('active + transitional states all count as ALIVE (never settle)', () => {
    for (const s of ['active', 'activating', 'deactivating', 'reloading'])
      assert.equal(classifyScopeState(s), 'active', `${s} must be alive`)
    assert.equal(classifyScopeState('active\n'), 'active', 'trims trailing newline')
  })
  it('inactive/failed/dead are CONFIRMED dead (settle-able)', () => {
    for (const s of ['inactive', 'failed', 'dead'])
      assert.equal(classifyScopeState(s), 'inactive', `${s} must be dead`)
  })
  it('unknown / empty / unexpected are UNKNOWN (fail-closed)', () => {
    for (const s of ['unknown', '', '   ', 'garbage'])
      assert.equal(classifyScopeState(s), 'unknown', `${JSON.stringify(s)} must be unknown`)
  })
})

describe('release worker — R2-3: checkpoint binds candidateRef + all-ok proofs', () => {
  it('timeout with a checkpoint whose candidateRef is a STRANGER → ignored → deploy_unknown + fuse', async () => {
    await insertJob('to-cr')
    // Everything binds EXCEPT candidateRef (points at another repair's candidate)
    // — a stranger's push must never be mistaken for this job's deploy effect.
    const bad = {
      ...checkpointEvt('to-cr'),
      candidateRef: `refs/heads/selfheal/candidates/r-OTHER-${SHA.slice(0, 12)}`,
    } as LaneEvent
    const { p } = primitives([bad], { timedOut: true })
    await makeWorker(p).pumpOnce()
    assert.equal((await getReleaseJob('to-cr'))?.status, 'deploy_unknown')
    assert.equal((await getReleaseFuse()).engaged, true)
    assert.equal((await getReleaseJob('to-cr'))?.checkpointJson, null, 'never persisted')
  })

  it('timeout with a checkpoint whose proofs are EMPTY {} → ignored → deploy_unknown', async () => {
    await insertJob('to-pe')
    const bad = { ...checkpointEvt('to-pe'), proofs: {} } as LaneEvent
    const { p } = primitives([bad], { timedOut: true })
    await makeWorker(p).pumpOnce()
    assert.equal((await getReleaseJob('to-pe'))?.status, 'deploy_unknown')
    assert.equal((await getReleaseJob('to-pe'))?.checkpointJson, null, 'empty proofs never bind')
  })

  it('timeout with a checkpoint carrying a proof face ok=false → ignored → deploy_unknown', async () => {
    await insertJob('to-pf')
    const bad = { ...checkpointEvt('to-pf'), proofs: { master: { ok: false } } } as LaneEvent
    const { p } = primitives([bad], { timedOut: true })
    await makeWorker(p).pumpOnce()
    assert.equal((await getReleaseJob('to-pf'))?.status, 'deploy_unknown')
    assert.equal((await getReleaseJob('to-pf'))?.checkpointJson, null, 'a not-ok proof never binds')
  })

  it('R3-2: a one-face proof can never validate a multi-surface plan → ignored → deploy_unknown', async () => {
    // Plan touches web+master → expected faces {web, master, slot}; the checkpoint
    // only proves {web, slot} (all ok) — coverage fails, so it must NOT bind.
    await insertJob('to-cov', { surfaces: ['web', 'master'] })
    const partial = { ...checkpointEvt('to-cov'), proofs: { web: { ok: true }, slot: { ok: true } } } as LaneEvent
    const { p } = primitives([partial], { timedOut: true })
    await makeWorker(p).pumpOnce()
    assert.equal((await getReleaseJob('to-cov'))?.status, 'deploy_unknown')
    assert.equal((await getReleaseJob('to-cov'))?.checkpointJson, null, 'partial coverage never binds')
  })

  it('crash recovery: a persisted checkpoint with a MISMATCHED candidateRef is treated as absent', async () => {
    await insertJob('rc-cr')
    await claimReleaseJob({ releaseRequestId: 'rc-cr', scopeUnit: 'scope-rc-cr' })
    // Write a checkpoint straight to storage that fails ONLY the candidateRef bind.
    await setReleaseJobCheckpoint(
      'rc-cr',
      JSON.stringify({ ...checkpointEvt('rc-cr'), candidateRef: 'refs/heads/selfheal/candidates/x' }),
    )
    const { p, laneRuns } = primitives([])
    await makeWorker(p).pumpOnce()
    assert.equal(laneRuns.length, 0)
    assert.equal((await getReleaseJob('rc-cr'))?.status, 'deploy_unknown', 'stranger ref → unknown')
    assert.equal((await getReleaseFuse()).engaged, true)
  })
})

describe('release worker — R2-2: fail-CLOSED scope liveness (never settle while alive/unknown)', () => {
  it('timeout + scope stuck ALIVE (deactivating) through SIGKILL → NOT settled, held deploying + alert', async () => {
    await insertJob('sk-alive')
    const alerts: string[] = []
    // '*' keeps EVERY scope 'active' (models a scope wedged deactivating); no
    // dieOnKill → even after the SIGKILL escalation it never confirms dead.
    const { p, killRuns } = primitives([], { timedOut: true, activeScopes: new Set(['*']) })
    await makeWorker(p, { killGraceMs: 20, notify: (t) => alerts.push(t) }).pumpOnce()
    const job = await getReleaseJob('sk-alive')
    assert.equal(job?.status, 'deploying', 'a scope that never confirms dead is NEVER terminalized')
    assert.equal((await getReleaseFuse()).engaged, false, 'no fuse — the job is not settled')
    assert.equal(killRuns.length, 1, 'SIGKILL escalation was attempted exactly once')
    assert.equal(alerts.length, 1, 'a human is alerted (deduped)')
  })

  it('timeout + liveness probe THROWS (unknown) → NOT settled, held deploying + alert', async () => {
    await insertJob('sk-throw')
    const alerts: string[] = []
    const { p, killRuns } = primitives([], { timedOut: true, livenessThrows: true })
    await makeWorker(p, { killGraceMs: 20, notify: (t) => alerts.push(t) }).pumpOnce()
    assert.equal((await getReleaseJob('sk-throw'))?.status, 'deploying', 'probe exception = unknown, never settle')
    assert.equal((await getReleaseFuse()).engaged, false)
    assert.equal(killRuns.length, 1)
    assert.equal(alerts.length, 1)
  })

  it('timeout + scope alive UNTIL SIGKILL, then dead → normal adjudication (checkpoint → deployed)', async () => {
    await insertJob('sk-kill')
    // Active until killScope flips it inactive (dieOnKill) — the SIGKILL took.
    const { p, killRuns } = primitives([checkpointEvt('sk-kill')], {
      timedOut: true,
      activeScopes: new Set(['*']),
      dieOnKill: true,
    })
    await makeWorker(p, { killGraceMs: 20 }).pumpOnce()
    assert.equal(killRuns.length, 1, 'escalated to SIGKILL once')
    assert.equal((await getReleaseJob('sk-kill'))?.status, 'deployed', 'confirmed dead → settle from checkpoint')
    assert.equal((await getReleaseFuse()).engaged, false, 'checkpoint honored → no fuse')
  })

  it('crash recovery + UNKNOWN liveness → NOT adjudicated, held deploying + alert (no fuse)', async () => {
    await insertJob('rc-unk')
    await claimReleaseJob({ releaseRequestId: 'rc-unk', scopeUnit: 'scope-rc-unk' })
    const alerts: string[] = []
    const { p, laneRuns } = primitives([], { unknownScopes: new Set(['scope-rc-unk']) })
    await makeWorker(p, { notify: (t) => alerts.push(t) }).pumpOnce()
    assert.equal(laneRuns.length, 0, 'recovery never re-runs deploy')
    assert.equal((await getReleaseJob('rc-unk'))?.status, 'deploying', 'unknown liveness → never settle')
    assert.equal((await getReleaseFuse()).engaged, false, 'not settled → no deploy_unknown fuse')
    assert.equal(alerts.length, 1, 'alerted once')
  })
})

describe('release worker — gates', () => {
  it('a manual plan is closed manual_required WITHOUT claiming (no lane)', async () => {
    await insertJob('gm-1', { manual: [{ path: 'scripts/x.sh', reason: 'manual_glob' }] })
    const { p, laneRuns } = primitives([receiptEvt('gm-1', 'deployed')])
    await makeWorker(p).pumpOnce()
    assert.equal(laneRuns.length, 0, 'a manual plan never spawns a lane')
    assert.equal((await getReleaseJob('gm-1'))?.status, 'manual_required')
  })

  it('the local fuse blocks a claim (job stays received)', async () => {
    await insertJob('fz-1')
    await engageReleaseFuse({ reason: 'test', releaseRequestId: 'other' })
    const { p, laneRuns } = primitives([receiptEvt('fz-1', 'deployed')])
    await makeWorker(p).pumpOnce()
    assert.equal(laneRuns.length, 0)
    assert.equal((await getReleaseJob('fz-1'))?.status, 'received')
  })

  it('a release revoked by a terminal-job cancel is cancel-closed, never deployed', async () => {
    await insertJob('rv-1')
    await insertJobReceived({ repairId: 'r-rv-1', incidentId: 'inc-rv-1', attempt: 0, payloadHash: 'x' })
    await setJobReleaseRevoked('r-rv-1')
    const { p, laneRuns } = primitives([receiptEvt('rv-1', 'deployed')])
    await makeWorker(p).pumpOnce()
    assert.equal(laneRuns.length, 0)
    assert.equal((await getReleaseJob('rv-1'))?.status, 'cancelled')
  })

  it('global singleflight: a second received job is not claimed while one is deploying', async () => {
    // Pre-claim job A (deploying) and keep its scope "active" so recovery skips it.
    await insertJob('sf-a')
    const claim = await claimReleaseJob({ releaseRequestId: 'sf-a', scopeUnit: 'scope-a' })
    assert.equal(claim.outcome, 'claimed')
    await insertJob('sf-b')
    const { p, laneRuns } = primitives([receiptEvt('sf-b', 'deployed')], {
      activeScopes: new Set(['scope-a']),
    })
    await makeWorker(p).pumpOnce()
    assert.equal(laneRuns.length, 0, 'no new lane while another deploy is in flight')
    assert.equal((await getReleaseJob('sf-b'))?.status, 'received', 'B stays received (busy)')
    assert.equal((await getReleaseJob('sf-a'))?.status, 'deploying', 'A left untouched (scope active)')
  })
})

describe('release worker — crash recovery (never re-runs deploy)', () => {
  it('deploying + persisted receipt → normal close (idempotent)', async () => {
    await insertJob('rc-1')
    await claimReleaseJob({ releaseRequestId: 'rc-1', scopeUnit: 'scope-rc1' })
    await setReleaseJobReceipt('rc-1', JSON.stringify(receiptEvt('rc-1', 'deployed')))
    const { p, laneRuns } = primitives([]) // scopeLiveness='inactive' → dead lane
    await makeWorker(p).pumpOnce()
    assert.equal(laneRuns.length, 0, 'recovery never re-runs deploy')
    assert.equal((await getReleaseJob('rc-1'))?.status, 'deployed')
  })

  it('deploying + checkpoint but NO receipt → retry push, close deployed from checkpoint', async () => {
    await insertJob('rc-2')
    await claimReleaseJob({ releaseRequestId: 'rc-2', scopeUnit: 'scope-rc2' })
    await setReleaseJobCheckpoint('rc-2', JSON.stringify(checkpointEvt('rc-2')))
    const { p, laneRuns } = primitives([])
    await makeWorker(p).pumpOnce()
    assert.equal(laneRuns.length, 0)
    const job = await getReleaseJob('rc-2')
    assert.equal(job?.status, 'deployed', 'checkpoint proves deploy applied → deployed')
    const dep = (await outbox('rc-2')).find((r) => r.phase === 'deployed')!
    assert.ok(dep.detail.proofs, 'the deployed callback carries the checkpoint proofs')
  })

  it('deploying + NO receipt + NO checkpoint → deploy_unknown + fuse', async () => {
    await insertJob('rc-3')
    await claimReleaseJob({ releaseRequestId: 'rc-3', scopeUnit: 'scope-rc3' })
    const { p } = primitives([])
    await makeWorker(p).pumpOnce()
    assert.equal((await getReleaseJob('rc-3'))?.status, 'deploy_unknown')
    assert.equal((await getReleaseFuse()).engaged, true)
  })

  it('deploying + scope STILL active → left alone (no premature settle)', async () => {
    await insertJob('rc-4')
    await claimReleaseJob({ releaseRequestId: 'rc-4', scopeUnit: 'scope-rc4' })
    const { p } = primitives([], { activeScopes: new Set(['scope-rc4']) })
    await makeWorker(p).pumpOnce()
    assert.equal((await getReleaseJob('rc-4'))?.status, 'deploying', 'still running → untouched')
  })
})

describe('release worker — trusted attestation (red line 1)', () => {
  it('origin=auto + deployed mints a trusted attestation in the callback detail', async () => {
    await insertJob('att-1', { origin: 'auto' })
    await insertJobReceived({ repairId: 'r-att-1', incidentId: 'inc-att-1', attempt: 0, payloadHash: 'x' })
    await setJobFrozenRouting('r-att-1', 'ops.monitor:svc_v5', 'tier2', null)
    const { p } = primitives([checkpointEvt('att-1'), receiptEvt('att-1', 'deployed')])
    await makeWorker(p).pumpOnce()
    const dep = (await outbox('att-1')).find((r) => r.phase === 'deployed')!
    const att = dep.detail.trusted_attestation as Record<string, unknown> | undefined
    assert.ok(att, 'auto+deployed mints an attestation')
    assert.equal(att.executionMode, 'fully_automatic')
    assert.equal(att.target, 'service:v5')
    assert.equal(att.incidentId, 'inc-att-1')
  })

  it('origin=v5 + deployed mints NO attestation (human release)', async () => {
    await insertJob('att-2', { origin: 'v5' })
    const { p } = primitives([checkpointEvt('att-2'), receiptEvt('att-2', 'deployed')])
    await makeWorker(p).pumpOnce()
    const dep = (await outbox('att-2')).find((r) => r.phase === 'deployed')!
    assert.equal(dep.detail.trusted_attestation, undefined, 'human origin never attests')
  })
})
