// OpenClaude — Current-session plan / TodoWrite quick panel
import { $, htmlSafeEscape } from './dom.js?v=b9adb66b'
import { processRichBlocks, renderMarkdown, renderStreamingMarkdown } from './markdown.js?v=b9adb66b'
import { getSession } from './state.js?v=b9adb66b'

let _open = false
let _initialized = false

function _normalizeStatus(status) {
  if (status === 'inProgress') return 'in_progress'
  return status || 'pending'
}

function _statusLabel(status) {
  const s = _normalizeStatus(status)
  if (s === 'completed') return '完成'
  if (s === 'in_progress') return '进行中'
  return '待处理'
}

function _todoContent(t) {
  if (!t || typeof t !== 'object') return ''
  return _normalizeStatus(t.status) === 'in_progress' && t.activeForm ? t.activeForm : t.content || ''
}

export function getLatestPlanAndTodos(sess = getSession()) {
  const messages = Array.isArray(sess?.messages) ? sess.messages : []
  let plan = null
  let progressPlan = null
  let todo = null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role === 'plan') {
      if (!plan && typeof m.text === 'string' && m.text.trim()) plan = m
      if (!progressPlan && Array.isArray(m.steps) && m.steps.length > 0) progressPlan = m
    }
    if (!todo && m?.role === 'tool' && m.toolName === 'TodoWrite') {
      const todos = Array.isArray(m.inputJson?.todos) ? m.inputJson.todos : null
      if (todos && todos.length > 0) todo = { msg: m, todos, source: 'todo' }
    }
    if (plan && todo) break
  }

  // Prefer the generated plan document for the Current Plan section. If an
  // older session only has a structured plan table, keep that as a fallback.
  const displayPlan = plan || progressPlan

  if (!todo && Array.isArray(progressPlan?.steps) && progressPlan.steps.length > 0) {
    todo = {
      msg: progressPlan,
      source: 'plan',
      todos: progressPlan.steps.map((s) => ({
        status: _normalizeStatus(s?.status),
        content: s?.step || '',
        activeForm: s?.step || '',
      })),
    }
  }
  return { plan: displayPlan, todo }
}

function _ensurePanel() {
  if (_initialized) return
  _initialized = true

  const actions = document.querySelector('.head-actions')
  if (actions && !$('plan-panel-btn')) {
    const btn = document.createElement('button')
    btn.id = 'plan-panel-btn'
    btn.type = 'button'
    btn.className = 'icon-btn plan-panel-btn'
    btn.title = '查看当前会话的计划和任务进度'
    btn.setAttribute('aria-label', '计划和任务进度')
    btn.hidden = true
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg><span id="plan-panel-badge" class="plan-panel-badge" hidden></span>'
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      openPlanPanel()
    })
    const tasksBtn = $('tasks-btn')
    actions.insertBefore(btn, tasksBtn || actions.firstChild)
  }

  if (!$('plan-panel-backdrop')) {
    const backdrop = document.createElement('div')
    backdrop.id = 'plan-panel-backdrop'
    backdrop.className = 'plan-panel-backdrop'
    backdrop.hidden = true
    backdrop.addEventListener('click', closePlanPanel)
    document.body.appendChild(backdrop)
  }

  if (!$('plan-panel')) {
    const panel = document.createElement('aside')
    panel.id = 'plan-panel'
    panel.className = 'plan-panel'
    panel.hidden = true
    panel.setAttribute('aria-label', '当前计划和任务进度')
    panel.innerHTML = `
      <div class="plan-panel-head">
        <div>
          <div class="plan-panel-kicker">当前会话</div>
          <h3>计划与任务</h3>
        </div>
        <button id="plan-panel-close" type="button" class="icon-btn" aria-label="关闭计划面板">&times;</button>
      </div>
      <div id="plan-panel-content" class="plan-panel-content"></div>
    `
    document.body.appendChild(panel)
    $('plan-panel-close')?.addEventListener('click', closePlanPanel)
  }
}

