import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { CC5_FIXED_TOOL_NAME } from '../cc5FixedTool.js'
import { Cc5ToolObservation } from '../cc5ToolObservation.js'

function fixture() {
  const operationId = randomUUID()
  const nativeSessionId = randomUUID()
  const request = {
    nativeSessionId,
    toolUseId: 'toolu_original',
    name: CC5_FIXED_TOOL_NAME,
    arguments: { operationId },
  }
  const frame = {
    type: 'assistant',
    session_id: nativeSessionId,
    parent_tool_use_id: null,
    message: {
      content: [
        { type: 'text', text: '真實工具' },
        { type: 'tool_use', id: request.toolUseId, name: request.name, input: request.arguments },
      ],
    },
  }
  return {
    operationId,
    nativeSessionId,
    request,
    frame,
    observation: new Cc5ToolObservation(operationId),
  }
}

test('only a complete original assistant row authorizes; fragmented UTF8 is preserved', async () => {
  const f = fixture()
  f.observation.ingest(
    Buffer.from(
      `${JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: f.request.toolUseId, name: f.request.name },
        },
      })}\n`,
    ),
  )
  let settled = false
  const pending = f.observation.waitFor(f.request).then((value) => {
    settled = true
    return value
  })
  const raw = Buffer.from(`${JSON.stringify(f.frame)}\n`)
  // Split inside the actual multibyte character, then before the line terminator.
  const index = raw.indexOf(Buffer.from('真')) + 1
  f.observation.ingest(raw.subarray(0, index))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  f.observation.ingest(raw.subarray(index, raw.length - 1))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  f.observation.ingest(raw.subarray(raw.length - 1))
  assert.deepEqual(await pending, {
    nativeSessionId: f.nativeSessionId,
    toolUseId: f.request.toolUseId,
    name: f.request.name,
    input: f.request.arguments,
  })
})

test('user text or partial delta cannot forge tool observation; abort leaves no authorization', async () => {
  const f = fixture()
  f.observation.ingest(Buffer.from(`${JSON.stringify({ ...f.frame, type: 'user' })}\n`))
  const abort = new AbortController()
  const pending = f.observation.waitFor(f.request, abort.signal)
  abort.abort()
  await assert.rejects(pending, /NOT_OBSERVED/)
})

test('matching ids still reject a changed operation input, native session, or MCP name', async () => {
  const f = fixture()
  f.observation.ingest(Buffer.from(`${JSON.stringify(f.frame)}\n`))
  for (const changed of [
    { arguments: { operationId: randomUUID() } },
    { arguments: { operationId: f.operationId, command: 'outside' } },
    { nativeSessionId: randomUUID() },
    { name: 'Bash' },
    { toolUseId: 'different' },
  ]) {
    await assert.rejects(f.observation.waitFor({ ...f.request, ...changed }), /SCOPE_MISMATCH/)
  }
})

test('conflicting complete blocks, a second tool call, or a switched native UUID fail closed', () => {
  const f = fixture()
  f.observation.ingest(Buffer.from(`${JSON.stringify(f.frame)}\n`))
  f.observation.ingest(Buffer.from(`${JSON.stringify(f.frame)}\n`)) // exact duplicate, no extra effect permission
  const changed = structuredClone(f.frame)
  ;(changed.message.content[1] as { id?: string }).id = 'toolu_second'
  assert.throws(
    () => f.observation.ingest(Buffer.from(`${JSON.stringify(changed)}\n`)),
    /OBSERVATION_INVALID/,
  )
  assert.throws(
    () =>
      f.observation.ingest(
        Buffer.from(`${JSON.stringify({ type: 'system', session_id: randomUUID() })}\n`),
      ),
    /OBSERVATION_INVALID/,
  )
})

test('truncated or malformed original frames never yield an observation', async () => {
  const f = fixture()
  f.observation.ingest(Buffer.from('{"type":"assistant"'))
  assert.throws(() => f.observation.finish(), /OBSERVATION_INVALID/)
  await assert.rejects(f.observation.waitFor(f.request), /NOT_OBSERVED/)
  const bad = new Cc5ToolObservation(f.operationId)
  assert.throws(() => bad.ingest(Buffer.from([0xff, 0x0a])))
})

test('a valid-looking first block cannot release a waiter before the entire original row is validated', async () => {
  const f = fixture()
  let authorized = false
  const pending = f.observation.waitFor(f.request).then((value) => {
    authorized = true
    return value
  })
  const row = structuredClone(f.frame)
  row.message.content.push({
    type: 'tool_use',
    id: 'toolu_second',
    name: f.request.name,
    input: f.request.arguments,
  })
  assert.throws(
    () => f.observation.ingest(Buffer.from(`${JSON.stringify(row)}\n`)),
    /OBSERVATION_INVALID/,
  )
  await assert.rejects(pending, /NOT_OBSERVED/)
  assert.equal(authorized, false)
  await assert.rejects(f.observation.waitFor(f.request), /NOT_OBSERVED/)
})
