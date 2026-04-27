import { apiGet, apiJson } from './api.js?v=e15648c'
// OpenClaude — Memory + Skills
import { $, htmlSafeEscape } from './dom.js?v=e15648c'
import { getSession, state } from './state.js?v=e15648c'
import { closeModal, openModal, toast, toastOptsFromError } from './ui.js?v=e15648c'

let _memoryTab = 'memory'

export async function openMemoryModal(agentId) {
  const id = agentId || (getSession()?.agentId ?? state.defaultAgentId)
  _memoryTab = 'memory'
  const title = $('memory-modal-title')
  title.textContent = `Memory — ${id}`
  title.dataset.agentId = id
  await loadMemoryTab('memory', id)
  $('memory-tab-memory').className = 'btn btn-secondary'
  $('memory-tab-user').className = 'btn btn-ghost'
  openModal('memory-modal')
}

export async function loadMemoryTab(target, agentId) {
  _memoryTab = target
  const id = agentId || $('memory-modal-title').dataset.agentId
  try {
    const data = await apiGet(`/api/agents/${encodeURIComponent(id)}/memory/${target}`)
    $('memory-text').value = data.text || ''
    $('memory-label').innerHTML =
      `${target === 'memory' ? 'MEMORY.md (我的观察)' : 'USER.md (用户画像)'} — <span id="memory-count">${data.charCount ?? 0}</span> chars`
  } catch (err) {
    toast(String(err), 'error', toastOptsFromError(err))
  }
}

export async function saveMemory() {
  const id = $('memory-modal-title').dataset.agentId
  try {
    await apiJson('PUT', `/api/agents/${encodeURIComponent(id)}/memory/${_memoryTab}`, {
      text: $('memory-text').value,
    })
    toast('已保存', 'success')
    closeModal('memory-modal')
  } catch (err) {
    toast(String(err), 'error', toastOptsFromError(err))
  }
}

export async function openSkillsModal(agentId) {
  const id = agentId || (getSession()?.agentId ?? state.defaultAgentId)
  const wrap = $('skills-list-wrap')
  wrap.innerHTML = '<p style="color:var(--fg-muted);font-size:var(--text-sm)">加载中...</p>'
  openModal('skills-modal')
  try {
    const data = await apiGet(`/api/agents/${encodeURIComponent(id)}/skills`)
    if (!data.skills || data.skills.length === 0) {
      wrap.innerHTML =
        '<p style="color:var(--fg-muted);font-size:var(--text-sm);margin:0">还没有任何 skill。让 agent 完成一个复杂任务后,它会通过 <code>skill_save</code> MCP 工具自动积累 skill。</p>'
      return
    }
    wrap.innerHTML = ''
    for (const s of data.skills) {
      const row = document.createElement('div')
      row.className = 'agent-row'
      const info = document.createElement('div')
      info.className = 'agent-row-info'
      const title = document.createElement('div')
      title.className = 'agent-row-title'
      title.textContent = s.name
      if (s.tags && s.tags.length > 0) {
        for (const tag of s.tags.slice(0, 3)) {
          const badge = document.createElement('span')
          badge.className = 'badge'
          badge.textContent = tag
          badge.style.marginLeft = '6px'
          title.appendChild(badge)
        }
      }
      const sub = document.createElement('div')
      sub.className = 'agent-row-sub'
      sub.style.whiteSpace = 'normal'
      sub.style.fontFamily = 'var(--font-sans)'
      sub.style.fontSize = 'var(--text-sm)'
      sub.textContent = s.description
      info.appendChild(title)
      info.appendChild(sub)
      const delBtn = document.createElement('button')
      delBtn.className = 'btn btn-ghost'
      delBtn.style.padding = '6px 14px'
      delBtn.style.minHeight = '36px'
      delBtn.style.fontSize = 'var(--text-sm)'
      delBtn.textContent = '删除'
      delBtn.onclick = async () => {
        if (!confirm(`删除 skill "${s.name}"?`)) return
        try {
          await apiJson(
            'DELETE',
            `/api/agents/${encodeURIComponent(id)}/skills/${encodeURIComponent(s.name)}`,
          )
          toast('已删除')
          await openSkillsModal(id)
        } catch (err) {
          toast(String(err), 'error', toastOptsFromError(err))
        }
      }
      row.appendChild(info)
      row.appendChild(delBtn)
      wrap.appendChild(row)
    }
  } catch (err) {
    wrap.innerHTML = `<p style="color:var(--danger)">加载失败: ${htmlSafeEscape(String(err))}</p>`
  }
}
