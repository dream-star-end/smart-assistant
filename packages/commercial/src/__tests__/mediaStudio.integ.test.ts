/**
 * OCV5-591 A1 media studio on real Postgres (0324_media_studio).
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
 *   5. (0325) catalog audio and licence evidence are site-owned and kept while listed; licence rules
 *      and the user-track rights statement are enforced by the schema.
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdtemp, readFile, readdir } from 'node:fs/promises'
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

describe('media studio store (0324)', () => {
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

  test('project pages never skip rows that share a millisecond or a timestamp', async (t) => {
    if (skip(t)) return
    const store = new StudioStore(getPool())
    const a = await user()
    const ids: string[] = []
    for (const title of ['one', 'two', 'three'])
      ids.push((await store.createProject(a, { title })).id)
    // Codex Sol r1 P2: .123800 and .123400 collapse to the same millisecond; two rows tie exactly.
    await query(
      `UPDATE studio_projects SET updated_at='2026-10-23 01:02:03.123800+00' WHERE id=$1`,
      [ids[0]],
    )
    await query(
      `UPDATE studio_projects SET updated_at='2026-10-23 01:02:03.123400+00' WHERE id = ANY($1::uuid[])`,
      [ids.slice(1)],
    )
    const seen: string[] = []
    let before: string | undefined
    for (let i = 0; i < 5; i++) {
      const page = await store.listProjects(a, { limit: 1, before })
      seen.push(...page.projects.map((p) => p.id))
      if (!page.next) break
      assert.equal('cursor' in page.projects[0]!, false)
      before = page.next
    }
    assert.deepEqual([...seen].sort(), [...ids].sort())
    assert.equal(seen[0], ids[0])
    await assert.rejects(store.listProjects(a, { before: '2026-10-23T01:02:03.123Z' }), {
      status: 400,
    })
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

  test('an expired hold is re-admitted at settle; addRef keeps usage while any ref survives', async (t) => {
    if (skip(t)) return
    const root = await mkdtemp(path.join(tmpdir(), 'oc-studio-readmit-'))
    const u = BigInt(await user())
    // holdTtlSeconds 0: the hold is already expired when the write settles (Codex code r1 P1).
    const lapsed = blobStore(root, { holdTtlSeconds: 0 })
    const takeId = randomUUID()
    const put = await lapsed.put({
      userId: u,
      mime: 'image/png',
      maxBytes: 16,
      source: Buffer.from('lapsed hold'),
      ref: { kind: 'take', id: takeId },
    })
    assert.equal(await quota(`u:${u}`), put.bytes)
    assert.equal(await liveHolds(), 0)
    const assetId = randomUUID()
    assert.equal(await lapsed.addRef(u, put.sha, { kind: 'asset', id: assetId }), true)
    await lapsed.dropRefs(u, { kind: 'take', id: takeId })
    assert.equal(await quota(`u:${u}`), put.bytes, 'the asset ref still holds the content')
    await lapsed.dropRefs(u, { kind: 'asset', id: assetId })
    assert.equal(await quota(`u:${u}`), 0)
    assert.equal(await lapsed.addRef(u, put.sha, { kind: 'asset', id: randomUUID() }), false)
  })

  test('a hold that lapses while settle waits on its locks is re-admitted', async (t) => {
    if (skip(t)) return
    const root = await mkdtemp(path.join(tmpdir(), 'oc-studio-lapse-'))
    const u = BigInt(await user())
    await query(`UPDATE studio_quota SET limit_bytes=1000000000 WHERE scope='site'`)
    const a = Buffer.from('a'.repeat(16))
    const shaA = createHash('sha256').update(a).digest('hex')
    // Codex code r2 P1: A's settle transaction begins before its hold expires, then waits on the
    // sha lock until it has; B is admitted in the meantime, so A must be re-checked and refused.
    const locker = await getPool().connect()
    try {
      await locker.query('BEGIN')
      await locker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`studio-blob:${shaA}`])
      const short = blobStore(root, { holdTtlSeconds: 1, userLimitBytes: 16n })
      const pending = short.put({
        userId: u,
        mime: 'image/png',
        maxBytes: 16,
        source: a,
        ref: { kind: 'take', id: randomUUID() },
      })
      pending.catch(() => {})
      for (let i = 0; i < 100; i++) {
        const w = await query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted`,
        )
        if (w.rows[0]!.n !== '0') break
        await new Promise((r) => setTimeout(r, 20))
      }
      await new Promise((r) => setTimeout(r, 1300))
      const b = await blobStore(root, { userLimitBytes: 16n }).put({
        userId: u,
        mime: 'image/png',
        maxBytes: 16,
        source: Buffer.from('b'.repeat(16)),
        ref: { kind: 'take', id: randomUUID() },
      })
      assert.equal(await quota(`u:${u}`), b.bytes)
      await locker.query('COMMIT')
      await assert.rejects(
        pending,
        (e: unknown) => e instanceof StudioQuotaError && e.scope === 'user',
      )
    } finally {
      await locker.query('ROLLBACK').catch(() => {})
      locker.release()
    }
    assert.equal(await quota(`u:${u}`), 16)
    assert.equal(await liveHolds(), 0)
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

describe('media studio music catalog (0325, OCV5-591 M1)', () => {
  async function catalogRow(over: Record<string, unknown> = {}) {
    const root = await mkdtemp(path.join(tmpdir(), 'oc-studio-cat-'))
    const blobs = blobStore(root)
    const audio = await blobs.putSite(Buffer.from(`ID3 audio ${randomUUID()}`), 'audio/mpeg')
    const evidence = await blobs.putSite(Buffer.from(`PNG snapshot ${randomUUID()}`), 'image/png')
    const row = {
      license: 'CC-BY-4.0',
      attribution_required: true,
      attribution_text: '"Snowfield" by Example, CC BY 4.0',
      active: true,
      retired_reason: null,
      ...over,
    }
    const id = randomUUID()
    await query(
      `INSERT INTO studio_music_catalog(id, title, artist, source, source_track_id, landing_url, license,
         license_url, attribution_required, attribution_text, duration_ms, bpm, moods, genres, blob_sha,
         mime, evidence_sha, evidence, verified_at, verified_by, active, retired_reason)
       VALUES ($1, 'Snowfield', 'Example', 'openverse', $2, 'https://example.org/t/1', $3,
         'https://creativecommons.org/licenses/by/4.0/', $4, $5, 52000, 72, '{calm,warm}', '{piano}', $6,
         'audio/mpeg', $7, '{"licenseTextSeen":"CC BY 4.0"}'::jsonb, NOW(), 'claude', $8, $9)`,
      [
        id,
        id,
        row.license,
        row.attribution_required,
        row.attribution_text,
        audio,
        evidence,
        row.active,
        row.retired_reason,
      ],
    )
    return { id, blobs, audio, evidence }
  }

  test('catalog audio and evidence are site-owned: counted once, never collected while listed', async (t) => {
    if (skip(t)) return
    const { id, blobs, audio, evidence } = await catalogRow()
    const site = await quota('site')
    assert.ok(site > 0)
    // The same content again is stored and counted once.
    const content = await readFile(blobs.blobPath(audio))
    assert.equal(await blobs.putSite(content, 'audio/mpeg'), audio)
    assert.equal(await quota('site'), site)
    await query("UPDATE studio_blobs SET created_at = NOW() - INTERVAL '2 hours'")
    assert.equal(await blobs.gc(), 0, 'no user ref, but the catalog holds both blobs')
    await query(
      `UPDATE studio_music_catalog SET active = FALSE, retired_reason = 'source changed' WHERE id = $1`,
      [id],
    )
    assert.equal(await blobs.gc(), 0, 'a retired row is still licence evidence')
    await query('DELETE FROM studio_music_catalog WHERE id = $1', [id])
    assert.equal(await blobs.gc(), 2)
    await assert.rejects(access(blobs.blobPath(audio)))
    await assert.rejects(access(blobs.blobPath(evidence)))
    assert.equal(await quota('site'), 0)
  })

  test('licence rules are enforced by the schema', async (t) => {
    if (skip(t)) return
    await assert.rejects(
      catalogRow({ attribution_text: '' }),
      /check/i,
      'CC BY needs its attribution text',
    )
    await assert.rejects(
      catalogRow({ attribution_required: false }),
      /check/i,
      'CC BY always requires attribution',
    )
    await assert.rejects(
      catalogRow({ license: 'CC0-1.0', attribution_required: true }),
      /check/i,
      'CC0 never requires attribution',
    )
    await assert.rejects(
      catalogRow({ license: 'CC-BY-NC-4.0' }),
      /check/i,
      'non-commercial licences are refused',
    )
    await assert.rejects(catalogRow({ active: false }), /check/i, 'retiring needs a reason')
    const ok = await catalogRow({
      license: 'CC0-1.0',
      attribution_required: false,
      attribution_text: '',
    })
    assert.ok(ok.id)
  })

  test('a user track needs the rights statement', async (t) => {
    if (skip(t)) return
    const uid = await user()
    const insert = (statement: unknown) =>
      query(
        `INSERT INTO studio_user_tracks(id, user_id, title, blob_sha, mime, rights_statement)
         VALUES ($1, $2, 'demo', $3, 'audio/mpeg', $4::jsonb)`,
        [randomUUID(), uid, 'a'.repeat(64), JSON.stringify(statement)],
      )
    await assert.rejects(insert({}), /check/i)
    await assert.rejects(insert({ statement: 'yes' }), /check/i)
    await insert({ statement: 'own_or_licensed', acceptedAt: '2026-10-23T00:00:00Z' })
  })
})
