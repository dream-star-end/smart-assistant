// OpenClaude V3 commercial — 站内信(in-app inbox)模块
//
// 端点(commercial gateway):
//   GET  /api/me/messages?unread_only=0|1&limit=20&offset=0  → { messages, unread_count }
//   GET  /api/me/messages/unread_count                       → { unread_count }
//   POST /api/me/messages/:id/read                           → { ok, already }
//   POST /api/me/messages/read_all                           → { ok, inserted }
//
// 触发刷新:
//   - main.js 在 commercial 模式 refreshBalance 拿到 user 后启动 polling(60s)
//   - 用户切回标签页(visibilitychange visible)→ 立即刷一次
//   - 打开面板 → 拉完整列表 + 自动给第一屏可见消息标已读(可见即已读)
//
// 个人版无 /api/me → 401/403/404 → 静默,铃铛保持 hidden。

import { apiGet, apiJson } from './api.js?v=1f2fd83'
import { $ } from './dom.js?v=1f2fd83'
import { openModal, closeModal, toast, toastOptsFromError } from './ui.js?v=1f2fd83'
import { renderMarkdown } from './markdown.js?v=1f2fd83'

const POLL_INTERVAL_MS = 60_000
let _pollTimer = null
let _enabled = false
let _lastUnread = 0
// 每次 startInbox 递增,refreshUnread / _markVisibleAsRead 在 await 后用它判定"还是
// 同一个登录会话"。logout/切账号触发 stopInbox 后,旧 in-flight 请求 fulfill 时
// _gen 已变,丢弃结果(避免旧账号未读数渲染到新账号 badge / 残留 read 状态)。
let _gen = 0

function _bell() { return document.getElementById('inbox-bell') }
function _badge() { return document.getElementById('inbox-badge') }

function _renderBadge(n) {
  const badge = _badge()
  if (!badge) return
  if (n > 0) {
    badge.textContent = n > 99 ? '99+' : String(n)
    badge.hidden = false
  } else {
    badge.hidden = true
  }
}

/**
 * 启动 inbox(commercial 模式 user 已登录调用一次)。
 * 显示铃铛 + 拉一次 unread_count + 启动 60s polling + 监听 visibilitychange。
 */
export function startInbox() {
  if (_enabled) return
  _enabled = true
  _gen++
  const bell = _bell()
  if (bell) {
    bell.hidden = false
    bell.addEventListener('click', openInbox)
  }
  const markAll = document.getElementById('inbox-mark-all')
  if (markAll) markAll.addEventListener('click', _onMarkAllClick)

  document.addEventListener('visibilitychange', _onVisibility)
  refreshUnread()
  _pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') refreshUnread()
  }, POLL_INTERVAL_MS)
}

/**
 * 停止 inbox(logout / commercial → personal 模式切换调用)。
 */
export function stopInbox() {
  _enabled = false
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null }
  document.removeEventListener('visibilitychange', _onVisibility)
  const bell = _bell()
  if (bell) bell.hidden = true
  _renderBadge(0)
}

function _onVisibility() {
  if (document.visibilityState === 'visible') refreshUnread()
}

/**
 * 拉 unread_count(轻量 polling 用)。失败静默(401 由 api.js 自身处理)。
 */
export async function refreshUnread() {
  if (!_enabled) return
  const myGen = _gen
  try {
    const r = await apiGet('/api/me/messages/unread_count')
    if (!_enabled || _gen !== myGen) return // logout / 切账号期间旧请求晚返回
    _lastUnread = r?.unread_count ?? 0
    _renderBadge(_lastUnread)
  } catch (e) {
    if (!_enabled || _gen !== myGen) return
    // 个人版回 404 / 容器拦 403 → 关掉铃铛,不打扰
    if (e?.status === 404 || e?.status === 403) {
      stopInbox()
    }
    // 401 已由 api.js 触发 auth-expired,这里不再 toast
  }
}

/**
 * 打开站内信面板:拉完整列表 + 渲染 + 自动给可见消息标已读。
 */
