import assert from 'node:assert/strict'
import test from 'node:test'
import { LiteratureArtifactStore, type StagedLiteratureArtifact } from './artifactStore.js'
import { LiteratureError } from './errors.js'

/** Minimal valid PDF padded to roughly `bytes` (a stream object carries the padding). */
function pdfOfSize(bytes: number, tag = 'x'): Buffer {
  const header = '%PDF-1.4\n'
  const obj1 = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'
  const obj2 = '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'
  const obj3 = '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n'
  const pad = Math.max(0, bytes - 400)
  const data = tag.repeat(pad).slice(0, pad)
  const obj4 = `4 0 obj\n<< /Length ${data.length} >>\nstream\n${data}\nendstream\nendobj\n`
  const trailer = 'trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n'
  return Buffer.from(header + obj1 + obj2 + obj3 + obj4 + trailer, 'latin1')
}

const MiB = 1024 * 1024
const signal = new AbortController().signal

async function stageAndPublish(
  store: LiteratureArtifactStore,
  userId: number,
  data: Buffer,
  reuseKey?: string,
): Promise<StagedLiteratureArtifact> {
  const staged = await store.stagePdf({
    userId,
    filename: `paper-${userId}.pdf`,
    data,
    signal,
    ...(reuseKey ? { reuseKey } : {}),
  })
  staged.publish()
  return staged
}

function capacityError(err: unknown): boolean {
  return err instanceof LiteratureError && err.code === 'LITERATURE_ARTIFACT_CAPACITY'
}

test('default store lets one user stage a third and later PDFs within ten minutes (was 2 slots per user)', async () => {
  const store = new LiteratureArtifactStore()
  const ids: string[] = []
  for (let i = 0; i < 6; i++) {
    const staged = await stageAndPublish(store, 7, pdfOfSize(2.4 * MiB, String(i)))
    ids.push(staged.artifactId)
  }
  for (const id of ids) assert(store.read(7, id), 'every staged PDF is still readable')
})

test('default store serves a fifth unexpired PDF across users in the same process (was 4 slots per process)', async () => {
  const store = new LiteratureArtifactStore()
  const staged: Array<{ user: number; id: string }> = []
  for (let user = 1; user <= 5; user++) {
    const s = await stageAndPublish(store, user, pdfOfSize(2 * MiB, String(user)))
    staged.push({ user, id: s.artifactId })
  }
  for (const item of staged) assert(store.read(item.user, item.id))
})

test('budget is counted in real bytes, saved PDFs are evicted first, and other users’ unsaved PDFs are never evicted', async () => {
  let now = 1_700_000_000_000
  const store = new LiteratureArtifactStore({
    now: () => now,
    maxTotalBytes: 10 * MiB,
    maxUserBytes: 5 * MiB,
    maxUserFiles: 16,
  })
  const otherUser = await stageAndPublish(store, 2, pdfOfSize(4 * MiB, 'o'))
  now += 1000
  const first = await stageAndPublish(store, 1, pdfOfSize(3 * MiB, 'a'))
  now += 1000
  // Saving (owner GET) marks the first file as delivered: it is the first eviction candidate.
  assert(store.read(1, first.artifactId))
  now += 1000
  const second = await stageAndPublish(store, 1, pdfOfSize(3 * MiB, 'b'))
  assert.equal(store.describe(1, first.artifactId), null, 'saved PDF made room')
  assert(store.describe(1, second.artifactId))
  assert(store.describe(2, otherUser.artifactId), 'other user’s unsaved PDF survives')

  // Total budget: 4 (user 2, unsaved) + 3 (user 1, unsaved) = 7 MiB of 10. User 3 wants 4 MiB.
  // Nothing evictable belongs to user 3 and nobody's file is saved → explicit capacity error.
  await assert.rejects(stageAndPublish(store, 3, pdfOfSize(4 * MiB, 'c')), capacityError)
  assert(store.describe(2, otherUser.artifactId))
  assert(store.describe(1, second.artifactId))
})

test('a user over their own budget rotates out their oldest unsaved PDF instead of failing', async () => {
  let now = 1_700_000_000_000
  const store = new LiteratureArtifactStore({ now: () => now, maxUserFiles: 3 })
  const ids: string[] = []
  for (let i = 0; i < 4; i++) {
    now += 1000
    ids.push((await stageAndPublish(store, 9, pdfOfSize(64 * 1024, String(i)))).artifactId)
  }
  assert.equal(store.describe(9, ids[0]!), null)
  for (const id of ids.slice(1)) assert(store.describe(9, id))
})

