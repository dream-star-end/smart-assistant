import { apiGet, apiJson } from './api.js?v=e6bc8391'
import { $, htmlSafeEscape } from './dom.js?v=e6bc8391'
import { scheduleSaveFromUserEdit } from './sessions.js?v=e6bc8391'
import { state } from './state.js?v=e6bc8391'
import { confirmDialog, toast, toastOptsFromError } from './ui.js?v=e6bc8391'

const TEAM_ID_RE = /^[a-zA-Z0-9_-]+$/
export const SELECTED_TEAM_KEY = 'openclaude_selected_team'
const SELECTED_TEAM_USER_PREFIX = `${SELECTED_TEAM_KEY}:user:`
let _editingTeamId = ''
let _agentTeamsLoaded = false
let _agentTeamsOwnerUserId = ''

function _emitTeamSelectionChanged() {
  document.dispatchEvent(new CustomEvent('agent-team-selection-changed'))
}

function _currentSession() {
  return state.sessions?.get?.(state.currentSessionId) || null
}

function _selectedTeamStorageKey() {
  const userId = _currentUserId()
  return userId ? `${SELECTED_TEAM_USER_PREFIX}${userId}` : SELECTED_TEAM_KEY
}

function _currentUserId() {
  return state.userId ? String(state.userId) : ''
}

function _readStoredSelectedTeamId() {
  try {
    const key = _selectedTeamStorageKey()
    const scoped = localStorage.getItem(key) || ''
    if (scoped || key === SELECTED_TEAM_KEY) return scoped
    // Upgrade path: preserve the user's existing browser choice once, then
    // future writes go to the user-scoped key and logout clears both forms.
    return localStorage.getItem(SELECTED_TEAM_KEY) || ''
  } catch {
    return ''
  }
}

function _selectedTeamCandidateForSession(sess) {
  if (sess && Object.prototype.hasOwnProperty.call(sess, '_selectedTeamId')) {
    return sess._selectedTeamId || ''
  }
  return _readStoredSelectedTeamId()
}

function _writeStoredSelectedTeamId(teamId = '') {
  try {
    const key = _selectedTeamStorageKey()
    if (teamId) localStorage.setItem(key, teamId)
    else localStorage.removeItem(key)
    if (key !== SELECTED_TEAM_KEY) localStorage.removeItem(SELECTED_TEAM_KEY)
  } catch {}
}

export function clearStoredAgentTeamSelection() {
  state.selectedTeamId = ''
  state.agentTeams = []
  _agentTeamsLoaded = false
  _agentTeamsOwnerUserId = ''
  const sess = _currentSession()
  if (sess) sess._selectedTeamId = ''
  try {
    // Clear the legacy cross-user key so the next login never inherits this
    // user's picker state. Keep user-scoped keys: they are isolated by
    // state.userId and preserve convenience when the same user logs in again.
    localStorage.removeItem(SELECTED_TEAM_KEY)
  } catch {}
  _emitTeamSelectionChanged()
}

