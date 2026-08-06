import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { after, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'

import { signAccess } from '../auth/jwt.js'
import { resetPool, setPoolOverride } from '../db/index.js'
import {
  createMediaResultTicket,
  dispatchMediaGenerationRoute,
  verifyMediaResultTicket,
} from '../media-generation/http.js'
import { MediaGenerationService } from '../media-generation/service.js'
import {
  type MediaJobRow,
  acceptStaleShot,
  cancelProject,
  claimNextJob,
  completeJob,
  createComposeJob,
  createMediaJob,
  failJob,
  getJob,
  getProject,
  insertInput,
  listAckPendingJobs,
  listJobInputs,
  listJobs,
  listProjectShots,
  listProjects,
  markWorkerAcked,
  markWorkerStagingStarted,
  regenerateShot,
  requestCancel,
  withJobExecutionLease,
} from '../media-generation/store.js'
import { MediaWorkerClient } from '../media-generation/workerClient.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://octest:octest@127.0.0.1:5432/openclaude_commercial_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
const SCHEMA = 'oc_media_generation_test'
const here = path.dirname(fileURLToPath(import.meta.url))
const MIGRATION = path.resolve(here, '../db/migrations/0200_media_generation_jobs.sql')
const previousChannel = process.env.OC_RUNTIME_CHANNEL

let admin: Pool | undefined
let pool: Pool | undefined
let pgAvailable = false

before(async () => {
  admin = new Pool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1_500 })
  try {
    await admin.query('SELECT 1')
    pgAvailable = true
  } catch {
    await admin.end().catch(() => {})
    admin = undefined
    if (REQUIRE_TEST_DB)
      throw new Error('media generation integ requires the octest PostgreSQL fixture')
    return
  }
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
  await admin.query(`CREATE SCHEMA ${SCHEMA}`)
  pool = new Pool({
    connectionString: TEST_DB_URL,
    max: 8,
    options: `-c search_path=${SCHEMA}`,
  })
  await pool.query('CREATE TABLE users (id BIGINT PRIMARY KEY)')
  await pool.query(await readFile(MIGRATION, 'utf8'))
  setPoolOverride(pool)
  process.env.OC_RUNTIME_CHANNEL = 'v5'
})

after(async () => {
  if (pgAvailable) await resetPool().catch(() => {})
  if (admin) {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {})
    await admin.end().catch(() => {})
  }
  if (previousChannel === undefined) Reflect.deleteProperty(process.env, 'OC_RUNTIME_CHANNEL')
  else process.env.OC_RUNTIME_CHANNEL = previousChannel
})

beforeEach(async () => {
  if (!pgAvailable || !pool) return
  await pool.query(
    'TRUNCATE media_generation_job_inputs,video_project_shots,video_projects,media_generation_jobs,media_generation_inputs,users CASCADE',
  )
  await pool.query('INSERT INTO users(id) VALUES (1),(2)')
})

function maybe(t: { skip(reason: string): void }): boolean {
  if (pgAvailable) return true
  t.skip('octest PostgreSQL not running')
  return false
}

function service(): MediaGenerationService {
  return new MediaGenerationService({
    workerUrl: 'http://127.0.0.1:18883',
    workerToken: 'test-token-that-is-at-least-thirty-two-characters',
    stateRoot: '/tmp/openclaude-media-generation-test',
    allowUserIds: ['1'],
  })
}

async function addInput(
  id: string,
  kind: 'first_frame' | 'last_frame' | 'reference_image',
): Promise<void> {
  await insertInput({
    id,
    userId: '1',
    sha256: createHash('sha256').update(id).digest('hex'),
    sizeBytes: 10,
    mime: 'image/png',
    filename: `${id}.png`,
    workerFilename: `${id}.png`,
    kind,
    storagePath: `/tmp/${id}`,
  })
}

async function finishNext(resource: 'gpu-h3' | 'cpu-compose', sha: string) {
  const job = await claimNextJob(resource)
  assert.ok(job?.attemptId, `expected a ${resource} job`)
  const done = await completeJob(job, { path: `/tmp/${job.id}.mp4`, sha256: sha, size: 123 })
  assert.equal(done?.status, 'completed')
  assert.ok(await markWorkerAcked(done.id, done.attemptId!))
  return done!
}

function workerStatus(
  jobId: string,
  attemptId: string,
  status: 'running' | 'canceled',
): Record<string, unknown> {
  return {
    job_id: jobId,
    attempt_id: attemptId,
    fence_version: 1,
    resource_class: 'gpu-h3',
    status,
    phase: status,
    request_digest: status === 'running' ? 'worker-request-digest' : null,
    current_step: status === 'running' ? 1 : null,
    total_steps: status === 'running' ? 20 : null,
    result_sha256: null,
    result_size: null,
    error_code: null,
    error_message: null,
    result_ready: false,
  }
}

