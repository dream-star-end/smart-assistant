import { apiGet, apiJson } from './api.js?v=b1e23a47'
// OpenClaude — Agents
import { $, htmlSafeEscape } from './dom.js?v=b1e23a47'
import { renderModePills } from './effortMode.js?v=b1e23a47'
import { getSession, state } from './state.js?v=b1e23a47'
import { closeModal, openModal, toast, toastOptsFromError } from './ui.js?v=b1e23a47'

// modelPicker.renderModelPill 的 late-binding setter — 避免 modelPicker.js
// (依赖本模块的 reloadAgents)与本模块互相 import 形成循环。
// main.js 在 init 时调 setRenderModelPill(renderModelPill) 注入。
let _renderModelPill = () => {}
export function setRenderModelPill(fn) {
  if (typeof fn === 'function') _renderModelPill = fn
}

const COMMERCIAL_FALLBACK_AGENTS = Object.freeze([
  {
    id: 'main',
    displayName: 'MiniMax M3 助手',
    avatarEmoji: '🧠',
    model: 'MiniMax-M3',
    provider: 'minimax',
  },
  {
    id: 'researcher',
    displayName: '资料研究员',
    avatarEmoji: '🔎',
    model: 'MiniMax-M3',
    provider: 'minimax',
  },
  {
    id: 'coder',
    displayName: '代码工程师',
    avatarEmoji: '🛠️',
    model: 'deepseek-v4-pro',
    provider: 'deepseek',
  },
  {
    id: 'reviewer',
    displayName: '审阅员',
    avatarEmoji: '🧪',
    model: 'MiniMax-M3',
    provider: 'minimax',
  },
  {
    id: 'codex',
    displayName: 'GPT 5.5 队长',
    avatarEmoji: '🤖',
    model: 'gpt-5.5',
    provider: 'codex-native',
  },
])

function _mergeCommercialFallbackAgents(agents = []) {
  const byId = new Map()
  for (const agent of Array.isArray(agents) ? agents : []) {
    if (agent?.id) byId.set(agent.id, agent)
  }
  for (const fallback of COMMERCIAL_FALLBACK_AGENTS) {
    if (!byId.has(fallback.id)) byId.set(fallback.id, { ...fallback })
  }
  return Array.from(byId.values())
}

function _isLimitedCommercialAgentList(agents = [], defaultAgentId = 'main') {
  return (
    defaultAgentId === 'main' &&
    Array.isArray(agents) &&
    agents.length <= 1 &&
    (agents.length === 0 || agents[0]?.id === 'main')
  )
}

export async function reloadAgents() {
  try {
    const data = await apiGet('/api/agents')
    state.defaultAgentId = data.default || 'main'
    const agents = Array.isArray(data.agents) ? data.agents : []
    if (_isLimitedCommercialAgentList(agents, state.defaultAgentId)) {
      // Some commercial user paths still return only `main` even though the
      // runtime seeds collaboration agents. Keep team templates usable and let
      // backend save/send validation remain authoritative.
      state.agentsList = _mergeCommercialFallbackAgents(agents)
      state.agentsListIsFallback = true
    } else {
      state.agentsList = agents
      state.agentsListIsFallback = false
    }
  } catch (err) {
    // v3 商用版 P0 防火墙对非 admin 用户把 /api/agents 403 掉了(见
    // packages/commercial/src/http/router.ts BLOCKED_FOR_USER_RULES)。前端
    // 拿不到列表时必须回落到商业版 seed agents,否则 state.agentsList.find(...) 全 undefined:
    //   - effortMode.getCurrentAgentModel() → '' → 思考深度 pill 一直隐藏
    //   - renderAgentDropdown / setCurrentSessionId / websocket.restoreTurnState
    //     拿 agentInfo 都会失败。顶栏那个切换下拉仍隐掉,避免把占位列表当成可编辑真列表。
    console.warn('load agents failed (commercial non-admin → fallback seeded agents):', err)
    state.agentsList = _mergeCommercialFallbackAgents()
    state.agentsListIsFallback = true
    state.defaultAgentId = 'main'
  }
  renderAgentDropdown()
  renderAgentsManagementList()
}

export function renderAgentDropdown() {
  // Legacy name kept for existing call sites. The header #agent-select was removed;
  // refreshing mode/model pills is still required after session-agent changes.
  renderModePills()
  _renderModelPill()
}

export function renderAgentsManagementList() {
  const wrap = $('agents-list-wrap')
  if (!wrap) return
  wrap.innerHTML = ''
  if (state.agentsListIsFallback) {
    const hint = document.createElement('p')
    hint.className = 'prefs-hint'
    hint.textContent = 'Agent 列表暂用商业版默认占位；团队保存和运行仍以后端实际配置为准。'
    wrap.appendChild(hint)
  }
  if (state.agentsList.length === 0) {
    wrap.innerHTML =
      '<p style="color:var(--fg-muted);font-size:var(--text-sm);margin:0">没有 agents</p>'
    return
  }
  for (const a of state.agentsList) {
    const row = document.createElement('div')
    row.className = 'agent-row agent-card-row'
    const info = document.createElement('div')
    info.className = 'agent-row-info'
    const title = document.createElement('div')
    title.className = 'agent-row-title'
    title.textContent = (a.avatarEmoji ? `${a.avatarEmoji} ` : '') + (a.displayName || a.id)
    if (a.id === state.defaultAgentId) {
      const badge = document.createElement('span')
      badge.className = 'badge'
      badge.textContent = '默认'
      title.appendChild(badge)
    }
    const sub = document.createElement('div')
    sub.className = 'agent-row-sub'
    sub.textContent = `${a.id} · ${a.model || '未配置模型'}`
    info.appendChild(title)
    info.appendChild(sub)
    const editBtn = document.createElement('button')
    editBtn.className = 'btn btn-secondary'
    editBtn.textContent = '编辑'
    if (state.agentsListIsFallback) {
      editBtn.disabled = true
      editBtn.title = '当前是默认占位列表，暂不能编辑'
    } else {
      editBtn.onclick = () => openPersonaEditor(a.id)
    }
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

// persona-model-preset 下拉变化 → 同步到 #persona-model 输入框。
// 原 inline onchange 移到这里:CSP 收紧 'unsafe-inline' 时仍可工作。
// 模块顶层一次性绑定 — element 是 index.html 静态节点,ES module deferred
// 加载时 DOM 已完整解析,无时序问题、无累积绑定。
{
  const _preset = document.getElementById('persona-model-preset')
  if (_preset) {
    _preset.addEventListener('change', () => {
      const v = _preset.value
      if (!v) return
      const model = document.getElementById('persona-model')
      if (model) model.value = v
    })
  }
}