function _jumpToMessage(id) {
  if (!id) return
  const el = document.querySelector(`[data-msg-id="${CSS.escape(id)}"]`)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  el.classList.add('plan-panel-jump-highlight')
  setTimeout(() => el.classList.remove('plan-panel-jump-highlight'), 1400)
  closePlanPanel()
}

function _renderMarkdownInto(el, text, partial = false) {
  const raw = text || ''
  el.innerHTML = partial ? renderStreamingMarkdown(raw) : renderMarkdown(raw)
}

function _renderPlanSection(root, plan) {
  const section = document.createElement('section')
  section.className = 'plan-panel-section'
  const stateText = plan ? (plan._partial ? '生成中' : '待确认') : '暂无'
  section.innerHTML = `
    <div class="plan-panel-section-head">
      <h4>当前计划</h4>
      <span class="plan-panel-section-state">${htmlSafeEscape(stateText)}</span>
    </div>
  `

  if (!plan) {
    const empty = document.createElement('div')
    empty.className = 'plan-panel-empty'
    empty.textContent = '当前会话还没有生成计划。'
    section.appendChild(empty)
    root.appendChild(section)
    return
  }

  if (plan.text) {
    const draft = document.createElement('div')
    draft.className = 'plan-panel-markdown plan-panel-draft'
    _renderMarkdownInto(draft, plan.text, !!plan._partial)
    section.appendChild(draft)
  } else if (plan.explanation) {
    const explanation = document.createElement('div')
    explanation.className = 'plan-panel-markdown plan-panel-explanation'
    _renderMarkdownInto(explanation, plan.explanation, !!plan._partial)
    section.appendChild(explanation)
  }

  if (!plan.text && Array.isArray(plan.steps) && plan.steps.length > 0) {
    const steps = document.createElement('div')
    steps.className = 'plan-panel-steps'
    for (const s of plan.steps) {
      if (!s || typeof s !== 'object') continue
      const status = _normalizeStatus(s.status)
      const row = document.createElement('div')
      row.className = `plan-panel-step ${status}`
      const mark = document.createElement('span')
      mark.className = 'plan-panel-step-mark'
      mark.textContent = status === 'completed' ? '✓' : status === 'in_progress' ? '◐' : '○'
      const body = document.createElement('div')
      body.className = 'plan-panel-step-body'
      const label = document.createElement('div')
      label.className = 'plan-panel-step-status'
      label.textContent = _statusLabel(status)
      const text = document.createElement('div')
      text.className = 'plan-panel-step-text'
      text.textContent = s.step || ''
      body.appendChild(label)
      body.appendChild(text)
      row.appendChild(mark)
      row.appendChild(body)
      steps.appendChild(row)
    }
    section.appendChild(steps)
  }

  const actions = document.createElement('div')
  actions.className = 'plan-panel-actions'
  const jump = document.createElement('button')
  jump.type = 'button'
  jump.className = 'btn btn-ghost plan-panel-jump'
  jump.textContent = '在对话中查看'
  jump.addEventListener('click', () => _jumpToMessage(plan.id))
  actions.appendChild(jump)
  section.appendChild(actions)
  root.appendChild(section)
}

