import assert from 'node:assert/strict'
import test from 'node:test'

import {
  APPROVAL_PENDING_CHANNEL,
  buildApprovalPendingPayload,
  createPendingApprovalStore,
  formatApprovalDetail,
} from '../src/approvalWindow.mjs'
import {
  createApprovalBridge,
  shouldForwardGatewayFrame,
} from '../src/host/approvalBridge.mjs'
import { createApprovalController } from '../src/host/workspace/approval.mjs'
import { createLocalHostIpcHandler } from '../src/ipc-contract.mjs'
import { formatApprovalDetail as enrollFormatApprovalDetail, resolveLocalHostAsset } from '../src/enroll.mjs'

function trustedFixture(url = 'app://clarvy-local/index.html') {
  const mainFrame = { url, parent: null }
  const webContents = { mainFrame, isDestroyed: () => false }
  return { event: { sender: webContents, senderFrame: mainFrame }, webContents, mainFrame }
}

test('formatApprovalDetail is plain text (no HTML)', () => {
  const text = formatApprovalDetail({
    tool: 'Bash',
    command: '<img src=x onerror=alert(1)>',
    workspaceRoot: 'C:\\w\\proj',
  })
  assert.equal(text.includes('<img'), true)
  assert.equal(text.includes('innerHTML'), false)
  assert.equal(text, enrollFormatApprovalDetail({
    tool: 'Bash',
    command: '<img src=x onerror=alert(1)>',
    workspaceRoot: 'C:\\w\\proj',
  }))
  assert.match(text, /^工具：Bash\n命令：/)
})

test('pending → allow → permission_response allow frame', async () => {
  let lastId = null
  const approval = createApprovalController({
    timeoutMs: 5_000,
    prompt: async (request) => {
      lastId = request.id
    },
  })
  const bridge = createApprovalBridge({ approval })
  const injected = []
  const pending = bridge.inspectOutbound(JSON.stringify({
    type: 'outbound.permission_request',
    requestId: 'req-rm',
    toolName: 'Bash',
    channel: 'webchat',
    peer: { kind: 'webchat', id: 'u' },
    agentId: 'main',
    inputJson: { command: 'rm -rf /tmp/proj' },
  }), { sendJson: (frame) => injected.push(frame) })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(typeof lastId, 'string')
  const store = createPendingApprovalStore()
  store.add({ id: lastId, kind: 'rm-rf', command: 'rm -rf /tmp/proj', detail: { toolName: 'Bash' } })
  const resolved = store.resolve(lastId, true)
  assert.equal(resolved.ok, true)
  assert.equal(resolved.approved, true)
  approval.approve(lastId)
  const { response, forward } = await pending
  assert.equal(response.behavior, 'allow')
  assert.equal(response.type, 'inbound.permission_response')
  assert.equal(forward, false)
  assert.equal(injected.length, 1)
})

test('pending → deny injects permission_response deny', async () => {
  let lastId = null
  const approval = createApprovalController({
    timeoutMs: 5_000,
    prompt: async (request) => {
      lastId = request.id
    },
  })
  const bridge = createApprovalBridge({ approval })
  const pending = bridge.inspectOutbound(JSON.stringify({
    type: 'outbound.permission_request',
    requestId: 'req-deny',
    toolName: 'Bash',
    channel: 'webchat',
    peer: { kind: 'webchat', id: 'u' },
    inputJson: { command: 'rm -rf /tmp/proj' },
  }), { sendJson: () => {} })
  await new Promise((r) => setTimeout(r, 20))
  const store = createPendingApprovalStore()
  store.add({ id: lastId, kind: 'rm-rf', command: 'rm -rf /tmp/proj' })
  assert.equal(store.resolve(lastId, false).approved, false)
  approval.deny(lastId)
  const { response } = await pending
  assert.equal(response.behavior, 'deny')
})