const TEAM_TEMPLATES = [
  {
    id: 'science_research_team',
    name: '科研协作团队',
    description: '适合文献调研、实验/数据分析、论文思路和证据复核',
    // 队长默认走 glm-5.1：codex-native runner 跑不了 glm-5.1，故队长用
    // main（GLM-5.1 助手）+ 队长提示词，而非 codex（GPT-5.5）。
    leaderAgentId: 'main',
    leaderRole: '科研项目负责人',
    leaderPrompt:
      '你是科研协作队长。先把研究问题拆成可验证子问题，定义证据标准和交付物；优先把资料整理交给 researcher，把统计建模/科学计算/可视化/生信分析交给 scientist，把工程实现或复现实验脚本交给 coder，把证据链复核交给 reviewer。默认不假设 browser/research MCP 已挂载，需要外部检索或论文工具时只要求成员在当前工具列表可用时使用。最终按结论、证据、局限和下一步组织输出。',
    members: [
      {
        agentId: 'researcher',
        role: '文献研究员',
        responsibility: '整理资料、阅读论文/文档并列出可靠来源',
        rolePrompt:
          '围绕研究问题整理和筛选高可信资料，区分已证实结论、假设和争议。默认不假设浏览器或 PDF 工具可用；若当前工具列表没有 browser/research，就基于已有上下文、平台文献/搜索入口和可追溯来源线索输出。输出必须包含来源线索、关键证据、适用边界和仍需验证的问题。',
      },
      {
        agentId: 'scientist',
        role: '科研数据分析师',
        responsibility: '负责统计建模、科学计算、论文级可视化、生信/单细胞分析和方法选择',
        rolePrompt:
          '把研究问题转成可验证的数据分析、统计建模、科学计算、可视化或生信流程。优先使用已加载科研 skills，先确认变量、假设、样本量、评价指标和数据边界；默认本地处理数据，外部上传或数据库调用前先征得用户同意。输出方法选择、最小可复现实验、指标解释、图表建议、局限和验证风险。',
      },
      {
        agentId: 'coder',
        role: '复现工程师',
        responsibility: '把分析方案落成可运行脚本、数据处理管线或复现实验步骤',
        rolePrompt:
          '根据 researcher/scientist 的方案做最小可运行实现，明确输入输出、依赖、运行命令和失败风险。不要扩大成无关重构；代码交付必须可复现并便于 scientist/reviewer 复核。',
      },
      {
        agentId: 'reviewer',
        role: '证据审稿人',
        responsibility: '复核证据链、方法漏洞、夸大结论和遗漏',
        rolePrompt:
          '像严格审稿人一样检查证据是否支撑结论，指出样本、方法、因果、统计和引用层面的弱点。不要重写答案，优先列出阻塞性问题和可信度判断。',
      },
    ],
    policy: { maxParallel: 2, requireReview: true, reviewAgentId: 'reviewer' },
    badge: '科研',
  },
  {
    id: 'programming_team',
    name: '编程协作团队',
    description: '适合需求拆解、技术调研、代码实现、测试和审查闭环',
    // 队长默认走 glm-5.1（同上：main 而非 codex/GPT-5.5）。
    leaderAgentId: 'main',
    leaderRole: '技术负责人',
    leaderPrompt:
      '你是编程协作队长。先确认需求、约束、影响范围和验收标准；把技术调研交给 researcher，把实现交给 coder，把质量审查交给 reviewer。默认不假设浏览器工具已挂载，需要外部官方资料时只要求成员在当前工具列表可用时使用。保持最小改动和可验证交付，最终说明改动点、验证结果、风险和后续建议。',
    members: [
      {
        agentId: 'researcher',
        role: '技术调研工程师',
        responsibility: '整理官方资料、现有实现、依赖约束和可选方案',
        rolePrompt:
          '优先阅读仓库现有模式、README/锁文件、已提供资料和真实约束，给出可执行方案对比。不要假设浏览器工具可用；只有当前工具列表明确包含 browser/WebFetch 等外部访问工具时才查外部官方文档。输出要包含推荐方案、关键依据、兼容性风险和不建议采用的方案理由。',
      },
      {
        agentId: 'coder',
        role: '实现工程师',
        responsibility: '按既有架构做最小必要代码修改并自测',
        rolePrompt:
          '先读相关代码和测试，再按项目约定做最小必要实现。不要扩大需求或重构无关模块。输出改动文件、核心逻辑、已跑验证和未覆盖风险。',
      },
      {
        agentId: 'reviewer',
        role: '质量审查工程师',
        responsibility: '检查正确性、边界、回归风险和测试覆盖',
        rolePrompt:
          '从正确性、回归风险、安全边界、测试覆盖和过度工程角度审查。区分阻塞问题和非阻塞建议，避免提出与需求无关的范围扩张。',
      },
    ],
    policy: { maxParallel: 2, requireReview: true, reviewAgentId: 'reviewer' },
    badge: '编程',
  },
]

function _cleanPromptText(value, maxLen = 1000) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen)
}

function _cleanBlockText(value, maxLen = 1200) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLen)
}

function _teamById(id) {
  return (state.agentTeams || []).find((t) => t.id === id) || null
}

function _agentExists(id) {
  return (state.agentsList || []).some((a) => a.id === id)
}

function _missingAgentIds(ids) {
  const missing = []
  for (const id of ids) {
    if (!id || missing.includes(id) || _agentExists(id)) continue
    missing.push(id)
  }
  return missing
}

