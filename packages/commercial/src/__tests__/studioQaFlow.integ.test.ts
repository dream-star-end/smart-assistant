/**
 * OCV5-591 A2-1b-1 integ: visual QA end to end on the real schema — a fake Grok (that settles a
 * charge into usage_records + credit_ledger like the real one) and a fake sandbox for clip frames.
 *   - a frame is judged before use; the charge lands on the user's ledger and the project's spent
 *   - three failing attempts hand the shot to the user even while the scores improve (plan r1 P1)
 *   - a moderation block is never adopted and not redone
 *   - a stored answer is reused (no second call, no second charge); a bad answer is asked once more
 *   - a passing clip is adopted as the shot's video; bible candidates: the best passing one locks
 *   - a QA task of a finished project releases its reservation; reconcile books a late charge
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'

import sharp from 'sharp'

import { closePool, createPool, getPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'
import type { GrokRunInput, GrokRunner } from '../grok/visionProxy.js'
import { StudioBlobStore } from '../media-studio/blobs.js'
import type { ComposeResult } from '../media-studio/compose/runner.js'
import type { ComposeOp } from '../media-studio/compose/spec.js'
import { type AdvanceDeps, advanceProject } from '../media-studio/orchestrator/advance.js'
import type { ComposeRunnerLike } from '../media-studio/orchestrator/compose.js'
import { type ExecuteDeps, executeTask } from '../media-studio/orchestrator/execute.js'
import { reconcileCharges } from '../media-studio/orchestrator/reconcile.js'
import type { ProviderRegistry } from '../media-studio/providers/registry.js'
import { claimStudioTasks } from '../media-studio/queue.js'
import { StudioStore } from '../media-studio/store.js'
import { resetTestSchemaForTest } from './helpers/db.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
let pgAvailable = false

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
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 8 }))
  await resetTestSchemaForTest()
  await runMigrations()
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
  await query(
    'TRUNCATE TABLE studio_projects, studio_blob_refs, studio_blobs, studio_quota, studio_quota_holds, studio_step_results, usage_records, credit_ledger, users RESTART IDENTITY CASCADE',
  )
})

const skip = (t: { skip: (m: string) => void }) => {
  if (!pgAvailable) {
    t.skip('no Postgres test fixture')
    return true
  }
  return false
}

const noProviders: ProviderRegistry = {
  list: () => [],
  get: () => undefined,
  candidates: () => [],
  describe: () => ({ kinds: [] }),
}

const png = (r: number) =>
  sharp({ create: { width: 320, height: 180, channels: 3, background: { r, g: 90, b: 140 } } })
    .png()
    .toBuffer()

const answer = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    character: 0.9,
    scene: 0.9,
    action: 0.9,
    artifacts: 0.95,
    moderation: 'pass',
    confidence: 0.9,
    summary: '角色一致，画面干净',
    issues: [],
    ...over,
  })

/** A Grok that answers from a list and settles each call like the real one (usage + ledger). */
class FakeGrok {
  calls: GrokRunInput[] = []
  answers: string[] = []
  chargeEach = 7n
  run: GrokRunner = async (input) => {
    this.calls.push(input)
    const text = this.answers.shift() ?? answer()
    const requestId = input.attempt ? `${input.requestId}~${input.attempt}` : input.requestId
    await input.onResult?.({ text, usage: {} as never, model: 'grok-build', requestId })
    if (input.billTo === 'user' && this.chargeEach > 0n)
      await settle(input.userId, requestId, this.chargeEach)
    return { text, model: 'grok-build', usage: {} as never, requestId }
  }
}

async function settle(userId: bigint, requestId: string, credits: bigint) {
  const u = await query<{ id: string }>(
    `INSERT INTO usage_records(user_id, mode, model, input_tokens, output_tokens, cache_read_tokens,
                               price_snapshot, cost_credits, request_id, status)
     VALUES ($1, 'chat', 'grok-build', 1, 1, 0, '{}'::jsonb, $2, $3, 'success') RETURNING id::text AS id`,
    [userId.toString(), credits.toString(), requestId],
  )
  await query(
    `INSERT INTO credit_ledger(user_id, delta, balance_after, reason, ref_type, ref_id)
     VALUES ($1, $2, 0, 'chat', 'usage_record', $3)`,
    [userId.toString(), (-credits).toString(), u.rows[0]!.id],
  )
}

