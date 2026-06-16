// OpenClaude — V3 CC 外接 API key 管理面 UI(Phase 6 admin-only,plan §3.4)
//
// 入口:`openApiKeysModal()`。后端三个 endpoint:
//   GET    /api/me/api-keys
//   POST   /api/me/api-keys { label }       → 返完整明文 `plaintext` **仅此一次**
//   DELETE /api/me/api-keys/:id              → 软撤销
// 全部 admin-only(403 ADMIN_ONLY);入口按钮 hidden,billing.js refreshBalance
// 拿 role==='admin' 时翻转可见 —— 沿用 #admin-console-link 范式。
//
// 安全要点(Codex plan-review 必修):
//   - 任何 label 渲染走 textContent,绝不拼 innerHTML(防 XSS,label 是用户输入)
//   - secret plaintext 在 modal 任何 close 路径(Esc / backdrop / X / 关闭按钮 /
//     "我已保存")都必须清空,且不留 module-level cache
//   - DELETE :id 用 encodeURIComponent

import { $ } from './dom.js?v=fbeead85'
import { apiGet, apiJson } from './api.js?v=fbeead85'
import { openModal, closeModal, toast, toastOptsFromError, confirmDialog } from './ui.js?v=fbeead85'
import { shortTime } from './util.js?v=fbeead85'

let _wired = false
let _observer = null
// in-flight POST guard。覆盖两类竞态:
//   a) Enter 在 button 已 disabled 时仍能触发 keydown → 并发 POST → secret 互相覆盖
//   b) 同 click 也用同一把锁,行为统一。
// 注意:create button disabled 只挡 UI,不是状态机,所以必须有独立 flag。
let _createInflight = false
// modal session generation。每次 modal 从 .open → !.open(MutationObserver 检测)
// 都递增。_onCreateSubmit 进入时 snapshot `_modalSession`,POST resolve 后必须
// snapshot === 当前值 才允许写 secret panel,否则丢弃 plaintext。
//
// 这把 token 解决"关闭后立刻重开"竞态:仅 check `.open` class 会让旧请求
// resolve 时 modal 已重新 open,把放弃的 plaintext 写到新 session。安全语义
// 就是"关闭即放弃,即使重开也不能恢复旧 secret"。
let _modalSession = 0

export function openApiKeysModal() {
  _wireOnce()
  _showListPanel()
  openModal('api-keys-modal')
  _loadList()
}

function _wireOnce() {
  if (_wired) return
  _wired = true

  // 顶部"新建" → 切到 create panel
  $('api-keys-new-btn').addEventListener('click', () => {
    _showCreatePanel()
  })

  // create panel:取消 → 回列表;提交 → POST
  $('api-keys-create-cancel').addEventListener('click', () => {
    _showListPanel()
  })
  $('api-keys-create-submit').addEventListener('click', _onCreateSubmit)
  $('api-keys-create-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault()
      _onCreateSubmit()
    }
  })

  // secret panel:复制 / 我已保存
  $('api-keys-secret-copy').addEventListener('click', _onCopySecret)
  $('api-keys-secret-done').addEventListener('click', () => {
    _clearSecret()
    _showListPanel()
    _loadList()
  })

  // 列表行的撤销:事件委托(因为 rows 是动态 render 的)
  $('api-keys-list').addEventListener('click', (e) => {
    const btn = e.target.closest?.('[data-revoke-id]')
    if (!btn) return
    const id = btn.getAttribute('data-revoke-id')
    const label = btn.getAttribute('data-revoke-label') || ''
    _onRevoke(id, label)
  })

  // MutationObserver:监听 #api-keys-modal 的 .open class 移除 → 清空 secret。
  // 覆盖所有 close 路径(X / data-close-modal / backdrop click / Esc / 直接
  // closeModal),保证 secret 不会因为关闭顺序问题残留在 DOM input.value。
  const modal = $('api-keys-modal')
  if (modal && !_observer) {
    _observer = new MutationObserver(() => {
      if (!modal.classList.contains('open')) {
        _clearSecret()
        // 关闭即递增 session,任何 in-flight POST snapshot 都会 stale → 丢明文
        _modalSession += 1
      }
    })
    _observer.observe(modal, { attributes: true, attributeFilter: ['class'] })
  }
}

// ── 面板切换 ──────────────────────────────────────────────────────────────
// 主 modal 内三个互斥 panel:list / create / secret。同一时刻只显示一个。

