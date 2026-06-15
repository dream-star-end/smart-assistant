import { apiGet, apiJson } from './api.js?v=cb18d789'
// OpenClaude — Context Hub: Memory + Skills + Automation
import { $, htmlSafeEscape } from './dom.js?v=cb18d789'
import { getSession, state } from './state.js?v=cb18d789'
import { confirmDialog, openModal, toast, toastOptsFromError } from './ui.js?v=cb18d789'
import { _cronHuman } from './util.js?v=cb18d789'

const MEMORY_DELIMITER = '\n§\n'
const CONTEXT_TABS = ['memory', 'skills', 'tasks']
const CONTEXT_PANEL_IDS = { memory: 'context-panel-memory', skills: 'context-panel-skills', tasks: 'context-panel-tasks' }
const TASK_TABS = ['cron', 'bg', 'log']
const TASK_PANEL_IDS = { cron: 'context-tasks-cron', bg: 'context-tasks-bg', log: 'context-tasks-log' }

let _hubBound = false
let _hubAgentId = null
let _hubTab = 'memory'
let _memoryTarget = 'memory'
let _memoryRawMode = false
let _memoryLoaded = { memory: false, user: false }
let _memoryRaw = { memory: '', user: '' }
let _memoryEntries = { memory: [], user: [] }
let _memoryDirty = false
let _skillsCache = []
let _selectedSkill = null
let _tasksTab = 'cron'

function _activeAgentId(agentId) {
  return agentId || getSession()?.agentId || state.defaultAgentId || 'main'
}

function _safeText(v) {
  return v == null ? '' : String(v)
}

function _splitMemoryEntries(raw) {
  if (!raw) return []
  return raw.replace(/\r\n/g, '\n').split(MEMORY_DELIMITER)
}

function _joinMemoryEntries(entries) {
  return entries
    .map((entry) => _safeText(entry).replace(/\r\n/g, '\n'))
    .filter((entry) => entry.trim())
    .join(MEMORY_DELIMITER)
}

function _shortDate(ts) {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return String(ts)
  }
}

function _setBusy(btn, busy, label) {
  if (!btn) return
  if (busy) {
    btn.dataset.prevText = btn.textContent || ''
    btn.textContent = label || '处理中…'
    btn.disabled = true
  } else {
    btn.textContent = btn.dataset.prevText || btn.textContent || ''
    btn.disabled = false
    delete btn.dataset.prevText
  }
}

function _syncMemoryEditorState() {
  if (_memoryRawMode) {
    const text = $('memory-raw-text')?.value || ''
    _memoryRaw[_memoryTarget] = text
    _memoryEntries[_memoryTarget] = _splitMemoryEntries(text)
  } else if (_memoryDirty) {
    _memoryRaw[_memoryTarget] = _joinMemoryEntries(_memoryEntries[_memoryTarget] || [])
  }
}

function _showFieldGroup(mode) {
  for (const group of document.querySelectorAll('[data-reminder-fields]')) {
    const modes = (group.dataset.reminderFields || '').split(',')
    group.hidden = !modes.includes(mode)
  }
  const oneshot = $('reminder-oneshot')
  if (oneshot && ['after', 'today', 'tomorrow'].includes(mode)) oneshot.checked = true
  if (oneshot && ['daily', 'weekly'].includes(mode)) oneshot.checked = false
  _updateReminderPreview()
}

function _parseTimeValue(value) {
  const m = String(value || '').match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return { hour, minute }
}

function _cronForDate(date) {
  return `${date.getMinutes()} ${date.getHours()} ${date.getDate()} ${date.getMonth() + 1} *`
}

