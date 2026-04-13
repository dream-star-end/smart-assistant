// OpenClaude — Permission Requests
import { $ } from './dom.js'
import { state } from './state.js'
import { openModal, closeModal, toast } from './ui.js'

// Queue pending permission requests; show modal for the head of the queue.
let permQueue = []
let permCurrent = null

export function enqueuePermission(frame) {
  const req = frame.permissionRequest
  if (!req || !req.id) return
  // Dedupe: if we've already got this reqId, skip
  if (permCurrent && permCurrent.id === req.id) return
  if (permQueue.some((p) => p.id === req.id)) return
  // Extract reason + detail from the block text body
  const blockText = (frame.blocks || []).map((b) => b.text || '').join('\n')
  const enriched = {
    id: req.id,
    tool: req.tool,
    summary: req.summary,
    rawText: blockText,
  }
  permQueue.push(enriched)
  if (!permCurrent) showNextPermission()
}
export function showNextPermission() {
  if (permCurrent) return
  permCurrent = permQueue.shift()
  if (!permCurrent) return
  $('perm-tool').value = permCurrent.tool || ''
  const m = /规则:\s*([^\n]+)/.exec(permCurrent.rawText || '')
  $('perm-reason').value = m ? m[1].trim() : '(unknown)'
  $('perm-detail').value = permCurrent.summary || ''
  const pendingMsg = permQueue.length > 0 ? `(后面还有 ${permQueue.length} 个待审批)` : ''
  $('perm-pending-count').textContent = pendingMsg
  openModal('permission-modal')
}
export function respondPermission(decision) {
  if (!permCurrent) return
  if (!state.ws || state.ws.readyState !== 1) {
    toast('未连接,无法响应', 'error')
    return
  }
  state.ws.send(
    JSON.stringify({
      type: 'inbound.permission_response',
      requestId: permCurrent.id,
      decision,
    }),
  )
  toast(decision === 'allow' ? '已批准' : '已拒绝', decision === 'allow' ? 'success' : 'error')
  permCurrent = null
  closeModal('permission-modal')
  setTimeout(showNextPermission, 150)
}