/** A sandbox whose `frames` writes one PNG per time point. */
class FakeRunner implements ComposeRunnerLike {
  ran: ComposeOp[] = []
  constructor(private readonly root: string) {}
  configured() {
    return true
  }
  async prepare(jobId: string) {
    const inDir = path.join(this.root, jobId, 'in')
    const outDir = path.join(this.root, jobId, 'out')
    await mkdir(inDir, { recursive: true })
    await mkdir(outDir, { recursive: true })
    return { inDir, outDir }
  }
  async run(jobId: string, op: ComposeOp): Promise<ComposeResult> {
    this.ran.push(op)
    if (op.op !== 'frames') throw new Error(`unexpected op ${op.op}`)
    const outputs = []
    for (const [i] of op.times.entries()) {
      const p = path.join(this.root, jobId, 'out', `frame-${i}.png`)
      const bytes = await png(40 * (i + 1))
      await writeFile(p, bytes)
      outputs.push({ name: `frame-${i}.png`, path: p, bytes: bytes.length })
    }
    return { outputs }
  }
  async cleanup() {}
}

async function setup(opts: { candidates?: 1 | 2 } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'oc-qa-'))
  const blobs = new StudioBlobStore({
    pool: getPool(),
    root: path.join(root, 'blobs'),
    freeBytes: async () => 100n * 1024n ** 3n,
  })
  const grok = new FakeGrok()
  const runner = new FakeRunner(path.join(root, 'work'))
  const qa = {
    enabled: true,
    bibleCandidates: opts.candidates ?? 1,
    maxCost: async () => 10n,
  } as const
  const exec: ExecuteDeps = {
    pool: getPool(),
    blobs,
    providers: noProviders,
    grok: grok.run,
    systemVoices: async () => [],
    compose: runner,
    qa,
  }
  const advanceDeps: AdvanceDeps = { pool: getPool(), providers: noProviders, compose: runner, qa }
  const uid = (
    await query<{ id: string }>(
      `INSERT INTO users(email, password_hash, email_verified, credits) VALUES ($1, 'x', TRUE, 1000) RETURNING id::text AS id`,
      [`q${randomUUID().slice(0, 8)}@t.local`],
    )
  ).rows[0]!.id
  const p = await new StudioStore(getPool()).createProject(uid, { budgetCredits: 500 })
  await query(
    `UPDATE studio_projects SET status = 'running', settings = settings || '{"musicSkippedNoted":true}'::jsonb WHERE id = $1`,
    [p.id],
  )
  const take = async (
    ownerKind: string,
    ownerId: string,
    opts2: { version?: number; mime?: string; bytes?: Buffer; qa?: unknown; ms?: number } = {},
  ) => {
    const id = randomUUID()
    const mime = opts2.mime ?? 'image/png'
    const bytes = opts2.bytes ?? (await png(Math.floor(Math.random() * 200)))
    const sha = (
      await blobs.put({
        userId: BigInt(uid),
        mime,
        maxBytes: bytes.length,
        source: bytes,
        ref: { kind: 'take', id },
      })
    ).sha
    await query(
      `INSERT INTO studio_takes(id, project_id, owner_kind, owner_id, version, provider, model, op, status, blob_sha, cost_credits, meta, qa, finished_at)
       VALUES ($1, $2, $3, $4, $5, 'fake', 'm', 'x', 'succeeded', $6, 0, $7::jsonb, $8::jsonb, NOW())`,
      [
        id,
        p.id,
        ownerKind,
        ownerId,
        opts2.version ?? 1,
        sha,
        JSON.stringify(opts2.ms ? { durationMs: opts2.ms } : {}),
        opts2.qa === undefined ? null : JSON.stringify(opts2.qa),
      ],
    )
    return { id, sha }
  }
  // A locked character (its image is a QA reference) and one shot.
  const asset = randomUUID()
  const ref = await png(220)
  const refSha = (
    await blobs.put({
      userId: BigInt(uid),
      mime: 'image/png',
      maxBytes: ref.length,
      source: ref,
      ref: { kind: 'take', id: asset },
    })
  ).sha
  await query(
    `INSERT INTO studio_assets(id, project_id, user_id, kind, name, descriptor, locked, blob_sha)
     VALUES ($1, $2, $3, 'character', '小狐狸', '橙红色毛，尾尖白', TRUE, $4)`,
    [asset, p.id, uid, refSha],
  )
  const shot = randomUUID()
  await query(
    `INSERT INTO studio_shots(id, project_id, ordinal, spec, status) VALUES ($1, $2, 0, $3::jsonb, 'generating')`,
    [shot, p.id, JSON.stringify({ durationSec: 5, framing: '中景', action: '狐狸穿过雪地' })],
  )
  return { uid, p, grok, runner, exec, advanceDeps, take, shot, asset }
}

