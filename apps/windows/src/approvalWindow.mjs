import { APPROVAL_TIMEOUT_MS } from './host/workspace/approval.mjs'

export const APPROVAL_PENDING_CHANNEL = 'approval:pending'

export function formatApprovalDetail(summary = {}) {
  const tool = String(summary.tool ?? '')
  const command = String(summary.command ?? '')
  const workspaceRoot = String(summary.workspaceRoot ?? '')
  return `工具：${tool}\n命令：${command}\n工作区：${workspaceRoot}`
}

export function summarizeApprovalRequest(info = {}) {
  const detail = info.detail && typeof info.detail === 'object' ? info.detail : {}
  return {
    tool: String(detail.toolName || info.kind || ''),
    command: String(info.command || detail.command || ''),
    workspaceRoot: String(detail.workspaceRoot || ''),
  }
}

export function buildApprovalPendingPayload(info = {}, { now = () => Date.now(), timeoutMs = APPROVAL_TIMEOUT_MS } = {}) {
  const opId = typeof info.id === 'string' ? info.id : ''
  if (!opId) return null
  const summary = summarizeApprovalRequest(info)
  const deadlineAt = typeof info.deadlineAt === 'number' ? info.deadlineAt : now() + timeoutMs
  return {
    opId,
    summary,
    deadlineAt,
    detailText: formatApprovalDetail(summary),
  }
}

export function createPendingApprovalStore({
  now = () => Date.now(),
  timeoutMs = APPROVAL_TIMEOUT_MS,
} = {}) {
  const pending = new Map()

  function expire(opId, at = now()) {
    const item = pending.get(opId)
    if (!item) return null
    if (at >= item.deadlineAt) {
      pending.delete(opId)
      return null
    }
    return item
  }

  return {
    add(info) {
      const payload = buildApprovalPendingPayload(info, { now, timeoutMs })
      if (!payload) return null
      pending.set(payload.opId, payload)
      return payload
    },
    has(opId) {
      if (typeof opId !== 'string' || opId.length === 0) return false
      return Boolean(expire(opId))
    },
    take(opId) {
      if (typeof opId !== 'string' || opId.length === 0) return null
      const item = expire(opId)
      if (!item) return null
      pending.delete(opId)
      return item
    },
    resolve(opId, allow) {
      const item = this.take(opId)
      if (!item) return { ok: false, error: 'unknown-op', approved: false }
      return { ok: true, approved: allow === true, id: opId }
    },
    get size() {
      let count = 0
      const at = now()
      for (const opId of [...pending.keys()]) {
        if (expire(opId, at)) count += 1
      }
      return count
    },
  }
}