test('timeout 120s → deny', async () => {
  let now = 1_000
  const store = createPendingApprovalStore({ now: () => now, timeoutMs: 120_000 })
  store.add({ id: 'op-timeout', kind: 'rm-rf', command: 'rm -rf x' })
  assert.equal(store.has('op-timeout'), true)
  now += 120_000
  assert.equal(store.has('op-timeout'), false)
  assert.deepEqual(store.resolve('op-timeout', true), { ok: false, error: 'unknown-op', approved: false })

  const timers = []
  const approval = createApprovalController({
    timeoutMs: 120_000,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms })
      return timers.length
    },
    clearTimer: () => {},
  })
  const pending = approval.requestApproval({ kind: 'rm-rf', command: 'rm -rf x' })
  assert.equal(timers[0].ms, 120_000)
  timers[0].fn()
  const result = await pending
  assert.equal(result.approved, false)
  assert.equal(result.reason, 'timeout')
})

test('non-local window sender approve-op is rejected', async () => {
  const local = trustedFixture()
  const store = createPendingApprovalStore()
  store.add({ id: 'op-1', kind: 'rm-rf', command: 'rm -rf x' })
  const hostCalls = []
  const handler = createLocalHostIpcHandler({
    getLocalWebContents: () => local.webContents,
    approval: {
      approve(id) {
        const resolved = store.resolve(id, true)
        if (resolved.ok) hostCalls.push(id)
        return resolved
      },
      deny(id) {
        return store.resolve(id, false)
      },
    },
    getProductStatus: () => ({ pendingApprovals: store.size }),
  })
  const forged = trustedFixture('https://claudeai.chat/')
  const denied = await handler(forged.event, { type: 'approve-op', id: 'op-1' })
  assert.equal(denied.ok, false)
  assert.equal(denied.error, 'forbidden')
  assert.equal(hostCalls.length, 0)
  assert.equal(store.has('op-1'), true)

  const allowed = await handler(local.event, { type: 'approve-op', id: 'op-1' })
  assert.equal(allowed.ok, true)
  assert.equal(allowed.approved, true)
  assert.equal(hostCalls[0], 'op-1')

  const status = await handler(local.event, { type: 'get-status' })
  assert.equal(status.status.pendingApprovals, 0)
})

test('needsApproval permission_request is not forwarded to the product tunnel', () => {
  const destructive = JSON.stringify({
    type: 'outbound.permission_request',
    requestId: 'req-1',
    toolName: 'Bash',
    inputJson: { command: 'rm -rf /tmp/x' },
  })
  const readonly = JSON.stringify({
    type: 'outbound.permission_request',
    requestId: 'req-2',
    toolName: 'Bash',
    inputJson: { command: 'ls' },
  })
  const other = JSON.stringify({ type: 'outbound.message', text: 'hi' })
  assert.equal(shouldForwardGatewayFrame(destructive, false), false)
  assert.equal(shouldForwardGatewayFrame(readonly, false), true)
  assert.equal(shouldForwardGatewayFrame(other, false), true)
  assert.equal(shouldForwardGatewayFrame(destructive, true), true)
})

test('local renderer script binds approval buttons with textContent not innerHTML', () => {
  const asset = resolveLocalHostAsset('app://clarvy-local/local.mjs')
  assert.equal(typeof asset?.body, 'string')
  assert.equal(asset.body.includes("getElementById('approve-op')"), true)
  assert.equal(asset.body.includes("getElementById('deny-op')"), true)
  assert.equal(asset.body.includes('onApprovalPending'), true)
  assert.equal(asset.body.includes('textContent'), true)
  assert.equal(asset.body.includes('innerHTML'), false)
  assert.equal(APPROVAL_PENDING_CHANNEL, 'approval:pending')
  const payload = buildApprovalPendingPayload({
    id: 'op-abc',
    kind: 'rm-rf',
    command: 'rm -rf src',
    detail: { toolName: 'Bash', workspaceRoot: 'C:\\w\\proj' },
  }, { now: () => 0, timeoutMs: 120_000 })
  assert.equal(payload.opId, 'op-abc')
  assert.equal(payload.deadlineAt, 120_000)
  assert.equal(payload.summary.workspaceRoot, 'C:\\w\\proj')
})