function _templateRequiredAgentIds(template) {
  return [
    template.leaderAgentId,
    ...(template.members || []).map((m) => m.agentId),
    template.policy?.reviewAgentId,
  ].filter(Boolean)
}

function _templateRoleSummary(template) {
  return (template.members || [])
    .map((m) => `${m.agentId}/${m.role || '成员'}`)
    .join(' · ')
}

function _nextAvailableTeamId(baseId) {
  if (!_teamById(baseId)) return baseId
  for (let i = 2; i <= 99; i++) {
    const candidate = `${baseId}_${i}`
    if (!_teamById(candidate)) return candidate
  }
  return `${baseId}_${Date.now().toString(36)}`
}

function _agentLabel(agentId) {
  const agent = (state.agentsList || []).find((a) => a.id === agentId)
  return agent?.displayName ? `${agent.displayName} (${agentId})` : agentId
}

function _effectiveMaxParallel(value) {
  const parsed = Number.isInteger(value) ? value : 2
  return Math.max(1, Math.min(parsed, 2))
}

function _memberLines(team) {
  const members = [...(team.members || [])]
  const reviewAgentId = team?.policy?.requireReview ? team?.policy?.reviewAgentId : ''
  if (reviewAgentId && !members.some((m) => m.agentId === reviewAgentId)) {
    members.push({
      agentId: reviewAgentId,
      role: '复核',
      responsibility: '检查草案的遗漏、风险和错误',
    })
  }
  return members
    .map((m) => {
      const role = _cleanPromptText(m.role, 40) || '成员'
      const resp = _cleanPromptText(m.responsibility, 200)
      const rolePrompt = _cleanBlockText(m.rolePrompt, 1200)
      const promptLine = rolePrompt ? `\n  角色提示词: ${rolePrompt.replace(/\n/g, '\n  ')}` : ''
      return `- ${m.agentId}: ${role}${resp ? ` — ${resp}` : ''}${promptLine}`
    })
    .join('\n')
}

export function buildTeamRunPrompt(team, userText) {
  const name = _cleanPromptText(team?.name, 80) || team?.id || '未命名团队'
  const description = _cleanPromptText(team?.description, 300)
  const leader = _cleanPromptText(team?.leaderAgentId, 48)
  const leaderRole = _cleanPromptText(team?.leaderRole, 40) || '团队协调者'
  const leaderPrompt = _cleanBlockText(team?.leaderPrompt, 1200)
  const members = _memberLines(team)
  const policy = team?.policy || {}
  const maxParallel = _effectiveMaxParallel(policy.maxParallel)
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
    '## 队长角色定义',
    `- 角色: ${leaderRole}`,
    leaderPrompt ? `- 提示词: ${leaderPrompt.replace(/\n/g, '\n  ')}` : '- 提示词: 先拆解任务,再按成员专长委派,最后汇总证据、风险和下一步。',
    '',
    '## 可委派成员',
    members || '- (无成员配置 — 请说明团队配置不完整)',
    '',
    '## 协作规则',
    '- 先把用户目标改写成可验证的成功标准,再给出简短任务拆解和任务账本。',
    `- 只允许委派给上面列出的 agentId;不要编造不存在的 agent。`,
    `- 需要成员产出时,使用 delegate_task(goal=..., agentId=..., context=...),并在 context 里交代用户目标、成功标准、相关附件/代码/约束、成员角色提示词、期望输出和交接摘要。`,
    '- 如果当前会话绑定了 GitHub 仓库,委派 context 必须写明 owner/repo、分支、本地工作目录,并要求成员以当前仓库 cwd 为准工作。',
    '- 必须等待每个已发起的 delegate_task 明确返回后再把该成员结论写入最终答案;未返回、报错或超时的委派只能列为缺口,不得假装已完成。',
    `- 同一个 agent 在不同团队可能有不同角色;委派时必须按本团队列出的角色定义和角色提示词要求成员工作。`,
    `- 可以把独立子任务分批推进,但最多同时推进 ${maxParallel} 条子任务;不要重复委派同一问题。`,
    '- 采用有上限的迭代闭环:首轮委派 → 汇总草案 → 对照成功标准检查缺口 → 如有关键缺口,最多再进行 1 轮有针对性的补充委派/修正。',
    '- 不要为了追求完美无限循环;达到成功标准后收敛输出,无法补齐的缺口必须明确列为局限或未完成事项。',
    reviewLine,
    '- 如果需要复核,先产出草案和缺口检查,再请复核 agent 检查遗漏、风险和错误;复核返回前不得声称已经完成复核。',
    '- 汇总时保留实际参与的 agent、每个成员的关键结论、缺口如何处理、风险和未完成事项。',
    '- 不要把协作过程写成聊天剧本;用任务账本呈现真实进度。',
    '',
    '## 最终输出格式',
    '1. 成功标准与协作计划',
    '2. 子任务账本(agent / 任务 / 状态 / 结果摘要)',
    '3. 缺口检查与迭代处理',
    '4. 最终结论或交付物',
    '5. 风险、验证和下一步',
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
    const sess = _currentSession()
    if (sess) sess._selectedTeamId = ''
    _writeStoredSelectedTeamId('')
    renderTeamDropdown()
    toast('团队配置不存在,已关闭团队模式', 'warning')
    return null
  }
  if (!_agentExists(team.leaderAgentId) && !state.agentsListIsFallback) {
    toast(`团队队长 agent 不存在: ${team.leaderAgentId}`, 'error')
    return false
  }
  const missingMembers = _missingAgentIds((team.members || []).map((m) => m.agentId))
  if (missingMembers.length > 0 && !state.agentsListIsFallback) {
    toast(`团队成员 agent 不存在: ${missingMembers.join(', ')}`, 'error')
    return false
  }
  const reviewAgentId = team.policy?.requireReview ? team.policy?.reviewAgentId : ''
  if (reviewAgentId && !_agentExists(reviewAgentId) && !state.agentsListIsFallback) {
    toast(`团队复核 agent 不存在: ${reviewAgentId}`, 'error')
    return false
  }
  return team
}