function _showListPanel() {
  $('api-keys-list-panel').hidden = false
  $('api-keys-create-panel').hidden = true
  $('api-keys-secret-panel').hidden = true
  $('api-keys-new-btn').hidden = false
}

function _showCreatePanel() {
  $('api-keys-list-panel').hidden = true
  $('api-keys-create-panel').hidden = false
  $('api-keys-secret-panel').hidden = true
  $('api-keys-new-btn').hidden = true
  const input = $('api-keys-create-input')
  input.value = ''
  setTimeout(() => input.focus(), 30)
}

function _showSecretPanel(plaintext, label) {
  $('api-keys-list-panel').hidden = true
  $('api-keys-create-panel').hidden = true
  $('api-keys-secret-panel').hidden = false
  $('api-keys-new-btn').hidden = true
  $('api-keys-secret-input').value = plaintext
  // label 是用户输入 → 必须 textContent,不能 innerHTML
  $('api-keys-secret-label').textContent = label
}

// ── 列表 ─────────────────────────────────────────────────────────────────

async function _loadList() {
  const list = $('api-keys-list')
  const empty = $('api-keys-empty')
  list.replaceChildren()
  empty.hidden = true
  list.setAttribute('aria-busy', 'true')
  try {
    const data = await apiGet('/api/me/api-keys')
    const keys = Array.isArray(data?.keys) ? data.keys : []
    if (keys.length === 0) {
      empty.hidden = false
    } else {
      for (const k of keys) list.appendChild(_renderRow(k))
    }
  } catch (err) {
    empty.hidden = false
    empty.textContent = '加载失败,请稍后重试'
    toast(`加载失败:${err?.message || err}`, 'error', toastOptsFromError(err))
  } finally {
    list.removeAttribute('aria-busy')
  }
}

function _renderRow(k) {
  // k: { id, label, key_prefix, created_at, last_used_at }
  // 后端时间是 ISO 字符串;shortTime 接收 ms timestamp(util.js)
  const row = document.createElement('div')
  row.className = 'api-key-row'
  row.style.cssText =
    'display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-secondary)'

  const meta = document.createElement('div')
  meta.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:4px'

  const labelEl = document.createElement('div')
  labelEl.style.cssText = 'font-weight:600;font-size:13px;line-height:1.3;word-break:break-all'
  labelEl.textContent = k.label || '(未命名)' // ← textContent 防 XSS

  const subEl = document.createElement('div')
  subEl.style.cssText =
    'font-size:11px;color:var(--text-secondary);font-family:var(--font-mono,ui-monospace,monospace);word-break:break-all'
  subEl.textContent = `${k.key_prefix}…`

  const timeEl = document.createElement('div')
  timeEl.style.cssText = 'font-size:11px;color:var(--text-secondary)'
  const createdMs = Date.parse(k.created_at)
  const lastUsedMs = k.last_used_at ? Date.parse(k.last_used_at) : null
  const createdText = Number.isFinite(createdMs) ? shortTime(createdMs) : '—'
  const lastUsedText =
    lastUsedMs && Number.isFinite(lastUsedMs) ? shortTime(lastUsedMs) : '从未使用'
  timeEl.textContent = `创建于 ${createdText} · 上次使用 ${lastUsedText}`

  meta.appendChild(labelEl)
  meta.appendChild(subEl)
  meta.appendChild(timeEl)

  const revokeBtn = document.createElement('button')
  revokeBtn.type = 'button'
  revokeBtn.className = 'btn btn-ghost'
  revokeBtn.style.cssText = 'font-size:12px;flex-shrink:0;color:var(--accent-danger)'
  revokeBtn.textContent = '撤销'
  revokeBtn.setAttribute('data-revoke-id', String(k.id))
  revokeBtn.setAttribute('data-revoke-label', String(k.label || ''))

  row.appendChild(meta)
  row.appendChild(revokeBtn)
  return row
}

// ── 创建 ─────────────────────────────────────────────────────────────────

