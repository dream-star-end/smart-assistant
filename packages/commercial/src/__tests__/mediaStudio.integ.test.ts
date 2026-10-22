/**
 * OCV5-591 A1 media studio on real Postgres (0323_media_studio).
 *
 *   1. projects are user-scoped: another user's project is not found; optimistic rev; brief only
 *      while draft; budget never below spent + reserved; pause/resume/cancel; cancel and delete
 *      cancel queued tasks.
 *   2. queue: idempotent enqueue; concurrent claims are disjoint; an expired lease is re-claimed with
 *      a new epoch and the stale owner's CAS matches nothing; Muse affinity waits for an online
 *      bridge until its deadline, then any worker claims it for failover only.
 *   3. blobs: content stored once, counted once on 'site' and once per referencing user; user / site
 *      / disk-floor quota refuse without leaking a hold; an oversize stream aborts cleanly; dropRefs
 *      gives bytes back; gc removes unreferenced content and expired holds.
 *   4. the GC tick purges projects soft-deleted more than 7 days ago with their refs.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { access, mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'

import { closePool, createPool, getPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'
import {
  StudioBlobStore,
  StudioBlobTooLargeError,
  StudioQuotaError,
} from '../media-studio/blobs.js'
import { runStudioGc } from '../media-studio/gc.js'
import {
  claimStudioTasks,
  enqueueStudioTask,
  finishStudioTask,
  renewStudioTask,
  retryStudioTask,
} from '../media-studio/queue.js'
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
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }))
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
    'TRUNCATE TABLE studio_projects, studio_blob_refs, studio_blobs, studio_quota, studio_quota_holds, users RESTART IDENTITY CASCADE',
  )
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
    [`s${randomUUID().slice(0, 8)}@t.local`],
  )
  return r.rows[0]!.id
}

async function bytesSource(...parts: string[]): Promise<AsyncIterable<Uint8Array>> {
  return (async function* () {
    for (const p of parts) yield Buffer.from(p)
  })()
}

function blobStore(
  root: string,
  over: Partial<ConstructorParameters<typeof StudioBlobStore>[0]> = {},
) {
  return new StudioBlobStore({
    pool: getPool(),
    root,
    freeBytes: async () => 100n * 1024n ** 3n,
    ...over,
  })
}

async function quota(scope: string): Promise<number> {
  const r = await query<{ used: string }>(
    'SELECT used_bytes::text AS used FROM studio_quota WHERE scope=$1',
    [scope],
  )
  return Number(r.rows[0]?.used ?? 0)
}

async function liveHolds(): Promise<number> {
  const r = await query<{ n: string }>('SELECT COUNT(*)::text AS n FROM studio_quota_holds')
  return Number(r.rows[0]!.n)
}

describe('media studio store (0323)', () => {
  test('projects are user-scoped with optimistic edits and status rules', async (t) => {
    if (skip(t)) return
    const store = new StudioStore(getPool())
    const a = await user()
    const b = await user()
    const p = await store.createProject(a, {
      title: ' Lighthouse ',
      brief: 'storm at dusk',
      targetSec: 15,
    })
    assert.equal(p.title, 'Lighthouse')
    assert.equal(p.status, 'draft')
    assert.equal(p.budgetCredits, '2000')
    assert.equal(await store.getProject(b, p.id), null)
    assert.equal(await store.projectView(b, p.id), null)
    await assert.rejects(store.updateProject(b, p.id, p.rev, { title: 'x' }), { status: 404 })
    await assert.rejects(store.updateProject(a, p.id, p.rev + 1, { title: 'x' }), {
      status: 409,
      code: 'STUDIO_REV_CONFLICT',
    })
    const edited = await store.updateProject(a, p.id, p.rev, {
      brief: 'calm sea',
      budgetCredits: 900,
    })
    assert.equal(edited.brief, 'calm sea')
    assert.equal(edited.rev, p.rev + 1)
    await assert.rejects(store.updateProject(a, p.id, edited.rev, { aspect: '4:3' }), {
      status: 400,
    })

    await query(
      "UPDATE studio_projects SET status='running', spent_credits=500, reserved_credits=300 WHERE id=$1",
      [p.id],
    )
    const running = (await store.getProject(a, p.id))!
    await assert.rejects(store.updateProject(a, p.id, running.rev, { brief: 'late' }), {
      code: 'STUDIO_NOT_DRAFT',
    })
    await assert.rejects(store.updateProject(a, p.id, running.rev, { budgetCredits: 700 }), {
      code: 'STUDIO_BUDGET_BELOW_SPENT',
    })
    assert.equal(
      (await store.updateProject(a, p.id, running.rev, { budgetCredits: 800 })).budgetCredits,
      '800',
    )

    const queued = await enqueueStudioTask(getPool(), {
      projectId: p.id,
      kind: 'shot.frame',
      idempotencyKey: `${p.id}:f1`,
    })
    assert.equal((await store.transition(a, p.id, 'pause')).status, 'paused')
    assert.equal((await store.transition(a, p.id, 'resume')).status, 'running')
    await assert.rejects(store.transition(a, p.id, 'resume'), { code: 'STUDIO_BAD_TRANSITION' })
    assert.equal((await store.transition(a, p.id, 'cancel')).status, 'canceled')
    const task = await query<{ status: string }>('SELECT status FROM studio_tasks WHERE id=$1', [
      queued.id,
    ])
    assert.equal(task.rows[0]!.status, 'canceled')

    await store.deleteProject(a, p.id)
    assert.equal((await store.listProjects(a)).projects.length, 0)
    await assert.rejects(store.deleteProject(a, p.id), { status: 404 })
    const events = await query<{ type: string }>(
      'SELECT type FROM studio_events WHERE project_id=$1 ORDER BY id',
      [p.id],
    )
    assert.deepEqual(
      events.rows.map((e) => e.type),
      [
        'project.created',
        'project.updated',
        'project.updated',
        'project.paused',
        'project.resumed',
        'project.canceled',
        'project.deleted',
      ],
    )
  })

  test('credit_ledger accepts the media_studio reason', async (t) => {
    if (skip(t)) return
    const def = await query<{ d: string }>(
      "SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='credit_ledger_reason_check'",
    )
    assert.match(def.rows[0]!.d, /'media_studio'/)
    assert.match(def.rows[0]!.d, /'muse_media'/)
  })
})

describe('media studio queue', () => {
  test('lease + epoch claims, stale owners lose, idempotent enqueue', async (t) => {
    if (skip(t)) return
    const store = new StudioStore(getPool())
    const p = await store.createProject(await user(), {})
    const first = await enqueueStudioTask(getPool(), {
      projectId: p.id,
      kind: 'shot.frame',
      idempotencyKey: 'k1',
    })
    const again = await enqueueStudioTask(getPool(), {
      projectId: p.id,
      kind: 'shot.frame',
      idempotencyKey: 'k1',
    })
    assert.equal(again.id, first.id)
    assert.equal(again.created, false)
    for (let i = 2; i <= 6; i++)
      await enqueueStudioTask(getPool(), {
        projectId: p.id,
        kind: 'shot.frame',
        idempotencyKey: `k${i}`,
      })

    const [ca, cb] = await Promise.all([
      claimStudioTasks(getPool(), { owner: 'A', limit: 4, museOnline: false }),
      claimStudioTasks(getPool(), { owner: 'B', limit: 4, museOnline: false }),
    ])
    const ids = [...ca, ...cb].map((x) => x.id)
    assert.equal(ids.length, 6)
    assert.equal(new Set(ids).size, 6)
    const one = ca[0] ?? cb[0]!
    assert.equal(one.execRequestId, `studio:${one.id}`)
    assert.equal(one.attempts, 1)

    await query("UPDATE studio_tasks SET lease_until=NOW() - INTERVAL '1 second' WHERE id=$1", [
      one.id,
    ])
    const [stolen] = await claimStudioTasks(getPool(), { owner: 'C', limit: 1, museOnline: false })
    assert.equal(stolen!.id, one.id)
    assert.equal(stolen!.epoch, one.epoch + 1)
    assert.equal(stolen!.execRequestId, one.execRequestId)
    assert.equal(await renewStudioTask(getPool(), one), false)
    assert.equal(await finishStudioTask(getPool(), one, { status: 'done' }), false)
    assert.equal(
      await retryStudioTask(getPool(), stolen!, { delaySeconds: 3600, error: 'busy' }),
      true,
    )
    assert.equal(
      (await claimStudioTasks(getPool(), { owner: 'C', limit: 4, museOnline: false })).length,
      0,
    )
  })

  test('muse affinity waits for an online bridge, then fails over after its deadline', async (t) => {
    if (skip(t)) return
    const store = new StudioStore(getPool())
    const p = await store.createProject(await user(), {})
    const task = await enqueueStudioTask(getPool(), {
      projectId: p.id,
      kind: 'shot.video',
      idempotencyKey: 'v1',
      affinity: 'muse',
    })
    assert.equal((await claimStudioTasks(getPool(), { owner: 'B', museOnline: false })).length, 0)
    const [served] = await claimStudioTasks(getPool(), { owner: 'A', museOnline: true })
    assert.equal(served!.id, task.id)
    assert.equal(served!.failover, false)
    await retryStudioTask(getPool(), served!, { delaySeconds: 0, error: 'again' })
    await query(
      "UPDATE studio_tasks SET affinity_deadline=NOW() - INTERVAL '1 second' WHERE id=$1",
      [task.id],
    )
    const [failover] = await claimStudioTasks(getPool(), { owner: 'B', museOnline: false })
    assert.equal(failover!.id, task.id)
    assert.equal(failover!.failover, true)
  })
})

describe('media studio blobs', () => {
  test('content is stored once and counted per site and per referencing user', async (t) => {
    if (skip(t)) return
    const root = await mkdtemp(path.join(tmpdir(), 'oc-studio-blobs-'))
    const blobs = blobStore(root)
    const a = BigInt(await user())
    const b = BigInt(await user())
    const r1 = randomUUID()
    const put1 = await blobs.put({
      userId: a,
      mime: 'image/png',
      maxBytes: 64,
      source: Buffer.from('hello world'),
      ref: { kind: 'upload', id: r1 },
    })
    assert.equal(put1.bytes, 11)
    assert.equal(put1.newForUser, true)
    const put2 = await blobs.put({
      userId: a,
      mime: 'image/png',
      maxBytes: 64,
      source: await bytesSource('hello ', 'world'),
      ref: { kind: 'take', id: randomUUID() },
    })
    assert.equal(put2.sha, put1.sha)
    assert.equal(put2.newForUser, false)
    const put3 = await blobs.put({
      userId: b,
      mime: 'image/png',
      maxBytes: 64,
      source: Buffer.from('hello world'),
      ref: { kind: 'upload', id: randomUUID() },
    })
    assert.equal(put3.newForUser, true)
    assert.equal(await quota('site'), 11)
    assert.equal(await quota(`u:${a}`), 11)
    assert.equal(await quota(`u:${b}`), 11)
    assert.equal(await liveHolds(), 0)
    await access(blobs.blobPath(put1.sha))
    assert.deepEqual(await readdir(path.join(root, 'tmp')), [])

    assert.ok(await blobs.open(a, put1.sha))
    assert.equal(await blobs.open(BigInt(await user()), put1.sha), null)

    assert.equal(await blobs.dropRefs(a, { kind: 'upload', id: r1 }), 1)
    assert.equal(await quota(`u:${a}`), 11, 'a still references the content through the take')
    assert.equal(
      await blobs.addRef(BigInt(await user()), put1.sha, { kind: 'asset', id: randomUUID() }),
      false,
    )
  })

  test('quota and disk floor refuse without leaking holds; oversize streams abort', async (t) => {
    if (skip(t)) return
    const root = await mkdtemp(path.join(tmpdir(), 'oc-studio-quota-'))
    const a = BigInt(await user())
    const small = blobStore(root, { userLimitBytes: 20n, siteLimitBytes: 30n })
    await small.put({
      userId: a,
      mime: 'audio/mpeg',
      maxBytes: 15,
      source: Buffer.from('x'.repeat(15)),
      ref: { kind: 'take', id: randomUUID() },
    })
    await assert.rejects(
      small.put({
        userId: a,
        mime: 'audio/mpeg',
        maxBytes: 10,
        source: Buffer.from('y'.repeat(10)),
        ref: { kind: 'take', id: randomUUID() },
      }),
      (e: unknown) => e instanceof StudioQuotaError && e.scope === 'user',
    )
    const b = BigInt(await user())
    await small.put({
      userId: b,
      mime: 'audio/mpeg',
      maxBytes: 12,
      source: Buffer.from('z'.repeat(12)),
      ref: { kind: 'take', id: randomUUID() },
    })
    await assert.rejects(
      small.put({
        userId: b,
        mime: 'audio/mpeg',
        maxBytes: 5,
        source: Buffer.from('w'.repeat(5)),
        ref: { kind: 'take', id: randomUUID() },
      }),
      (e: unknown) => e instanceof StudioQuotaError && e.scope === 'site',
    )
    // Quota rows keep the limits they were created with; widen them for the remaining checks.
    await query('UPDATE studio_quota SET limit_bytes=1000000')
    const disk = blobStore(root, { freeBytes: async () => 2n * 1024n ** 3n + 3n })
    await assert.rejects(
      disk.put({
        userId: b,
        mime: 'audio/mpeg',
        maxBytes: 4,
        source: Buffer.from('dddd'),
        ref: { kind: 'take', id: randomUUID() },
      }),
      (e: unknown) => e instanceof StudioQuotaError && e.scope === 'disk',
    )
    const roomy = blobStore(root)
    await assert.rejects(
      roomy.put({
        userId: b,
        mime: 'audio/mpeg',
        maxBytes: 4,
        source: await bytesSource('abc', 'def'),
        ref: { kind: 'take', id: randomUUID() },
      }),
      StudioBlobTooLargeError,
    )
    assert.equal(await liveHolds(), 0)
    assert.deepEqual(await readdir(path.join(root, 'tmp')), [])

    // A crashed writer's hold counts until it expires, then GC removes it.
    const hold = await roomy.hold(a, 1000)
    await query('UPDATE studio_quota SET limit_bytes=1020 WHERE scope=$1', [`u:${a}`])
    await assert.rejects(
      roomy.hold(a, 10),
      (e: unknown) => e instanceof StudioQuotaError && e.scope === 'user',
    )
    await query(
      "UPDATE studio_quota_holds SET expires_at=NOW() - INTERVAL '1 second' WHERE id=$1",
      [hold],
    )
    await roomy.hold(a, 10)
    await roomy.gc()
    assert.equal(await liveHolds(), 1)
  })

  test('gc deletes unreferenced content and the GC tick purges old deleted projects', async (t) => {
    if (skip(t)) return
    const root = await mkdtemp(path.join(tmpdir(), 'oc-studio-gc-'))
    const blobs = blobStore(root)
    const store = new StudioStore(getPool())
    const uid = await user()
    const p = await store.createProject(uid, {})
    const assetId = randomUUID()
    const stored = await blobs.put({
      userId: BigInt(uid),
      mime: 'image/png',
      maxBytes: 32,
      source: Buffer.from('reference image'),
      ref: { kind: 'upload', id: assetId },
    })
    await store.addUploadAsset(uid, p.id, {
      assetId,
      name: 'ref.png',
      blobSha: stored.sha,
      mime: 'image/png',
      bytes: stored.bytes,
    })
    await store.deleteProject(uid, p.id)
    let out = await runStudioGc({ pool: getPool(), blobs })
    assert.equal(out.projects, 0, 'kept for 7 days after soft delete')
    await query("UPDATE studio_projects SET deleted_at=NOW() - INTERVAL '8 days' WHERE id=$1", [
      p.id,
    ])
    out = await runStudioGc({ pool: getPool(), blobs })
    assert.equal(out.projects, 1)
    assert.equal(await quota(`u:${uid}`), 0)
    assert.equal(out.blobs, 0, 'unreferenced content waits out its grace period')
    await query("UPDATE studio_blobs SET created_at=NOW() - INTERVAL '2 hours'")
    out = await runStudioGc({ pool: getPool(), blobs })
    assert.equal(out.blobs, 1)
    assert.equal(await quota('site'), 0)
    await assert.rejects(access(blobs.blobPath(stored.sha)))
  })
})