describe('media generation durable queue and projects', () => {
  test('worker client bypasses the gateway global proxy dispatcher', async () => {
    const job = {
      id: 'direct-egress-job',
      attemptId: 'direct-egress-attempt',
      fenceVersion: 1,
      resourceClass: 'gpu-h3',
    } as MediaJobRow
    const worker = createServer((req, res) => {
      assert.equal(req.url, '/v1/attempts/direct-egress-job/direct-egress-attempt/status')
      assert.equal(req.headers.authorization, 'Bearer test-worker-token-that-is-long-enough')
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(workerStatus(job.id, job.attemptId!, 'canceled')))
    })
    await new Promise<void>((resolve) => worker.listen(0, '127.0.0.1', resolve))
    const address = worker.address()
    assert.ok(address && typeof address === 'object')
    const previousDispatcher = getGlobalDispatcher()
    const proxyTrap = new MockAgent()
    proxyTrap.disableNetConnect()
    setGlobalDispatcher(proxyTrap)
    try {
      const client = new MediaWorkerClient(
        `http://127.0.0.1:${address.port}`,
        'test-worker-token-that-is-long-enough',
      )
      const status = await client.status(job)
      assert.equal(status.status, 'canceled')
    } finally {
      setGlobalDispatcher(previousDispatcher)
      await proxyTrap.close()
      worker.closeAllConnections()
      await new Promise<void>((resolve) => worker.close(() => resolve()))
    }
  })

  test('worker client splits large uploads into fixed-length streams without transfer encoding', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'oc-media-worker-chunks-'))
    const inputPath = path.join(root, 'large-input.bin')
    const inputBody = Buffer.alloc(9 * 1024 * 1024 + 17, 0x5a)
    await writeFile(inputPath, inputBody)
    const received: Buffer[] = []
    const offsets: string[] = []
    const lengths: string[] = []
    const worker = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        assert.equal(req.method, 'PUT')
        assert.equal(req.headers.authorization, 'Bearer test-worker-token-that-is-long-enough')
        assert.equal(req.headers['x-content-size'], String(inputBody.length))
        assert.equal(req.headers['transfer-encoding'], undefined)
        offsets.push(String(req.headers['x-upload-offset']))
        lengths.push(String(req.headers['content-length']))
        received.push(Buffer.concat(chunks))
        res.end(JSON.stringify({ ok: true }))
      })
    })
    await new Promise<void>((resolve) => worker.listen(0, '127.0.0.1', resolve))
    const address = worker.address()
    assert.ok(address && typeof address === 'object')
    try {
      const client = new MediaWorkerClient(
        `http://127.0.0.1:${address.port}`,
        'test-worker-token-that-is-long-enough',
      )
      const job = {
        id: 'chunk-client-job',
        attemptId: 'chunk-client-attempt',
        fenceVersion: 7,
        resourceClass: 'gpu-h3',
      } as MediaJobRow
      await client.upload(job, 0, {
        storagePath: inputPath,
        sha256: createHash('sha256').update(inputBody).digest('hex'),
        sizeBytes: inputBody.length,
        mime: 'application/octet-stream',
        kind: 'reference_image',
        workerFilename: 'large-input.bin',
      })
      assert.deepEqual(offsets, ['0', String(4 * 1024 * 1024), String(8 * 1024 * 1024)])
      assert.deepEqual(lengths, [
        String(4 * 1024 * 1024),
        String(4 * 1024 * 1024),
        String(1024 * 1024 + 17),
      ])
      assert.deepEqual(Buffer.concat(received), inputBody)
    } finally {
      worker.closeAllConnections()
      await new Promise<void>((resolve) => worker.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  })

  test('an empty rollout allowlist fails closed for reads, creation, and mutations', async (t) => {
    if (!maybe(t)) return
    const denied = new MediaGenerationService({
      workerUrl: 'http://127.0.0.1:18883',
      workerToken: 'test-token-that-is-at-least-thirty-two-characters',
    })
    assert.deepEqual(await denied.capabilities('1'), { available: false })
    await assert.rejects(
      denied.createJob('1', { prompt: 'must not queue' }),
      /media_generation_not_enabled/,
    )
    await assert.rejects(denied.listJobDtos('1'), /media_generation_not_enabled/)
    await assert.rejects(
      denied.regenerateProjectShot('1', 'project', 'shot', { expectedRev: 1 }),
      /media_generation_not_enabled/,
    )
    assert.equal((await listJobs('1')).jobs.length, 0)
  })

  test('the cross-process execution lease excludes a second owner for the whole callback', async (t) => {
    if (!maybe(t)) return
    let entered!: () => void
    let release!: () => void
    const inside = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = withJobExecutionLease(
      { id: 'lease-job', attemptId: 'lease-attempt' },
      async () => {
        entered()
        await gate
        return 'first'
      },
    )
    await inside
    let duplicateRan = false
    const duplicate = await withJobExecutionLease(
      { id: 'lease-job', attemptId: 'lease-attempt' },
      async () => {
        duplicateRan = true
      },
    )
    assert.equal(duplicate.acquired, false)
    assert.equal(duplicateRan, false)
    release()
    assert.deepEqual(await first, { acquired: true, value: 'first' })
    const afterRelease = await withJobExecutionLease(
      { id: 'lease-job', attemptId: 'lease-attempt' },
      async () => 'next',
    )
    assert.deepEqual(afterRelease, { acquired: true, value: 'next' })
  })

  test('standalone request ids are exactly idempotent and tenant-scoped', async (t) => {
    if (!maybe(t)) return
    await addInput('ref', 'reference_image')
    const input = {
      userId: '1',
      requestId: 'req-1',
      prompt: 'A clean office scene',
      options: { durationSeconds: 5, steps: 20 },
      inputIds: ['ref'],
    }
    const first = await createMediaJob(input)
    const retry = await createMediaJob(input)
    assert.equal(retry.id, first.id)
    await assert.rejects(
      createMediaJob({ ...input, prompt: 'different prompt' }),
      /media_job_idempotency_conflict/,
    )
    assert.equal(await getJob('2', first.id), null)
    const otherTenant = await createMediaJob({ ...input, userId: '2', inputIds: [] })
    assert.notEqual(otherTenant.id, first.id)
    await assert.rejects(
      pool!.query(
        `INSERT INTO media_generation_jobs
        (id,request_id,user_id,runtime_channel,kind,resource_class,prompt,predecessor_job_id)
       VALUES ('cross-tenant','cross-tenant',2,'v5','h3_generate','gpu-h3','bad',$1)`,
        [first.id],
      ),
      /foreign key constraint/,
    )
  })

  test('project creation preserves reference order and assigns first/last frames to boundary shots', async (t) => {
    if (!maybe(t)) return
    await addInput('first', 'first_frame')
    await addInput('ref-a', 'reference_image')
    await addInput('ref-b', 'reference_image')
    await addInput('last', 'last_frame')
    const body = {
      requestId: 'project-request-1',
      title: '一分钟产品片',
      inputIds: ['first', 'ref-b', 'ref-a', 'last'],
      options: { aspect: '16:9', steps: 20 },
      shots: [
        { prompt: 'shot one', durationSeconds: 5 },
        { prompt: 'shot two', durationSeconds: 10 },
        { prompt: 'shot three', durationSeconds: 15 },
      ],
    }
    const created = await service().createVideoProject('1', body)
    const retry = await service().createVideoProject('1', body)
    assert.equal(retry.id, created.id)
    await assert.rejects(
      service().createVideoProject('1', { ...body, title: '冲突标题' }),
      /project_idempotency_conflict/,
    )
    assert.equal(created.status, 'draft')
    assert.ok(created.shots.every((shot) => shot.activeJob === null))
    const started = await service().startVideoProject('1', created.id, 1)
    const startRetry = await service().startVideoProject('1', created.id, 1)
    assert.equal(started.rev, 2)
    assert.deepEqual(
      startRetry.shots.map((shot) => shot.activeJob?.id),
      started.shots.map((shot) => shot.activeJob?.id),
    )
    const shots = await listProjectShots('1', created.id)
    assert.equal(shots.length, 3)
    assert.deepEqual(
      (await listJobInputs('1', shots[0]!.active_media_job_id!)).map((row) => row.id),
      ['ref-b', 'ref-a', 'first'],
    )
    assert.deepEqual(
      (await listJobInputs('1', shots[1]!.active_media_job_id!)).map((row) => row.id),
      ['ref-b', 'ref-a'],
    )
    assert.deepEqual(
      (await listJobInputs('1', shots[2]!.active_media_job_id!)).map((row) => row.id),
      ['ref-b', 'ref-a', 'last'],
    )
  })

  test('a draft storyboard can be replaced before start without breaking create idempotency', async (t) => {
    if (!maybe(t)) return
    await addInput('draft-ref', 'reference_image')
    const body = {
      requestId: 'editable-draft',
      title: '初稿',
      inputIds: ['draft-ref'],
      shots: [
        { prompt: 'old one', durationSeconds: 5 },
        { prompt: 'old two', durationSeconds: 5 },
      ],
    }
    const created = await service().createVideoProject('1', body)
    const edited = await service().editVideoProject('1', created.id, {
      expectedRev: 1,
      title: '用户确认稿',
      shots: [{ prompt: 'replacement shot', durationSeconds: 10 }],
      options: { aspect: '9:16', steps: 16 },
    })
    assert.equal(edited.rev, 2)
    assert.equal(edited.title, '用户确认稿')
    assert.equal(edited.status, 'draft')
    assert.deepEqual(
      edited.shots.map((shot) => shot.prompt),
      ['replacement shot'],
    )
    assert.equal((await service().createVideoProject('1', body)).id, created.id)

    const started = await service().startVideoProject('1', created.id, 2)
    assert.equal(started.rev, 3)
    assert.deepEqual(
      (await listJobInputs('1', started.shots[0]!.activeJob!.id)).map((input) => input.id),
      ['draft-ref'],
    )
    await assert.rejects(
      service().editVideoProject('1', created.id, {
        expectedRev: 3,
        shots: [{ prompt: 'too late', durationSeconds: 5 }],
      }),
      /project_already_started/,
    )
  })

  test('draft and canceled projects cannot bypass their lifecycle', async (t) => {
    if (!maybe(t)) return
    const draft = await service().createVideoProject('1', {
      requestId: 'project-lifecycle',
      title: '生命周期',
      shots: [{ prompt: 'one', durationSeconds: 5 }],
    })
    await assert.rejects(
      service().regenerateProjectShot('1', draft.id, draft.shots[0]!.id, {
        expectedRev: draft.rev,
        requestId: 'draft-regenerate',
      }),
      /project_not_started/,
    )
    const started = await service().startVideoProject('1', draft.id, draft.rev)
    await service().cancelVideoProject('1', draft.id, started.rev)
    const canceled = await service().projectDto('1', draft.id)
    assert.equal(canceled?.status, 'canceled')
    await assert.rejects(
      service().regenerateProjectShot('1', draft.id, draft.shots[0]!.id, {
        expectedRev: canceled!.rev,
        requestId: 'canceled-regenerate',
      }),
      /project_canceled/,
    )
    await assert.rejects(
      service().renderProject('1', draft.id, {
        expectedRev: canceled!.rev,
        requestId: 'canceled-compose',
      }),
      /project_canceled/,
    )
    await assert.rejects(
      service().acceptProjectShot('1', draft.id, draft.shots[0]!.id, canceled!.rev),
      /project_canceled/,
    )
  })

  test('input streams stop at the declared size and enforce transparent file and user quotas', async (t) => {
    if (!maybe(t)) return
    const root = await mkdtemp(path.join(tmpdir(), 'oc-media-input-'))
    const limited = new MediaGenerationService({
      workerUrl: 'http://127.0.0.1:18883',
      workerToken: 'test-token-that-is-at-least-thirty-two-characters',
      stateRoot: root,
      allowUserIds: ['1'],
      maxInputBytes: 8,
      maxUserStoredInputBytes: 10,
    })
    try {
      const oversizedChunk = Buffer.alloc(1024 * 1024, 1)
      await assert.rejects(
        limited.ingestInput('1', Readable.from([oversizedChunk]) as IncomingMessage, {
          kind: 'reference_image',
          filename: 'overflow.png',
          mime: 'image/png',
          sha256: createHash('sha256')
            .update(Buffer.from([1]))
            .digest('hex'),
          size: 1,
        }),
        /input_size_exceeded/,
      )
      assert.equal(
        (await pool!.query('SELECT count(*)::int AS count FROM media_generation_inputs')).rows[0]
          .count,
        0,
      )

      await assert.rejects(
        limited.ingestInput('1', Readable.from([]) as IncomingMessage, {
          kind: 'reference_image',
          filename: 'file-quota.png',
          mime: 'image/png',
          sha256: 'a'.repeat(64),
          size: 9,
        }),
        /media_input_file_quota_exceeded/,
      )
      await addInput('quota-existing', 'reference_image')
      await pool!.query('UPDATE media_generation_inputs SET size_bytes=8 WHERE id=$1', [
        'quota-existing',
      ])
      await assert.rejects(
        limited.ingestInput('1', Readable.from([]) as IncomingMessage, {
          kind: 'reference_image',
          filename: 'user-quota.png',
          mime: 'image/png',
          sha256: 'b'.repeat(64),
          size: 3,
        }),
        /media_input_user_quota_exceeded/,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('FIFO dependencies freeze artifact hashes and regeneration makes descendants explicitly reviewable', async (t) => {
    if (!maybe(t)) return
    await addInput('ref', 'reference_image')
    const project = await service().createVideoProject('1', {
      requestId: 'project-sequential',
      title: '连续分镜',
      inputIds: ['ref'],
      options: { aspect: '16:9', steps: 20 },
      shots: [
        { prompt: 'first', durationSeconds: 5 },
        { prompt: 'second', durationSeconds: 5 },
      ],
    })
    await service().startVideoProject('1', project.id, 1)
    const firstDone = await finishNext('gpu-h3', 'a'.repeat(64))
    const secondDone = await finishNext('gpu-h3', 'b'.repeat(64))
    assert.equal(secondDone.predecessorJobId, firstDone.id)
    assert.equal(secondDone.predecessorArtifactSha256, 'a'.repeat(64))
    assert.equal((await service().projectDto('1', project.id))?.status, 'ready')

    const firstShot = (await listProjectShots('1', project.id))[0]!
    const regenerated = await regenerateShot('1', project.id, firstShot.id, 2, 'redo-first')
    assert.equal(
      (await regenerateShot('1', project.id, firstShot.id, 2, 'redo-first')).id,
      regenerated.id,
    )
    assert.deepEqual(
      (await listJobInputs('1', regenerated.id)).map((row) => row.id),
      ['ref'],
    )
    await finishNext('gpu-h3', 'c'.repeat(64))
    const staleShot = (await listProjectShots('1', project.id))[1]!
    assert.ok(staleShot.stale_at)
    assert.equal((await service().projectDto('1', project.id))?.status, 'needs_review')
    await acceptStaleShot('1', project.id, staleShot.id, 3)
    assert.equal((await service().projectDto('1', project.id))?.status, 'ready')
  })

  test('regeneration rebinds an undispatched child to the new predecessor without wasting the old queued job', async (t) => {
    if (!maybe(t)) return
    const project = await service().createVideoProject('1', {
      requestId: 'project-rebind',
      title: '排队依赖重绑',
      shots: [
        { prompt: 'first', durationSeconds: 5 },
        { prompt: 'second', durationSeconds: 5 },
      ],
    })
    const started = await service().startVideoProject('1', project.id, 1)
    const oldFirstId = started.shots[0]!.activeJob!.id
    const childId = started.shots[1]!.activeJob!.id
    const regenerated = await service().regenerateProjectShot(
      '1',
      project.id,
      started.shots[0]!.id,
      { expectedRev: 2, requestId: 'rebind-first' },
    )
    assert.equal((await getJob('1', oldFirstId))?.status, 'canceled')
    const rebound = await getJob('1', childId)
    assert.equal(rebound?.predecessorJobId, regenerated.id)
    assert.equal(rebound?.predecessorArtifactSha256, null)
    assert.equal((await listProjectShots('1', project.id))[1]!.stale_at, null)

    const regeneratedDone = await finishNext('gpu-h3', '7'.repeat(64))
    assert.equal(regeneratedDone.id, regenerated.id)
    const childDone = await finishNext('gpu-h3', '8'.repeat(64))
    assert.equal(childDone.id, childId)
    assert.equal(childDone.predecessorArtifactSha256, '7'.repeat(64))
    assert.equal((await service().projectDto('1', project.id))?.status, 'ready')
  })

  test('compose freezes the exact revision manifest and an old render cannot become current', async (t) => {
    if (!maybe(t)) return
    const project = await service().createVideoProject('1', {
      requestId: 'project-compose',
      title: '合成冻结',
      options: { aspect: '16:9', steps: 20 },
      shots: [
        { prompt: 'one', durationSeconds: 5 },
        { prompt: 'two', durationSeconds: 5 },
      ],
    })
    await service().startVideoProject('1', project.id, 1)
    await finishNext('gpu-h3', 'd'.repeat(64))
    await finishNext('gpu-h3', 'e'.repeat(64))
    const compose = await createComposeJob('1', project.id, 2, 'compose-1', { mode: 'normalize' })
    assert.equal(
      (await createComposeJob('1', project.id, 2, 'compose-1', { mode: 'normalize' })).id,
      compose.id,
    )
    await assert.rejects(
      createComposeJob('1', project.id, 2, 'compose-1', { mode: 'copy' }),
      /compose_job_conflict/,
    )
    await assert.rejects(
      service().renderProject('1', project.id, { expectedRev: 3, options: { fps: 24 } }),
      /unsupported_compose_option/,
    )
    assert.deepEqual(
      (compose.composeManifest as Array<{ sha256: string }>).map((item) => item.sha256),
      ['d'.repeat(64), 'e'.repeat(64)],
    )
    const activeCompose = await claimNextJob('cpu-compose')
    assert.equal(activeCompose?.id, compose.id)
    const firstShot = (await listProjectShots('1', project.id))[0]!
    await regenerateShot('1', project.id, firstShot.id, 3, 'redo-after-compose')
    await completeJob(activeCompose!, {
      path: '/tmp/old-compose.mp4',
      sha256: 'f'.repeat(64),
      size: 456,
    })
    const current = await getProject('1', project.id)
    assert.equal(current?.rev, 4)
    assert.equal(current?.current_compose_job_id, null)
  })

  test('job and project history paginate without truncation and cancellation is CAS guarded', async (t) => {
    if (!maybe(t)) return
    for (let index = 0; index < 4; index += 1) {
      await createMediaJob({
        userId: '1',
        requestId: `page-job-${index}`,
        prompt: `job ${index}`,
        options: { durationSeconds: 5 },
      })
    }
    const page1 = await listJobs('1', undefined, 2)
    const page2 = await listJobs('1', page1.nextCursor!, 2)
    assert.equal(page1.jobs.length, 2)
    assert.equal(page2.jobs.length, 2)
    assert.equal(new Set([...page1.jobs, ...page2.jobs].map((job) => job.id)).size, 4)

    for (let index = 0; index < 3; index += 1) {
      await service().createVideoProject('1', {
        requestId: `page-project-${index}`,
        title: `project ${index}`,
        shots: [{ prompt: `shot ${index}`, durationSeconds: 5 }],
      })
    }
    const projects1 = await listProjects('1', undefined, 2)
    const projects2 = await listProjects('1', projects1.nextCursor!, 2)
    assert.equal(projects1.projects.length, 2)
    assert.equal(projects2.projects.length, 1)
    const target = projects1.projects[0]!
    await assert.rejects(cancelProject('1', target.id, 99), /project_revision_conflict/)
    await cancelProject('1', target.id, 1)
    assert.ok((await getProject('1', target.id))?.canceled_at)

    const queued = page1.jobs[0]!
    assert.equal((await requestCancel('1', queued.id))?.status, 'canceled')
  })

  test('failed and canceled worker attempts remain ACK-pending until cleanup is confirmed', async (t) => {
    if (!maybe(t)) return
    for (const status of ['failed', 'canceled'] as const) {
      await createMediaJob({
        userId: '1',
        requestId: `terminal-ack-${status}`,
        prompt: `terminal ${status}`,
        options: { durationSeconds: 5 },
      })
      const claimed = await claimNextJob('gpu-h3')
      assert.ok(claimed?.attemptId)
      const staged = await markWorkerStagingStarted(claimed.id, claimed.attemptId)
      assert.ok(staged)
      const terminal = await failJob(staged, status, status, status)
      assert.ok(terminal)
      assert.equal(terminal.workerAckPending, true)
      assert.equal((await listAckPendingJobs()).at(-1)?.status, status)
      assert.ok(await markWorkerAcked(terminal.id, terminal.attemptId!))
    }
    assert.equal((await listAckPendingJobs()).length, 0)
  })

  test('a claimed pre-staging cancellation terminates locally without contacting the worker', async (t) => {
    if (!maybe(t)) return
    let workerRequests = 0
    const worker = createServer((_req, res) => {
      workerRequests += 1
      res.statusCode = 500
      res.end()
    })
    await new Promise<void>((resolve) => worker.listen(0, '127.0.0.1', resolve))
    const address = worker.address()
    assert.ok(address && typeof address === 'object')
    const queued = await createMediaJob({
      userId: '1',
      requestId: 'claimed-pre-stage-cancel',
      prompt: 'cancel before staging',
      options: { durationSeconds: 5 },
    })
    const claimed = await claimNextJob('gpu-h3')
    assert.equal(claimed?.id, queued.id)
    await requestCancel('1', queued.id)
    const runner = new MediaGenerationService({
      workerUrl: `http://127.0.0.1:${address.port}`,
      workerToken: 'test-worker-token-that-is-long-enough',
      allowUserIds: ['1'],
    })
    const handle = runner.start(60_000)
    try {
      let canceled = await getJob('1', queued.id)
      for (let index = 0; index < 100 && canceled?.status !== 'canceled'; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        canceled = await getJob('1', queued.id)
      }
      assert.equal(canceled?.status, 'canceled')
      assert.equal(canceled?.workerStagingStartedAt, null)
      assert.equal(canceled?.workerAckPending, false)
      assert.equal(workerRequests, 0)
    } finally {
      await handle.stop()
      worker.closeAllConnections()
      await new Promise<void>((resolve) => worker.close(() => resolve()))
    }
  })

  test('canceling after staging intent treats a missing worker attempt as canceled, not failed', async (t) => {
    if (!maybe(t)) return
    let workerRequests = 0
    const worker = createServer((_req, res) => {
      workerRequests += 1
      res.statusCode = 404
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: 'attempt_not_found' }))
    })
    await new Promise<void>((resolve) => worker.listen(0, '127.0.0.1', resolve))
    const address = worker.address()
    assert.ok(address && typeof address === 'object')
    const queued = await createMediaJob({
      userId: '1',
      requestId: 'staging-missing-cancel',
      prompt: 'cancel missing staging attempt',
      options: { durationSeconds: 5 },
    })
    const claimed = await claimNextJob('gpu-h3')
    assert.equal(claimed?.id, queued.id)
    assert.ok(claimed?.attemptId)
    await markWorkerStagingStarted(claimed.id, claimed.attemptId)
    await requestCancel('1', queued.id)
    const runner = new MediaGenerationService({
      workerUrl: `http://127.0.0.1:${address.port}`,
      workerToken: 'test-worker-token-that-is-long-enough',
      allowUserIds: ['1'],
    })
    const handle = runner.start(60_000)
    try {
      let canceled = await getJob('1', queued.id)
      for (let index = 0; index < 100 && !canceled?.workerAckedAt; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        canceled = await getJob('1', queued.id)
      }
      assert.equal(canceled?.status, 'canceled')
      assert.equal(canceled?.errorCode, 'user_canceled')
      assert.equal(canceled?.workerAckPending, false)
      assert.ok(canceled?.workerAckedAt)
      assert.equal(workerRequests, 2)
    } finally {
      await handle.stop()
      worker.closeAllConnections()
      await new Promise<void>((resolve) => worker.close(() => resolve()))
    }
  })

  test('a fatal staging upload is canceled and ACK-scrubbed on the worker', async (t) => {
    if (!maybe(t)) return
    const root = await mkdtemp(path.join(tmpdir(), 'oc-media-staging-fatal-'))
    const inputPath = path.join(root, 'private-reference.png')
    const inputBody = Buffer.from('private-reference')
    await writeFile(inputPath, inputBody)
    const inputSha = createHash('sha256').update(inputBody).digest('hex')
    let workerState: 'missing' | 'staging' | 'canceled' | 'acked' = 'missing'
    const actions: string[] = []
    const worker = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        const match = /^\/v1\/attempts\/([^/]+)\/([^/]+)\/(status|ack|cancel|inputs\/\d+)$/.exec(
          req.url ?? '',
        )
        assert.ok(match)
        const action = match[3]!
        actions.push(action)
        res.setHeader('content-type', 'application/json')
        if (action === 'status' && workerState === 'missing') {
          res.statusCode = 404
          res.end(JSON.stringify({ error: 'attempt_not_found' }))
        } else if (action.startsWith('inputs/')) {
          workerState = 'staging'
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'input_sha256_mismatch' }))
        } else if (action === 'ack' && workerState === 'staging') {
          res.statusCode = 409
          res.end(JSON.stringify({ error: 'attempt_not_terminal' }))
        } else if (action === 'cancel') {
          workerState = 'canceled'
          res.end(JSON.stringify(workerStatus(match[1]!, match[2]!, 'canceled')))
        } else if (action === 'ack' && workerState === 'canceled') {
          workerState = 'acked'
          res.end(JSON.stringify({ ok: true }))
        } else {
          assert.fail(`unexpected worker action ${action} in state ${workerState}`)
        }
      })
    })
    await new Promise<void>((resolve) => worker.listen(0, '127.0.0.1', resolve))
    const address = worker.address()
    assert.ok(address && typeof address === 'object')
    const runner = new MediaGenerationService({
      workerUrl: `http://127.0.0.1:${address.port}`,
      workerToken: 'test-worker-token-that-is-long-enough',
      stateRoot: root,
      allowUserIds: ['1'],
    })
    let handle: ReturnType<MediaGenerationService['start']> | undefined
    try {
      await insertInput({
        id: 'fatal-staging-input',
        userId: '1',
        sha256: inputSha,
        sizeBytes: inputBody.length,
        mime: 'image/png',
        filename: 'private-reference.png',
        workerFilename: 'private-reference.png',
        kind: 'reference_image',
        storagePath: inputPath,
      })
      const queued = await createMediaJob({
        userId: '1',
        requestId: 'fatal-staging-upload',
        prompt: 'private prompt',
        options: { durationSeconds: 5 },
        inputIds: ['fatal-staging-input'],
      })
      handle = runner.start(60_000)
      let failed = await getJob('1', queued.id)
      for (let index = 0; index < 100 && !failed?.workerAckedAt; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        failed = await getJob('1', queued.id)
      }
      assert.equal(failed?.status, 'failed')
      assert.equal(failed?.workerAckPending, false)
      assert.equal(workerState, 'acked')
      assert.deepEqual(actions, ['status', 'inputs/0', 'ack', 'cancel', 'ack'])
    } finally {
      await handle?.stop()
      worker.closeAllConnections()
      await new Promise<void>((resolve) => worker.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a fatal running attempt holds FIFO until cancel reaches terminal and ACK completes', async (t) => {
    if (!maybe(t)) return
    let workerState: 'missing' | 'running' | 'canceling' | 'canceled' | 'acked' = 'missing'
    let firstJobId = ''
    let nextSubmitted = false
    let cancelAttempts = 0
    let ackAttempts = 0
    const worker = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        const match = /^\/v1\/attempts\/([^/]+)\/([^/]+)\/(status|submit|ack|cancel)$/.exec(
          req.url ?? '',
        )
        assert.ok(match)
        const action = match[3]!
        res.setHeader('content-type', 'application/json')
        if (match[1] !== firstJobId) {
          if (action === 'status' && !nextSubmitted) {
            res.statusCode = 404
            res.end(JSON.stringify({ error: 'attempt_not_found' }))
          } else if (action === 'submit') {
            nextSubmitted = true
            res.end(JSON.stringify(workerStatus(match[1]!, match[2]!, 'running')))
          } else if (action === 'status') {
            res.end(JSON.stringify(workerStatus(match[1]!, match[2]!, 'running')))
          } else {
            assert.fail(`unexpected next-worker action ${action}`)
          }
          return
        }
        if (action === 'status' && workerState === 'missing') {
          res.statusCode = 404
          res.end(JSON.stringify({ error: 'attempt_not_found' }))
        } else if (action === 'submit') {
          workerState = 'running'
          res.end(JSON.stringify(workerStatus(match[1]!, match[2]!, 'running')))
        } else if (action === 'status' && workerState === 'running') {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'fatal_worker_contract' }))
        } else if (action === 'ack' && workerState !== 'canceled') {
          ackAttempts += 1
          res.statusCode = 409
          res.end(JSON.stringify({ error: 'attempt_not_terminal' }))
        } else if (action === 'cancel') {
          cancelAttempts += 1
          workerState = cancelAttempts === 1 ? 'canceling' : 'canceled'
          res.end(
            JSON.stringify(
              workerStatus(
                match[1]!,
                match[2]!,
                workerState === 'canceled' ? 'canceled' : 'running',
              ),
            ),
          )
        } else if (action === 'ack' && workerState === 'canceled') {
          ackAttempts += 1
          workerState = 'acked'
          res.end(JSON.stringify({ ok: true }))
        } else {
          assert.fail(`unexpected worker action ${action} in state ${workerState}`)
        }
      })
    })
    await new Promise<void>((resolve) => worker.listen(0, '127.0.0.1', resolve))
    const address = worker.address()
    assert.ok(address && typeof address === 'object')
    const runner = new MediaGenerationService({
      workerUrl: `http://127.0.0.1:${address.port}`,
      workerToken: 'test-worker-token-that-is-long-enough',
      allowUserIds: ['1'],
    })
    const queued = await createMediaJob({
      userId: '1',
      requestId: 'fatal-running-worker',
      prompt: 'private running prompt',
      options: { durationSeconds: 5 },
    })
    firstJobId = queued.id
    const handle = runner.start(60_000)
    try {
      let failed = await getJob('1', queued.id)
      for (
        let index = 0;
        index < 100 && (failed?.status !== 'failed' || cancelAttempts < 1);
        index += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        failed = await getJob('1', queued.id)
      }
      assert.equal(failed?.workerAckPending, true)
      assert.equal(workerState, 'canceling')
      const next = await createMediaJob({
        userId: '1',
        requestId: 'queued-behind-canceling-worker',
        prompt: 'must remain queued while the old GPU process exits',
        options: { durationSeconds: 5 },
      })
      assert.equal(await claimNextJob('gpu-h3'), null)
      assert.equal((await getJob('1', next.id))?.status, 'queued')
      for (let index = 0; index < 100 && !failed?.workerAckedAt; index += 1) {
        await handle.runNow()
        await new Promise((resolve) => setTimeout(resolve, 20))
        failed = await getJob('1', queued.id)
      }
      assert.equal(workerState, 'acked')
      assert.equal(cancelAttempts, 2)
      assert.equal(ackAttempts, 3)
      assert.equal(failed?.workerAckPending, false)
      for (let index = 0; index < 100; index += 1) {
        await handle.runNow()
        await new Promise((resolve) => setTimeout(resolve, 20))
        if ((await getJob('1', next.id))?.status !== 'queued') break
      }
      const dispatched = await getJob('1', next.id)
      assert.ok(
        dispatched && ['dispatching', 'running', 'reconnecting'].includes(dispatched.status),
      )
      assert.notEqual(dispatched.status, 'failed')
    } finally {
      await handle.stop()
      worker.closeAllConnections()
      await new Promise<void>((resolve) => worker.close(() => resolve()))
    }
  })

  test('scheduler streams inputs and results through one fenced worker attempt before durable completion', async (t) => {
    if (!maybe(t)) return
    const root = await mkdtemp(path.join(tmpdir(), 'oc-media-service-'))
    const inputPath = path.join(root, 'reference.png')
    const inputBody = Buffer.from('reference-image-bytes')
    const resultBody = Buffer.from('generated-video-bytes')
    await writeFile(inputPath, inputBody)
    const inputSha = createHash('sha256').update(inputBody).digest('hex')
    const resultSha = createHash('sha256').update(resultBody).digest('hex')
    let submitted = false
    let ackAttempts = 0
    let uploaded = Buffer.alloc(0)
    const worker = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        const body = Buffer.concat(chunks)
        const match =
          /^\/v1\/attempts\/([^/]+)\/([^/]+)\/(status|submit|result|ack|inputs\/\d+)$/.exec(
            req.url ?? '',
          )
        assert.ok(match)
        assert.equal(req.headers.authorization, 'Bearer test-worker-token-that-is-long-enough')
        const base = {
          job_id: match[1],
          attempt_id: match[2],
          fence_version: Number(req.headers['x-fence-version']),
          resource_class: 'gpu-h3',
          phase: submitted ? 'completed' : 'staging',
          request_digest: submitted ? 'worker-request-digest' : null,
          current_step: submitted ? 20 : null,
          total_steps: submitted ? 20 : null,
          result_sha256: submitted ? resultSha : null,
          result_size: submitted ? resultBody.length : null,
          error_code: null,
          error_message: null,
          result_ready: submitted,
        }
        res.setHeader('content-type', 'application/json')
        if (match[3] === 'status' && !submitted) {
          res.statusCode = 404
          res.end(JSON.stringify({ error: 'attempt_not_found' }))
        } else if (match[3]?.startsWith('inputs/')) {
          assert.equal(req.headers['content-length'], String(inputBody.length))
          assert.equal(req.headers['transfer-encoding'], undefined)
          assert.equal(req.headers['x-upload-offset'], '0')
          uploaded = body
          res.end(JSON.stringify({ ok: true }))
        } else if (match[3] === 'submit') {
          submitted = true
          res.end(
            JSON.stringify({
              ...base,
              status: 'running',
              phase: 'sampling',
              request_digest: 'worker-request-digest',
            }),
          )
        } else if (match[3] === 'status') {
          res.end(JSON.stringify({ ...base, status: 'completed' }))
        } else if (match[3] === 'result') {
          res.setHeader('content-type', 'video/mp4')
          res.setHeader('content-length', String(resultBody.length))
          res.setHeader('x-content-sha256', resultSha)
          res.end(resultBody)
        } else {
          ackAttempts += 1
          if (ackAttempts === 1) {
            res.statusCode = 503
            res.end(JSON.stringify({ error: 'temporary_ack_failure' }))
          } else {
            res.end(JSON.stringify({ ok: true }))
          }
        }
      })
    })
    await new Promise<void>((resolve) => worker.listen(0, '127.0.0.1', resolve))
    const address = worker.address()
    assert.ok(address && typeof address === 'object')
    const broadcasts: string[] = []
    const runner = new MediaGenerationService({
      workerUrl: `http://127.0.0.1:${address.port}`,
      workerToken: 'test-worker-token-that-is-long-enough',
      stateRoot: root,
      allowUserIds: ['1'],
      broadcast: (_userId, frame) => broadcasts.push(frame.job.status),
    })
    let handle: ReturnType<MediaGenerationService['start']> | undefined
    try {
      await insertInput({
        id: 'worker-ref',
        userId: '1',
        sha256: inputSha,
        sizeBytes: inputBody.length,
        mime: 'image/png',
        filename: 'reference.png',
        workerFilename: 'worker-ref.png',
        kind: 'reference_image',
        storagePath: inputPath,
      })
      const queued = await createMediaJob({
        userId: '1',
        requestId: 'worker-run',
        prompt: 'worker integration',
        options: { durationSeconds: 5, steps: 20 },
        inputIds: ['worker-ref'],
      })
      handle = runner.start(60_000)
      await handle.runNow()
      let completed = await getJob('1', queued.id)
      for (let index = 0; index < 100 && completed?.status !== 'completed'; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25))
        completed = await getJob('1', queued.id)
      }
      assert.equal(completed?.status, 'completed')
      assert.equal(completed?.requestDigest, 'worker-request-digest')
      assert.equal(completed?.resultSha256, resultSha)
      assert.deepEqual(uploaded, inputBody)
      for (let index = 0; index < 100 && ackAttempts < 2; index += 1) {
        await handle.runNow()
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      const acknowledged = await getJob('1', queued.id)
      assert.equal(ackAttempts, 2)
      assert.equal(acknowledged?.workerAckPending, false)
      assert.ok(acknowledged?.workerAckedAt)
      assert.ok(broadcasts.includes('running'))
      assert.equal(broadcasts.at(-1), 'completed')
      assert.deepEqual(await readFile(completed!.resultPath!), resultBody)
    } finally {
      await handle?.stop()
      worker.closeAllConnections()
      await new Promise<void>((resolve) => worker.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  })

  test('browser result tickets authorize byte ranges without exposing the bearer token', async (t) => {
    if (!maybe(t)) return
    const jwtSecret = 'media-result-test-secret-that-is-long-enough'
    const resultBody = Buffer.from('0123456789-video')
    const resultSha = createHash('sha256').update(resultBody).digest('hex')
    const root = await mkdtemp(path.join(tmpdir(), 'oc-media-result-'))
    const resultPath = path.join(root, 'result.mp4')
    await writeFile(resultPath, resultBody)
    const queued = await createMediaJob({
      userId: '1',
      requestId: 'signed-result',
      prompt: 'signed result',
      options: { durationSeconds: 5 },
    })
    const claimed = await claimNextJob('gpu-h3')
    assert.equal(claimed?.id, queued.id)
    await completeJob(claimed!, { path: resultPath, sha256: resultSha, size: resultBody.length })
    const browser = createServer((req, res) => {
      void dispatchMediaGenerationRoute(req, res, {} as never, {
        jwtSecret,
        mediaGeneration: service(),
      }).catch((error) => {
        res.statusCode = typeof error?.status === 'number' ? error.status : 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: error?.code ?? 'INTERNAL' }))
      })
    })
    await new Promise<void>((resolve) => browser.listen(0, '127.0.0.1', resolve))
    const address = browser.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    try {
      const unsigned = await fetch(`${base}/api/media-generation/jobs/${queued.id}/result`)
      assert.equal(unsigned.status, 401)
      const access = (await signAccess({ sub: '1', role: 'user' }, jwtSecret)).token
      const issued = await fetch(`${base}/api/media-generation/jobs/${queued.id}/result-ticket`, {
        method: 'POST',
        headers: { authorization: `Bearer ${access}` },
      })
      assert.equal(issued.status, 200)
      const ticket = (await issued.json()) as { url: string; expiresInSeconds: number }
      assert.equal(ticket.expiresInSeconds, 15 * 60)
      assert.equal(ticket.url.includes(access), false)
      const partial = await fetch(`${base}${ticket.url}`, { headers: { range: 'bytes=2-5' } })
      assert.equal(partial.status, 206)
      assert.equal(partial.headers.get('content-range'), `bytes 2-5/${resultBody.length}`)
      assert.deepEqual(Buffer.from(await partial.arrayBuffer()), resultBody.subarray(2, 6))

      const tampered = ticket.url.replace(/.$/, (value) => (value === 'a' ? 'b' : 'a'))
      assert.equal((await fetch(`${base}${tampered}`)).status, 401)
      const expired = createMediaResultTicket(jwtSecret, '1', queued.id, 1)
      assert.throws(
        () => verifyMediaResultTicket(jwtSecret, expired, queued.id, 15 * 60 + 1),
        /invalid result ticket/,
      )
    } finally {
      browser.closeAllConnections()
      await new Promise<void>((resolve) => browser.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  })

  test('an accepted submit with a lost response is never blindly recomputed after worker loss', async (t) => {
    if (!maybe(t)) return
    const sockets = new Set<Socket>()
    let submitAttempts = 0
    const worker = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        const match = /^\/v1\/attempts\/([^/]+)\/([^/]+)\/(status|submit|ack|cancel)$/.exec(
          req.url ?? '',
        )
        assert.ok(match)
        if (match[3] !== 'submit') {
          res.statusCode = 404
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: 'attempt_not_found' }))
          return
        }
        submitAttempts += 1
        req.socket.destroy()
      })
    })
    worker.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    await new Promise<void>((resolve) => worker.listen(0, '127.0.0.1', resolve))
    const address = worker.address()
    assert.ok(address && typeof address === 'object')
    const runner = new MediaGenerationService({
      workerUrl: `http://127.0.0.1:${address.port}`,
      workerToken: 'test-worker-token-that-is-long-enough',
      allowUserIds: ['1'],
    })
    const queued = await createMediaJob({
      userId: '1',
      requestId: 'ambiguous-submit',
      prompt: 'must not be recomputed',
      options: { durationSeconds: 5, steps: 20 },
    })
    const handle = runner.start(60_000)
    try {
      let failed = await getJob('1', queued.id)
      for (let index = 0; index < 250 && !failed?.workerAckedAt; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        failed = await getJob('1', queued.id)
      }
      assert.equal(failed?.status, 'failed')
      assert.equal(failed?.errorCode, 'worker_lost')
      assert.ok(failed?.submitStartedAt)
      assert.equal(failed?.workerAckPending, false)
      assert.ok(failed?.workerAckedAt)
      assert.equal(submitAttempts, 1)
    } finally {
      await handle.stop()
      for (const socket of sockets) socket.destroy()
      worker.closeAllConnections()
      await new Promise<void>((resolve) => worker.close(() => resolve()))
    }
  })

  test('scheduler shutdown aborts the HTTP wait but leaves the fenced active attempt recoverable', async (t) => {
    if (!maybe(t)) return
    const sockets = new Set<Socket>()
    let submitted = false
    const worker = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        const match = /^\/v1\/attempts\/([^/]+)\/([^/]+)\/(status|submit)$/.exec(req.url ?? '')
        assert.ok(match)
        if (match[3] === 'status' && !submitted) {
          res.statusCode = 404
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: 'attempt_not_found' }))
          return
        }
        if (match[3] === 'submit') {
          submitted = true
          res.setHeader('content-type', 'application/json')
          res.end(
            JSON.stringify({
              job_id: match[1],
              attempt_id: match[2],
              fence_version: Number(req.headers['x-fence-version']),
              resource_class: 'gpu-h3',
              status: 'running',
              phase: 'sampling',
              request_digest: 'recoverable-digest',
              current_step: 1,
              total_steps: 20,
              result_sha256: null,
              result_size: null,
              error_code: null,
              error_message: null,
              result_ready: false,
            }),
          )
        }
        // The post-submit status request intentionally stays open until stop()
        // aborts its fetch; this models a healthy long-running generation.
      })
    })
    worker.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    await new Promise<void>((resolve) => worker.listen(0, '127.0.0.1', resolve))
    const address = worker.address()
    assert.ok(address && typeof address === 'object')
    const runner = new MediaGenerationService({
      workerUrl: `http://127.0.0.1:${address.port}`,
      workerToken: 'test-worker-token-that-is-long-enough',
      allowUserIds: ['1'],
    })
    const job = await createMediaJob({
      userId: '1',
      requestId: 'recoverable-stop',
      prompt: 'long generation',
      options: { durationSeconds: 15, steps: 20 },
    })
    const handle = runner.start(60_000)
    try {
      await handle.runNow()
      let active = await getJob('1', job.id)
      for (
        let index = 0;
        index < 100 && active?.requestDigest !== 'recoverable-digest';
        index += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        active = await getJob('1', job.id)
      }
      assert.equal(active?.status, 'running')
      const started = Date.now()
      await handle.stop()
      assert.ok(
        Date.now() - started < 1_000,
        'shutdown must detach without waiting for the long job',
      )
      const recoverable = await getJob('1', job.id)
      assert.equal(recoverable?.status, 'running')
      assert.equal(recoverable?.requestDigest, 'recoverable-digest')
    } finally {
      for (const socket of sockets) socket.destroy()
      worker.closeAllConnections()
      await new Promise<void>((resolve) => worker.close(() => resolve()))
    }
  })
})
