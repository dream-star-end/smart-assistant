/**
 * OCV5-591 A2-1a orchestrator engine on real Postgres (0324_media_studio), with a fake provider
 * whose ledger is keyed on exec_request_id like the real adapters:
 *
 *   1. two processes advancing the same project at once dispatch each step once; two workers claim
 *      disjoint tasks; spent ends equal to the charges and every reservation is released.
 *   2. a worker that lost its lease commits nothing; the new holder replays the provider call and
 *      the charge is booked exactly once.
 *   3. a failure books what was charged at that moment; a charge that settles later is booked by
 *      reconcileCharges (once — a second pass changes nothing) and pauses an over-budget project.
 *   4. canceling queued work releases its reservations and cancels its takes, including the take a
 *      retried task left 'running'.
 *   5. a reservation that does not fit pauses the project instead of dispatching.
 *   6. (code r1) the model is frozen at dispatch; a late video never overrides the user's choice or a
 *      shot sent to the user; an unexpected executor error is retried, then closes the task with its
 *      charge booked; the reconciler skips a provider that cannot read its ledger; a bible entry no
 *      provider can make hands the project to the user; GC keeps a take whose image an asset uses.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'

import { closePool, createPool, getPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'
import { InMemoryPreCheckRedis } from '../billing/preCheck.js'
import { PricingCache } from '../billing/pricing.js'
import { makeGrokRunner } from '../grok/visionProxy.js'
import { PUBLIC_VISION_AUTHZ, grokVisionSnapshot, grokVisionUpstreamPayload } from './helpers/grokVisionFixtures.js'
import { StudioBlobStore } from '../media-studio/blobs.js'
import { runStudioGc } from '../media-studio/gc.js'
import { advanceProject, dispatchRequest } from '../media-studio/orchestrator/advance.js'
import { makeOrchestratorApi } from '../media-studio/orchestrator/service.js'
import {
  type ExecuteDeps,
  LeaseLostError,
  executeTask,
} from '../media-studio/orchestrator/execute.js'
import { reconcileCharges } from '../media-studio/orchestrator/reconcile.js'
import type { ProviderRegistry } from '../media-studio/providers/registry.js'
import {
  type MediaKind,
  type MediaProvider,
  MediaProviderError,
  type MediaRequest,
  type MediaResult,
  type ModelInfo,
} from '../media-studio/providers/types.js'
import {
  cancelQueuedStudioTasks,
  claimStudioTasks,
  retryStudioTask,
} from '../media-studio/queue.js'
import { StudioStore } from '../media-studio/store.js'
import { prepareAuthRowResetForTest } from './helpers/authRows.js'
import { resetTestSchemaForTest } from './helpers/db.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'

let pgAvailable = false
let resetRows: (() => Promise<void>) | undefined

async function probe(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 })
  try {
    await p.query('SELECT 1')
    await p.end()
    return true
  } catch {
    try {
      await p.end()
    } catch {
      /* ignore */
    }
    return false
  }
}

before(async () => {
  pgAvailable = await probe()
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error(`test Postgres unavailable at ${TEST_DB_URL}`)
    return
  }
  await resetPool()
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 12 }))
  await resetTestSchemaForTest()
  await runMigrations()
  // Keep the original FK-closure isolation without rewriting every users child
  // table before every case. Business calls still use real, separate transactions.
  resetRows = await prepareAuthRowResetForTest(async (client) => {
    await client.query('DELETE FROM studio_projects')
    await client.query('DELETE FROM studio_blob_refs')
    await client.query('DELETE FROM studio_blobs')
    await client.query('DELETE FROM studio_quota')
    await client.query('DELETE FROM studio_quota_holds')
    await client.query('DELETE FROM studio_step_results')
    // Also check the two roots outside the shared reset's users FK closure.
    const extra = await client.query<{ blobs: number; quota: number }>(
      `SELECT (SELECT count(*) FROM studio_blobs)::int AS blobs,
              (SELECT count(*) FROM studio_quota)::int AS quota`,
    )
    assert.deepEqual(extra.rows, [{ blobs: 0, quota: 0 }])
  })
})

after(async () => {
  if (pgAvailable) {
    try {
      await resetTestSchemaForTest()
    } catch {
      /* ignore */
    }
    await closePool()
  }
})

