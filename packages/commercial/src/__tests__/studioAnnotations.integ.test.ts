/**
 * OCV5-591 A2-1b-2 integ: annotations end to end on the real schema — API → interpret task (fake
 * Grok, fake sandbox for the marked frame) → one-time execution → settle.
 *   - a sure instruction on an autonomous, finished project runs at once and reopens it; the change
 *     lives on the shot and the director dispatches it (an edit as image.edit of the current frame)
 *   - otherwise it waits; two applies start once; reject is refused while it runs; one execution
 *     per target
 *   - a voice swap re-voices every line; an instruction outside the whitelist never runs
 *   - a running execution is applied when its target is ready on a new version, and ends when the
 *     project is handed to the user; a budget pause keeps it waiting
 *   - an export asked for before the rework waits; apply on a canceled project is refused
 *   - another user's annotation is 404
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
import { makeOrchestratorApi } from '../media-studio/orchestrator/service.js'
import type { ProviderRegistry } from '../media-studio/providers/registry.js'
import type { MediaKind, MediaOp, MediaProvider } from '../media-studio/providers/types.js'
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
    'TRUNCATE TABLE studio_projects, studio_blob_refs, studio_blobs, studio_quota, studio_quota_holds, studio_step_results, users RESTART IDENTITY CASCADE',
  )
})

const skip = (t: { skip: (m: string) => void }) => {
  if (!pgAvailable) {
    t.skip('no Postgres test fixture')
    return true
  }
  return false
}

/** Dispatch-only providers (the tests never run a generation; they look at what was queued). */
function provider(id: string, kind: MediaKind, ops: MediaOp[]): MediaProvider {
  return {
    id,
    kind,
    adapter: 'fake',
    label: id,
    priority: 0,
    models: () => [{ id: `${id}-m`, label: 'm', ops, isDefault: true }],
    status: () => ({ state: 'ready' as const }),
    estimateMaxCost: () => 10n,
    affinity: () => null,
    chargedFor: async () => 0n,
    run: async () => {
      throw new Error('not run in these tests')
    },
  } as unknown as MediaProvider
}
const PROVIDERS = [
  provider('img', 'image', ['image.generate', 'image.edit']),
  provider('vid', 'video', ['video.from_image']),
  provider('tts', 'voice', ['voice.tts']),
]
const registry: ProviderRegistry = {
  list: () => PROVIDERS,
  get: (id) => PROVIDERS.find((p) => p.id === id),
  candidates: (kind, op) =>
    PROVIDERS.filter(
      (p) => p.kind === kind && p.models().some((m) => (m.ops as string[]).includes(op)),
    ),
  describe: () => ({ kinds: [] }),
}

class FakeGrok {
  calls: GrokRunInput[] = []
  answers: string[] = []
  run: GrokRunner = async (input) => {
    this.calls.push(input)
    const text = this.answers.shift() ?? '{"op":null,"confidence":0.2,"explanation":"?"}'
    await input.onResult?.({
      text,
      usage: {} as never,
      model: 'grok-build',
      requestId: input.requestId,
    })
    return { text, model: 'grok-build', usage: {} as never, requestId: input.requestId }
  }
}

const png = (r: number) =>
  sharp({ create: { width: 320, height: 180, channels: 3, background: { r, g: 90, b: 140 } } })
    .png()
    .toBuffer()

class FakeRunner implements ComposeRunnerLike {
  constructor(private readonly root: string) {}
  configured() {
    return true
  }
  async prepare(jobId: string) {
    const inDir = path.join(this.root, jobId, 'in')
    await mkdir(inDir, { recursive: true })
    await mkdir(path.join(this.root, jobId, 'out'), { recursive: true })
    return { inDir, outDir: path.join(this.root, jobId, 'out') }
  }
  async run(jobId: string, op: ComposeOp): Promise<ComposeResult> {
    if (op.op !== 'frames') throw new Error(`unexpected ${op.op}`)
    const p = path.join(this.root, jobId, 'out', 'frame-0.png')
    const b = await png(120)
    await writeFile(p, b)
    return { outputs: [{ name: 'frame-0.png', path: p, bytes: b.length }] }
  }
  async cleanup() {}
}