test('repeated download of the same paper reuses the verified file and takes no new slot', async () => {
  let now = 1_700_000_000_000
  const store = new LiteratureArtifactStore({ now: () => now, maxUserFiles: 2 })
  const first = await stageAndPublish(store, 5, pdfOfSize(128 * 1024), 'key-same-paper')
  now += 60_000
  const again = store.reuse(5, 'key-same-paper')
  assert(again, 'same owner + same key finds the published file')
  assert.equal(again.artifactId, first.artifactId)
  assert.equal(again.reused, true)
  again.publish()
  assert.equal(store.reuse(6, 'key-same-paper'), null, 'other owners never reuse')
  assert.equal(store.reuse(5, 'key-other-paper'), null)
  // Reuse refreshes the expiry of the same file.
  assert.equal(store.describe(5, first.artifactId)?.expiresAt, again.expiresAt)
  // A discarded reuse handle (post-CAS failure) must not delete the earlier published file.
  store.reuse(5, 'key-same-paper')?.discard()
  assert(store.read(5, first.artifactId))
  // Only one file is held for the user, so a second distinct paper still fits.
  await stageAndPublish(store, 5, pdfOfSize(128 * 1024, 'z'), 'key-other-paper')
  assert(store.describe(5, first.artifactId))
})

test('describe exposes expiresAt without marking delivery; expired files disappear', async () => {
  let now = 1_700_000_000_000
  const store = new LiteratureArtifactStore({ now: () => now, ttlMs: 30 * 60_000 })
  const staged = await stageAndPublish(store, 4, pdfOfSize(64 * 1024))
  assert.equal(staged.expiresAt, now + 30 * 60_000)
  const meta = store.describe(4, staged.artifactId)
  assert.deepEqual(meta && { expiresAt: meta.expiresAt, saved: meta.saved }, {
    expiresAt: now + 30 * 60_000,
    saved: false,
  })
  assert.equal(store.describe(5, staged.artifactId), null, 'owner scoped')
  now += 30 * 60_000
  assert.equal(store.describe(4, staged.artifactId), null)
  assert.equal(store.read(4, staged.artifactId), null)
})

test('store events report saves, evictions and unsaved expiry without ids', async () => {
  let now = 1_700_000_000_000
  const events: Array<Record<string, unknown>> = []
  const store = new LiteratureArtifactStore({
    now: () => now,
    ttlMs: 1000,
    maxUserFiles: 1,
    onEvent: (e) => events.push({ ...e }),
  })
  const a = await stageAndPublish(store, 3, pdfOfSize(64 * 1024, 'a'))
  assert(store.read(3, a.artifactId))
  await stageAndPublish(store, 3, pdfOfSize(64 * 1024, 'b'))
  now += 5000
  store.read(3, 'ffffffffffffffff-unknown')
  assert.deepEqual(
    events.map((e) => [e.event, e.reason ?? e.outcome ?? null]),
    [
      ['get', 'ok'],
      ['evict', 'saved'],
      ['expire', 'unsaved'],
      ['get', 'not_found'],
    ],
  )
  for (const e of events) {
    assert.equal('artifactId' in e, false)
    assert.equal(e.uid, 3)
  }
})

test('a reused file waiting for the account commit is neither evicted nor swept before publish', async () => {
  let now = 1_700_000_000_000
  const store = new LiteratureArtifactStore({
    now: () => now,
    ttlMs: 60_000,
    maxTotalFiles: 2,
  })
  const a = await stageAndPublish(store, 1, pdfOfSize(64 * 1024, 'a'), 'paper-a')
  assert(store.read(1, a.artifactId), 'saved, so normally the first eviction candidate')
  const handle = store.reuse(1, 'paper-a')
  assert(handle)
  // While user 1 commits, user 2 fills the process budget: the pinned file must survive.
  await stageAndPublish(store, 2, pdfOfSize(64 * 1024, 'b'))
  await assert.rejects(stageAndPublish(store, 3, pdfOfSize(64 * 1024, 'c')), capacityError)
  // The original TTL passes during the commit: still not swept.
  now += 61_000
  store.describe(2, 'ffffffffffffffff-unknown')
  handle.publish()
  assert(store.read(1, handle.artifactId), 'the reported artifactId is readable after publish')
  // After publish the pin is gone, so the (saved again) file is evictable as usual.
  await stageAndPublish(store, 2, pdfOfSize(64 * 1024, 'd'))
  await stageAndPublish(store, 3, pdfOfSize(64 * 1024, 'c'))
  assert.equal(store.describe(1, handle.artifactId), null)
})

test('a discarded reuse handle releases its pin', async () => {
  const store = new LiteratureArtifactStore({ maxTotalFiles: 1 })
  const a = await stageAndPublish(store, 1, pdfOfSize(64 * 1024, 'a'), 'paper-a')
  assert(store.read(1, a.artifactId))
  store.reuse(1, 'paper-a')?.discard()
  await stageAndPublish(store, 2, pdfOfSize(64 * 1024, 'b'))
  assert.equal(store.describe(1, a.artifactId), null)
})
