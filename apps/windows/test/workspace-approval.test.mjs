import assert from 'node:assert/strict'
import test from 'node:test'

import {
  APPROVAL_TIMEOUT_MS,
  classifyDestructiveOp,
  createApprovalController,
} from '../src/host/workspace/approval.mjs'

test('rule table requires approval for delete, git hard/force, rm -rf, format, and system paths', () => {
  assert.equal(classifyDestructiveOp({ kind: 'delete-directory' }).needsApproval, true)
  assert.equal(classifyDestructiveOp({ command: 'git reset --hard HEAD' }).reason, 'git-reset-hard')
  assert.equal(classifyDestructiveOp({ command: 'git push --force origin main' }).reason, 'git-push-force')
  assert.equal(classifyDestructiveOp({ command: 'rm -rf /tmp/proj' }).reason, 'rm-rf')
  assert.equal(classifyDestructiveOp({ command: 'format C:' }).reason, 'format')
  assert.equal(
    classifyDestructiveOp({ kind: 'write', detail: { path: 'C:\\Windows\\System32\\cmd.exe' }, platform: 'win32' })
      .reason,
    'system-disk',
  )
  assert.equal(classifyDestructiveOp({ command: 'echo hello' }).needsApproval, true)
  assert.equal(APPROVAL_TIMEOUT_MS, 120_000)
})

function fakeTimers() {
  const pending = []
  return {
    setTimer(fn) {
      const handle = { fn, cleared: false }
      pending.push(handle)
      return handle
    },
    clearTimer(handle) {
      if (handle) handle.cleared = true
    },
    flush() {
      for (const handle of pending) {
        if (!handle.cleared) handle.fn()
        handle.cleared = true
      }
    },
  }
}

test('requestApproval times out as deny when the injected timer fires', async () => {
  const timers = fakeTimers()
  const audits = []
  const controller = createApprovalController({
    timeoutMs: 120_000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    audit: (entry) => audits.push(entry),
  })
  const pending = controller.requestApproval({ kind: 'rm-rf', detail: { path: '/tmp/x' } })
  timers.flush()
  const result = await pending
  assert.equal(result.ok, true)
  assert.equal(result.approved, false)
  assert.equal(result.reason, 'timeout')
  assert.equal(audits.some((entry) => entry.event === 'approval_denied'), true)
})

test('requestApproval defaults to deny via deny-op and grants via approve-op', async () => {
  const timers = fakeTimers()
  const seen = []
  const controller = createApprovalController({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    prompt: async (request) => {
      seen.push(request.id)
    },
  })
  const deniedWait = controller.requestApproval({ kind: 'delete-directory' })
  await Promise.resolve()
  const deniedId = seen[0]
  const denied = controller.deny(deniedId)
  assert.equal(denied.approved, false)
  assert.equal((await deniedWait).approved, false)

  const grantedWait = controller.requestApproval({ kind: 'git-reset-hard' })
  await Promise.resolve()
  const grantedId = seen[1]
  const granted = controller.approve(grantedId)
  assert.equal(granted.approved, true)
  assert.equal((await grantedWait).approved, true)
  assert.equal(controller.pendingCount(), 0)
})