async function setup(
  opts: { autonomy?: 'max' | 'confirm'; status?: string; budget?: number } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'oc-annot-'))
  const blobs = new StudioBlobStore({
    pool: getPool(),
    root: path.join(root, 'blobs'),
    freeBytes: async () => 100n * 1024n ** 3n,
  })
  const grok = new FakeGrok()
  const runner = new FakeRunner(path.join(root, 'work'))
  const voices = [{ voiceId: 'female-shaonv', name: '少女', description: [] as string[] }]
  const exec: ExecuteDeps = {
    pool: getPool(),
    blobs,
    providers: registry,
    grok: grok.run,
    systemVoices: async () => voices,
    compose: runner,
  }
  const advanceDeps: AdvanceDeps = { pool: getPool(), providers: registry, compose: runner }
  const kicked: string[] = []
  const api = makeOrchestratorApi(getPool(), (id) => void kicked.push(id), advanceDeps).annotations
  const uid = (
    await query<{ id: string }>(
      `INSERT INTO users(email, password_hash, email_verified, credits) VALUES ($1, 'x', TRUE, 1000) RETURNING id::text AS id`,
      [`a${randomUUID().slice(0, 8)}@t.local`],
    )
  ).rows[0]!.id
  const p = await new StudioStore(getPool()).createProject(uid, {
    budgetCredits: opts.budget ?? 500,
  })
  await query(
    `UPDATE studio_projects SET status = $2, autonomy = $3,
            settings = settings || '{"musicSkippedNoted":true,"narration":{"voiceId":"male-qn-jingying"}}'::jsonb
      WHERE id = $1`,
    [p.id, opts.status ?? 'done', opts.autonomy ?? 'max'],
  )
  const take = async (
    ownerKind: string,
    ownerId: string,
    version: number,
    mime: string,
    qa?: unknown,
  ) => {
    const id = randomUUID()
    const bytes = mime.startsWith('image')
      ? await png(version * 30)
      : Buffer.from(`${ownerKind}-${id}`)
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
      `INSERT INTO studio_takes(id, project_id, owner_kind, owner_id, version, provider, model, op, status, blob_sha,
                                cost_credits, meta, qa, inputs, finished_at)
       VALUES ($1, $2, $3, $4, $5, 'fake', 'm', 'x', 'succeeded', $6, 0, '{"durationMs":5000}'::jsonb, $7::jsonb, $8::jsonb, NOW())`,
      [
        id,
        p.id,
        ownerKind,
        ownerId,
        version,
        sha,
        qa === undefined ? null : JSON.stringify(qa),
        JSON.stringify({ inputs: [] }),
      ],
    )
    return { id, sha }
  }
  const shot = randomUUID()
  await query(
    `INSERT INTO studio_shots(id, project_id, ordinal, spec, status) VALUES ($1, $2, 0, $3::jsonb, 'ready')`,
    [shot, p.id, JSON.stringify({ durationSec: 5, framing: '中景', action: '狐狸奔跑' })],
  )
  const frame = await take('shot_frame', shot, 1, 'image/png')
  const video = await take('shot_video', shot, 1, 'video/mp4')
  await query('UPDATE studio_shots SET active_take_id = $2 WHERE id = $1', [shot, video.id])
  const lines: string[] = []
  for (const [i, text] of ['雪落下来了', '狐狸回头'].entries()) {
    const id = randomUUID()
    await query(
      `INSERT INTO studio_lines(id, project_id, shot_id, ordinal, text, status) VALUES ($1, $2, $3, $4, $5, 'ready')`,
      [id, p.id, shot, i, text],
    )
    const lt = await take('line', id, 1, 'audio/mpeg')
    await query('UPDATE studio_lines SET active_take_id = $2 WHERE id = $1', [id, lt.id])
    lines.push(id)
  }
  return { uid, p, grok, exec, advanceDeps, api, kicked, shot, frame, video, lines, take }
}

async function runOne(exec: ExecuteDeps) {
  const [task] = await claimStudioTasks(getPool(), { owner: 'A', limit: 1, museOnline: false })
  assert.ok(task, 'a due task')
  await executeTask(exec, task, new AbortController().signal)
  return task
}
const annotation = async (id: string) =>
  (
    await query<{
      status: string
      interpretation: Record<string, any> | null
      frame: string | null
      applied: string | null
    }>(
      'SELECT status, interpretation, frame_blob_sha AS frame, applied_take_id::text AS applied FROM studio_annotations WHERE id = $1',
      [id],
    )
  ).rows[0]!
