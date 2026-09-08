import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  createApprovalBridge,
} from '../src/host/approvalBridge.mjs'
import {
  classifyDestructiveOp,
  createApprovalController,
  isReadonlyBash,
} from '../src/host/workspace/approval.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const APPROVAL_SRC = join(HERE, '../src/host/workspace/approval.mjs')
const BRIDGE_SRC = join(HERE, '../src/host/approvalBridge.mjs')
const OS_COMMAND_E2E = false

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function bashFrame(requestId, command) {
  return JSON.stringify({
    type: 'outbound.permission_request',
    requestId,
    toolName: 'Bash',
    channel: 'webchat',
    peer: { kind: 'webchat', id: 'u' },
    agentId: 'main',
    inputJson: { command },
  })
}

function classifyBash(command) {
  return classifyDestructiveOp({
    kind: 'Bash',
    command,
    detail: { toolName: 'Bash', command },
  })
}

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
    uncleared() {
      return pending.filter((handle) => !handle.cleared).length
    },
  }
}

async function waitFor(predicate, label) {
  for (let i = 0; i < 30; i++) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error(`timed out waiting for ${label}`)
}

const CORE_LF = 'ls\necho audit-benign'
const CORE_CRLF = 'ls\r\necho audit-benign'
const CORE_CR = 'ls\recho audit-benign'
const QUOTED_NEWLINE = 'ls "\necho audit-benign"'

const CLASSIFY_CASES = Object.freeze([
  { id: 'C1-ls', command: 'ls -la', expectReadOnly: true, expectReason: 'read-only' },
  { id: 'C2-ls-tab', command: 'ls\t-la', expectReadOnly: true, expectReason: 'read-only' },
  { id: 'C3-cat', command: 'cat README.md', expectReadOnly: true, expectReason: 'read-only' },
  { id: 'C4-rg', command: 'rg foo src', expectReadOnly: true, expectReason: 'read-only' },
  { id: 'C5-find', command: "find . -name '*.mjs'", expectReadOnly: true, expectReason: 'read-only' },
  { id: 'C6-git-status', command: 'git status', expectReadOnly: true, expectReason: 'read-only' },
  { id: 'C7-git-log-tab', command: 'git\tlog\t-1', expectReadOnly: true, expectReason: 'read-only' },
  { id: 'C8-git-diff', command: 'git diff --stat', expectReadOnly: true, expectReason: 'read-only' },
  { id: 'C9-lf', command: CORE_LF, expectReadOnly: false, expectReason: 'unknown' },
  { id: 'C10-crlf', command: CORE_CRLF, expectReadOnly: false, expectReason: 'unknown' },
  { id: 'C11-cr', command: CORE_CR, expectReadOnly: false, expectReason: 'unknown' },
  { id: 'C12-lead-lf', command: '\nls -la', expectReadOnly: false, expectReason: 'unknown' },
  { id: 'C13-trail-lf', command: 'ls -la\n', expectReadOnly: false, expectReason: 'unknown' },
  { id: 'C14-wrap-crlf', command: '\r\nls -la\r\n', expectReadOnly: false, expectReason: 'unknown' },
  { id: 'C15-quoted-lf', command: QUOTED_NEWLINE, expectReadOnly: false, expectReason: 'unknown' },
  { id: 'C16-rg-pre', command: 'rg --pre rm foo', expectReadOnly: false, expectNeedsApproval: true },
  { id: 'C17-rg-pre-glob', command: "rg --pre-glob '*' x", expectReadOnly: false, expectNeedsApproval: true },
  { id: 'C18-find-fprintf', command: 'find . -fprintf /tmp/out %p', expectReadOnly: false, expectNeedsApproval: true },
  { id: 'C19-find-exec', command: 'find . -exec rm {} ;', expectReadOnly: false, expectNeedsApproval: true },
  { id: 'C20-git-output', command: 'git log --output=/tmp/x', expectReadOnly: false, expectNeedsApproval: true },
  { id: 'C21-pipe-meta', command: 'ls | rm -rf /', expectReadOnly: false, expectNeedsApproval: true },
  { id: 'C22-echo', command: 'echo audit-benign', expectReadOnly: false, expectReason: 'unknown' },
])

