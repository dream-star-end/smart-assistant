import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_APPROVAL_SRC = join(HERE, '../src/host/workspace/approval.mjs')
const BRIDGE_SRC = join(HERE, '../src/host/approvalBridge.mjs')
const TEST_SRC = fileURLToPath(import.meta.url)
const OS_COMMAND_E2E = false
const APPROVAL_SRC = process.env.OCV5_188_D_APPROVAL_MODULE || DEFAULT_APPROVAL_SRC

const { createApprovalBridge } = await import(pathToFileURL(BRIDGE_SRC).href)
const { classifyDestructiveOp, createApprovalController, isReadonlyBash } = await import(
  pathToFileURL(APPROVAL_SRC).href
)

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function hashes() {
  return {
    approvalSha256: sha256File(APPROVAL_SRC),
    bridgeSha256: sha256File(BRIDGE_SRC),
    testSha256: sha256File(TEST_SRC),
    approvalModule: APPROVAL_SRC,
  }
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

function classifyFrame(request) {
  const command = typeof request.input?.command === 'string' ? request.input.command : ''
  return classifyDestructiveOp({
    kind: request.toolName,
    command,
    detail: { toolName: request.toolName, command },
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
  }
}

async function drainBridge({ timers, approval, prompts, inspectPromise }) {
  try {
    if (approval && typeof approval.pendingCount === 'function' && approval.pendingCount() > 0) {
      for (const request of prompts) {
        if (typeof request?.id === 'string' && approval.hasPending(request.id)) {
          approval.deny(request.id)
        }
      }
    }
  } catch {
    /* drain must not mask the original error */
  }
  try {
    timers?.flush()
  } catch {
    /* drain */
  }
  if (inspectPromise) {
    try {
      await inspectPromise
    } catch {
      /* drain leftover inspect only */
    }
  }
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

const BRIDGE_NOCTRL_CASES = Object.freeze([
  { id: 'B1-noctrl-lf', requestId: 'req-noctrl-lf', command: CORE_LF },
  { id: 'B2-noctrl-crlf', requestId: 'req-noctrl-crlf', command: CORE_CRLF },
  { id: 'B3-noctrl-cr', requestId: 'req-noctrl-cr', command: CORE_CR },
])

const BRIDGE_CONTROLLER_CASES = Object.freeze([
  { id: 'B4-deny', requestId: 'req-ml-deny', command: CORE_LF, action: 'deny', behavior: 'deny' },
  { id: 'B5-timeout', requestId: 'req-ml-timeout', command: CORE_CRLF, action: 'timeout', behavior: 'deny' },
  { id: 'B6-approve', requestId: 'req-ml-approve', command: CORE_CR, action: 'approve', behavior: 'allow' },
])

const BRIDGE_SAFE_CASES = Object.freeze([
  { id: 'B7-ls', requestId: 'req-safe-ls', command: 'ls -la' },
  { id: 'B8-ls-tab', requestId: 'req-safe-ls-tab', command: 'ls\t-la' },
  { id: 'B9-git-status', requestId: 'req-safe-git', command: 'git status' },
])

const BUSINESS_IDS = Object.freeze([
  ...CLASSIFY_CASES.map((spec) => spec.id),
  ...BRIDGE_NOCTRL_CASES.map((spec) => spec.id),
  ...BRIDGE_CONTROLLER_CASES.map((spec) => spec.id),
  ...BRIDGE_SAFE_CASES.map((spec) => spec.id),
])

const executed = []

function emit(row) {
  console.log(JSON.stringify({ osCommandE2E: OS_COMMAND_E2E, hashes: hashes(), ...row }))
}

function mark(id, pass, extra = {}) {
  executed.push({ id, pass: pass === true, ...extra })
}

after(() => {
  const ran = new Set(executed.map((row) => row.id))
  const notRun = BUSINESS_IDS.filter((id) => !ran.has(id)).map((id) => ({ id, status: 'not-run' }))
  const pass = executed.filter((row) => row.pass).length
  const fail = executed.filter((row) => !row.pass).length
  emit({
    contractId: 'ocv5-188-D-catalog-summary',
    phase: 'catalog-summary',
    expected: { business: BUSINESS_IDS.length, skip: 0 },
    actual: {
      catalog: BUSINESS_IDS.length,
      executed: executed.length,
      pass,
      fail,
      skip: 0,
      notRun,
      ids: executed.map((row) => ({ id: row.id, pass: row.pass })),
    },
  })
})

for (const spec of CLASSIFY_CASES) {
  test(spec.id, () => {
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
    const expected = {
      readOnly: expectReadOnly,
      needsApproval: expectNeedsApproval,
      reason: expectReason ?? '(any non-readonly reason)',
      isReadonlyBash: expectReadOnly,
    }
    const pass =
      actual.readOnly === expected.readOnly &&
      actual.needsApproval === expected.needsApproval &&
      actual.isReadonlyBash === expected.isReadonlyBash &&
      (expectReason == null || actual.reason === expectReason)
    emit({
      contractId: spec.id,
      phase: 'classify',
      expected,
      actual,
      pass,
    })
    try {
      assert.equal(actual.readOnly, expectReadOnly, `${spec.id} readOnly`)
      assert.equal(actual.needsApproval, expectNeedsApproval, `${spec.id} needsApproval`)
      assert.equal(actual.isReadonlyBash, expectReadOnly, `${spec.id} isReadonlyBash`)
      if (expectReason) assert.equal(actual.reason, expectReason, `${spec.id} reason`)
      mark(spec.id, true)
    } catch (err) {
      mark(spec.id, false)
      throw err
    }
  })
}

for (const spec of BRIDGE_NOCTRL_CASES) {
  test(spec.id, async () => {
    const bridge = createApprovalBridge({ classify: classifyFrame })
    const sent = []
    const result = await bridge.inspectOutbound(bashFrame(spec.requestId, spec.command), {
      sendJson: (frame) => sent.push(frame),
    })
    const expected = {
      intercepted: true,
      readOnly: false,
      needsApproval: true,
      behavior: 'deny',
      requestId: spec.requestId,
      message: 'no-approval-controller',
      send: 1,
    }
    const actual = {
      intercepted: result.intercepted === true,
      readOnly: result.classified.readOnly === true,
      needsApproval: result.classified.needsApproval === true,
      behavior: result.response.behavior,
      requestId: result.response.requestId,
      message: result.response.message,
      send: sent.length,
      sentBehavior: sent[0]?.behavior,
      sentRequestId: sent[0]?.requestId,
    }
    const pass =
      actual.intercepted === true &&
      actual.readOnly === false &&
      actual.needsApproval === true &&
      actual.behavior === 'deny' &&
      actual.requestId === spec.requestId &&
      actual.message === 'no-approval-controller' &&
      actual.send === 1 &&
      actual.sentBehavior === 'deny' &&
      actual.sentRequestId === spec.requestId
    emit({ contractId: spec.id, phase: 'bridge-noctrl', expected, actual, pass })
    try {
      assert.equal(result.intercepted, true, spec.id)
      assert.equal(result.classified.readOnly, false, spec.id)
      assert.equal(result.classified.needsApproval, true, spec.id)
      assert.equal(result.response.behavior, 'deny', spec.id)
      assert.equal(result.response.requestId, spec.requestId, spec.id)
      assert.equal(result.response.message, 'no-approval-controller', spec.id)
      assert.equal(sent.length, 1, spec.id)
      assert.equal(sent[0].behavior, 'deny', spec.id)
      assert.equal(sent[0].requestId, spec.requestId, spec.id)
      mark(spec.id, true)
    } catch (err) {
      mark(spec.id, false)
      throw err
    }
  })
}

for (const spec of BRIDGE_CONTROLLER_CASES) {
  test(spec.id, async () => {
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
    const bridge = createApprovalBridge({ approval, classify: classifyFrame })
    let inspectPromise
    let testError
    try {
      inspectPromise = bridge.inspectOutbound(bashFrame(spec.requestId, spec.command), {
        sendJson: (frame) => sent.push(frame),
      })
      for (let i = 0; i < 30; i++) {
        if (prompts.length === 1 && approval.pendingCount() === 1) break
        await Promise.resolve()
      }
      const pendingExpected = { promptCount: 1, pendingCount: 1, send: 0 }
      const pendingActual = {
        promptCount: prompts.length,
        pendingCount: approval.pendingCount(),
        send: sent.length,
      }
      const pendingPass =
        pendingActual.promptCount === 1 && pendingActual.pendingCount === 1 && pendingActual.send === 0
      emit({
        contractId: spec.id,
        phase: 'bridge-controller-pending',
        expected: pendingExpected,
        actual: pendingActual,
        pass: pendingPass,
      })
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
      const result = await inspectPromise
      const expected = {
        behavior: spec.behavior,
        send: 1,
        requestId: spec.requestId,
        pendingThen: spec.action,
        drained: 0,
      }
      const actual = {
        behavior: result.response.behavior,
        send: sent.length,
        requestId: result.response.requestId,
        sentBehavior: sent[0]?.behavior,
        sentRequestId: sent[0]?.requestId,
        promptCount: prompts.length,
        drained: approval.pendingCount(),
      }
      const pass =
        actual.behavior === spec.behavior &&
        actual.send === 1 &&
        actual.requestId === spec.requestId &&
        actual.sentBehavior === spec.behavior &&
        actual.sentRequestId === spec.requestId &&
        actual.drained === 0
      emit({ contractId: spec.id, phase: 'bridge-controller-result', expected, actual, pass })
      assert.equal(result.response.requestId, spec.requestId, spec.id)
      assert.equal(result.response.behavior, spec.behavior, spec.id)
      assert.equal(sent.length, 1, `${spec.id} send count`)
      assert.equal(sent[0].behavior, spec.behavior, spec.id)
      assert.equal(sent[0].requestId, spec.requestId, spec.id)
      assert.equal(approval.pendingCount(), 0, `${spec.id} drained`)
    } catch (err) {
      testError = err
      emit({
        contractId: spec.id,
        phase: 'bridge-controller-error',
        expected: { pendingCount: 1, send: 0, then: spec.action, behavior: spec.behavior },
        actual: {
          promptCount: prompts.length,
          pendingCount: approval.pendingCount(),
          send: sent.length,
          sentBehavior: sent[0]?.behavior,
          error: err?.message || String(err),
        },
        pass: false,
      })
    } finally {
      mark(spec.id, !testError)
      await drainBridge({ timers, approval, prompts, inspectPromise })
    }
    if (testError) throw testError
  })
}

for (const spec of BRIDGE_SAFE_CASES) {
  test(spec.id, async () => {
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
    const bridge = createApprovalBridge({ approval, classify: classifyFrame })
    let inspectPromise
    let testError
    try {
      inspectPromise = bridge.inspectOutbound(bashFrame(spec.requestId, spec.command), {
        sendJson: (frame) => sent.push(frame),
      })
      const result = await inspectPromise
      const expected = {
        behavior: 'allow',
        message: 'read-only',
        requestId: spec.requestId,
        readOnly: true,
        prompts: 0,
        pendingCount: 0,
        send: 1,
      }
      const actual = {
        behavior: result.response.behavior,
        message: result.response.message,
        requestId: result.response.requestId,
        readOnly: result.classified.readOnly === true,
        prompts: prompts.length,
        pendingCount: approval.pendingCount(),
        send: sent.length,
        sentBehavior: sent[0]?.behavior,
      }
      const pass =
        actual.behavior === 'allow' &&
        actual.message === 'read-only' &&
        actual.requestId === spec.requestId &&
        actual.readOnly === true &&
        actual.prompts === 0 &&
        actual.pendingCount === 0 &&
        actual.send === 1 &&
        actual.sentBehavior === 'allow'
      emit({ contractId: spec.id, phase: 'bridge-safe', expected, actual, pass })
      assert.equal(result.response.behavior, 'allow', spec.id)
      assert.equal(result.response.message, 'read-only', spec.id)
      assert.equal(result.response.requestId, spec.requestId, spec.id)
      assert.equal(result.classified.readOnly, true, spec.id)
      assert.equal(prompts.length, 0, `${spec.id} no prompt`)
      assert.equal(approval.pendingCount(), 0, spec.id)
      assert.equal(sent.length, 1, spec.id)
      assert.equal(sent[0].behavior, 'allow', spec.id)
    } catch (err) {
      testError = err
      emit({
        contractId: spec.id,
        phase: 'bridge-safe-error',
        expected: { behavior: 'allow', prompts: 0 },
        actual: {
          prompts: prompts.length,
          pendingCount: approval.pendingCount(),
          send: sent.length,
          error: err?.message || String(err),
        },
        pass: false,
      })
    } finally {
      mark(spec.id, !testError)
      await drainBridge({ timers, approval, prompts, inspectPromise })
    }
    if (testError) throw testError
  })
}

test('P1-provenance', () => {
  const snap = hashes()
  const expected = {
    osCommandE2E: false,
    catalogBusiness: 31,
    classifyCases: 22,
    bridgeCases: 9,
  }
  const actual = {
    osCommandE2E: OS_COMMAND_E2E,
    catalogBusiness: BUSINESS_IDS.length,
    classifyCases: CLASSIFY_CASES.length,
    bridgeCases: BRIDGE_NOCTRL_CASES.length + BRIDGE_CONTROLLER_CASES.length + BRIDGE_SAFE_CASES.length,
    executedBusiness: executed.filter((row) => BUSINESS_IDS.includes(row.id)).length,
    skipInvoked: 0,
    hashes: snap,
  }
  emit({
    contractId: 'P1-provenance',
    phase: 'provenance',
    expected,
    actual,
    pass:
      actual.osCommandE2E === false &&
      actual.catalogBusiness === 31 &&
      actual.classifyCases === 22 &&
      actual.bridgeCases === 9 &&
      snap.approvalSha256.length === 64 &&
      snap.bridgeSha256.length === 64 &&
      snap.testSha256.length === 64,
  })
  assert.equal(OS_COMMAND_E2E, false)
  assert.equal(CLASSIFY_CASES.length, 22)
  assert.equal(BRIDGE_NOCTRL_CASES.length, 3)
  assert.equal(BRIDGE_CONTROLLER_CASES.length, 3)
  assert.equal(BRIDGE_SAFE_CASES.length, 3)
  assert.equal(BUSINESS_IDS.length, 31)
  assert.equal(snap.approvalSha256.length, 64)
  assert.equal(snap.bridgeSha256.length, 64)
  assert.equal(snap.testSha256.length, 64)
})