export function buildReminderSchedule(mode, values = {}) {
  const now = values.now instanceof Date ? new Date(values.now.getTime()) : new Date()
  if (mode === 'after') {
    const minutes = Math.max(1, Math.floor(Number(values.minutes || 0)))
    if (!Number.isFinite(minutes)) throw new Error('请填写有效分钟数')
    return { schedule: _cronForDate(new Date(now.getTime() + minutes * 60_000)), oneshot: true }
  }
  if (mode === 'today' || mode === 'tomorrow') {
    const t = _parseTimeValue(values.time)
    if (!t) throw new Error('请填写 HH:mm 时间')
    const target = new Date(now.getTime())
    target.setHours(t.hour, t.minute, 0, 0)
    if (mode === 'tomorrow') target.setDate(target.getDate() + 1)
    if (mode === 'today' && target.getTime() <= now.getTime()) {
      throw new Error('今天这个时间已经过去，请选择明天或稍后时间')
    }
    return { schedule: _cronForDate(target), oneshot: true }
  }
  if (mode === 'daily') {
    const t = _parseTimeValue(values.time)
    if (!t) throw new Error('请填写 HH:mm 时间')
    return { schedule: `${t.minute} ${t.hour} * * *`, oneshot: false }
  }
  if (mode === 'weekly') {
    const t = _parseTimeValue(values.time)
    if (!t) throw new Error('请填写 HH:mm 时间')
    const weekday = Number(values.weekday)
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new Error('请选择星期')
    return { schedule: `${t.minute} ${t.hour} * * ${weekday}`, oneshot: false }
  }
  if (mode === 'advanced') {
    const schedule = String(values.cron || '').trim()
    if (!/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(schedule)) {
      throw new Error('Cron 必须是 5 段：分 时 日 月 周')
    }
    return { schedule, oneshot: values.oneshot !== false }
  }
  throw new Error('未知提醒类型')
}

function _readReminderForm() {
  const mode = $('reminder-mode')?.value || 'after'
  return buildReminderSchedule(mode, {
    minutes: $('reminder-minutes')?.value,
    time: $('reminder-time')?.value,
    weekday: $('reminder-weekday')?.value,
    cron: $('reminder-cron')?.value,
    oneshot: $('reminder-oneshot')?.checked,
  })
}

function _updateReminderPreview() {
  const el = $('reminder-preview')
  if (!el) return
  try {
    const { schedule, oneshot } = _readReminderForm()
    el.innerHTML = `<span>将创建：</span><code>${htmlSafeEscape(schedule)}</code><span>${oneshot ? '一次性提醒' : '重复提醒'}</span>`
  } catch (err) {
    el.innerHTML = `<span>${htmlSafeEscape(err?.message || '填写提醒信息后自动生成 Cron')}</span>`
  }
}

function _ensureHubBound() {
  if (_hubBound) return
  _hubBound = true

  for (const btn of document.querySelectorAll('[data-context-tab]')) {
    btn.addEventListener('click', () => switchContextHubTab(btn.dataset.contextTab))
  }
  for (const btn of document.querySelectorAll('[data-memory-target]')) {
    btn.addEventListener('click', () => loadMemoryTab(btn.dataset.memoryTarget))
  }
  $('memory-entry-search')?.addEventListener('input', () => _renderMemoryEntries())
  $('memory-raw-toggle')?.addEventListener('click', () => {
    _syncMemoryEditorState()
    _memoryRawMode = !_memoryRawMode
    _renderMemoryPanel()
  })
  $('memory-raw-text')?.addEventListener('input', () => {
    _memoryRaw[_memoryTarget] = $('memory-raw-text')?.value || ''
    _memoryDirty = true
    $('memory-count-pill').textContent = `${($('memory-raw-text')?.value || '').length} chars`
  })
  $('memory-add-entry')?.addEventListener('click', () => {
    _memoryEntries[_memoryTarget] = ['', ..._memoryEntries[_memoryTarget]]
    _memoryDirty = true
    _memoryRawMode = false
    _renderMemoryPanel()
    const first = document.querySelector('.memory-entry-card textarea')
    if (first) first.focus()
  })
  $('context-memory-save')?.addEventListener('click', () => saveMemory())

  $('skills-search')?.addEventListener('input', () => _renderSkillsList())
  $('skill-new-btn')?.addEventListener('click', () => _openSkillEditor())
  $('skill-editor-cancel')?.addEventListener('click', () => _closeSkillEditor())
  $('skill-editor-save')?.addEventListener('click', () => _saveSkillEditor())
  $('skill-delete-btn')?.addEventListener('click', () => _deleteSelectedSkill())

  for (const btn of document.querySelectorAll('[data-context-task-tab]')) {
    btn.addEventListener('click', () => switchContextTasksTab(btn.dataset.contextTaskTab))
  }
  $('reminder-mode')?.addEventListener('change', (e) => _showFieldGroup(e.target.value))
  for (const id of ['reminder-minutes', 'reminder-time', 'reminder-weekday', 'reminder-cron', 'reminder-oneshot']) {
    $(id)?.addEventListener('input', _updateReminderPreview)
    $(id)?.addEventListener('change', _updateReminderPreview)
  }
  $('context-task-save')?.addEventListener('click', () => _createReminder())
}

