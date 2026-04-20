import { apiGet, apiJson } from './api.js'
// OpenClaude — Agents
import { $, htmlSafeEscape } from './dom.js'
import { renderModePills } from './effortMode.js'
import { renderResearchTools } from './researchTools.js'
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
    const name = a.displayName ? `${a.displayName} (${a.id})` : a.id
    const label = (a.avatarEmoji ? `${a.avatarEmoji} ` : '') + name
    opt.textContent = label + (a.id === state.defaultAgentId ? ' (default)' : '')
    sel.appendChild(opt)
  }
  const sess = getSession()
  if (sess) sel.value = sess.agentId || state.defaultAgentId
  // Pill 可见性依赖当前 agent 的 model — 任何 agent 列表/会话切换后都要刷新一次。
  renderModePills()
  // 科研工具条的可见性同样取决于 effort pill 当前选中值,跟随 agent 切换一起刷新。
  renderResearchTools()
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

// 商用版预设来自 /api/models(管理后台 model_pricing 表)。
// 缓存到模块级,modal 反复打开时不重复 fetch;失败 → 空数组(只剩"自定义")。
let _modelsCache = null
async function loadAdminModels() {
  if (_modelsCache) return _modelsCache
  try {
    const r = await apiGet('/api/models')
    _modelsCache = Array.isArray(r?.models) ? r.models : []
  } catch {
    _modelsCache = []
  }
  return _modelsCache
}

export async function openPersonaEditor(agentId) {
  try {
    const [info, persona, models] = await Promise.all([
      apiGet(`/api/agents/${encodeURIComponent(agentId)}`),
      apiGet(`/api/agents/${encodeURIComponent(agentId)}/persona`),
      loadAdminModels(),
    ])
    $('persona-modal-title').textContent = `编辑: ${info.agent.displayName || agentId}`
    $('persona-display-name').value = info.agent.displayName || ''
    $('persona-avatar-emoji').value = info.agent.avatarEmoji || ''
    $('persona-greeting').value = info.agent.greeting || ''
    $('persona-model').value = info.agent.model || ''
    // 用 /api/models 重建预设下拉(管理后台启用的模型)
    const preset = $('persona-model-preset')
    if (preset) {
      preset.innerHTML = ''
      const blank = document.createElement('option')
      blank.value = ''
      blank.textContent = '自定义'
      preset.appendChild(blank)
      for (const m of models) {
        const opt = document.createElement('option')
        opt.value = m.id
        opt.textContent = m.display_name || m.id
        preset.appendChild(opt)
      }
      const modelVal = info.agent.model || ''
      preset.value = [...preset.options].some((o) => o.value === modelVal) ? modelVal : ''
    }
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
          // 商用版不暴露 provider,服务端继承全局配置
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
