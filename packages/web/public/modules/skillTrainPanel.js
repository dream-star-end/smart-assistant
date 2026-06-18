// SkillOpt training panel — vanilla JS, self-contained overlay.
//
// Drives the async train → diff → confirm-merge UX for one user skill:
//   start training → poll run status (progress) → on diff_ready render a line diff
//   of each staged draft vs the live skill → user can comment (AI revises), edit the
//   draft manually, then merge (promote to the authoritative library) or discard.
//
// Backend (gateway): POST /api/skills/:name/train, GET/DELETE /api/skill-training/:id,
// GET .../drafts, GET/PUT .../drafts/:name, POST .../drafts/:name/comment, POST .../merge.

import { apiGet, apiJson } from './api.js?v=c9d2ed11'
import { htmlSafeEscape } from './dom.js?v=c9d2ed11'
import { toast } from './ui.js?v=c9d2ed11'

const PHASE_LABEL = {
  queued: '排队中',
  scanning_sessions: '扫描历史会话',
  evaluating: '评估现有技能',
  drafting: '生成候选草稿',
  diff_ready: '草稿就绪,待确认',
  done: '完成',
  failed: '失败',
}
const PHASE_PCT = {
  queued: 8,
  scanning_sessions: 30,
  evaluating: 55,
  drafting: 80,
  diff_ready: 100,
  done: 100,
  failed: 100,
}
const POLL_MS = 1500

let _overlay = null
let _skillName = null
let _runId = null
let _pollTimer = null
let _stylesInjected = false
let _editing = new Set() // skill names currently in manual-edit mode

export function openSkillTrainPanel(skillName) {
  _skillName = skillName
  _runId = null
  _editing = new Set()
  _ensureStyles()
  _ensureOverlay()
  _renderIdle()
  _overlay.hidden = false
}

function _close() {
  _stopPoll()
  if (_overlay) _overlay.hidden = true
  _runId = null
}

function _stopPoll() {
  if (_pollTimer) {
    clearInterval(_pollTimer)
    _pollTimer = null
  }
}

function _ensureOverlay() {
  if (_overlay) return
  _overlay = document.createElement('div')
  _overlay.className = 'skt-backdrop'
  _overlay.hidden = true
  _overlay.innerHTML = `
    <div class="skt-modal" role="dialog" aria-modal="true" aria-label="技能训练优化">
      <div class="skt-head">
        <h3>技能训练优化</h3>
        <button type="button" class="skt-x" aria-label="关闭">✕</button>
      </div>
      <div class="skt-body"></div>
    </div>`
  _overlay.addEventListener('click', (e) => {
    if (e.target === _overlay) _close()
  })
  _overlay.querySelector('.skt-x').addEventListener('click', () => _close())
  document.body.appendChild(_overlay)
}

function _body() {
  return _overlay.querySelector('.skt-body')
}

function _renderIdle() {
  _stopPoll()
  _body().innerHTML = `
    <p class="skt-intro">基于你最近的真实会话,用 DeepSeek 优化技能
      <strong>${htmlSafeEscape(_skillName)}</strong>。训练只产出<strong>草稿</strong>,
      你确认 diff 后才会合入,过程中可随时评论让 AI 修订或手动改。</p>
    <label class="skt-focus">训练侧重(可选)
      <input type="text" class="skt-focus-input" placeholder="例如:补充部署的缓存失效步骤" />
    </label>
    <div class="skt-actions">
      <button type="button" class="skt-btn skt-btn-primary skt-start">开始训练</button>
    </div>`
  _body()
    .querySelector('.skt-start')
    .addEventListener('click', () => _start())
}

