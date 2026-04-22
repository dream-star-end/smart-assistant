// OpenClaude (commercial v3) — user preferences module
//
// Phase 4C 范围:用户偏好面板(顶栏「设置 → 偏好」)。
//
// 后端契约(packages/commercial/src/user/preferences.ts):
//   GET   /api/me/preferences   → { prefs: {...}, updated_at }
//   PATCH /api/me/preferences   body = patch (strict allowlist; null=删除字段)
//                               → { prefs: {新快照}, updated_at }
//
// MVP 暴露字段(后端 schema 完整列表见 user/preferences.ts):
//   - default_model    string 1..64,可空(空 = 跟随会话默认)
//   - default_effort   'low' | 'medium' | 'high' | 'xhigh'
//   - notify_email     boolean (邮件通知支付/重要事件)
//   - notify_telegram  → MVP 不暴露(v3 商用版 telegram 通道未接)
//   - hotkeys          → MVP 不暴露(无键位编辑器)
//   - theme            → 不暴露(已有顶栏「切换主题」按钮)
//
// 模型列表从 GET /api/models 拉(personal 没这接口 → 失败时 fallback 到 free input)。
//
// PATCH 策略:与上次 load 的快照做 diff,只发改动字段;
//   - 字段从 X → ""(空字符串)→ 发 null(后端语义=删除该 key)
//   - 字段从 X → 同 X → 跳过
//   - 没有任何改动 → 不发请求,直接 close + toast"无变化"

import { apiGet, apiJson } from './api.js'
import { closeModal, openModal, toast } from './ui.js'

let _wired = false
let _lastSnapshot = null   // 最近一次从后端拿到的 prefs 对象(diff base)
let _modelOptions = null   // GET /api/models 缓存
let _modelOptionsInflight = null

const EFFORTS = ['low', 'medium', 'high', 'xhigh']
// 短标签:segmented control 需要等宽显示,xhigh=Opus 4.7 的信息挪到 hint 里
const EFFORT_LABELS = { low: '低', medium: '中', high: '高', xhigh: '超高' }

function $(id) { return document.getElementById(id) }

// ── 模型选项 ────────────────────────────────────────────────────────

async function _loadModelOptions() {
  if (_modelOptions) return _modelOptions
  if (_modelOptionsInflight) return _modelOptionsInflight
  _modelOptionsInflight = (async () => {
    try {
      const j = await apiGet('/api/models')
      _modelOptions = Array.isArray(j?.models) ? j.models : []
    } catch {
      _modelOptions = []
    }
    return _modelOptions
  })().finally(() => { _modelOptionsInflight = null })
  return _modelOptionsInflight
}

function _renderModelDropdown(selectedId) {
  const sel = $('prefs-default-model')
  if (!sel) return
  sel.innerHTML = ''
  // 第一项:跟随会话(无默认)
  const empty = document.createElement('option')
  empty.value = ''
  empty.textContent = '— 跟随会话默认 —'
  sel.appendChild(empty)
  for (const m of (_modelOptions || [])) {
    const opt = document.createElement('option')
    opt.value = String(m.id || '')
    opt.textContent = String(m.display_name || m.id || '')
    sel.appendChild(opt)
  }
  // 已选模型可能不在列表里(被禁用 / 旧值)→ 加一个保留选项
  if (selectedId && !Array.from(sel.options).some((o) => o.value === selectedId)) {
    const orphan = document.createElement('option')
    orphan.value = selectedId
    orphan.textContent = `${selectedId}(已下线)`
    sel.appendChild(orphan)
  }
  sel.value = selectedId || ''
}

