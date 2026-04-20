// OpenClaude — 超管控制台 (admin.html 入口)
//
// V3 Phase 4D 范围:
//   - bootstrap: 检查 access token + role=admin,否则跳转回 / 登录
//   - tab 路由: hash-based (#tab=users)
//   - 实现只读 tabs:users / accounts / containers / ledger / pricing / plans / audit
//   - settings / health 占位,等 4I / 4L 实现
//   - 4J 之后再加 accounts CRUD;4I 之后再加 settings 编辑
//
// 与 SPA(/index.html)分离:
//   - 不跑 service worker(<link rel="serviceworker"> 没注册)
//   - 复用 state.js + api.js(共享 access token 与 silent refresh 逻辑)
//   - 自带 CSS + 极简 toast/modal,不依赖 SPA 的 dom.js / theme.js
//
// 安全:
//   - 任何 list 接口 4xx → 提示 + 跳转 /;不要在 admin 页面里"匿名展示空列表"
//   - PATCH/DELETE 操作前必须有 confirm 提示

import { state } from './state.js'
import { apiGet, apiJson, onAuthExpired } from './api.js'

// ─── DOM helpers ────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id)
const view = () => $('view')

function escapeHtml(s) {
  if (s == null) return ''
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

function fmtCents(cents) {
  if (cents == null) return '¥0.00'
  const s = String(cents)
  if (!/^-?\d+$/.test(s)) return '¥0.00'
  const negative = s.startsWith('-')
  const digits = negative ? s.slice(1) : s
  const padded = digits.padStart(3, '0')
  const yuan = padded.slice(0, -2)
  const fen = padded.slice(-2)
  const yuanFmt = yuan.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}¥${yuanFmt}.${fen}`
}

function fmtDate(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    const HH = String(d.getHours()).padStart(2, '0')
    const MM = String(d.getMinutes()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd} ${HH}:${MM}`
  } catch { return iso }
}

function statusBadge(status) {
  const cls = status === 'active' ? 'ok'
    : status === 'banned' || status === 'deleted' ? 'danger'
    : status === 'deleting' ? 'warn'
    : 'muted'
  return `<span class="badge ${cls}">${escapeHtml(status)}</span>`
}

function toast(msg, kind = 'ok', ttl = 3000) {
  const el = document.createElement('div')
  el.className = `toast ${kind === 'danger' ? 'danger' : 'ok'}`
  el.textContent = msg
  $('toasts').appendChild(el)
  setTimeout(() => el.remove(), ttl)
}

function showError(msg) {
  view().innerHTML = `<div class="error">${escapeHtml(msg)}</div>`
}

function setLoading() {
  view().innerHTML = `<div class="loading">加载中…</div>`
}

// ─── Modal ──────────────────────────────────────────────────────────

function openModal(html) {
  $('modal-body').innerHTML = html
  $('modal-bg').hidden = false
}
function closeModal() {
  $('modal-bg').hidden = true
  $('modal-body').innerHTML = ''
}
$('modal-bg').addEventListener('click', (e) => {
  if (e.target === $('modal-bg')) closeModal()
})

// ─── Bootstrap ──────────────────────────────────────────────────────

async function bootstrap() {
  if (!state.token) {
    renderGate('未登录')
    return
  }
  let me
  try {
    me = await apiGet('/api/me')
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      renderGate('未登录或会话已过期')
      return
    }
    showError(`加载用户信息失败: ${e.message}`)
    return
  }
  const user = me?.user || me
  if (!user) {
    renderGate('用户信息缺失')
    return
  }
  if (user.role !== 'admin') {
    renderGate(`当前账号 ${user.email || user.id} 不是超管`)
    return
  }
  $('who').innerHTML = `<strong>${escapeHtml(user.email || '')}</strong>`
  $('logout').addEventListener('click', logout)
  // Tabs
  for (const btn of document.querySelectorAll('#tabs button')) {
    btn.addEventListener('click', () => navigate(btn.dataset.tab))
  }
  window.addEventListener('hashchange', applyHash)
  applyHash()
}

function logout() {
  try { localStorage.removeItem('openclaude_access_token') } catch {}
  try { localStorage.removeItem('openclaude_refresh_token') } catch {}
  try { localStorage.removeItem('openclaude_access_exp') } catch {}
  window.location.href = '/'
}

onAuthExpired(() => {
  renderGate('会话已过期,请重新登录')
})

