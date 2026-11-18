import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { CC5_TOOL_RESULT_MAX_BYTES, REMOTE_V4_TOOL_INPUT_MAX_BYTES, REMOTE_V4_TOOL_RESULT_MAX_BYTES,
  assertCc5ToolResult, boundCc5ToolResult, cc5ToolResultBytes, cc5ToolInputSha256,
  validateCc5NativeToolInput } from '../cc5NativeTool.js'

test('Python and Node hash the exact nested Unicode tool input identically regardless of key order', () => {
  const args = { tool_name: 'mcp__openclaude-memory__skill_search', params: { query: '记忆 😀', filters: { z: 1, a: [{ y: true, b: null }] },
    '10': 0.000001, '2': 1e-7, '\u{1F600}': 1, '\uFFFF': 2.5 },
    replace_all: false, new_string: '新行\n😀' }
  validateCc5NativeToolInput('mcp__ocbridge__ExecuteExtraTool', args)
  const child = spawnSync('python3', ['-I', '-B', '-c',
    'import sys,json,hashlib,importlib.util\nspec=importlib.util.spec_from_file_location("m",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nprint(hashlib.sha256(m.canonical(json.load(sys.stdin))).hexdigest())',
    new URL('../../../../scripts/agent-remote/cc5-fixed-mcp.py', import.meta.url).pathname],
  { input: JSON.stringify(args), encoding: 'utf8', timeout: 3000 })
  assert.equal(child.status, 0)
  assert.equal(cc5ToolInputSha256(args), child.stdout.trim())
  const reordered = { new_string: args.new_string, replace_all: false,
    params: { '\uFFFF': 2.5, '\u{1F600}': 1, '2': 1e-7, filters: { a: [{ b: null, y: true }], z: 1 }, query: args.params.query,
      '10': 0.000001 }, tool_name: args.tool_name }
  assert.equal(cc5ToolInputSha256(args), cc5ToolInputSha256(reordered))
})

test('any catalog alias with a bounded JSON object is admitted; the tool schema is checked where it runs', () => {
  for (const [name, args] of [
    ['mcp__ocbridge__Write', { file_path: '/tmp/a', content: 'x' }],
    ['mcp__ocbridge__Bash', { command: 'pwd', timeout: 600000, run_in_background: true }],
    ['mcp__ocbridge__t7', { nested: { list: [1, 2.5, 'x'] } }],
  ] as const) assert.doesNotThrow(() => validateCc5NativeToolInput(name, args))
  assert.throws(() => validateCc5NativeToolInput('mcp__ocbridge__Write', { file_path: '/tmp/a', content: 'x'.repeat(98304) }), /CC5_NATIVE_TOOL_INPUT_INVALID/)
  assert.doesNotThrow(() => validateCc5NativeToolInput('mcp__ocbridge__Write', { file_path: '/tmp/a', content: 'x'.repeat(200 * 1024) }, REMOTE_V4_TOOL_INPUT_MAX_BYTES))
  for (const [name, args] of [
    ['Write', { file_path: '/tmp/a' }],
    ['mcp__other__Write', { file_path: '/tmp/a' }],
    ['mcp__ocbridge__Bash', ['pwd']],
    ['mcp__ocbridge__Edit', { file_path: '/tmp/a', old_string: { deep: '\ud800' }, new_string: 'x' }],
    ['mcp__ocbridge__Read', { offset: 2 ** 53 }],
    ['mcp__ocbridge__Write', { file_path: '/tmp/a', content: 'x'.repeat(4 * 1024 * 1024) }],
  ] as const) assert.throws(() => validateCc5NativeToolInput(name, args, REMOTE_V4_TOOL_INPUT_MAX_BYTES), /CC5_NATIVE_TOOL_INPUT_INVALID/)
})

test('legacy 128 KiB result bound stays compatible with immutable cc5-fixed-mcp.py while v4 preserves 200 KiB text/images', () => {
  const bigText = { content: [{ type: 'text', text: '新行\n😀"\\'.repeat(24000) }], isError: false }
  const legacyBounded = boundCc5ToolResult(bigText)
  assert.ok(cc5ToolResultBytes(legacyBounded) <= CC5_TOOL_RESULT_MAX_BYTES)
  assertCc5ToolResult(legacyBounded)
  const reqArgs = { file_path: '/tmp/a' }
  const inputHash = cc5ToolInputSha256(reqArgs)
  const compatValue = {
    version: 2,
    ok: true,
    runId: 'run-compat-1',
    operationId: 'op-compat-1',
    rpcId: 1,
    toolUseId: 'toolu-compat-1',
    name: 'mcp__ocbridge__Read',
    inputSha256: inputHash,
    result: legacyBounded,
  }
  const compatCheck = spawnSync(
    'python3',
    [
      '-I',
      '-B',
      '-c',
      'import sys,json,importlib.util\nspec=importlib.util.spec_from_file_location("m",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\np=json.load(sys.stdin)\nprint(json.dumps(m.validate_response(p["value"],p["config"],p["ident"],p["tool_id"],p["name"],p["input_hash"])))',
      new URL('../../../../scripts/agent-remote/cc5-fixed-mcp.py', import.meta.url).pathname,
    ],
    {
      input: JSON.stringify({
        value: compatValue,
        config: { runId: compatValue.runId, operationId: compatValue.operationId },
        ident: compatValue.rpcId,
        tool_id: compatValue.toolUseId,
        name: compatValue.name,
        input_hash: inputHash,
      }),
      encoding: 'utf8',
      timeout: 3000,
    },
  )
  assert.equal(compatCheck.status, 0, compatCheck.stderr)
  assert.deepEqual(boundCc5ToolResult(bigText, REMOTE_V4_TOOL_RESULT_MAX_BYTES), bigText)

  const data = Buffer.alloc(200 * 1024, 7).toString('base64')
  const bigImage = { content: [{ type: 'image', mimeType: 'image/png', data }], isError: false }
  assert.deepEqual(boundCc5ToolResult(bigImage, REMOTE_V4_TOOL_RESULT_MAX_BYTES), bigImage)
})

