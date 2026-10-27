/**
 * OCV5-591 A2-1c compose on real Postgres (0324/0329), with a fake sandbox:
 *
 *   1. when every shot and line is ready the director queues one compose and the project composes;
 *      the run stores the film as a free final take (QA, credits, the user's own ref), the project
 *      is done, nothing is charged and studio_charges stays empty (user 2026-10-23 21:42).
 *   2. an export for the same format and inputs returns that film; another format re-composes for
 *      free and the project stays done (user 2026-10-23 22:13).
 *   3. inputs that change while composing are not published: the take is canceled, its refs are
 *      given back and a new compose is queued.
 *   4. narration that does not fit its shot sends the project to the user instead of composing.
 *   5. a sandbox failure fails the take, frees its refs and leaves the project with the user.
 *   6. changing the music edit after done sends the project back to the director.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'

import { closePool, createPool, getPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'
import { StudioBlobStore } from '../media-studio/blobs.js'
import type { ComposeResult } from '../media-studio/compose/runner.js'
import type { ComposeOp } from '../media-studio/compose/spec.js'
import { runStudioGc } from '../media-studio/gc.js'
import { advanceProject } from '../media-studio/orchestrator/advance.js'
import type { ComposeRunnerLike } from '../media-studio/orchestrator/compose.js'
import { type ExecuteDeps, executeTask } from '../media-studio/orchestrator/execute.js'
import { makeOrchestratorApi } from '../media-studio/orchestrator/service.js'
import type { ProviderRegistry } from '../media-studio/providers/registry.js'
import { claimStudioTasks, enqueueStudioTask } from '../media-studio/queue.js'
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
    'TRUNCATE TABLE studio_projects, studio_blob_refs, studio_blobs, studio_quota, studio_quota_holds, studio_charges, users RESTART IDENTITY CASCADE',
  )
})

const skip = (t: { skip: (m: string) => void }) => {
  if (!pgAvailable) {
    t.skip('no Postgres test fixture')
    return true
  }
  return false
}

/** A sandbox that writes a tiny "mp4" and answers probe with the length it is told to. */
class FakeRunner implements ComposeRunnerLike {
  ran: ComposeOp[] = []
  prepared: string[] = []
  probeSec = 0
  fail: Error | null = null
  onCompose: (() => Promise<void>) | null = null
  constructor(private readonly root: string) {}
  configured() {
    return true
  }
  async prepare(jobId: string) {
    this.prepared.push(jobId)
    const inDir = path.join(this.root, jobId, 'in')
    const outDir = path.join(this.root, jobId, 'out')
    await mkdir(inDir, { recursive: true })
    await mkdir(outDir, { recursive: true })
    return { inDir, outDir }
  }
  async run(jobId: string, op: ComposeOp): Promise<ComposeResult> {
    this.ran.push(op)
    if (this.fail) throw this.fail
    if (op.op === 'probe') {
      return {
        outputs: [],
        stdoutJson: {
          format: { duration: String(this.probeSec) },
          streams: [{ codec_type: 'video' }, { codec_type: 'audio' }],
        },
      }
    }
    await this.onCompose?.()
    const out = path.join(this.root, jobId, 'out', 'final.mp4')
    await writeFile(
      out,
      Buffer.concat([
        Buffer.from([0, 0, 0, 24]),
        Buffer.from('ftypisom'),
        Buffer.from(randomUUID()),
      ]),
    )
    return { outputs: [{ name: 'final.mp4', path: out, bytes: 48 }] }
  }
  async cleanup() {}
}

const noProviders: ProviderRegistry = {
  list: () => [],
  get: () => undefined,
  candidates: () => [],
  describe: () => ({ kinds: [] }),
}