async function _onCreateSubmit() {
  // in-flight guard:Enter keydown 在 btn disabled 后仍会触发,只有这把
  // 模块级 lock 能阻并发 POST。click 路径走同一把锁,行为统一。
  if (_createInflight) return
  const input = $('api-keys-create-input')
  const raw = input.value || ''
  const label = raw.trim()
  // 前端先 validate 一道,少一次失败往返(后端仍是最终校验)
  if (label.length < 1 || label.length > 80) {
    toast('标签需 1-80 字符', 'warn')
    input.focus()
    return
  }
  _createInflight = true
  const btn = $('api-keys-create-submit')
  btn.disabled = true
  btn.textContent = '创建中…'
  const modal = $('api-keys-modal')
  // snapshot session token,POST resolve 后必须匹配才允许写 secret。
  // 仅 check .open 不够 — 用户可能"关闭→重开",observer 已递增 session,
  // 旧请求 resolve 时 .open 又为 true 但属于新 session,plaintext 必须丢。
  const session = _modalSession
  try {
    const created = await apiJson('POST', '/api/me/api-keys', { label })
    if (!created?.plaintext) {
      throw new Error('后端响应缺少 plaintext')
    }
    // POST 期间用户可能已关闭 modal(Esc / backdrop / X / 关闭按钮),甚至
    // 关闭后又重开。MutationObserver 在每次关闭都已 += session。
    // 安全语义:关闭即放弃,即使重开也不能恢复旧 secret。一次性明文丢就丢,
    // key 在后端已存在(用户可在列表看到,但拿不回明文 = 等同失效需重建)。
    // 这是 anti-leak 必要代价,不抱怨。
    if (!modal || !modal.classList.contains('open') || session !== _modalSession) {
      return
    }
    _showSecretPanel(created.plaintext, created.label || label)
  } catch (err) {
    const code = err?.code
    let msg = err?.message || '创建失败'
    if (code === 'INVALID_LABEL') msg = '标签格式不合法(1-80 字符)'
    else if (code === 'ADMIN_ONLY') msg = '当前仅管理员可创建 API Key'
    toast(msg, 'error', toastOptsFromError(err))
  } finally {
    _createInflight = false
    btn.disabled = false
    btn.textContent = '创建'
  }
}

// ── secret 复制 / 清空 ────────────────────────────────────────────────────

async function _onCopySecret() {
  const input = $('api-keys-secret-input')
  const v = input.value || ''
  if (!v) {
    toast('无可复制的内容', 'warn')
    return
  }
  try {
    await navigator.clipboard.writeText(v)
    toast('已复制到剪贴板', 'info')
    return
  } catch {}
  // fallback:对 readonly input 直接 select + execCommand
  try {
    input.removeAttribute('readonly')
    input.select()
    input.setSelectionRange(0, v.length)
    const ok = document.execCommand && document.execCommand('copy')
    input.setAttribute('readonly', '')
    input.blur()
    if (ok) toast('已复制到剪贴板', 'info')
    else toast('复制失败,请手动选中复制', 'warn')
  } catch {
    toast('复制失败,请手动选中复制', 'warn')
  }
}

function _clearSecret() {
  // DOM 是 secret 的唯一持有者(本模块无 module-level cache)。每次清空都
  // 显式覆盖 value(不仅 set "",还把 input value 字符串引用替换),覆盖
  // 所有 close 路径(MutationObserver 兜底 + "我已保存"/"取消" 手动调用)。
  const input = $('api-keys-secret-input')
  if (input) input.value = ''
  const labelEl = $('api-keys-secret-label')
  if (labelEl) labelEl.textContent = ''
}

// ── 撤销 ─────────────────────────────────────────────────────────────────

async function _onRevoke(id, label) {
  // confirmDialog 用 textContent 渲染 body,不解释 HTML;label 仍 trim + 截断
  // 避免换行/超长破坏弹窗可读性。
  const safeLabel = (label || '').replace(/\s+/g, ' ').slice(0, 60)
  const ok = await confirmDialog({
    title: '撤销 API Key?',
    body: `撤销 "${safeLabel}" 后该 key 立即失效,使用此 key 的客户端会立刻断连。`,
    confirmText: '撤销',
    danger: true,
  })
  if (!ok) return
  try {
    await apiJson('DELETE', `/api/me/api-keys/${encodeURIComponent(id)}`)
    toast('已撤销', 'info')
    _loadList()
  } catch (err) {
    const code = err?.code
    let msg = err?.message || '撤销失败'
    if (code === 'NOT_FOUND') {
      msg = 'Key 已不存在或已撤销'
      _loadList() // 刷新让用户看到当前实际状态
    } else if (code === 'ADMIN_ONLY') {
      msg = '当前仅管理员可撤销 API Key'
    }
    toast(msg, 'error', toastOptsFromError(err))
  }
}
