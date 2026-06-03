import { apiGet, apiJson } from './api.js?v=d07a53ac'
import { $, htmlSafeEscape } from './dom.js?v=d07a53ac'
import { state } from './state.js?v=d07a53ac'
import { toast, toastOptsFromError } from './ui.js?v=d07a53ac'

const TEAM_ID_RE = /^[a-zA-Z0-9_-]+$/
const SELECTED_TEAM_KEY = 'openclaude_selected_team'
let _editingTeamId = ''

function _cleanPromptText(value, maxLen = 1000) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen)
}

function _teamById(id) {
  return (state.agentTeams || []).find((t) => t.id === id) || null
}

function _agentExists(id) {
  return (state.agentsList || []).some((a) => a.id === id)
}

function _agentLabel(agentId) {
  const agent = (state.agentsList || []).find((a) => a.id === agentId)
  return agent?.displayName ? `${agent.displayName} (${agentId})` : agentId
}

function _memberLines(team) {
  return (team.members || [])
    .map((m) => {
      const role = _cleanPromptText(m.role, 40) || '成员'
      const resp = _cleanPromptText(m.responsibility, 200)
      return `- ${m.agentId}: ${role}${resp ? ` — ${resp}` : ''}`
    })
    .join('\n')
}

export function buildTeamRunPrompt(team, userText) {
  const name = _cleanPromptText(team?.name, 80) || team?.id || '未命名团队'
  const description = _cleanPromptText(team?.description, 300)
  const leader = _cleanPromptText(team?.leaderAgentId, 48)
  const members = _memberLines(team)
  const policy = team?.policy || {}
  const maxParallel = Number.isInteger(policy.maxParallel) ? policy.maxParallel : 3
  const reviewLine = policy.requireReview
    ? `- 需要复核: 是${
        policy.reviewAgentId ? `,优先请 ${_cleanPromptText(policy.reviewAgentId, 48)} 复核` : ''
      }`
    : '- 需要复核: 否'
  const goal = String(userText || '').trim() || '(用户没有输入文本目标,请结合附件完成任务)'
  return [
    '# Agent Team Run',
    '',
    `你是本次团队协作的队长/coordinator: ${leader}。`,
    `团队: ${name}${description ? ` — ${description}` : ''}`,
    '',
    '## 可委派成员',
    members || '- (无成员配置 — 请说明团队配置不完整)',
    '',
    '## 协作规则',
    '- 先给出简短任务拆解,再开始执行。',
    `- 只允许委派给上面列出的 agentId;不要编造不存在的 agent。`,
    `- 需要成员产出时,使用 delegate_task(goal=..., agentId=..., context=...)；可并行思考,但最多同时推进 ${maxParallel} 条子任务。`,
    reviewLine,
    '- 汇总时保留每个成员的关键结论、风险和未完成事项。',
    '- 不要把协作过程写成聊天剧本;用任务账本呈现真实进度。',
    '',
    '## 最终输出格式',
    '1. 协作计划',
    '2. 子任务账本(agent / 任务 / 状态 / 结果摘要)',
    '3. 最终结论或交付物',
    '4. 风险、验证和下一步',
    '',
    '## 用户目标',
    goal,
  ].join('\n')
}

export function getSelectedTeamForSend() {
  const id = state.selectedTeamId || ''
  if (!id) return null
  const team = _teamById(id)
  if (!team) {
    state.selectedTeamId = ''
    try {
      localStorage.removeItem(SELECTED_TEAM_KEY)
    } catch {}
    renderTeamDropdown()
    toast('团队配置不存在,已关闭团队模式', 'warning')
    return null
  }
  if (!_agentExists(team.leaderAgentId)) {
    toast(`团队队长 agent 不存在: ${team.leaderAgentId}`, 'error')
    return false
  }
  return team
}

export function teamDisplayPrefix(team) {
  return `👥 ${team.name || team.id}`
}

export async function reloadAgentTeams() {
  try {
    const data = await apiGet('/api/agent-teams')
    state.agentTeams = Array.isArray(data.teams) ? data.teams : []
  } catch (err) {
    console.warn('load agent teams failed:', err)
    state.agentTeams = []
  }
  const stored = (() => {
    try {
      return localStorage.getItem(SELECTED_TEAM_KEY) || ''
    } catch {
      return ''
    }
  })()
  state.selectedTeamId = state.agentTeams.some((t) => t.id === stored) ? stored : ''
  renderTeamDropdown()
  renderTeamsManagementList()
}

export function renderTeamDropdown() {
  const sel = $('team-select')
  if (!sel) return
  sel.innerHTML = ''
  const off = document.createElement('option')
  off.value = ''
  off.textContent = '团队: 关闭'
  sel.appendChild(off)
  for (const t of state.agentTeams || []) {
    const opt = document.createElement('option')
    opt.value = t.id
    opt.textContent = `团队: ${t.name || t.id}`
    sel.appendChild(opt)
  }
  sel.value = state.selectedTeamId || ''
  sel.hidden = (state.agentTeams || []).length === 0
}

