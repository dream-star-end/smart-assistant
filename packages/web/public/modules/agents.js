import { apiGet, apiJson } from './api.js'
// OpenClaude — Agents
import { $, htmlSafeEscape } from './dom.js'
import { renderEffortPicker } from './effortMode.js?v=3'
import { renderGoalModePanel } from './goalMode.js?v=3'
import { renderModelPicker } from './modelMode.js?v=1'
import { getSession, state } from './state.js'
import { closeModal, openModal, toast } from './ui.js'

export async function reloadAgents() {
  try {
    const data = await apiGet('/api/agents')
    state.agentsList = data.agents || []
    state.modelsList = data.models || []
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
  // 模型选择器选项随 agent 默认 model 变;agent 列表/会话切换后刷新。先于 effort,
  // 因为 effort 档位依赖"当前生效 model"(可能是模型选择器里的覆盖值)。
  renderModelPicker()
  // 思考深度选择器可见性/档位依赖当前生效 model — 任何 agent 列表/会话切换后都要刷新一次。
  renderEffortPicker()
  // Goal 模式只对 codex-native app-server agent 可见。
  renderGoalModePanel({ autoRefresh: true })
}

function syncRunnerKindVisibility() {
  const row = $('persona-runner-row')
  const runner = $('persona-runner-kind')
  const provider = $('persona-provider')?.value || ''
  if (row) row.hidden = provider !== 'codex-native'
  if (provider === 'codex-native' && runner && !runner.value) {
    runner.value = 'app-server'
  }
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
    $('persona-runner-kind').value = info.agent.runnerKind || 'app-server'
    $('persona-provider').onchange = () => syncRunnerKindVisibility()
    syncRunnerKindVisibility()
    $('persona-permission').value = info.agent.permissionMode || 'default'
    $('persona-cwd').value = info.agent.cwd || ''
    $('persona-toolsets').value = (info.agent.toolsets || []).join(', ')
    // proxyUrl arrives masked (user:pass → ***). Capture the masked value as
    // the dirty-tracking baseline so an unchanged field is omitted from the
    // PUT body — otherwise the redacted display would overwrite the real
    // credential. The gateway rejects masked values too (defense in depth).
    const proxyInput = $('persona-proxy-url')
    const proxyInitial = info.agent.proxyUrl ?? ''
    proxyInput.value = proxyInitial
    proxyInput.dataset.initial = proxyInitial
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
        const provider = $('persona-provider').value || undefined
        const payload = {
          model: $('persona-model').value.trim(),
          permissionMode: $('persona-permission').value,
          provider,
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
        }
        if (provider === 'codex-native') {
          payload.runnerKind = $('persona-runner-kind').value || 'app-server'
        }
        // Only include proxyUrl when the operator actually changed it. Sending
        // the masked initial value back would either no-op (best case) or be
        // rejected by the gateway's looksRedactedProxyUrl guard (worst case);
        // either way it's noise. Send empty string explicitly to clear.
        const proxyInputEl = $('persona-proxy-url')
        if (proxyInputEl.value !== (proxyInputEl.dataset.initial ?? '')) {
          payload.proxyUrl = proxyInputEl.value
        }
        await apiJson('PUT', `/api/agents/${encodeURIComponent(agentId)}`, payload)
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