function _renderTodoSection(root, todo) {
  const section = document.createElement('section')
  section.className = 'plan-panel-section'
  const todos = todo?.todos || []
  const done = todos.filter((t) => _normalizeStatus(t?.status) === 'completed').length
  const current = todos.find((t) => _normalizeStatus(t?.status) === 'in_progress')
  section.innerHTML = `
    <div class="plan-panel-section-head">
      <h4>任务进度</h4>
      <span class="plan-panel-section-state">${todos.length ? `${done}/${todos.length}` : '暂无'}</span>
    </div>
  `

  if (!todos.length) {
    const empty = document.createElement('div')
    empty.className = 'plan-panel-empty'
    empty.textContent = '当前会话还没有任务列表。'
    section.appendChild(empty)
    root.appendChild(section)
    return
  }

  const progress = document.createElement('div')
  progress.className = 'plan-panel-progress'
  const bar = document.createElement('div')
  bar.className = 'plan-panel-progress-bar'
  bar.style.width = `${Math.round((done / todos.length) * 100)}%`
  progress.appendChild(bar)
  section.appendChild(progress)

  if (current) {
    const active = document.createElement('div')
    active.className = 'plan-panel-active-task'
    active.textContent = `当前: ${_todoContent(current)}`
    section.appendChild(active)
  }

  const list = document.createElement('div')
  list.className = 'plan-panel-todos'
  for (const t of todos) {
    if (!t || typeof t !== 'object') continue
    const status = _normalizeStatus(t.status)
    const row = document.createElement('div')
    row.className = `plan-panel-todo ${status}`
    const mark = document.createElement('span')
    mark.className = 'plan-panel-todo-mark'
    mark.textContent = status === 'completed' ? '✓' : status === 'in_progress' ? '◐' : '○'
    const text = document.createElement('span')
    text.className = 'plan-panel-todo-text'
    text.textContent = _todoContent(t)
    row.appendChild(mark)
    row.appendChild(text)
    list.appendChild(row)
  }
  section.appendChild(list)

  const actions = document.createElement('div')
  actions.className = 'plan-panel-actions'
  const jump = document.createElement('button')
  jump.type = 'button'
  jump.className = 'btn btn-ghost plan-panel-jump'
  jump.textContent = '在对话中查看'
  jump.addEventListener('click', () => _jumpToMessage(todo.msg.id))
  actions.appendChild(jump)
  section.appendChild(actions)
  root.appendChild(section)
}

export function refreshPlanPanel() {
  _ensurePanel()
  const { plan, todo } = getLatestPlanAndTodos()
  const btn = $('plan-panel-btn')
  const badge = $('plan-panel-badge')
  const hasContent = !!plan || !!todo
  if (btn) {
    btn.hidden = !hasContent
    btn.setAttribute('aria-expanded', _open ? 'true' : 'false')
  }
  if (badge) {
    if (todo?.todos?.length) {
      const done = todo.todos.filter((t) => _normalizeStatus(t?.status) === 'completed').length
      badge.hidden = false
      badge.textContent = `${done}/${todo.todos.length}`
    } else {
      badge.hidden = !plan
      badge.textContent = plan ? '•' : ''
    }
  }

  const content = $('plan-panel-content')
  if (!content) return
  content.innerHTML = ''
  if (!hasContent) {
    const empty = document.createElement('div')
    empty.className = 'plan-panel-empty plan-panel-empty-main'
    empty.textContent = '当前会话还没有计划或任务列表。'
    content.appendChild(empty)
  } else {
    _renderPlanSection(content, plan)
    _renderTodoSection(content, todo)
  }
  if (!_open && !hasContent) closePlanPanel()
  processRichBlocks()
}

export function openPlanPanel() {
  _ensurePanel()
  _open = true
  refreshPlanPanel()
  const panel = $('plan-panel')
  const backdrop = $('plan-panel-backdrop')
  if (panel) {
    panel.hidden = false
    requestAnimationFrame(() => panel.classList.add('open'))
  }
  if (backdrop) {
    backdrop.hidden = false
    requestAnimationFrame(() => backdrop.classList.add('open'))
  }
  $('plan-panel-btn')?.setAttribute('aria-expanded', 'true')
}

export function closePlanPanel() {
  _open = false
  const panel = $('plan-panel')
  const backdrop = $('plan-panel-backdrop')
  panel?.classList.remove('open')
  backdrop?.classList.remove('open')
  setTimeout(() => {
    if (!_open) {
      if (panel) panel.hidden = true
      if (backdrop) backdrop.hidden = true
    }
  }, 180)
  $('plan-panel-btn')?.setAttribute('aria-expanded', 'false')
}

export function initPlanPanel() {
  _ensurePanel()
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _open) closePlanPanel()
  })
  refreshPlanPanel()
}