export function teamDisplayPrefix(team) {
  return `👥 ${team.name || team.id}`
}

export async function reloadAgentTeams() {
  const ownerUserId = _currentUserId()
  try {
    const data = await apiGet('/api/agent-teams')
    state.agentTeams = Array.isArray(data.teams) ? data.teams : []
    _agentTeamsLoaded = true
    _agentTeamsOwnerUserId = ownerUserId
  } catch (err) {
    console.warn('load agent teams failed:', err)
    // Transient reload failures should not erase the current user's selected
    // team. Preserve the previously loaded same-user list; clear only if the
    // list belongs to a different/unknown user to avoid cross-account leakage.
    if (!_agentTeamsLoaded || _agentTeamsOwnerUserId !== ownerUserId) {
      state.agentTeams = []
      _agentTeamsLoaded = false
      _agentTeamsOwnerUserId = ''
    }
    _emitTeamSelectionChanged()
    renderTeamDropdown()
    renderTeamsManagementList()
    return
  }
  const sess = _currentSession()
  const stored = _selectedTeamCandidateForSession(sess)
  state.selectedTeamId = state.agentTeams.some((t) => t.id === stored) ? stored : ''
  if (sess) sess._selectedTeamId = state.selectedTeamId
  if (state.selectedTeamId) _writeStoredSelectedTeamId(state.selectedTeamId)
  _emitTeamSelectionChanged()
  renderTeamDropdown()
  renderTeamsManagementList()
}

export function selectAgentTeam(teamId = '') {
  const nextTeamId = teamId && (state.agentTeams || []).some((t) => t.id === teamId) ? teamId : ''
  state.selectedTeamId = nextTeamId
  const sess = _currentSession()
  if (sess) {
    sess._selectedTeamId = nextTeamId
    scheduleSaveFromUserEdit(sess)
  }
  _writeStoredSelectedTeamId(nextTeamId)
  _emitTeamSelectionChanged()
}

export function clearSelectedAgentTeam() {
  selectAgentTeam('')
}

