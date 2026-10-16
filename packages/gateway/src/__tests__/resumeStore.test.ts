// OCV5-464: ResumeStore (extracted from SessionManager) keeps resume-map.json byte-for-byte.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  CCB_RESUME_HISTORY_CONTEXT_VERSION,
  ResumeStore,
  normalizeEngineTag,
} from '../resumeStore.js'

test('serialize: stored then live entries, fixed field order, live heads adopted', () => {
  const store = new ResumeStore('/dev/null')
  store.ids.set('a', 'id-a')
  store.timestamps.set('a', 100)
  store.lastCost.set('a', 2)
  store.provider.set('a', 'codex')
  store.history.set('a', ['old-a', 'id-a'])
  store.ids.set('b', 'id-b-old')
  store.timestamps.set('b', 50)
  store.history.set('b', ['prior-b'])
  const out = store.serialize(
    [['b', { ccbSessionId: 'id-b', _lastCcbCumulativeCost: 3, costImprecise: true }]],
    999,
  )
  assert.equal(
    out,
    JSON.stringify(
      {
        a: { id: 'id-a', ts: 100, lastCost: 2, provider: 'codex', history: ['old-a'] },
        b: {
          id: 'id-b',
          ts: 999,
          lastCost: 3,
          costImprecise: true,
          historyContextVersion: CCB_RESUME_HISTORY_CONTEXT_VERSION,
          history: ['prior-b'],
        },
      },
      null,
      2,
    ),
  )
  assert.equal(store.ids.get('b'), 'id-b')
  assert.equal(store.timestamps.get('b'), 999)
  assert.equal(store.lastCost.get('b'), 3)
  assert.equal(store.costImprecise.get('b'), true)
})

test('load round-trips what persist wrote; obsolete CCB contexts are dropped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'resume-store-'))
  try {
    const path = join(dir, 'resume-map.json')
    writeFileSync(
      path,
      JSON.stringify({
        legacy: 'plain-string-id',
        oldCcb: { id: 'x', ts: 1 },
        cur: {
          id: 'c',
          ts: 5,
          historyContextVersion: CCB_RESUME_HISTORY_CONTEXT_VERSION,
          history: ['c', 'h1'],
        },
        cdx: { id: 't', ts: 6, provider: 'codex-native', lastCost: 0.5 },
      }),
    )
    const store = new ResumeStore(path)
    store.load()
    assert.deepEqual([...store.ids.keys()].sort(), ['cdx', 'cur'])
    assert.deepEqual(store.history.get('cur'), ['h1'])
    assert.equal(store.provider.get('cdx'), 'codex')
    assert.equal(store.lastCost.get('cdx'), 0.5)
    store.persist(store.serialize([], 7))
    await store.flush()
    const again = new ResumeStore(path)
    again.load()
    assert.deepEqual([...again.ids], [...store.ids])
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).cdx, {
      id: 't',
      ts: 6,
      lastCost: 0.5,
      provider: 'codex',
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('prune drops idle non-live entries through forget and reports their age', () => {
  const store = new ResumeStore('/dev/null')
  for (const [k, ts] of [
    ['live', 0],
    ['old', 1_000],
    ['fresh', 9_000],
    ['unknown', 0],
  ] as const) {
    store.ids.set(k, `id-${k}`)
    if (ts) store.timestamps.set(k, ts)
    store.history.set(k, ['h'])
  }
  const pruned = store.prune((k) => k === 'live', 5_000, 10_000)
  assert.deepEqual(pruned, [
    { key: 'old', ageMs: 9_000 },
    { key: 'unknown', ageMs: null },
  ])
  assert.deepEqual([...store.ids.keys()].sort(), ['fresh', 'live'])
  assert.equal(store.history.has('old'), false)
})

test('rejected ids leave the history ladder and are never pushed back', () => {
  const store = new ResumeStore('/dev/null')
  store.ids.set('k', 'sand-ccb:11111111-1111-1111-1111-111111111111')
  store.pushHistory('k', '22222222-2222-2222-2222-222222222222')
  const marked = store.markRejectedFromError(
    'k',
    'No conversation found with session ID: 22222222-2222-2222-2222-222222222222',
    null,
  )
  assert.deepEqual(marked, ['22222222-2222-2222-2222-222222222222'])
  assert.equal(store.history.has('k'), false)
  store.pushHistory('k', '22222222-2222-2222-2222-222222222222')
  assert.equal(store.history.has('k'), false)
})

test('engine tag normalization is unchanged', () => {
  assert.equal(normalizeEngineTag('codex-native'), 'codex')
  assert.equal(normalizeEngineTag('antigravity'), 'antigravity')
  assert.equal(normalizeEngineTag(undefined), 'ccb')
  assert.equal(normalizeEngineTag('something-else'), 'ccb')
})