export async function openContextHub(tab = 'memory', agentId) {
  _ensureHubBound()
  const nextAgentId = _activeAgentId(agentId)
  if (_hubAgentId !== nextAgentId) {
    _memoryLoaded = { memory: false, user: false }
    _memoryRaw = { memory: '', user: '' }
    _memoryEntries = { memory: [], user: [] }
    _skillsCache = []
    _selectedSkill = null
  }
  _hubAgentId = nextAgentId
  $('context-hub-agent').textContent = _hubAgentId
  openModal('context-hub-modal')
  await switchContextHubTab(tab)
}

export async function openMemoryModal(agentId) {
  await openContextHub('memory', agentId)
}

export async function openSkillsModal(agentId) {
  await openContextHub('skills', agentId)
}

export async function switchContextHubTab(tab) {
  _hubTab = CONTEXT_TABS.includes(tab) ? tab : 'memory'
  for (const t of CONTEXT_TABS) {
    const btn = document.querySelector(`[data-context-tab="${t}"]`)
    const panel = $(CONTEXT_PANEL_IDS[t])
    btn?.classList.toggle('active', t === _hubTab)
    if (panel) panel.hidden = t !== _hubTab
  }
  if (_hubTab === 'memory') await _renderMemoryPanel(true)
  if (_hubTab === 'skills') await _loadSkills()
  if (_hubTab === 'tasks') await _loadTasksPanel()
}

export async function loadMemoryTab(target, agentId) {
  _hubAgentId = _activeAgentId(agentId || _hubAgentId)
  const nextTarget = target === 'user' ? 'user' : 'memory'
  if (
    nextTarget !== _memoryTarget &&
    _memoryDirty &&
    !(await confirmDialog({
      title: '放弃未保存改动?',
      body: '当前记忆有未保存改动,切换会丢弃这些改动。',
      confirmText: '继续切换',
      danger: true,
    }))
  ) {
    return
  }
  _syncMemoryEditorState()
  _memoryTarget = nextTarget
  _memoryDirty = false
  await _loadMemoryTarget(_memoryTarget)
  _renderMemoryPanel()
}

async function _loadMemoryTarget(target) {
  const id = _activeAgentId(_hubAgentId)
  const data = await apiGet(`/api/agents/${encodeURIComponent(id)}/memory/${target}`)
  const raw = _safeText(data.text || '')
  _memoryRaw[target] = raw
  _memoryEntries[target] = _splitMemoryEntries(raw)
  _memoryLoaded[target] = true
  return data
}

async function _renderMemoryPanel(ensureLoaded = false) {
  for (const t of ['memory', 'user']) {
    const btn = document.querySelector(`[data-memory-target="${t}"]`)
    btn?.classList.toggle('active', t === _memoryTarget)
  }
  if (ensureLoaded && !_memoryLoaded[_memoryTarget]) {
    $('memory-entries').innerHTML = '<div class="context-loading">读取记忆中…</div>'
    try {
      await _loadMemoryTarget(_memoryTarget)
    } catch (err) {
      toast(String(err), 'error', toastOptsFromError(err))
      $('memory-entries').innerHTML = `<div class="context-error">${htmlSafeEscape(String(err))}</div>`
      return
    }
  }
  const rawPanel = $('memory-raw-panel')
  const cardPanel = $('memory-card-panel')
  if (rawPanel) rawPanel.hidden = !_memoryRawMode
  if (cardPanel) cardPanel.hidden = _memoryRawMode
  $('memory-raw-toggle').textContent = _memoryRawMode ? '返回卡片编辑' : '高级原文编辑'
  $('memory-mode-note').textContent = _memoryRawMode
    ? '原文模式会按 textarea 内容精确保存，适合处理复杂格式或包含 § 的内容。'
    : '卡片模式只在你保存时重新序列化条目；复杂格式请切到原文模式。'
  const rawText = $('memory-raw-text')
  if (rawText && !_memoryRawMode) rawText.value = _memoryRaw[_memoryTarget]
  if (rawText && _memoryRawMode) rawText.value = _memoryRaw[_memoryTarget]
  _renderMemoryEntries()
}

