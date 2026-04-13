import { apiGet, apiJson } from './api.js'
// OpenClaude — Agents
import { $, htmlSafeEscape } from './dom.js'
import { getSession, state } from './state.js'
import { closeModal, openModal, toast } from './ui.js'

export async function reloadAgents() {
  try {
    const data = await apiGet('/api/agents')
    state.agentsList = data.agents || []
    state.defaultAgentId = data.default || 'main'
    renderAgentDropdown()
    renderAgentsManagementList()
  } catch (err) {
    console.warn('load agents failed:', err)
  }
}

export function renderAgentDropdown() {
  const sel = $('agent-select')
  if (!sel) return
  sel.innerHTML = ''
  for (const a of state.agentsList) {
    const opt = document.createElement('option')
    opt.value = a.id
    opt.textContent = a.id + (a.id === state.defaultAgentId ? ' (default)' : '')
    sel.appendChild(opt)
  }
  const sess = getSession()
  if (sess) sel.value = sess.agentId || state.defaultAgentId
}

export function renderAgentsManagementList() {
  const wrap = $('agents-list-wrap')
  if (!wrap) return
  wrap.innerHTML = ''
  if (state.agentsList.length === 0) {
    wrap.innerHTML =
      '<p style="color:var(--fg-muted);font-size:var(--text-sm);margin:0">没有 agents</p>'
    return
  }
  for (const a of state.agentsList) {
    const row = document.createElement('div')
    row.className = 'agent-row'
    const info = document.createElement('div')
    info.className = 'agent-row-info'
    const title = document.createElement('div')
    title.className = 'agent-row-title'
    title.textContent = (a.avatarEmoji ? `${a.avatarEmoji} ` : '') + (a.displayName || a.id)
    if (a.id === state.defaultAgentId) {
      const badge = document.createElement('span')
      badge.className = 'badge'
      badge.textContent = 'default'
      title.appendChild(badge)
    }
    const sub = document.createElement('div')
    sub.className = 'agent-row-sub'
    sub.textContent = a.model || '—'
    info.appendChild(title)
    info.appendChild(sub)
    const editBtn = document.createElement('button')
    editBtn.className = 'btn btn-secondary'
    editBtn.style.padding = '8px 16px'
    editBtn.style.minHeight = '38px'
    editBtn.style.fontSize = 'var(--text-sm)'
    editBtn.textContent = '编辑'
    editBtn.onclick = () => openPersonaEditor(a.id)
    row.appendChild(info)
    row.appendChild(editBtn)
    wrap.appendChild(row)
  }
}

export async function openPersonaEditor(agentId) {
  try {
    const [info, persona] = await Promise.all([
      apiGet(`/api/agents/${encodeURIComponent(agentId)}`),
      apiGet(`/api/agents/${encodeURIComponent(agentId)}/persona`),
    ])
    $('persona-modal-title').textContent = `编辑: ${info.agent.displayName || agentId}`
    $('persona-display-name').value = info.agent.displayName || ''
    $('persona-avatar-emoji').value = info.agent.avatarEmoji || ''
    $('persona-greeting').value = info.agent.greeting || ''
    $('persona-model').value = info.agent.model || ''
    // Sync preset dropdown
    const preset = $('persona-model-preset')
    const modelVal = info.agent.model || ''
    preset.value = [...preset.options].some((o) => o.value === modelVal) ? modelVal : ''
    $('persona-provider').value = info.agent.provider || ''
    $('persona-permission').value = info.agent.permissionMode || 'default'
    $('persona-cwd').value = info.agent.cwd || ''
    $('persona-toolsets').value = (info.agent.toolsets || []).join(', ')
    $('persona-text').value = persona.text || ''
    const delBtn = $('delete-agent-btn')
    delBtn.disabled = agentId === state.defaultAgentId
    delBtn.style.display = agentId === state.defaultAgentId ? 'none' : ''
    delBtn.onclick = async () => {
      if (!confirm(`删除 agent "${agentId}"?`)) return
      try {
        await apiJson('DELETE', `/api/agents/${encodeURIComponent(agentId)}`)
        toast('agent 已删除', 'success')
        closeModal('persona-modal')
        await reloadAgents()
      } catch (err) {
        toast(String(err), 'error')
      }
    }
    $('save-persona-btn').onclick = async () => {
      try {
        await apiJson('PUT', `/api/agents/${encodeURIComponent(agentId)}`, {
          model: $('persona-model').value.trim(),
          permissionMode: $('persona-permission').value,
          provider: $('persona-provider').value || undefined,
          displayName: $('persona-display-name').value.trim() || undefined,
          avatarEmoji: $('persona-avatar-emoji').value.trim() || undefined,
          greeting: $('persona-greeting').value.trim() || undefined,
          cwd: $('persona-cwd').value.trim() || undefined,
          toolsets: $('persona-toolsets').value.trim()
            ? $('persona-toolsets')
                .value.split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            : undefined,
        })
        await apiJson('PUT', `/api/agents/${encodeURIComponent(agentId)}/persona`, {
          text: $('persona-text').value,
        })
        toast('已保存', 'success')
        closeModal('persona-modal')
        await reloadAgents()
      } catch (err) {
        toast(String(err), 'error')
      }
    }
    openModal('persona-modal')
  } catch (err) {
    toast(String(err), 'error')
  }
}