export async function openInbox() {
  openModal('inbox-modal')
  const listEl = $('inbox-list')
  const emptyEl = $('inbox-empty')
  if (!listEl) return
  listEl.innerHTML = '<div class="inbox-loading">加载中…</div>'
  if (emptyEl) emptyEl.hidden = true
  let r
  try {
    r = await apiGet('/api/me/messages?limit=50')
  } catch (e) {
    listEl.innerHTML = ''
    toast('加载站内信失败', 'error', toastOptsFromError(e))
    return
  }
  const messages = Array.isArray(r?.messages) ? r.messages : []
  _lastUnread = r?.unread_count ?? 0
  _renderBadge(_lastUnread)
  if (messages.length === 0) {
    listEl.innerHTML = ''
    if (emptyEl) emptyEl.hidden = false
    return
  }
  if (emptyEl) emptyEl.hidden = true
  listEl.innerHTML = ''
  for (const m of messages) {
    listEl.appendChild(_renderItem(m))
  }
  // 打开即给第一屏未读标已读(可见即已读)。批量同步 + 后台请求,UI 立刻更新 badge。
  const unreadIds = messages.filter((m) => !m.read).map((m) => m.id)
  if (unreadIds.length > 0) {
    _markVisibleAsRead(unreadIds, listEl)
  }
}

function _renderItem(m) {
  const wrap = document.createElement('div')
  wrap.className = `inbox-item inbox-level-${m.level || 'info'}${m.read ? ' inbox-read' : ''}`
  wrap.dataset.id = m.id

  const head = document.createElement('div')
  head.className = 'inbox-item-head'
  const dot = document.createElement('span')
  dot.className = 'inbox-dot'
  if (m.read) dot.style.visibility = 'hidden'
  const title = document.createElement('div')
  title.className = 'inbox-title'
  title.textContent = m.title
  const time = document.createElement('div')
  time.className = 'inbox-time'
  time.textContent = _fmtTime(m.created_at)
  head.appendChild(dot)
  head.appendChild(title)
  head.appendChild(time)

  const body = document.createElement('div')
  body.className = 'inbox-body markdown-body'
  // body_md 由 admin 写入,renderMarkdown 已做 sanitize(同 chat 消息渲染)
  body.innerHTML = renderMarkdown(m.body_md || '')

  wrap.appendChild(head)
  wrap.appendChild(body)
  return wrap
}

function _fmtTime(iso) {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const now = new Date()
    const sameDay = d.toDateString() === now.toDateString()
    const pad = (n) => String(n).padStart(2, '0')
    if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  } catch { return '' }
}

async function _markVisibleAsRead(ids, listEl) {
  // 只标记本次渲染出来的 ids;**不要**调 read_all —— 用户当前列表 limit=50,
  // read_all 会把第 51 条以后的未读也标掉(Codex 审查抓到的语义 bug)。
  // 逐条 POST,fire-and-forget;失败的下次 polling 会自然带回未读数。
  await Promise.allSettled(
    ids.map((id) =>
      apiJson('POST', `/api/me/messages/${encodeURIComponent(id)}/read`).then(() => {
        const el = listEl.querySelector(`.inbox-item[data-id="${id}"]`)
        if (!el) return
        el.classList.add('inbox-read')
        const dot = el.querySelector('.inbox-dot')
        if (dot) dot.style.visibility = 'hidden'
      }),
    ),
  )
  // 全成功后再刷一次 unread_count(真值锁定 badge)。失败不影响后续 polling。
  refreshUnread().catch(() => {})
}

async function _onMarkAllClick() {
  try {
    await apiJson('POST', '/api/me/messages/read_all')
    _lastUnread = 0
    _renderBadge(0)
    // 把面板里所有 item 切已读态
    const listEl = $('inbox-list')
    if (listEl) {
      listEl.querySelectorAll('.inbox-item').forEach((el) => {
        el.classList.add('inbox-read')
        const dot = el.querySelector('.inbox-dot')
        if (dot) dot.style.visibility = 'hidden'
      })
    }
    toast('已全部标记为已读', 'success')
  } catch (e) {
    toast('操作失败', 'error', toastOptsFromError(e))
  }
}

// 给 commands.js / 其他模块用:程序化关闭
export function closeInbox() { closeModal('inbox-modal') }