function _renderMemoryEntries() {
  const wrap = $('memory-entries')
  const entries = _memoryEntries[_memoryTarget] || []
  const q = ($('memory-entry-search')?.value || '').trim().toLowerCase()
  const shown = entries
    .map((text, idx) => ({ text, idx }))
    .filter((item) => !q || item.text.toLowerCase().includes(q))
  const joined = _memoryRawMode ? $('memory-raw-text')?.value || '' : _joinMemoryEntries(entries)
  $('memory-count-pill').textContent = `${joined.length} chars`
  $('memory-entry-count').textContent = `${entries.filter((e) => e.trim()).length} 条`
  if (!wrap) return
  wrap.innerHTML = ''
  if (shown.length === 0) {
    wrap.innerHTML = `<div class="context-empty-card"><div class="context-empty-icon">🧠</div><strong>${q ? '没有匹配的记忆' : '还没有记忆条目'}</strong><p>${q ? '换个关键词搜索，或清空搜索。' : '点击“新增条目”，让 Agent 在后续对话中持续记住重要事实。'}</p></div>`
    return
  }
  for (const item of shown) {
    const card = document.createElement('div')
    card.className = 'memory-entry-card'
    const meta = document.createElement('div')
    meta.className = 'memory-entry-meta'
    meta.innerHTML = `<span>${_memoryTarget === 'user' ? '用户画像' : '助手观察'}</span><span>#${item.idx + 1}</span>`
    const textarea = document.createElement('textarea')
    textarea.value = item.text
    textarea.setAttribute('aria-label', `记忆条目 ${item.idx + 1}`)
    textarea.addEventListener('input', () => {
      _memoryEntries[_memoryTarget][item.idx] = textarea.value
      _memoryDirty = true
      $('memory-count-pill').textContent = `${_joinMemoryEntries(_memoryEntries[_memoryTarget]).length} chars`
    })
    const actions = document.createElement('div')
    actions.className = 'memory-entry-actions'
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'btn btn-ghost btn-sm danger-soft'
    del.textContent = '删除'
    del.addEventListener('click', () => {
      _memoryEntries[_memoryTarget].splice(item.idx, 1)
      _memoryDirty = true
      _renderMemoryPanel()
    })
    actions.appendChild(del)
    card.appendChild(meta)
    card.appendChild(textarea)
    card.appendChild(actions)
    wrap.appendChild(card)
  }
}

export async function saveMemory() {
  const id = _activeAgentId(_hubAgentId)
  const target = _memoryTarget
  const saveBtn = $('context-memory-save')
  let text
  if (_memoryRawMode) text = $('memory-raw-text')?.value || ''
  else text = _joinMemoryEntries(_memoryEntries[target] || [])
  _setBusy(saveBtn, true, '保存中…')
  try {
    await apiJson('PUT', `/api/agents/${encodeURIComponent(id)}/memory/${target}`, { text })
    _memoryRaw[target] = text
    _memoryEntries[target] = _splitMemoryEntries(text)
    _memoryLoaded[target] = true
    _memoryDirty = false
    toast('记忆已保存', 'success')
    await _renderMemoryPanel()
  } catch (err) {
    toast(String(err), 'error', toastOptsFromError(err))
  } finally {
    _setBusy(saveBtn, false)
  }
}

async function _loadSkills() {
  const wrap = $('context-skills-list')
  if (wrap) wrap.innerHTML = '<div class="context-loading">读取技能库中…</div>'
  try {
    const data = await apiGet(`/api/agents/${encodeURIComponent(_activeAgentId(_hubAgentId))}/skills`)
    _skillsCache = data.skills || []
    _selectedSkill = _skillsCache[0]?.name || null
    _renderSkillsList()
    if (_selectedSkill) await _loadSkillDetail(_selectedSkill)
    else _renderSkillEmpty()
  } catch (err) {
    if (wrap) wrap.innerHTML = `<div class="context-error">加载失败：${htmlSafeEscape(String(err))}</div>`
    toast(String(err), 'error', toastOptsFromError(err))
  }
}