function renderGate(msg) {
  document.body.innerHTML = `
    <div class="login-gate">
      <div class="icon">⛔</div>
      <div>${escapeHtml(msg)}</div>
      <a href="/">返回登录</a>
    </div>
  `
}

// ─── Tab routing ────────────────────────────────────────────────────

const TABS = {
  users: renderUsersTab,
  accounts: renderAccountsTab,
  containers: renderContainersTab,
  ledger: renderLedgerTab,
  pricing: renderPricingTab,
  plans: renderPlansTab,
  settings: renderSettingsTab,
  audit: renderAuditTab,
  health: renderHealthTab,
}

function navigate(tab) {
  if (window.location.hash !== `#tab=${tab}`) {
    window.location.hash = `#tab=${tab}`
  } else {
    applyHash()
  }
}

function applyHash() {
  const m = /#tab=([a-z]+)/.exec(window.location.hash)
  const tab = (m && TABS[m[1]]) ? m[1] : 'users'
  for (const btn of document.querySelectorAll('#tabs button')) {
    btn.classList.toggle('active', btn.dataset.tab === tab)
  }
  setLoading()
  TABS[tab]().catch((e) => showError(`加载失败: ${e.message}`))
}

// ─── Tab: Users ─────────────────────────────────────────────────────

async function renderUsersTab() {
  const sp = new URLSearchParams()
  const q = sessionStorage.getItem('admin_users_q') || ''
  const status = sessionStorage.getItem('admin_users_status') || ''
  if (q) sp.set('q', q)
  if (status) sp.set('status', status)
  sp.set('limit', '50')
  const data = await apiGet(`/api/admin/users?${sp.toString()}`)
  const rows = data?.rows ?? []
  view().innerHTML = `
    <div class="panel">
      <h2>用户 <small>共 ${rows.length} 人(最多 50)</small></h2>
      <div class="toolbar">
        <input type="text" id="u-q" placeholder="搜索 邮箱 / id / 显示名"
               value="${escapeHtml(q)}" />
        <select id="u-status">
          <option value="">全部状态</option>
          <option value="active" ${status === 'active' ? 'selected' : ''}>active</option>
          <option value="banned" ${status === 'banned' ? 'selected' : ''}>banned</option>
          <option value="deleting" ${status === 'deleting' ? 'selected' : ''}>deleting</option>
          <option value="deleted" ${status === 'deleted' ? 'selected' : ''}>deleted</option>
        </select>
        <button class="btn btn-primary" id="u-search">搜索</button>
      </div>
      ${rows.length === 0
        ? '<div class="empty">无用户</div>'
        : `
        <table class="data">
          <thead>
            <tr>
              <th>id</th><th>邮箱</th><th>显示名</th><th>角色</th>
              <th>状态</th><th>余额</th><th>注册时间</th><th class="actions">操作</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((u) => `
              <tr>
                <td class="mono">${escapeHtml(u.id)}</td>
                <td>${escapeHtml(u.email || '')} ${u.email_verified ? '<span class="badge ok">✓</span>' : '<span class="badge warn">未验证</span>'}</td>
                <td>${escapeHtml(u.display_name || '')}</td>
                <td><span class="badge ${u.role === 'admin' ? 'warn' : 'muted'}">${escapeHtml(u.role)}</span></td>
                <td>${statusBadge(u.status)}</td>
                <td class="num">${fmtCents(u.credits)}</td>
                <td class="mono">${fmtDate(u.created_at)}</td>
                <td class="actions">
                  <button data-act="adjust" data-id="${escapeHtml(u.id)}">±积分</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>`}
    </div>
  `
  $('u-search').addEventListener('click', () => {
    sessionStorage.setItem('admin_users_q', $('u-q').value.trim())
    sessionStorage.setItem('admin_users_status', $('u-status').value)
    applyHash()
  })
  $('u-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('u-search').click() })
  for (const b of view().querySelectorAll('button[data-act="adjust"]')) {
    b.addEventListener('click', () => openAdjustCreditsModal(b.dataset.id))
  }
}

function openAdjustCreditsModal(userId) {
  openModal(`
    <h3>调整积分(用户 ${escapeHtml(userId)})</h3>
    <div class="form-row">
      <label>delta(分;正数加,负数扣)</label>
      <input type="text" id="adj-delta" placeholder="例如 100 或 -50" />
    </div>
    <div class="form-row">
      <label>memo(必填)</label>
      <input type="text" id="adj-memo" placeholder="如:补偿 / 退款 / 测试" />
    </div>
    <div class="form-actions">
      <button id="adj-cancel">取消</button>
      <button class="btn-primary" id="adj-ok">提交</button>
    </div>
  `)
  $('adj-cancel').addEventListener('click', closeModal)
  $('adj-ok').addEventListener('click', async () => {
    const delta = $('adj-delta').value.trim()
    const memo = $('adj-memo').value.trim()
    if (!/^-?\d+$/.test(delta) || delta === '0') {
      toast('delta 必须是非零整数', 'danger'); return
    }
    if (!memo) { toast('memo 不能为空', 'danger'); return }
    try {
      const r = await apiJson('POST', `/api/admin/users/${userId}/credits`,
        { delta, memo })
      toast(`已记账,新余额 ${fmtCents(r.balance_after)}`)
      closeModal()
      applyHash()
    } catch (e) {
      toast(`失败: ${e.message}`, 'danger')
    }
  })
}

// ─── Tab: Accounts(read-only,4J 加 CRUD)──────────────────────────

async function renderAccountsTab() {
  const data = await apiGet('/api/admin/accounts?limit=200')
  const rows = data?.rows ?? []
  view().innerHTML = `
    <div class="panel">
      <h2>账号池 <small>共 ${rows.length} 条 · 完整 CRUD 在 4J 实装</small></h2>
      ${rows.length === 0
        ? '<div class="empty">账号池为空</div>'
        : `
        <table class="data">
          <thead>
            <tr><th>id</th><th>label</th><th>plan</th><th>状态</th>
                <th>health</th><th>quota</th><th>egress</th>
                <th>oauth_exp</th><th>last_used</th></tr>
          </thead>
          <tbody>
            ${rows.map((a) => `
              <tr>
                <td class="mono">${escapeHtml(a.id)}</td>
                <td>${escapeHtml(a.label)}</td>
                <td>${escapeHtml(a.plan)}</td>
                <td>${statusBadge(a.status)}</td>
                <td class="num">${a.health_score ?? '—'}</td>
                <td class="num">${a.quota_remaining ?? '—'}</td>
                <td class="mono">${escapeHtml(a.egress_proxy || '—')}</td>
                <td class="mono">${fmtDate(a.oauth_expires_at)}</td>
                <td class="mono">${fmtDate(a.last_used_at)}</td>
              </tr>`).join('')}
          </tbody>
        </table>`}
    </div>
  `
}

// ─── Tab: Containers ───────────────────────────────────────────────

async function renderContainersTab() {
  const data = await apiGet('/api/admin/agent-containers?limit=200')
  const rows = data?.rows ?? []
  view().innerHTML = `
    <div class="panel">
      <h2>Agent 容器 <small>共 ${rows.length} 条</small></h2>
      ${rows.length === 0
        ? '<div class="empty">无容器</div>'
        : `
        <table class="data">
          <thead>
            <tr><th>id</th><th>用户</th><th>订阅</th><th>状态</th>
                <th>docker</th><th>image</th><th>开始</th><th>停止</th>
                <th class="actions">操作</th></tr>
          </thead>
          <tbody>
            ${rows.map((c) => `
              <tr>
                <td class="mono">${escapeHtml(c.id)}</td>
                <td>${escapeHtml(c.user_email || c.user_id)}</td>
                <td><span class="badge muted">${escapeHtml(c.subscription_status || '—')}</span></td>
                <td>${statusBadge(c.status)}</td>
                <td class="mono">${escapeHtml((c.docker_id || '').slice(0, 12) || '—')}</td>
                <td class="mono">${escapeHtml(c.image || '')}</td>
                <td class="mono">${fmtDate(c.last_started_at)}</td>
                <td class="mono">${fmtDate(c.last_stopped_at)}</td>
                <td class="actions">
                  <button data-act="restart" data-id="${escapeHtml(c.id)}">重启</button>
                  <button data-act="stop" data-id="${escapeHtml(c.id)}">停止</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>`}
    </div>
  `
  for (const b of view().querySelectorAll('button[data-act]')) {
    b.addEventListener('click', () => containerAction(b.dataset.id, b.dataset.act))
  }
}

async function containerAction(id, action) {
  if (!confirm(`确定 ${action} 容器 ${id}?`)) return
  try {
    await apiJson('POST', `/api/admin/agent-containers/${id}/${action}`)
    toast(`已 ${action}`)
    applyHash()
  } catch (e) {
    toast(`失败: ${e.message}`, 'danger')
  }
}

// ─── Tab: Ledger ───────────────────────────────────────────────────

async function renderLedgerTab() {
  const userId = sessionStorage.getItem('admin_ledger_user') || ''
  const reason = sessionStorage.getItem('admin_ledger_reason') || ''
  const sp = new URLSearchParams({ limit: '100' })
  if (userId) sp.set('user_id', userId)
  if (reason) sp.set('reason', reason)
  const data = await apiGet(`/api/admin/ledger?${sp.toString()}`)
  const rows = data?.rows ?? []
  view().innerHTML = `
    <div class="panel">
      <h2>积分流水 <small>共 ${rows.length} 条(最多 100)</small></h2>
      <div class="toolbar">
        <input type="text" id="l-uid" placeholder="user_id 过滤" value="${escapeHtml(userId)}" />
        <select id="l-reason">
          <option value="">全部 reason</option>
          ${['topup','chat','admin_adjust','refund','expire'].map((r) =>
            `<option value="${r}" ${reason === r ? 'selected' : ''}>${r}</option>`).join('')}
        </select>
        <button class="btn btn-primary" id="l-go">查询</button>
      </div>
      ${rows.length === 0
        ? '<div class="empty">无记录</div>'
        : `
        <table class="data">
          <thead>
            <tr><th>id</th><th>用户</th><th>delta</th><th>余额</th>
                <th>reason</th><th>memo</th><th>时间</th></tr>
          </thead>
          <tbody>
            ${rows.map((r) => {
              const negative = String(r.delta).startsWith('-')
              return `
              <tr>
                <td class="mono">${escapeHtml(r.id)}</td>
                <td class="mono">${escapeHtml(r.user_id)}</td>
                <td class="num" style="color:${negative ? 'var(--danger)' : 'var(--ok)'}">
                  ${fmtCents(r.delta)}
                </td>
                <td class="num">${fmtCents(r.balance_after)}</td>
                <td><span class="badge muted">${escapeHtml(r.reason)}</span></td>
                <td>${escapeHtml(r.memo || '')}</td>
                <td class="mono">${fmtDate(r.created_at)}</td>
              </tr>`
            }).join('')}
          </tbody>
        </table>`}
    </div>
  `
  $('l-go').addEventListener('click', () => {
    sessionStorage.setItem('admin_ledger_user', $('l-uid').value.trim())
    sessionStorage.setItem('admin_ledger_reason', $('l-reason').value)
    applyHash()
  })
}

// ─── Tab: Pricing ──────────────────────────────────────────────────

async function renderPricingTab() {
  const data = await apiGet('/api/admin/pricing')
  const rows = data?.rows ?? []
  view().innerHTML = `
    <div class="panel">
      <h2>模型定价 <small>共 ${rows.length} 个</small></h2>
      ${rows.length === 0
        ? '<div class="empty">无定价</div>'
        : `
        <table class="data">
          <thead>
            <tr><th>model_id</th><th>显示名</th><th>input/Mtok</th>
                <th>output/Mtok</th><th>cache_read</th><th>cache_write</th>
                <th>multiplier</th><th>启用</th><th class="actions">操作</th></tr>
          </thead>
          <tbody>
            ${rows.map((p) => `
              <tr>
                <td class="mono">${escapeHtml(p.model_id)}</td>
                <td>${escapeHtml(p.display_name || '')}</td>
                <td class="num">${fmtCents(p.input_per_mtok)}</td>
                <td class="num">${fmtCents(p.output_per_mtok)}</td>
                <td class="num">${fmtCents(p.cache_read_per_mtok)}</td>
                <td class="num">${fmtCents(p.cache_write_per_mtok)}</td>
                <td class="num">×${escapeHtml(p.multiplier)}</td>
                <td>${p.enabled ? '<span class="badge ok">on</span>' : '<span class="badge muted">off</span>'}</td>
                <td class="actions">
                  <button data-act="edit-pricing" data-id="${escapeHtml(p.model_id)}"
                          data-mult="${escapeHtml(p.multiplier)}"
                          data-enabled="${p.enabled ? '1' : '0'}">编辑</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>`}
    </div>
  `
  for (const b of view().querySelectorAll('button[data-act="edit-pricing"]')) {
    b.addEventListener('click', () => openEditPricingModal(b.dataset.id, b.dataset.mult, b.dataset.enabled === '1'))
  }
}

function openEditPricingModal(modelId, multiplier, enabled) {
  openModal(`
    <h3>编辑定价 · ${escapeHtml(modelId)}</h3>
    <div class="form-row">
      <label>multiplier(decimal,例如 2.000)</label>
      <input type="text" id="p-mult" value="${escapeHtml(multiplier)}" />
    </div>
    <div class="form-row">
      <label><input type="checkbox" id="p-enabled" ${enabled ? 'checked' : ''} /> 启用</label>
    </div>
    <div class="form-actions">
      <button id="p-cancel">取消</button>
      <button class="btn-primary" id="p-ok">保存</button>
    </div>
  `)
  $('p-cancel').addEventListener('click', closeModal)
  $('p-ok').addEventListener('click', async () => {
    const m = $('p-mult').value.trim()
    if (!/^\d+(\.\d{1,3})?$/.test(m)) { toast('multiplier 格式不对', 'danger'); return }
    try {
      await apiJson('PATCH', `/api/admin/pricing/${encodeURIComponent(modelId)}`,
        { multiplier: m, enabled: $('p-enabled').checked })
      toast('已保存')
      closeModal()
      applyHash()
    } catch (e) {
      toast(`失败: ${e.message}`, 'danger')
    }
  })
}

// ─── Tab: Plans ────────────────────────────────────────────────────

async function renderPlansTab() {
  const data = await apiGet('/api/admin/plans')
  const rows = data?.rows ?? []
  view().innerHTML = `
    <div class="panel">
      <h2>充值套餐 <small>共 ${rows.length} 个</small></h2>
      ${rows.length === 0
        ? '<div class="empty">无套餐</div>'
        : `
        <table class="data">
          <thead>
            <tr><th>code</th><th>label</th><th>金额</th><th>积分</th>
                <th>排序</th><th>启用</th><th class="actions">操作</th></tr>
          </thead>
          <tbody>
            ${rows.map((p) => `
              <tr>
                <td class="mono">${escapeHtml(p.code)}</td>
                <td>${escapeHtml(p.label)}</td>
                <td class="num">${fmtCents(p.amount_cents)}</td>
                <td class="num">${fmtCents(p.credits)}</td>
                <td class="num">${escapeHtml(String(p.sort_order))}</td>
                <td>${p.enabled ? '<span class="badge ok">on</span>' : '<span class="badge muted">off</span>'}</td>
                <td class="actions">
                  <button data-act="edit-plan"
                          data-code="${escapeHtml(p.code)}"
                          data-label="${escapeHtml(p.label)}"
                          data-amount="${escapeHtml(p.amount_cents)}"
                          data-credits="${escapeHtml(p.credits)}"
                          data-sort="${escapeHtml(String(p.sort_order))}"
                          data-enabled="${p.enabled ? '1' : '0'}">编辑</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>`}
    </div>
  `
  for (const b of view().querySelectorAll('button[data-act="edit-plan"]')) {
    b.addEventListener('click', () => openEditPlanModal(b.dataset))
  }
}

function openEditPlanModal(d) {
  openModal(`
    <h3>编辑套餐 · ${escapeHtml(d.code)}</h3>
    <div class="form-row"><label>label</label>
      <input type="text" id="pl-label" value="${escapeHtml(d.label)}" /></div>
    <div class="form-row"><label>amount_cents</label>
      <input type="text" id="pl-amount" value="${escapeHtml(d.amount)}" /></div>
    <div class="form-row"><label>credits</label>
      <input type="text" id="pl-credits" value="${escapeHtml(d.credits)}" /></div>
    <div class="form-row"><label>sort_order</label>
      <input type="number" id="pl-sort" value="${escapeHtml(d.sort)}" /></div>
    <div class="form-row"><label>
      <input type="checkbox" id="pl-enabled" ${d.enabled === '1' ? 'checked' : ''} /> 启用</label></div>
    <div class="form-actions">
      <button id="pl-cancel">取消</button>
      <button class="btn-primary" id="pl-ok">保存</button>
    </div>
  `)
  $('pl-cancel').addEventListener('click', closeModal)
  $('pl-ok').addEventListener('click', async () => {
    try {
      await apiJson('PATCH', `/api/admin/plans/${encodeURIComponent(d.code)}`, {
        label: $('pl-label').value,
        amount_cents: $('pl-amount').value.trim(),
        credits: $('pl-credits').value.trim(),
        sort_order: Number($('pl-sort').value),
        enabled: $('pl-enabled').checked,
      })
      toast('已保存')
      closeModal()
      applyHash()
    } catch (e) {
      toast(`失败: ${e.message}`, 'danger')
    }
  })
}

// ─── Tab: Settings(占位 — 4I 实装)─────────────────────────────────

async function renderSettingsTab() {
  view().innerHTML = `
    <div class="panel">
      <h2>系统设置 <small>4H 后端已就绪;UI 在 Phase 4I 接入</small></h2>
      <div class="placeholder">
        Phase 4I 将渲染 GET /api/admin/settings + 每个 key 的编辑表单<br/>
        当前可用 key:<code>idle_sweep_min / allow_registration / default_effort /
        rate_limit_chat_per_min / maintenance_mode</code>
      </div>
    </div>
  `
}

// ─── Tab: Audit ────────────────────────────────────────────────────

async function renderAuditTab() {
  const adminId = sessionStorage.getItem('admin_audit_admin') || ''
  const action = sessionStorage.getItem('admin_audit_action') || ''
  const sp = new URLSearchParams({ limit: '100' })
  if (adminId) sp.set('admin_id', adminId)
  if (action) sp.set('action', action)
  const data = await apiGet(`/api/admin/audit?${sp.toString()}`)
  const rows = data?.rows ?? []
  view().innerHTML = `
    <div class="panel">
      <h2>审计日志 <small>共 ${rows.length} 条(最多 100)</small></h2>
      <div class="toolbar">
        <input type="text" id="a-aid" placeholder="admin_id 过滤" value="${escapeHtml(adminId)}" />
        <input type="text" id="a-act" placeholder="action 前缀(如 user.)" value="${escapeHtml(action)}" />
        <button class="btn btn-primary" id="a-go">查询</button>
      </div>
      ${rows.length === 0
        ? '<div class="empty">无记录</div>'
        : `
        <table class="data">
          <thead>
            <tr><th>id</th><th>admin</th><th>action</th><th>target</th>
                <th>before → after</th><th>ip</th><th>时间</th></tr>
          </thead>
          <tbody>
            ${rows.map((r) => `
              <tr>
                <td class="mono">${escapeHtml(r.id)}</td>
                <td class="mono">${escapeHtml(r.admin_id)}</td>
                <td><span class="badge muted">${escapeHtml(r.action)}</span></td>
                <td class="mono">${escapeHtml(r.target || '—')}</td>
                <td class="mono" style="max-width:280px;overflow:hidden;text-overflow:ellipsis"
                    title="${escapeHtml(JSON.stringify({ before: r.before, after: r.after }))}">
                  ${escapeHtml(JSON.stringify(r.before || {}).slice(0, 60))}
                  →
                  ${escapeHtml(JSON.stringify(r.after || {}).slice(0, 60))}
                </td>
                <td class="mono">${escapeHtml(r.ip || '')}</td>
                <td class="mono">${fmtDate(r.created_at)}</td>
              </tr>`).join('')}
          </tbody>
        </table>`}
    </div>
  `
  $('a-go').addEventListener('click', () => {
    sessionStorage.setItem('admin_audit_admin', $('a-aid').value.trim())
    sessionStorage.setItem('admin_audit_action', $('a-act').value.trim())
    applyHash()
  })
}

// ─── Tab: Health(占位 — 4L 实装)──────────────────────────────────

async function renderHealthTab() {
  view().innerHTML = `
    <div class="panel">
      <h2>健康面板 <small>Phase 4L 实装</small></h2>
      <div class="placeholder">
        将聚合 /api/admin/metrics(Prometheus 文本)成图表卡片:<br/>
        gateway 请求 / 账号池健康 / 容器状态 / Anthropic 代理延迟 等
      </div>
    </div>
  `
}

// ─── Boot ──────────────────────────────────────────────────────────

bootstrap().catch((e) => {
  console.error('admin bootstrap failed', e)
  showError(`bootstrap failed: ${e.message}`)
})
