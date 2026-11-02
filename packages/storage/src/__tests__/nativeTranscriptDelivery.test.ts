import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  snapshotNativeTranscriptJson,
  verifyNativeJson,
} from '@openclaude/protocol/agentRemoteNative'
import {
  type NativeMessageProjection,
  nativeTranscriptMessageHash,
} from '@openclaude/protocol/agentRemoteNativeDelivery'
import { readNativeTranscriptDelivery } from '../nativeTranscriptDelivery.js'
import { withSessionFile } from '../sessionFileIo.js'
const sid = '00000000-0000-4000-8000-000000000003'
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const target = { kind: 'main' as const }
function row(n: number, type = 'user', parentUuid: string | null = null) {
  return {
    type,
    uuid: uuid(n),
    timestamp: '2026-11-01T00:00:00.000Z',
    parentUuid,
    isSidechain: false,
    sessionId: sid,
    message: { role: type, content: `synthetic-${n}` },
  }
}
function projection(value: ReturnType<typeof row>): NativeMessageProjection {
  return {
    uuid: value.uuid,
    target,
    projectionHash: nativeTranscriptMessageHash(value),
    parentUuid: value.parentUuid,
    timestamp: value.timestamp,
  }
}
const encode = (rows: unknown[]) =>
  Buffer.from(`${rows.map((value) => JSON.stringify(value)).join('\n')}\n`)
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'native-readback-'))
  const projects = join(root, 'projects')
  await mkdir(join(projects, 'cwd'), { recursive: true, mode: 0o700 })
  const path = join(projects, 'cwd', `${sid}.jsonl`)
  const scope = { projectsDir: projects, sessionId: sid, requireKernelLock: true }
  t.after(() => rm(root, { recursive: true, force: true }))
  const scan = (expected: NativeMessageProjection[], requireAll = true) =>
    withSessionFile(path, scope, false, (file) =>
      readNativeTranscriptDelivery(file, sid, target, expected, requireAll),
    )
  return { path, scope, scan }
}
test('readback hashes raw bytes across chunks and accepts native content larger than a wire frame', async (t) => {
  const f = await fixture(t)
  const large = {
    ...row(2, 'user', uuid(1)),
    message: { role: 'user', content: `${'x'.repeat(9 * 1024 * 1024)}中文😀` },
  }
  const bytes = encode([row(0), row(1, 'assistant', uuid(0)), large])
  await writeFile(f.path, bytes, { mode: 0o600 })
  assert.throws(() => verifyNativeJson(large), /native-frame-size/)
  const result = await f.scan([projection(large)])
  assert.equal(result.foundCount, 1)
  assert.equal(result.headUuid, uuid(2))
  assert.equal(result.headBytes, bytes.length)
  assert.equal(result.prefixHash, createHash('sha256').update(bytes).digest('hex'))
})
test('existing expected messages must be a unique ordered prefix', async (t) => {
  const f = await fixture(t)
  const base = [row(0), row(1, 'assistant', uuid(0))]
  const a = row(2, 'user', uuid(1))
  const b = row(3, 'user', uuid(2))
  const expected = [projection(a), projection(b)]
  await writeFile(f.path, encode([...base, a]), { mode: 0o600 })
  assert.equal((await f.scan(expected, false)).foundCount, 1)
  await assert.rejects(f.scan(expected), /native-proof-message-missing/)
  await writeFile(f.path, encode([...base, b]))
  await assert.rejects(f.scan(expected, false), /native-proof-nonprefix/)
  await writeFile(f.path, encode([...base, a, a]))
  await assert.rejects(f.scan(expected, false), /native-proof-duplicate-uuid/)
})
test('prepared parents need real prior transcript anchors and a source tool parent must be an assistant', async (t) => {
  const f = await fixture(t)
  for (const source of [99, 0]) {
    const bad = { ...row(2, 'user', uuid(source)), sourceToolAssistantUUID: uuid(source) }
    await writeFile(f.path, encode([row(0), row(1, 'assistant', uuid(0)), bad]), { mode: 0o600 })
    await assert.rejects(
      f.scan([projection(bad)]),
      source === 99 ? /native-proof-parent-missing/ : /native-proof-source-parent/,
    )
  }
})
test('BOM on a later line, invalid UTF8 and incomplete tails cannot become proof', async (t) => {
  const f = await fixture(t)
  const first = encode([row(0)])
  for (const [kind, bytes] of [
    ['bom', Buffer.concat([first, Buffer.from([239, 187, 191]), encode([row(1)])])],
    ['utf8', Buffer.concat([first, Buffer.from([255, 10])])],
    ['partial', Buffer.concat([first, Buffer.from('{"type":"user"')])],
  ] as const) {
    await writeFile(f.path, bytes, { mode: 0o600 })
    await assert.rejects(f.scan([]), (error) =>
      kind === 'partial'
        ? (error as { code: string }).code === 'native-proof-partial-line'
        : error instanceof SyntaxError || error instanceof TypeError,
    )
  }
})
test('file mutation outside managed locking invalidates a streaming readback', async (t) => {
  const f = await fixture(t)
  await writeFile(f.path, encode([row(0), row(1, 'assistant', uuid(0))]), { mode: 0o600 })
  await assert.rejects(
    withSessionFile(f.path, f.scope, false, async (file) => {
      let changed = false
      return readNativeTranscriptDelivery(
        {
          stat: file.stat.bind(file),
          read: (async (...args: Parameters<typeof file.read>) => {
            const result = await file.read(...args)
            if (!changed) {
              changed = true
              await appendFile(f.path, encode([{ type: 'custom-title', customTitle: 'changed' }]))
            }
            return result
          }) as typeof file.read,
        },
        sid,
        target,
        [],
        true,
      )
    }),
    /native-proof-file-changed/,
  )
})
test('snapshot follows native optional-field omission without invoking accessors and freezes original nested content', () => {
  const original = { ...row(2), optional: undefined, message: { role: 'user', content: 'before' } }
  const snapshot = snapshotNativeTranscriptJson(original) as typeof original
  original.message.content = 'after'
  assert.equal(snapshot.message.content, 'before')
  assert.equal(Object.hasOwn(snapshot, 'optional'), false)
  let called = false
  const hostile = Object.defineProperty({}, 'message', {
    enumerable: true,
    get() {
      called = true
      return 'unsafe'
    },
  })
  assert.throws(() => snapshotNativeTranscriptJson(hostile), /native-json-property/)
  assert.equal(called, false)
})