beforeEach(async () => {
  if (!pgAvailable) return
  assert.ok(resetRows)
  await resetRows()
})

const skip = (t: { skip: (m: string) => void }) => {
  if (!pgAvailable) {
    t.skip('no Postgres test fixture')
    return true
  }
  return false
}

async function user(): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, email_verified, credits)
     VALUES ($1, 'x', TRUE, 0) RETURNING id::text AS id`,
    [`o${randomUUID().slice(0, 8)}@t.local`],
  )
  return r.rows[0]!.id
}

/** A provider with its own ledger keyed on exec_request_id: a replay never charges again. */
class FakeProvider implements MediaProvider {
  readonly adapter = 'fake'
  readonly label = 'Fake'
  readonly priority = 0
  readonly ledger = new Map<string, bigint>()
  calls = 0
  fail: MediaProviderError | null = null
  ledgerDown = false
  extraModels: ModelInfo[] = []
  constructor(
    readonly id: string,
    readonly kind: MediaKind,
    private readonly est = 10n,
    private readonly cost = 6n,
  ) {}
  models() {
    const ops =
      this.kind === 'image'
        ? (['image.generate'] as const)
        : this.kind === 'video'
          ? (['video.from_image'] as const)
          : (['voice.tts'] as const)
    return [{ id: `${this.id}-m`, label: 'm', ops: [...ops], isDefault: true }, ...this.extraModels]
  }
  status() {
    return { state: 'ready' as const }
  }
  estimateMaxCost(_req: MediaRequest) {
    return this.est
  }
  affinity() {
    return null
  }
  async chargedFor(_userId: bigint, exec: string) {
    if (this.ledgerDown) throw new MediaProviderError('PROVIDER_UNAVAILABLE', true, 'down')
    return this.ledger.get(exec) ?? 0n
  }
  async run(ctx: { execRequestId: string }, req: MediaRequest): Promise<MediaResult> {
    this.calls += 1
    if (this.fail) throw this.fail
    const charged = !this.ledger.has(ctx.execRequestId)
    if (charged) this.ledger.set(ctx.execRequestId, this.cost)
    return {
      outputs: [
        {
          bytes: Buffer.from(`${req.op}:${ctx.execRequestId}`),
          mime: req.op === 'voice.tts' ? 'audio/mpeg' : 'image/png',
          ...(req.op === 'voice.tts' ? { durationMs: 1200 } : {}),
        },
      ],
      model: `${this.id}-m`,
      costCredits: this.ledger.get(ctx.execRequestId)!,
      charged,
      overReservation: false,
      providerRef: { table: 'fake_ledger', id: ctx.execRequestId },
    }
  }
}

function registry(...ps: FakeProvider[]): ProviderRegistry {
  return {
    list: () => ps,
    get: (id) => ps.find((p) => p.id === id),
    candidates: (kind, op, _user, opts) =>
      ps.filter(
        (p) =>
          p.kind === kind &&
          p.models().some((m) => (m.ops as string[]).includes(op)) &&
          !(opts?.exclude ?? []).includes(p.id),
      ),
    describe: () => ({ kinds: [] }),
  }
}

async function deps(...ps: FakeProvider[]): Promise<ExecuteDeps> {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-orch-'))
  return {
    pool: getPool(),
    providers: registry(...ps),
    blobs: new StudioBlobStore({
      pool: getPool(),
      root,
      freeBytes: async () => 100n * 1024n ** 3n,
    }),
    systemVoices: async () => [],
  }
}

/** Claims the project's one due task and runs it. */
async function runOne(d: ExecuteDeps, owner = 'A') {
  const [task] = await claimStudioTasks(getPool(), { owner, limit: 1, museOnline: false })
  assert.ok(task, 'a due task')
  await executeTask(d, task, signal())
  return task
}

/** A shot with a finished frame, ready to get its video. */
async function shotWithFrame(d: ExecuteDeps, p: { id: string }) {
  await advanceProject(d, p.id)
  await runOne(d)
  await advanceProject(d, p.id)
  const shot = await query<{ id: string }>(
    'SELECT id::text AS id FROM studio_shots WHERE project_id = $1',
    [p.id],
  )
  return shot.rows[0]!.id
}
/** A running project with locked bible, `shots` planned shots and no lines. */
async function runningProject(
  shots: number,
  budget = 2000,
): Promise<{ id: string; userId: string }> {
  const userId = await user()
  const p = await new StudioStore(getPool()).createProject(userId, { budgetCredits: budget })
  await query(
    `UPDATE studio_projects SET status = 'running',
            settings = settings || '{"narration":{"voiceId":"male-qn-jingying"},"musicSkippedNoted":true}'::jsonb
      WHERE id = $1`,
    [p.id],
  )
  for (let i = 0; i < shots; i++) {
    await query(
      `INSERT INTO studio_shots(id, project_id, ordinal, spec)
       VALUES (gen_random_uuid(), $1, $2, '{"title":"s","framing":"wide","action":"a","durationSec":4}'::jsonb)`,
      [p.id, i],
    )
  }
  return { id: p.id, userId }
}

async function money(
  projectId: string,
): Promise<{ spent: bigint; reserved: bigint; status: string }> {
  const r = await query<{ spent: string; reserved: string; status: string }>(
    'SELECT spent_credits::text AS spent, reserved_credits::text AS reserved, status FROM studio_projects WHERE id = $1',
    [projectId],
  )
  const row = r.rows[0]!
  return { spent: BigInt(row.spent), reserved: BigInt(row.reserved), status: row.status }
}

async function takes(projectId: string) {
  const r = await query<{ id: string; owner_kind: string; status: string; cost: string }>(
    `SELECT id::text AS id, owner_kind, status, cost_credits::text AS cost
       FROM studio_takes WHERE project_id = $1 ORDER BY owner_kind, version`,
    [projectId],
  )
  return r.rows
}

const signal = () => new AbortController().signal

describe('studio orchestrator engine (OCV5-591 A2-1a)', () => {
  test('real planner SSE commits ordered deltas before completion and produces the same final plan as JSON', async (t) => {
    if (skip(t)) return
    const plan = {
      title: '冬日来客',
      shots: [{ title: '晨雾', framing: '远景', action: '红狐走出晨雾', durationSec: 6 }],
      bible: [{ kind: 'character', name: '红狐', descriptor: '橙红毛，胸口白色' }],
      narration: null, music: null,
    }
    const text = JSON.stringify(plan)
    const deltaTexts = [text.slice(0, 50), text.slice(50)]
    const finalized: unknown[] = []
    for (const streaming of [true, false]) {
      const userId = await user()
      const project = await new StudioStore(getPool()).createProject(userId, { brief: '红狐短片', targetSec: 6, budgetCredits: 2000 })
      await query("UPDATE studio_projects SET status = 'planning' WHERE id = $1", [project.id])
      const d = await deps(new FakeProvider('img', 'image'))
      await advanceProject(d, project.id)
      const [task] = await claimStudioTasks(getPool(), { owner: 'planner', limit: 1, museOnline: false })
      assert.ok(task)
      let calls = 0
      const billing = async () => { throw new Error('platform planner touched user billing') }
      d.grok = makeGrokRunner({
        getPool, preCheckRedis: new InMemoryPreCheckRedis(), pricing: new PricingCache(),
        catalog: { assertFresh: async () => grokVisionSnapshot() }, loadUserModelAuthz: async () => PUBLIC_VISION_AUTHZ,
        pickAccountId: async () => 24n, freshToken: async () => Buffer.from('test-token'), recordStatus: async () => {},
        preCheckWithCostFn: billing, startInflightJournalFn: billing, settleDurableCodexBillingFn: billing,
        abortInflightJournalFn: billing, releasePreCheckFn: billing,
        requestFn: async (_url, init) => {
          calls++
          const isPlan = JSON.parse(init.body).stream === true
          const json = grokVisionUpstreamPayload({ text: isPlan ? text : '{"verdict":"pass","reason":""}' })
          if (!isPlan || !streaming) return { statusCode: 200, body: { text: async () => JSON.stringify(json) } }
          const event = (v: unknown) => Buffer.from(`data: ${JSON.stringify(v)}\n\n`)
          const body = {
            text: async () => { throw new Error('SSE was buffered') },
            async *[Symbol.asyncIterator]() {
              for (const [i, delta] of deltaTexts.entries()) {
                yield event({ type: 'response.output_text.delta', delta })
                const rows = await query<{ payload: { seq: number; delta: string } }>("SELECT payload FROM studio_events WHERE project_id=$1 AND type='plan.delta' ORDER BY id", [project.id])
                assert.deepEqual(rows.rows.map((r) => [r.payload.seq, r.payload.delta]), deltaTexts.slice(0, i + 1).map((s, n) => [n + 1, s]))
                assert.equal((await query('SELECT 1 FROM studio_shots WHERE project_id=$1', [project.id])).rowCount, 0)
              }
              yield event({ type: 'response.completed', response: json })
            },
          }
          return { statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body }
        },
      })
      await executeTask(d, task, signal())
      assert.equal(calls, 2, 'one moderation and one planning request, no extra fallback request')
      const shots = await query('SELECT ordinal, spec FROM studio_shots WHERE project_id=$1 ORDER BY ordinal', [project.id])
      const assets = await query('SELECT kind, name, descriptor FROM studio_assets WHERE project_id=$1', [project.id])
      finalized.push({ shots: shots.rows, assets: assets.rows })
      const events = await query<{ type: string }>("SELECT type FROM studio_events WHERE project_id=$1 AND type LIKE 'plan.%' ORDER BY id", [project.id])
      assert.deepEqual(events.rows.map((r) => r.type), streaming ? ['plan.delta', 'plan.delta', 'plan.ready'] : ['plan.ready'])
    }
    assert.deepEqual(finalized[0], finalized[1])
  })
  test('concurrent advances dispatch once; concurrent workers split the work; money adds up', async (t) => {
    if (skip(t)) return
    const img = new FakeProvider('img', 'image')
    const d = await deps(img)
    const p = await runningProject(2)

    const results = await Promise.all([1, 2, 3, 4].map(() => advanceProject(d, p.id)))
    assert.ok(results.some((x) => x))
    // Whoever lost the advisory lock returned false; nothing was dispatched twice.
    const queued = await takes(p.id)
    assert.equal(queued.length, 2)
    assert.ok(queued.every((x) => x.owner_kind === 'shot_frame' && x.status === 'queued'))
    assert.equal((await money(p.id)).reserved, 20n)
    // A later pass sees the live takes and adds nothing.
    await advanceProject(d, p.id)
    assert.equal((await takes(p.id)).length, 2)

    const [a, b] = await Promise.all([
      claimStudioTasks(getPool(), { owner: 'A', limit: 2, museOnline: false }),
      claimStudioTasks(getPool(), { owner: 'B', limit: 2, museOnline: false }),
    ])
    const claimed = [...a, ...b]
    assert.equal(claimed.length, 2)
    assert.equal(new Set(claimed.map((x) => x.id)).size, 2)
    await Promise.all(claimed.map((task) => executeTask(d, task, signal())))

    const done = await takes(p.id)
    assert.deepEqual(
      done.map((x) => [x.status, x.cost]),
      [
        ['succeeded', '6'],
        ['succeeded', '6'],
      ],
    )
    assert.deepEqual(await money(p.id), { spent: 12n, reserved: 0n, status: 'running' })
    assert.equal(img.calls, 2)
  })

  test('a worker that lost its lease commits nothing; the charge is booked once', async (t) => {
    if (skip(t)) return
    const img = new FakeProvider('img', 'image')
    const d = await deps(img)
    const p = await runningProject(1)
    await advanceProject(d, p.id)

    const [stale] = await claimStudioTasks(getPool(), { owner: 'A', limit: 1, museOnline: false })
    assert.ok(stale)
    await query("UPDATE studio_tasks SET lease_until = NOW() - INTERVAL '1 second' WHERE id = $1", [
      stale.id,
    ])
    const [fresh] = await claimStudioTasks(getPool(), { owner: 'B', limit: 1, museOnline: false })
    assert.ok(fresh)
    assert.equal(fresh.id, stale.id)
    assert.equal(fresh.epoch, stale.epoch + 1)

    // A still finishes its upstream call (and pays), but its commit is refused.
    await assert.rejects(executeTask(d, stale, signal()), LeaseLostError)
    assert.equal((await takes(p.id))[0]!.status, 'running')
    assert.deepEqual(await money(p.id), { spent: 0n, reserved: 10n, status: 'running' })

    // B replays the same exec id: no second charge, booked exactly once.
    await executeTask(d, fresh, signal())
    assert.equal(img.calls, 2)
    assert.equal(img.ledger.size, 1)
    const [only] = await takes(p.id)
    assert.equal(only!.status, 'succeeded')
    assert.equal(only!.cost, '6')
    assert.deepEqual(await money(p.id), { spent: 6n, reserved: 0n, status: 'running' })
    const booked = await query<{ booked: string; status: string }>(
      "SELECT payload->>'booked' AS booked, status FROM studio_tasks WHERE id = $1",
      [fresh.id],
    )
    assert.deepEqual(booked.rows[0], { booked: '6', status: 'done' })
  })

  test('a late charge after a failure is booked by the reconciler, once, and pauses over budget', async (t) => {
    if (skip(t)) return
    const img = new FakeProvider('img', 'image', 10n, 6n)
    img.fail = new MediaProviderError('UPSTREAM_REJECTED', false, 'nope')
    const d = await deps(img)
    const p = await runningProject(1, 10)
    await advanceProject(d, p.id)
    const [task] = await claimStudioTasks(getPool(), { owner: 'A', limit: 1, museOnline: false })
    assert.ok(task)
    await executeTask(d, task, signal())

    const [failed] = await takes(p.id)
    assert.equal(failed!.status, 'failed')
    assert.equal(failed!.cost, '0')
    assert.deepEqual(await money(p.id), { spent: 0n, reserved: 0n, status: 'running' })
    assert.equal(await reconcileCharges(d), 0)

    // The abandoned upstream attempt settles later, for more than is left in the budget.
    img.ledger.set(task.execRequestId, 12n)
    assert.equal(await reconcileCharges(d), 1)
    assert.equal((await takes(p.id))[0]!.cost, '12')
    assert.deepEqual(await money(p.id), { spent: 12n, reserved: 0n, status: 'paused' })
    const ev = await query<{ type: string }>(
      `SELECT type FROM studio_events WHERE project_id = $1 AND type IN ('charge.reconciled', 'budget.exceeded_late') ORDER BY id`,
      [p.id],
    )
    assert.deepEqual(
      ev.rows.map((r) => r.type),
      ['charge.reconciled', 'budget.exceeded_late'],
    )
    // A second pass finds nothing new.
    assert.equal(await reconcileCharges(d), 0)
    assert.equal((await money(p.id)).spent, 12n)
  })

  test('canceling queued work releases reservations and cancels takes, also a retried one', async (t) => {
    if (skip(t)) return
    const img = new FakeProvider('img', 'image')
    const d = await deps(img)
    const p = await runningProject(3)
    await advanceProject(d, p.id)
    assert.equal((await money(p.id)).reserved, 30n)

    // One task ran once, hit a retryable error and is queued again; its take stayed 'running'.
    const [task] = await claimStudioTasks(getPool(), { owner: 'A', limit: 1, museOnline: false })
    assert.ok(task)
    await query(`UPDATE studio_takes SET status = 'running' WHERE id = $1`, [
      (task.payload as { takeId: string }).takeId,
    ])
    assert.ok(await retryStudioTask(getPool(), task, { delaySeconds: 30, error: 'retry' }))

    assert.equal(await cancelQueuedStudioTasks(getPool(), p.id), 3)
    assert.equal((await money(p.id)).reserved, 0n)
    assert.ok((await takes(p.id)).every((x) => x.status === 'canceled'))
    const left = await query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM studio_tasks WHERE project_id = $1 AND reserved_credits <> 0',
      [p.id],
    )
    assert.equal(left.rows[0]!.n, '0')
  })

  test('the model is frozen in the task at dispatch (code r1 P1)', async (t) => {
    if (skip(t)) return
    const d = await deps(new FakeProvider('img', 'image'))
    const p = await runningProject(1)
    await advanceProject(d, p.id)
    const r = await query<{ model: string }>(
      "SELECT payload->'request'->>'model' AS model FROM studio_tasks WHERE project_id = $1",
      [p.id],
    )
    assert.equal(r.rows[0]!.model, 'img-m')
  })

  test('a voice design is frozen to the model that runs it, not the TTS default (code r2 P1)', async (t) => {
    if (skip(t)) return
    const voice = new FakeProvider('mm', 'voice')
    voice.extraModels = [{ id: 'mm-design', label: 'design', ops: ['voice.design'] }]
    const d = await deps(voice)
    const p = await runningProject(0)
    const asset = await query<{ id: string }>(
      `INSERT INTO studio_assets(id, project_id, user_id, kind, name, descriptor)
       VALUES (gen_random_uuid(), $1, $2, 'voice', '旁白', '沉稳') RETURNING id::text AS id`,
      [p.id, p.userId],
    )
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      const out = await dispatchRequest(
        client,
        d,
        { id: p.id, userId: p.userId },
        { ownerKind: 'bible', ownerId: asset.rows[0]!.id, op: 'voice.design', exclude: [] },
        { op: 'voice.design', prompt: '沉稳男声', text: '清晨' },
      )
      assert.equal(out, 'queued')
      await client.query('COMMIT')
    } finally {
      client.release()
    }
    const r = await query<{ model: string; take: string }>(
      `SELECT t.payload->'request'->>'model' AS model, k.model AS take
         FROM studio_tasks t JOIN studio_takes k ON k.id::text = t.payload->>'takeId'
        WHERE t.project_id = $1`,
      [p.id],
    )
    assert.deepEqual(r.rows[0], { model: 'mm-design', take: 'mm-design' })
  })

  test("a late video never overrides the user's pick or a shot sent to the user (code r1 P1)", async (t) => {
    if (skip(t)) return
    const d = await deps(new FakeProvider('img', 'image'), new FakeProvider('vid', 'video'))
    const p = await runningProject(1)
    const shotId = await shotWithFrame(d, p)
    // The video is in flight; meanwhile a long line sends the shot to the user.
    const video = await query<{ id: string }>(
      "SELECT id::text AS id FROM studio_takes WHERE owner_kind = 'shot_video' AND owner_id = $1",
      [shotId],
    )
    assert.equal(video.rows.length, 1)
    await query(`UPDATE studio_shots SET status = 'needs_user' WHERE id = $1`, [shotId])
    await runOne(d)
    const s1 = await query<{ status: string; active: string | null }>(
      'SELECT status, active_take_id::text AS active FROM studio_shots WHERE id = $1',
      [shotId],
    )
    assert.deepEqual(s1.rows[0], { status: 'needs_user', active: null })
    // The take is still a finished version the user can choose.
    const v = await query<{ status: string }>('SELECT status FROM studio_takes WHERE id = $1', [
      video.rows[0]!.id,
    ])
    assert.equal(v.rows[0]!.status, 'succeeded')

    // Back to work: the next advance adopts the finished video instead of paying for another.
    await query(`UPDATE studio_shots SET status = 'generating' WHERE id = $1`, [shotId])
    await advanceProject(d, p.id)
    const s2 = await query<{ status: string; active: string | null }>(
      'SELECT status, active_take_id::text AS active FROM studio_shots WHERE id = $1',
      [shotId],
    )
    assert.deepEqual(s2.rows[0], { status: 'ready', active: video.rows[0]!.id })
  })

  test("after a failed video the user's frame pick retries the same provider (INC-20261027-STUDIO-RETRY-PROVIDER-EXCLUDED)", async (t) => {
    if (skip(t)) return
    // prod 2026-10-27 c6f0a9f2: Muse (the only video provider) failed one video of a shot; the user
    // picked the first frame and the shot was handed straight back with provider.exhausted.
    const vid = new FakeProvider('vid', 'video')
    vid.fail = new MediaProviderError('UPSTREAM_REJECTED', false, 'lost')
    const d = await deps(new FakeProvider('img', 'image'), vid)
    const p = await runningProject(1)
    const shotId = await shotWithFrame(d, p)
    await runOne(d)
    await advanceProject(d, p.id) // no other video provider: the shot goes to the user
    await advanceProject(d, p.id) // and with it the project
    const handed = await query<{ status: string; reason: string | null; shot: string }>(
      `SELECT p.status, p.settings->>'awaitingReason' AS reason, s.status AS shot
         FROM studio_projects p JOIN studio_shots s ON s.project_id = p.id WHERE p.id = $1`,
      [p.id],
    )
    assert.deepEqual(handed.rows[0], { status: 'awaiting_user', reason: 'needs_user', shot: 'needs_user' })
    const callsBefore = vid.calls

    vid.fail = null
    const frame = await query<{ id: string }>(
      "SELECT id::text AS id FROM studio_takes WHERE owner_kind = 'shot_frame' AND owner_id = $1 AND status = 'succeeded'",
      [shotId],
    )
    const api = makeOrchestratorApi(getPool(), () => {}, d)
    await api.selectTake(p.userId, frame.rows[0]!.id)
    await advanceProject(d, p.id)
    const queued = await query<{ provider: string; version: number; status: string }>(
      `SELECT provider, version, status FROM studio_takes
        WHERE owner_kind = 'shot_video' AND owner_id = $1 ORDER BY version`,
      [shotId],
    )
    assert.deepEqual(
      queued.rows.map((r) => `${r.provider} v${r.version} ${r.status}`),
      ['vid v1 failed', 'vid v2 queued'],
      'the pick must dispatch a new video on the provider that failed before',
    )
    await runOne(d)
    assert.equal(vid.calls, callsBefore + 1, 'the retried video ran on the same provider')
    await advanceProject(d, p.id)
    const done = await query<{ status: string; active: string | null }>(
      `SELECT s.status, t.status AS active FROM studio_shots s LEFT JOIN studio_takes t ON t.id = s.active_take_id
        WHERE s.id = $1`,
      [shotId],
    )
    assert.deepEqual(done.rows[0], { status: 'ready', active: 'succeeded' }, 'the retried video is adopted')
  })

  test('an unexpected executor error is retried, then closes the task with its charge booked (code r1 P1)', async (t) => {
    if (skip(t)) return
    const img = new FakeProvider('img', 'image')
    const d = await deps(img)
    // The provider charges, then storing the result keeps failing (e.g. the user's quota).
    d.blobs.put = async () => {
      throw new Error('quota')
    }
    const p = await runningProject(1)
    await advanceProject(d, p.id)
    for (let attempt = 1; attempt <= 3; attempt++) {
      const task = await runOne(d)
      const row = await query<{ status: string }>('SELECT status FROM studio_tasks WHERE id = $1', [
        task.id,
      ])
      assert.equal(row.rows[0]!.status, attempt < 3 ? 'queued' : 'failed', `attempt ${attempt}`)
      await query('UPDATE studio_tasks SET run_after = NOW() WHERE id = $1', [task.id])
    }
    assert.equal(img.calls, 3)
    assert.equal(img.ledger.size, 1, 'replays never charge again')
    const [take] = await takes(p.id)
    assert.deepEqual([take!.status, take!.cost], ['failed', '6'])
    assert.deepEqual(await money(p.id), { spent: 6n, reserved: 0n, status: 'running' })
  })

  test('waiting out a pause does not use up attempts (code r2 P1)', async (t) => {
    if (skip(t)) return
    const img = new FakeProvider('img', 'image')
    const d = await deps(img)
    const p = await runningProject(1)
    await advanceProject(d, p.id)
    await query(`UPDATE studio_projects SET status = 'paused' WHERE id = $1`, [p.id])
    for (let i = 0; i < 8; i++) {
      await runOne(d)
      await query('UPDATE studio_tasks SET run_after = NOW() WHERE project_id = $1', [p.id])
    }
    const task = await query<{ status: string; attempts: number }>(
      'SELECT status, attempts FROM studio_tasks WHERE project_id = $1',
      [p.id],
    )
    assert.deepEqual(task.rows[0], { status: 'queued', attempts: 0 })
    assert.equal(img.calls, 0)
    await query(`UPDATE studio_projects SET status = 'running' WHERE id = $1`, [p.id])
    await runOne(d)
    assert.equal((await takes(p.id))[0]!.status, 'succeeded')
  })

  test('a task claimed too many times is closed instead of re-running forever (code r1 P1)', async (t) => {
    if (skip(t)) return
    const img = new FakeProvider('img', 'image')
    const d = await deps(img)
    const p = await runningProject(1)
    await advanceProject(d, p.id)
    await query('UPDATE studio_tasks SET attempts = 6 WHERE project_id = $1', [p.id])
    await runOne(d)
    assert.equal(img.calls, 0)
    assert.equal((await takes(p.id))[0]!.status, 'failed')
    assert.equal((await money(p.id)).reserved, 0n)
  })

  test('the reconciler skips a provider that cannot read its ledger (code r1 P1)', async (t) => {
    if (skip(t)) return
    const img = new FakeProvider('img', 'image')
    const d = await deps(img)
    const p = await runningProject(1)
    await advanceProject(d, p.id)
    await runOne(d)
    assert.equal((await money(p.id)).spent, 6n)
    img.ledgerDown = true
    assert.equal(await reconcileCharges(d), 0)
    assert.equal((await money(p.id)).spent, 6n, 'unknown is not a refund')
    assert.equal((await takes(p.id))[0]!.cost, '6')
  })

  test('a bible entry no provider can make hands the project to the user (code r1 P1)', async (t) => {
    if (skip(t)) return
    const img = new FakeProvider('img', 'image')
    img.fail = new MediaProviderError('UPSTREAM_REJECTED', false, 'nope')
    const d = await deps(img)
    const p = await runningProject(1)
    await query(
      `INSERT INTO studio_assets(id, project_id, user_id, kind, name, descriptor)
       VALUES (gen_random_uuid(), $1, $2, 'character', '狐狸', '红狐')`,
      [p.id, p.userId],
    )
    await advanceProject(d, p.id)
    await runOne(d)
    await advanceProject(d, p.id)
    const r = await query<{ status: string; reason: string }>(
      "SELECT status, settings->>'awaitingReason' AS reason FROM studio_projects WHERE id = $1",
      [p.id],
    )
    assert.deepEqual(r.rows[0], { status: 'awaiting_user', reason: 'needs_user' })
    // Further passes do nothing (the project is no longer running).
    await advanceProject(d, p.id)
    const ev = await query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM studio_events WHERE project_id = $1 AND type = 'provider.exhausted'",
      [p.id],
    )
    assert.equal(ev.rows[0]!.n, '1')
  })

  test('GC keeps an old take whose image a bible asset uses (code r1 P1)', async (t) => {
    if (skip(t)) return
    const d = await deps(new FakeProvider('img', 'image'))
    const p = await runningProject(1)
    await query(
      `INSERT INTO studio_assets(id, project_id, user_id, kind, name, descriptor)
       VALUES (gen_random_uuid(), $1, $2, 'character', '狐狸', '红狐')`,
      [p.id, p.userId],
    )
    await advanceProject(d, p.id)
    await runOne(d)
    const a = await query<{ sha: string; locked: boolean }>(
      "SELECT blob_sha AS sha, locked FROM studio_assets WHERE project_id = $1 AND kind = 'character'",
      [p.id],
    )
    assert.equal(a.rows[0]!.locked, true)
    await query(
      "UPDATE studio_takes SET finished_at = NOW() - INTERVAL '40 days' WHERE project_id = $1",
      [p.id],
    )
    await runStudioGc({ pool: getPool(), blobs: d.blobs })
    assert.ok(await d.blobs.open(BigInt(p.userId), a.rows[0]!.sha), 'the asset image survives')
  })

  test('a step that does not fit the budget pauses the project instead of dispatching', async (t) => {
    if (skip(t)) return
    const d = await deps(new FakeProvider('img', 'image', 10n, 6n))
    const p = await runningProject(3, 25)
    await advanceProject(d, p.id)
    // Two frames fit (20 of 25); the third does not → paused, nothing reserved beyond the budget.
    const m = await money(p.id)
    assert.equal(m.status, 'paused')
    assert.equal(m.reserved, 20n)
    assert.equal((await takes(p.id)).length, 2)
    const ev = await query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM studio_events WHERE project_id = $1 AND type = 'budget.exhausted'",
      [p.id],
    )
    assert.equal(ev.rows[0]!.n, '1')
  })
})