async function setup(lineSec = [2, 1.5]) {
  const blobs = new StudioBlobStore({
    pool: getPool(),
    root: await mkdtemp(path.join(tmpdir(), 'oc-compose-blobs-')),
    freeBytes: async () => 100n * 1024n ** 3n,
  })
  const runner = new FakeRunner(await mkdtemp(path.join(tmpdir(), 'oc-compose-work-')))
  const exec: ExecuteDeps = {
    pool: getPool(),
    blobs,
    providers: noProviders,
    systemVoices: async () => [],
    compose: runner,
  }
  const advanceDeps = { pool: getPool(), providers: noProviders, compose: runner }
  const api = makeOrchestratorApi(getPool(), () => {}, advanceDeps)
  const uid = (
    await query<{ id: string }>(
      `INSERT INTO users(email, password_hash, email_verified, credits) VALUES ($1, 'x', TRUE, 0) RETURNING id::text AS id`,
      [`c${randomUUID().slice(0, 8)}@t.local`],
    )
  ).rows[0]!.id
  const p = await new StudioStore(getPool()).createProject(uid, { budgetCredits: 500 })
  const put = async (kind: 'take', id: string, body: string, mime: string) =>
    (
      await blobs.put({
        userId: BigInt(uid),
        mime,
        maxBytes: 64,
        source: Buffer.from(body),
        ref: { kind, id },
      })
    ).sha
  const take = async (ownerKind: string, ownerId: string, mime: string, ms: number) => {
    const id = randomUUID()
    const sha = await put('take', id, `${ownerKind} ${id}`, mime)
    await query(
      `INSERT INTO studio_takes(id, project_id, owner_kind, owner_id, version, provider, model, op, status, blob_sha, cost_credits, meta, finished_at)
       VALUES ($1, $2, $3, $4, 1, 'fake', 'm', 'x', 'succeeded', $5, 0, $6::jsonb, NOW())`,
      [id, p.id, ownerKind, ownerId, sha, JSON.stringify({ durationMs: ms })],
    )
    return { id, sha }
  }
  const shots: string[] = []
  for (const [i, dur] of [5, 4].entries()) {
    const sid = randomUUID()
    await query(
      `INSERT INTO studio_shots(id, project_id, ordinal, spec, status) VALUES ($1, $2, $3, $4::jsonb, 'ready')`,
      [sid, p.id, i, JSON.stringify({ durationSec: dur })],
    )
    const v = await take('shot_video', sid, 'video/mp4', 10_000)
    await query('UPDATE studio_shots SET active_take_id = $2 WHERE id = $1', [sid, v.id])
    shots.push(sid)
  }
  for (const [i, sec] of lineSec.entries()) {
    const lid = randomUUID()
    await query(
      `INSERT INTO studio_lines(id, project_id, shot_id, ordinal, text, status) VALUES ($1, $2, $3, $4, $5, 'ready')`,
      [lid, p.id, shots[0], i, `第 ${i + 1} 句旁白`],
    )
    const l = await take('line', lid, 'audio/mpeg', sec * 1000)
    await query('UPDATE studio_lines SET active_take_id = $2 WHERE id = $1', [lid, l.id])
  }
  const music = await take('music', p.id, 'audio/mpeg', 90_000)
  await query('UPDATE studio_takes SET meta = meta || $2::jsonb WHERE id = $1', [
    music.id,
    JSON.stringify({
      license: {
        license: 'CC-BY-4.0',
        title: 'Easy Lemon',
        attributionRequired: true,
        attributionText: '"Easy Lemon" Kevin MacLeod (incompetech.com)',
      },
    }),
  ])
  await query(
    `UPDATE studio_projects SET status = 'running', settings = settings || $2::jsonb WHERE id = $1`,
    [
      p.id,
      JSON.stringify({
        musicTakeId: music.id,
        musicSkippedNoted: true,
        narration: { voiceId: 'v' },
      }),
    ],
  )
  runner.probeSec = 9
  return { uid, p, blobs, runner, exec, advanceDeps, api, shots }
}

const project = async (id: string) =>
  (
    await query<{ status: string; reason: string | null; spent: string; reserved: string }>(
      `SELECT status, settings->>'awaitingReason' AS reason, spent_credits::text AS spent, reserved_credits::text AS reserved
         FROM studio_projects WHERE id = $1`,
      [id],
    )
  ).rows[0]!
const finals = async (id: string) =>
  (
    await query<{
      id: string
      status: string
      cost: string
      sha: string | null
      qa: Record<string, unknown> | null
      meta: Record<string, unknown>
    }>(
      `SELECT id::text AS id, status, cost_credits::text AS cost, blob_sha AS sha, qa, meta FROM studio_takes
        WHERE project_id = $1 AND owner_kind = 'final' ORDER BY version`,
      [id],
    )
  ).rows
