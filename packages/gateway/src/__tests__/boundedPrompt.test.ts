import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { prepareBoundedPrompt } from '../engine/boundedPrompt.js'
import type { EngineContentEvent } from '../engine/engineEvents.js'
import { renderHistoricalContextJsonPrompt } from '../historicalContextPrompt.js'
import { classifyRunError } from '../errorClassify.js'

const serialize = (input: string) => `${JSON.stringify({ event: 'user', message: { content: input } })}\n`

test('50 MiB history is fitted using encoded bytes and preserves the exact current request', async () => {
  const events: EngineContentEvent[] = []
  const input = renderHistoricalContextJsonPrompt(
    Array.from({ length: 200 }, (_, i) => ({ role: 'User', text: `${i}:${'x'.repeat(256 * 1024)}` })),
    '继续处理 "最后一个任务" 😀',
  )
  const result = await prepareBoundedPrompt({ input, serialize, maxBytes: 600 * 1024, cwd: '/unused', engine: 'antigravity', onEvent: (e) => events.push(e) })
  assert.ok(Buffer.byteLength(result) <= 600 * 1024)
  const prompt = JSON.parse(result).message.content as string
  assert.ok(prompt.includes('199:'))
  assert.ok(!prompt.includes('0:'))
  assert.equal(JSON.parse(prompt.split('\n')[6]!), '继续处理 "最后一个任务" 😀')
  const done = events.find((e) => e.kind === 'context_compacted')
  assert.ok(done?.kind === 'context_compacted' && done.compaction.droppedEntries === 198)
})

test('pressure is measured before dispatch at 80 percent, with no false compaction', async () => {
  const events: EngineContentEvent[] = []
  const input = 'a'.repeat(900)
  assert.equal(await prepareBoundedPrompt({ input, serialize, maxBytes: 1100, cwd: '/unused', engine: 'antigravity', onEvent: (e) => events.push(e) }), serialize(input))
  assert.deepEqual(events, [{ kind: 'context_pressure', pressure: {
    engine: 'antigravity', scope: 'launch_prompt', dimension: 'transport_bytes', level: 'warning', usedRatio: Buffer.byteLength(serialize(input)) / 1100,
  } }])
})

test('oversized standalone input is stored privately and can be read byte for byte', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'oc-bounded-prompt-'))
  try {
    const input = '当前用户请求\n"quotes"\\emoji 😀'.repeat(50_000)
    const wire = await prepareBoundedPrompt({ input, serialize, maxBytes: 4096, cwd, engine: 'antigravity', onEvent: () => {} })
    const prompt = JSON.parse(wire).message.content as string
    const file = JSON.parse(prompt.split('\n')[1]!.slice('Input file: '.length)) as string
    assert.equal(await readFile(file, 'utf8'), input)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    assert.equal((await stat(join(file, '..'))).mode & 0o777, 0o700)
    assert.ok(Buffer.byteLength(wire) < 4096)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('an oversized platform envelope still fails honestly and removes only its unreferenced artifact', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'oc-bounded-envelope-'))
  const events: EngineContentEvent[] = []
  try {
    await assert.rejects(prepareBoundedPrompt({ input: 'x'.repeat(5000), serialize: (s) => serialize('p'.repeat(4096) + s), maxBytes: 4096, cwd, engine: 'antigravity', onEvent: (e) => events.push(e) }), (error: Error) => {
      assert.equal(classifyRunError(error.message).code, 'request_too_large')
      return true
    })
    assert.equal(events.some((e) => e.kind === 'context_compacted'), false)
    assert.deepEqual(await readdir(cwd), [])
  } finally { await rm(cwd, { recursive: true, force: true }) }
})


test('content-addressed references publish atomically and reuse files across callers', async () => {
  const { writeContextReference } = await import('../engine/contextReference.js')
  const cwd = await mkdtemp(join(tmpdir(), 'oc-context-ref-'))
  try {
    const content = Buffer.alloc(256 * 1024, 9)
    const key = 'a'.repeat(64)
    const refs = await Promise.all(Array.from({ length: 4 }, () => writeContextReference(cwd, content, 'image.png', key)))
    assert.equal(new Set(refs.map(r => r.file)).size, 1)
    assert.deepEqual(await readFile(refs[0]!.file), content)
    assert.equal((await readdir(cwd)).length, 1)
    assert.equal((await writeContextReference(cwd, content, 'image.png', key)).file, refs[0]!.file)
    await assert.rejects(writeContextReference(cwd, 'changed', 'image.png', key), /does not match/)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})