async function _start() {
  const focus = _body().querySelector('.skt-focus-input')?.value.trim() || undefined
  const startBtn = _body().querySelector('.skt-start')
  if (startBtn) {
    startBtn.disabled = true
    startBtn.textContent = '启动中…'
  }
  try {
    const r = await apiJson('POST', `/api/skills/${encodeURIComponent(_skillName)}/train`, {
      focus,
    })
    _runId = r.runId
    _renderProgress({ status: 'queued', phase: 'queued', proposalCount: 0, toolCalls: 0 })
    _startPoll()
  } catch (err) {
    toast(`无法启动训练:${String(err)}`, 'error')
    _renderIdle()
  }
}

function _startPoll() {
  _stopPoll()
  _pollTimer = setInterval(_poll, POLL_MS)
}

async function _poll() {
  if (!_runId) return
  try {
    const { run } = await apiGet(`/api/skill-training/${encodeURIComponent(_runId)}`)
    if (!run) return
    if (run.status === 'diff_ready' || run.status === 'merged') {
      _stopPoll()
      await _renderDiffReady(run)
    } else if (run.status === 'failed') {
      _stopPoll()
      _renderTerminal(`训练失败:${htmlSafeEscape(run.error || '未知错误')}`)
    } else if (run.status === 'discarded') {
      _stopPoll()
      _renderTerminal('本次训练未产出可用候选([SILENT])。')
    } else {
      _renderProgress(run)
    }
  } catch {
    // transient; keep polling
  }
}

function _renderProgress(run) {
  const pct = PHASE_PCT[run.phase] ?? 10
  _body().innerHTML = `
    <div class="skt-progress">
      <div class="skt-phase">${htmlSafeEscape(PHASE_LABEL[run.phase] || run.phase)}</div>
      <div class="skt-bar"><div class="skt-bar-fill" style="width:${pct}%"></div></div>
      <div class="skt-stat">已检视工具调用 ${run.toolCalls || 0} 次 · 已生成候选 ${run.proposalCount || 0} 个</div>
      <div class="skt-spinner">训练进行中,可关闭面板稍后回来——进度不丢。</div>
    </div>`
}

function _renderTerminal(html) {
  _body().innerHTML = `<div class="skt-terminal">${html}</div>
    <div class="skt-actions"><button type="button" class="skt-btn skt-again">重新训练</button></div>`
  _body()
    .querySelector('.skt-again')
    .addEventListener('click', () => _renderIdle())
}

async function _renderDiffReady(run) {
  const { drafts } = await apiGet(`/api/skill-training/${encodeURIComponent(_runId)}/drafts`)
  if (!drafts || drafts.length === 0) {
    _renderTerminal('没有待确认的草稿。')
    return
  }
  _body().innerHTML = `
    <div class="skt-diffhead">
      <span>训练完成,生成 ${drafts.length} 个候选。逐个审阅后合入,或丢弃整次训练。</span>
      <div class="skt-diffhead-actions">
        <button type="button" class="skt-btn skt-merge-all">全部合入</button>
        <button type="button" class="skt-btn skt-discard">丢弃</button>
      </div>
    </div>
    <div class="skt-drafts"></div>`
  _body()
    .querySelector('.skt-merge-all')
    .addEventListener('click', () => _merge())
  _body()
    .querySelector('.skt-discard')
    .addEventListener('click', () => _discard())
  const host = _body().querySelector('.skt-drafts')
  for (const d of drafts) {
    host.appendChild(await _renderDraftCard(d))
  }
}

