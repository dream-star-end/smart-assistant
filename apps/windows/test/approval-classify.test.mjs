import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyDestructiveOp } from '../src/host/workspace/approval.mjs'
import { classifyPermissionFrame, createApprovalBridge } from '../src/host/approvalBridge.mjs'
import { createApprovalController } from '../src/host/workspace/approval.mjs'

test('unknown toolName requires approval (default deny)', () => {
  const result = classifyDestructiveOp({ kind: 'MysteryTool', detail: { toolName: 'MysteryTool' } })
  assert.equal(result.needsApproval, true)
  assert.equal(result.reason, 'unknown')
  assert.equal(result.readOnly, false)
})

test('read-only CCB tools auto-allow', () => {
  for (const kind of ['Read', 'Grep', 'Glob', 'LS']) {
    const result = classifyDestructiveOp({ kind, detail: { toolName: kind, path: '/w/proj/a.ts' } })
    assert.equal(result.needsApproval, false, kind)
    assert.equal(result.readOnly, true, kind)
  }
  const fetchGet = classifyDestructiveOp({
    kind: 'WebFetch',
    detail: { toolName: 'WebFetch', method: 'GET' },
  })
  assert.equal(fetchGet.readOnly, true)
  const fetchPost = classifyDestructiveOp({
    kind: 'WebFetch',
    detail: { toolName: 'WebFetch', method: 'POST' },
  })
  assert.equal(fetchPost.needsApproval, true)
})

test('readonly bash whitelist allows ls/cat/git status/log/diff/rg/find without delete', () => {
  for (const command of ['ls', 'ls -la /tmp', 'cat README.md', 'git status', 'git log -1', 'git diff', 'rg foo', 'find . -name *.js']) {
    const result = classifyDestructiveOp({ kind: 'Bash', command, detail: { toolName: 'Bash', command } })
    assert.equal(result.readOnly, true, command)
    assert.equal(result.needsApproval, false, command)
  }
})

test('auditor reverse-delete examples require approval', () => {
  const examples = [
    { command: 'Remove-Item -Recurse -Force C:\\w\\proj\\secret', reason: 'rm-rf' },
    { command: 'rm --recursive --force dir', reason: 'rm-rf' },
    { command: 'rm -r -f dir', reason: 'rm-rf' },
    { command: 'rm -fr dir', reason: 'rm-rf' },
    { command: 'rm -Rf dir', reason: 'rm-rf' },
    { command: 'del /s /q secret', reason: 'delete-directory' },
    { command: 'rd /s /q foo', reason: 'delete-directory' },
    { command: 'rmdir /s /q foo', reason: 'delete-directory' },
    { command: 'git clean -fd', reason: 'git-reset-hard' },
    { command: 'git checkout -- .', reason: 'git-reset-hard' },
    { command: 'git restore .', reason: 'git-reset-hard' },
    { command: 'git branch -D topic', reason: 'git-reset-hard' },
    { command: 'format D:', reason: 'format' },
    { command: 'diskpart', reason: 'format' },
  ]
  for (const example of examples) {
    const result = classifyDestructiveOp({
      kind: 'Bash',
      command: example.command,
      detail: { toolName: 'Bash', command: example.command },
    })
    assert.equal(result.needsApproval, true, example.command)
    assert.equal(result.reason, example.reason, example.command)
  }
})

test('system disk and user profile roots in write/delete require approval', () => {
  assert.equal(
    classifyDestructiveOp({ kind: 'Bash', command: 'rm -rf C:\\', detail: { path: 'C:\\' }, platform: 'win32' }).needsApproval,
    true,
  )
  assert.equal(
    classifyDestructiveOp({
      kind: 'Write',
      detail: { toolName: 'Write', path: 'C:\\Users\\alice' },
      platform: 'win32',
    }).reason,
    'system-disk',
  )
  assert.equal(
    classifyDestructiveOp({
      kind: 'Write',
      detail: { toolName: 'Write', path: '~' },
      platform: 'linux',
    }).reason,
    'system-disk',
  )
})

test('Write outside workspace root requires approval', () => {
  const result = classifyDestructiveOp({
    kind: 'Write',
    detail: {
      toolName: 'Write',
      path: 'C:\\w\\proj-evil\\x',
      workspaceRoot: 'C:\\w\\proj',
    },
    platform: 'win32',
  })
  assert.equal(result.needsApproval, true)
  assert.equal(result.reason, 'workspace-escape')
})

test('echo and unknown bash require approval', () => {
  const echo = classifyDestructiveOp({ kind: 'Bash', command: 'echo hello', detail: { toolName: 'Bash', command: 'echo hello' } })
  assert.equal(echo.needsApproval, true)
  const piped = classifyDestructiveOp({ kind: 'Bash', command: 'ls | rm -rf /', detail: { toolName: 'Bash' } })
  assert.equal(piped.needsApproval, true)
})

test('approvalBridge auto-allows only read-only; unknown waits on requestApproval', async () => {
  let lastId = null
  const approval = createApprovalController({
    timeoutMs: 5_000,
    prompt: async (request) => {
      lastId = request.id
    },
  })
  const bridge = createApprovalBridge({ approval })
  const read = await bridge.inspectOutbound(JSON.stringify({
    type: 'outbound.permission_request',
    requestId: 'req-read',
    toolName: 'Read',
    channel: 'webchat',
    peer: { kind: 'webchat', id: 'u' },
    inputJson: { path: '/w/proj/a.ts' },
  }), { sendJson: () => {} })
  assert.equal(read.response.behavior, 'allow')
  assert.equal(read.response.message, 'read-only')

  const pending = bridge.inspectOutbound(JSON.stringify({
    type: 'outbound.permission_request',
    requestId: 'req-rm',
    toolName: 'Bash',
    channel: 'webchat',
    peer: { kind: 'webchat', id: 'u' },
    inputJson: { command: 'Remove-Item -Recurse -Force C:\\w\\proj\\secret' },
  }), { sendJson: () => {} })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(typeof lastId, 'string')
  approval.deny(lastId)
  const denied = await pending
  assert.equal(denied.response.behavior, 'deny')
})

test('classifyPermissionFrame maps CCB Bash Remove-Item to needsApproval', () => {
  const framed = classifyPermissionFrame({
    toolName: 'Bash',
    input: { command: 'Remove-Item -Recurse C:\\w\\proj\\secret' },
  })
  assert.equal(framed.needsApproval, true)
})