function _renderSkillsList() {
  const wrap = $('context-skills-list')
  if (!wrap) return
  const q = ($('skills-search')?.value || '').trim().toLowerCase()
  const list = _skillsCache.filter((s) => {
    const hay = [s.name, s.description, ...(s.tags || []), s.source].join(' ').toLowerCase()
    return !q || hay.includes(q)
  })
  $('skills-count-pill').textContent = `${_skillsCache.length} skills`
  wrap.innerHTML = ''
  if (list.length === 0) {
    wrap.innerHTML = `<div class="context-empty-card"><div class="context-empty-icon">🛠️</div><strong>${q ? '没有匹配的技能' : '还没有自建技能'}</strong><p>复杂任务完成后 Agent 会自动沉淀 skill；你也可以手动新建。</p></div>`
    return
  }
  for (const s of list) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `skill-card${s.name === _selectedSkill ? ' active' : ''}`
    btn.innerHTML = `
      <span class="skill-card-top"><strong>${htmlSafeEscape(s.name)}</strong><span class="source-badge ${s.source === 'platform' ? 'platform' : 'user'}">${s.source === 'platform' ? '平台' : '自建'}</span></span>
      <span class="skill-card-desc">${htmlSafeEscape(s.description || '无描述')}</span>
      <span class="skill-card-tags">${(s.tags || []).slice(0, 4).map((tag) => `<span>${htmlSafeEscape(tag)}</span>`).join('')}</span>`
    btn.addEventListener('click', () => _loadSkillDetail(s.name))
    wrap.appendChild(btn)
  }
}

function _renderSkillEmpty() {
  $('skill-detail').innerHTML = '<div class="context-empty-card"><div class="context-empty-icon">✨</div><strong>选择一个技能查看详情</strong><p>技能会在相关任务开始前被 Agent 按需加载。</p></div>'
  $('skill-delete-btn').hidden = true
}

async function _loadSkillDetail(name) {
  _selectedSkill = name
  _renderSkillsList()
  const detail = $('skill-detail')
  detail.innerHTML = '<div class="context-loading">读取技能详情中…</div>'
  try {
    const data = await apiGet(`/api/agents/${encodeURIComponent(_activeAgentId(_hubAgentId))}/skills/${encodeURIComponent(name)}`)
    const skill = data.skill
    const canEdit = skill.source !== 'platform'
    detail.innerHTML = `
      <div class="skill-detail-head">
        <div><span class="source-badge ${skill.source === 'platform' ? 'platform' : 'user'}">${skill.source === 'platform' ? '平台只读' : '自建可编辑'}</span><h4>${htmlSafeEscape(skill.name)}</h4><p>${htmlSafeEscape(skill.description || '')}</p></div>
        <button type="button" id="skill-edit-inline" class="btn btn-secondary" ${canEdit ? '' : 'disabled'}>${canEdit ? '编辑' : '只读'}</button>
      </div>
      <div class="skill-detail-tags">${(skill.tags || []).map((tag) => `<span>${htmlSafeEscape(tag)}</span>`).join('')}</div>
      <pre class="skill-body-preview">${htmlSafeEscape(skill.body || skill.rawContent || '')}</pre>`
    $('skill-delete-btn').hidden = !canEdit
    detail.querySelector('#skill-edit-inline')?.addEventListener('click', () => _openSkillEditor(skill))
  } catch (err) {
    detail.innerHTML = `<div class="context-error">加载失败：${htmlSafeEscape(String(err))}</div>`
  }
}

function _openSkillEditor(skill) {
  $('skill-editor').hidden = false
  $('skill-editor-title').textContent = skill ? `编辑 ${skill.name}` : '新建技能'
  $('skill-editor-name').value = skill?.name || ''
  $('skill-editor-name').disabled = !!skill
  $('skill-editor-description').value = skill?.description || ''
  $('skill-editor-tags').value = (skill?.tags || []).join(', ')
  $('skill-editor-body').value = skill?.body || ''
  $('skill-editor-name').focus()
}

function _closeSkillEditor() {
  $('skill-editor').hidden = true
}

async function _saveSkillEditor() {
  const name = $('skill-editor-name').value.trim()
  const description = $('skill-editor-description').value.trim()
  const tags = $('skill-editor-tags').value.split(',').map((s) => s.trim()).filter(Boolean)
  const body = $('skill-editor-body').value.trim()
  if (!name || !description || !body) {
    toast('请填写技能名称、描述和正文', 'error')
    return
  }
  const btn = $('skill-editor-save')
  _setBusy(btn, true, '保存中…')
  try {
    await apiJson('PUT', `/api/agents/${encodeURIComponent(_activeAgentId(_hubAgentId))}/skills/${encodeURIComponent(name)}`, {
      description,
      tags,
      body,
    })
    toast('技能已保存', 'success')
    _closeSkillEditor()
    await _loadSkills()
    await _loadSkillDetail(name)
  } catch (err) {
    toast(String(err), 'error', toastOptsFromError(err))
  } finally {
    _setBusy(btn, false)
  }
}