test('the gateway result bound matches the Python canonical wire limit byte for byte', () => {
  const oversized = { content: [{ type: 'text', text: '新行\n😀"\\'.repeat(24000) }], isError: false }
  const bounded = boundCc5ToolResult(oversized)
  assert.notDeepEqual(bounded, oversized)
  const child = spawnSync('python3', ['-I', '-B', '-c',
    'import sys,json; print(len(json.dumps(json.load(sys.stdin),sort_keys=True,separators=(",",":"),ensure_ascii=False).encode("utf-8")))'],
  { input: JSON.stringify(bounded), encoding: 'utf8', timeout: 3000 })
  assert.equal(child.status, 0)
  const pythonBytes = Number(child.stdout.trim())
  assert.equal(pythonBytes, cc5ToolResultBytes(bounded))
  assert.ok(pythonBytes <= CC5_TOOL_RESULT_MAX_BYTES)
  const text = (bounded.content[0] as { type: string; text: string }).text
  assert.ok(text.startsWith('新行\n😀"\\'))
  assert.ok(text.endsWith(`[cc5 tool result truncated: original ${cc5ToolResultBytes(oversized)} bytes]`))

  const v4Oversized = { content: [{ type: 'text', text: 'A'.repeat(5 * 1024 * 1024) }], isError: false }
  const v4Bounded = boundCc5ToolResult(v4Oversized, REMOTE_V4_TOOL_RESULT_MAX_BYTES) as unknown as { content: Array<{ text: string }> }
  assert.ok(cc5ToolResultBytes(v4Bounded) <= REMOTE_V4_TOOL_RESULT_MAX_BYTES)
  assert.ok(v4Bounded.content[0].text.endsWith(`[cc5 tool result truncated: original ${cc5ToolResultBytes(v4Oversized)} bytes]`))
})


test('an oversized image block becomes a placeholder instead of base64 text', () => {
  const data = Buffer.alloc(200 * 1024, 7).toString('base64')
  const oversized = { content: [{ type: 'image', mimeType: 'image/png', data }], isError: false }
  const bounded = boundCc5ToolResult(oversized) as unknown as { content: Array<{ type: string; text?: string }>; isError: boolean }
  assert.ok(cc5ToolResultBytes(bounded) <= CC5_TOOL_RESULT_MAX_BYTES)
  assert.deepEqual(bounded.content.map((block) => block.type), ['text'])
  assert.ok(bounded.content[0].text!.includes('[image omitted: original 204800 bytes, too large to transfer'))
  assert.ok(!JSON.stringify(bounded).includes(data.slice(0, 64)), 'image bytes leaked as text')

  const v4Data = Buffer.alloc(4 * 1024 * 1024, 7).toString('base64')
  const v4Bounded = boundCc5ToolResult(
    { content: [{ type: 'image', mimeType: 'image/png', data: v4Data }], isError: false },
    REMOTE_V4_TOOL_RESULT_MAX_BYTES,
  ) as unknown as { content: Array<{ type: string; text?: string }> }
  assert.ok(cc5ToolResultBytes(v4Bounded) <= REMOTE_V4_TOOL_RESULT_MAX_BYTES)
  assert.deepEqual(v4Bounded.content.map((b) => b.type), ['text'])
})

test('mixed text and an oversized image keep the text head and replace only the image', () => {
  const head = 'gateway head\n'.repeat(4000)
  const data = Buffer.alloc(200 * 1024, 9).toString('base64')
  const oversized = { content: [
    { type: 'text', text: head },
    { type: 'image', mimeType: 'image/png', data },
  ], isError: false }
  const bounded = boundCc5ToolResult(oversized) as unknown as { content: Array<{ type: string; text?: string }>; isError: boolean }
  assert.ok(cc5ToolResultBytes(bounded) <= CC5_TOOL_RESULT_MAX_BYTES)
  assert.equal(bounded.content[0].type, 'text')
  assert.ok(bounded.content[0].text!.startsWith('gateway head\ngateway head\n'))
  const wire = JSON.stringify(bounded)
  assert.ok(wire.includes('[image omitted: original 204800 bytes'))
  assert.ok(!wire.includes(data.slice(0, 64)), 'image bytes leaked as text')
})

test('oversized UTF-8 text is cut on a complete character boundary', () => {
  const oversized = { content: [{ type: 'text', text: '😀'.repeat(50000) }], isError: false }
  const bounded = boundCc5ToolResult(oversized) as unknown as { content: Array<{ type: string; text: string }> }
  const text = bounded.content[0].text
  assert.ok(cc5ToolResultBytes(bounded) <= CC5_TOOL_RESULT_MAX_BYTES)
  assert.ok(!text.includes('�'), 'truncation split a UTF-8 character')
  assert.ok(text.endsWith(']'))
})