async function runOne(exec: ExecuteDeps) {
  const [task] = await claimStudioTasks(getPool(), { owner: 'A', limit: 1, museOnline: false })
  assert.ok(task, 'a due task')
  await executeTask(exec, task, new AbortController().signal)
  return task
}

describe('studio compose (OCV5-591 A2-1c)', () => {
  test('the director composes the film once everything is ready; free, with QA, credits and the user’s ref', async (t) => {
    if (skip(t)) return
    const s = await setup()
    await advanceProject(s.advanceDeps, s.p.id)
    assert.equal((await project(s.p.id)).status, 'composing')
    await advanceProject(s.advanceDeps, s.p.id)
    const queued = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM studio_tasks WHERE project_id = $1 AND kind = 'compose'`,
      [s.p.id],
    )
    assert.equal(queued.rows[0]!.n, '1', 'one compose, however often the project is advanced')
    await runOne(s.exec)
    const [film] = await finals(s.p.id)
    assert.equal(film!.status, 'succeeded')
    assert.equal(film!.cost, '0')
    assert.equal((film!.qa as { passed: boolean }).passed, true)
    assert.deepEqual((film!.meta as { credits: unknown }).credits, [
      {
        kind: 'music',
        title: 'Easy Lemon',
        attributionText: '"Easy Lemon" Kevin MacLeod (incompetech.com)',
        license: 'CC-BY-4.0',
      },
    ])
    assert.ok(await s.blobs.open(BigInt(s.uid), film!.sha!), 'the film is the user’s own blob')
    assert.deepEqual(await project(s.p.id), {
      status: 'done',
      reason: null,
      spent: '0',
      reserved: '0',
    })
    const charges = await query<{ n: string }>('SELECT COUNT(*)::text AS n FROM studio_charges')
    assert.equal(charges.rows[0]!.n, '0', 'compose is never charged')
    const spec = s.runner.ran.find((o) => o.op === 'compose') as Extract<
      ComposeOp,
      { op: 'compose' }
    >
    assert.deepEqual(
      spec.spec.voice?.map((v) => v.startSec),
      [0.15, 2.45],
    )
    assert.equal(spec.spec.music?.file, 'm.mp3')
  })

  test('export: the same format returns that film; another format re-composes for free', async (t) => {
    if (skip(t)) return
    const s = await setup()
    await advanceProject(s.advanceDeps, s.p.id)
    await runOne(s.exec)
    const [film] = await finals(s.p.id)
    assert.deepEqual(
      await s.api.requestExport(s.uid, s.p.id, { resolution: '1080p', subtitles: 'burn' }),
      {
        reused: true,
        takeId: film!.id,
      },
    )
    assert.deepEqual(
      await s.api.requestExport(s.uid, s.p.id, { resolution: 'vertical', subtitles: 'srt' }),
      { queued: true },
    )
    await runOne(s.exec)
    const all = await finals(s.p.id)
    assert.equal(all.length, 2)
    assert.equal(all[1]!.meta.variantKey, 'vertical-srt')
    assert.equal(all[1]!.cost, '0')
    assert.ok(all[1]!.meta.srtSha, 'the .srt is kept next to the film')
    // A2-1c-2: the final page reads each film's format, credits and .srt from the project view.
    const view = (await new StudioStore(getPool()).projectView(s.uid, s.p.id)) as {
      takes: Array<{
        id: string
        ownerKind: string
        durationMs: number | null
        final: Record<string, unknown> | null
      }>
    }
    // …and each narration take's real length, which the timeline places lines by.
    const voiced = view.takes.filter((tk) => tk.ownerKind === 'line')
    assert.ok(voiced.length > 0 && voiced.every((tk) => typeof tk.durationMs === 'number'))
    const vertical = view.takes.find((tk) => tk.id === all[1]!.id)
    assert.deepEqual(
      [
        vertical?.final?.variantKey,
        vertical?.final?.srtSha,
        Array.isArray(vertical?.final?.credits),
      ],
      ['vertical-srt', all[1]!.meta.srtSha, true],
    )
    assert.deepEqual((vertical?.final?.variant as { resolution?: string })?.resolution, 'vertical')
    const spec = s.runner.ran.filter((o) => o.op === 'compose').at(-1) as Extract<
      ComposeOp,
      { op: 'compose' }
    >
    assert.deepEqual(
      [spec.spec.width, spec.spec.height, spec.spec.subtitles],
      [1080, 1920, undefined],
    )
    assert.equal((await project(s.p.id)).status, 'done')
    assert.equal((await project(s.p.id)).spent, '0')
    await assert.rejects(
      s.api.requestExport(s.uid, s.p.id, { resolution: '4k', subtitles: 'burn' }),
      { status: 400 },
    )
  })

  test('inputs changed while composing are not published; a new compose is queued', async (t) => {
    if (skip(t)) return
    const s = await setup()
    await advanceProject(s.advanceDeps, s.p.id)
    s.runner.onCompose = async () => {
      s.runner.onCompose = null
      await query(
        `UPDATE studio_projects SET settings = settings || '{"musicEdit":{"inSec":8}}'::jsonb WHERE id = $1`,
        [s.p.id],
      )
    }
    await runOne(s.exec)
    const [stale] = await finals(s.p.id)
    assert.equal(stale!.status, 'canceled')
    const refs = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM studio_blob_refs WHERE ref_kind = 'final' AND ref_id = $1`,
      [stale!.id],
    )
    assert.equal(refs.rows[0]!.n, '0', 'its refs were given back')
    assert.equal((await project(s.p.id)).status, 'composing')
    await runOne(s.exec)
    const all = await finals(s.p.id)
    assert.equal(all.at(-1)!.status, 'succeeded')
    assert.equal((await project(s.p.id)).status, 'done')
  })

  test('narration that does not fit its shot goes to the user, nothing is composed', async (t) => {
    if (skip(t)) return
    const s = await setup([3, 2.5])
    await advanceProject(s.advanceDeps, s.p.id)
    await runOne(s.exec)
    assert.deepEqual((await project(s.p.id)).status, 'awaiting_user')
    assert.equal((await project(s.p.id)).reason, 'needs_user')
    const shot = await query<{ status: string }>('SELECT status FROM studio_shots WHERE id = $1', [
      s.shots[0],
    ])
    assert.equal(shot.rows[0]!.status, 'needs_user')
    assert.equal((await finals(s.p.id)).length, 0)
    assert.equal(s.runner.ran.length, 0)
  })

  test('a sandbox failure fails the take, frees its refs and leaves the project with the user', async (t) => {
    if (skip(t)) return
    const s = await setup()
    await advanceProject(s.advanceDeps, s.p.id)
    s.runner.fail = Object.assign(new Error('ffmpeg exited 1'), { code: 'COMPOSE_FAILED' })
    await runOne(s.exec)
    const [film] = await finals(s.p.id)
    assert.equal(film!.status, 'failed')
    assert.equal(film!.cost, '0')
    assert.deepEqual(
      [(await project(s.p.id)).status, (await project(s.p.id)).reason],
      ['awaiting_user', 'compose_failed'],
    )
  })

  test('after a failed compose the user can ask the director to compose again, free (INC-20261027-STUDIO-COMPOSE-FAILED-NO-RETRY)', async (t) => {
    if (skip(t)) return
    // prod 2026-10-27 c6f0a9f2: COMPOSE_FAILED left the project at awaiting_user/compose_failed with
    // no way back but writing a note.
    const s = await setup()
    await advanceProject(s.advanceDeps, s.p.id)
    s.runner.fail = Object.assign(new Error('ffmpeg exited 1'), { code: 'COMPOSE_FAILED' })
    await runOne(s.exec)
    assert.deepEqual(
      [(await project(s.p.id)).status, (await project(s.p.id)).reason],
      ['awaiting_user', 'compose_failed'],
    )
    s.runner.fail = null
    await s.api.approve(s.uid, s.p.id)
    assert.deepEqual(
      [(await project(s.p.id)).status, (await project(s.p.id)).reason],
      ['running', null],
      'the film goes back to the director',
    )
    await advanceProject(s.advanceDeps, s.p.id)
    assert.equal((await project(s.p.id)).status, 'composing')
    await runOne(s.exec)
    const all = await finals(s.p.id)
    assert.deepEqual(
      all.map((f) => `${f.status} ${f.cost}`),
      ['failed 0', 'succeeded 0'],
      'composed again, nothing charged',
    )
    const after = await project(s.p.id)
    assert.deepEqual([after.status, after.spent], ['done', '0'])
    // Only a waiting project can be approved: a second click does nothing.
    await assert.rejects(s.api.approve(s.uid, s.p.id), (e: { status?: number }) => e.status === 409)
  })

  test('changing the music edit after done sends the film back to the director', async (t) => {
    if (skip(t)) return
    const s = await setup()
    await advanceProject(s.advanceDeps, s.p.id)
    await runOne(s.exec)
    assert.equal((await project(s.p.id)).status, 'done')
    await s.api.setMusicEdit(s.uid, s.p.id, { inSec: 4 })
    assert.equal((await project(s.p.id)).status, 'running')
    await advanceProject(s.advanceDeps, s.p.id)
    assert.equal((await project(s.p.id)).status, 'composing')
    await runOne(s.exec)
    const all = await finals(s.p.id)
    assert.equal(all.length, 2)
    assert.equal(all[1]!.status, 'succeeded')
  })

  test('a compose that finishes while paused resumes to the film, not a stuck composing (code r1 P1)', async (t) => {
    if (skip(t)) return
    const s = await setup()
    await advanceProject(s.advanceDeps, s.p.id)
    s.runner.onCompose = async () => {
      await new StudioStore(getPool()).transition(s.uid, s.p.id, 'pause')
    }
    await runOne(s.exec)
    assert.equal((await project(s.p.id)).status, 'paused')
    await new StudioStore(getPool()).transition(s.uid, s.p.id, 'resume')
    assert.equal((await project(s.p.id)).status, 'done')
  })

  test('sandbox dirs are per lease epoch (code r1 P1)', async (t) => {
    if (skip(t)) return
    const s = await setup()
    await advanceProject(s.advanceDeps, s.p.id)
    const task = await runOne(s.exec)
    assert.deepEqual(s.runner.prepared, [
      `c-${task.id}-e${task.epoch}`,
      `q-${task.id}-e${task.epoch}`,
    ])
  })

  test('a re-used final take keeps only the film it publishes (code r1 P1)', async (t) => {
    if (skip(t)) return
    const s = await setup()
    await advanceProject(s.advanceDeps, s.p.id)
    const [task] = await claimStudioTasks(getPool(), { owner: 'A', limit: 1, museOnline: false })
    // An earlier attempt created the take and stored a blob on it, then lost its lease.
    const takeId = randomUUID()
    await query(
      `INSERT INTO studio_takes(id, project_id, owner_kind, owner_id, version, provider, model, op, status, cost_credits)
       VALUES ($1, $2, 'final', $2, 1, 'compose', 'ffmpeg', 'compose', 'running', 0)`,
      [takeId, s.p.id],
    )
    await query('UPDATE studio_tasks SET payload = payload || $2::jsonb WHERE id = $1', [
      task!.id,
      JSON.stringify({ takeId }),
    ])
    task!.payload = { ...task!.payload, takeId }
    const stale = await s.blobs.put({
      userId: BigInt(s.uid),
      mime: 'video/mp4',
      maxBytes: 64,
      source: Buffer.from('stale film'),
      ref: { kind: 'final', id: takeId },
    })
    await executeTask(s.exec, task!, new AbortController().signal)
    const [film] = await finals(s.p.id)
    assert.equal(film!.id, takeId, 'the same take was re-used')
    const refs = await query<{ sha: string }>(
      `SELECT sha256 AS sha FROM studio_blob_refs WHERE ref_kind = 'final' AND ref_id = $1`,
      [takeId],
    )
    assert.deepEqual(
      refs.rows.map((r) => r.sha),
      [film!.sha],
    )
    assert.equal(
      await s.blobs.open(BigInt(s.uid), stale.sha),
      null,
      'the stale blob is no longer the user’s',
    )
  })

  test('refusing narration closes the take an earlier attempt created (code r1 P1)', async (t) => {
    if (skip(t)) return
    const s = await setup([3, 2.5])
    await advanceProject(s.advanceDeps, s.p.id)
    const [task] = await claimStudioTasks(getPool(), { owner: 'A', limit: 1, museOnline: false })
    const takeId = randomUUID()
    await query(
      `INSERT INTO studio_takes(id, project_id, owner_kind, owner_id, version, provider, model, op, status, cost_credits)
       VALUES ($1, $2, 'final', $2, 1, 'compose', 'ffmpeg', 'compose', 'running', 0)`,
      [takeId, s.p.id],
    )
    task!.payload = { ...task!.payload, takeId }
    await s.blobs.put({
      userId: BigInt(s.uid),
      mime: 'video/mp4',
      maxBytes: 64,
      source: Buffer.from('half film'),
      ref: { kind: 'final', id: takeId },
    })
    await executeTask(s.exec, task!, new AbortController().signal)
    const [film] = await finals(s.p.id)
    assert.equal(film!.status, 'failed')
    const refs = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM studio_blob_refs WHERE ref_kind = 'final' AND ref_id = $1`,
      [takeId],
    )
    assert.equal(refs.rows[0]!.n, '0')
  })

  test('the GC collects a failed film’s blob under its final ref (code r1 P1)', async (t) => {
    if (skip(t)) return
    const s = await setup()
    const takeId = randomUUID()
    await query(
      `INSERT INTO studio_takes(id, project_id, owner_kind, owner_id, version, provider, model, op, status, cost_credits, finished_at)
       VALUES ($1, $2, 'final', $2, 1, 'compose', 'ffmpeg', 'compose', 'failed', 0, NOW() - INTERVAL '40 days')`,
      [takeId, s.p.id],
    )
    await s.blobs.put({
      userId: BigInt(s.uid),
      mime: 'video/mp4',
      maxBytes: 64,
      source: Buffer.from('left behind'),
      ref: { kind: 'final', id: takeId },
    })
    const out = await runStudioGc({ pool: getPool(), blobs: s.blobs })
    assert.ok(out.takes >= 1)
    const refs = await query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM studio_blob_refs WHERE ref_id = $1',
      [takeId],
    )
    assert.equal(refs.rows[0]!.n, '0')
  })

  test('work still in flight (a new track) is not overtaken by an older film (code r1 P1)', async (t) => {
    if (skip(t)) return
    const s = await setup()
    await advanceProject(s.advanceDeps, s.p.id)
    s.runner.onCompose = async () => {
      // The user picks another track while the film is being composed.
      await enqueueStudioTask(getPool(), {
        projectId: s.p.id,
        kind: 'gen',
        idempotencyKey: `gen:music:${randomUUID()}`,
        payload: {},
      })
    }
    await runOne(s.exec)
    const [film] = await finals(s.p.id)
    assert.equal(film!.status, 'canceled')
    assert.equal(
      (await project(s.p.id)).status,
      'running',
      'back to the director, who composes after that work',
    )
  })

  test('a music edit saved while paused after the film finished is composed on resume (code r2 P1)', async (t) => {
    if (skip(t)) return
    const s = await setup()
    await advanceProject(s.advanceDeps, s.p.id)
    s.runner.onCompose = async () => {
      await new StudioStore(getPool()).transition(s.uid, s.p.id, 'pause')
    }
    await runOne(s.exec)
    await s.api.setMusicEdit(s.uid, s.p.id, { inSec: 6 })
    await new StudioStore(getPool()).transition(s.uid, s.p.id, 'resume')
    assert.equal(
      (await project(s.p.id)).status,
      'running',
      'back to the director, not straight to done',
    )
    await advanceProject(s.advanceDeps, s.p.id)
    assert.equal((await project(s.p.id)).status, 'composing')
  })

  test('an export interrupted by pending work keeps its format and comes back (code r2 P1)', async (t) => {
    if (skip(t)) return
    const s = await setup()
    await advanceProject(s.advanceDeps, s.p.id)
    await runOne(s.exec)
    assert.deepEqual(
      await s.api.requestExport(s.uid, s.p.id, { resolution: 'vertical', subtitles: 'srt' }),
      { queued: true },
    )
    s.runner.onCompose = async () => {
      await enqueueStudioTask(getPool(), {
        projectId: s.p.id,
        kind: 'gen',
        idempotencyKey: `gen:music:${randomUUID()}`,
        payload: {},
      })
    }
    await runOne(s.exec)
    const again = await query<{
      variant: { resolution: string; subtitles: string }
      reason: string
    }>(
      `SELECT payload->'variant' AS variant, payload->>'reason' AS reason FROM studio_tasks
        WHERE project_id = $1 AND kind = 'compose' AND status = 'queued'`,
      [s.p.id],
    )
    assert.deepEqual(again.rows, [
      { variant: { resolution: 'vertical', subtitles: 'srt' }, reason: 'export' },
    ])
  })
})