export function syncSelectedTeamForCurrentSession() {
  if (!_agentTeamsLoaded) return
  const sess = _currentSession()
  const stored = _selectedTeamCandidateForSession(sess)
  const nextTeamId = stored && (state.agentTeams || []).some((t) => t.id === stored) ? stored : ''
  state.selectedTeamId = nextTeamId
  if (sess) sess._selectedTeamId = nextTeamId
  if (nextTeamId) _writeStoredSelectedTeamId(nextTeamId)
  _emitTeamSelectionChanged()
  renderTeamDropdown()
}

export function getAgentTeamById(teamId = '') {
  return _teamById(teamId)
}

export function renderTeamDropdown() {
  // Legacy no-op: the composer no longer has a standalone #team-select.
}

export function renderTeamsManagementList() {
  const wrap = $('teams-list-wrap')
  if (!wrap) return
  wrap.innerHTML = ''

  const templateCard = document.createElement('div')
  templateCard.className = 'team-empty-card team-template-showcase'
  templateCard.innerHTML = `
    <div class="team-empty-title">推荐团队模板</div>
    <p>内置科研协作团队和编程协作团队，可直接预填并按需修改每个 Agent 的团队角色提示词。</p>
    <div class="team-template-grid" data-team-template-grid></div>`
  wrap.appendChild(templateCard)
  _renderTemplateButtons(templateCard.querySelector('[data-team-template-grid]'))

  if (!state.agentTeams || state.agentTeams.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'team-empty-card'
    empty.innerHTML = '<div class="team-empty-title">还没有保存的团队</div><p>点击上方模板或“新建团队”开始。</p>'
    wrap.appendChild(empty)
    return
  }
  for (const t of state.agentTeams) {
    const row = document.createElement('div')
    row.className = 'agent-row team-row agent-card-row'
    row.innerHTML = `
      <div class="agent-row-info">
        <div class="agent-row-title">👥 ${htmlSafeEscape(t.name || t.id)}</div>
        <div class="agent-row-sub">队长: ${htmlSafeEscape(t.leaderAgentId)} · 成员: ${
          (t.members || []).map((m) => htmlSafeEscape(m.agentId)).join(', ') || '—'
        }</div>
        <div class="agent-row-sub">角色: ${htmlSafeEscape(t.leaderRole || '团队协调者')} · ${
          (t.members || [])
            .map((m) => htmlSafeEscape(m.role || m.agentId))
            .join(' / ') || '—'
        }</div>
      </div>`
    const editBtn = document.createElement('button')
    editBtn.className = 'btn btn-secondary'
    editBtn.textContent = '编辑'
    editBtn.onclick = () => openTeamEditor(t.id)
    row.appendChild(editBtn)
    wrap.appendChild(row)
  }
}

function _renderTemplateButtons(container) {
  if (!container) return
  container.innerHTML = ''
  for (const template of TEAM_TEMPLATES) {
    const missing = _missingAgentIds(_templateRequiredAgentIds(template))
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `team-template-card${missing.length > 0 ? ' is-warning' : ''}`
    btn.title =
      missing.length > 0
        ? `当前列表暂未看到: ${missing.join(', ')}；仍可点击预填`
        : `使用模板: ${template.name}`
    btn.innerHTML = `
      <span class="team-template-badge">${htmlSafeEscape(template.badge)}</span>
      <strong>${htmlSafeEscape(template.name)}</strong>
      <span>${htmlSafeEscape(template.description)}</span>
      <em>${htmlSafeEscape(_templateRoleSummary(template))}</em>
      ${
        missing.length > 0
          ? `<small>当前列表暂未看到: ${htmlSafeEscape(missing.join(', '))}；仍可预填</small>`
          : '<small>已内置团队角色提示词,点击预填后可修改</small>'
      }`
    btn.addEventListener('click', () => _openTemplate(template))
    container.appendChild(btn)
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
  if (selected && !Array.from(el.options).some((opt) => opt.value === selected)) {
    const opt = document.createElement('option')
    opt.value = selected
    opt.textContent = `${selected} (当前列表不可见)`
    el.appendChild(opt)
  }
  el.value =
    selected ||
    (el.id === 'team-review-agent' ? '' : state.defaultAgentId || state.agentsList?.[0]?.id || '')
}

function _membersToText(members = []) {
  return members
    .map((m) =>
      [m.agentId, m.role || '', m.responsibility || '', m.rolePrompt || '']
        .join(' | ')
        .replace(/(\s+\|\s*)+$/, ''),
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
      const responsibility = rest.shift()
      return {
        agentId,
        role: role || undefined,
        responsibility: responsibility || undefined,
        rolePrompt: rest.join(' | ') || undefined,
      }
    })
}