async function _renderDraftCard(summary) {
  const card = document.createElement('div')
  card.className = 'skt-draft'
  const name = summary.name
  let detail
  try {
    detail = await apiGet(
      `/api/skill-training/${encodeURIComponent(_runId)}/drafts/${encodeURIComponent(name)}`,
    )
  } catch (err) {
    card.innerHTML = `<div class="skt-error">读取草稿 ${htmlSafeEscape(name)} 失败</div>`
    return card
  }
  const draft = detail.draft
  const current = detail.current
  const op = draft.record.op
  const opLabel = { create: '新建', update: '更新', delete: '删除' }[op] || op
  const oldText = op === 'create' ? '' : current?.body || ''
  const newText = op === 'delete' ? '' : draft.body || ''

  card.innerHTML = `
    <div class="skt-draft-head">
      <span class="skt-op skt-op-${op}">${opLabel}</span>
      <strong>${htmlSafeEscape(name)}</strong>
      <span class="skt-author">${draft.record.authoredBy === 'user' ? '手动修改' : 'AI 提案'}</span>
    </div>
    <div class="skt-rationale">${htmlSafeEscape(draft.record.rationale || '')}</div>
    <div class="skt-diff">${_renderLineDiff(oldText, newText)}</div>
    <div class="skt-draft-tools">
      <button type="button" class="skt-link skt-edit">手动编辑</button>
      <button type="button" class="skt-btn skt-btn-primary skt-merge-one">合入此项</button>
    </div>
    <div class="skt-comment">
      <textarea class="skt-comment-input" rows="2" placeholder="对这个草稿提意见,AI 实时修订…"></textarea>
      <button type="button" class="skt-btn skt-comment-send">发给 AI 修订</button>
    </div>`

  card.querySelector('.skt-merge-one').addEventListener('click', () => _merge(name))
  card.querySelector('.skt-edit').addEventListener('click', () => _toggleEdit(card, name, draft))
  card.querySelector('.skt-comment-send').addEventListener('click', () => {
    const c = card.querySelector('.skt-comment-input').value.trim()
    if (c) _comment(name, c)
  })
  return card
}

// Minimal LCS line diff → rows tagged same/add/del.
function _renderLineDiff(oldText, newText) {
  const a = oldText ? oldText.split('\n') : []
  const b = newText ? newText.split('\n') : []
  const n = a.length
  const m = b.length
  // LCS is O(n*m); for very large skills fall back to a plain del-all/add-all block
  // rather than freeze the UI building an n*m table.
  if (n * m > 400_000) {
    const del = a.map(
      (l) =>
        `<div class="skt-row skt-del"><span class="skt-sign">-</span>${htmlSafeEscape(l)}</div>`,
    )
    const add = b.map(
      (l) =>
        `<div class="skt-row skt-add"><span class="skt-sign">+</span>${htmlSafeEscape(l)}</div>`,
    )
    return `<div class="skt-diff-empty">(内容较大,按整体替换展示)</div>${del.join('')}${add.join('')}`
  }
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const rows = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push(['same', a[i]])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push(['del', a[i++]])
    } else {
      rows.push(['add', b[j++]])
    }
  }
  while (i < n) rows.push(['del', a[i++]])
  while (j < m) rows.push(['add', b[j++]])
  if (rows.length === 0) return '<div class="skt-diff-empty">(无内容变化)</div>'
  return rows
    .map(([kind, line]) => {
      const sign = kind === 'add' ? '+' : kind === 'del' ? '-' : ' '
      return `<div class="skt-row skt-${kind}"><span class="skt-sign">${sign}</span>${htmlSafeEscape(line)}</div>`
    })
    .join('')
}

function _toggleEdit(card, name, draft) {
  const diff = card.querySelector('.skt-diff')
  if (_editing.has(name)) return
  _editing.add(name)
  diff.innerHTML = `
    <textarea class="skt-edit-body" rows="12">${htmlSafeEscape(draft.body || '')}</textarea>
    <div class="skt-edit-actions">
      <button type="button" class="skt-btn skt-edit-save">保存修改</button>
      <button type="button" class="skt-link skt-edit-cancel">取消</button>
    </div>`
  card.querySelector('.skt-edit-cancel').addEventListener('click', () => _refresh())
  card.querySelector('.skt-edit-save').addEventListener('click', async () => {
    const body = card.querySelector('.skt-edit-body').value
    try {
      await apiJson(
        'PUT',
        `/api/skill-training/${encodeURIComponent(_runId)}/drafts/${encodeURIComponent(name)}`,
        { body },
      )
      toast('草稿已更新', 'success')
      _editing.delete(name)
      await _refresh()
    } catch (err) {
      toast(`保存失败:${String(err)}`, 'error')
    }
  })
}

