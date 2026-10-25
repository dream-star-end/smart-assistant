/**
 * OCV5-591 M1 music sources on real Postgres (0329), through the real registry and adapters:
 *
 *   1. catalog search filters (text, moods, BPM, duration) and says when BPM / moods are a guess;
 *      only active rows are found or previewed.
 *   2. choosing a catalog track queues a free music take; running it gives the user their own ref to
 *      the audio, stores the licence snapshot on the take and makes it the project's soundtrack.
 *   3. My Music is per user: another user's track id fails; the owner's track becomes the take.
 *   4. the music edit is validated before it is stored.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'

import { closePool, createPool, getPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'
import { StudioBlobStore } from '../media-studio/blobs.js'
import { type ExecuteDeps, executeTask } from '../media-studio/orchestrator/execute.js'
import { makeOrchestratorApi } from '../media-studio/orchestrator/service.js'
import { BUILTIN_ADAPTERS } from '../media-studio/providers/adapters/index.js'
import { createProviderRegistry } from '../media-studio/providers/registry.js'
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
    [`m${randomUUID().slice(0, 8)}@t.local`],
  )
  return r.rows[0]!.id
}

async function setup() {
  const blobs = new StudioBlobStore({
    pool: getPool(),
    root: await mkdtemp(path.join(tmpdir(), 'oc-studio-music-')),
    freeBytes: async () => 100n * 1024n ** 3n,
  })
  const providers = createProviderRegistry({
    entries: null,
    factories: BUILTIN_ADAPTERS,
    deps: {
      pool: getPool(),
      music: {
        pool: getPool(),
        readCatalog: async (sha) => {
          const f = await blobs.openCatalog(sha)
          return f ? readFile(f.path) : null
        },
      },
    },
    warn: () => {},
  })
  const exec: ExecuteDeps = { pool: getPool(), blobs, providers, systemVoices: async () => [] }
  const api = makeOrchestratorApi(getPool(), () => {}, { pool: getPool(), providers })
  return { blobs, providers, exec, api }
}

async function catalogTrack(
  blobs: StudioBlobStore,
  over: {
    title: string
    bpm: number | null
    moods: string[]
    seconds: number
    guessed?: boolean
    active?: boolean
  },
) {
  const audio = await blobs.putSite(Buffer.from(`ID3 ${over.title} ${randomUUID()}`), 'audio/mpeg')
  const evidence = await blobs.putSite(
    Buffer.from(`PNG ${over.title} ${randomUUID()}`),
    'image/png',
  )
  const id = randomUUID()
  await query(
    `INSERT INTO studio_music_catalog(id, title, artist, source, source_track_id, landing_url, license, license_url,
       attribution_required, attribution_text, duration_ms, bpm, moods, genres, blob_sha, mime, evidence_sha, evidence,
       verified_at, verified_by, active, retired_reason)
     VALUES ($1, $2, 'Kevin MacLeod', 'incompetech', $12, 'https://incompetech.com/x', 'CC-BY-4.0',
       'https://creativecommons.org/licenses/by/4.0/', TRUE, $3, $4, $5, $6, '{piano}', $7, 'audio/mpeg', $8, $9::jsonb,
       NOW(), 'claude', $10, $11)`,
    [
      id,
      over.title,
      `"${over.title}" Kevin MacLeod (incompetech.com)`,
      over.seconds * 1000,
      over.bpm,
      over.moods,
      audio,
      evidence,
      JSON.stringify({
        metadataConfidence: over.guessed
          ? { bpm: 'unknown', moods: 'guessed' }
          : { bpm: 'source', moods: 'source' },
      }),
      over.active ?? true,
      over.active === false ? 'source page changed' : null,
      id,
    ],
  )
  return { id, audio }
}

const ALICE = { id: '' }

describe('studio music sources (OCV5-591 M1)', () => {
  test('catalog search filters, flags guessed metadata, never shows retired tracks', async (t) => {
    if (skip(t)) return
    const { blobs, providers } = await setup()
    ALICE.id = await user()
    await catalogTrack(blobs, {
      title: 'Easy Lemon',
      bpm: 82,
      moods: ['宁静', '轻快'],
      seconds: 126,
    })
    await catalogTrack(blobs, {
      title: 'Handel Largo',
      bpm: null,
      moods: ['温暖'],
      seconds: 140,
      guessed: true,
    })
    const gone = await catalogTrack(blobs, {
      title: 'Retired Tune',
      bpm: 90,
      moods: ['宁静'],
      seconds: 100,
      active: false,
    })
    const search = providers.get('music-catalog')!.search!
    const titles = async (q: Parameters<typeof search>[1]) =>
      (await search(ALICE, q)).tracks.map((x) => x.title)

    assert.deepEqual(await titles({}), ['Easy Lemon', 'Handel Largo'])
    assert.deepEqual(await titles({ moods: ['宁静'] }), ['Easy Lemon'])
    assert.deepEqual(await titles({ text: 'lemon' }), ['Easy Lemon'])
    assert.deepEqual(await titles({ text: '温暖' }), ['Handel Largo'], 'mood words match too')
    assert.deepEqual(
      await titles({ bpmMin: 60, bpmMax: 100 }),
      ['Easy Lemon'],
      'unknown BPM is not in a BPM range',
    )
    assert.deepEqual(await titles({ minSec: 130 }), ['Handel Largo'])
    const handel = (await search(ALICE, { text: 'handel' })).tracks[0]!
    assert.deepEqual(handel.metadata, { bpm: 'unknown', moods: 'guessed' })
    assert.equal(handel.attributionRequired, true)
    const page = await search(ALICE, { limit: 1 })
    assert.equal(page.tracks.length, 1)
    assert.deepEqual(await titles({ limit: 1, cursor: page.next! }), ['Handel Largo'])

    assert.ok(await blobs.openCatalog(handel.previewSha), 'active tracks can be previewed')
    assert.equal(await blobs.openCatalog(gone.audio), null, 'retired ones cannot')
  })

  test('choosing a catalog track: free take, licence snapshot, the user’s own ref, the project soundtrack', async (t) => {
    if (skip(t)) return
    const { blobs, exec, api } = await setup()
    const uid = await user()
    const p = await new StudioStore(getPool()).createProject(uid, {})
    const track = await catalogTrack(blobs, {
      title: 'Easy Lemon',
      bpm: 82,
      moods: ['宁静'],
      seconds: 126,
    })

    await assert.rejects(
      api.selectMusic(uid, p.id, { providerId: 'gpt-image', trackId: track.id }),
      {
        status: 400,
      },
    )
    assert.deepEqual(
      await api.selectMusic(uid, p.id, { providerId: 'music-catalog', trackId: track.id }),
      {
        queued: true,
      },
    )
    const [task] = await claimStudioTasks(getPool(), { owner: 'A', limit: 1, museOnline: false })
    assert.ok(task)
    assert.equal(task.reservedCredits, 0n)
    await executeTask(exec, task, new AbortController().signal)

    const take = await query<{
      id: string
      status: string
      cost: string
      sha: string
      license: Record<string, unknown>
    }>(
      `SELECT id::text AS id, status, cost_credits::text AS cost, blob_sha AS sha, meta->'license' AS license
         FROM studio_takes WHERE project_id = $1 AND owner_kind = 'music'`,
      [p.id],
    )
    const row = take.rows[0]!
    assert.deepEqual([row.status, row.cost, row.sha], ['succeeded', '0', track.audio])
    assert.equal(row.license.license, 'CC-BY-4.0')
    assert.equal(row.license.attributionText, '"Easy Lemon" Kevin MacLeod (incompetech.com)')
    assert.ok(
      await blobs.open(BigInt(uid), track.audio),
      'the user now holds their own ref to the audio',
    )
    const s = await query<{ take: string; spent: string }>(
      "SELECT settings->>'musicTakeId' AS take, spent_credits::text AS spent FROM studio_projects WHERE id = $1",
      [p.id],
    )
    assert.deepEqual(s.rows[0], { take: row.id, spent: '0' })
    // The project view carries the licence and track card for the music page (other takes do not).
    const view = (await new StudioStore(getPool()).projectView(uid, p.id))!
    const music = (view.takes as Array<{ id: string }>).find((x) => x.id === row.id) as unknown as {
      music: { license: { attributionText: string }; track: { metadata: unknown } }
    }
    assert.equal(
      music.music.license.attributionText,
      '"Easy Lemon" Kevin MacLeod (incompetech.com)',
    )
    assert.deepEqual(music.music.track.metadata, { bpm: 'source', moods: 'source' })
  })

  test('an older choice finishing last never replaces a newer one (code r1 P1)', async (t) => {
    if (skip(t)) return
    const { blobs, exec, api } = await setup()
    const uid = await user()
    const p = await new StudioStore(getPool()).createProject(uid, {})
    const a = await catalogTrack(blobs, { title: 'Track A', bpm: 80, moods: ['宁静'], seconds: 90 })
    const b = await catalogTrack(blobs, { title: 'Track B', bpm: 90, moods: ['轻快'], seconds: 90 })
    await api.selectMusic(uid, p.id, { providerId: 'music-catalog', trackId: a.id })
    await api.selectMusic(uid, p.id, { providerId: 'music-catalog', trackId: b.id })
    const tasks = await claimStudioTasks(getPool(), { owner: 'A', limit: 2, museOnline: false })
    const byTrack = (id: string) =>
      tasks.find((x) => (x.payload as { request: { trackId: string } }).request.trackId === id)!
    // B (the newer choice) finishes first, then A.
    await executeTask(exec, byTrack(b.id), new AbortController().signal)
    await executeTask(exec, byTrack(a.id), new AbortController().signal)
    const cur = await query<{ sha: string }>(
      `SELECT t.blob_sha AS sha FROM studio_projects p JOIN studio_takes t ON t.id::text = p.settings->>'musicTakeId'
        WHERE p.id = $1`,
      [p.id],
    )
    assert.equal(cur.rows[0]!.sha, b.audio)
  })

  test('My Music is per user', async (t) => {
    if (skip(t)) return
    const { blobs, exec, api, providers } = await setup()
    const owner = await user()
    const other = await user()
    const trackId = randomUUID()
    const stored = await blobs.put({
      userId: BigInt(owner),
      mime: 'audio/mpeg',
      maxBytes: 64,
      source: Buffer.from('ID3 my own tune'),
      ref: { kind: 'upload', id: trackId },
    })
    await new StudioStore(getPool()).addUserTrack(owner, {
      id: trackId,
      title: '我的片头曲',
      blobSha: stored.sha,
      mime: 'audio/mpeg',
      rights: { statement: 'own_or_licensed', acceptedAt: '2026-10-23T00:00:00Z' },
    })
    const mine = providers.get('music-mine')!.search!
    assert.deepEqual(
      (await mine({ id: owner }, {})).tracks.map((x) => x.title),
      ['我的片头曲'],
    )
    assert.deepEqual((await mine({ id: other }, {})).tracks, [])

    const run = async (uid: string) => {
      const p = await new StudioStore(getPool()).createProject(uid, {})
      await api.selectMusic(uid, p.id, { providerId: 'music-mine', trackId })
      const [task] = await claimStudioTasks(getPool(), { owner: 'A', limit: 1, museOnline: false })
      await executeTask(exec, task!, new AbortController().signal)
      const r = await query<{ status: string; code: string | null }>(
        "SELECT status, error_code AS code FROM studio_takes WHERE project_id = $1 AND owner_kind = 'music'",
        [p.id],
      )
      return r.rows[0]
    }
    assert.deepEqual(await run(other), { status: 'failed', code: 'TRACK_UNAVAILABLE' })
    assert.deepEqual(await run(owner), { status: 'succeeded', code: null })
  })

  test('the music edit is validated before it is stored', async (t) => {
    if (skip(t)) return
    const { api } = await setup()
    const uid = await user()
    const p = await new StudioStore(getPool()).createProject(uid, {})
    await assert.rejects(api.setMusicEdit(uid, p.id, { loop: {} }), { status: 400 })
    await assert.rejects(api.setMusicEdit(await user(), p.id, { inSec: 1 }), { status: 404 })
    const edit = await api.setMusicEdit(uid, p.id, {
      inSec: 8,
      outSec: 14,
      loop: { crossfadeSec: 1 },
      duckDb: 12,
    })
    assert.deepEqual(edit, { inSec: 8, outSec: 14, duckDb: 12, loop: { crossfadeSec: 1 } })
    const s = await query<{ edit: unknown }>(
      "SELECT settings->'musicEdit' AS edit FROM studio_projects WHERE id = $1",
      [p.id],
    )
    assert.deepEqual(s.rows[0]!.edit, edit)
  })
})
