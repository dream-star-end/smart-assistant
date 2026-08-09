import assert from 'node:assert/strict'
import test from 'node:test'

import { DownloadRegistry, taskbarProgressState } from '../src/download-registry.mjs'

function registryWithIds(ids, options = {}) {
  let index = 0
  return new DownloadRegistry({
    randomUUID: () => ids[index++],
    now: () => 1000 + index,
    ...options,
  })
}

test('DownloadRegistry exposes opaque ids and never exposes registered paths', () => {
  const registry = registryWithIds(['11111111-1111-4111-8111-111111111111'])
  const id = registry.register({ fileName: 'report.pdf', totalBytes: 200 })
  registry.update(id, { receivedBytes: 100 })
  registry.complete(id, { filePath: 'C:\\Users\\dx\\Downloads\\report.pdf', receivedBytes: 200 })

  assert.equal(registry.resolveCompletedPath(id), 'C:\\Users\\dx\\Downloads\\report.pdf')
  assert.deepEqual(registry.list(), [
    {
      id,
      fileName: 'report.pdf',
      receivedBytes: 200,
      totalBytes: 200,
      state: 'completed',
      createdAt: 1001,
      updatedAt: 1001,
    },
  ])
  assert.equal('filePath' in registry.list()[0], false)
  assert.equal('completedPath' in registry.list()[0], false)
})

test('resolveCompletedPath requires both completed state and a registered path', () => {
  const registry = registryWithIds([
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ])
  const active = registry.register({ fileName: 'active.zip' })
  const pathless = registry.register({ fileName: 'pathless.zip' })
  assert.equal(registry.resolveCompletedPath(active), null)
  registry.complete(pathless)
  assert.equal(registry.resolveCompletedPath(pathless), null)
  registry.fail(active, 'cancelled')
  assert.equal(registry.resolveCompletedPath(active), null)
  assert.equal(registry.resolveCompletedPath('missing'), null)
})

test('DownloadRegistry keeps at most 20 records and evicts oldest terminal work first', () => {
  const registry = registryWithIds(
    [
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    ],
    { maxEntries: 3 },
  )
  const first = registry.register({ fileName: 'first' })
  const terminal = registry.register({ fileName: 'terminal' })
  registry.fail(terminal)
  registry.register({ fileName: 'third' })
  registry.register({ fileName: 'fourth' })

  const ids = registry.list().map((entry) => entry.id)
  assert.equal(ids.length, 3)
  assert.equal(ids.includes(first), true)
  assert.equal(ids.includes(terminal), false)
})

test('DownloadRegistry rejects invalid or duplicate generated ids', () => {
  const invalid = registryWithIds(['../not-opaque'])
  assert.throws(() => invalid.register({ fileName: 'bad' }), /invalid or duplicate/)

  const duplicate = registryWithIds([
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  ])
  duplicate.register({ fileName: 'one' })
  assert.throws(() => duplicate.register({ fileName: 'two' }), /invalid or duplicate/)
})

test('DownloadRegistry sanitizes display metadata and terminal failure state', () => {
  const registry = registryWithIds(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'])
  const id = registry.register({ fileName: '\u0000\u0007  ', totalBytes: -1 })
  assert.equal(registry.list()[0].fileName, 'download')
  assert.equal(registry.list()[0].totalBytes, 0)
  assert.equal(registry.fail(id, 'unknown'), null)
  assert.equal(registry.fail(id, 'failed').state, 'failed')
})

test('taskbar progress aggregates concurrent downloads and clears only after all finish', () => {
  const first = { state: 'progressing', receivedBytes: 50, totalBytes: 100 }
  const second = { state: 'progressing', receivedBytes: 25, totalBytes: 100 }

  assert.deepEqual(taskbarProgressState([first, second]), {
    value: 0.375,
    options: { mode: 'normal' },
  })
  assert.deepEqual(taskbarProgressState([second]), {
    value: 0.25,
    options: { mode: 'normal' },
  })
  assert.deepEqual(taskbarProgressState([]), { value: -1 })
})

test('taskbar progress preserves indeterminate and interrupted states', () => {
  assert.deepEqual(
    taskbarProgressState([{ state: 'progressing', receivedBytes: 10, totalBytes: 0 }]),
    { value: 2, options: { mode: 'indeterminate' } },
  )
  assert.deepEqual(
    taskbarProgressState([{ state: 'interrupted', receivedBytes: 10, totalBytes: 20 }]),
    { value: 0.5, options: { mode: 'error' } },
  )
})
