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
    observation: new Cc5ToolObservation(operationId, { legacyFixedTool: true }),
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
  const bad = new Cc5ToolObservation(f.operationId, { legacyFixedTool: true })
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

test('native profile matches multiple complete tools by canonical input and preserves the session across turns', async () => {
  const native = randomUUID()
  const observation = new Cc5ToolObservation(randomUUID())
  observation.beginTurn()
  const first = { nativeSessionId: native, toolUseId: 'read-1', name: 'mcp__ocbridge__Read', arguments: { file_path: '/task/a', limit: 2 } }
  const second = { nativeSessionId: native, toolUseId: 'edit-1', name: 'mcp__ocbridge__Edit', arguments: { file_path: '/task/a', old_string: 'before', new_string: 'after' } }
  const row = (requests: Array<{ toolUseId: string; name: string; arguments: unknown }>) => Buffer.from(`${JSON.stringify({ type: 'assistant', session_id: native,
    message: { content: requests.map((request) => ({ type: 'tool_use', id: request.toolUseId, name: request.name, input: request.arguments })) } })}\n`)
  observation.ingest(row([first, second]))
  assert.deepEqual((await observation.waitFor({ ...first, arguments: { limit: 2, file_path: '/task/a' } })).input, first.arguments)
  assert.equal((await observation.waitFor(second)).toolUseId, 'edit-1')
  assert.deepEqual(observation.toolUseIds, ['read-1', 'edit-1'])
  await assert.rejects(observation.waitFor({ ...first, arguments: { file_path: '/task/elsewhere', limit: 2 } }), /SCOPE_MISMATCH/)
  observation.endTurn()
  observation.beginTurn()
  const third = { ...first, toolUseId: 'read-2' }
  observation.ingest(row([third]))
  assert.equal((await observation.waitFor(third)).nativeSessionId, native)
  assert.throws(() => observation.ingest(row([first])), /OBSERVATION_INVALID/)
})

test('native profile rejects fixed proof, tools outside the ocbridge catalog namespace, unsafe inputs and effects outside an admitted turn', () => {
  for (const tool of [
    { name: 'Write', input: { file_path: '/task/a', content: 'x' } },
    { name: 'mcp__openclaude-memory__skill_search', input: { query: 'x' } },
    { name: 'mcp__ocbridge__Bash', input: { command: '\ud800' } },
    { name: 'mcp__ocbridge__Write', input: { file_path: '/task/a', content: 'x'.repeat(98304) } },
  ]) {
    const observation = new Cc5ToolObservation(randomUUID())
    assert.throws(() => observation.ingest(Buffer.from(`${JSON.stringify({ type: 'assistant', session_id: randomUUID(),
      message: { content: [{ type: 'tool_use', id: 'tool-1', ...tool }] } })}\n`)))
  }
  const observation = new Cc5ToolObservation(randomUUID())
  observation.endTurn()
  assert.throws(() => observation.ingest(Buffer.from(`${JSON.stringify({ type: 'assistant', session_id: randomUUID(),
    message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'mcp__ocbridge__Read', input: { file_path: '/task/a' } }] } })}\n`)))
})

test('a later invalid block in a native batch never releases the valid earlier tool', async () => {
  const native = randomUUID()
  const observation = new Cc5ToolObservation(randomUUID())
  const request = { nativeSessionId: native, toolUseId: 'read-1', name: 'mcp__ocbridge__Read', arguments: { file_path: '/task/a' } }
  const waiting = observation.waitFor(request)
  assert.throws(() => observation.ingest(Buffer.from(`${JSON.stringify({ type: 'assistant', session_id: native, message: { content: [
    { type: 'tool_use', id: request.toolUseId, name: request.name, input: request.arguments },
    { type: 'tool_use', id: 'bad-1', name: 'Write', input: { file_path: '/task/a', content: 'bad' } },
  ] } })}\n`)))
  await assert.rejects(waiting, /NOT_OBSERVED/)
})