export function openTeamEditor(teamId = '') {
  const team = teamId ? _teamById(teamId) : null
  _editingTeamId = team?.id || ''
  $('team-editor').hidden = false
  $('team-editor-title').textContent = team ? `编辑团队: ${team.name || team.id}` : '新建团队'
  const strip = $('team-template-strip')
  if (strip) {
    strip.hidden = Boolean(team)
    if (!team) _renderTemplateButtons(strip)
  }
  $('team-id').value = team?.id || ''
  $('team-id').disabled = Boolean(team)
  $('team-name').value = team?.name || ''
  $('team-description').value = team?.description || ''
  $('team-leader-role').value = team?.leaderRole || ''
  $('team-leader-prompt').value = team?.leaderPrompt || ''
  _fillAgentSelect($('team-leader'), team?.leaderAgentId)
  $('team-members').value = _membersToText(team?.members || [])
  $('team-max-parallel').value = String(_effectiveMaxParallel(team?.policy?.maxParallel))
  $('team-require-review').checked = Boolean(team?.policy?.requireReview)
  _fillAgentSelect($('team-review-agent'), team?.policy?.reviewAgentId || '')
  $('team-delete-btn').hidden = !team
}

function _openTemplate(template) {
  const missing = _missingAgentIds(_templateRequiredAgentIds(template))
  openTeamEditor('')
  $('team-id').value = _nextAvailableTeamId(template.id)
  $('team-name').value = template.name
  $('team-description').value = template.description || ''
  $('team-leader-role').value = template.leaderRole || ''
  $('team-leader-prompt').value = template.leaderPrompt || ''
  _fillAgentSelect($('team-leader'), template.leaderAgentId)
  $('team-members').value = _membersToText(template.members)
  $('team-max-parallel').value = String(_effectiveMaxParallel(template.policy?.maxParallel))
  $('team-require-review').checked = Boolean(template.policy?.requireReview)
  _fillAgentSelect($('team-review-agent'), template.policy?.reviewAgentId || '')
  if (missing.length > 0) {
    toast(
      `已预填「${template.name}」。当前列表暂未看到: ${missing.join(', ')};如保存失败,请先刷新或创建对应 agent。`,
      'warning',
    )
  } else {
    toast(`已预填「${template.name}」,确认后点击保存团队`, 'success')
  }
}

function _closeTeamEditor() {
  _editingTeamId = ''
  $('team-editor').hidden = true
  const strip = $('team-template-strip')
  if (strip) strip.hidden = true
}

async function _saveTeamEditor() {
  const id = $('team-id').value.trim()
  const body = {
    id,
    name: $('team-name').value.trim(),
    description: $('team-description').value.trim() || undefined,
    leaderAgentId: $('team-leader').value,
    leaderRole: $('team-leader-role').value.trim() || undefined,
    leaderPrompt: $('team-leader-prompt').value.trim() || undefined,
    members: _parseMembers($('team-members').value),
    policy: {
      maxParallel: _effectiveMaxParallel(Number($('team-max-parallel').value || 2)),
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
  if (
    !(await confirmDialog({
      title: '删除团队?',
      body: `删除团队 "${id}"?`,
      confirmText: '删除',
      danger: true,
    }))
  )
    return
  try {
    await apiJson('DELETE', `/api/agent-teams/${encodeURIComponent(id)}`)
    if (state.selectedTeamId === id) {
      clearSelectedAgentTeam()
    }
    toast('团队已删除', 'success')
    _closeTeamEditor()
    await reloadAgentTeams()
  } catch (err) {
    toast(String(err), 'error', toastOptsFromError(err))
  }
}

export function initAgentTeams() {
  $('new-team-btn')?.addEventListener('click', () => openTeamEditor(''))
  $('team-cancel-btn')?.addEventListener('click', _closeTeamEditor)
  $('team-save-btn')?.addEventListener('click', _saveTeamEditor)
  $('team-delete-btn')?.addEventListener('click', _deleteTeamEditor)
}