async function _comment(name, comment) {
  try {
    await apiJson(
      'POST',
      `/api/skill-training/${encodeURIComponent(_runId)}/drafts/${encodeURIComponent(name)}/comment`,
      { comment },
    )
    toast('已发送给 AI,正在按你的意见修订…', 'success')
    _renderProgress({ status: 'running', phase: 'drafting', proposalCount: 0, toolCalls: 0 })
    _startPoll()
  } catch (err) {
    toast(`发送失败:${String(err)}`, 'error')
  }
}

async function _merge(name) {
  try {
    const r = await apiJson(
      'POST',
      `/api/skill-training/${encodeURIComponent(_runId)}/merge`,
      name ? { name } : {},
    )
    const failed = (r.results || []).filter((x) => !x.ok)
    if (failed.length) {
      toast(`部分合入失败:${failed.map((f) => `${f.name}(${f.error})`).join(', ')}`, 'error')
    } else {
      toast(name ? `已合入 ${name}` : '已全部合入', 'success')
    }
    // Refresh remaining drafts; if none, the run is closed.
    await _refresh()
  } catch (err) {
    toast(`合入失败:${String(err)}`, 'error')
  }
}

async function _discard() {
  try {
    await apiJson('DELETE', `/api/skill-training/${encodeURIComponent(_runId)}`)
    toast('已丢弃本次训练', 'success')
    _close()
  } catch (err) {
    toast(`丢弃失败:${String(err)}`, 'error')
  }
}

// Re-read the run + drafts to re-render (after merge/edit/comment).
async function _refresh() {
  if (!_runId) return
  try {
    const { run } = await apiGet(`/api/skill-training/${encodeURIComponent(_runId)}`)
    if (!run || run.status === 'merged') {
      _renderTerminal('草稿已全部处理,技能库已更新。')
      return
    }
    if (run.status === 'running' || run.status === 'queued') {
      _renderProgress(run)
      _startPoll()
      return
    }
    await _renderDiffReady(run)
  } catch {
    // The run is gone (fully merged → forgotten, or discarded). That's a success
    // terminal after a merge, not an error.
    _renderTerminal('本次训练已结束,技能库已更新。')
  }
}

