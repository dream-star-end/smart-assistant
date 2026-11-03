import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { CC5_TOOL_RESULT_MAX_BYTES, boundCc5ToolResult, cc5ToolResultBytes, cc5ToolInputSha256,
  validateCc5NativeToolInput } from '../cc5NativeTool.js'

test('Python and Node hash the exact Unicode tool input identically regardless of key order', () => {
  const args = { replace_all: false, new_string: '新行\n😀', file_path: '/tmp/文字.txt', old_string: 'old' }
  validateCc5NativeToolInput('mcp__ocbridge__Edit', args)
  const child = spawnSync('python3', ['-I', '-B', '-c',
    'import sys,json,hashlib; print(hashlib.sha256(json.dumps(json.load(sys.stdin),sort_keys=True,separators=(",",":"),ensure_ascii=False).encode("utf-8")).hexdigest())'],
  { input: JSON.stringify(args), encoding: 'utf8', timeout: 3000 })
  assert.equal(child.status, 0)
  assert.equal(cc5ToolInputSha256(args), child.stdout.trim())
  assert.equal(cc5ToolInputSha256(args), cc5ToolInputSha256(Object.fromEntries(Object.entries(args).reverse())))
})

test('only the three bounded foreground schemas are admitted', () => {
  for (const [name, args] of [
    ['mcp__ocbridge__Read', { file_path: '/tmp/a', offset: 1, limit: 10 }],
    ['mcp__ocbridge__Edit', { file_path: '/tmp/a', old_string: '', new_string: 'x' }],
    ['mcp__ocbridge__Bash', { command: 'pwd', timeout: 30000 }],
  ] as const) assert.doesNotThrow(() => validateCc5NativeToolInput(name, args))
  for (const [name, args] of [
    ['mcp__ocbridge__Write', { file_path: '/tmp/a', content: 'x' }],
    ['mcp__ocbridge__Bash', { command: 'pwd', run_in_background: true }],
    ['mcp__ocbridge__Bash', { command: 'pwd', dangerouslyDisableSandbox: true }],
    ['mcp__ocbridge__Bash', { command: 'pwd', timeout: 30001 }],
    ['mcp__ocbridge__Read', { file_path: '/tmp/a', offset: 1.5 }],
    ['mcp__ocbridge__Edit', { file_path: '/tmp/a', old_string: '\ud800', new_string: 'x' }],
  ] as const) assert.throws(() => validateCc5NativeToolInput(name, args), /CC5_NATIVE_TOOL_INPUT_INVALID/)
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
})
