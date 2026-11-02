import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { link, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  type SessionFileReadRequest,
  appendSessionFile,
  flushSessionFileIo,
  withSessionFile,
  withSessionFileGroupRead,
} from '../sessionFileIo.js'
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'native-group-'))
  const scope = {
    projectsDir: join(root, 'projects'),
    sessionId: '12345678-1234-1234-1234-123456789abc',
    requireKernelLock: true,
  }
  await mkdir(scope.projectsDir, { mode: 0o700 })
  const request = (name: string): SessionFileReadRequest => ({
    filePath: join(scope.projectsDir, `${name}.jsonl`),
    scope: { ...scope, artifactId: name },
  })
  const a = request('a')
  const b = request('b')
  await appendSessionFile(a.filePath, 'first\n', a.scope)
  await appendSessionFile(b.filePath, 'second\n', b.scope)
  t.after(async () => {
    await flushSessionFileIo()
    await rm(root, { recursive: true, force: true })
  })
  return { root, scope, request, a, b }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}
test('group exposes only read methods and rejects nested IO or flush', async (t) => {
  const { a, b } = await fixture(t)
  await withSessionFileGroupRead([a, b], async (files) => {
    assert.equal(files.length, 2)
    assert.deepEqual(Object.keys(files[0]!.file).sort(), ['read', 'stat'])
    const bytes = Buffer.alloc(6)
    await files[0]!.file.read(bytes, 0, 6, 0)
    assert.equal(bytes.toString(), 'first\n')
    await assert.rejects(
      withSessionFile(a.filePath, a.scope, false, async () => {}),
      (error: unknown) => (error as { code: string }).code === 'CCB_TRANSCRIPT_NESTED_IO',
    )
    await assert.rejects(
      flushSessionFileIo(),
      (error: unknown) => (error as { code: string }).code === 'CCB_TRANSCRIPT_NESTED_FLUSH',
    )
  })
})
test('opposite logical target order reserves all queues atomically and releases before the next group', async (t) => {
  const { a, b } = await fixture(t)
  const entered = deferred()
  const release = deferred()
  const order: string[] = []
  const first = withSessionFileGroupRead([a, b], async () => {
    order.push('first')
    entered.resolve()
    await release.promise
  })
  await entered.promise
  const second = withSessionFileGroupRead([b, a], async () => {
    order.push('second')
  })
  release.resolve()
  await Promise.all([first, second])
  assert.deepEqual(order, ['first', 'second'])
})
test('physical inode order serializes reversed hard-link mappings with disjoint metadata identities', async (t) => {
  const { a, b, request } = await fixture(t)
  const c = request('c')
  const d = request('d')
  await link(b.filePath, c.filePath)
  await link(a.filePath, d.filePath)
  let count = 0
  await Promise.all([
    withSessionFileGroupRead([a, b], async () => {
      count++
    }),
    withSessionFileGroupRead([c, d], async () => {
      count++
    }),
  ])
  assert.equal(count, 2)
})
test('duplicate data inode is rejected before flock and does not strand an earlier lock', async (t) => {
  const { a, request } = await fixture(t)
  const alias = request('alias')
  await link(a.filePath, alias.filePath)
  await assert.rejects(
    withSessionFileGroupRead([a, alias], async () => assert.fail('duplicate entered')),
    (error: unknown) => (error as { code: string }).code === 'CCB_TRANSCRIPT_DUPLICATE_INODE',
  )
  await appendSessionFile(a.filePath, 'after\n', a.scope)
})
test('failed later acquisition closes every earlier data and metadata FD', async (t) => {
  const { a, request } = await fixture(t)
  await assert.rejects(
    withSessionFileGroupRead([a, request('missing')], async () => assert.fail('missing entered')),
    { code: 'ENOENT' },
  )
  assert.equal(spawnSync('/usr/bin/flock', ['-n', a.filePath, '/usr/bin/true']).status, 0)
  await appendSessionFile(a.filePath, 'after\n', a.scope)
})
test('data alias of a private metadata lock cannot deadlock acquisition', async (t) => {
  const { a, request, scope } = await fixture(t)
  const alias = request('lock-alias')
  const digest = createHash('sha256')
    .update(`${scope.projectsDir}\n${scope.sessionId}\na`)
    .digest('hex')
  const path = join(scope.projectsDir, '.oc-transcript-integrity', digest, 'lock')
  await link(path, alias.filePath)
  await assert.rejects(
    withSessionFileGroupRead([a, alias], async () => assert.fail('metadata alias entered')),
    (error: unknown) => (error as { code: string }).code === 'CCB_TRANSCRIPT_PRIVATE_FILE',
  )
})
test('awaited commit keeps every data inode locked and a queued writer waits for release', async (t) => {
  const { a, b } = await fixture(t)
  const entered = deferred()
  const release = deferred()
  const held = withSessionFileGroupRead([a, b], async () => {
    entered.resolve()
    await release.promise
  })
  await entered.promise
  let written = false
  const write = appendSessionFile(b.filePath, 'after-proof\n', b.scope).then(() => {
    written = true
  })
  try {
    for (const target of [a, b])
      assert.equal(spawnSync('/usr/bin/flock', ['-n', target.filePath, '/usr/bin/true']).status, 1)
    assert.equal(written, false)
  } finally {
    release.resolve()
  }
  await Promise.all([held, write])
  for (const target of [a, b])
    assert.equal(spawnSync('/usr/bin/flock', ['-n', target.filePath, '/usr/bin/true']).status, 0)
})
test('duplicate logical targets and cross-session groups reject before acquiring IO', async (t) => {
  const { a } = await fixture(t)
  await assert.rejects(
    withSessionFileGroupRead([a, a], async () => {}),
    (error: unknown) =>
      (error as { code: string }).code === 'CCB_TRANSCRIPT_GROUP_DUPLICATE_TARGET',
  )
  await assert.rejects(
    withSessionFileGroupRead(
      [a, { ...a, scope: { ...a.scope, sessionId: 'other' } }],
      async () => {},
    ),
    (error: unknown) => (error as { code: string }).code === 'CCB_TRANSCRIPT_GROUP_SCOPE_INVALID',
  )
})

test('internal metadata namespace cannot be used as data in a cross-group lock cycle', async (t) => {
  const { a, b, scope } = await fixture(t)
  const path = (name: string) =>
    join(
      scope.projectsDir,
      '.oc-transcript-integrity',
      createHash('sha256')
        .update(`${scope.projectsDir}\n${scope.sessionId}\n${name}`)
        .digest('hex'),
      'lock',
    )
  await Promise.all(
    [
      withSessionFile(path('b'), a.scope, false, async () => assert.fail('internal data entered')),
      withSessionFile(path('a'), b.scope, false, async () => assert.fail('internal data entered')),
    ].map((pending) =>
      assert.rejects(
        pending,
        (error: unknown) => (error as { code: string }).code === 'CCB_TRANSCRIPT_PATH_INVALID',
      ),
    ),
  )
})
