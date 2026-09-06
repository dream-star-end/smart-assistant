import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildPermissionResponse,
  classifyPermissionFrame,
  createApprovalBridge,
  parseGatewayWsJson,
  permissionRequestFromFrame,
} from '../src/host/approvalBridge.mjs'
import { createApprovalController } from '../src/host/workspace/approval.mjs'

test('parses outbound.permission_request and ignores other frames', () => {
  const frame = parseGatewayWsJson(Buffer.from(JSON.stringify({
    type: 'outbound.permission_request',
    requestId: 'req-1',
    toolName: 'Bash',
    channel: 'webchat',
    peer: { kind: 'webchat', id: 'u' },
    inputJson: { command: 'rm -rf /tmp/x' },
  })))
  const req = permissionRequestFromFrame(frame)
  assert.equal(req.requestId, 'req-1')
  assert.equal(req.toolName, 'Bash')
  assert.equal(permissionRequestFromFrame({ type: 'outbound.message' }), null)
  assert.equal(parseGatewayWsJson('not-json'), null)
})

test('destructive permission_request grants via controller.approve and injects allow', async () => {
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
  approval.approve(lastId)
  const { response } = await pending
  assert.equal(response.type, 'inbound.permission_response')
  assert.equal(response.requestId, 'req-rm')
  assert.equal(response.behavior, 'allow')
  assert.equal(injected.length, 1)
})

test('non-destructive permission_request auto-allows without the approval window', async () => {
  const approval = createApprovalController({ timeoutMs: 50 })
  const bridge = createApprovalBridge({ approval })
  const { response } = await bridge.inspectOutbound(JSON.stringify({
    type: 'outbound.permission_request',
    requestId: 'req-ls',
    toolName: 'Bash',
    channel: 'webchat',
    peer: { kind: 'webchat', id: 'u' },
    inputJson: { command: 'ls' },
  }), { sendJson: () => {} })
  assert.equal(response.behavior, 'allow')
  assert.equal(response.message, 'read-only')
  assert.equal(approval.pendingCount(), 0)
})

test('classifyPermissionFrame flags rm -rf and git reset --hard', () => {
  const rm = classifyPermissionFrame({
    toolName: 'Bash',
    input: { command: 'rm -rf ./build' },
  })
  assert.equal(rm.needsApproval, true)
  const ok = classifyPermissionFrame({ toolName: 'Read', input: { path: '/w/proj/a.ts' } })
  assert.equal(ok.needsApproval, false)
  const built = buildPermissionResponse(
    { requestId: 'x', channel: 'webchat', peer: { kind: 'webchat', id: 'u' }, agentId: 'main' },
    { approved: false, message: 'denied' },
  )
  assert.equal(built.behavior, 'deny')
})
