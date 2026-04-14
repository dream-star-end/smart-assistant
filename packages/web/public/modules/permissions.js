// OpenClaude — Permission Requests
import { $ } from './dom.js'
import { state } from './state.js'
import { closeModal, openModal, toast } from './ui.js'

// Queue pending permission requests; show modal for the head of the queue.
const permQueue = []
let permCurrent = null

export function enqueuePermission(frame) {
  const req = frame.permissionRequest
  if (!req || !req.id) return
  // Dedupe: if we've already got this reqId, skip
  if (permCurrent && permCurrent.id === req.id) return
  if (permQueue.some((p) => p.id === req.id)) return
  const enriched = {
    id: req.id,
    tool: req.tool,
    reason: req.reason || '',
    detail: req.detail || '',
    summary: req.summary || '',
    toolInput: req.toolInput || null,
  }
  permQueue.push(enriched)
  if (!permCurrent) showNextPermission()
}
export function showNextPermission() {
  if (permCurrent) return
  permCurrent = permQueue.shift()
  if (!permCurrent) return
  $('perm-tool').value = permCurrent.tool || ''
  $('perm-reason').value = permCurrent.reason || permCurrent.summary || '(unknown)'
  // Show tool input as detail so user knows exactly what the tool will do
  let detailText = permCurrent.detail || permCurrent.summary || ''
  if (permCurrent.toolInput) {
    try {
      const inputStr = JSON.stringify(permCurrent.toolInput, null, 2)
      if (inputStr.length < 2000) detailText = `${detailText}\n\n--- 工具参数 ---\n${inputStr}`
    } catch {}
  }
  $('perm-detail').value = detailText
  const pendingMsg = permQueue.length > 0 ? `(后面还有 ${permQueue.length} 个待审批)` : ''
  $('perm-pending-count').textContent = pendingMsg
  openModal('permission-modal')
}
export function respondPermission(decision) {
  if (!permCurrent) return
  // If connected, send response to server
  if (state.ws && state.ws.readyState === 1) {
    state.ws.send(
      JSON.stringify({
        type: 'inbound.permission_response',
        requestId: permCurrent.id,
        decision,
      }),
    )
    toast(decision === 'allow' ? '已批准' : '已拒绝', decision === 'allow' ? 'success' : 'error')
  } else {
    // Disconnected: just close the modal, can't send response
    toast('连接断开，已自动拒绝', 'error')
  }
  permCurrent = null
  closeModal('permission-modal')
  setTimeout(showNextPermission, 150)
}

// Force-clear all pending permissions (called on disconnect)
export function clearAllPermissions() {
  permCurrent = null
  permQueue.length = 0
  closeModal('permission-modal')
}