function _ensureStyles() {
  if (_stylesInjected) return
  _stylesInjected = true
  // Use the app's real theme tokens (--bg-elevated / --text-primary / --border /
  // --accent / --danger ...) so the panel adapts to BOTH light and dark themes.
  // (Earlier it guessed --surface/--text which don't exist → dark fallbacks rendered
  // an unreadable black modal on the light theme.)
  const css = `
.skt-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:1200}
.skt-modal{background:var(--bg-elevated,#212125);color:var(--text-primary,#eceae6);width:min(760px,94vw);max-height:88vh;border-radius:14px;display:flex;flex-direction:column;box-shadow:0 12px 48px rgba(0,0,0,.45);border:1px solid var(--border,#32323a)}
.skt-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--border,#32323a)}
.skt-head h3{margin:0;font-size:15px;color:var(--text-primary,#eceae6)}
.skt-x{background:none;border:none;color:var(--text-secondary,#9f9c96);font-size:16px;cursor:pointer}
.skt-x:hover{color:var(--text-primary,#eceae6)}
.skt-body{padding:18px;overflow:auto;color:var(--text-primary,#eceae6)}
.skt-intro{font-size:13px;line-height:1.6;color:var(--text-secondary,#9f9c96);margin:0 0 14px}
.skt-focus{display:block;font-size:12px;color:var(--text-secondary,#9f9c96);margin-bottom:14px}
.skt-focus-input,.skt-comment-input,.skt-edit-body{width:100%;box-sizing:border-box;margin-top:6px;background:var(--bg-secondary,#2a2a30);color:var(--text-primary,#eceae6);border:1px solid var(--border,#32323a);border-radius:8px;padding:8px;font:inherit}
.skt-actions{display:flex;gap:10px;justify-content:flex-end}
.skt-btn{background:var(--bg-tertiary,#2a2a30);color:var(--text-primary,#eceae6);border:1px solid var(--border,#32323a);border-radius:8px;padding:7px 14px;font-size:13px;cursor:pointer}
.skt-btn:hover{filter:brightness(1.08)}
.skt-btn-primary{background:var(--accent,#d97757);border-color:var(--accent,#d97757);color:#fff}
.skt-link{background:none;border:none;color:var(--accent,#d97757);cursor:pointer;font-size:12px;padding:0}
.skt-progress{text-align:center;padding:14px 0}
.skt-phase{font-size:14px;margin-bottom:12px;color:var(--text-primary,#eceae6)}
.skt-bar{height:8px;background:var(--bg-tertiary,#2a2a30);border-radius:6px;overflow:hidden}
.skt-bar-fill{height:100%;background:var(--accent,#d97757);transition:width .4s ease}
.skt-stat{font-size:12px;color:var(--text-secondary,#9f9c96);margin-top:10px}
.skt-spinner{font-size:12px;color:var(--text-secondary,#9f9c96);opacity:.8;margin-top:8px}
.skt-diffhead{display:flex;align-items:center;justify-content:space-between;font-size:13px;margin-bottom:14px;gap:12px}
.skt-diffhead-actions{display:flex;gap:8px;flex-shrink:0}
.skt-draft{border:1px solid var(--border,#32323a);border-radius:10px;padding:12px;margin-bottom:14px}
.skt-draft-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.skt-op{font-size:11px;padding:1px 7px;border-radius:10px;font-weight:600}
.skt-op-create{background:#1f5132;color:#9fe7b8}
.skt-op-update{background:#1f3a63;color:#9fc2ff}
.skt-op-delete{background:#5a2530;color:#ffb3bd}
.skt-author{font-size:11px;color:var(--text-secondary,#9f9c96);margin-left:auto}
.skt-rationale{font-size:12px;color:var(--text-secondary,#9f9c96);line-height:1.5;margin-bottom:10px;white-space:pre-wrap}
.skt-diff{font-family:var(--font-mono,ui-monospace,Menlo,Consolas,monospace);font-size:12px;background:var(--bg-secondary,#1e1e22);color:var(--text-primary,#eceae6);border:1px solid var(--border-subtle,#26262c);border-radius:8px;padding:8px;max-height:340px;overflow:auto;white-space:pre-wrap}
.skt-row{display:flex;gap:6px}
.skt-sign{width:1ch;opacity:.6;flex-shrink:0}
.skt-add{background:rgba(63,185,80,.20)}
.skt-del{background:rgba(248,81,73,.20)}
.skt-diff-empty{color:var(--text-secondary,#9f9c96);opacity:.8}
.skt-draft-tools{display:flex;align-items:center;justify-content:space-between;margin-top:10px}
.skt-comment{margin-top:10px;display:flex;gap:8px;align-items:flex-start}
.skt-comment-send{flex-shrink:0}
.skt-edit-actions{display:flex;gap:10px;align-items:center;margin-top:8px}
.skt-terminal{padding:18px 4px;font-size:13px;line-height:1.6;color:var(--text-primary,#eceae6)}
.skt-error{color:var(--danger,#e06c6c);font-size:12px}
@media (max-width:640px){.skt-modal{width:100vw;height:100%;max-height:100%;border-radius:0}.skt-comment{flex-direction:column}.skt-comment-send{align-self:flex-end}}`
  const style = document.createElement('style')
  style.id = 'skt-styles'
  style.textContent = css
  document.head.appendChild(style)
}
