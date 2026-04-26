import { apiGet, apiJson } from './api.js?v=55ce6b5'
// OpenClaude — Scheduled Tasks
import { $, htmlSafeEscape } from './dom.js?v=55ce6b5'
import { closeModal, openModal, toast, toastOptsFromError } from './ui.js?v=55ce6b5'
import { _cronHuman, shortTime } from './util.js?v=55ce6b5'

let _currentTasksTab = 'cron'

export async function openTasksModal() {
  const list = $('tasks-list')
  const empty = $('tasks-empty')
  list.innerHTML = ''
  empty.style.display = 'block'
  openModal('tasks-modal')
  try {
    const data = await apiGet('/api/cron')
    const jobs = data.jobs || []
    if (jobs.length === 0) {
      empty.style.display = 'block'
      return
    }
    empty.style.display = 'none'
    for (const job of jobs) {
      const row = document.createElement('div')
      row.className = 'agent-row'
      row.style.gap = '8px'
      const info = document.createElement('div')
      info.className = 'agent-row-info'
      info.style.flex = '1'
      const title = document.createElement('div')
      title.className = 'agent-row-title'
      title.style.fontSize = '13px'
      title.textContent = job.label || job.id
      if (job.oneshot) {
        const badge = document.createElement('span')
        badge.className = 'badge'
        badge.textContent = '一次性'
        badge.style.marginLeft = '6px'
        title.appendChild(badge)
      }
      const sub = document.createElement('div')
      sub.className = 'agent-row-sub'
      sub.style.fontSize = '12px'
      const schedText = _cronHuman(job.schedule)
      const nextText = job.nextRunAt ? ` · 下次: ${new Date(job.nextRunAt).toLocaleString()}` : ''
      sub.textContent = `${schedText}${nextText} · agent: ${job.agent}`
      info.appendChild(title)
      info.appendChild(sub)
      // Enable/disable toggle
      const toggle = document.createElement('button')
      toggle.className = 'btn btn-ghost'
      toggle.style.cssText = 'padding:4px 10px;min-height:28px;font-size:12px'
      toggle.textContent = job.enabled !== false ? '暂停' : '启用'
      toggle.onclick = async () => {
        try {
          await apiJson('PUT', `/api/cron/${encodeURIComponent(job.id)}`, {
            enabled: job.enabled === false,
          })
          await openTasksModal()
        } catch (err) {
          toast(String(err), 'error', toastOptsFromError(err))
        }
      }
      // Delete button
      const del = document.createElement('button')
      del.className = 'btn btn-ghost'
      del.style.cssText = 'padding:4px 10px;min-height:28px;font-size:12px;color:var(--danger)'
      del.textContent = '删除'
      del.onclick = async () => {
        if (!confirm(`删除任务 "${job.label || job.id}"?`)) return
        try {
          await apiJson('DELETE', `/api/cron/${encodeURIComponent(job.id)}`)
          toast('已删除')
          await openTasksModal()
        } catch (err) {
          toast(String(err), 'error', toastOptsFromError(err))
        }
      }
      row.appendChild(info)
      row.appendChild(toggle)
      row.appendChild(del)
      list.appendChild(row)
    }
  } catch (err) {
    list.innerHTML = `<p style="color:var(--danger)">加载失败: ${htmlSafeEscape(String(err))}</p>`
  }
}

export function switchTasksTab(tab) {
  _currentTasksTab = tab
  for (const t of ['cron', 'bg', 'log']) {
    const panel = $(`tasks-panel-${t}`)
    const btn = $(`tasks-tab-${t}`)
    if (panel) panel.hidden = t !== tab
    if (btn) btn.className = t === tab ? 'btn btn-secondary' : 'btn btn-ghost'
  }
  if (tab === 'bg') loadBgTasks()
  if (tab === 'log') loadExecLog()
}

