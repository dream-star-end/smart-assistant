import { apiGet, apiJson } from './api.js?v=48b5679'
// OpenClaude — Agents
import { $, htmlSafeEscape } from './dom.js?v=48b5679'
import { renderModePills } from './effortMode.js?v=48b5679'
import { getSession, state } from './state.js?v=48b5679'
import { closeModal, openModal, toast, toastOptsFromError } from './ui.js?v=48b5679'

// modelPicker.renderModelPill 的 late-binding setter — 避免 modelPicker.js
// (依赖本模块的 reloadAgents)与本模块互相 import 形成循环。
// main.js 在 init 时调 setRenderModelPill(renderModelPill) 注入。
let _renderModelPill = () => {}
export function setRenderModelPill(fn) {
  if (typeof fn === 'function') _renderModelPill = fn
}

export async function reloadAgents() {
  try {
    const data = await apiGet('/api/agents')
    state.agentsList = data.agents || []
    state.defaultAgentId = data.default || 'main'
    // commercial admin 才能切 agent — 普通用户即便成功也只有 main,没意义就隐藏。
    const sel = $('agent-select')
    if (sel) sel.hidden = state.agentsList.length <= 1
  } catch (err) {
    // v3 商用版 P0 防火墙对非 admin 用户把 /api/agents 403 掉了(见
    // packages/commercial/src/http/router.ts BLOCKED_FOR_USER_RULES)。前端
    // 拿不到列表时必须回落一个 main agent,否则 state.agentsList.find(...) 全 undefined:
    //   - effortMode.getCurrentAgentModel() → '' → 思考深度 pill 一直隐藏
    //   - renderAgentDropdown / setCurrentSessionId / websocket.restoreTurnState
    //     拿 agentInfo 都会失败。顶栏那个切换下拉同时隐掉 —— 只有 main 没得切。
    console.warn('load agents failed (commercial non-admin → fallback main):', err)
    state.agentsList = [{
      id: 'main',
      displayName: 'main',
      model: 'claude-opus-4-7',
      provider: 'claude-subscription',
    }]
    state.defaultAgentId = 'main'
    const sel = $('agent-select')
    if (sel) sel.hidden = true
  }
  renderAgentDropdown()
  renderAgentsManagementList()
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
  // 思考深度选择器可见性依赖当前 agent 的 model — 任何 agent 列表/会话切换后都要刷新一次。
  renderModePills()
  // 模型 pill 也跟着 agent 当前 model 走;late-binding setter 在 modelPicker
  // 注入前是 noop,不会炸。
  _renderModelPill()
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
        toast(String(err), 'error', toastOptsFromError(err))
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
        toast(String(err), 'error', toastOptsFromError(err))
      }
    }
    openModal('persona-modal')
  } catch (err) {
    toast(String(err), 'error', toastOptsFromError(err))
  }
}