const genTasks = async (projectId: string) =>
  (
    await query<{
      key: string
      request: { op: string; prompt?: string; inputs?: Array<{ role: string; blobSha: string }> }
    }>(
      `SELECT idempotency_key AS key, payload->'request' AS request FROM studio_tasks
        WHERE project_id = $1 AND kind = 'gen' ORDER BY idempotency_key`,
      [projectId],
    )
  ).rows
const projectRow = async (id: string) =>
  (
    await query<{ status: string; reserved: string }>(
      'SELECT status, reserved_credits::text AS reserved FROM studio_projects WHERE id = $1',
      [id],
    )
  ).rows[0]!
const sure = (op: string, args: unknown, confidence = 0.92) =>
  JSON.stringify({ op, args, confidence, explanation: '按批注重画这个镜头' })

describe('studio annotations (OCV5-591 A2-1b-2)', () => {
  test('a sure instruction on an autonomous finished film runs at once: reopened, the change kept on the shot', async (t) => {
    if (skip(t)) return
    const s = await setup()
    const { id } = await s.api.create(s.uid, s.p.id, {
      takeId: s.video.id,
      kind: 'box',
      tStartMs: 1200,
      geom: { x: 0.1, y: 0.2, w: 0.3, h: 0.3 },
      text: '尾巴应该是白色的',
    })
    await s.api.send(s.uid, id)
    s.grok.answers.push(sure('regenerate_shot', { shotId: s.shot, promptDelta: '尾巴白色' }))
    const task = await runOne(s.exec)
    assert.equal(task.kind, 'interpret', 'interpret runs on a finished project')
    assert.equal(s.grok.calls[0]!.billTo, 'platform')
    assert.equal(s.grok.calls[0]!.image?.mediaType, 'image/jpeg', 'the marked frame is sent')
    const a = await annotation(id)
    assert.equal(a.interpretation?.op, 'regenerate_shot')
    assert.equal(a.interpretation?.execution?.state, 'running')
    assert.ok(a.frame, 'the marked frame is kept with the annotation')
    assert.equal((await projectRow(s.p.id)).status, 'running')
    const shot = (
      await query<{ status: string; active: string | null; redo: unknown }>(
        `SELECT status, active_take_id::text AS active, spec->'redo' AS redo FROM studio_shots WHERE id = $1`,
        [s.shot],
      )
    ).rows[0]!
    assert.deepEqual(shot, {
      status: 'generating',
      active: null,
      redo: { frame: 2, video: 2, delta: '尾巴白色' },
    })
    // The director dispatches the new first frame, with the change in its prompt (kept on retries).
    await advanceProject(s.advanceDeps, s.p.id)
    const gens = await genTasks(s.p.id)
    assert.deepEqual(
      gens.map((g) => g.key),
      [`gen:shot_frame:${s.shot}:v2`],
    )
    assert.ok(gens[0]!.request.prompt?.includes('修改要求：尾巴白色'))
  })

  test('keeping the first frame redoes only the video, from the frame on screen (INC-20261027-STUDIO-REGENERATE-REDOES-FRAME)', async (t) => {
    if (skip(t)) return
    // prod 2026-10-27 c6f0a9f2: "首帧画面保持不变…只重新生成视频" became regenerate_shot and a new
    // first frame was generated and charged (50) before the video.
    const s = await setup()
    const newer = await s.take('shot_frame', s.shot, 2, 'image/png')
    await query(`UPDATE studio_takes SET inputs = $2::jsonb WHERE id = $1`, [
      s.video.id,
      JSON.stringify({ inputs: [{ role: 'first_frame', blobSha: s.frame.sha }] }),
    ])
    const { id } = await s.api.create(s.uid, s.p.id, {
      takeId: s.video.id,
      kind: 'box',
      geom: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 },
      text: '首帧画面保持不变，只把视频重新生成一次，动作慢一点',
    })
    await s.api.send(s.uid, id)
    s.grok.answers.push(sure('regenerate_video', { shotId: s.shot, promptDelta: '动作慢一点' }))
    await runOne(s.exec)
    assert.equal((await annotation(id)).interpretation?.execution?.state, 'running')
    const shot = (
      await query<{ redo: unknown; frame: string | null }>(
        `SELECT spec->'redo' AS redo, spec->>'frameTakeId' AS frame FROM studio_shots WHERE id = $1`,
        [s.shot],
      )
    ).rows[0]!
    assert.deepEqual(shot, { redo: { frame: 0, video: 2, videoDelta: '动作慢一点' }, frame: s.frame.id })
    await advanceProject(s.advanceDeps, s.p.id)
    const gens = await genTasks(s.p.id)
    assert.deepEqual(
      gens.map((g) => g.key),
      [`gen:shot_video:${s.shot}:v2`],
      'only a video is made: no new first frame',
    )
    assert.deepEqual(gens[0]!.request.inputs, [{ role: 'first_frame', blobSha: s.frame.sha }])
    assert.notEqual(gens[0]!.request.inputs?.[0]?.blobSha, newer.sha, 'not the newer frame')
    assert.ok(gens[0]!.request.prompt?.includes('修改要求：动作慢一点'), 'the change is in the video prompt')
  })

  test('an edit is dispatched as image.edit of the current frame with the marked frame as reference', async (t) => {
    if (skip(t)) return
    const s = await setup()
    const { id } = await s.api.create(s.uid, s.p.id, {
      takeId: s.frame.id,
      kind: 'box',
      geom: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
      text: '这里加一棵树',
    })
    await s.api.send(s.uid, id)
    s.grok.answers.push(
      sure('edit_frame', {
        shotId: s.shot,
        region: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
        instruction: '加一棵雪松',
      }),
    )
    await runOne(s.exec)
    await advanceProject(s.advanceDeps, s.p.id)
    const [g] = await genTasks(s.p.id)
    const marked = (await annotation(id)).frame
    assert.equal(g?.request.op, 'image.edit')
    assert.deepEqual(g?.request.inputs, [
      { role: 'source', blobSha: s.frame.sha },
      { role: 'reference', blobSha: marked },
    ])
  })

  test('otherwise it waits; two applies start once; reject is refused while it runs', async (t) => {
    if (skip(t)) return
    const s = await setup({ autonomy: 'confirm', status: 'awaiting_user' })
    const { id } = await s.api.create(s.uid, s.p.id, {
      takeId: s.frame.id,
      kind: 'text',
      text: '镜头再长一点',
    })
    await s.api.send(s.uid, id)
    s.grok.answers.push(sure('retime_shot', { shotId: s.shot, durationSec: 7 }))
    await runOne(s.exec)
    assert.equal((await annotation(id)).interpretation?.execution, undefined, 'waits for the user')
    const results = await Promise.allSettled([s.api.apply(s.uid, id), s.api.apply(s.uid, id)])
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    assert.equal((refused.reason as { code?: string }).code, 'ANNOTATION_BUSY')
    const spec = (
      await query<{ d: number }>(
        `SELECT (spec->>'durationSec')::float8 AS d FROM studio_shots WHERE id = $1`,
        [s.shot],
      )
    ).rows[0]!
    assert.equal(spec.d, 7)
    await advanceProject(s.advanceDeps, s.p.id)
    assert.deepEqual(
      (await genTasks(s.p.id)).map((g) => g.key),
      [`gen:shot_video:${s.shot}:v2`],
      'one new video',
    )
    await assert.rejects(s.api.reject(s.uid, id), { code: 'ANNOTATION_BUSY' })
  })

  test('a second annotation on a target being changed fails as busy (code r1 P1)', async (t) => {
    if (skip(t)) return
    const s = await setup({ autonomy: 'confirm' })
    const ids: string[] = []
    for (const text of ['镜头长一点', '镜头再短一点']) {
      const { id } = await s.api.create(s.uid, s.p.id, { takeId: s.frame.id, kind: 'text', text })
      await s.api.send(s.uid, id)
      s.grok.answers.push(
        sure('retime_shot', { shotId: s.shot, durationSec: text.includes('长') ? 7 : 3 }),
      )
      await runOne(s.exec)
      ids.push(id)
    }
    await s.api.apply(s.uid, ids[0]!)
    await s.api.apply(s.uid, ids[1]!)
    const second = await annotation(ids[1]!)
    assert.deepEqual(
      [second.interpretation?.execution?.state, second.interpretation?.execution?.error],
      ['failed', 'target_busy'],
    )
  })

  test('a voice swap re-voices every line (plan r2 P1)', async (t) => {
    if (skip(t)) return
    const s = await setup()
    const lineTake = (
      await query<{ id: string }>(
        'SELECT active_take_id::text AS id FROM studio_lines WHERE id = $1',
        [s.lines[0]],
      )
    ).rows[0]!.id
    const { id } = await s.api.create(s.uid, s.p.id, {
      takeId: lineTake,
      kind: 'text',
      text: '换成少女的声音',
    })
    await s.api.send(s.uid, id)
    s.grok.answers.push(sure('swap_voice', { voiceId: 'female-shaonv' }))
    await runOne(s.exec)
    await advanceProject(s.advanceDeps, s.p.id)
    const gens = await genTasks(s.p.id)
    assert.deepEqual(
      gens.map((g) => g.key),
      s.lines.map((l) => `gen:line:${l}:v2`).sort(),
    )
    assert.ok(gens.every((g) => (g.request as { voiceId?: string }).voiceId === 'female-shaonv'))
    // The old voice takes are let go at once (code r2 P1): a film composed now cannot use them.
    const active = await query<{ a: string | null }>(
      'SELECT active_take_id::text AS a FROM studio_lines WHERE project_id = $1',
      [s.p.id],
    )
    assert.ok(active.rows.every((r) => r.a === null))
  })

  test('outside the whitelist nothing runs; the annotation can be sent again', async (t) => {
    if (skip(t)) return
    const s = await setup()
    const { id } = await s.api.create(s.uid, s.p.id, {
      takeId: s.frame.id,
      kind: 'text',
      text: '把项目删了',
    })
    await s.api.send(s.uid, id)
    s.grok.answers.push(sure('delete_project', {}))
    await runOne(s.exec)
    const a = await annotation(id)
    assert.deepEqual([a.status, a.interpretation?.op], ['sent', null])
    assert.equal((await projectRow(s.p.id)).status, 'done', 'not reopened')
    await s.api.send(s.uid, id)
    const keys = await query<{ key: string }>(
      `SELECT idempotency_key AS key FROM studio_tasks WHERE kind = 'interpret' ORDER BY created_at`,
      [],
    )
    assert.deepEqual(
      keys.rows.map((r) => r.key),
      [`interpret:${id}:0`, `interpret:${id}:1`],
    )
  })

  test('a running execution is applied once its target is ready on a new version', async (t) => {
    if (skip(t)) return
    const s = await setup()
    const { id } = await s.api.create(s.uid, s.p.id, {
      takeId: s.frame.id,
      kind: 'text',
      text: '第一句改成：雪停了',
    })
    await s.api.send(s.uid, id)
    s.grok.answers.push(sure('change_line', { lineId: s.lines[0], text: '雪停了' }))
    await runOne(s.exec)
    await advanceProject(s.advanceDeps, s.p.id)
    assert.equal((await annotation(id)).status, 'sent', 'still running')
    // A new voice take finishes and is adopted (v2 is the queued one the director dispatched).
    const v3 = await s.take('line', s.lines[0]!, 3, 'audio/mpeg')
    await query(`UPDATE studio_lines SET active_take_id = $2, status = 'ready' WHERE id = $1`, [
      s.lines[0],
      v3.id,
    ])
    await advanceProject(s.advanceDeps, s.p.id)
    const a = await annotation(id)
    assert.deepEqual(
      [a.status, a.applied, a.interpretation?.execution?.state],
      ['applied', v3.id, 'done'],
    )
  })

  test('a project handed to the user in the same pass ends the execution waiting on it (code r2 P1)', async (t) => {
    if (skip(t)) return
    const s = await setup()
    const { id } = await s.api.create(s.uid, s.p.id, {
      takeId: s.frame.id,
      kind: 'text',
      text: '长一点',
    })
    await s.api.send(s.uid, id)
    s.grok.answers.push(sure('retime_shot', { shotId: s.shot, durationSec: 7 }))
    await runOne(s.exec)
    // No video service at all: the director can only hand the shot over.
    const noVideo: ProviderRegistry = {
      ...registry,
      candidates: (kind, op, user, opts) =>
        kind === 'video' ? [] : registry.candidates(kind, op, user, opts),
    }
    await advanceProject({ ...s.advanceDeps, providers: noVideo }, s.p.id)
    assert.equal((await projectRow(s.p.id)).status, 'awaiting_user')
    const a = await annotation(id)
    assert.deepEqual(
      [a.interpretation?.execution?.state, a.interpretation?.execution?.error],
      ['failed', 'needs_user'],
    )
  })

  test('an execution ends when the project is handed to the user with its target unfinished', async (t) => {
    if (skip(t)) return
    const s = await setup()
    const { id } = await s.api.create(s.uid, s.p.id, {
      takeId: s.frame.id,
      kind: 'text',
      text: '长一点',
    })
    await s.api.send(s.uid, id)
    s.grok.answers.push(sure('retime_shot', { shotId: s.shot, durationSec: 7 }))
    await runOne(s.exec)
    await query(`UPDATE studio_projects SET status = 'awaiting_user' WHERE id = $1`, [s.p.id])
    await advanceProject(s.advanceDeps, s.p.id)
    const a = await annotation(id)
    assert.deepEqual(
      [a.interpretation?.execution?.state, a.interpretation?.execution?.error],
      ['failed', 'needs_user'],
    )
  })

  test('a budget that cannot cover the redo pauses the project; the annotation waits for it', async (t) => {
    if (skip(t)) return
    const s = await setup({ budget: 5 })
    const { id } = await s.api.create(s.uid, s.p.id, {
      takeId: s.frame.id,
      kind: 'text',
      text: '重画',
    })
    await s.api.send(s.uid, id)
    s.grok.answers.push(sure('regenerate_shot', { shotId: s.shot, promptDelta: '更亮' }))
    await runOne(s.exec)
    await advanceProject(s.advanceDeps, s.p.id)
    const p = await projectRow(s.p.id)
    assert.deepEqual([p.status, p.reserved], ['paused', '0'])
    assert.equal(
      (await annotation(id)).interpretation?.execution?.state,
      'running',
      'resumes with the budget',
    )
  })

  test('an export asked for before the rework waits for the new film (code r1 P1)', async (t) => {
    if (skip(t)) return
    const s = await setup()
    // A 720p export is waiting to run when the annotation reopens the film.
    await query(
      `INSERT INTO studio_tasks(id, project_id, kind, payload, idempotency_key, exec_request_id, run_after)
       VALUES (gen_random_uuid(), $1, 'compose', '{"reason":"export","variant":{"resolution":"720p","subtitles":"burn"}}'::jsonb,
               'compose:test-export', 'studio:test-export', NOW() + interval '1 hour')`,
      [s.p.id],
    )
    const { id } = await s.api.create(s.uid, s.p.id, {
      takeId: s.frame.id,
      kind: 'text',
      text: '长一点',
    })
    await s.api.send(s.uid, id)
    s.grok.answers.push(sure('retime_shot', { shotId: s.shot, durationSec: 7 }))
    assert.equal((await runOne(s.exec)).kind, 'interpret')
    assert.equal((await projectRow(s.p.id)).status, 'running')
    await query(
      `UPDATE studio_tasks SET run_after = NOW() WHERE idempotency_key = 'compose:test-export'`,
      [],
    )
    assert.equal((await runOne(s.exec)).kind, 'compose')
    const compose = await query<{ key: string; status: string; variant: unknown }>(
      `SELECT idempotency_key AS key, status, payload->'variant' AS variant FROM studio_tasks
        WHERE project_id = $1 AND kind = 'compose' ORDER BY created_at`,
      [s.p.id],
    )
    assert.deepEqual(
      compose.rows.map((r) => r.status),
      ['done', 'queued'],
      'the export did not fail; it waits',
    )
    assert.deepEqual(compose.rows[1]!.variant, { resolution: '720p', subtitles: 'burn' })
  })

  test('apply is refused on a canceled project', async (t) => {
    if (skip(t)) return
    const s = await setup({ autonomy: 'confirm' })
    const { id } = await s.api.create(s.uid, s.p.id, {
      takeId: s.frame.id,
      kind: 'text',
      text: '长一点',
    })
    await s.api.send(s.uid, id)
    s.grok.answers.push(sure('retime_shot', { shotId: s.shot, durationSec: 7 }))
    await runOne(s.exec)
    await query(`UPDATE studio_projects SET status = 'canceled' WHERE id = $1`, [s.p.id])
    await assert.rejects(s.api.apply(s.uid, id), { code: 'STUDIO_BAD_TRANSITION' })
    assert.equal((await annotation(id)).interpretation?.execution, undefined)
  })

  test("another user's annotation is not found", async (t) => {
    if (skip(t)) return
    const s = await setup()
    const other = await setup()
    const { id } = await s.api.create(s.uid, s.p.id, {
      takeId: s.frame.id,
      kind: 'text',
      text: '改',
    })
    for (const call of [
      () => other.api.send(other.uid, id),
      () => other.api.apply(other.uid, id),
      () => other.api.reject(other.uid, id),
      () => other.api.remove(other.uid, id),
    ])
      await assert.rejects(call(), { status: 404 })
    await assert.rejects(
      s.api.create(s.uid, s.p.id, { takeId: other.frame.id, kind: 'text', text: 'x' }),
      {
        status: 400,
      },
    )
  })
})
