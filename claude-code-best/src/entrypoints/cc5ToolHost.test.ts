import assert from 'node:assert/strict'
import test from 'node:test'
import { createCc5ToolDispatcher, isCc5ToolHostCommand, parseCc5ToolAllowlist } from './cc5ToolHost.js'

const session = 'd71e4679-e7df-482a-a129-a998a8f51f7e'
function call(toolUseId: string, name = 'Read', args: Record<string, unknown> = { file_path: '/workspace/probe.txt' }) {
  return { name, arguments: args, _meta: { 'claudecode/toolUseId': toolUseId,
    'openclaude/nativeSessionId': session, 'openclaude/turnKey': 'turn-one' } }
}
const ok = { content: [{ type: 'text' as const, text: 'done' }], isError: false }

test('only the exact three-tool host profile is accepted', () => {
  assert.deepEqual(parseCc5ToolAllowlist('Read,Edit,Bash'), ['Read', 'Edit', 'Bash'])
  for (const value of [undefined, '', 'Read', 'Read,Edit,Bash,Write', 'Read, Edit,Bash'])
    assert.throws(() => parseCc5ToolAllowlist(value), /REJECTED/)
})

test('the exact tool-host command is routed while ordinary commands remain ordinary', () => {
  assert.equal(isCc5ToolHostCommand(['mcp', 'serve', '--tool-allowlist', 'Read,Edit,Bash']), true)
  for (const args of [[], ['--version'], ['mcp', 'serve'], ['mcp', 'serve', '--help'], ['auth', 'status']])
    assert.equal(isCc5ToolHostCommand(args), false)
})

test('malformed, expanded and misplaced profiles cannot fall through to normal initialization', () => {
  for (const args of [
    ['mcp', 'serve', '--tool-allowlist'],
    ['mcp', 'serve', '--tool-allowlist', 'Read,Edit,Bash,Write'],
    ['mcp', 'serve', '--tool-allowlist', 'Read,Edit,Bash', '--debug'],
    ['mcp', 'serve', '--tool-allowlist=Read,Edit,Bash'],
    ['mcp', 'serve', '--tool-allowlist-typo', 'Read,Edit,Bash'],
    ['--tool-allowlist', 'Read,Edit,Bash', 'mcp', 'serve'],
    ['mcp', 'list', '--tool-allowlist', 'Read,Edit,Bash'],
    ['mcp', 'serve', '--tool-allowlist', 'Read,Edit,Bash', '--tool-allowlist', 'Read,Edit,Bash'],
  ]) assert.throws(() => isCc5ToolHostCommand(args), /REJECTED/)
})

test('unknown tools, fields and malformed inputs never enter the pipeline', async () => {
  let effects = 0
  const host = createCc5ToolDispatcher({ async execute() { effects++; return ok }, async close() {} })
  for (const input of [call('1', 'Write'), call('2', 'Bash', { command: 'pwd', run_in_background: true }),
    call('3', 'Bash', { command: 'pwd', timeout: 30001 }), call('4', 'Read', { file_path: '/x', limit: 0 }),
    call('5', 'Edit', { file_path: '/x', old_string: 'a' }), call('6', 'Read', { file_path: '/x', unsafe: true })])
    assert.throws(() => host.call(input), /REJECTED/)
  assert.equal(effects, 0)
  await host.close()
})

test('tool identity remains burned across an execution failure', async () => {
  let effects = 0
  const host = createCc5ToolDispatcher({ async execute() { effects++; throw new Error('pipeline failed') }, async close() {} })
  await assert.rejects(host.call(call('once')), /pipeline failed/)
  assert.throws(() => host.call(call('once')), /REJECTED/)
  assert.equal(effects, 1)
  await host.close()
})

test('a new turn shares the session and runtime while a different session is rejected', async () => {
  const seen: string[] = []
  const host = createCc5ToolDispatcher({ async execute(input) {
    seen.push(`${input.turnKey}:${input.name}`)
    return ok
  }, async close() {} })
  await host.call(call('read'))
  const edit = call('edit', 'Edit', { file_path: '/workspace/probe.txt', old_string: 'a', new_string: 'b' })
  edit._meta['openclaude/turnKey'] = 'turn-two'
  await host.call(edit)
  const other = call('other')
  other._meta['openclaude/nativeSessionId'] = '9a35eda8-8870-4c3f-a4e4-98e7f98fe169'
  assert.throws(() => host.call(other), /REJECTED/)
  assert.deepEqual(seen, ['turn-one:Read', 'turn-two:Edit'])
  await host.close()
})

test('a busy host rejects a second pipeline without queueing an effect', async () => {
  let release!: () => void
  let effects = 0
  const host = createCc5ToolDispatcher({ async execute() {
    effects++
    await new Promise<void>(resolve => { release = resolve })
    return ok
  }, async close() {} })
  const first = host.call(call('first'))
  await Promise.resolve()
  assert.throws(() => host.call(call('second')), /REJECTED/)
  release()
  await first
  assert.equal(effects, 1)
  await host.close()
})

test('close revokes new calls, aborts and waits for the running pipeline', async () => {
  let drain!: () => void
  let signal: AbortSignal | undefined
  let closed = false
  const host = createCc5ToolDispatcher({ async execute(input) {
    signal = input.signal
    await new Promise<void>(resolve => { drain = resolve })
    return ok
  }, async close() { closed = true } })
  const running = host.call(call('running'))
  await Promise.resolve()
  const closing = host.close()
  assert.equal(signal?.aborted, true)
  assert.equal(closed, false)
  assert.throws(() => host.call(call('late')), /REJECTED/)
  drain()
  await running
  await closing
  assert.equal(closed, true)
  assert.equal(host.close(), closing)
})

test('Bash receives a bounded default timeout and a captured input', async () => {
  let timeout: unknown
  let command: unknown
  const host = createCc5ToolDispatcher({ async execute(input) {
    timeout = input.input.timeout
    command = input.input.command
    return ok
  }, async close() {} })
  const request = call('bash', 'Bash', { command: 'pwd' })
  const running = host.call(request)
  request.arguments.command = 'changed-after-admission'
  await running
  assert.equal(timeout, 30000)
  assert.equal(command, 'pwd')
  await host.close()
})

test('oversized output is never returned as a successful tool receipt', async () => {
  const host = createCc5ToolDispatcher({ async execute() {
    return { content: [{ type: 'text', text: 'x'.repeat(131072) }], isError: false }
  }, async close() {} })
  await assert.rejects(host.call(call('oversized')), /RESULT_LIMIT/)
  assert.throws(() => host.call(call('oversized')), /REJECTED/)
  await host.close()
})