async function _deleteSelectedSkill() {
  const skill = _selectedSkill
  if (!skill) return
  if (!(await confirmDialog({ title: '删除 Skill?', body: `删除 skill "${skill}"?`, confirmText: '删除', danger: true }))) return
  try {
    await apiJson('DELETE', `/api/agents/${encodeURIComponent(_activeAgentId(_hubAgentId))}/skills/${encodeURIComponent(skill)}`)
    toast('技能已删除')
    await _loadSkills()
  } catch (err) {
    toast(String(err), 'error', toastOptsFromError(err))
  }
}

export async function switchContextTasksTab(tab) {
  _tasksTab = TASK_TABS.includes(tab) ? tab : 'cron'
  for (const t of TASK_TABS) {
    const btn = document.querySelector(`[data-context-task-tab="${t}"]`)
    const panel = $(TASK_PANEL_IDS[t])
    btn?.classList.toggle('active', t === _tasksTab)
    if (panel) panel.hidden = t !== _tasksTab
  }
  await _loadTasksPanel()
}

async function _loadTasksPanel() {
  _showFieldGroup($('reminder-mode')?.value || 'after')
  if (_tasksTab === 'cron') await _loadCronTasks()
  if (_tasksTab === 'bg') await _loadBgTasks()
  if (_tasksTab === 'log') await _loadExecLog()
}

async function _loadCronTasks() {
  const list = $('context-cron-list')
  list.innerHTML = '<div class="context-loading">读取定时任务中…</div>'
  try {
    const data = await apiGet('/api/cron')
    const jobs = data.jobs || []
    $('tasks-count-pill').textContent = `${jobs.length} tasks`
    list.innerHTML = ''
    if (jobs.length === 0) {
      list.innerHTML = '<div class="context-empty-card"><div class="context-empty-icon">⏰</div><strong>暂无定时任务</strong><p>用上面的快捷表单创建一次性提醒或重复自动化。</p></div>'
      return
    }
    for (const job of jobs) list.appendChild(_cronJobCard(job))
  } catch (err) {
    list.innerHTML = `<div class="context-error">加载失败：${htmlSafeEscape(String(err))}</div>`
  }
}

function _cronJobCard(job) {
  const row = document.createElement('div')
  row.className = `automation-card${job.enabled === false ? ' paused' : ''}`
  const next = job.nextRunAt ? `下次 ${_shortDate(job.nextRunAt)}` : '已暂停'
  row.innerHTML = `
    <div class="automation-main">
      <div class="automation-title"><span>${htmlSafeEscape(job.label || job.id)}</span>${job.oneshot ? '<span class="mini-badge">一次性</span>' : '<span class="mini-badge repeat">重复</span>'}</div>
      <div class="automation-meta">${htmlSafeEscape(_cronHuman(job.schedule))} · ${htmlSafeEscape(next)} · agent: ${htmlSafeEscape(job.agent || 'main')}</div>
      <code>${htmlSafeEscape(job.schedule)}</code>
    </div>
    <div class="automation-actions"></div>`
  const actions = row.querySelector('.automation-actions')
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'btn btn-ghost btn-sm'
  toggle.textContent = job.enabled === false ? '启用' : '暂停'
  toggle.addEventListener('click', async () => {
    try {
      await apiJson('PUT', `/api/cron/${encodeURIComponent(job.id)}`, { enabled: job.enabled === false })
      await _loadCronTasks()
    } catch (err) {
      toast(String(err), 'error', toastOptsFromError(err))
    }
  })
  const del = document.createElement('button')
  del.type = 'button'
  del.className = 'btn btn-ghost btn-sm danger-soft'
  del.textContent = '删除'
  del.addEventListener('click', async () => {
    if (!(await confirmDialog({ title: '删除任务?', body: `删除任务 "${job.label || job.id}"?`, confirmText: '删除', danger: true }))) return
    try {
      await apiJson('DELETE', `/api/cron/${encodeURIComponent(job.id)}`)
      toast('已删除')
      await _loadCronTasks()
    } catch (err) {
      toast(String(err), 'error', toastOptsFromError(err))
    }
  })
  actions.appendChild(toggle)
  actions.appendChild(del)
  return row
}