test('raw LF/CRLF/CR are not collapsed into a read-only ls prefix (strings only, never executed)', () => {
  const ledger = []
  for (const spec of CLASSIFY_CASES) {
    const classified = classifyBash(spec.command)
    const readonly = isReadonlyBash(spec.command)
    const actual = {
      readOnly: classified.readOnly === true,
      needsApproval: classified.needsApproval === true,
      reason: classified.reason,
      isReadonlyBash: readonly,
    }
    const expectReadOnly = spec.expectReadOnly === true
    const expectNeedsApproval = spec.expectNeedsApproval === true || !expectReadOnly
    const expectReason = spec.expectReason
    const pass =
      actual.readOnly === expectReadOnly &&
      actual.needsApproval === expectNeedsApproval &&
      actual.isReadonlyBash === expectReadOnly &&
      (expectReason == null || actual.reason === expectReason)
    ledger.push({
      id: spec.id,
      expected: {
        readOnly: expectReadOnly,
        needsApproval: expectNeedsApproval,
        reason: expectReason ?? '(any non-readonly reason)',
      },
      actual,
      pass,
    })
    assert.equal(actual.readOnly, expectReadOnly, `${spec.id} readOnly`)
    assert.equal(actual.needsApproval, expectNeedsApproval, `${spec.id} needsApproval`)
    assert.equal(actual.isReadonlyBash, expectReadOnly, `${spec.id} isReadonlyBash`)
    if (expectReason) assert.equal(actual.reason, expectReason, `${spec.id} reason`)
  }
  assert.equal(CLASSIFY_CASES.length, 22)
  assert.equal(ledger.length, 22)
  console.log(JSON.stringify({ contractId: 'ocv5-188-D-classify', cases: ledger }, null, 2))
})

test('inspectOutbound: no controller denies multiline and does not auto-allow ls prefix', async () => {
  const bridge = createApprovalBridge({})
  const cases = [
    { id: 'B1-noctrl-lf', requestId: 'req-noctrl-lf', command: CORE_LF },
    { id: 'B2-noctrl-crlf', requestId: 'req-noctrl-crlf', command: CORE_CRLF },
    { id: 'B3-noctrl-cr', requestId: 'req-noctrl-cr', command: CORE_CR },
  ]
  for (const spec of cases) {
    const sent = []
    const result = await bridge.inspectOutbound(bashFrame(spec.requestId, spec.command), {
      sendJson: (frame) => sent.push(frame),
    })
    assert.equal(result.intercepted, true, spec.id)
    assert.equal(result.classified.readOnly, false, spec.id)
    assert.equal(result.classified.needsApproval, true, spec.id)
    assert.equal(result.response.behavior, 'deny', spec.id)
    assert.equal(result.response.requestId, spec.requestId, spec.id)
    assert.equal(result.response.message, 'no-approval-controller', spec.id)
    assert.equal(sent.length, 1, spec.id)
    assert.equal(sent[0].behavior, 'deny', spec.id)
    assert.equal(sent[0].requestId, spec.requestId, spec.id)
    console.log(JSON.stringify({
      contractId: spec.id,
      expected: { behavior: 'deny', send: 1, requestId: spec.requestId },
      actual: { behavior: result.response.behavior, send: sent.length, requestId: result.response.requestId },
    }))
  }
})