function _renderEffortRadios(selectedEffort) {
  const wrap = $('prefs-effort-radios')
  if (!wrap) return
  wrap.innerHTML = ''
  // 第一项:无默认(让会话用 server side 默认)
  const empty = document.createElement('label')
  empty.className = 'prefs-effort-pill'
  empty.innerHTML = `<input type="radio" name="prefs-effort" value="" ${!selectedEffort ? 'checked' : ''}><span>跟随系统</span>`
  wrap.appendChild(empty)
  for (const e of EFFORTS) {
    const lab = document.createElement('label')
    lab.className = 'prefs-effort-pill'
    lab.innerHTML = `<input type="radio" name="prefs-effort" value="${e}" ${selectedEffort === e ? 'checked' : ''}><span>${EFFORT_LABELS[e]}</span>`
    wrap.appendChild(lab)
  }
}

// ── 加载 / 渲染 ─────────────────────────────────────────────────────

async function _loadPreferences() {
  try {
    const j = await apiGet('/api/me/preferences')
    _lastSnapshot = (j && typeof j.prefs === 'object' && j.prefs !== null) ? { ...j.prefs } : {}
    return _lastSnapshot
  } catch (err) {
    // personal 版无此接口 → 默认空快照,UI 仍可用但 PATCH 也会失败
    _lastSnapshot = null
    throw err
  }
}

async function _openPrefsModal() {
  // 先打开模态(避免感觉卡顿),再异步拉数据
  openModal('prefs-modal')
  const status = $('prefs-status')
  if (status) status.textContent = '加载中…'
  // 锁住 save 直到加载完成
  const saveBtn = $('prefs-save-btn')
  if (saveBtn) saveBtn.disabled = true

  let prefs
  try {
    [prefs] = await Promise.all([_loadPreferences(), _loadModelOptions()])
  } catch (err) {
    if (status) status.textContent = '加载失败: ' + (err?.message || err)
    return
  }
  _renderModelDropdown(prefs.default_model || '')
  _renderEffortRadios(prefs.default_effort || '')
  const notifyEmail = $('prefs-notify-email')
  if (notifyEmail) notifyEmail.checked = prefs.notify_email === true
  if (status) status.textContent = ''
  if (saveBtn) saveBtn.disabled = false
}

// ── 收集 + diff + 保存 ──────────────────────────────────────────────

function _collectPatch() {
  if (!_lastSnapshot) return null
  const patch = {}
  const baseline = _lastSnapshot

  // default_model
  const newModel = ($('prefs-default-model')?.value ?? '').trim()
  const oldModel = baseline.default_model || ''
  if (newModel !== oldModel) {
    patch.default_model = newModel === '' ? null : newModel
  }

  // default_effort
  const newEffort = document.querySelector('input[name="prefs-effort"]:checked')?.value ?? ''
  const oldEffort = baseline.default_effort || ''
  if (newEffort !== oldEffort) {
    patch.default_effort = newEffort === '' ? null : newEffort
  }

  // notify_email
  const newNE = $('prefs-notify-email')?.checked === true
  const oldNE = baseline.notify_email === true
  if (newNE !== oldNE) {
    patch.notify_email = newNE
  }

  return patch
}

async function _savePrefs() {
  const status = $('prefs-status')
  const saveBtn = $('prefs-save-btn')
  const patch = _collectPatch()
  if (!patch) {
    if (status) status.textContent = '加载未完成,请稍候'
    return
  }
  if (Object.keys(patch).length === 0) {
    closeModal('prefs-modal')
    toast('无变化', 'info')
    return
  }
  if (saveBtn) saveBtn.disabled = true
  if (status) status.textContent = '保存中…'
  try {
    const j = await apiJson('PATCH', '/api/me/preferences', patch)
    _lastSnapshot = (j && typeof j.prefs === 'object' && j.prefs !== null) ? { ...j.prefs } : {}
    toast('偏好已保存', 'success')
    closeModal('prefs-modal')
  } catch (err) {
    if (status) status.textContent = '保存失败: ' + (err?.message || err)
    if (saveBtn) saveBtn.disabled = false
  }
}

// ── 入口 ───────────────────────────────────────────────────────────

export function openPrefsModal() {
  _openPrefsModal()
}

export function initUserPrefs() {
  if (_wired) return
  _wired = true
  const saveBtn = $('prefs-save-btn')
  if (saveBtn) saveBtn.addEventListener('click', _savePrefs)
}
