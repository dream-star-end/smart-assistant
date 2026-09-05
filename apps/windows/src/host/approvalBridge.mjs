/**
 * Intercept gateway `/ws` `outbound.permission_request` frames, run the S5
 * approval engine, and inject `inbound.permission_response` (design §7, S6).
 * Does not modify gateway: Host is a WS man-in-the-middle on the loopback hop.
 */

import { classifyDestructiveOp } from './workspace/approval.mjs'

function asText(value) {
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  if (typeof value === 'string') return value
  return ''
}

export function parseGatewayWsJson(data) {
  const text = asText(data).trim()
  if (!text || (text[0] !== '{' && text[0] !== '[')) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function permissionRequestFromFrame(frame) {
  if (!frame || typeof frame !== 'object') return null
  if (frame.type !== 'outbound.permission_request') return null
  const requestId = typeof frame.requestId === 'string' ? frame.requestId : ''
  if (!requestId) return null
  return {
    requestId,
    toolName: typeof frame.toolName === 'string' ? frame.toolName : '',
    toolUseId: typeof frame.toolUseId === 'string' ? frame.toolUseId : '',
    input: frame.inputJson && typeof frame.inputJson === 'object' ? frame.inputJson : {},
    channel: typeof frame.channel === 'string' ? frame.channel : 'webchat',
    peer: frame.peer && typeof frame.peer === 'object' ? frame.peer : { kind: 'webchat', id: 'desktop' },
    agentId: typeof frame.agentId === 'string' ? frame.agentId : 'main',
  }
}

export function buildPermissionResponse(request, { approved, message } = {}) {
  return {
    type: 'inbound.permission_response',
    channel: request.channel,
    peer: request.peer,
    agentId: request.agentId,
    requestId: request.requestId,
    behavior: approved === true ? 'allow' : 'deny',
    ...(typeof message === 'string' && message ? { message } : {}),
  }
}

export function classifyPermissionFrame(request) {
  const input = request.input || {}
  const command = typeof input.command === 'string' ? input.command : ''
  const target = typeof input.path === 'string' ? input.path : typeof input.file_path === 'string' ? input.file_path : ''
  return classifyDestructiveOp({
    kind: request.toolName,
    command,
    detail: { path: target, command, toolName: request.toolName },
  })
}

export function createApprovalBridge({
  approval,
  classify = classifyPermissionFrame,
  audit = () => {},
} = {}) {
  async function handleRequest(request) {
    const classified = classify(request)
    audit({
      event: 'permission_request',
      requestId: request.requestId,
      toolName: request.toolName,
      needsApproval: classified.needsApproval,
      reason: classified.reason,
    })
    if (!classified.needsApproval) {
      return buildPermissionResponse(request, { approved: true, message: 'not-destructive' })
    }
    if (!approval || typeof approval.requestApproval !== 'function') {
      return buildPermissionResponse(request, { approved: false, message: 'no-approval-controller' })
    }
    const outcome = await approval.requestApproval({
      kind: classified.reason,
      command: request.input?.command,
      detail: {
        path: request.input?.path || request.input?.file_path,
        toolName: request.toolName,
        requestId: request.requestId,
      },
    })
    return buildPermissionResponse(request, {
      approved: outcome?.approved === true,
      message: outcome?.reason || (outcome?.approved ? 'approved' : 'denied'),
    })
  }

  return {
    classify,
    parseGatewayWsJson,
    permissionRequestFromFrame,
    buildPermissionResponse,
    async inspectOutbound(data, { sendJson } = {}) {
      const frame = parseGatewayWsJson(data)
      const request = permissionRequestFromFrame(frame)
      if (!request) return { intercepted: false, frame }
      const response = await handleRequest(request)
      if (typeof sendJson === 'function') sendJson(response)
      return { intercepted: true, frame, request, response }
    },
  }
}