test('inspectOutbound: real controller pending then deny/timeout/approve each send once', async () => {
  const specs = [
    { id: 'B4-deny', requestId: 'req-ml-deny', command: CORE_LF, action: 'deny', behavior: 'deny' },
    { id: 'B5-timeout', requestId: 'req-ml-timeout', command: CORE_CRLF, action: 'timeout', behavior: 'deny' },
    { id: 'B6-approve', requestId: 'req-ml-approve', command: CORE_CR, action: 'approve', behavior: 'allow' },
  ]
  for (const spec of specs) {
    const timers = fakeTimers()
    const prompts = []
    const sent = []
    const approval = createApprovalController({
      timeoutMs: 5_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      prompt: async (request) => {
        prompts.push(request)
      },
    })
    const bridge = createApprovalBridge({ approval })
    try {
      const pending = bridge.inspectOutbound(bashFrame(spec.requestId, spec.command), {
        sendJson: (frame) => sent.push(frame),
      })
      await waitFor(() => prompts.length === 1 && approval.pendingCount() === 1, `${spec.id} pending`)
      assert.equal(sent.length, 0, `${spec.id} no send while pending`)
      assert.equal(approval.pendingCount(), 1, `${spec.id} pendingCount`)
      const opId = prompts[0].id
      assert.equal(typeof opId, 'string')
      if (spec.action === 'deny') {
        const denied = approval.deny(opId)
        assert.equal(denied.ok, true)
        assert.equal(denied.approved, false)
      } else if (spec.action === 'timeout') {
        timers.flush()
      } else {
        const granted = approval.approve(opId)
        assert.equal(granted.ok, true)
        assert.equal(granted.approved, true)
      }
      const result = await pending
      assert.equal(result.response.requestId, spec.requestId, spec.id)
      assert.equal(result.response.behavior, spec.behavior, spec.id)
      assert.equal(sent.length, 1, `${spec.id} send count`)
      assert.equal(sent[0].behavior, spec.behavior, spec.id)
      assert.equal(sent[0].requestId, spec.requestId, spec.id)
      assert.equal(approval.pendingCount(), 0, `${spec.id} drained`)
      console.log(JSON.stringify({
        contractId: spec.id,
        expected: { behavior: spec.behavior, send: 1, requestId: spec.requestId, pendingThen: spec.action },
        actual: {
          behavior: result.response.behavior,
          send: sent.length,
          requestId: result.response.requestId,
          promptCount: prompts.length,
        },
      }))
    } finally {
      timers.flush()
    }
  }
})

test('inspectOutbound: safe single-line ls/git with tab auto-allow and never prompt', async () => {
  const cases = [
    { id: 'B7-ls', requestId: 'req-safe-ls', command: 'ls -la' },
    { id: 'B8-ls-tab', requestId: 'req-safe-ls-tab', command: 'ls\t-la' },
    { id: 'B9-git-status', requestId: 'req-safe-git', command: 'git status' },
  ]
  for (const spec of cases) {
    const timers = fakeTimers()
    const prompts = []
    const sent = []
    const approval = createApprovalController({
      timeoutMs: 5_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      prompt: async (request) => {
        prompts.push(request)
      },
    })
    const bridge = createApprovalBridge({ approval })
    try {
      const result = await bridge.inspectOutbound(bashFrame(spec.requestId, spec.command), {
        sendJson: (frame) => sent.push(frame),
      })
      assert.equal(result.response.behavior, 'allow', spec.id)
      assert.equal(result.response.message, 'read-only', spec.id)
      assert.equal(result.response.requestId, spec.requestId, spec.id)
      assert.equal(result.classified.readOnly, true, spec.id)
      assert.equal(prompts.length, 0, `${spec.id} no prompt`)
      assert.equal(approval.pendingCount(), 0, spec.id)
      assert.equal(sent.length, 1, spec.id)
      assert.equal(sent[0].behavior, 'allow', spec.id)
      console.log(JSON.stringify({
        contractId: spec.id,
        expected: { behavior: 'allow', send: 1, prompts: 0, requestId: spec.requestId },
        actual: {
          behavior: result.response.behavior,
          send: sent.length,
          prompts: prompts.length,
          requestId: result.response.requestId,
        },
      }))
    } finally {
      timers.flush()
    }
  }
})

test('ocv5-188-D provenance: source hashes, fixed denominator, no OS command E2E', () => {
  const classifyN = CLASSIFY_CASES.length
  const bridgeN = 9
  const expectedTotal = classifyN + bridgeN
  const approvalHash = sha256File(APPROVAL_SRC)
  const bridgeHash = sha256File(BRIDGE_SRC)
  const summary = {
    contractId: 'ocv5-188-D-windows-multiline-approval',
    classifyCases: classifyN,
    bridgeCases: bridgeN,
    expectedTotal,
    skip: 0,
    osCommandE2E: OS_COMMAND_E2E,
    approvalSha256: approvalHash,
    bridgeSha256: bridgeHash,
  }
  console.log(JSON.stringify(summary, null, 2))
  assert.equal(classifyN, 22)
  assert.equal(bridgeN, 9)
  assert.equal(expectedTotal, 31)
  assert.equal(OS_COMMAND_E2E, false)
  assert.equal(approvalHash.length, 64)
  assert.equal(bridgeHash.length, 64)
})
