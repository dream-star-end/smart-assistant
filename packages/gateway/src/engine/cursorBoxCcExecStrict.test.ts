import test from 'node:test'
import assert from 'node:assert/strict'
import { parseExecFramesStrict } from './cursorBoxCcExec.js'

function frame(value: unknown, flag = 0): Buffer {
  const raw = Buffer.from(JSON.stringify(value))
  const output = Buffer.alloc(5 + raw.length)
  output[0] = flag
  output.writeUInt32BE(raw.length, 1)
  raw.copy(output, 5)
  return output
}

test('strict Box Exec frames preserve stdout and known remote exit across chunks', () => {
  const bytes = Buffer.concat([frame({ stdoutEvent: { data: 'hello' } }),
    frame({ exitEvent: {} }), frame({}, 2)])
  const first = parseExecFramesStrict(bytes.subarray(0, 8))
  assert.deepEqual(first.events, [])
  const second = parseExecFramesStrict(Buffer.concat([first.rest, bytes.subarray(8)]))
  assert.deepEqual(second.events, [{ kind: 'stdout', data: 'hello' },
    { kind: 'exit', code: 0 }, { kind: 'end' }])
  assert.equal(second.rest.length, 0)
})

test('strict Box Exec frames reject corruption rather than skip to a later success', () => {
  const validExit = frame({ exitEvent: { exitCode: 0 } })
  const badJson = frame({ stdoutEvent: { data: 'x' } })
  badJson[5] = 0x7b // corrupt the JSON payload while retaining its length
  badJson[6] = 0x7b
  assert.throws(() => parseExecFramesStrict(Buffer.concat([badJson, validExit])),
    /BOX_EXEC_FRAME_JSON_INVALID/)
  const badFlag = frame({ stdoutEvent: { data: 'x' } })
  badFlag[0] = 1
  assert.throws(() => parseExecFramesStrict(badFlag), /BOX_EXEC_FRAME_FLAGS_INVALID/)
  assert.throws(() => parseExecFramesStrict(frame({ error: { code: 'unavailable' } }, 2)),
    /BOX_EXEC_END_INVALID/)
  assert.throws(() => parseExecFramesStrict(frame({ unknownEvent: {} })),
    /BOX_EXEC_FRAME_VARIANT_INVALID/)
  assert.deepEqual(parseExecFramesStrict(frame({ exitEvent: {} })).events,
    [{ kind: 'exit', code: 0 }], 'real proto3 Box omits default zero');
  assert.throws(() => parseExecFramesStrict(frame({ exitEvent: { reason: 'unknown' } })),
    /BOX_EXEC_FRAME_EXIT_INVALID/)
  assert.throws(() => parseExecFramesStrict(Buffer.concat([
    frame({ exitEvent: {}, exit_event: { exitCode: 3 } }), frame({}, 2),
  ])), /BOX_EXEC_FRAME_ALIAS_CONFLICT/)
  assert.throws(() => parseExecFramesStrict(frame({ exitEvent: { exitCode: 0, exit_code: 3 } })),
    /BOX_EXEC_FRAME_ALIAS_CONFLICT/)
  const invalidUtf8 = frame({ stdoutEvent: { data: 'x' } })
  const marker = invalidUtf8.indexOf(Buffer.from('"x"'))
  assert.ok(marker > 0)
  invalidUtf8[marker + 1] = 0xff
  assert.throws(() => parseExecFramesStrict(invalidUtf8), /BOX_EXEC_FRAME_JSON_INVALID/)
})