async function runOne(exec: ExecuteDeps) {
  const [task] = await claimStudioTasks(getPool(), { owner: 'A', limit: 1, museOnline: false })
  assert.ok(task, 'a due task')
  await executeTask(exec, task, new AbortController().signal)
  return task
}
const takeQa = async (id: string) =>
  (
    await query<{ qa: Record<string, unknown> | null }>(
      'SELECT qa FROM studio_takes WHERE id = $1',
      [id],
    )
  ).rows[0]!.qa
const shotRow = async (id: string) =>
  (
    await query<{ status: string; active: string | null }>(
      'SELECT status, active_take_id::text AS active FROM studio_shots WHERE id = $1',
      [id],
    )
  ).rows[0]!
const projectRow = async (id: string) =>
  (
    await query<{ status: string; spent: string; reserved: string }>(
      'SELECT status, spent_credits::text AS spent, reserved_credits::text AS reserved FROM studio_projects WHERE id = $1',
      [id],
    )
  ).rows[0]!

describe('studio visual QA (OCV5-591 A2-1b-1)', () => {
  test('a frame is judged before use; the charge lands on the ledger and the project', async (t) => {
    if (skip(t)) return
    const s = await setup()
    const f = await s.take('shot_frame', s.shot)
    await advanceProject(s.advanceDeps, s.p.id)
    assert.equal((await shotRow(s.shot)).status, 'qa')
    assert.equal((await projectRow(s.p.id)).reserved, '10', 'the worst case is reserved')
    const task = await runOne(s.exec)
    assert.equal(task.kind, 'qa')
    assert.equal(s.grok.calls.length, 1)
    assert.equal(s.grok.calls[0]!.billTo, 'user')
    assert.equal(s.grok.calls[0]!.image?.mediaType, 'image/jpeg')
    const qa = await takeQa(f.id)
    assert.deepEqual([qa?.passed, qa?.next, qa?.costCredits], [true, 'adopt', '7'])
    assert.equal((await shotRow(s.shot)).status, 'generating', 'ready for its video')
    const p = await projectRow(s.p.id)
    assert.deepEqual([p.spent, p.reserved], ['7', '0'])
  })

  test('three failing attempts hand the shot over even while the scores improve', async (t) => {
    if (skip(t)) return
    const s = await setup()
    const judged = (score: number) => ({
      passed: false,
      next: 'redo',
      score,
      reason: 'below_threshold',
    })
    const v1 = await s.take('shot_frame', s.shot, { version: 1, qa: judged(0.5) })
    const v2 = await s.take('shot_frame', s.shot, { version: 2, qa: judged(0.6) })
    const v3 = await s.take('shot_frame', s.shot, { version: 3 })
    s.grok.answers.push(answer({ character: 0.7 }))
    await advanceProject(s.advanceDeps, s.p.id)
    await runOne(s.exec)
    const qa = await takeQa(v3.id)
    assert.deepEqual([qa?.next, qa?.reason], ['handoff', 'retries_exhausted'])
    assert.equal((await shotRow(s.shot)).status, 'needs_user')
    const ev = await query<{ payload: { takeIds: string[] } }>(
      `SELECT payload FROM studio_events WHERE project_id = $1 AND type = 'shot.needs_user'`,
      [s.p.id],
    )
    assert.deepEqual(ev.rows[0]?.payload.takeIds, [v3.id, v2.id], 'the best two are offered')
    void v1
    await advanceProject(s.advanceDeps, s.p.id)
    assert.equal((await projectRow(s.p.id)).status, 'awaiting_user')
  })

  test('a moderation block is never adopted and not redone', async (t) => {
    if (skip(t)) return
    const s = await setup()
    const f = await s.take('shot_frame', s.shot)
    s.grok.answers.push(answer({ moderation: 'block', summary: '画面含有血腥内容' }))
    await advanceProject(s.advanceDeps, s.p.id)
    await runOne(s.exec)
    const qa = await takeQa(f.id)
    assert.deepEqual([qa?.passed, qa?.next, qa?.reason], [false, 'handoff', 'moderation_block'])
    assert.equal((await shotRow(s.shot)).status, 'needs_user')
  })

  test('a stored answer is reused; a bad answer is asked once more, then counts as unsure', async (t) => {
    if (skip(t)) return
    const s = await setup()
    const f = await s.take('shot_frame', s.shot)
    await advanceProject(s.advanceDeps, s.p.id)
    const task = (
      await query<{ exec: string }>(
        `SELECT exec_request_id AS exec FROM studio_tasks WHERE project_id = $1 AND kind = 'qa'`,
        [s.p.id],
      )
    ).rows[0]!
    // An earlier holder got the answer (and paid for it), then lost its lease.
    await query(
      'INSERT INTO studio_step_results(request_id, user_id, output) VALUES ($1, $2, $3::jsonb)',
      [task.exec, s.uid, JSON.stringify({ text: answer() })],
    )
    await settle(BigInt(s.uid), task.exec, 7n)
    await runOne(s.exec)
    assert.equal(s.grok.calls.length, 0, 'not asked again')
    assert.equal((await takeQa(f.id))?.passed, true)
    assert.equal((await projectRow(s.p.id)).spent, '7', 'charged once')

    const s2 = await setup()
    const g = await s2.take('shot_frame', s2.shot)
    s2.grok.answers.push('看起来不错', '还是不错')
    await advanceProject(s2.advanceDeps, s2.p.id)
    await runOne(s2.exec)
    assert.equal(await takeQa(g.id), null, 'asked once more')
    await query('UPDATE studio_tasks SET run_after = NOW() WHERE project_id = $1', [s2.p.id])
    await runOne(s2.exec)
    assert.equal(s2.grok.calls.length, 2)
    assert.equal(s2.grok.calls[1]!.attempt, 1, 'the second answer bills under its own attempt')
    const qa = await takeQa(g.id)
    assert.deepEqual([qa?.next, qa?.reason], ['handoff', 'low_confidence'])
  })

  test('a passing clip is adopted as the shot video, from four sandbox frames', async (t) => {
    if (skip(t)) return
    const s = await setup()
    await s.take('shot_frame', s.shot, { qa: { passed: true, next: 'adopt', score: 0.9 } })
    const v = await s.take('shot_video', s.shot, {
      mime: 'video/mp4',
      bytes: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(16)]),
      ms: 8000,
    })
    await advanceProject(s.advanceDeps, s.p.id)
    await runOne(s.exec)
    const frames = s.runner.ran.find((o) => o.op === 'frames') as Extract<
      ComposeOp,
      { op: 'frames' }
    >
    assert.deepEqual(frames.times, [0.8, 2.8, 4.8, 6.8])
    assert.equal((await takeQa(v.id))?.passed, true)
    assert.deepEqual(await shotRow(s.shot), { status: 'ready', active: v.id })
  })

  test('generation and QA-provider failures do not consume the quality regeneration rounds', async (t) => {
    if (skip(t)) return
    const s = await setup()
    await query(
      `INSERT INTO studio_takes(id, project_id, owner_kind, owner_id, version, provider, model, op, status, error_code)
       VALUES (gen_random_uuid(), $1, 'shot_frame', $2, 1, 'fake', 'm', 'image.generate', 'failed', 'IMAGE_DAILY_LIMIT')`,
      [s.p.id, s.shot],
    )
    await s.take('shot_frame', s.shot, { version: 2, qa: { passed: false, score: 0, next: 'handoff', reason: 'unavailable', error: 'QA_GROK_UPSTREAM_ERROR' } })
    const current = await s.take('shot_frame', s.shot, { version: 3 })
    s.grok.answers.push(answer({ character: 0.4 }))
    await advanceProject(s.advanceDeps, s.p.id)
    await runOne(s.exec)
    assert.equal((await takeQa(current.id))?.next, 'redo', 'first real quality failure still gets a redo')
  })

  test('bible candidates: the best passing one is locked once both are judged', async (t) => {
    if (skip(t)) return
    const s = await setup({ candidates: 2 })
    const a = randomUUID()
    await query(
      `INSERT INTO studio_assets(id, project_id, user_id, kind, name, descriptor, locked)
       VALUES ($1, $2, $3, 'scene', '雪松林', '清晨薄雾', FALSE)`,
      [a, s.p.id, s.uid],
    )
    const b1 = await s.take('bible', a, { version: 1 })
    const b2 = await s.take('bible', a, { version: 2 })
    const sha = new Map<string, string>([
      [b1.id, b1.sha],
      [b2.id, b2.sha],
    ])
    s.grok.answers.push(answer({ scene: 0.8 }), answer({ scene: 0.95 }))
    await advanceProject(s.advanceDeps, s.p.id)
    await runOne(s.exec) // judged 0.8, whichever candidate is claimed first
    const mid = await query<{ locked: boolean }>('SELECT locked FROM studio_assets WHERE id = $1', [
      a,
    ])
    assert.equal(mid.rows[0]!.locked, false, 'waits for the other candidate')
    const second = await runOne(s.exec) // judged 0.95
    const done = await query<{ locked: boolean; sha: string }>(
      'SELECT locked, blob_sha AS sha FROM studio_assets WHERE id = $1',
      [a],
    )
    const best = (second.payload as { takeId: string }).takeId
    assert.deepEqual(done.rows[0], { locked: true, sha: sha.get(best) })
  })

  test('a QA task of a finished project releases its reservation; reconcile books a late charge', async (t) => {
    if (skip(t)) return
    const s = await setup()
    await s.take('shot_frame', s.shot)
    await advanceProject(s.advanceDeps, s.p.id)
    assert.equal((await projectRow(s.p.id)).reserved, '10')
    await query(`UPDATE studio_projects SET status = 'done' WHERE id = $1`, [s.p.id])
    await runOne(s.exec)
    assert.equal((await projectRow(s.p.id)).reserved, '0')

    const s2 = await setup()
    const f = await s2.take('shot_frame', s2.shot)
    s2.grok.chargeEach = 0n
    await advanceProject(s2.advanceDeps, s2.p.id)
    const task = await runOne(s2.exec)
    assert.equal((await projectRow(s2.p.id)).spent, '0')
    await settle(BigInt(s2.uid), task.execRequestId, 9n) // settles after the task finished
    await reconcileCharges({ pool: getPool(), providers: noProviders })
    assert.equal((await projectRow(s2.p.id)).spent, '9')
    assert.equal((await takeQa(f.id))?.costCredits, '9')
  })

  test('brief moderation: unsure without visual QA goes back to draft; a violation fails', async (t) => {
    if (skip(t)) return
    for (const [answerText, qaOn, status] of [
      ['{"verdict":"uncertain","reason":"可能涉及真人"}', false, 'draft'],
      ['{"verdict":"block","reason":"血腥暴力"}', true, 'failed'],
    ] as const) {
      const s = await setup()
      await query(
        `UPDATE studio_projects SET status = 'planning', brief = '一段需求' WHERE id = $1`,
        [s.p.id],
      )
      s.grok.answers.push(answerText)
      const exec = { ...s.exec, qa: { ...s.exec.qa!, enabled: qaOn } }
      await advanceProject(s.advanceDeps, s.p.id)
      await runOne(exec)
      assert.equal((await projectRow(s.p.id)).status, status)
      assert.equal(s.grok.calls.length, 1, 'no plan was asked for')
      assert.equal(s.grok.calls[0]!.billTo, 'platform')
      const ev = await query(
        `SELECT 1 FROM studio_events WHERE project_id = $1 AND type = 'brief.moderation'`,
        [s.p.id],
      )
      assert.equal(ev.rowCount, 1)
    }
  })

  test('a stored answer is settled again under the id it billed (code r1 P1)', async (t) => {
    if (skip(t)) return
    const s = await setup()
    const f = await s.take('shot_frame', s.shot)
    const resettled: Array<{ requestId: string }> = []
    const exec: ExecuteDeps = {
      ...s.exec,
      grokResettle: async (i) => {
        resettled.push({ requestId: i.requestId })
      },
    }
    await advanceProject(s.advanceDeps, s.p.id)
    const exe = (
      await query<{ exec: string }>(
        `SELECT exec_request_id AS exec FROM studio_tasks WHERE project_id = $1 AND kind = 'qa'`,
        [s.p.id],
      )
    ).rows[0]!.exec
    await query(
      'INSERT INTO studio_step_results(request_id, user_id, output) VALUES ($1, $2, $3::jsonb)',
      [
        exe,
        s.uid,
        JSON.stringify({ text: answer(), usage: { input_tokens: 1 }, requestId: `${exe}~1` }),
      ],
    )
    await runOne(exec)
    assert.deepEqual(resettled, [{ requestId: `${exe}~1` }])
    assert.equal(s.grok.calls.length, 0)
    assert.equal((await takeQa(f.id))?.passed, true)
  })

  test('a call still in flight under this billing id is waited for; a dead id moves on (code r1 P1)', async (t) => {
    if (skip(t)) return
    const s = await setup()
    const f = await s.take('shot_frame', s.shot)
    await advanceProject(s.advanceDeps, s.p.id)
    const exe = (
      await query<{ exec: string }>(
        `SELECT exec_request_id AS exec FROM studio_tasks WHERE project_id = $1 AND kind = 'qa'`,
        [s.p.id],
      )
    ).rows[0]!.exec
    // Another holder admitted this id and is still calling.
    await query(
      `INSERT INTO request_finalize_journal(request_id, user_id, state, ctx, precheck_credits)
       VALUES ($1, $2, 'inflight', '{}'::jsonb, 10)`,
      [exe, s.uid],
    )
    await runOne(s.exec)
    assert.equal(s.grok.calls.length, 0, 'never a second concurrent call')
    assert.equal(await takeQa(f.id), null)
    // It died without an answer: the id is spent, the next call bills under ~1.
    await query(`UPDATE request_finalize_journal SET state = 'aborted' WHERE request_id = $1`, [
      exe,
    ])
    await query('UPDATE studio_tasks SET run_after = NOW() WHERE project_id = $1', [s.p.id])
    await runOne(s.exec)
    assert.equal(s.grok.calls.length, 1)
    assert.equal(s.grok.calls[0]!.attempt, 1)
    assert.equal((await takeQa(f.id))?.passed, true)
  })

  test('two candidates: a sibling of a handed-off round keeps the redo cap (code r1 P1)', async (t) => {
    if (skip(t)) return
    const s = await setup({ candidates: 2 })
    const a = randomUUID()
    await query(
      `INSERT INTO studio_assets(id, project_id, user_id, kind, name, descriptor, locked)
       VALUES ($1, $2, $3, 'character', '小狐狸', '橙红色毛', FALSE)`,
      [a, s.p.id, s.uid],
    )
    const redo = (score: number) => ({
      passed: false,
      next: 'redo',
      score,
      reason: 'below_threshold',
    })
    for (const [i, score] of [0.5, 0.52, 0.54, 0.56].entries())
      await s.take('bible', a, { version: i + 1, qa: redo(score) })
    // v6 is already on its way when v5 (same round) hands over.
    const v6 = await s.take('bible', a, { version: 6 })
    await s.take('bible', a, {
      version: 5,
      qa: {
        passed: false,
        next: 'handoff',
        score: 0.58,
        reason: 'retries_exhausted',
        at: new Date(Date.now() + 60_000).toISOString(),
      },
    })
    s.grok.answers.push(answer({ character: 0.6 }))
    await advanceProject(s.advanceDeps, s.p.id)
    await runOne(s.exec)
    const qa = await takeQa(v6.id)
    assert.deepEqual([qa?.next, qa?.reason], ['handoff', 'retries_exhausted'])
  })

  test('a call the catalog cannot price is not dispatched (code r1 P1)', async (t) => {
    if (skip(t)) return
    const s = await setup()
    await s.take('shot_frame', s.shot)
    const deps: AdvanceDeps = {
      ...s.advanceDeps,
      qa: { ...s.advanceDeps.qa!, maxCost: async () => null },
    }
    await advanceProject(deps, s.p.id)
    const tasks = await query(`SELECT 1 FROM studio_tasks WHERE project_id = $1 AND kind = 'qa'`, [
      s.p.id,
    ])
    assert.equal(tasks.rowCount, 0)
    assert.equal((await projectRow(s.p.id)).reserved, '0')
    const ev = await query(
      `SELECT 1 FROM studio_events WHERE project_id = $1 AND type = 'qa.waiting'`,
      [s.p.id],
    )
    assert.equal(ev.rowCount, 1)
  })

  test('a frame the user picks while its QA is queued is not judged or charged (code r2 P1)', async (t) => {
    if (skip(t)) return
    const s = await setup()
    const f = await s.take('shot_frame', s.shot)
    await advanceProject(s.advanceDeps, s.p.id)
    // The user picks it before the queued QA runs.
    await query(
      `UPDATE studio_shots SET status = 'generating', spec = jsonb_set(spec, '{frameTakeId}', to_jsonb($2::text)) WHERE id = $1`,
      [s.shot, f.id],
    )
    await runOne(s.exec)
    assert.equal(s.grok.calls.length, 0)
    assert.deepEqual(await takeQa(f.id), { skipped: true, reason: 'user_picked', costCredits: '0' })
    assert.equal((await shotRow(s.shot)).status, 'generating')
    const p = await projectRow(s.p.id)
    assert.deepEqual([p.spent, p.reserved], ['0', '0'])
  })

  test('an id that settled without a stored answer is spent; the next call bills under ~1', async (t) => {
    if (skip(t)) return
    const s = await setup()
    const f = await s.take('shot_frame', s.shot)
    await advanceProject(s.advanceDeps, s.p.id)
    const exe = (
      await query<{ exec: string }>(
        `SELECT exec_request_id AS exec FROM studio_tasks WHERE project_id = $1 AND kind = 'qa'`,
        [s.p.id],
      )
    ).rows[0]!.exec
    await query(
      `INSERT INTO request_finalize_journal(request_id, user_id, state, ctx, precheck_credits)
       VALUES ($1, $2, 'committed', '{}'::jsonb, 10)`,
      [exe, s.uid],
    )
    await runOne(s.exec)
    assert.equal(s.grok.calls.length, 1)
    assert.equal(s.grok.calls[0]!.attempt, 1)
    assert.equal((await takeQa(f.id))?.passed, true)
  })

  test('a pick does not leave an answered call unbilled: the stored answer is settled first (code r3 P1)', async (t) => {
    if (skip(t)) return
    const s = await setup()
    const f = await s.take('shot_frame', s.shot)
    const resettled: string[] = []
    const exec: ExecuteDeps = {
      ...s.exec,
      grokResettle: async (i) => {
        resettled.push(i.requestId)
        await settle(i.userId, i.requestId, 7n)
      },
    }
    await advanceProject(s.advanceDeps, s.p.id)
    const exe = (
      await query<{ exec: string }>(
        `SELECT exec_request_id AS exec FROM studio_tasks WHERE project_id = $1 AND kind = 'qa'`,
        [s.p.id],
      )
    ).rows[0]!.exec
    // Answered and stored, then the process died before settling; then the user picks the frame.
    await query(
      'INSERT INTO studio_step_results(request_id, user_id, output) VALUES ($1, $2, $3::jsonb)',
      [exe, s.uid, JSON.stringify({ text: answer(), usage: { input_tokens: 1 }, requestId: exe })],
    )
    await query(
      `UPDATE studio_shots SET spec = jsonb_set(spec, '{frameTakeId}', to_jsonb($2::text)) WHERE id = $1`,
      [s.shot, f.id],
    )
    await runOne(exec)
    assert.deepEqual(resettled, [exe])
    assert.equal((await takeQa(f.id))?.reason, 'user_picked')
    assert.equal((await projectRow(s.p.id)).spent, '7', 'the finished call is billed and booked')
  })
})