export async function loadBgTasks() {
  const list = $('bg-tasks-list')
  const empty = $('bg-tasks-empty')
  if (!list) return
  list.innerHTML = ''
  try {
    const data = await apiGet('/api/tasks')
    const tasks = data.tasks || []
    empty.style.display = tasks.length === 0 ? 'block' : 'none'
    for (const t of tasks) {
      const row = document.createElement('div')
      row.className = 'agent-row'
      row.style.gap = '8px'
      const info = document.createElement('div')
      info.className = 'agent-row-info'
      info.style.flex = '1'
      const title = document.createElement('div')
      title.className = 'agent-row-title'
      title.style.fontSize = '13px'
      title.textContent = t.title || t.id
      const statusBadge = document.createElement('span')
      statusBadge.className = 'badge'
      statusBadge.style.marginLeft = '6px'
      statusBadge.textContent = t.status
      title.appendChild(statusBadge)
      const sub = document.createElement('div')
      sub.className = 'agent-row-sub'
      sub.style.fontSize = '12px'
      const parts = [`${t.trigger} · agent: ${t.agent} · runs: ${t.runCount}`]
      if (t.lastRunAt) parts.push(`last: ${new Date(t.lastRunAt).toLocaleString()}`)
      sub.textContent = parts.join(' · ')
      info.appendChild(title)
      info.appendChild(sub)
      const runBtn = document.createElement('button')
      runBtn.className = 'btn btn-ghost'
      runBtn.style.cssText = 'padding:4px 10px;min-height:28px;font-size:12px'
      runBtn.textContent = '执行'
      runBtn.onclick = async () => {
        try {
          await apiJson('POST', `/api/tasks/${encodeURIComponent(t.id)}`)
          toast('任务已触发')
        } catch (err) {
          toast(String(err), 'error', toastOptsFromError(err))
        }
      }
      const del = document.createElement('button')
      del.className = 'btn btn-ghost'
      del.style.cssText = 'padding:4px 10px;min-height:28px;font-size:12px;color:var(--danger)'
      del.textContent = '删除'
      del.onclick = async () => {
        if (!confirm(`删除任务 "${t.title}"?`)) return
        try {
          await apiJson('DELETE', `/api/tasks/${encodeURIComponent(t.id)}`)
          toast('已删除')
          await loadBgTasks()
        } catch (err) {
          toast(String(err), 'error', toastOptsFromError(err))
        }
      }
      row.appendChild(info)
      row.appendChild(runBtn)
      row.appendChild(del)
      list.appendChild(row)
    }
  } catch (err) {
    list.innerHTML = `<p style="color:var(--danger)">加载失败: ${htmlSafeEscape(String(err))}</p>`
  }
}

export async function loadExecLog() {
  const list = $('exec-log-list')
  const empty = $('exec-log-empty')
  if (!list) return
  list.innerHTML = ''
  try {
    const data = await apiGet('/api/tasks-executions')
    const execs = (data.executions || []).reverse() // newest first
    empty.style.display = execs.length === 0 ? 'block' : 'none'
    for (const ex of execs.slice(0, 30)) {
      const row = document.createElement('div')
      row.style.cssText =
        'display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px'
      const statusIcon = ex.status === 'completed' ? '✅' : ex.status === 'failed' ? '❌' : '⏳'
      const time = new Date(ex.startedAt).toLocaleString()
      const duration = ex.completedAt
        ? `${((ex.completedAt - ex.startedAt) / 1000).toFixed(1)}s`
        : '...'
      row.innerHTML = `<span>${statusIcon}</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${htmlSafeEscape(ex.taskId)}</span><span style="color:var(--text-secondary)">${time} · ${duration}</span>`
      if (ex.error) {
        row.title = `Error: ${ex.error}`
        row.style.color = 'var(--danger)'
      }
      list.appendChild(row)
    }
  } catch (err) {
    list.innerHTML = `<p style="color:var(--danger)">加载失败: ${htmlSafeEscape(String(err))}</p>`
  }
}

export function initTasksListeners() {
  // Tab switching for tasks modal
  for (const btn of document.querySelectorAll('[data-tasks-tab]')) {
    btn.addEventListener('click', () => switchTasksTab(btn.dataset.tasksTab))
  }
  // Wire up add-task modal
  $('tasks-add-btn')?.addEventListener('click', () => {
    $('task-message').value = ''
    $('task-cron').value = ''
    $('task-oneshot').checked = true
    openModal('add-task-modal')
  })
  $('task-save-btn')?.addEventListener('click', async () => {
    const message = $('task-message').value.trim()
    const cron = $('task-cron').value.trim()
    if (!message || !cron) {
      toast('请填写提醒内容和 cron 表达式', 'error')
      return
    }
    try {
      await apiJson('POST', '/api/cron', {
        schedule: cron,
        prompt: `请直接输出以下提醒内容,不要添加任何额外文字:\n\n⏰ 提醒: ${message}`,
        deliver: 'webchat',
        oneshot: $('task-oneshot').checked,
        label: message,
      })
      toast('提醒已创建', 'success')
      closeModal('add-task-modal')
      await openTasksModal()
    } catch (err) {
      toast(String(err), 'error', toastOptsFromError(err))
    }
  })
}