export function renderTeamsManagementList() {
  const wrap = $('teams-list-wrap')
  if (!wrap) return
  wrap.innerHTML = ''
  if (!state.agentTeams || state.agentTeams.length === 0) {
    wrap.innerHTML =
      '<p style="color:var(--fg-muted);font-size:var(--text-sm);margin:0">还没有团队。先创建几个 Agent,再把它们组成团队。</p>'
    return
  }
  for (const t of state.agentTeams) {
    const row = document.createElement('div')
    row.className = 'agent-row team-row'
    row.innerHTML = `
      <div class="agent-row-info">
        <div class="agent-row-title">👥 ${htmlSafeEscape(t.name || t.id)}</div>
        <div class="agent-row-sub">队长: ${htmlSafeEscape(t.leaderAgentId)} · 成员: ${
          (t.members || []).map((m) => htmlSafeEscape(m.agentId)).join(', ') || '—'
        }</div>
      </div>`
    const editBtn = document.createElement('button')
    editBtn.className = 'btn btn-secondary'
    editBtn.style.padding = '8px 16px'
    editBtn.style.minHeight = '38px'
    editBtn.style.fontSize = 'var(--text-sm)'
    editBtn.textContent = '编辑'
    editBtn.onclick = () => openTeamEditor(t.id)
    row.appendChild(editBtn)
    wrap.appendChild(row)
  }
}

function _fillAgentSelect(el, selected) {
  if (!el) return
  el.innerHTML = ''
  if (el.id === 'team-review-agent') {
    const blank = document.createElement('option')
    blank.value = ''
    blank.textContent = '不指定复核 Agent'
    el.appendChild(blank)
  }
  for (const a of state.agentsList || []) {
    const opt = document.createElement('option')
    opt.value = a.id
    opt.textContent = _agentLabel(a.id)
    el.appendChild(opt)
  }
  el.value =
    selected ||
    (el.id === 'team-review-agent' ? '' : state.defaultAgentId || state.agentsList?.[0]?.id || '')
}

function _membersToText(members = []) {
  return members
    .map((m) =>
      [m.agentId, m.role || '', m.responsibility || ''].join(' | ').replace(/\s+\|\s+$/, ''),
    )
    .join('\n')
}

function _parseMembers(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [agentId, role, ...rest] = line.split('|').map((p) => p.trim())
      return { agentId, role: role || undefined, responsibility: rest.join(' | ') || undefined }
    })
}

export function openTeamEditor(teamId = '') {
  const team = teamId ? _teamById(teamId) : null
  _editingTeamId = team?.id || ''
  $('team-editor').hidden = false
  $('team-editor-title').textContent = team ? `编辑团队: ${team.name || team.id}` : '新建团队'
  $('team-id').value = team?.id || ''
  $('team-id').disabled = Boolean(team)
  $('team-name').value = team?.name || ''
  $('team-description').value = team?.description || ''
  _fillAgentSelect($('team-leader'), team?.leaderAgentId)
  $('team-members').value = _membersToText(team?.members || [])
  $('team-max-parallel').value = String(team?.policy?.maxParallel || 3)
  $('team-require-review').checked = Boolean(team?.policy?.requireReview)
  _fillAgentSelect($('team-review-agent'), team?.policy?.reviewAgentId || '')
  $('team-delete-btn').hidden = !team
}

function _closeTeamEditor() {
  _editingTeamId = ''
  $('team-editor').hidden = true
}

async function _saveTeamEditor() {
  const id = $('team-id').value.trim()
  const body = {
    id,
    name: $('team-name').value.trim(),
    description: $('team-description').value.trim() || undefined,
    leaderAgentId: $('team-leader').value,
    members: _parseMembers($('team-members').value),
    policy: {
      maxParallel: Number($('team-max-parallel').value || 3),
      requireReview: $('team-require-review').checked,
      reviewAgentId: $('team-review-agent').value || undefined,
    },
  }
  if (!TEAM_ID_RE.test(id)) {
    toast('团队 id 只能包含 a-z 0-9 _ -', 'error')
    return
  }
  try {
    if (_editingTeamId) {
      await apiJson('PUT', `/api/agent-teams/${encodeURIComponent(_editingTeamId)}`, body)
    } else {
      await apiJson('POST', '/api/agent-teams', body)
    }
    toast('团队已保存', 'success')
    _closeTeamEditor()
    await reloadAgentTeams()
  } catch (err) {
    toast(String(err), 'error', toastOptsFromError(err))
  }
}

async function _deleteTeamEditor() {
  const id = $('team-id').value.trim()
  if (!id || !_teamById(id)) return
  if (!confirm(`删除团队 "${id}"?`)) return
  try {
    await apiJson('DELETE', `/api/agent-teams/${encodeURIComponent(id)}`)
    if (state.selectedTeamId === id) {
      state.selectedTeamId = ''
      try {
        localStorage.removeItem(SELECTED_TEAM_KEY)
      } catch {}
    }
    toast('团队已删除', 'success')
    _closeTeamEditor()
    await reloadAgentTeams()
  } catch (err) {
    toast(String(err), 'error', toastOptsFromError(err))
  }
}

export function initAgentTeams() {
  $('team-select')?.addEventListener('change', (e) => {
    state.selectedTeamId = e.target.value || ''
    try {
      if (state.selectedTeamId) localStorage.setItem(SELECTED_TEAM_KEY, state.selectedTeamId)
      else localStorage.removeItem(SELECTED_TEAM_KEY)
    } catch {}
  })
  $('new-team-btn')?.addEventListener('click', () => openTeamEditor(''))
  $('team-cancel-btn')?.addEventListener('click', _closeTeamEditor)
  $('team-save-btn')?.addEventListener('click', _saveTeamEditor)
  $('team-delete-btn')?.addEventListener('click', _deleteTeamEditor)
}