async function _createReminder() {
  const message = $('reminder-message').value.trim()
  if (!message) {
    toast('请填写提醒内容', 'error')
    return
  }
  let built
  try {
    built = _readReminderForm()
  } catch (err) {
    toast(err.message || String(err), 'error')
    return
  }
  const btn = $('context-task-save')
  _setBusy(btn, true, '创建中…')
  try {
    await apiJson('POST', '/api/cron', {
      schedule: built.schedule,
      prompt: `请直接输出以下提醒内容,不要添加任何额外文字:\n\n⏰ 提醒: ${message}`,
      deliver: 'webchat',
      oneshot: built.oneshot,
      label: message,
    })
    toast('提醒已创建', 'success')
    $('reminder-message').value = ''
    await _loadCronTasks()
  } catch (err) {
    toast(String(err), 'error', toastOptsFromError(err))
  } finally {
    _setBusy(btn, false)
  }
}

async function _loadBgTasks() {
  const list = $('context-bg-list')
  list.innerHTML = '<div class="context-loading">读取后台任务中…</div>'
  try {
    const data = await apiGet('/api/tasks')
    const tasks = data.tasks || []
    list.innerHTML = ''
    if (tasks.length === 0) {
      list.innerHTML = '<div class="context-empty-card"><div class="context-empty-icon">📌</div><strong>暂无后台任务</strong><p>未来的长期任务、Webhook 和站立规则会显示在这里。</p></div>'
      return
    }
    for (const t of tasks) {
      const row = document.createElement('div')
      row.className = 'automation-card'
      row.innerHTML = `<div class="automation-main"><div class="automation-title"><span>${htmlSafeEscape(t.title || t.id)}</span><span class="mini-badge">${htmlSafeEscape(t.status)}</span></div><div class="automation-meta">${htmlSafeEscape(t.trigger)} · agent: ${htmlSafeEscape(t.agent)} · runs: ${t.runCount || 0}${t.lastRunAt ? ` · last ${_shortDate(t.lastRunAt)}` : ''}</div></div><div class="automation-actions"></div>`
      const runBtn = document.createElement('button')
      runBtn.type = 'button'
      runBtn.className = 'btn btn-ghost btn-sm'
      runBtn.textContent = '执行'
      runBtn.addEventListener('click', async () => {
        try {
          await apiJson('POST', `/api/tasks/${encodeURIComponent(t.id)}`)
          toast('任务已触发')
        } catch (err) {
          toast(String(err), 'error', toastOptsFromError(err))
        }
      })
      row.querySelector('.automation-actions').appendChild(runBtn)
      list.appendChild(row)
    }
  } catch (err) {
    list.innerHTML = `<div class="context-error">加载失败：${htmlSafeEscape(String(err))}</div>`
  }
}

async function _loadExecLog() {
  const list = $('context-log-list')
  list.innerHTML = '<div class="context-loading">读取执行记录中…</div>'
  try {
    const data = await apiGet('/api/tasks-executions')
    const execs = (data.executions || []).slice().reverse().slice(0, 30)
    list.innerHTML = ''
    if (execs.length === 0) {
      list.innerHTML = '<div class="context-empty-card"><div class="context-empty-icon">📜</div><strong>暂无执行记录</strong><p>提醒或后台任务执行后会在这里保留最近记录。</p></div>'
      return
    }
    for (const ex of execs) {
      const row = document.createElement('div')
      row.className = `execution-row ${ex.status}`
      const duration = ex.completedAt ? `${((ex.completedAt - ex.startedAt) / 1000).toFixed(1)}s` : '运行中'
      row.innerHTML = `<span>${ex.status === 'completed' ? '✓' : ex.status === 'failed' ? '✕' : '…'}</span><strong>${htmlSafeEscape(ex.taskId)}</strong><em>${_shortDate(ex.startedAt)} · ${duration}</em>`
      if (ex.error) row.title = ex.error
      list.appendChild(row)
    }
  } catch (err) {
    list.innerHTML = `<div class="context-error">加载失败：${htmlSafeEscape(String(err))}</div>`
  }
}
