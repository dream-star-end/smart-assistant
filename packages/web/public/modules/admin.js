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

import { _clearStoredAccessToken, state } from './state.js?v=43464cdc'
import { apiGet, apiJson, apiText, apiFetch, authHeaders, onAuthExpired } from './api.js?v=43464cdc'
import { lineChart, barChart, destroyChart, fmt as cfmt } from './charts.js?v=43464cdc'

// 与后端 packages/commercial/src/admin/ledger.ts 的 LEDGER_REASONS 枚举严格同步。
// 新增/删除 reason 必须两端同步改,否则 ledger tab filter 会把错误值发给后端
// 400,或漏掉新 reason 的中文 label(R1 Codex L2)。
const LEDGER_REASONS = [
  'topup', 'chat', 'agent_chat', 'agent_subscription',
  'refund', 'admin_adjust', 'promotion',
]
const LEDGER_REASON_LABELS = {
  topup:              '充值',
  chat:               '对话',
  agent_chat:         'Agent 对话',
  agent_subscription: 'Agent 订阅',
  refund:             '退款',
  admin_adjust:       '管理员调整',
  promotion:          '活动赠送',
}
const LEDGER_CHANNEL_LABELS = {
  web:    '网页',
  wechat: '微信',
}

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

/**
 * 把人类可读的人民币字符串(如 "1.50"、"-0.25"、"¥10"、"100")解析成"分"整数。
 *
 * 2026-04-21 安全审计 MED(单位语义统一):后端 /api/admin/users/:id/credits
 * 收到的 delta 是「分」整数;但 admin 在 UI 里看到余额是 ¥X.XX,直接让他
 * 输入分会让"加 ¥1"误打成 1(实际只加 1 分)或 100x 多加。这里加一道
 * yuan→cents 转换 + 实时 ¥ 预览,避免单位错位事故。
 *
 * 接受:
 *   - "1"、"1.5"、"1.50"、"-0.25"、"  ¥10  "、"+5.00"
 * 拒绝(返回 null):
 *   - 空串、非数字、超过 2 位小数、NaN/Inf、"0"/"0.00"(零变动无意义)
 *   - 整数部分超过 10 位 / 绝对值超过 100,000,000 cents(¥100 万) —— 与
 *     codex round 1 finding #6 修的服务端硬 cap 对齐,避免前端 Number()
 *     精度损失把超长输入静默截断后再交给后端
 */
function parseYuanToCents(input) {
  // ¥1,000,000 = 100,000,000 cents — 与 commercial/src/http/admin.ts 后端硬 cap 严格一致
  const MAX_ADMIN_DELTA_CENTS = 100_000_000
  if (typeof input !== 'string') return null
  const trimmed = input.trim().replace(/^¥/, '').replace(/^\+/, '')
  if (trimmed === '') return null
  // sign + integer (最多 10 位防 Number 精度丢) + optional .frac (max 2 digits)
  const m = /^(-?)(\d{1,10})(?:\.(\d{1,2}))?$/.exec(trimmed)
  if (!m) return null
  const negative = m[1] === '-'
  const intPart = m[2]
  const fracPart = (m[3] ?? '').padEnd(2, '0')
  const combined = `${intPart}${fracPart}`.replace(/^0+(?=\d)/, '')
  if (combined === '0' || combined === '') return null
  const cents = Number(combined)
  if (!Number.isFinite(cents) || !Number.isInteger(cents)) return null
  if (cents > MAX_ADMIN_DELTA_CENTS) return null
  return negative ? -cents : cents
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

function ledgerChannelBadge(channel) {
  const label = LEDGER_CHANNEL_LABELS[channel] || '—'
  if (label === '—') return '<span class="badge muted">—</span>'
  const cls = channel === 'wechat' ? 'ok' : 'muted'
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`
}

/**
 * admin panel toast
 *
 * 2026-04-23 改造:扩签名支持 {code, requestId},与主站 ui.js:toast 同语义 ——
 * error 态把 `CODE · req:xxxx…` 贴在 msg 下面,req 徽章点击复制。admin 自己
 * 排障时可直接把 request_id 交给运维去 grep journalctl,不用截 console。
 */
function toast(msg, kind = 'ok', optsOrTtl) {
  let ttl = 3000
  let opts
  if (typeof optsOrTtl === 'number') ttl = optsOrTtl
  else if (optsOrTtl && typeof optsOrTtl === 'object') {
    opts = optsOrTtl
    if (typeof opts.ttl === 'number') ttl = opts.ttl
  }
  const code = opts?.code
  const reqId = opts?.requestId
  // danger/err 类文案带 code|reqId 时延长到 7s
  if (kind === 'danger' && (code || reqId)) ttl = Math.max(ttl, 7000)
  const el = document.createElement('div')
  el.className = `toast ${kind === 'danger' ? 'danger' : 'ok'}`
  const main = document.createElement('div')
  main.textContent = msg
  el.appendChild(main)
  if (code || reqId) {
    const trace = document.createElement('div')
    trace.style.cssText = 'margin-top:4px;font-size:11px;opacity:0.85;display:flex;gap:6px;align-items:center'
    if (code) {
      const c = document.createElement('span')
      c.textContent = String(code)
      c.style.opacity = '0.75'
      trace.appendChild(c)
    }
    if (reqId) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.title = '点击复制 request_id'
      const label = `req:${String(reqId).slice(0, 8)}…`
      btn.textContent = label
      btn.style.cssText = 'background:rgba(0,0,0,0.08);border:1px solid rgba(0,0,0,0.12);color:inherit;cursor:pointer;font-family:var(--font-mono,ui-monospace,monospace);font-size:11px;padding:1px 6px;border-radius:3px'
      // 注意:按钮只显示截断前缀,真正要复制的是完整 reqId。fallback 必须用
      // 临时 textarea 托载完整串再 select,不能退回到 selectNodeContents(btn)
      // —— 那样只会 select 到 "req:xxxxxxxx…"(codex R2 #4)。
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation()
        const full = String(reqId)
        const flash = () => {
          btn.textContent = '已复制'
          setTimeout(() => { if (btn.isConnected) btn.textContent = label }, 1500)
        }
        try {
          await navigator.clipboard.writeText(full)
          flash()
          return
        } catch {}
        try {
          const ta = document.createElement('textarea')
          ta.value = full
          ta.setAttribute('readonly', '')
          ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0'
          document.body.appendChild(ta)
          ta.select()
          ta.setSelectionRange(0, full.length)
          const ok = document.execCommand && document.execCommand('copy')
          document.body.removeChild(ta)
          if (ok) flash()
        } catch {}
      })
      trace.appendChild(btn)
    }
    el.appendChild(trace)
  }
  $('toasts').appendChild(el)
  setTimeout(() => el.remove(), ttl)
}

// e.code / e.requestId 已由 modules/api.js 挂到 Error 对象上,这里一步抽取
function toastOptsFromError(e) {
  if (!e) return undefined
  return { code: e.code, requestId: e.requestId }
}

function showError(msg, e) {
  const code = e?.code
  const reqId = e?.requestId
  const trace = (code || reqId)
    ? `<div style="margin-top:6px;font-size:11px;opacity:0.75;font-family:var(--font-mono,ui-monospace,monospace)">${code ? escapeHtml(String(code)) : ''}${code && reqId ? ' · ' : ''}${reqId ? 'req:' + escapeHtml(String(reqId)) : ''}</div>`
    : ''
  view().innerHTML = `<div class="error">${escapeHtml(msg)}${trace}</div>`
}

function setLoading(kind = 'table') {
  if (kind === 'table') {
    // skeleton 行,配合 admin.html 里 .skeleton .skeleton-row .skeleton-bar.w60/w80/w40
    const rows = Array.from({ length: 6 }).map(() => `
      <div class="skeleton-row">
        <div class="skeleton-bar w60"></div>
        <div class="skeleton-bar w80"></div>
        <div class="skeleton-bar w40"></div>
      </div>`).join('')
    view().innerHTML = `<div class="panel"><div class="skeleton">${rows}</div></div>`
  } else {
    view().innerHTML = `<div class="loading">加载中…</div>`
  }
}

// 按钮 loading:awaitFn() 期间给 btn 加 .is-loading,完成后还原
async function withBtnLoading(btn, fn) {
  if (!btn) return fn()
  btn.disabled = true
  btn.classList.add('is-loading')
  btn.setAttribute('aria-busy', 'true')
  try {
    return await fn()
  } finally {
    btn.disabled = false
    btn.classList.remove('is-loading')
    btn.removeAttribute('aria-busy')
  }
}

// ─── Modal ──────────────────────────────────────────────────────────

function openModal(html) {
  $('modal-body').innerHTML = html
  $('modal-bg').hidden = false
}
function closeModal() {
  $('modal-bg').hidden = true
  $('modal-body').innerHTML = ''
  // Abort any in-flight long-poll loops tied to the modal (e.g. iLink QR poll).
  // Without this, dismissing via backdrop click leaves the loop running until
  // its 125s deadline — harmless but wasteful. Cancel button already does this.
  if (ALERTS_STATE && ALERTS_STATE.qrAbortFlag) {
    ALERTS_STATE.qrAbortFlag.aborted = true
  }
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
    showError(`加载用户信息失败: ${e.message}`, e)
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
  // 2026-04-24 "记住我":access token 可能在 localStorage 或 sessionStorage,两处都清。
  _clearStoredAccessToken()
  try { localStorage.removeItem('openclaude_refresh_token') } catch {}
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
  dashboard: renderDashboardTab,
  users: renderUsersTab,
  accounts: renderAccountsTab,
  accountGroups: renderAccountGroupsTab,
  egressProxies: renderEgressProxiesTab,
  containers: renderContainersTab,
  hosts: renderHostsTab,
  ledger: renderLedgerTab,
  orders: renderOrdersTab,
  pricing: renderPricingTab,
  plans: renderPlansTab,
  modelGrants: renderModelGrantsTab,
  feedback: renderFeedbackTab,
  inbox: renderInboxTab,
  literature: renderLiteratureTab,
  settings: renderSettingsTab,
  audit: renderAuditTab,
  health: renderHealthTab,
  alerts: renderAlertsTab,
}

// pendingDeeplink:cross-tab 跳转时,把 query 暂存到这个一次性 token。
// 接管 tab 的 render 函数读到后**立即**清空,确保只生效一次,不污染后续手动操作。
// 同步也写 sessionStorage 一份(原有"过滤值持久化"的契约保持),
// 但 render 的优先级是 pendingDeeplink > sessionStorage,
// 解决 Codex review 标识的"sessionStorage 残留覆盖刚跳过来的 query"问题。
let pendingDeeplink = null

/**
 * 把元素的 data-q-* 属性收成 navigate 的 query 参数对象。
 *   <a data-nav="containers" data-q-user_email="x@y" data-q-host_uuid="...">
 *     → { user_email: "x@y", host_uuid: "..." }
 *
 * dataset 把 hyphen 转成 camelCase,所以 data-q-user_email → dataset.qUser_email,
 * 但我们用 underscore key 不带 hyphen,dataset 直接保留为 quser_email — 不可靠。
 * 改用 element.attributes 遍历,显式过滤 data-q- 前缀,稳定。
 */
function _navQueryFrom(el) {
  const out = {}
  for (const attr of el.attributes) {
    if (attr.name.startsWith('data-q-')) {
      const k = attr.name.slice('data-q-'.length)
      if (k && attr.value !== '') out[k] = attr.value
    }
  }
  return Object.keys(out).length === 0 ? null : out
}

function navigate(tab, query) {
  // query 可选:无 query 时与原行为完全一致(只切 tab)。
  const qs = query
    ? '&' + new URLSearchParams(query).toString()
    : ''
  const target = `#tab=${tab}${qs}`
  if (window.location.hash !== target) {
    window.location.hash = target
  } else {
    applyHash()
  }
}

// 离开某 tab 时必须执行的清理(计时器 / chart 实例)。applyHash() 在目标 tab
// != currentTab 时统一触发,保证切 tab 不泄漏 setInterval + Chart.js 实例。
// R1 Codex M2:过去只有"重新进入 dashboard"会清理,切走期间 timer 仍在跑 +
// canvas 持有 detached Chart 实例。
const TAB_CLEANUPS = {
  dashboard() {
    if (DASH_STATE.refreshTimer) {
      clearInterval(DASH_STATE.refreshTimer)
      DASH_STATE.refreshTimer = null
    }
    _destroyDashCharts()
  },
  hosts() {
    if (HOSTS_STATE.refreshTimer) {
      clearInterval(HOSTS_STATE.refreshTimer)
      HOSTS_STATE.refreshTimer = null
    }
  },
}
let _currentTab = null

function applyHash() {
  // 扩展原正则,支持 #tab=NAME 和 #tab=NAME&k=v&k2=v2 两种形态。
  // 字符类用 [A-Za-z0-9_] 而非纯小写 — 历史 bug:tab 名带大写(如 modelGrants)
  // 时旧 `[a-z]+` 永不匹配,无声 fall-back 到 dashboard。TABS 白名单仍是兜底。
  const m = /#tab=([A-Za-z0-9_]+)(?:&(.+))?$/.exec(window.location.hash)
  const tab = (m && TABS[m[1]]) ? m[1] : 'dashboard'
  const params = m && m[2] ? new URLSearchParams(m[2]) : null

  // pendingDeeplink:render 函数优先消费它(覆盖 sessionStorage 残留)。
  pendingDeeplink = params ? { tab, params } : null

  // 也写一份 sessionStorage:保持现有"刷新页面后过滤值还在"的契约。
  // 注意 render 的覆盖优先级:pendingDeeplink > sessionStorage。
  if (params) {
    if (tab === 'containers') {
      if (params.has('user_email')) sessionStorage.setItem('admin_ct_email', params.get('user_email'))
      if (params.has('host_uuid')) sessionStorage.setItem('admin_ct_host_uuid', params.get('host_uuid'))
    }
    if (tab === 'hosts' && params.has('focus_uuid')) {
      sessionStorage.setItem('admin_h_focus_uuid', params.get('focus_uuid'))
    }
  }

  // 切 tab 时清理上一个 tab 的副作用(只跑非本 tab 的 cleanup;同 tab 重新
  // 渲染时由 tab 自身的"停上一个 timer / destroy charts"逻辑接管)
  if (_currentTab && _currentTab !== tab) {
    try { TAB_CLEANUPS[_currentTab]?.() } catch {}
  }
  _currentTab = tab
  for (const btn of document.querySelectorAll('#tabs button')) {
    btn.classList.toggle('active', btn.dataset.tab === tab)
  }
  setLoading()
  TABS[tab]().catch((e) => showError(`加载失败: ${e.message}`, e))
}

// ─── Tab: Dashboard (总览) ──────────────────────────────────────────
//
// 后端聚合走 /api/admin/stats/* (dau / revenue-by-day / request-series /
// alerts-summary / account-pool)。前端只负责渲染 + Chart.js 绘图。
// Prometheus metrics 只保留一项 TTFT 样本(新端点里没做,保留原逻辑)。
// 刷新按钮 / 30 秒自动轮询。

const DASH_STATE = {
  refreshTimer: null,
  dauWindow: '24h',   // 活跃度卡片窗口 toggle
  reqHours: 24,        // 请求趋势窗口 toggle
  charts: {},          // canvas 引用,供主题切换 / 销毁用
  renderSeq: 0,        // 每次 renderDashboardTab 递增,异步任务按此判断自己是否过期
  loadSeq: 0,          // 每次 loadDashboardData 递增;防止 timer + 手刷重叠时旧请求覆盖新结果
  lifetimeLoadSeq: 0,  // 运营至今 lifetime 卡片独立 seq(只首屏 + 手刷,不进 30s 轮询)
}

// Prometheus metrics 的前端 parser 已被 /api/admin/stats/* 后端聚合替代。
// 健康页(renderHealthTab)里保留了一份内部 `_parsePromText` 自用,不走此处。

async function renderDashboardTab() {
  // 停掉上一个 tab 的定时器
  if (DASH_STATE.refreshTimer) {
    clearInterval(DASH_STATE.refreshTimer)
    DASH_STATE.refreshTimer = null
  }
  // 销毁上一个 tab 遗留的 chart(切 tab / 热更新防泄漏)
  _destroyDashCharts()

  // R2 Codex M1:await loadDashboardData() 期间用户可能切走 tab。
  // 递增 seq,后续异步 continuation 必须确认自己仍是"最新一次 render"才做副作用。
  const mySeq = ++DASH_STATE.renderSeq

  const dauW = DASH_STATE.dauWindow
  const reqH = DASH_STATE.reqHours

  view().innerHTML = `
    <div class="dash">
      <div class="dash-h1">
        <h2>总览
          <span class="dash-sub" id="dash-last-refresh">加载中…</span>
        </h2>
        <div style="display:flex;gap:var(--s-2);align-items:center;">
          <div class="chart-toggle" id="dash-dau-toggle">
            <button data-w="24h" class="${dauW==='24h'?'is-active':''}">24h</button>
            <button data-w="7d"  class="${dauW==='7d' ?'is-active':''}">7d</button>
            <button data-w="30d" class="${dauW==='30d'?'is-active':''}">30d</button>
          </div>
          <button class="btn" id="dash-refresh">刷新</button>
        </div>
      </div>

      <!-- 运营至今(累计)KPI —— 不进 30s 自动轮询,只首屏 + 点击"刷新累计"按钮触发 -->
      <div class="dash-section-head" style="display:flex;align-items:baseline;gap:var(--s-2);margin-top:var(--s-2);">
        <h3 style="margin:0;font-size:14px;">运营至今</h3>
        <span class="dash-sub" id="dash-lifetime-sub">加载中…</span>
        <button class="btn btn-ghost" id="dash-lifetime-refresh" style="margin-left:auto;font-size:12px;padding:2px 8px;">刷新累计</button>
      </div>
      <div class="stat-grid" id="dash-lifetime-kpis">
        ${[
          '累计用户','累计营收','累计订单','累计请求','累计 Token','运营天数',
        ].map((label) => `
          <div class="stat-card">
            <div class="stat-label">${escapeHtml(label)}</div>
            <div class="stat-value is-loading">—</div>
            <div class="stat-delta">—</div>
          </div>`).join('')}
      </div>

      <div class="stat-grid" id="dash-kpis">
        ${[
          // P2 Plan v10:11 张 KPI,2 行 6+5(商业 6 / 资源 5)。
          // 商业类
          '活跃用户 DAU','窗口新注册','付费用户','返场用户',
          '7d 营收','24h 订单异常',
          // 资源类
          '24h 请求数','24h Token','账号池 可用','容器活跃','虚机利用率',
        ].map((label) => `
          <div class="stat-card">
            <div class="stat-label">${escapeHtml(label)}</div>
            <div class="stat-value is-loading">—</div>
            <div class="stat-delta">—</div>
          </div>`).join('')}
      </div>

      <div class="chart-grid">
        <div class="chart-card">
          <div class="chart-card-head">
            <h3>请求趋势 · 最近 ${escapeHtml(String(reqH))} 小时</h3>
            <div class="chart-toggle" id="dash-req-toggle">
              <button data-h="24"  class="${reqH===24 ?'is-active':''}">24h</button>
              <button data-h="72"  class="${reqH===72 ?'is-active':''}">3d</button>
              <button data-h="168" class="${reqH===168?'is-active':''}">7d</button>
            </div>
          </div>
          <div class="chart-card-body"><canvas id="dash-chart-req"></canvas></div>
        </div>
        <div class="chart-card">
          <div class="chart-card-head">
            <h3>虚机利用率分布</h3>
            <a class="admin-link" data-nav="hosts">主机管理 →</a>
          </div>
          <div class="chart-card-body"><canvas id="dash-chart-hosts"></canvas></div>
        </div>
      </div>

      <div class="chart-grid" style="grid-template-columns: 1fr 1fr;">
        <div class="chart-card">
          <div class="chart-card-head">
            <h3>营收 · 最近 14 天</h3>
            <span class="chart-sub" id="dash-revenue-sub">—</span>
          </div>
          <div class="chart-card-body"><canvas id="dash-chart-revenue"></canvas></div>
        </div>
        <div class="chart-card">
          <div class="chart-card-head">
            <h3>新注册 · 最近 14 天</h3>
            <span class="chart-sub" id="dash-signups-sub">—</span>
          </div>
          <div class="chart-card-body"><canvas id="dash-chart-signups"></canvas></div>
        </div>
      </div>

      <div class="chart-grid" style="grid-template-columns: 1fr 1fr;">
        <div class="chart-card">
          <div class="chart-card-head">
            <h3>告警 · 7d 事件分布</h3>
            <a class="admin-link" data-nav="alerts">告警中心 →</a>
          </div>
          <div class="chart-card-body" id="dash-alerts7d-body">
            <canvas id="dash-chart-alerts7d"></canvas>
          </div>
        </div>
      </div>

      <div class="admin-two-col">
        <div class="admin-card">
          <div class="admin-card-head">
            <h3>账号池明细</h3>
            <a class="admin-link" data-nav="accounts">查看全部 →</a>
          </div>
          <div class="pool-list" id="dash-pools"><div class="skeleton-row"><div class="skeleton-bar w60"></div></div></div>
        </div>
        <div class="admin-card">
          <div class="admin-card-head">
            <h3>最近积分流水</h3>
            <a class="admin-link" data-nav="ledger">打开流水 →</a>
          </div>
          <div class="log-list" id="dash-activity"><div class="skeleton-row"><div class="skeleton-bar w60"></div></div></div>
        </div>
      </div>
    </div>`

  // 累计指标 fire-and-forget(独立 seq;不阻塞窗口 KPI 渲染)
  loadLifetimeStats(mySeq).catch(() => {})

  await loadDashboardData(mySeq)

  // R2 Codex M1:await 期间可能用户已切走或又点了一次 DAU toggle 触发新 render。
  // 如果不是"最新一次 dashboard render",就不要再绑事件/起 timer —— 上一个 render
  // 的副作用已经被 TAB_CLEANUPS 或下一个 render 清过了,这里重新绑会造成 handler
  // 挂到已被 innerHTML 替换掉的旧节点上,或者启动多个平行的 30s timer。
  if (mySeq !== DASH_STATE.renderSeq || _currentTab !== 'dashboard') return

  // ─── 事件绑定 ───
  $('dash-refresh')?.addEventListener('click', async (ev) => {
    await withBtnLoading(ev.currentTarget, () => loadDashboardData(DASH_STATE.renderSeq))
  })
  $('dash-lifetime-refresh')?.addEventListener('click', async (ev) => {
    await withBtnLoading(ev.currentTarget, () => loadLifetimeStats(DASH_STATE.renderSeq))
  })
  for (const b of $('dash-dau-toggle')?.querySelectorAll('button[data-w]') || []) {
    b.addEventListener('click', () => {
      DASH_STATE.dauWindow = b.dataset.w
      renderDashboardTab()
    })
  }
  for (const b of $('dash-req-toggle')?.querySelectorAll('button[data-h]') || []) {
    b.addEventListener('click', () => {
      DASH_STATE.reqHours = Number(b.dataset.h) || 24
      renderDashboardTab()
    })
  }
  for (const a of view().querySelectorAll('a[data-nav]')) {
    a.addEventListener('click', (e) => {
      e.preventDefault()
      navigate(a.dataset.nav, _navQueryFrom(a))
    })
  }

  // 30 秒自动刷新。切 tab 时 TAB_CLEANUPS.dashboard 会清掉 timer;此处捕获 seq
  // 防止上一轮 render 的"游离 timer"在清理前又塞一次 loadDashboardData 到队列。
  const timerSeq = mySeq
  DASH_STATE.refreshTimer = setInterval(() => {
    if (timerSeq !== DASH_STATE.renderSeq || _currentTab !== 'dashboard') return
    loadDashboardData(DASH_STATE.renderSeq).catch(() => {})
  }, 30_000)
}

/** 销毁 dashboard 所有缓存的 chart 实例,防止 tab 切换 / 重新渲染时泄漏。 */
function _destroyDashCharts() {
  for (const c of Object.values(DASH_STATE.charts)) {
    if (c) destroyChart(c)
  }
  DASH_STATE.charts = {}
}

/** 在 canvas 上画个"加载失败"文本占位。
 *  下一次 render 成功会走 destroyChart → 新 Chart.js 实例,占位自动被 Chart.js 盖住。 */
function _renderChartError(canvas, msg) {
  if (!canvas) return
  destroyChart(canvas)
  try {
    // R2 Codex L2:canvas 没被 Chart.js attach 过时,其 backing store 默认是
    // 300×150;直接按 canvas.width/height 居中画,文字会挤在左上角。
    // 先按父容器的 clientSize + devicePixelRatio 把 canvas 抻到实际可视大小,
    // 再画文字 —— 这样无论 chart-card-body 多大,"加载失败"都在视觉正中。
    const parent = canvas.parentElement
    const cssW = Math.max(160, parent?.clientWidth  || canvas.width)
    const cssH = Math.max(120, parent?.clientHeight || canvas.height)
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1))
    canvas.style.width  = `${cssW}px`
    canvas.style.height = `${cssH}px`
    canvas.width  = Math.round(cssW * dpr)
    canvas.height = Math.round(cssH * dpr)

    const ctx = canvas.getContext('2d')
    ctx.save()
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, cssW, cssH)
    ctx.fillStyle = getComputedStyle(document.documentElement)
      .getPropertyValue('--muted').trim() || '#888'
    ctx.font = '13px -apple-system, "Inter", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(msg || '加载失败'), cssW / 2, cssH / 2)
    ctx.restore()
  } catch {
    /* canvas 2d 不可用 ignore */
  }
}

/** 替换 alerts7d-body 的内容为占位文本前,先 destroy 已挂的 chart 防泄漏。
 *  下一轮恢复有数据时由 _ensureAlerts7dCanvas() 重建 canvas。 */
function _replaceAlerts7dWithText(bodyEl, html) {
  if (DASH_STATE.charts.alerts7d) {
    destroyChart(DASH_STATE.charts.alerts7d)
    DASH_STATE.charts.alerts7d = null
  }
  bodyEl.innerHTML = html
}

/** 确保 alerts7d-body 内有 canvas;若上一轮被 _replaceAlerts7dWithText 换成 div
 *  了,重建一个 canvas 节点并返回。 */
function _ensureAlerts7dCanvas(bodyEl) {
  let canvas = document.getElementById('dash-chart-alerts7d')
  if (!canvas) {
    bodyEl.innerHTML = ''
    canvas = document.createElement('canvas')
    canvas.id = 'dash-chart-alerts7d'
    bodyEl.appendChild(canvas)
  }
  return canvas
}

/**
 * 拉运营至今累计指标。独立于 30s 轮询(避免反复在 usage_records 上跑全表 COUNT/SUM)。
 *
 * 触发场景:
 *  - renderDashboardTab 首屏 fire-and-forget
 *  - 用户点 "刷新累计" 按钮
 *  - 用户点全局 "刷新" 不顺带刷 lifetime(单卡数据变化频率低,30s 轮询不需要)
 *
 * 失败:6 张卡同步降级为 "—" + "加载失败" warning,不影响其它部分。
 */
async function loadLifetimeStats(renderSeq) {
  const mySeq = ++DASH_STATE.lifetimeLoadSeq
  const sub = $('dash-lifetime-sub')
  if (sub) sub.textContent = '加载中…'

  let r = null
  let err = null
  try {
    r = await apiGet('/api/admin/stats/lifetime')
  } catch (e) {
    err = e
  }

  // 异步竞争防护:render 切换或 tab 切走则放弃
  if (renderSeq != null && renderSeq !== DASH_STATE.renderSeq) return
  if (_currentTab !== 'dashboard') return
  if (mySeq !== DASH_STATE.lifetimeLoadSeq) return

  const cards = view().querySelectorAll('#dash-lifetime-kpis .stat-card')
  if (!cards || cards.length < 6) return

  if (err || !r) {
    for (let i = 0; i < 6; i++) updateStat(cards[i], '—', '加载失败', 'danger')
    if (sub) sub.textContent = '加载失败'
    return
  }

  // 0. 累计用户(其中付费 N)
  updateStat(cards[0], Number(r.total_users || 0).toLocaleString(),
    `付费 ${Number(r.total_paying_users || 0).toLocaleString()}`,
    r.total_paying_users > 0 ? 'success' : null)

  // 1. 累计营收 ¥X
  const revYuan = Number(r.total_revenue_cents || '0') / 100
  updateStat(cards[1], `¥${revYuan.toFixed(2)}`,
    `自首单累计`, revYuan > 0 ? 'success' : null)

  // 2. 累计订单
  updateStat(cards[2], Number(r.total_orders_paid || 0).toLocaleString(),
    '已付清',
    r.total_orders_paid > 0 ? 'success' : null)

  // 3. 累计请求(大数走 compact,精度可接受)
  const reqNum = Number(r.total_requests || '0')
  updateStat(cards[3], cfmt.compact(reqNum), 'usage_records', null)

  // 4. 累计 Token(同上)
  const tokNum = Number(r.total_tokens || '0')
  updateStat(cards[4], cfmt.compact(tokNum), 'in+out+cache', null)

  // 5. 运营天数
  const days = Number(r.days_in_operation || 0)
  updateStat(cards[5], days > 0 ? days.toLocaleString() : '—',
    r.first_paid_at ? `自 ${String(r.first_paid_at).slice(0, 10)}` : '未开单', null)

  if (sub) sub.textContent = `更新于 ${new Date().toLocaleTimeString()}`
}

async function loadDashboardData(seq) {
  const dauW = DASH_STATE.dauWindow
  const reqH = DASH_STATE.reqHours
  // R3 Codex L1:timer + 手动刷新 + toggle 连点 可能并发触发两次 loadDashboardData。
  // 网络/后端延迟不保证"后发先到",旧请求若晚返回会把新结果覆盖回去(或"加载失败"
  // 覆盖成功态)。用独立 loadSeq 判定"我是不是最新一次 load",非最新直接 bail。
  const myLoadSeq = ++DASH_STATE.loadSeq

  // 并行拉 stats + 明细 (accounts / ledger) + orders KPI + P2 Plan v10 新 2 条
  // (hosts-utilization 用于"容器活跃""虚机利用率"KPI 与新堆叠柱;alert-events-7d
  // 替换原 24h alerts 卡)。每个端点独立 fulfilled/rejected,失败的不传染其他卡。
  const [dauR, revR, reqR, poolR, accountsR, ledgerR, ordersKpiR, hostsR, alerts7dR, signupsR] = await Promise.allSettled([
    apiGet(`/api/admin/stats/dau?window=${encodeURIComponent(dauW)}`),
    apiGet(`/api/admin/stats/revenue-by-day?days=14`),
    apiGet(`/api/admin/stats/request-series?hours=${reqH}`),
    apiGet(`/api/admin/stats/account-pool`),
    apiGet(`/api/admin/accounts`),
    apiGet(`/api/admin/ledger?limit=8`),
    apiGet(`/api/admin/orders/kpi`),
    apiGet(`/api/admin/stats/hosts-utilization`),
    apiGet(`/api/admin/stats/alert-events-7d`),
    apiGet(`/api/admin/stats/signups-by-day?days=14`),
  ])

  // R2 Codex M1:fetch 期间如果用户切 tab / 又触发了一次 renderDashboardTab,
  // 我们捕获的 seq 会过期。此时 DOM 可能已被替换,继续写是 no-op 但会在 canvas
  // 上挂 Chart.js 实例拖到下一轮泄漏。直接 bail,不改任何 DOM。
  // R3 Codex L1:同时检查 loadSeq —— 若另一个并发 loadDashboardData 已启动,
  // 本次结果已过期,直接丢弃。
  if (seq != null && (seq !== DASH_STATE.renderSeq || _currentTab !== 'dashboard')) return
  if (myLoadSeq !== DASH_STATE.loadSeq) return

  const dau        = dauR.status === 'fulfilled' ? dauR.value : null
  const revOk      = revR.status === 'fulfilled'
  const reqOk      = reqR.status === 'fulfilled'
  const poolOk     = poolR.status === 'fulfilled'
  const accountsOk = accountsR.status === 'fulfilled'
  const ledgerOk   = ledgerR.status  === 'fulfilled'
  const rev        = revOk    ? (revR.value?.rows || []) : []
  const reqSeries  = reqOk    ? (reqR.value?.rows || []) : []
  const pool       = poolOk   ? poolR.value : null
  const accounts   = accountsOk ? (accountsR.value?.rows || []) : []
  const ledger     = ledgerOk  ? (ledgerR.value?.rows  || []) : []
  const ordersKpiOk = ordersKpiR.status === 'fulfilled'
  const ordersKpi   = ordersKpiOk ? (ordersKpiR.value?.kpi || null) : null
  const hostsOk    = hostsR.status === 'fulfilled'
  const hostsUtil  = hostsOk ? hostsR.value : null
  const alerts7dOk = alerts7dR.status === 'fulfilled'
  const alerts7d   = alerts7dOk ? (alerts7dR.value?.rows || []) : []
  const signupsOk  = signupsR.status === 'fulfilled'
  const signups    = signupsOk ? (signupsR.value?.rows || []) : []

  // ─── KPI 卡片(P2 Plan v10:11 张,2 行 6+5) ───
  // 商业类(0..5): DAU / 新注册 / 付费 / 返场 / 7d营收 / 24h订单异常
  // 资源类(6..10): 24h请求 / 24h Token / 账号池可用 / 容器活跃 / 虚机利用率
  const statCards = view().querySelectorAll('#dash-kpis .stat-card')
  const wLabel = dauW === '24h' ? '24 小时' : dauW === '7d' ? '7 天' : '30 天'

  // 0-3. DAU 相关四张卡 — /stats/dau 失败 → "加载失败"占位
  if (dau) {
    updateStat(statCards[0], dau.active_users.toLocaleString(), `窗口 ${wLabel}`, null)
    updateStat(statCards[1], dau.new_users.toLocaleString(),
      `窗口 ${wLabel} 首次注册`, dau.new_users > 0 ? 'success' : null)
    updateStat(statCards[2], dau.paying_users.toLocaleString(),
      `窗口 ${wLabel} 有 topup`, dau.paying_users > 0 ? 'success' : null)
    updateStat(statCards[3], dau.returning_users.toLocaleString(),
      `窗口 ${wLabel} 登录/续签`, null)
  } else {
    for (const i of [0, 1, 2, 3]) updateStat(statCards[i], '—', '加载失败', 'danger')
  }

  // 4. 7d 营收 — 复用 revenue-by-day 14d 数据,取最近 7 天求和
  if (revOk) {
    const last7 = rev.slice(-7)
    const cents7 = last7.reduce((a, r) => a + (Number(r.paid_amount_cents) || 0), 0)
    const orders7 = last7.reduce((a, r) => a + (Number(r.orders_paid) || 0), 0)
    updateStat(statCards[4], `¥${(cents7 / 100).toFixed(2)}`,
      `${orders7} 笔 · 最近 7 天`, cents7 > 0 ? 'success' : null)
  } else {
    updateStat(statCards[4], '—', '加载失败', 'danger')
  }

  // 5. 24h 订单异常 — pending_overdue_24h + callback_conflicts_24h 合并
  if (ordersKpi) {
    const overdue24 = Number(ordersKpi.pending_overdue_24h || 0)
    const conflict24 = Number(ordersKpi.callback_conflicts_24h || 0)
    const total = overdue24 + conflict24
    const tone = conflict24 > 0 ? 'danger' : overdue24 > 0 ? 'warning' : null
    updateStat(statCards[5], total.toLocaleString(),
      total > 0 ? `卡单 ${overdue24} · 冲突 ${conflict24}` : '24h 无异常', tone)
  } else {
    updateStat(statCards[5], '—', '加载失败', 'danger')
  }

  // 6-7. request series — 失败 → "—"
  if (reqOk) {
    const totalReq = reqSeries.reduce((a, r) => a + (Number(r.total) || 0), 0)
    const totalErr = reqSeries.reduce((a, r) => a + (Number(r.error) || 0), 0)
    const errRate = totalReq > 0 ? (totalErr / totalReq) : 0
    updateStat(statCards[6], totalReq.toLocaleString(),
      totalReq > 0 ? `错误率 ${(errRate * 100).toFixed(2)}%` : `窗口 ${reqH}h 无请求`,
      totalReq === 0 ? null : (errRate > 0.05 ? 'danger' : errRate > 0.01 ? 'warning' : 'success'))
    const totalTokens = reqSeries.reduce((a, r) => {
      const t = Number(r.tokens || 0)
      return Number.isFinite(t) ? a + t : a
    }, 0)
    updateStat(statCards[7], cfmt.compact(totalTokens), `窗口 ${reqH}h 总 token`, null)
  } else {
    updateStat(statCards[6], '—', '加载失败', 'danger')
    updateStat(statCards[7], '—', '加载失败', 'danger')
  }

  // 8. 账号池可用
  if (pool) {
    const avail = pool.active
    const tot = pool.total
    const tone = tot === 0 ? null : (avail === tot ? 'success'
      : pool.cooldown > 0 ? 'warning' : 'danger')
    const meta = pool.cooldown > 0 ? `${pool.cooldown} 冷却`
      : (pool.disabled + pool.banned > 0 ? `${pool.disabled + pool.banned} 禁用/封禁` : '全部健康')
    updateStat(statCards[8], `${avail} / ${tot}`, meta, tone)
  } else {
    updateStat(statCards[8], '—', '加载失败', 'danger')
  }

  // 9-10. 容器活跃 / 虚机利用率(P2 Plan v10 新)
  if (hostsUtil) {
    const used = Number(hostsUtil.used || 0)
    const cap = Number(hostsUtil.capacity || 0)
    updateStat(statCards[9], used.toLocaleString(),
      `${(hostsUtil.per_host || []).length} 台主机`, used > 0 ? 'success' : null)
    if (cap > 0) {
      const pct = (used / cap) * 100
      const tone = pct >= 90 ? 'danger' : pct >= 70 ? 'warning' : null
      updateStat(statCards[10], `${pct.toFixed(0)}%`, `${used} / ${cap} 容量`, tone)
    } else {
      updateStat(statCards[10], '—', '无主机配额', null)
    }
  } else {
    updateStat(statCards[9], '—', '加载失败', 'danger')
    updateStat(statCards[10], '—', '加载失败', 'danger')
  }

  // KPI 跳转:订单异常 → orders;容器活跃 / 虚机利用率 → containers / hosts
  statCards[5]?.addEventListener('click', () => {
    sessionStorage.removeItem('admin_orders_status')
    navigate('orders')
  })
  statCards[9]?.addEventListener('click', () => navigate('containers'))
  statCards[10]?.addEventListener('click', () => navigate('hosts'))
  for (const i of [5, 9, 10]) {
    if (statCards[i]) statCards[i].style.cursor = 'pointer'
  }

  // ─── Chart: 请求趋势(折线)───
  const reqCanvas = document.getElementById('dash-chart-req')
  if (reqCanvas) {
    if (reqOk) {
      reqCanvas.style.display = ''
      DASH_STATE.charts.req = reqCanvas
      lineChart(reqCanvas, {
        labels: reqSeries.map((r) => reqH > 24 ? r.hour.slice(5, 16) : cfmt.hourShort(r.hour)),
        series: [
          { label: '成功', data: reqSeries.map((r) => Number(r.success) || 0), fill: true },
          { label: '错误', data: reqSeries.map((r) => Number(r.error) || 0), color: getComputedStyle(document.documentElement).getPropertyValue('--danger').trim() || '#e06c6c', fill: false },
          { label: '独立用户', data: reqSeries.map((r) => Number(r.users) || 0), color: getComputedStyle(document.documentElement).getPropertyValue('--warn').trim() || '#e8b64c', fill: false },
        ],
      })
    } else {
      _renderChartError(reqCanvas, '加载失败')
    }
  }

  // ─── Chart: 虚机利用率分布(P2 Plan v10:每 host 一根柱,active vs free) ───
  const hostsCanvas = document.getElementById('dash-chart-hosts')
  if (hostsCanvas) {
    if (hostsUtil) {
      const phs = hostsUtil.per_host || []
      DASH_STATE.charts.hosts = hostsCanvas
      // 名字过长截断到 16 字;主机数受 hosts 表 max_containers 配额管理,实际不会过多
      const labels = phs.map((h) => (h.name || h.uuid || '').slice(0, 16))
      const activeData = phs.map((h) => Number(h.active) || 0)
      const freeData = phs.map((h) => Math.max(0, (Number(h.max) || 0) - (Number(h.active) || 0)))
      barChart(hostsCanvas, {
        labels,
        stacked: true,
        series: [
          { label: '已用', data: activeData },
          { label: '剩余', data: freeData,
            color: getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#888' },
        ],
        yFormatter: (v) => Number.isInteger(v) ? String(v) : v.toFixed(1),
      })
    } else {
      _renderChartError(hostsCanvas, '加载失败')
    }
  }

  // ─── Chart: 营收柱状 ───
  const revCanvas = document.getElementById('dash-chart-revenue')
  if (revCanvas) {
    if (revOk) {
      DASH_STATE.charts.rev = revCanvas
      barChart(revCanvas, {
        labels: rev.map((r) => cfmt.dayShort(r.day)),
        series: [
          { label: '订单金额(元)', data: rev.map((r) => Number(r.paid_amount_cents) / 100) },
          { label: '新订阅数',    data: rev.map((r) => Number(r.new_subscriptions) || 0),
            color: getComputedStyle(document.documentElement).getPropertyValue('--warn').trim() || '#e8b64c' },
        ],
        yFormatter: (v) => {
          // 第一 series 是元,第二是订阅数;formatter 对二者都生效,尺度主要由订单金额主导。
          return Number.isInteger(v) ? String(v) : v.toFixed(1)
        },
      })
      const sub = $('dash-revenue-sub')
      if (sub) {
        const totalY = rev.reduce((a, r) => a + Number(r.paid_amount_cents) / 100, 0)
        const totalO = rev.reduce((a, r) => a + (Number(r.orders_paid) || 0), 0)
        sub.textContent = `合计 ¥${totalY.toFixed(2)}  ·  ${totalO} 笔`
      }
    } else {
      _renderChartError(revCanvas, '加载失败')
      const sub = $('dash-revenue-sub')
      if (sub) sub.textContent = '—'
    }
  }

  // ─── Chart: 新注册柱状(signups + verified 双柱)───
  const signupsCanvas = document.getElementById('dash-chart-signups')
  if (signupsCanvas) {
    if (signupsOk) {
      DASH_STATE.charts.signups = signupsCanvas
      barChart(signupsCanvas, {
        labels: signups.map((r) => cfmt.dayShort(r.day)),
        series: [
          { label: '新注册', data: signups.map((r) => Number(r.signups) || 0) },
          { label: '已验证', data: signups.map((r) => Number(r.verified) || 0),
            color: getComputedStyle(document.documentElement).getPropertyValue('--success').trim() || '#5cb85c' },
        ],
        yFormatter: (v) => Number.isInteger(v) ? String(v) : v.toFixed(1),
      })
      const sub = $('dash-signups-sub')
      if (sub) {
        const totalS = signups.reduce((a, r) => a + (Number(r.signups) || 0), 0)
        const totalV = signups.reduce((a, r) => a + (Number(r.verified) || 0), 0)
        sub.textContent = `合计 ${totalS} 注册  ·  ${totalV} 已验证`
      }
    } else {
      _renderChartError(signupsCanvas, '加载失败')
      const sub = $('dash-signups-sub')
      if (sub) sub.textContent = '—'
    }
  }

  // ─── Chart: 告警 · 7d 事件分布(P2 Plan v10:每天一根柱,按 event_type 堆叠) ───
  // - 永远固定 7 根日柱(今天 - 6 ... 今天),稀疏事件 0 补齐,避免视觉误导(Codex review #1)
  // - empty 判定看 totalCount(行数 0 或聚合 0 都算 empty-ok)
  // - DOM:用 _ensureAlerts7dCanvas() 在 empty/失败 后能恢复 canvas;若直接 innerHTML
  //   替换 canvas → 下一轮 30s 刷新 getElementById 拿不到 canvas 卡死(Codex review #1)
  const alertsBody = $('dash-alerts7d-body')
  if (alertsBody) {
    if (!alerts7dOk) {
      _replaceAlerts7dWithText(alertsBody,
        '<div class="empty" style="padding:var(--s-3);font-size:13px;color:var(--danger)">加载失败</div>')
    } else {
      // 1. 固定生成最近 7 天 day labels(本地时区,与 PG date_trunc 服务器时区可能差一天,
      //    跨边界的 row 直接丢弃 — admin 看趋势够用)
      const days = []
      const today = new Date()
      for (let i = 6; i >= 0; i--) {
        const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)
        const yyyy = d.getFullYear()
        const mm = String(d.getMonth() + 1).padStart(2, '0')
        const dd = String(d.getDate()).padStart(2, '0')
        days.push(`${yyyy}-${mm}-${dd}`)
      }
      const dayIndex = new Map(days.map((d, i) => [d, i]))
      // 2. 收集 event_type(出场顺序)
      const types = []
      const typeIndex = new Map()
      for (const r of alerts7d) {
        if (!typeIndex.has(r.event_type)) {
          typeIndex.set(r.event_type, types.length)
          types.push(r.event_type)
        }
      }
      // 3. 矩阵 + total
      const matrix = types.map(() => days.map(() => 0))
      let total = 0
      for (const r of alerts7d) {
        const di = dayIndex.get(r.day)
        if (di == null) continue  // 7 日窗口外的 row 丢弃
        const ti = typeIndex.get(r.event_type)
        const v = Number(r.count) || 0
        matrix[ti][di] = v
        total += v
      }
      if (total === 0) {
        _replaceAlerts7dWithText(alertsBody,
          `<div class="empty-ok" style="padding:var(--s-4);font-size:13px;color:var(--ok);text-align:center;">近 7 天无告警 · 一切正常</div>`)
      } else {
        const canvas = _ensureAlerts7dCanvas(alertsBody)
        DASH_STATE.charts.alerts7d = canvas
        barChart(canvas, {
          labels: days.map((d) => cfmt.dayShort(d)),
          stacked: true,
          series: types.map((t, i) => ({ label: t, data: matrix[i] })),
          yFormatter: (v) => Number.isInteger(v) ? String(v) : v.toFixed(1),
        })
      }
    }
  }

  // ─── 账号池明细列 ───
  const poolEl = $('dash-pools')
  if (poolEl) {
    if (!accountsOk) {
      // R2 Codex L1:拉账号列表失败时明确告诉用户"加载失败",
      // 别和"真的没账号"(空数组)混在一起。
      poolEl.innerHTML = '<div class="empty" style="padding:var(--s-3);font-size:13px;color:var(--danger)">加载失败</div>'
    } else if (accounts.length === 0) {
      poolEl.innerHTML = '<div class="empty" style="padding:var(--s-3);font-size:13px;color:var(--muted)">暂无账号</div>'
    } else {
      poolEl.innerHTML = accounts.slice(0, 6).map((a) => {
        const s = a.status
        const tone = s === 'active' ? 'success' : s === 'cooldown' ? 'warning' : 'danger'
        const health = Number(a.health_score ?? 100)
        const loadPct = Math.max(2, Math.min(100, Math.round(health)))
        return `
          <div class="pool-row">
            <code>${escapeHtml(a.label || `#${a.id}`)}</code>
            <div class="pool-bar"><div class="pool-bar-fill pool-${tone}" style="width:${loadPct}%"></div></div>
            <span class="pool-meta">${escapeHtml(a.plan || '-')}</span>
            <span class="chip ${tone === 'success' ? '' : 'chip-accent'}">
              <span class="chip-dot chip-dot-${tone}"></span>${escapeHtml(s)}
            </span>
          </div>`
      }).join('')
    }
  }

  // ─── 最近流水 ───
  const activityEl = $('dash-activity')
  if (activityEl) {
    if (!ledgerOk) {
      // R2 Codex L1:同上,区分"ledger 拉失败"与"真的没流水"。
      activityEl.innerHTML = '<div class="empty" style="padding:var(--s-3);font-size:13px;color:var(--danger)">加载失败</div>'
    } else if (ledger.length === 0) {
      activityEl.innerHTML = '<div class="empty" style="padding:var(--s-3);font-size:13px;color:var(--muted)">暂无流水</div>'
    } else {
      activityEl.innerHTML = ledger.map((l) => {
        const t = fmtTime(l.created_at)
        const delta = Number(l.delta || 0)
        const cls = delta > 0 ? 'is-positive' : delta < 0 ? 'is-negative' : ''
        const sign = delta > 0 ? '+' : ''
        // 中文 label 复用顶部 LEDGER_REASON_LABELS(与后端 LEDGER_REASONS 同步)。
        const kindLabel = LEDGER_REASON_LABELS[l.reason] || l.reason
        return `
          <div class="log-row">
            <span class="mono">${escapeHtml(t)}</span>
            <span class="log-actor" title="${escapeHtml(String(l.user_id || ''))}"><code>${escapeHtml(String(l.user_id || '—').slice(0, 8))}</code> · ${escapeHtml(kindLabel)}</span>
            <span class="log-delta ${cls}">${sign}${fmtCents(delta)}</span>
            <span class="log-status ok">ok</span>
          </div>`
      }).join('')
    }
  }

  const ts = $('dash-last-refresh')
  if (ts) ts.textContent = `更新于 ${fmtTime(new Date().toISOString())}  ·  30s 自动刷新`
}

/** ISO 时间 → "刚刚" / "3 分钟前" / "2 天前" / "2026-01-03"(超 30 天)。 */
function fmtRelative(iso) {
  if (!iso) return '—'
  try {
    const t = new Date(iso).getTime()
    if (Number.isNaN(t)) return '—'
    const diff = Math.max(0, Math.floor((Date.now() - t) / 1000))
    if (diff < 30) return '刚刚'
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
    if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`
    return new Date(iso).toISOString().slice(0, 10)
  } catch { return '—' }
}

function updateStat(card, value, delta, tone) {
  if (!card) return
  const v = card.querySelector('.stat-value')
  const d = card.querySelector('.stat-delta')
  if (v) {
    v.classList.remove('is-loading')
    v.textContent = value
  }
  if (d) {
    d.textContent = delta || ''
    d.classList.remove('stat-success', 'stat-warning', 'stat-danger')
    if (tone) d.classList.add(`stat-${tone}`)
  }
}

function fmtTime(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return String(iso).slice(11, 19)
    const HH = String(d.getHours()).padStart(2, '0')
    const MM = String(d.getMinutes()).padStart(2, '0')
    const SS = String(d.getSeconds()).padStart(2, '0')
    return `${HH}:${MM}:${SS}`
  } catch { return '—' }
}

// ─── Tab: Users ─────────────────────────────────────────────────────

// 单 tab 状态 —— cursor 累积分页 + 触发版本号防异步竞态(沿用 dashboard 模式)。
// 每次 renderUsersTab() 进入就递增 renderSeq,中途异步 continuation 必须确认
// 自己仍是"最新一次 render"才能写 DOM。
const USERS_STATE = {
  renderSeq: 0,
  loadSeq: 0,
  /** 全部已加载的行(按 id DESC 排,append 更多的追加到末尾)。 */
  rows: [],
  /** 下一页 cursor;为 null 表示已到底。 */
  nextCursor: null,
  /** 当前搜索/过滤快照,用于判断"按条件翻下一页"时是否还是同一查询。 */
  q: '',
  status: '',
  /** P-FILTER:注册时间 chip — 空 / today / yesterday / 7d / 30d。 */
  registeredWithin: '',
  /** P-FILTER:漏斗状态 chip — 空 / unverified / no_topup / no_request / silent_24h。 */
  funnelState: '',
  /** P-FUNNEL:漏斗 KPI 窗口 7 / 30(只前端显示用,后端两个参数化端点)。 */
  funnelDays: 7,
  /** 防 funnel KPI 异步竞态(切 7/30 来回点)。 */
  funnelLoadSeq: 0,
}

const REG_WITHIN_CHIPS = [
  { value: '',          label: '全部时间' },
  { value: 'today',     label: '今天' },
  { value: 'yesterday', label: '昨天' },
  { value: '7d',        label: '7 天内' },
  { value: '30d',       label: '30 天内' },
]
const FUNNEL_STATE_CHIPS = [
  { value: '',             label: '全部漏斗' },
  { value: 'unverified',   label: '未验证邮箱' },
  { value: 'no_topup',     label: '未充值' },
  { value: 'no_request',   label: '未请求' },
  { value: 'silent_24h',   label: '注册满 24h 沉默' },
]

const USERS_PAGE_SIZE = 50

/** 格式化"上一次活跃"的 tone:>7 天 danger,>1 天 warn,否则 ok。 */
function _userActiveTone(iso) {
  if (!iso) return 'muted'
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff > 86400 * 7) return 'danger'
  if (diff > 86400) return 'warn'
  return 'ok'
}

async function renderUsersTab() {
  const mySeq = ++USERS_STATE.renderSeq

  // toolbar 状态从 sessionStorage 恢复;state reset 只保留过滤条件不保留 rows。
  USERS_STATE.q = sessionStorage.getItem('admin_users_q') || ''
  USERS_STATE.status = sessionStorage.getItem('admin_users_status') || ''
  USERS_STATE.registeredWithin = sessionStorage.getItem('admin_users_reg_within') || ''
  USERS_STATE.funnelState = sessionStorage.getItem('admin_users_funnel') || ''
  const fdRaw = Number(sessionStorage.getItem('admin_users_funnel_days') || '7')
  USERS_STATE.funnelDays = fdRaw === 30 ? 30 : 7
  USERS_STATE.rows = []
  USERS_STATE.nextCursor = null

  const q = USERS_STATE.q
  const status = USERS_STATE.status
  const fday = USERS_STATE.funnelDays

  view().innerHTML = `
    <div class="panel">
      <div class="dash-h1">
        <h2>用户 <span class="dash-sub" id="u-count">加载中…</span></h2>
        <div style="display:flex;gap:var(--s-2);align-items:center;">
          <button class="btn" id="u-refresh">刷新</button>
        </div>
      </div>

      <div class="stat-grid" id="u-kpis">
        ${['总用户数','7 天新注册','7 天活跃','7 天付费用户'].map((label) => `
          <div class="stat-card">
            <div class="stat-label">${escapeHtml(label)}</div>
            <div class="stat-value is-loading">—</div>
            <div class="stat-delta">—</div>
          </div>`).join('')}
      </div>

      <div class="dash-h1" style="margin-top:var(--s-3);">
        <h3 style="margin:0;font-size:14px;">新用户漏斗 <span class="dash-sub" id="u-funnel-sub">最近 ${fday} 天</span></h3>
        <div class="chart-toggle" id="u-funnel-toggle">
          <button data-d="7"  class="${fday===7 ?'is-active':''}">7d</button>
          <button data-d="30" class="${fday===30?'is-active':''}">30d</button>
        </div>
      </div>
      <div class="stat-grid" id="u-funnel-kpis">
        ${['cohort 总数','已验证邮箱','首次充值','首次请求','D1 留存','D7 留存'].map((label) => `
          <div class="stat-card">
            <div class="stat-label">${escapeHtml(label)}</div>
            <div class="stat-value is-loading">—</div>
            <div class="stat-delta">—</div>
          </div>`).join('')}
      </div>

      <div class="toolbar" style="margin-top:var(--s-3);">
        <input type="text" id="u-q" placeholder="搜索 邮箱 / id / 显示名"
               value="${escapeHtml(q)}" />
        <select id="u-status">
          <option value="">全部状态</option>
          <option value="active"   ${status === 'active'   ? 'selected' : ''}>active</option>
          <option value="banned"   ${status === 'banned'   ? 'selected' : ''}>banned</option>
          <option value="deleting" ${status === 'deleting' ? 'selected' : ''}>deleting</option>
          <option value="deleted"  ${status === 'deleted'  ? 'selected' : ''}>deleted</option>
        </select>
        <button class="btn btn-primary" id="u-search">搜索</button>
      </div>

      <div id="u-chips-reg" style="display:flex;gap:var(--s-1);flex-wrap:wrap;margin-top:var(--s-2);align-items:center;">
        <span style="font-size:12px;color:var(--muted);margin-right:4px;">注册时间:</span>
        ${REG_WITHIN_CHIPS.map((c) => `
          <button class="chip ${USERS_STATE.registeredWithin === c.value ? 'chip-ok' : 'chip-muted'}"
                  data-rw="${escapeHtml(c.value)}">${escapeHtml(c.label)}</button>`).join('')}
      </div>
      <div id="u-chips-funnel" style="display:flex;gap:var(--s-1);flex-wrap:wrap;margin-top:var(--s-1);align-items:center;">
        <span style="font-size:12px;color:var(--muted);margin-right:4px;">漏斗:</span>
        ${FUNNEL_STATE_CHIPS.map((c) => `
          <button class="chip ${USERS_STATE.funnelState === c.value ? 'chip-ok' : 'chip-muted'}"
                  data-fs="${escapeHtml(c.value)}">${escapeHtml(c.label)}</button>`).join('')}
      </div>

      <div id="u-table-container" style="margin-top:var(--s-2);">
        <div class="skeleton-row"><div class="skeleton-bar w60"></div></div>
      </div>

      <div id="u-load-more" style="margin-top:var(--s-3);display:none;text-align:center;">
        <button class="btn" id="u-load-more-btn">加载更多</button>
      </div>
    </div>`

  // ─── 事件绑定(先绑再 await,避免 Enter/Click 被 await 期间吞掉)───
  $('u-search').addEventListener('click', () => {
    sessionStorage.setItem('admin_users_q', $('u-q').value.trim())
    sessionStorage.setItem('admin_users_status', $('u-status').value)
    applyHash()
  })
  $('u-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('u-search').click() })
  $('u-refresh').addEventListener('click', () => applyHash())
  $('u-load-more-btn').addEventListener('click', async (ev) => {
    await withBtnLoading(ev.currentTarget, () => _loadMoreUsers(mySeq))
  })
  // chip 单选;再点同一个等于"清空"。变化触发完整 reload(走 applyHash 让 URL 也保持一致)。
  for (const b of $('u-chips-reg')?.querySelectorAll('button[data-rw]') || []) {
    b.addEventListener('click', () => {
      const next = USERS_STATE.registeredWithin === b.dataset.rw ? '' : b.dataset.rw
      sessionStorage.setItem('admin_users_reg_within', next)
      applyHash()
    })
  }
  for (const b of $('u-chips-funnel')?.querySelectorAll('button[data-fs]') || []) {
    b.addEventListener('click', () => {
      const next = USERS_STATE.funnelState === b.dataset.fs ? '' : b.dataset.fs
      sessionStorage.setItem('admin_users_funnel', next)
      applyHash()
    })
  }
  for (const b of $('u-funnel-toggle')?.querySelectorAll('button[data-d]') || []) {
    b.addEventListener('click', () => {
      const d = Number(b.dataset.d) === 30 ? 30 : 7
      sessionStorage.setItem('admin_users_funnel_days', String(d))
      USERS_STATE.funnelDays = d
      // 不走 applyHash —— 7/30 切换只影响 funnel KPI,不重拉用户列表。
      const sub = $('u-funnel-sub'); if (sub) sub.textContent = `最近 ${d} 天`
      for (const x of $('u-funnel-toggle')?.querySelectorAll('button[data-d]') || []) {
        x.classList.toggle('is-active', Number(x.dataset.d) === d)
      }
      _loadFunnelKpis(mySeq)
    })
  }

  await Promise.all([
    _loadUsersKpis(mySeq),
    _loadFunnelKpis(mySeq),
    _loadMoreUsers(mySeq),  // 首次加载 = 首页加载 = "加载更多"的第一次
  ])
}

/** 加载漏斗 KPI(独立 funnelLoadSeq 防 7/30 切换连点)。 */
async function _loadFunnelKpis(renderSeq) {
  const myLoadSeq = ++USERS_STATE.funnelLoadSeq
  const days = USERS_STATE.funnelDays
  let f
  try {
    f = await apiGet(`/api/admin/stats/funnel?days=${days}`)
  } catch {
    if (renderSeq !== USERS_STATE.renderSeq || myLoadSeq !== USERS_STATE.funnelLoadSeq) return
    if (_currentTab !== 'users') return
    const cards = view().querySelectorAll('#u-funnel-kpis .stat-card')
    for (const c of cards) updateStat(c, '—', '加载失败', 'danger')
    return
  }
  if (renderSeq !== USERS_STATE.renderSeq || myLoadSeq !== USERS_STATE.funnelLoadSeq) return
  if (_currentTab !== 'users') return

  const cards = view().querySelectorAll('#u-funnel-kpis .stat-card')
  const total = Number(f.cohort_total) || 0
  const verified = Number(f.verified) || 0
  const topup = Number(f.first_topup) || 0
  const req = Number(f.first_request) || 0
  const elig1 = Number(f.eligible_for_d1) || 0
  const elig7 = Number(f.eligible_for_d7) || 0
  const ret1 = Number(f.d1_retained) || 0
  const ret7 = Number(f.d7_retained) || 0
  const pct = (n, d) => d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—'

  // cohort 总数
  updateStat(cards[0], total.toLocaleString(),
    total > 0 ? `最近 ${days} 天注册` : `最近 ${days} 天无新注册`, total > 0 ? 'success' : null)
  // verified — 占 cohort 比例
  updateStat(cards[1], verified.toLocaleString(),
    total > 0 ? `占 cohort ${pct(verified, total)}` : '—',
    total > 0 && verified / total < 0.5 ? 'warning' : null)
  // 首次充值 — 占 cohort 比例
  updateStat(cards[2], topup.toLocaleString(),
    total > 0 ? `占 cohort ${pct(topup, total)}` : '—',
    topup > 0 ? 'success' : null)
  // 首次请求 — 占 cohort 比例
  updateStat(cards[3], req.toLocaleString(),
    total > 0 ? `占 cohort ${pct(req, total)}` : '—',
    req > 0 ? 'success' : null)
  // D1 留存 — 注意 eligible 分母
  updateStat(cards[4], pct(ret1, elig1),
    elig1 > 0 ? `${ret1} / ${elig1} 合格 cohort` : '窗口未到',
    elig1 > 0 && ret1 / elig1 < 0.2 ? 'warning' : null)
  // D7 留存
  updateStat(cards[5], pct(ret7, elig7),
    elig7 > 0 ? `${ret7} / ${elig7} 合格 cohort` : '窗口未到',
    elig7 > 0 && ret7 / elig7 < 0.1 ? 'warning' : null)
}

/** 加载/刷新一页用户(cursor = USERS_STATE.nextCursor,或首页 null)。 */
async function _loadMoreUsers(renderSeq) {
  const myLoadSeq = ++USERS_STATE.loadSeq
  const sp = new URLSearchParams({
    with_stats: '1',
    limit: String(USERS_PAGE_SIZE),
  })
  if (USERS_STATE.q) sp.set('q', USERS_STATE.q)
  if (USERS_STATE.status) sp.set('status', USERS_STATE.status)
  if (USERS_STATE.registeredWithin) sp.set('registered_within', USERS_STATE.registeredWithin)
  if (USERS_STATE.funnelState) sp.set('funnel_state', USERS_STATE.funnelState)
  if (USERS_STATE.nextCursor) sp.set('cursor', USERS_STATE.nextCursor)

  const isFirstPage = USERS_STATE.rows.length === 0 && !USERS_STATE.nextCursor
  let data
  try {
    data = await apiGet(`/api/admin/users?${sp.toString()}`)
  } catch (err) {
    if (renderSeq !== USERS_STATE.renderSeq || _currentTab !== 'users') return
    toast(`加载失败:${err.message}`, 'danger', toastOptsFromError(err))
    // 首屏失败 → 表格区显示错误态并停用 "加载更多";非首屏保留已有 rows + toast
    if (isFirstPage) {
      const el = $('u-table-container')
      if (el) el.innerHTML = `<div class="empty" style="color:var(--danger)">加载失败:${escapeHtml(err.message)}</div>`
      const cnt = $('u-count'); if (cnt) cnt.textContent = '—'
      USERS_STATE.nextCursor = null
      _toggleLoadMoreBtn()
    }
    return
  }
  if (renderSeq !== USERS_STATE.renderSeq || myLoadSeq !== USERS_STATE.loadSeq) return
  if (_currentTab !== 'users') return

  const newRows = data?.rows ?? []
  USERS_STATE.rows.push(...newRows)
  USERS_STATE.nextCursor = data?.next_cursor ?? null

  _renderUsersTable()
  _updateUsersCount()
  _toggleLoadMoreBtn()
}

/** 并行拉 KPI(/users/stats),4 张卡片各自独立填值;失败保持 "—"。 */
async function _loadUsersKpis(renderSeq) {
  let s
  try {
    s = await apiGet('/api/admin/users/stats')
  } catch {
    if (renderSeq !== USERS_STATE.renderSeq) return
    const cards = view().querySelectorAll('#u-kpis .stat-card')
    for (const c of cards) updateStat(c, '—', '加载失败', 'danger')
    return
  }
  if (renderSeq !== USERS_STATE.renderSeq || _currentTab !== 'users') return

  const cards = view().querySelectorAll('#u-kpis .stat-card')
  updateStat(cards[0], s.total_users.toLocaleString(),
    `active ${s.active_users} · banned ${s.banned_users} · 已删 ${s.deleted_users}`,
    s.banned_users > 0 ? 'warning' : 'success')
  updateStat(cards[1], s.new_7d.toLocaleString(),
    `7d 累计`, s.new_7d > 0 ? 'success' : null)
  updateStat(cards[2], s.active_7d.toLocaleString(),
    `有 usage_records 的独立用户`, null)
  updateStat(cards[3], s.paying_7d.toLocaleString(),
    `平均余额 ${fmtCents(s.avg_credits_cents)}`,
    s.paying_7d > 0 ? 'success' : null)
}

function _renderUsersTable() {
  const el = $('u-table-container')
  if (!el) return
  const rows = USERS_STATE.rows
  if (rows.length === 0) {
    el.innerHTML = '<div class="empty">无用户</div>'
    return
  }
  el.innerHTML = `
    <table class="data">
      <thead>
        <tr>
          <th>id</th>
          <th>邮箱</th>
          <th>显示名</th>
          <th>角色</th>
          <th>状态</th>
          <th>余额</th>
          <th>累计充值</th>
          <th>今日请求</th>
          <th>最近活跃</th>
          <th>注册时间</th>
          <th class="actions">操作</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(_renderUserRow).join('')}
      </tbody>
    </table>`
  for (const b of el.querySelectorAll('button[data-act="adjust"]')) {
    b.addEventListener('click', (e) => {
      e.stopPropagation() // 防止冒泡到 tr 触发 detail modal
      openAdjustCreditsModal(b.dataset.id)
    })
  }
  // chip-跳转(用户行的"X 容器" → containers tab + email 过滤)
  for (const a of el.querySelectorAll('a[data-nav]')) {
    a.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      navigate(a.dataset.nav, _navQueryFrom(a))
    })
  }
  // 行点击 → 打开 detail modal(adjust 按钮 / chip-跳转都已 stopPropagation)
  for (const tr of el.querySelectorAll('tr[data-uid]')) {
    tr.addEventListener('click', () => openUserDetailModal(tr.dataset.uid))
  }
}

function _renderUserRow(u) {
  const errRate = u.today_requests > 0
    ? (u.today_errors / u.today_requests)
    : 0
  const errTone = errRate > 0.1 ? 'danger'
    : errRate > 0.02 ? 'warn'
    : (u.today_requests > 0 ? 'ok' : 'muted')
  const reqCell = u.today_requests > 0
    ? `<span>${u.today_requests}</span>
       <small class="chip chip-${errTone}" style="margin-left:4px;">${(errRate * 100).toFixed(1)}%</small>`
    : '<span class="muted">—</span>'

  const lastTone = _userActiveTone(u.last_active_at)
  const lastCell = u.last_active_at
    ? `<span class="chip chip-${lastTone}" title="${escapeHtml(fmtDate(u.last_active_at))}">${escapeHtml(fmtRelative(u.last_active_at))}</span>`
    : '<span class="muted">从未</span>'

  // 当前活跃容器数 chip:>0 → 链跳到 containers tab + email 过滤;0 → muted。
  const ctActive = Number(u.containers_active ?? 0)
  const ctChip = ctActive > 0
    ? `<a class="chip chip-muted" data-nav="containers" data-q-user_email="${escapeHtml(u.email || '')}" title="查看该用户的活跃容器">${ctActive} 容器</a>`
    : `<span class="chip chip-muted" style="opacity:.5">0 容器</span>`

  return `
    <tr data-uid="${escapeHtml(u.id)}" style="cursor:pointer;" title="点击查看详情">
      <td class="mono">${escapeHtml(u.id)}</td>
      <td>
        ${escapeHtml(u.email || '')}
        ${u.email_verified
          ? '<span class="badge ok" title="已验证">✓</span>'
          : '<span class="badge warn" title="未验证邮箱">未验证</span>'}
        ${ctChip}
      </td>
      <td>${escapeHtml(u.display_name || '')}</td>
      <td><span class="badge ${u.role === 'admin' ? 'warn' : 'muted'}">${escapeHtml(u.role)}</span></td>
      <td>${statusBadge(u.status)}</td>
      <td class="num">${fmtCents(u.credits)}</td>
      <td class="num">${fmtCents(u.total_topup_cents)}</td>
      <td class="num">${reqCell}</td>
      <td>${lastCell}</td>
      <td class="mono">${fmtDate(u.created_at)}</td>
      <td class="actions">
        <button data-act="adjust" data-id="${escapeHtml(u.id)}">±余额</button>
      </td>
    </tr>`
}

function _updateUsersCount() {
  const el = $('u-count')
  if (!el) return
  const n = USERS_STATE.rows.length
  const more = USERS_STATE.nextCursor ? '+' : ''
  el.textContent = `共 ${n}${more} 人`
}

function _toggleLoadMoreBtn() {
  const wrap = $('u-load-more')
  if (!wrap) return
  wrap.style.display = USERS_STATE.nextCursor ? '' : 'none'
}

function openAdjustCreditsModal(userId) {
  // 2026-04-21 安全审计 MED:UI 接受 ¥ 单位、内部转 cents,避免 admin 误把
  // "加 ¥1" 输成 1(实际 1 分)或 100x 加多。实时 preview 显示 cents 等价值。
  openModal(`
    <h3>调整余额(用户 ${escapeHtml(userId)})</h3>
    <div class="form-row">
      <label>金额(¥;支持两位小数,正数加,负数扣)</label>
      <input type="text" id="adj-delta" placeholder="例如 1.00 或 -0.50" autocomplete="off" />
      <div class="hint" id="adj-preview" style="margin-top:4px; color:#888; font-size:12px;">解析后:—</div>
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
  const updatePreview = () => {
    const raw = $('adj-delta').value
    const cents = parseYuanToCents(raw)
    const el = $('adj-preview')
    if (cents == null) {
      el.textContent = raw.trim() === '' ? '解析后:—' : '解析后:无效金额'
      el.style.color = raw.trim() === '' ? '#888' : '#c00'
    } else {
      el.textContent = `解析后:${fmtCents(cents)}(${cents} 分)`
      el.style.color = '#0a0'
    }
  }
  $('adj-delta').addEventListener('input', updatePreview)
  $('adj-cancel').addEventListener('click', closeModal)
  $('adj-ok').addEventListener('click', async (ev) => {
    const raw = $('adj-delta').value
    const memo = $('adj-memo').value.trim()
    const cents = parseYuanToCents(raw)
    if (cents == null) {
      toast('金额必须是非零数字,最多 2 位小数(如 1.00 / -0.50)', 'danger'); return
    }
    if (!memo) { toast('memo 不能为空', 'danger'); return }
    await withBtnLoading(ev.currentTarget, async () => {
      try {
        const r = await apiJson('POST', `/api/admin/users/${userId}/credits`,
          { delta: String(cents), memo })
        toast(`已记账,新余额 ${fmtCents(r.balance_after)}`)
        closeModal()
        applyHash()
      } catch (e) {
        toast(`失败: ${e.message}`, 'danger', toastOptsFromError(e))
      }
    })
  })
}

/** 用户详情 modal — 后端 GET /api/admin/users/:id/detail。 */
async function openUserDetailModal(userId) {
  // 先开 modal 占位,异步加载;失败 → modal 内显示错误,不关闭。
  openModal(`
    <h3>用户详情 #${escapeHtml(userId)}</h3>
    <div id="ud-body" style="min-height:200px;">
      <div class="skeleton-row"><div class="skeleton-bar w60"></div></div>
    </div>
    <div class="form-actions">
      <button id="ud-close">关闭</button>
    </div>
  `)
  $('ud-close').addEventListener('click', closeModal)

  let d
  try {
    d = await apiGet(`/api/admin/users/${encodeURIComponent(userId)}/detail`)
  } catch (e) {
    const body = $('ud-body')
    if (body) {
      body.innerHTML = `<div class="empty" style="color:var(--danger)">加载失败:${escapeHtml(e.message)}</div>`
    }
    return
  }

  const body = $('ud-body')
  if (!body) return // modal 已被关闭

  const u = d.user
  const lc = d.lifecycle || {}
  const topups = d.topups || []
  const reqs = d.recent_requests || []
  const sess = d.recent_sessions || []

  // 头部 — 关键字段一行
  const head = `
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:var(--s-2);margin-bottom:var(--s-3);">
      <div><div class="stat-label">邮箱</div><div>${escapeHtml(u.email || '')}
        ${u.email_verified ? '<span class="badge ok">✓</span>' : '<span class="badge warn">未验证</span>'}</div></div>
      <div><div class="stat-label">角色 / 状态</div><div>
        <span class="badge ${u.role === 'admin' ? 'warn' : 'muted'}">${escapeHtml(u.role)}</span>
        ${statusBadge(u.status)}</div></div>
      <div><div class="stat-label">余额</div><div class="num">${fmtCents(u.credits)}</div></div>
      <div><div class="stat-label">注册时间</div><div class="mono">${escapeHtml(fmtDate(u.created_at))}</div></div>
      <div><div class="stat-label">首次充值</div><div class="mono">${lc.first_topup_at ? escapeHtml(fmtDate(lc.first_topup_at)) : '<span class="muted">从未</span>'}</div></div>
      <div><div class="stat-label">首次请求</div><div class="mono">${lc.first_request_at ? escapeHtml(fmtDate(lc.first_request_at)) : '<span class="muted">从未</span>'}</div></div>
      <div><div class="stat-label">最近活跃</div><div class="mono">${lc.last_active_at ? escapeHtml(fmtRelative(lc.last_active_at)) : '<span class="muted">从未</span>'}</div></div>
      <div><div class="stat-label">显示名</div><div>${escapeHtml(u.display_name || '')}</div></div>
    </div>`

  // 充值历史(最多 20 笔)
  const topupsTbl = topups.length === 0
    ? '<div class="empty">暂无充值记录</div>'
    : `<table class="data" style="width:100%;font-size:13px;">
        <thead><tr><th>时间</th><th>金额</th><th>memo</th></tr></thead>
        <tbody>${topups.map((t) => `
          <tr>
            <td class="mono">${escapeHtml(fmtDate(t.created_at))}</td>
            <td class="num">${fmtCents(t.delta)}</td>
            <td>${escapeHtml(t.memo || '')}</td>
          </tr>`).join('')}</tbody>
       </table>`

  // 最近请求(最多 30 条)
  const reqsTbl = reqs.length === 0
    ? '<div class="empty">暂无请求记录</div>'
    : `<table class="data" style="width:100%;font-size:13px;">
        <thead><tr><th>时间</th><th>模型</th><th>cost</th><th>状态</th></tr></thead>
        <tbody>${reqs.map((r) => `
          <tr>
            <td class="mono">${escapeHtml(fmtDate(r.created_at))}</td>
            <td>${escapeHtml(r.model || '—')}</td>
            <td class="num">${fmtCents(r.cost_credits || 0)}</td>
            <td><span class="badge ${r.status === 'success' ? 'ok' : 'warn'}">${escapeHtml(r.status || '')}</span></td>
          </tr>`).join('')}</tbody>
       </table>`

  // 最近会话(最多 10 条;90 天窗口,按 last_at)
  //
  // 数据源:master SQLite `client_sessions`(web 前端 PUT /api/sessions/:id 写入),
  // 与详情接口 GET /api/admin/sessions/:id 同源 —— 避免历史 bug:列表用
  // usage_records.session_id (CCB metadata UUID)、详情用 client_sessions.id,
  // 两套命名空间不交叉导致 100% 404。
  //
  // 每行可折叠:点击 ▸/▾ 切换展开;第一次展开懒加载完整 messages
  // (GET /api/admin/sessions/:id?user_id=:userId)。
  // 加载结果按 session_id 缓存到 modal 生命周期内的 Map。
  const sessTbl = sess.length === 0
    ? '<div class="empty">90 天内暂无会话</div>'
    : `<table class="data" style="width:100%;font-size:13px;">
        <thead><tr><th style="width:18px;"></th><th>session_id</th><th>title</th><th>agent</th><th>msgs</th><th>创建</th><th>最近</th><th>更新</th></tr></thead>
        <tbody>${sess.map((s) => {
          const sid = String(s.session_id || '')
          const sidEsc = escapeHtml(sid)
          return `
          <tr class="ud-sess-row" data-sid="${sidEsc}" style="cursor:pointer;">
            <td class="mono"><span class="ud-sess-toggle" data-sid="${sidEsc}">▸</span></td>
            <td class="mono" title="${sidEsc}">${escapeHtml(sid.slice(0, 16))}</td>
            <td title="${escapeHtml(s.title || '')}">${escapeHtml((s.title || '').slice(0, 40))}</td>
            <td class="mono">${escapeHtml(s.agent_id || '')}</td>
            <td class="num">${Number(s.message_count || 0).toLocaleString()}</td>
            <td class="mono">${escapeHtml(fmtDate(s.created_at))}</td>
            <td class="mono">${escapeHtml(fmtDate(s.last_at))}</td>
            <td class="mono">${escapeHtml(fmtDate(s.updated_at))}</td>
          </tr>
          <tr class="ud-sess-detail" data-sid="${sidEsc}" style="display:none;">
            <td></td>
            <td colspan="7" class="ud-sess-detail-body"
                style="background:var(--bg-2);padding:var(--s-2);"></td>
          </tr>`
        }).join('')}</tbody>
       </table>`

  body.innerHTML = `
    ${head}
    <div style="margin-top:var(--s-2);"><h4 style="margin:0 0 var(--s-1) 0;font-size:13px;">最近充值(${topups.length})</h4>${topupsTbl}</div>
    <div style="margin-top:var(--s-3);"><h4 style="margin:0 0 var(--s-1) 0;font-size:13px;">最近请求(${reqs.length})</h4>${reqsTbl}</div>
    <div style="margin-top:var(--s-3);"><h4 style="margin:0 0 var(--s-1) 0;font-size:13px;">最近会话 · 90 天(${sess.length})</h4>${sessTbl}</div>`

  _bindSessionRowToggles(body, userId)
}

/**
 * 单 session 详情懒加载状态:首屏 50 条 + "加载更多"分页。
 *
 * 状态(modal lifetime cache 内的 value):
 *   { messages: [], nextOffset, totalMessages, hasMore, meta, loading } | { __error: msg }
 *
 *   - nextOffset = 已加载消息数(下一页 fetch 的 offset);**用实际 messages.length 推**,
 *     不信赖 server 端 offset+limit —— server 可能 clamp limit,最后一页也未必满。
 *   - meta 缓存第一页的 session metadata(title / agent / total)避免重复 render
 *   - loading 标志 "加载更多" 防重入
 */
const SESSION_PAGE_SIZE = 50

/**
 * Bind row-click toggles for the session detail table in user-detail modal.
 *
 * - 每个 session row 可点击展开/折叠下方 detail row
 * - 第一次展开时懒加载 /api/admin/sessions/:id?user_id=:userId&offset=0&limit=50
 * - 后续 "加载更多" 触发分页 fetch 并追加到 .ud-sess-msglist
 * - 结果缓存到 modal lifetime 的 Map(modal 关闭后丢弃 → 重开走新 fetch)
 * - 404 显示"会话不可用或已删除",其它错误显示错误信息
 */
function _bindSessionRowToggles(scope, userId) {
  // modal lifetime cache: key = session_id, value = SessionPagedState | { __error: msg }
  const cache = new Map()
  const rows = scope.querySelectorAll('tr.ud-sess-row')
  rows.forEach((row) => {
    row.addEventListener('click', async (ev) => {
      // 忽略 row 上选中文字等情况
      if (window.getSelection && String(window.getSelection())) return
      const sid = row.getAttribute('data-sid') || ''
      if (!sid) return
      const detail = scope.querySelector(
        `tr.ud-sess-detail[data-sid="${CSS.escape(sid)}"]`
      )
      const toggle = row.querySelector('.ud-sess-toggle')
      if (!detail) return
      const isOpen = detail.style.display !== 'none'
      if (isOpen) {
        detail.style.display = 'none'
        if (toggle) toggle.textContent = '▸'
        return
      }
      detail.style.display = ''
      if (toggle) toggle.textContent = '▾'
      const bodyCell = detail.querySelector('.ud-sess-detail-body')
      if (!bodyCell) return
      const existing = cache.get(sid)
      if (existing) {
        bodyCell.innerHTML = _renderSessionDetail(existing)
        _bindSessionMessageMoreButtons(bodyCell)
        _bindSessionLoadMore(bodyCell, sid, userId, cache)
        return
      }
      bodyCell.innerHTML = '<div class="empty">加载中…</div>'
      try {
        const r = await apiGet(
          `/api/admin/sessions/${encodeURIComponent(sid)}?user_id=${encodeURIComponent(userId)}&offset=0&limit=${SESSION_PAGE_SIZE}`
        )
        const sess = r.session || {}
        const firstPage = Array.isArray(sess.messages) ? sess.messages : []
        const total = Number(sess.total_messages || 0)
        // nextOffset 用实际 page.length 推 —— server 可能 clamp limit 或最后一页 < 50
        const nextOffset = firstPage.length
        const hasMore = total > nextOffset
        cache.set(sid, {
          messages: firstPage,
          nextOffset,
          totalMessages: total,
          hasMore,
          meta: {
            title: sess.title || '',
            agent_id: sess.agent_id || '',
            updated_at: sess.updated_at,
          },
          loading: false,
        })
        bodyCell.innerHTML = _renderSessionDetail(cache.get(sid))
        _bindSessionMessageMoreButtons(bodyCell)
        _bindSessionLoadMore(bodyCell, sid, userId, cache)
      } catch (e) {
        const msg = (e && e.status === 404)
          ? '会话不可用或已删除'
          : `加载失败:${e && e.message ? e.message : String(e)}`
        const payload = { __error: msg }
        cache.set(sid, payload)
        bodyCell.innerHTML = _renderSessionDetail(payload)
      }
      ev.stopPropagation()
    })
  })
}

/**
 * 绑定 "加载更多" 按钮 —— 拉下一页 messages 并 append。
 * 防重入:state.loading + 按钮 disabled 双重门控。
 */
function _bindSessionLoadMore(bodyCell, sid, userId, cache) {
  const btn = bodyCell.querySelector('button.ud-sess-load-more')
  if (!btn) return
  btn.addEventListener('click', async (ev) => {
    ev.stopPropagation()
    const state = cache.get(sid)
    if (!state || state.__error || state.loading || !state.hasMore) return
    state.loading = true
    btn.disabled = true
    const origText = btn.textContent
    btn.textContent = '加载中…'
    try {
      const r = await apiGet(
        `/api/admin/sessions/${encodeURIComponent(sid)}?user_id=${encodeURIComponent(userId)}&offset=${state.nextOffset}&limit=${SESSION_PAGE_SIZE}`
      )
      const sess = r.session || {}
      const page = Array.isArray(sess.messages) ? sess.messages : []
      // 边界:server 已无更多 / 同时被 client 端 truncate / cross-fetch 改变了 total
      if (page.length === 0) {
        state.hasMore = false
      } else {
        state.messages.push(...page)
        state.nextOffset += page.length
        state.totalMessages = Number(sess.total_messages || state.totalMessages)
        state.hasMore = state.nextOffset < state.totalMessages
      }
      // 重新渲染整块 detail(保持简洁,无需 diff 增量)
      bodyCell.innerHTML = _renderSessionDetail(state)
      _bindSessionMessageMoreButtons(bodyCell)
      _bindSessionLoadMore(bodyCell, sid, userId, cache)
    } catch (e) {
      btn.disabled = false
      btn.textContent = origText
      const errLine = bodyCell.querySelector('.ud-sess-load-err')
      const msg = e && e.message ? e.message : String(e)
      if (errLine) errLine.textContent = `加载失败:${msg}`
    } finally {
      state.loading = false
    }
  })
}

/** 把每条 message 末尾的"展开全部"按钮接上 click handler。 */
function _bindSessionMessageMoreButtons(scope) {
  const btns = scope.querySelectorAll('button.ud-sess-msg-more')
  btns.forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation()
      const wrapper = btn.parentElement
      if (!wrapper) return
      const rest = wrapper.querySelector('.ud-sess-msg-rest')
      if (rest) rest.style.display = ''
      btn.remove()
    })
  })
}

/**
 * 渲染单个 session 的展开详情。
 *
 * 接受两种 shape:
 *   - 新分页 state:{ messages, totalMessages, nextOffset, hasMore, meta }
 *   - 错误:{ __error }
 *
 * 末尾按 hasMore 决定是否渲染 "加载更多" 按钮(占位符;事件绑定在 _bindSessionLoadMore)。
 */
function _renderSessionDetail(s) {
  if (!s) return '<div class="empty">无数据</div>'
  if (s.__error) return `<div class="empty" style="color:var(--danger)">${escapeHtml(s.__error)}</div>`
  const msgs = Array.isArray(s.messages) ? s.messages : []
  const meta = s.meta || {}
  const total = Number(s.totalMessages != null ? s.totalMessages : msgs.length)
  const loaded = msgs.length
  const hasMore = !!s.hasMore
  if (total === 0) return '<div class="empty">该会话暂无消息</div>'
  const headLine = `<div class="muted" style="font-size:12px;margin-bottom:var(--s-2);">
    <strong>${escapeHtml(meta.title || '(无标题)')}</strong>
    · agent=${escapeHtml(meta.agent_id || '')}
    · ${loaded} / ${total} 条消息
    · 更新 ${escapeHtml(fmtDate(meta.updated_at))}
  </div>`
  const items = msgs.map((m, i) => _renderSessionMessage(m, i)).join('')
  const moreFooter = hasMore
    ? `<div style="margin-top:var(--s-2);text-align:center;">
         <button type="button" class="btn btn-ghost ud-sess-load-more" style="font-size:12px;">加载更多(剩 ${total - loaded} 条)</button>
         <div class="ud-sess-load-err muted" style="font-size:11px;color:var(--danger);margin-top:4px;"></div>
       </div>`
    : ''
  return `${headLine}<div class="ud-sess-msglist" style="display:flex;flex-direction:column;gap:var(--s-2);">${items}</div>${moreFooter}`
}

/** 渲染单条 message。容忍 wire-format 多变:string / array content / 缺字段。
 *
 *  渲染兜底(B3):若 _extractMessageText 返回空字符串(例如 content 是空数组,
 *  或全是无 text/name 的 block 等异常 shape),退化成 content blocks 的 type 摘要,
 *  避免出现"只有 chip + #N 没有任何 body"的诊断盲区。 */
function _renderSessionMessage(m, idx) {
  const role = String((m && m.role) || 'unknown')
  const roleCls = role === 'user' ? 'ok' : role === 'assistant' ? 'warn' : 'muted'
  const text = _extractMessageText(m)
  const FOLD = 2000
  const folded = text.length > FOLD
  const visible = folded ? text.slice(0, FOLD) : text
  const tools = _extractToolUseNames(m)
  const toolsLine = tools.length
    ? `<div class="muted" style="font-size:12px;margin-top:4px;">工具:${tools.map((t) => escapeHtml(t)).join(', ')}</div>`
    : ''
  // 展开按钮通过事件委托绑定到 .ud-sess-msg-more,id 不必唯一
  const moreBlock = folded
    ? `<span class="ud-sess-msg-rest" style="display:none;">${escapeHtml(text.slice(FOLD))}</span> <button type="button" class="link ud-sess-msg-more" style="font-size:12px;">展开全部(剩 ${text.length - FOLD} 字)</button>`
    : ''
  // B3: text 空且无 tool_use 名字时,渲染 content blocks 的 type 摘要兜底
  const fallbackBody = (!text && !tools.length)
    ? _renderEmptyMessageFallback(m)
    : ''
  return `<div class="ud-sess-msg" style="border-left:3px solid var(--border);padding-left:var(--s-2);">
    <div style="display:flex;align-items:center;gap:var(--s-1);margin-bottom:4px;">
      <span class="badge ${roleCls}">${escapeHtml(role)}</span>
      <span class="muted" style="font-size:12px;">#${idx + 1}</span>
    </div>
    <div class="mono" style="white-space:pre-wrap;word-break:break-word;font-size:12px;">${escapeHtml(visible)}${moreBlock}</div>
    ${fallbackBody}
    ${toolsLine}
  </div>`.replace(/^[ \t]+/gm, '') // strip leading whitespace to keep DOM compact
}

/**
 * 空内容兜底渲染:列 content blocks 的 type + 关键摘要。
 *
 * 触发场景:
 *  - content 是空 array
 *  - content 全是奇异 block(type 是 image / unknown / 缺 text 字段)
 *  - storage 层 sanitize 把 text 字段抽掉只留 type 框架
 *
 * 不替代 _extractMessageText —— 那条路径仍负责正常 text/tool_use/tool_result 抽取;
 * 这里只是"什么都拿不到"时的最后一道诊断光照。
 */
function _renderEmptyMessageFallback(m) {
  if (!m) return '<div class="muted" style="font-size:11px;">(空消息)</div>'
  const c = m.content
  if (typeof c === 'string') {
    // 字符串 content 但为空白
    return '<div class="muted" style="font-size:11px;">(空字符串 content)</div>'
  }
  if (!Array.isArray(c)) {
    return `<div class="muted" style="font-size:11px;">(无可识别 content;keys=${escapeHtml(Object.keys(m).join(','))})</div>`
  }
  if (c.length === 0) {
    return '<div class="muted" style="font-size:11px;">(content blocks 为空)</div>'
  }
  // 列出每个 block 的 type;tool_use 带 name,tool_result 带 is_error 标记
  const tags = c.map((b) => {
    if (!b || typeof b !== 'object') return '<span class="badge muted">?</span>'
    const t = String(b.type || '?')
    let extra = ''
    if (t === 'tool_use' && b.name) extra = `:${b.name}`
    else if (t === 'tool_result' && b.is_error) extra = '!err'
    else if (t === 'image' && b.source?.media_type) extra = `:${b.source.media_type}`
    return `<span class="badge muted" style="font-size:10px;">${escapeHtml(t + extra)}</span>`
  }).join(' ')
  return `<div class="muted" style="font-size:11px;display:flex;flex-wrap:wrap;gap:4px;align-items:center;">
    <span>${c.length} blocks:</span>${tags}
  </div>`
}

/** 从一条 wire-format message 提取文本(剥离 tool_use args / tool_result blob)。 */
function _extractMessageText(m) {
  if (!m) return ''
  const c = m.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  const parts = []
  for (const block of c) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (block.type === 'tool_use') {
      parts.push(`[tool_use: ${block.name || ''}]`)
    } else if (block.type === 'tool_result') {
      // content 可能是 string 或 array;只显示前 200 字概览
      const tr = typeof block.content === 'string'
        ? block.content
        : (Array.isArray(block.content)
            ? block.content.map((b) => (b && typeof b.text === 'string') ? b.text : '').join('')
            : '')
      parts.push(`[tool_result] ${tr.slice(0, 200)}${tr.length > 200 ? '…' : ''}`)
    }
  }
  return parts.join('\n')
}

/** 抽出 message 里的 tool_use 名字列表(诊断用)。 */
function _extractToolUseNames(m) {
  if (!m || !Array.isArray(m.content)) return []
  const out = []
  for (const block of m.content) {
    if (block && block.type === 'tool_use' && typeof block.name === 'string') {
      out.push(block.name)
    }
  }
  return out
}


// ─── Tab: Account Groups / Codex API Relay ────────────────────────
const ACCOUNT_GROUP_KIND_LABEL = {
  official_oauth: '官方 OAuth 订阅',
  api_relay: 'API 中转站',
}

async function renderAccountGroupsTab() {
  view().innerHTML = `
    <div class="panel">
      <h1 style="margin-top:0">账号分组 / 中转站路由</h1>
      <div class="toolbar">
        <button class="btn" id="grp-refresh">刷新</button>
        <span class="spacer"></span>
        <button class="btn btn-primary" id="grp-new">+ 新建分组</button>
      </div>
      <div class="table-scroll"><div id="grp-table"><div class="empty">加载中…</div></div></div>
    </div>`
  $('grp-refresh').addEventListener('click', renderAccountGroupsTab)
  $('grp-new').addEventListener('click', openCreateAccountGroupModal)
  try {
    const data = await apiGet('/api/admin/account-groups')
    _renderAccountGroupsTable(data.rows || [])
  } catch (err) {
    $('grp-table').innerHTML = `<div class="empty" style="color:var(--danger)">加载失败:${escapeHtml(err.message)}</div>`
  }
}

function _renderAccountGroupsTable(rows) {
  const el = $('grp-table')
  if (!rows.length) { el.innerHTML = '<div class="empty">暂无分组</div>'; return }
  el.innerHTML = `
    <table class="data">
      <thead><tr>
        <th>id</th><th>名称</th><th>类型</th><th>provider</th><th>启用</th><th class="num">优先级</th><th>模型</th><th class="actions">操作</th>
      </tr></thead>
      <tbody>${rows.map((g) => `
        <tr>
          <td class="mono">${escapeHtml(g.id)}</td>
          <td>${escapeHtml(g.label)}</td>
          <td>${escapeHtml(ACCOUNT_GROUP_KIND_LABEL[g.kind] || g.kind)}</td>
          <td class="mono">${escapeHtml(g.provider)}</td>
          <td>${g.enabled ? '<span class="badge ok">enabled</span>' : '<span class="badge muted">disabled</span>'}</td>
          <td class="num mono">${escapeHtml(String(g.priority))}</td>
          <td class="mono" title="${escapeHtml((g.models || []).join(', '))}">${escapeHtml((g.models || []).slice(0, 4).join(', ') || '—')}${(g.models || []).length > 4 ? ` +${(g.models || []).length - 4}` : ''}</td>
          <td class="actions">
            <button data-act="grp-toggle" data-id="${escapeHtml(g.id)}" data-enabled="${g.enabled ? '1' : '0'}">${g.enabled ? '停用' : '启用'}</button>
            <button data-act="grp-priority" data-id="${escapeHtml(g.id)}" data-priority="${escapeHtml(String(g.priority))}">优先级</button>
            <button data-act="grp-models" data-id="${escapeHtml(g.id)}" data-models="${escapeHtml((g.models || []).join(','))}">模型</button>
            ${g.kind === 'api_relay' && g.provider === 'codex' ? `<button data-act="grp-creds" data-id="${escapeHtml(g.id)}" data-label="${escapeHtml(g.label)}">凭据</button>` : ''}
            <button data-act="grp-delete" data-id="${escapeHtml(g.id)}" data-label="${escapeHtml(g.label)}">删除</button>
          </td>
        </tr>`).join('')}</tbody>
    </table>`
  for (const b of el.querySelectorAll('button[data-act="grp-toggle"]')) {
    b.addEventListener('click', async () => {
      try { await apiJson('PATCH', `/api/admin/account-groups/${encodeURIComponent(b.dataset.id)}`, { enabled: b.dataset.enabled !== '1' }); toast('已更新'); renderAccountGroupsTab() }
      catch (e) { toast(`更新失败:${e.message}`, 'danger', toastOptsFromError(e)) }
    })
  }
  for (const b of el.querySelectorAll('button[data-act="grp-priority"]')) {
    b.addEventListener('click', async () => {
      const v = prompt('优先级(数字越小越优先)', b.dataset.priority || '100')
      if (v == null) return
      const n = Number(v)
      if (!Number.isInteger(n)) { toast('优先级必须是整数', 'danger'); return }
      try { await apiJson('PATCH', `/api/admin/account-groups/${encodeURIComponent(b.dataset.id)}`, { priority: n }); toast('已更新'); renderAccountGroupsTab() }
      catch (e) { toast(`更新失败:${e.message}`, 'danger', toastOptsFromError(e)) }
    })
  }
  for (const b of el.querySelectorAll('button[data-act="grp-models"]')) {
    b.addEventListener('click', async () => {
      const v = prompt('精确模型 id,多个用逗号分隔', b.dataset.models || '')
      if (v == null) return
      const models = v.split(',').map((s) => s.trim()).filter(Boolean)
      try { await apiJson('PUT', `/api/admin/account-groups/${encodeURIComponent(b.dataset.id)}/models`, { models }); toast('模型已更新'); renderAccountGroupsTab() }
      catch (e) { toast(`更新失败:${e.message}`, 'danger', toastOptsFromError(e)) }
    })
  }
  for (const b of el.querySelectorAll('button[data-act="grp-creds"]')) {
    b.addEventListener('click', () => openRelayCredentialsModal(b.dataset.id, b.dataset.label))
  }
  for (const b of el.querySelectorAll('button[data-act="grp-delete"]')) {
    b.addEventListener('click', async () => {
      if (!confirm(`删除分组 #${b.dataset.id} (${b.dataset.label})?\n关联模型/中转站凭据会一起删除;Claude 账号会解绑。`)) return
      try { await apiJson('DELETE', `/api/admin/account-groups/${encodeURIComponent(b.dataset.id)}`); toast('已删除'); renderAccountGroupsTab() }
      catch (e) { toast(`删除失败:${e.message}`, 'danger', toastOptsFromError(e)) }
    })
  }
}

function openCreateAccountGroupModal() {
  openModal(`
    <h3>新建账号分组</h3>
    <div class="form-row"><label>名称</label><input id="grp-label" value="" placeholder="如 Yunwu GPT 中转站" /></div>
    <div class="form-row"><label>类型</label><select id="grp-kind"><option value="api_relay">API 中转站</option><option value="official_oauth">官方 OAuth 订阅</option></select></div>
    <div class="form-row"><label>provider</label><select id="grp-provider"><option value="codex">codex</option><option value="claude">claude</option></select><small style="color:var(--muted)">支持 api_relay+codex、official_oauth+codex、official_oauth+claude。</small></div>
    <div class="form-row"><label>启用</label><select id="grp-enabled"><option value="true">启用</option><option value="false">停用</option></select></div>
    <div class="form-row"><label>优先级</label><input id="grp-priority" type="number" value="100" /></div>
    <div class="form-row"><label>模型 id(逗号分隔)</label><input id="grp-models-input" value="gpt-5.5" /></div>
    <div class="form-actions"><button class="btn" id="grp-cancel">取消</button><button class="btn btn-primary" id="grp-save">创建</button></div>`)
  $('grp-cancel').addEventListener('click', closeModal)
  $('grp-save').addEventListener('click', async () => {
    const body = {
      label: $('grp-label').value.trim(),
      kind: $('grp-kind').value,
      provider: $('grp-provider').value,
      enabled: $('grp-enabled').value === 'true',
      priority: Number($('grp-priority').value || '100'),
      models: $('grp-models-input').value.split(',').map((s) => s.trim()).filter(Boolean),
    }
    try { await apiJson('POST', '/api/admin/account-groups', body); closeModal(); toast('已创建'); renderAccountGroupsTab() }
    catch (e) { toast(`创建失败:${e.message}`, 'danger', toastOptsFromError(e)) }
  })
}

async function openRelayCredentialsModal(groupId, groupLabel) {
  openModal(`<h3>中转站凭据 — #${escapeHtml(groupId)} ${escapeHtml(groupLabel || '')}</h3><div id="relay-creds-body"><div class="empty">加载中…</div></div>`)
  const render = async () => {
    const box = $('relay-creds-body')
    try {
      const data = await apiGet(`/api/admin/account-groups/${encodeURIComponent(groupId)}/relay-credentials`)
      const rows = data.rows || []
      box.innerHTML = `
        <div class="toolbar"><button class="btn btn-primary" id="relay-cred-new">+ 添加 API key</button></div>
        ${rows.length ? `<table class="data"><thead><tr><th>id</th><th>label</th><th>base_url</th><th>provider</th><th>状态</th><th class="num">health</th><th>最近错误</th><th class="actions">操作</th></tr></thead><tbody>${rows.map((c) => `
          <tr><td class="mono">${escapeHtml(c.id)}</td><td>${escapeHtml(c.label)}</td><td class="mono">${escapeHtml(c.base_url)}</td><td class="mono">${escapeHtml(c.model_provider)}</td><td>${statusBadge(c.status)}</td><td class="num">${escapeHtml(String(c.health_score))}</td><td>${escapeHtml(c.last_error || '—')}</td><td class="actions"><button data-act="relay-status" data-id="${escapeHtml(c.id)}" data-status="${escapeHtml(c.status)}">启停</button><button data-act="relay-del" data-id="${escapeHtml(c.id)}">删除</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty">暂无凭据</div>'}`
      $('relay-cred-new').addEventListener('click', () => openCreateRelayCredentialModal(groupId, render))
      for (const b of box.querySelectorAll('button[data-act="relay-status"]')) {
        b.addEventListener('click', async () => {
          const status = b.dataset.status === 'active' ? 'disabled' : 'active'
          try { await apiJson('PATCH', `/api/admin/account-groups/relay-credentials/${encodeURIComponent(b.dataset.id)}`, { status }); toast('已更新'); render() }
          catch (e) { toast(`更新失败:${e.message}`, 'danger', toastOptsFromError(e)) }
        })
      }
      for (const b of box.querySelectorAll('button[data-act="relay-del"]')) {
        b.addEventListener('click', async () => {
          if (!confirm(`删除凭据 #${b.dataset.id}?`)) return
          try { await apiJson('DELETE', `/api/admin/account-groups/relay-credentials/${encodeURIComponent(b.dataset.id)}`); toast('已删除'); render() }
          catch (e) { toast(`删除失败:${e.message}`, 'danger', toastOptsFromError(e)) }
        })
      }
    } catch (e) {
      box.innerHTML = `<div class="empty" style="color:var(--danger)">加载失败:${escapeHtml(e.message)}</div>`
    }
  }
  await render()
}

function openCreateRelayCredentialModal(groupId, refreshParent) {
  openModal(`
    <h3>添加中转站 API Key</h3>
    <div class="form-row"><label>label</label><input id="relay-label" value="Yunwu" /></div>
    <div class="form-row"><label>base_url</label><input id="relay-base" value="https://yunwu.ai/v1" /></div>
    <div class="form-row"><label>model_provider</label><input id="relay-provider" value="api111" /></div>
    <div class="form-row"><label>provider_name</label><input id="relay-provider-name" value="Yunwu" /></div>
    <div class="form-row"><label>wire_api</label><select id="relay-wire"><option value="responses">responses</option><option value="chat">chat</option></select></div>
    <div class="form-row"><label>preferred_auth_method</label><select id="relay-auth"><option value="apikey">apikey</option><option value="chatgpt">chatgpt</option></select></div>
    <div class="form-row"><label>API key(只提交一次,不会回显)</label><textarea id="relay-key" placeholder="sk-..."></textarea></div>
    <div class="form-actions"><button class="btn" id="relay-cancel">取消</button><button class="btn btn-primary" id="relay-save">保存</button></div>`)
  $('relay-cancel').addEventListener('click', closeModal)
  $('relay-save').addEventListener('click', async () => {
    const body = {
      label: $('relay-label').value.trim(),
      base_url: $('relay-base').value.trim(),
      model_provider: $('relay-provider').value.trim(),
      provider_name: $('relay-provider-name').value.trim() || null,
      wire_api: $('relay-wire').value,
      preferred_auth_method: $('relay-auth').value,
      disable_response_storage: true,
      api_key: $('relay-key').value.trim(),
      status: 'active',
    }
    try { await apiJson('POST', `/api/admin/account-groups/${encodeURIComponent(groupId)}/relay-credentials`, body); closeModal(); toast('已保存') }
    catch (e) { toast(`保存失败:${e.message}`, 'danger', toastOptsFromError(e)) }
  })
}

// ─── Tab: Accounts(CRUD)───────────────────────────────────────────
//
// 4J 实装:状态过滤 + 新建/编辑/删除。
// 后端字段: label / plan(pro|max|team) / status(active|cooldown|disabled|banned)
// / oauth_token / oauth_refresh_token / oauth_expires_at / egress_proxy_id
// (0055: egress 必须通过 egress_proxies 池条目 id 引用;raw text 列已锁 NULL)

const ACCOUNT_PLANS = ['pro', 'max', 'team']
const ACCOUNT_STATUSES = ['active', 'cooldown', 'disabled', 'banned']

// R3 accounts tab 单 tab 状态 —— 结构与 R2 USERS_STATE 对齐。
// 没有 cursor:账号池总量小(<1k),一次全拉(limit=500),前端 filter。
const ACCOUNTS_STATE = {
  renderSeq: 0, loadSeq: 0,
  rows: [], filterStatus: '',
}

async function renderAccountsTab() {
  const mySeq = ++ACCOUNTS_STATE.renderSeq
  ACCOUNTS_STATE.rows = []
  ACCOUNTS_STATE.filterStatus = sessionStorage.getItem('admin_acc_status') || ''

  view().innerHTML = `
    <div class="panel">
      <h1 style="margin-top:0">账号池 <small style="color:var(--muted);font-weight:400;font-size:14px" id="acc-count">加载中…</small></h1>

      <!-- 4 张 KPI 卡片 -->
      <div class="stat-grid" id="acc-kpis" style="margin-bottom:18px">
        <div class="stat-card"><div class="stat-label">总账号</div><div class="stat-value is-loading">—</div><div class="stat-delta stat-muted">加载中…</div></div>
        <div class="stat-card"><div class="stat-label">可用 / 冷却</div><div class="stat-value is-loading">—</div><div class="stat-delta stat-muted">加载中…</div></div>
        <div class="stat-card"><div class="stat-label">OAuth 过期风险</div><div class="stat-value is-loading">—</div><div class="stat-delta stat-muted">加载中…</div></div>
        <div class="stat-card"><div class="stat-label">今日请求</div><div class="stat-value is-loading">—</div><div class="stat-delta stat-muted">加载中…</div></div>
      </div>

      <div class="toolbar">
        <label>状态:
          <select id="acc-status">
            <option value="">全部</option>
            ${ACCOUNT_STATUSES.map((s) =>
              `<option value="${s}" ${s === ACCOUNTS_STATE.filterStatus ? 'selected' : ''}>${s}</option>`,
            ).join('')}
          </select>
        </label>
        <button class="btn" id="acc-refresh">刷新</button>
        <span class="spacer"></span>
        <button class="btn btn-primary" id="acc-new">+ 新建账号</button>
      </div>

      <div class="table-scroll"><div id="acc-table-container"><div class="empty">加载中…</div></div></div>
    </div>
  `
  // 先绑事件,避免首次拉数据期间切换/筛选延迟
  $('acc-status').addEventListener('change', (e) => {
    ACCOUNTS_STATE.filterStatus = e.target.value
    sessionStorage.setItem('admin_acc_status', e.target.value)
    // 首屏条件变化 = 重新一轮
    renderAccountsTab()
  })
  $('acc-refresh').addEventListener('click', () => renderAccountsTab())
  $('acc-new').addEventListener('click', openCreateAccountModal)

  await Promise.all([
    _loadAccountsKpis(mySeq),
    _loadAccounts(mySeq),
  ])
}

async function _loadAccountsKpis(renderSeq) {
  let s
  try {
    s = await apiGet('/api/admin/accounts/stats')
  } catch {
    if (renderSeq !== ACCOUNTS_STATE.renderSeq || _currentTab !== 'accounts') return
    const cards = view().querySelectorAll('#acc-kpis .stat-card')
    for (const c of cards) updateStat(c, '—', '加载失败', 'danger')
    return
  }
  if (renderSeq !== ACCOUNTS_STATE.renderSeq || _currentTab !== 'accounts') return

  const cards = view().querySelectorAll('#acc-kpis .stat-card')
  updateStat(cards[0], s.total.toLocaleString(),
    `disabled ${s.disabled} · banned ${s.banned}`,
    s.banned > 0 ? 'warning' : null)
  updateStat(cards[1], `${s.active} / ${s.cooldown}`,
    s.cooldown > 0 ? `有 ${s.cooldown} 个冷却中` : '全部可用',
    s.cooldown > 0 ? 'warning' : 'success')
  // 主值只把"真正需要人工介入"算进去:24h 内到期 + 过期且无 refresh token。
  // 过期但有 refresh 的会被 anthropicProxy 的 lazy refresh 自愈,不该 danger。
  updateStat(cards[2], `${s.expiring_24h} + ${s.expired_unrefreshable}`,
    `24h 内到期 / 待刷新 ${s.expired_refreshable} / 已过期 ${s.expired_unrefreshable}`,
    (s.expired_unrefreshable > 0) ? 'danger' : (s.expiring_24h > 0 ? 'warning' : 'success'))
  const errRate = s.today_requests > 0 ? s.today_errors / s.today_requests : 0
  updateStat(cards[3], s.today_requests.toLocaleString(),
    `错误 ${s.today_errors}(${(errRate * 100).toFixed(1)}%)`,
    errRate > 0.1 ? 'danger' : errRate > 0.02 ? 'warning' : 'success')
}

async function _loadAccounts(renderSeq) {
  const myLoadSeq = ++ACCOUNTS_STATE.loadSeq
  const sp = new URLSearchParams({ with_stats: '1', limit: '500' })
  if (ACCOUNTS_STATE.filterStatus) sp.set('status', ACCOUNTS_STATE.filterStatus)

  let data
  try {
    data = await apiGet(`/api/admin/accounts?${sp.toString()}`)
  } catch (err) {
    if (renderSeq !== ACCOUNTS_STATE.renderSeq || _currentTab !== 'accounts') return
    toast(`加载失败:${err.message}`, 'danger', toastOptsFromError(err))
    const el = $('acc-table-container')
    if (el) el.innerHTML = `<div class="empty" style="color:var(--danger)">加载失败:${escapeHtml(err.message)}</div>`
    const cnt = $('acc-count'); if (cnt) cnt.textContent = '—'
    return
  }
  if (renderSeq !== ACCOUNTS_STATE.renderSeq || myLoadSeq !== ACCOUNTS_STATE.loadSeq) return
  if (_currentTab !== 'accounts') return

  ACCOUNTS_STATE.rows = data?.rows ?? []
  _renderAccountsTable()
  const cnt = $('acc-count'); if (cnt) cnt.textContent = `共 ${ACCOUNTS_STATE.rows.length} 条`
}

function _renderAccountsTable() {
  const el = $('acc-table-container')
  if (!el) return
  const rows = ACCOUNTS_STATE.rows
  if (rows.length === 0) {
    el.innerHTML = '<div class="empty">无匹配账号</div>'
    return
  }
  el.innerHTML = `
    <table class="data">
      <thead>
        <tr>
          <th>id</th>
          <th>label</th>
          <th>plan</th>
          <th>状态</th>
          <th class="num">health</th>
          <th class="num">今日 / 错误率</th>
          <th class="num">累计 ok/fail</th>
          <th>OAuth 到期</th>
          <th title="Anthropic 订阅周期到期日(管理员手填;留空 = 未知,调度器按中性看待;快到期账号 WRH 自动加权优先吃流量榨干额度)">订阅到期</th>
          <th>分组</th>
          <th class="num" title="近 5 小时利用率(被动从上游响应头采集)">5h%</th>
          <th class="num" title="5 小时配额重置时间(剩余时间;tooltip 显示绝对时间)">5h 重置</th>
          <th class="num" title="近 7 天利用率(被动从上游响应头采集)">7d%</th>
          <th class="num" title="7 天配额重置时间(剩余时间;tooltip 显示绝对时间)">7d 重置</th>
          <th>冷却至</th>
          <th>最近使用</th>
          <th>egress</th>
          <th class="actions">操作</th>
        </tr>
      </thead>
      <tbody>${rows.map(_renderAccountRow).join('')}</tbody>
    </table>
  `
  for (const b of el.querySelectorAll('button[data-act="edit-acc"]')) {
    b.addEventListener('click', () => openEditAccountModal(b.dataset.id))
  }
  for (const b of el.querySelectorAll('button[data-act="del-acc"]')) {
    b.addEventListener('click', (ev) => deleteAccount(b.dataset.id, b.dataset.label, ev.currentTarget))
  }
  for (const b of el.querySelectorAll('button[data-act="reset-cooldown"]')) {
    b.addEventListener('click', (ev) => resetAccountCooldown(b.dataset.id, b.dataset.label, ev.currentTarget))
  }
  for (const b of el.querySelectorAll('button[data-act="refresh-history"]')) {
    b.addEventListener('click', () => _openRefreshHistoryModal(b.dataset.id, b.dataset.label))
  }
  for (const b of el.querySelectorAll('button[data-act="acc-recent-users"]')) {
    b.addEventListener('click', () => _openAccountRecentUsersModal(b.dataset.id, b.dataset.label))
  }
}

/**
 * 弹窗:近 24h 使用过该账号的用户(按请求量倒序)。
 * 后端 GET /api/admin/accounts/:id/recent-users?hours=24&limit=20。
 */
async function _openAccountRecentUsersModal(accountId, accountLabel) {
  const headerHtml = `
    <h3 style="margin:0 0 12px 0;">账号 #${escapeHtml(accountId)} (${escapeHtml(accountLabel)}) — 近 24h 使用方</h3>
  `
  openModal(headerHtml + `<div id="acc-rusers-body"><div class="muted" style="padding:12px 0;">加载中…</div></div>`)
  const body = document.getElementById('acc-rusers-body')
  try {
    const url = `/api/admin/accounts/${encodeURIComponent(accountId)}/recent-users?hours=24&limit=20`
    const r = await apiGet(url)
    const rows = Array.isArray(r?.rows) ? r.rows : []
    if (rows.length === 0) {
      body.innerHTML = `<div class="muted" style="padding:12px 0;">近 24h 无用户使用过该账号。</div>`
      return
    }
    const trs = rows.map((u) => `
      <tr>
        <td class="mono">${escapeHtml(u.user_id)}</td>
        <td>${escapeHtml(u.email || '')}</td>
        <td class="num">${Number(u.request_count).toLocaleString()}</td>
        <td class="mono">${escapeHtml(fmtDate(u.last_used_at))}</td>
      </tr>
    `).join('')
    body.innerHTML = `
      <table class="data-table">
        <thead><tr><th>user_id</th><th>email</th><th class="num">请求数</th><th>最近使用</th></tr></thead>
        <tbody>${trs}</tbody>
      </table>
      <div class="muted" style="margin-top:8px;font-size:12px;">仅近 24h、Top 20。</div>
    `
  } catch (e) {
    body.innerHTML = `<div class="chip chip-danger">加载失败:${escapeHtml(e.message || String(e))}</div>`
  }
}

// M6/P1-9 — 渲染 refresh 事件类型为可读 chip
function _renderRefreshEventChip(ev) {
  if (ev.ok) return '<span class="chip chip-ok">成功</span>'
  const code = ev.err_code || 'unknown'
  // network_transient 不 disable 账号 → muted;其他都是 disable 类 → danger
  const cls = code === 'network_transient' ? 'chip-warn' : 'chip-danger'
  return `<span class="chip ${cls}">${escapeHtml(code)}</span>`
}

async function _openRefreshHistoryModal(accountId, accountLabel) {
  const headerHtml = `
    <h3 style="margin:0 0 12px 0;">账号 #${escapeHtml(accountId)} (${escapeHtml(accountLabel)}) — OAuth refresh 历史</h3>
  `
  openModal(headerHtml + `<div id="refresh-events-body"><div class="muted" style="padding:12px 0;">加载中…</div></div>`)
  const body = document.getElementById('refresh-events-body')
  try {
    const url = `/api/admin/accounts/refresh-events?account_id=${encodeURIComponent(accountId)}&limit=50`
    const r = await apiGet(url)
    const events = Array.isArray(r?.events) ? r.events : []
    if (events.length === 0) {
      body.innerHTML = `<div class="muted" style="padding:12px 0;">该账号暂无 refresh 事件记录(28 天 retention)。</div>`
      return
    }
    const rows = events.map((ev) => {
      const tsStr = fmtDate(ev.ts)
      const chip = _renderRefreshEventChip(ev)
      const detail = ev.ok
        ? '—'
        : `<span class="mono">${escapeHtml(ev.err_msg || '')}</span>`
      return `<tr><td class="mono">${escapeHtml(tsStr)}</td><td>${chip}</td><td>${detail}</td></tr>`
    }).join('')
    body.innerHTML = `
      <table class="data-table">
        <thead><tr><th>时间</th><th>结果</th><th>详情</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="muted" style="margin-top:8px;font-size:12px;">仅展示最近 50 条;事件保留 28 天后自动清理。详情字段为后端枚举字面量,不含 raw error。</div>
    `
  } catch (e) {
    body.innerHTML = `<div class="chip chip-danger">加载失败:${escapeHtml(e.message || String(e))}</div>`
  }
}

// 返回账号的 warning chip 拼好的 HTML 串(放在 label 单元格尾巴)。
function _accountWarningChips(a) {
  const chips = []
  const now = Date.now()
  if (a.last_error) {
    chips.push(`<span class="chip chip-danger" title="${escapeHtml(a.last_error)}">最近出错</span>`)
  }
  if (a.oauth_expires_at) {
    const expMs = new Date(a.oauth_expires_at).getTime()
    if (!Number.isNaN(expMs)) {
      if (expMs < now) {
        // 有 refresh token → lazy refresh 会自愈,muted chip;没 refresh → 真坏,danger。
        // 严格 === true 防 cache/旧后端 falsy 值误判成可自愈。
        if (a.has_refresh_token === true) {
          chips.push(`<span class="chip chip-muted" title="${escapeHtml(fmtDate(a.oauth_expires_at))}">OAuth 待刷新</span>`)
        } else {
          chips.push(`<span class="chip chip-danger" title="${escapeHtml(fmtDate(a.oauth_expires_at))}">OAuth 已过期</span>`)
        }
      } else if (expMs - now < 24 * 3600 * 1000) {
        chips.push(`<span class="chip chip-warn" title="${escapeHtml(fmtDate(a.oauth_expires_at))}">24h 内到期</span>`)
      }
    }
  }
  if (a.cooldown_until) {
    const cMs = new Date(a.cooldown_until).getTime()
    if (!Number.isNaN(cMs) && cMs > now) {
      chips.push(`<span class="chip chip-warn">冷却中</span>`)
    }
  }
  // 订阅到期 chip:管理员手填字段(subscription_end_at),NULL = 未维护不显示。
  // 阈值与 scheduler.ts subscriptionFactor 保持一致(<2d / <7d / 已过)。
  if (a.subscription_end_at) {
    const subMs = new Date(a.subscription_end_at).getTime()
    if (!Number.isNaN(subMs)) {
      const days = (subMs - now) / (24 * 3600 * 1000)
      const tipDate = escapeHtml(fmtDate(a.subscription_end_at))
      if (days <= 0) {
        chips.push(`<span class="chip chip-danger" title="${tipDate}">订阅已过期</span>`)
      } else if (days < 2) {
        chips.push(`<span class="chip chip-danger" title="${tipDate}">订阅 ${Math.ceil(days * 24)}h 内到期</span>`)
      } else if (days < 7) {
        chips.push(`<span class="chip chip-warn" title="${tipDate}">订阅 ${Math.ceil(days)}d 内到期</span>`)
      }
    }
  }
  return chips.length > 0 ? `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:3px">${chips.join('')}</div>` : ''
}

// M9 — 渲染 5h / 7d 配额单元格。
//   pct: number | null (0-100)
//   updatedAt: ISO string | null  (整个账号的 quota_updated_at,共用)
// 陈旧数据 (>1h) → 灰色 chip(不再着色,但仍显示 % 数值)。
// 5h/7d 共用 quota_updated_at,prod 假设两组 header 同步返(见 quota.ts 注释)。
// 重置时间(resetsAt)由独立的 _renderResetCell 渲染到相邻列,boss 要求显式可见
// 而非藏在 tooltip 里(Issue B)。
function _renderQuotaCell(pct, updatedAt) {
  if (pct === null || pct === undefined) return '<span class="muted">—</span>'
  const num = Number(pct)
  if (!Number.isFinite(num)) return '<span class="muted">—</span>'
  const updMs = updatedAt ? new Date(updatedAt).getTime() : NaN
  const ageMs = Number.isFinite(updMs) ? Date.now() - updMs : Infinity
  const stale = ageMs > 60 * 60 * 1000
  const cls = stale ? 'chip-muted' : (num >= 95 ? 'chip-danger' : num >= 80 ? 'chip-warn' : '')
  const label = `${num.toFixed(0)}%`
  const title = updatedAt ? ` title="${escapeHtml(`更新: ${fmtDate(updatedAt)}${stale ? ' (陈旧)' : ''}`)}"` : ''
  return cls ? `<span class="chip ${cls}"${title}>${label}</span>` : `<span${title}>${label}</span>`
}

// Issue B (Codex review #019e0b90) — 5h / 7d 配额重置时间单元格。
//   resetsAt: ISO string | null
// 显示策略,跟同表的"冷却至"列对齐(line ~1992):
//   - null / 解析失败 → "—"
//   - 已过(diff ≤ 0) → "已过"(灰)+ tooltip 绝对时间 — 与"无数据"区分
//   - <60m → "Xm"(向上取整,避免比实际更快重置的错觉)
//   - <24h → "Xh"(向上取整)
//   - 否则 → 月-日 格式 (如 "12-25")
// 完整时间放 tooltip。窄列友好。
function _renderResetCell(resetsAt) {
  if (!resetsAt) return '<span class="muted">—</span>'
  const ms = new Date(resetsAt).getTime()
  if (Number.isNaN(ms)) return '<span class="muted">—</span>'
  const diff = ms - Date.now()
  if (diff <= 0) return `<span class="muted" title="${escapeHtml(fmtDate(resetsAt))}">已过</span>`
  let label
  if (diff < 60 * 60 * 1000) {
    label = `${Math.max(1, Math.ceil(diff / 60000))}m`
  } else if (diff < 24 * 60 * 60 * 1000) {
    label = `${Math.ceil(diff / (60 * 60 * 1000))}h`
  } else {
    const d = new Date(resetsAt)
    label = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  return `<span class="mono" title="${escapeHtml(fmtDate(resetsAt))}">${label}</span>`
}

function _renderAccountRow(a) {
  // 累计成功率
  const okN = Number(a.success_count || 0)
  const failN = Number(a.fail_count || 0)
  const totalN = okN + failN
  const failRate = totalN > 0 ? failN / totalN : 0
  const failRateChip = totalN > 20
    ? `<small class="chip chip-${failRate > 0.15 ? 'danger' : failRate > 0.05 ? 'warn' : 'muted'}" style="margin-left:4px;">${(failRate * 100).toFixed(1)}%</small>`
    : ''
  // 今日请求 + error rate
  const todayReq = a.today_requests ?? 0
  const todayErr = a.today_errors ?? 0
  const todayErrRate = todayReq > 0 ? todayErr / todayReq : 0
  const todayChip = todayReq > 0
    ? `<small class="chip chip-${todayErrRate > 0.1 ? 'danger' : todayErrRate > 0.02 ? 'warn' : 'ok'}" style="margin-left:4px;">${(todayErrRate * 100).toFixed(1)}%</small>`
    : ''
  // cooldown chip
  const cdChip = a.cooldown_until
    ? (() => {
        const ms = new Date(a.cooldown_until).getTime() - Date.now()
        if (Number.isNaN(ms)) return escapeHtml(String(a.cooldown_until))
        if (ms <= 0) return `<span class="chip chip-muted" title="${escapeHtml(fmtDate(a.cooldown_until))}">已过</span>`
        const mins = Math.max(1, Math.round(ms / 60000))
        const label = mins >= 60 ? `${Math.round(mins / 60)}h` : `${mins}m`
        return `<span class="chip chip-warn" title="${escapeHtml(fmtDate(a.cooldown_until))}">${label}</span>`
      })()
    : '—'
  // cooldown reset 只对 cooldown_until 非空的账号显示
  const showReset = !!a.cooldown_until
  // 5h / 7d 配额单元格(M9)。utilization 0-100 number|null。
  // quota_updated_at 早于 1h 显灰(陈旧),≥ 95 红 / ≥ 80 黄 / 否则常态。
  const cell5h = _renderQuotaCell(a.quota_5h_pct, a.quota_updated_at)
  const cell7d = _renderQuotaCell(a.quota_7d_pct, a.quota_updated_at)
  // Issue B — 配额重置时间独立列,boss 要求显式可见。
  const cell5hReset = _renderResetCell(a.quota_5h_resets_at)
  const cell7dReset = _renderResetCell(a.quota_7d_resets_at)
  return `
    <tr>
      <td class="mono">${escapeHtml(a.id)}</td>
      <td>${escapeHtml(a.label)}${_accountWarningChips(a)}</td>
      <td>${escapeHtml(a.plan)}</td>
      <td>${statusBadge(a.status)}</td>
      <td class="num">${a.health_score ?? '—'}</td>
      <td class="num">${todayReq}${todayChip}</td>
      <td class="num">${okN}/${failN}${failRateChip}</td>
      <td class="mono">${fmtDate(a.oauth_expires_at)}</td>
      <td class="mono" title="${escapeHtml(a.subscription_end_at ? fmtDate(a.subscription_end_at) : '未填(调度器中性看待)')}">${a.subscription_end_at ? escapeHtml(fmtDate(a.subscription_end_at)) : '<span class="muted">—</span>'}</td>
      <td class="mono">${a.group_id ? `#${escapeHtml(a.group_id)}` : '<span class="muted">—</span>'}</td>
      <td class="num">${cell5h}</td>
      <td class="num">${cell5hReset}</td>
      <td class="num">${cell7d}</td>
      <td class="num">${cell7dReset}</td>
      <td class="mono">${cdChip}</td>
      <td class="mono">${fmtRelative(a.last_used_at)}</td>
      <td class="mono" title="${escapeHtml(a.egress_proxy_pool_label || '')}">${escapeHtml(a.egress_proxy_pool_label || '—')}</td>
      <td class="actions">
        ${showReset ? `<button data-act="reset-cooldown" data-id="${escapeHtml(a.id)}" data-label="${escapeHtml(a.label)}" title="清冷却 + last_error">释放冷却</button>` : ''}
        <button data-act="acc-recent-users" data-id="${escapeHtml(a.id)}" data-label="${escapeHtml(a.label)}" title="近 24h 使用过该账号的用户">查看使用方</button>
        <button data-act="refresh-history" data-id="${escapeHtml(a.id)}" data-label="${escapeHtml(a.label)}" title="查看 OAuth refresh 最近 50 次结果">刷新历史</button>
        <button data-act="edit-acc" data-id="${escapeHtml(a.id)}">编辑</button>
        <button data-act="del-acc" data-id="${escapeHtml(a.id)}" data-label="${escapeHtml(a.label)}">删除</button>
      </td>
    </tr>`
}

async function resetAccountCooldown(id, label, btn) {
  if (!confirm(`释放账号 #${id} (${label}) 的冷却并清 last_error?\n不会修改 status。`)) return
  await withBtnLoading(btn, async () => {
    try {
      await apiJson('POST', `/api/admin/accounts/${encodeURIComponent(id)}/reset-cooldown`)
      toast(`#${id} 冷却已释放`)
      // 局部刷新:只重拉 accounts,KPI 不变太快
      _loadAccounts(ACCOUNTS_STATE.renderSeq)
      _loadAccountsKpis(ACCOUNTS_STATE.renderSeq)
    } catch (e) {
      toast(`释放失败:${e.message}`, 'danger', toastOptsFromError(e))
    }
  })
}

function _accountGroupOptions(accountGroups, provider, currentGroupId, isCreate) {
  const defaultLabel = provider === 'codex' ? '— 默认 Codex 官方 OAuth 组 —' : '— 默认 Claude 官方订阅组 —'
  const rows = (accountGroups || []).filter((g) => g && g.kind === 'official_oauth' && g.provider === provider)
  return [
    `<option value="" ${currentGroupId ? '' : 'selected'}>${isCreate ? defaultLabel : '— 未绑定 —'}</option>`,
    ...rows.map((g) => `
      <option value="${escapeHtml(String(g.id))}" ${String(g.id) === currentGroupId ? 'selected' : ''}>
        ${escapeHtml(g.label)} #${escapeHtml(String(g.id))}${g.enabled ? '' : ' (disabled)'}
      </option>`),
  ].join('')
}

function _accountFormFields(prefill, activeProxies = [], accountGroups = [], providerForGroups = null) {
  // prefill = null → 新建;否则 = 现有 account 对象。
  // oauth_token 在 PATCH 模式下必须用户主动输入才发送(避免误覆盖)。
  // activeProxies = [{id, label, url_masked}] 给 egress_proxy_id dropdown 用。
  const isCreate = !prefill
  const a = prefill || {}
  // 0055: egress 必须通过 egress_proxies 池条目。dropdown 选项来自 active 池。
  // 编辑时若当前绑定的 entry 已被禁用,把它单独 append 到尾部("已禁用"标签),
  // 保持选中态可见(避免静默切到第一项)。
  const currentEpid = a.egress_proxy_id != null ? String(a.egress_proxy_id) : ''
  const currentGroupId = a.group_id != null ? String(a.group_id) : ''
  const currentLabel = a.egress_proxy_pool_label || ''
  const inActiveList = activeProxies.some((p) => String(p.id) === currentEpid)
  const groupProvider = providerForGroups || a.provider || 'claude'
  const groupOptions = _accountGroupOptions(accountGroups, groupProvider === 'codex' ? 'codex' : 'claude', currentGroupId, isCreate)
  const epidOptions = [
    isCreate
      ? `<option value="" disabled ${currentEpid ? '' : 'selected'}>— 请选择代理池条目 —</option>`
      : '',
    ...activeProxies.map(
      (p) =>
        `<option value="${escapeHtml(String(p.id))}" ${
          String(p.id) === currentEpid ? 'selected' : ''
        }>${escapeHtml(p.label)} <${escapeHtml(p.url_masked || '')}></option>`,
    ),
    !isCreate && currentEpid && !inActiveList
      ? `<option value="${escapeHtml(currentEpid)}" selected>${escapeHtml(currentLabel || `#${currentEpid}`)}(已禁用)</option>`
      : '',
  ]
    .filter(Boolean)
    .join('')
  return `
    <div class="form-row">
      <label>label(账号标签,必填)</label>
      <input type="text" id="acc-label" maxlength="120" value="${escapeHtml(a.label || '')}" />
    </div>
    <div class="form-row">
      <label>plan</label>
      <select id="acc-plan">
        ${ACCOUNT_PLANS.map((p) => `<option value="${p}" ${p === (a.plan || 'pro') ? 'selected' : ''}>${p}</option>`).join('')}
      </select>
    </div>
    ${isCreate ? '' : `
    <div class="form-row">
      <label>status</label>
      <select id="acc-status-edit">
        ${ACCOUNT_STATUSES.map((s) => `<option value="${s}" ${s === a.status ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
    </div>`}
    <div class="form-row">
      <label>oauth_token ${isCreate ? '(必填)' : '(留空则不修改)'}</label>
      <textarea id="acc-token" placeholder="${isCreate ? '粘贴 OAuth access token' : '不动 → 留空'}"></textarea>
    </div>
    <div class="form-row">
      <label>oauth_refresh_token ${isCreate ? '(可选)' : '(留空则不修改;输入 NULL 清空)'}</label>
      <input type="text" id="acc-refresh" placeholder="可选" />
    </div>
    <div class="form-row">
      <label>oauth_expires_at ${isCreate ? '(可选 ISO 时间)' : '(留空不动;输入 NULL 清空)'}</label>
      <input type="text" id="acc-expires" placeholder="如 2026-12-31T00:00:00Z 或 NULL"
             value="${escapeHtml(a.oauth_expires_at || '')}" />
    </div>
    <div class="form-row">
      <label>subscription_end_at ${isCreate ? '(可选;Anthropic 订阅到期日)' : '(留空不动;输入 NULL 清空)'}</label>
      <input type="text" id="acc-sub-end" placeholder="如 2026-12-31 或 2026-12-31T00:00:00Z 或 NULL"
             value="${escapeHtml(a.subscription_end_at || '')}" />
      <small style="color:var(--muted)">管理员手填字段(Anthropic OAuth/API 不暴露)。NULL = 未知,调度器按中性 1.0 看待;否则参与 WRH 权重 — <strong>快到期账号自动加权(收益最大化:订阅到期前榨干额度)</strong>。</small>
    </div>
    <div class="form-row">
      <label>账号分组(官方 OAuth)</label>
      <select id="acc-group-id">${groupOptions}</select>
      <small style="color:var(--muted)">绑定 selected provider 的 official_oauth 分组;Codex API 中转站仍走独立 relay credential。</small>
    </div>
    <div class="form-row">
      <label>egress 代理池条目${isCreate ? '(必选)' : '(必选;不可清空)'}</label>
      <select id="acc-egress-id">${epidOptions}</select>
      <small style="color:var(--muted)">从"代理池"页维护可用条目;此处仅显示 active 项${
        !isCreate && currentEpid && !inActiveList ? ',当前条目已被禁用' : ''
      }。</small>
    </div>
  `
}

// 把 form 字段读成 PATCH/CREATE body。空 string 在 PATCH 模式下表示 "不动",
// 字符串 "NULL"(大小写不敏感)表示显式置空。
// 0055: egress_proxy_id 必填(create) / 不允许清空(patch)。
// 第二个参数 prefillEpid 在 patch 模式下用来判断是否变更,避免无谓写。
function _readAccountForm(isCreate, prefillEpid = '', prefillGroupId = '', provider = 'claude') {
  const label = $('acc-label').value.trim()
  const plan = $('acc-plan').value
  const tokenRaw = $('acc-token').value.trim()
  const refreshRaw = $('acc-refresh').value.trim()
  const expiresRaw = $('acc-expires').value.trim()
  const subEndRaw = $('acc-sub-end').value.trim()
  const egressIdRaw = $('acc-egress-id').value.trim()
  const groupIdRaw = $('acc-group-id')?.value?.trim() || ''
  const isNull = (v) => v.toUpperCase() === 'NULL'

  if (!label) throw new Error('label 必填')
  const body = { label, plan }

  if (isCreate) {
    if (!tokenRaw) throw new Error('oauth_token 必填')
    if (!egressIdRaw) throw new Error('egress 代理池条目 必选')
    body.oauth_token = tokenRaw
    if (refreshRaw) body.oauth_refresh_token = isNull(refreshRaw) ? null : refreshRaw
    if (expiresRaw) body.oauth_expires_at = isNull(expiresRaw) ? null : expiresRaw
    if (subEndRaw) body.subscription_end_at = isNull(subEndRaw) ? null : subEndRaw
    if ((provider === 'claude' || provider === 'codex') && groupIdRaw) body.group_id = groupIdRaw
    body.egress_proxy_id = egressIdRaw
  } else {
    body.status = $('acc-status-edit').value
    if (tokenRaw) body.oauth_token = tokenRaw
    if (refreshRaw) body.oauth_refresh_token = isNull(refreshRaw) ? null : refreshRaw
    if (expiresRaw) body.oauth_expires_at = isNull(expiresRaw) ? null : expiresRaw
    if (subEndRaw) body.subscription_end_at = isNull(subEndRaw) ? null : subEndRaw
    if (!egressIdRaw) throw new Error('egress 代理池条目 不可清空')
    if (egressIdRaw !== String(prefillEpid || '')) body.egress_proxy_id = egressIdRaw
    if ((provider === 'claude' || provider === 'codex') && groupIdRaw !== String(prefillGroupId || '')) {
      body.group_id = groupIdRaw || null
    }
  }
  return body
}

// 模块级 state:OAuth 拿到的 state 跟 modal 共享
let _oauthPendingState = null
// modal 当前选择的 provider —— 'claude' 或 'codex'。oauthStartStep 用,
// 创建账号时也透传给后端(账号 row.provider 决定后续 token refresh / 容器
// auth 路径,不可改,见 admin.ts:1148)
let _oauthSelectedProvider = 'claude'

function _selectedProviderFromRadio() {
  const checked = document.querySelector('input[name="acc-provider"]:checked')
  return checked && (checked.value === 'codex') ? 'codex' : 'claude'
}

// 拉 active 代理池条目;dropdown 选项只显示 active(disabled 不允许新绑)。
async function _fetchActiveEgressProxies() {
  const sp = new URLSearchParams({ status: 'active', limit: '500' })
  const r = await apiGet(`/api/admin/egress-proxies?${sp.toString()}`)
  return Array.isArray(r?.rows) ? r.rows : []
}

async function _fetchOfficialOAuthAccountGroups() {
  const r = await apiGet('/api/admin/account-groups')
  const rows = Array.isArray(r?.rows) ? r.rows : []
  return rows.filter((g) => g && g.kind === 'official_oauth')
}

async function openCreateAccountModal() {
  _oauthPendingState = null
  _oauthSelectedProvider = 'claude'
  let activeProxies
  let accountGroups
  try {
    ;[activeProxies, accountGroups] = await Promise.all([
      _fetchActiveEgressProxies(),
      _fetchOfficialOAuthAccountGroups(),
    ])
  } catch (e) {
    toast(`加载账号表单依赖失败: ${e.message}`, 'danger', toastOptsFromError(e)); return
  }
  if (activeProxies.length === 0) {
    toast('代理池没有 active 条目,先去"代理池"页新建并启用一条', 'danger'); return
  }
  openModal(`
    <h3>新建账号</h3>

    <div class="form-row">
      <label>provider(创建后不可改)</label>
      <div style="display:flex;gap:14px">
        <label style="display:inline-flex;gap:6px;align-items:center">
          <input type="radio" name="acc-provider" value="claude" checked /> claude
        </label>
        <label style="display:inline-flex;gap:6px;align-items:center">
          <input type="radio" name="acc-provider" value="codex" /> codex (GPT)
        </label>
      </div>
    </div>

    <div class="oauth-box" style="
      border:1px solid #6366f1; border-radius:8px;
      padding:14px; margin-bottom:16px; background:rgba(99,102,241,0.08);
    ">
      <div style="font-weight:600;margin-bottom:8px">🔐 OAuth 授权 (推荐)</div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
        <button class="btn-primary" id="acc-oauth-open" type="button"
                style="white-space:nowrap">① 打开授权页</button>
        <span id="acc-oauth-hint" style="color:var(--muted);font-size:13px">
          点左边 → 新页签授权 → 复制回调 URL 里的 code
        </span>
      </div>
      <div id="acc-oauth-step2" style="display:none">
        <label style="display:block;font-size:13px;color:var(--muted);margin-bottom:4px">
          ② 粘贴 code(或整段回调 URL,会自动抽 code 参数):
        </label>
        <div style="display:flex;gap:6px">
          <input type="text" id="acc-oauth-code" placeholder="粘 code 或 URL" style="flex:1" />
          <button class="btn-primary" id="acc-oauth-submit" type="button" style="white-space:nowrap">
            ③ 换 token
          </button>
        </div>
      </div>
    </div>

    <hr style="margin:14px 0;border:0;border-top:1px solid var(--border,#333)" />

    ${_accountFormFields(null, activeProxies, accountGroups, 'claude')}
    <div class="form-actions">
      <button id="acc-cancel">取消</button>
      <button class="btn-primary" id="acc-ok">创建</button>
    </div>
  `)
  $('acc-cancel').addEventListener('click', closeModal)
  $('acc-oauth-open').addEventListener('click', oauthStartStep)
  $('acc-oauth-submit').addEventListener('click', oauthExchangeStep)
  const syncGroupSelect = () => {
    const sel = $('acc-group-id')
    if (sel) sel.innerHTML = _accountGroupOptions(accountGroups, _selectedProviderFromRadio(), '', true)
  }
  for (const r of document.querySelectorAll('input[name="acc-provider"]')) {
    r.addEventListener('change', syncGroupSelect)
  }
  syncGroupSelect()
  $('acc-ok').addEventListener('click', async (ev) => {
    let body
    const provider = _selectedProviderFromRadio()
    try { body = _readAccountForm(true, '', '', provider) }
    catch (e) { toast(e.message, 'danger'); return }
    // 默认 claude(后端兼容历史 caller);codex 时显式传
    body.provider = provider
    await withBtnLoading(ev.currentTarget, async () => {
      try {
        const r = await apiJson('POST', '/api/admin/accounts', body)
        toast(`已创建账号 ${r?.account?.id || ''}`)
        closeModal()
        applyHash()
      } catch (e) {
        toast(`创建失败: ${e.message}`, 'danger', toastOptsFromError(e))
      }
    })
  })
}

// 步骤一:让后端发 PKCE state、生成 authUrl,新页签打开
async function oauthStartStep() {
  // 同步 radio → 模块状态,后端按 provider 返回 claude/codex 的 authUrl
  _oauthSelectedProvider = _selectedProviderFromRadio()
  let started
  try {
    started = await apiJson('POST', '/api/admin/accounts/oauth/start', {
      provider: _oauthSelectedProvider,
    })
  } catch (e) {
    toast(`OAuth 启动失败: ${e.message}`, 'danger', toastOptsFromError(e))
    return
  }
  const { authUrl, state: oauthState } = started || {}
  if (!authUrl || !oauthState) {
    toast('OAuth 启动返回不完整', 'danger')
    return
  }
  _oauthPendingState = oauthState
  // 新 tab 打开;被拦截时降级 location.href(本页跳走 — 但 modal state 已存模块级,
  // 用户回来重开 modal 也能续上 oauthExchange,虽然 state 已重置为 null;
  // 实践上多数浏览器允许 user-gesture-driven window.open)
  const win = window.open(authUrl, '_blank', 'noopener')
  if (!win) {
    toast('弹窗被拦截。请手动复制下方链接到新页签打开。', 'danger')
    $('acc-oauth-hint').innerHTML =
      `授权 URL(自己复制到新 tab):<br><code style="font-size:12px;word-break:break-all">${escapeHtml(authUrl)}</code>`
  } else {
    $('acc-oauth-hint').textContent = '授权页已在新 tab 打开,完成后回来粘 code ↓'
  }
  $('acc-oauth-step2').style.display = 'block'
  setTimeout(() => $('acc-oauth-code')?.focus(), 50)
}

// 步骤二:把 code 拿去后端换 token,自动填表单
async function oauthExchangeStep() {
  if (!_oauthPendingState) {
    toast('请先点"打开授权页",再粘 code', 'danger')
    return
  }
  const raw = $('acc-oauth-code')?.value?.trim()
  if (!raw) { toast('请粘 code 或 URL', 'danger'); return }

  let code = raw
  try {
    if (code.startsWith('http')) {
      const u = new URL(code)
      code = u.searchParams.get('code') || code
    }
  } catch { /* 不是合法 URL,当 code 用 */ }
  if (code.includes('#')) code = code.split('#')[0]

  let exchanged
  const btn = $('acc-oauth-submit')
  let failed = false
  if (btn) {
    btn.disabled = true
    btn.classList.add('is-loading')
    btn.setAttribute('aria-busy', 'true')
  }
  try {
    exchanged = await apiJson('POST', '/api/admin/accounts/oauth/exchange', {
      code, state: _oauthPendingState,
    })
  } catch (e) {
    toast(`Token 交换失败: ${e.message}`, 'danger', toastOptsFromError(e))
    failed = true
  } finally {
    if (btn) {
      btn.disabled = false
      btn.classList.remove('is-loading')
      btn.removeAttribute('aria-busy')
    }
  }
  if (failed) return

  _oauthPendingState = null
  if ($('acc-token')) $('acc-token').value = exchanged.access_token || ''
  if ($('acc-refresh')) $('acc-refresh').value = exchanged.refresh_token || ''
  if ($('acc-expires')) $('acc-expires').value = exchanged.expires_at || ''
  $('acc-oauth-hint').innerHTML =
    '<span style="color:#10b981">✓ token 已写入下方表单。核对 label/plan 后点 "创建"</span>'
  $('acc-oauth-step2').style.display = 'none'
  toast('Token 已自动填好,核对 label/plan 后点"创建"', 'success')
}

async function openEditAccountModal(id) {
  let account
  let activeProxies
  let accountGroups
  try {
    const [accResp, proxies, groups] = await Promise.all([
      apiGet(`/api/admin/accounts/${encodeURIComponent(id)}`),
      _fetchActiveEgressProxies(),
      _fetchOfficialOAuthAccountGroups(),
    ])
    account = accResp?.account
    if (!account) throw new Error('未找到账号')
    activeProxies = proxies
    accountGroups = groups
  } catch (e) {
    toast(`读取失败: ${e.message}`, 'danger', toastOptsFromError(e)); return
  }
  const prefillEpid = account.egress_proxy_id != null ? String(account.egress_proxy_id) : ''
  const prefillGroupId = account.group_id != null ? String(account.group_id) : ''
  openModal(`
    <h3>编辑账号 #${escapeHtml(account.id)}</h3>
    ${_accountFormFields(account, activeProxies, accountGroups, account.provider || 'claude')}
    <div class="form-actions">
      <button id="acc-cancel">取消</button>
      <button class="btn-primary" id="acc-ok">保存</button>
    </div>
  `)
  $('acc-cancel').addEventListener('click', closeModal)
  $('acc-ok').addEventListener('click', async (ev) => {
    let body
    try { body = _readAccountForm(false, prefillEpid, prefillGroupId, account.provider || 'claude') }
    catch (e) { toast(e.message, 'danger'); return }
    await withBtnLoading(ev.currentTarget, async () => {
      try {
        await apiJson('PATCH', `/api/admin/accounts/${encodeURIComponent(account.id)}`, body)
        toast(`#${account.id} 已保存`)
        closeModal()
        applyHash()
      } catch (e) {
        toast(`保存失败: ${e.message}`, 'danger', toastOptsFromError(e))
      }
    })
  })
}

async function deleteAccount(id, label, btn) {
  if (!confirm(`确认删除账号 #${id} (${label})?\n此操作不可恢复;若有运行中容器仍在用此账号会失败。`)) return
  await withBtnLoading(btn, async () => {
    try {
      await apiJson('DELETE', `/api/admin/accounts/${encodeURIComponent(id)}`)
      toast(`#${id} 已删除`)
      applyHash()
    } catch (e) {
      toast(`删除失败: ${e.message}`, 'danger', toastOptsFromError(e))
    }
  })
}

// ─── Tab: Egress Proxies(出口代理池 — 0052/0053) ──────────────────
//
// CRUD list — admin 维护一组出口代理 URL,创建/编辑账号时挂到 claude_accounts.egress_proxy_id。
// 列表只展示 url_masked(后端遮蔽),明文 URL 永远不出库。
// 0055: 删除被账号绑定的池条目 → 后端 409 PROXY_IN_USE,admin 必须先把账号迁到
// 其他池条目(在"账号"页编辑账号 → 改 egress 代理池条目下拉)。

const EGRESS_PROXY_STATE = {
  renderSeq: 0,
  rows: [],
  filterStatus: '',
}

async function renderEgressProxiesTab() {
  const mySeq = ++EGRESS_PROXY_STATE.renderSeq
  EGRESS_PROXY_STATE.filterStatus = sessionStorage.getItem('admin_ep_status') || ''
  view().innerHTML = `
    <div class="panel">
      <h1 style="margin-top:0">代理池 <small style="color:var(--muted);font-weight:400;font-size:14px" id="ep-count">加载中…</small></h1>
      <div class="toolbar">
        <label>状态:
          <select id="ep-status">
            <option value="" ${EGRESS_PROXY_STATE.filterStatus === '' ? 'selected' : ''}>全部</option>
            <option value="active" ${EGRESS_PROXY_STATE.filterStatus === 'active' ? 'selected' : ''}>active</option>
            <option value="disabled" ${EGRESS_PROXY_STATE.filterStatus === 'disabled' ? 'selected' : ''}>disabled</option>
          </select>
        </label>
        <button class="btn" id="ep-refresh">刷新</button>
        <span class="spacer"></span>
        <button class="btn btn-primary" id="ep-new">+ 新建代理</button>
      </div>
      <div id="ep-table-container"><div class="empty">加载中…</div></div>
    </div>
  `
  $('ep-status').addEventListener('change', (e) => {
    EGRESS_PROXY_STATE.filterStatus = e.target.value
    sessionStorage.setItem('admin_ep_status', e.target.value)
    renderEgressProxiesTab()
  })
  $('ep-refresh').addEventListener('click', () => renderEgressProxiesTab())
  $('ep-new').addEventListener('click', openCreateEgressProxyModal)

  const sp = new URLSearchParams({ limit: '500' })
  if (EGRESS_PROXY_STATE.filterStatus) sp.set('status', EGRESS_PROXY_STATE.filterStatus)
  let data
  try {
    data = await apiGet(`/api/admin/egress-proxies?${sp.toString()}`)
  } catch (err) {
    if (mySeq !== EGRESS_PROXY_STATE.renderSeq || _currentTab !== 'egressProxies') return
    toast(`加载失败:${err.message}`, 'danger', toastOptsFromError(err))
    const el = $('ep-table-container')
    if (el) el.innerHTML = `<div class="empty" style="color:var(--danger)">加载失败:${escapeHtml(err.message)}</div>`
    const cnt = $('ep-count'); if (cnt) cnt.textContent = '—'
    return
  }
  if (mySeq !== EGRESS_PROXY_STATE.renderSeq || _currentTab !== 'egressProxies') return
  const rows = data?.rows ?? []
  EGRESS_PROXY_STATE.rows = rows
  const cnt = $('ep-count'); if (cnt) cnt.textContent = `共 ${rows.length} 条`
  const el = $('ep-table-container')
  if (rows.length === 0) {
    el.innerHTML = '<div class="empty">尚无代理</div>'
    return
  }
  el.innerHTML = `
    <table class="data">
      <thead><tr>
        <th>label</th><th>url(已遮蔽)</th><th>status</th><th>notes</th>
        <th>更新时间</th><th class="actions">操作</th>
      </tr></thead>
      <tbody>
        ${rows.map((r) => `
          <tr>
            <td>${escapeHtml(r.label)}</td>
            <td class="mono">${escapeHtml(r.url_masked)}</td>
            <td>${r.status === 'active'
              ? '<span class="badge ok">active</span>'
              : '<span class="badge muted">disabled</span>'}</td>
            <td>${escapeHtml(r.notes || '')}</td>
            <td class="mono">${escapeHtml(fmtDate(r.updated_at))}</td>
            <td class="actions">
              <button data-act="ep-edit" data-id="${escapeHtml(r.id)}">编辑</button>
              <button data-act="ep-del" data-id="${escapeHtml(r.id)}" data-label="${escapeHtml(r.label)}">删除</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>
  `
  for (const b of view().querySelectorAll('button[data-act="ep-edit"]')) {
    b.addEventListener('click', () => openEditEgressProxyModal(b.dataset.id))
  }
  for (const b of view().querySelectorAll('button[data-act="ep-del"]')) {
    b.addEventListener('click', (ev) => deleteEgressProxy(b.dataset.id, b.dataset.label, ev.currentTarget))
  }
}

function openCreateEgressProxyModal() {
  openModal(`
    <h3>新建代理</h3>
    <div class="form-row"><label>label(展示名,唯一)</label>
      <input type="text" id="ep-label" placeholder="例:tokyo-residential-1" /></div>
    <div class="form-row"><label>URL(明文,创建后只展示遮蔽串)</label>
      <input type="text" id="ep-url" placeholder="http://user:pass@host:port 或 socks5://..." /></div>
    <div class="form-row"><label>status</label>
      <select id="ep-status-input">
        <option value="active" selected>active</option>
        <option value="disabled">disabled</option>
      </select></div>
    <div class="form-row"><label>notes(可选)</label>
      <input type="text" id="ep-notes" placeholder="备注" /></div>
    <div class="form-actions">
      <button id="ep-cancel">取消</button>
      <button class="btn-primary" id="ep-ok">创建</button>
    </div>
  `)
  $('ep-cancel').addEventListener('click', closeModal)
  $('ep-ok').addEventListener('click', async (ev) => {
    const label = $('ep-label').value.trim()
    const url = $('ep-url').value.trim()
    if (!label) { toast('label 必填', 'warn'); return }
    if (!url) { toast('url 必填', 'warn'); return }
    await withBtnLoading(ev.currentTarget, async () => {
      try {
        const body = {
          label, url,
          status: $('ep-status-input').value,
        }
        const notes = $('ep-notes').value
        if (notes !== '') body.notes = notes
        await apiJson('POST', '/api/admin/egress-proxies', body)
        toast('已创建')
        closeModal()
        renderEgressProxiesTab()
      } catch (e) {
        toast(`创建失败: ${e.message}`, 'danger', toastOptsFromError(e))
      }
    })
  })
}

async function openEditEgressProxyModal(id) {
  let row
  try {
    const r = await apiGet(`/api/admin/egress-proxies/${encodeURIComponent(id)}`)
    row = r?.row
    if (!row) throw new Error('未找到')
  } catch (e) {
    toast(`加载失败:${e.message}`, 'danger', toastOptsFromError(e))
    return
  }
  // 编辑窗口出于安全不回显明文 URL — admin 想换就重输,留空表示不改
  openModal(`
    <h3>编辑代理 · ${escapeHtml(row.label)}</h3>
    <div class="form-row"><label>label</label>
      <input type="text" id="ep-label" value="${escapeHtml(row.label)}" /></div>
    <div class="form-row"><label>当前 URL(已遮蔽,留空即不改)</label>
      <input type="text" id="ep-url" placeholder="${escapeHtml(row.url_masked)}" /></div>
    <div class="form-row"><label>status</label>
      <select id="ep-status-input">
        <option value="active" ${row.status === 'active' ? 'selected' : ''}>active</option>
        <option value="disabled" ${row.status === 'disabled' ? 'selected' : ''}>disabled</option>
      </select></div>
    <div class="form-row"><label>notes</label>
      <input type="text" id="ep-notes" value="${escapeHtml(row.notes || '')}" /></div>
    <div class="form-actions">
      <button id="ep-cancel">取消</button>
      <button class="btn-primary" id="ep-ok">保存</button>
    </div>
  `)
  $('ep-cancel').addEventListener('click', closeModal)
  $('ep-ok').addEventListener('click', async (ev) => {
    const label = $('ep-label').value.trim()
    if (!label) { toast('label 必填', 'warn'); return }
    await withBtnLoading(ev.currentTarget, async () => {
      try {
        const patch = {
          label,
          status: $('ep-status-input').value,
          notes: $('ep-notes').value,
        }
        const url = $('ep-url').value.trim()
        if (url) patch.url = url
        await apiJson('PATCH', `/api/admin/egress-proxies/${encodeURIComponent(id)}`, patch)
        toast('已保存')
        closeModal()
        renderEgressProxiesTab()
      } catch (e) {
        toast(`保存失败: ${e.message}`, 'danger', toastOptsFromError(e))
      }
    })
  })
}

async function deleteEgressProxy(id, label, btn) {
  // 0055: 被绑账号 → 后端 409 PROXY_IN_USE,admin 必须先迁。前端不预查 count,
  // 直接发请求让后端权威判定;失败 toast 把 issues.bound_account_count 透出。
  if (!confirm(`确认删除代理 "${label}"?\n\n注: 若仍有账号绑定该代理,后端会拒绝;请先在"账号"页把绑定的账号改到其他代理。`)) return
  await withBtnLoading(btn, async () => {
    try {
      await apiJson('DELETE', `/api/admin/egress-proxies/${encodeURIComponent(id)}`, null)
      toast('已删除')
      renderEgressProxiesTab()
    } catch (e) {
      toast(`删除失败: ${e.message}`, 'danger', toastOptsFromError(e))
    }
  })
}

// ─── Tab: Containers ───────────────────────────────────────────────

// R4 — containers tab 重写(KPI 卡 + 客户端 status/email 过滤 + 日志 modal)

const CONTAINER_STATUSES = ['provisioning', 'running', 'stopped', 'removed', 'error']

const CONTAINERS_STATE = {
  renderSeq: 0, loadSeq: 0,
  rows: [], filterStatus: '', filterEmail: '', filterHostUuid: '',
}

async function renderContainersTab() {
  const mySeq = ++CONTAINERS_STATE.renderSeq
  CONTAINERS_STATE.rows = []
  // deeplink 命中本 tab 时按"完整目标态"处理:query 里没出现的 cross-tab
  // filter 字段一律清空(并 remove sessionStorage),避免上一次跳转的残留
  // 与本次 deeplink 做交集 — 例如先按 host 过滤、再点用户的 chip,会变成
  // "host_uuid + user_email" 而不是预期的"只按 user_email"。
  // (Codex review #1 阻断项:deeplink 与 sessionStorage 残留的交集 bug)
  if (pendingDeeplink && pendingDeeplink.tab === 'containers') {
    const p = pendingDeeplink.params
    const ue = p.get('user_email') || ''
    const hu = p.get('host_uuid') || ''
    const st = p.get('status') || ''
    CONTAINERS_STATE.filterEmail = ue
    CONTAINERS_STATE.filterHostUuid = hu
    CONTAINERS_STATE.filterStatus = st
    if (ue) sessionStorage.setItem('admin_ct_email', ue); else sessionStorage.removeItem('admin_ct_email')
    if (hu) sessionStorage.setItem('admin_ct_host_uuid', hu); else sessionStorage.removeItem('admin_ct_host_uuid')
    if (st) sessionStorage.setItem('admin_ct_status', st); else sessionStorage.removeItem('admin_ct_status')
    pendingDeeplink = null
  } else {
    // 非 deeplink 进入(直接点 sidebar / 刷新页面)→ 沿用 sessionStorage。
    CONTAINERS_STATE.filterStatus = sessionStorage.getItem('admin_ct_status') || ''
    CONTAINERS_STATE.filterEmail = sessionStorage.getItem('admin_ct_email') || ''
    CONTAINERS_STATE.filterHostUuid = sessionStorage.getItem('admin_ct_host_uuid') || ''
  }

  view().innerHTML = `
    <div class="panel">
      <h1 style="margin-top:0">Agent 容器 <small style="color:var(--muted);font-weight:400;font-size:14px" id="ct-count">加载中…</small></h1>

      <!-- 4 张 KPI 卡片 -->
      <div class="stat-grid" id="ct-kpis" style="margin-bottom:18px">
        <div class="stat-card"><div class="stat-label">总容器</div><div class="stat-value is-loading">—</div><div class="stat-delta stat-muted">加载中…</div></div>
        <div class="stat-card"><div class="stat-label">运行中</div><div class="stat-value is-loading">—</div><div class="stat-delta stat-muted">加载中…</div></div>
        <div class="stat-card"><div class="stat-label">错误 / 有过报错</div><div class="stat-value is-loading">—</div><div class="stat-delta stat-muted">加载中…</div></div>
        <div class="stat-card"><div class="stat-label">7d 订阅到期</div><div class="stat-value is-loading">—</div><div class="stat-delta stat-muted">加载中…</div></div>
      </div>

      <div class="toolbar">
        <label>生命周期:
          <select id="ct-status">
            <option value="">全部</option>
            ${CONTAINER_STATUSES.map((s) =>
              `<option value="${s}" ${s === CONTAINERS_STATE.filterStatus ? 'selected' : ''}>${s}</option>`,
            ).join('')}
          </select>
        </label>
        <input type="text" id="ct-email" placeholder="email / user_id 过滤" value="${escapeHtml(CONTAINERS_STATE.filterEmail)}" />
        <button class="btn" id="ct-refresh">刷新</button>
        ${CONTAINERS_STATE.filterHostUuid
          ? `<button class="btn btn-link" id="ct-clear-host" title="清除 host_uuid 链接过滤">× 清除虚机过滤</button>`
          : ''}
      </div>

      <div id="ct-table-container"><div class="empty">加载中…</div></div>
    </div>
  `
  $('ct-status').addEventListener('change', (e) => {
    CONTAINERS_STATE.filterStatus = e.target.value
    sessionStorage.setItem('admin_ct_status', e.target.value)
    renderContainersTab()
  })
  $('ct-email').addEventListener('input', (e) => {
    CONTAINERS_STATE.filterEmail = e.target.value
    sessionStorage.setItem('admin_ct_email', e.target.value)
    _renderContainersTable()
  })
  $('ct-refresh').addEventListener('click', () => renderContainersTab())
  // 清除 host_uuid 链接过滤(仅在过滤生效时渲染按钮)
  $('ct-clear-host')?.addEventListener('click', () => {
    CONTAINERS_STATE.filterHostUuid = ''
    sessionStorage.removeItem('admin_ct_host_uuid')
    renderContainersTab()
  })

  await Promise.all([
    _loadContainersKpis(mySeq),
    _loadContainers(mySeq),
  ])
}

async function _loadContainersKpis(renderSeq) {
  let s
  try {
    s = await apiGet('/api/admin/agent-containers/stats')
  } catch {
    if (renderSeq !== CONTAINERS_STATE.renderSeq || _currentTab !== 'containers') return
    const cards = view().querySelectorAll('#ct-kpis .stat-card')
    for (const c of cards) updateStat(c, '—', '加载失败', 'danger')
    return
  }
  if (renderSeq !== CONTAINERS_STATE.renderSeq || _currentTab !== 'containers') return

  const cards = view().querySelectorAll('#ct-kpis .stat-card')
  updateStat(cards[0], s.total.toLocaleString(),
    `v2 ${s.v2} · v3 ${s.v3} · 已清理 ${s.gone}`,
    null)
  updateStat(cards[1], s.running.toLocaleString(),
    `provisioning ${s.provisioning} · stopped ${s.stopped}`,
    s.provisioning > 5 ? 'warning' : 'success')
  updateStat(cards[2], `${s.error} / ${s.with_last_error}`,
    `error 态 / 曾有 last_error`,
    s.error > 0 ? 'danger' : s.with_last_error > 0 ? 'warning' : 'success')
  updateStat(cards[3], s.expiring_7d.toLocaleString(),
    s.expiring_7d > 0 ? '需关注续订' : '暂无到期风险',
    s.expiring_7d > 0 ? 'warning' : 'success')
}

async function _loadContainers(renderSeq) {
  const myLoadSeq = ++CONTAINERS_STATE.loadSeq
  const sp = new URLSearchParams({ limit: '500' })
  if (CONTAINERS_STATE.filterStatus) sp.set('status', CONTAINERS_STATE.filterStatus)
  if (CONTAINERS_STATE.filterHostUuid) sp.set('host_uuid', CONTAINERS_STATE.filterHostUuid)

  let data
  try {
    data = await apiGet(`/api/admin/agent-containers?${sp.toString()}`)
  } catch (err) {
    if (renderSeq !== CONTAINERS_STATE.renderSeq || _currentTab !== 'containers') return
    toast(`加载失败:${err.message}`, 'danger', toastOptsFromError(err))
    const el = $('ct-table-container')
    if (el) el.innerHTML = `<div class="empty" style="color:var(--danger)">加载失败:${escapeHtml(err.message)}</div>`
    const cnt = $('ct-count'); if (cnt) cnt.textContent = '—'
    return
  }
  if (renderSeq !== CONTAINERS_STATE.renderSeq || myLoadSeq !== CONTAINERS_STATE.loadSeq) return
  if (_currentTab !== 'containers') return

  CONTAINERS_STATE.rows = data?.rows ?? []
  _renderContainersTable()
}

function _renderContainersTable() {
  const el = $('ct-table-container')
  if (!el) return
  const q = CONTAINERS_STATE.filterEmail.trim().toLowerCase()
  const rows = q
    ? CONTAINERS_STATE.rows.filter((c) =>
        (c.user_email || '').toLowerCase().includes(q) ||
        String(c.user_id || '').includes(q))
    : CONTAINERS_STATE.rows
  const cnt = $('ct-count')
  if (cnt) cnt.textContent = q
    ? `共 ${rows.length} / ${CONTAINERS_STATE.rows.length} 条(过滤中)`
    : `共 ${rows.length} 条`
  if (rows.length === 0) {
    el.innerHTML = '<div class="empty">无匹配容器</div>'
    return
  }
  el.innerHTML = `
    <table class="data">
      <thead>
        <tr>
          <th>id</th>
          <th>类型</th>
          <th>用户</th>
          <th>订阅 / 到期</th>
          <th>生命周期</th>
          <th>image</th>
          <th class="mono">docker</th>
          <th>虚机</th>
          <th>最近启动</th>
          <th>最近停止</th>
          <th class="actions">操作</th>
        </tr>
      </thead>
      <tbody>${rows.map(_renderContainerRow).join('')}</tbody>
    </table>
  `
  for (const b of el.querySelectorAll('button[data-act="ct-logs"]')) {
    b.addEventListener('click', () => openContainerLogsModal(b.dataset.id, b.dataset.label))
  }
  for (const b of el.querySelectorAll('button[data-act="ct-action"]')) {
    b.addEventListener('click', (ev) => containerAction(b.dataset.id, b.dataset.action, ev.currentTarget))
  }
  // 链跳:虚机列 → hosts tab + focus
  for (const a of el.querySelectorAll('a[data-nav]')) {
    a.addEventListener('click', (e) => {
      e.preventDefault()
      navigate(a.dataset.nav, _navQueryFrom(a))
    })
  }
}

function _containerWarningChips(c) {
  const chips = []
  if (c.last_error) {
    chips.push(`<span class="chip chip-danger" title="${escapeHtml(c.last_error)}">最近出错</span>`)
  }
  if (c.row_kind === 'v2' && c.subscription_end_at && c.subscription_status === 'active') {
    const end = new Date(c.subscription_end_at).getTime()
    if (!Number.isNaN(end)) {
      const days = (end - Date.now()) / 86400000
      if (days < 0) chips.push(`<span class="chip chip-danger" title="${escapeHtml(fmtDate(c.subscription_end_at))}">订阅已过期</span>`)
      else if (days < 7) chips.push(`<span class="chip chip-warn" title="${escapeHtml(fmtDate(c.subscription_end_at))}">${Math.ceil(days)}d 内到期</span>`)
    }
  }
  return chips.length > 0 ? `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:3px">${chips.join('')}</div>` : ''
}

function _renderContainerRow(c) {
  const kindClass = c.row_kind === 'v3' ? 'ok' : 'muted'
  const user = c.user_email
    ? `${escapeHtml(c.user_email)} <small style="color:var(--muted)">#${escapeHtml(c.user_id)}</small>`
    : `#${escapeHtml(c.user_id)}`
  const sub = c.row_kind === 'v2'
    ? `<div><span class="badge muted">${escapeHtml(c.subscription_status || '—')}</span></div>
       <small class="mono">${escapeHtml(fmtDate(c.subscription_end_at))}</small>`
    : '<small style="color:var(--muted)">ephemeral (v3 按量)</small>'
  const dockerRef = c.row_kind === 'v2'
    ? (c.docker_name || '—')
    : (c.docker_id || '').slice(0, 12) || '—'
  const idStr = escapeHtml(c.id)
  const label = `#${c.id} ${c.user_email || ''}`
  // 虚机列:有 host_uuid → 链跳 hosts tab + focus;无(v2 / 未分配)→ 灰显
  const hostCell = c.host_uuid
    ? `<a class="mono" data-nav="hosts" data-q-focus_uuid="${escapeHtml(c.host_uuid)}" title="${escapeHtml(c.host_uuid)}">${escapeHtml(c.host_name || c.host_uuid.slice(0, 8))}</a>`
    : '<span class="muted">—</span>'
  return `
    <tr>
      <td class="mono">${idStr}</td>
      <td><span class="badge ${kindClass}">${escapeHtml(c.row_kind || '?')}</span></td>
      <td>${user}${_containerWarningChips(c)}</td>
      <td>${sub}</td>
      <td>${statusBadge(c.lifecycle || c.status || c.state || '—')}</td>
      <td class="mono" title="${escapeHtml(c.image || '')}">${escapeHtml((c.image || '').split('/').pop() || '—')}</td>
      <td class="mono" title="${escapeHtml(c.docker_name || c.docker_id || '')}">${escapeHtml(dockerRef)}</td>
      <td>${hostCell}</td>
      <td class="mono">${fmtRelative(c.last_started_at)}</td>
      <td class="mono">${fmtRelative(c.last_stopped_at)}</td>
      <td class="actions">
        <button data-act="ct-logs" data-id="${idStr}" data-label="${escapeHtml(label)}">日志</button>
        <button data-act="ct-action" data-action="restart" data-id="${idStr}">重启</button>
        <button data-act="ct-action" data-action="stop" data-id="${idStr}">停止</button>
      </td>
    </tr>`
}

async function containerAction(id, action, btn) {
  if (!confirm(`确定 ${action} 容器 #${id}?`)) return
  await withBtnLoading(btn, async () => {
    try {
      await apiJson('POST', `/api/admin/agent-containers/${encodeURIComponent(id)}/${action}`)
      toast(`#${id} 已 ${action}`)
      _loadContainers(CONTAINERS_STATE.renderSeq)
      _loadContainersKpis(CONTAINERS_STATE.renderSeq)
    } catch (e) {
      toast(`失败: ${e.message}`, 'danger', toastOptsFromError(e))
    }
  })
}

// Codex LOW#5:logs modal 的 loadSeq —— 同一 modal 内快速切 lines / 点刷新时,
// 旧请求回来晚了别覆盖新请求写入的内容。
const LOGS_MODAL_STATE = { loadSeq: 0 }

async function openContainerLogsModal(id, label) {
  openModal(`
    <h2 style="margin-top:0">容器日志 <small style="color:var(--muted);font-weight:400;font-size:13px">${escapeHtml(label)}</small></h2>
    <div class="toolbar">
      <label>行数:
        <select id="lg-lines">
          <option value="100">100</option>
          <option value="200" selected>200</option>
          <option value="500">500</option>
        </select>
      </label>
      <button class="btn" id="lg-refresh">刷新</button>
      <span class="spacer"></span>
      <button class="btn" id="lg-close">关闭</button>
    </div>
    <pre id="lg-body" class="mono" style="max-height:60vh;overflow:auto;background:var(--bg-code, #111);color:var(--fg-code, #ddd);padding:12px;border-radius:6px;font-size:12px;white-space:pre-wrap;word-break:break-all;min-height:300px">加载中…</pre>
  `)
  $('lg-close').addEventListener('click', closeModal)
  $('lg-refresh').addEventListener('click', () => _loadContainerLogs(id))
  $('lg-lines').addEventListener('change', () => _loadContainerLogs(id))
  await _loadContainerLogs(id)
}

async function _loadContainerLogs(id) {
  const mySeq = ++LOGS_MODAL_STATE.loadSeq
  const body = $('lg-body')
  if (!body) return
  body.textContent = '加载中…'
  const lines = $('lg-lines')?.value || '200'
  try {
    const data = await apiGet(`/api/admin/agent-containers/${encodeURIComponent(id)}/logs?lines=${encodeURIComponent(lines)}`)
    // 晚到的响应被更新版 / 关闭 modal 抢占 → 丢弃
    if (mySeq !== LOGS_MODAL_STATE.loadSeq) return
    const nowBody = $('lg-body')
    if (!nowBody) return
    if (data.missing) {
      nowBody.textContent = `容器已不存在(docker_ref=${data.docker_ref ?? 'null'})。数据库行仍可见,可在 users tab 按 user 追查。`
      return
    }
    let combined = data.combined || '(无输出)'
    // R4-2 LOW#3:后端若中途截断或报错,前端把警示横幅贴到日志头,避免 admin
    // 误以为已经是完整 tail
    if (data.partial === 'bytes_truncated') {
      combined = `⚠ 后端命中 2 MiB 上限,仅展示前 2 MiB,之后内容已截断。\n────\n${combined}`
    } else if (data.partial === 'stream_error') {
      combined = `⚠ docker logs 流中途报错,以下内容不完整。\n────\n${combined}`
    }
    nowBody.textContent = combined
    nowBody.scrollTop = nowBody.scrollHeight
  } catch (e) {
    if (mySeq !== LOGS_MODAL_STATE.loadSeq) return
    const nowBody = $('lg-body')
    if (nowBody) nowBody.textContent = `加载失败:${e.message}`
  }
}

// ─── Tab: Ledger ───────────────────────────────────────────────────
//
// P1-5: 后端有 keyset 游标(`before` = 上一页最小 id)+ from/to 时间范围 +
// LEDGER_MAX_LIMIT=500 + .csv 导出。前端复用 ORDERS_STATE 的"加载更多"模式。

const LEDGER_STATE = {
  renderSeq: 0,
  loadSeq: 0,
  rows: [],
  nextBefore: null, // 上一页返回的 next_before,本批 query 的 ?before=
  done: false,
  userId: '',
  reason: '',
  from: '', // ISO 字符串(toISOString 后),空字符串表示不过滤
  to: '',
}
const LEDGER_PAGE_SIZE = 50

/** 把 <input type="datetime-local"> 的本地值(YYYY-MM-DDTHH:mm)转 ISO,空串透传。 */
function _datetimeLocalToIso(v) {
  if (!v) return ''
  const d = new Date(v) // 浏览器按本地时区解析 datetime-local
  return Number.isFinite(d.getTime()) ? d.toISOString() : ''
}
/** ISO → datetime-local 显示值(本地时间)。 */
function _isoToDatetimeLocal(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

async function renderLedgerTab() {
  const mySeq = ++LEDGER_STATE.renderSeq

  LEDGER_STATE.userId = sessionStorage.getItem('admin_ledger_user') || ''
  let reason = sessionStorage.getItem('admin_ledger_reason') || ''
  // sessionStorage 残留的 reason 可能来自旧版本(白名单变更)。不认的清掉。
  if (reason && !LEDGER_REASONS.includes(reason)) {
    reason = ''
    sessionStorage.removeItem('admin_ledger_reason')
  }
  LEDGER_STATE.reason = reason
  LEDGER_STATE.from = sessionStorage.getItem('admin_ledger_from') || ''
  LEDGER_STATE.to = sessionStorage.getItem('admin_ledger_to') || ''
  LEDGER_STATE.rows = []
  LEDGER_STATE.nextBefore = null
  LEDGER_STATE.done = false

  view().innerHTML = `
    <div class="panel">
      <h2>积分流水 <small id="l-count">加载中…</small></h2>
      <div class="toolbar" style="flex-wrap:wrap;gap:var(--s-2)">
        <input type="text" id="l-uid" placeholder="user_id 过滤" value="${escapeHtml(LEDGER_STATE.userId)}" />
        <select id="l-reason">
          <option value="">全部 reason</option>
          ${LEDGER_REASONS.map((r) =>
            `<option value="${r}" ${LEDGER_STATE.reason === r ? 'selected' : ''}>${LEDGER_REASON_LABELS[r]}</option>`).join('')}
        </select>
        <label style="display:flex;gap:var(--s-1);align-items:center;font-size:12px;opacity:0.85">
          从 <input type="datetime-local" id="l-from" value="${escapeHtml(_isoToDatetimeLocal(LEDGER_STATE.from))}" />
        </label>
        <label style="display:flex;gap:var(--s-1);align-items:center;font-size:12px;opacity:0.85">
          至 <input type="datetime-local" id="l-to" value="${escapeHtml(_isoToDatetimeLocal(LEDGER_STATE.to))}" />
        </label>
        <button class="btn btn-primary" id="l-go">查询</button>
        <button class="btn" id="l-clear">清空</button>
        <button class="btn" id="l-csv" title="导出当前过滤条件下最多 50000 行 CSV">导出 CSV</button>
      </div>
      <div id="l-table-container"><div class="skeleton-row"><div class="skeleton-bar w60"></div></div></div>
      <div id="l-load-more" style="margin-top:var(--s-3);display:none;text-align:center;">
        <button class="btn" id="l-load-more-btn">加载更多</button>
      </div>
    </div>
  `

  $('l-go').addEventListener('click', () => {
    sessionStorage.setItem('admin_ledger_user', $('l-uid').value.trim())
    sessionStorage.setItem('admin_ledger_reason', $('l-reason').value)
    const fromIso = _datetimeLocalToIso($('l-from').value)
    const toIso = _datetimeLocalToIso($('l-to').value)
    if (fromIso) sessionStorage.setItem('admin_ledger_from', fromIso)
    else sessionStorage.removeItem('admin_ledger_from')
    if (toIso) sessionStorage.setItem('admin_ledger_to', toIso)
    else sessionStorage.removeItem('admin_ledger_to')
    applyHash()
  })
  $('l-clear').addEventListener('click', () => {
    sessionStorage.removeItem('admin_ledger_user')
    sessionStorage.removeItem('admin_ledger_reason')
    sessionStorage.removeItem('admin_ledger_from')
    sessionStorage.removeItem('admin_ledger_to')
    applyHash()
  })
  $('l-load-more-btn').addEventListener('click', async (ev) => {
    await withBtnLoading(ev.currentTarget, () => _loadMoreLedger(mySeq))
  })
  $('l-csv').addEventListener('click', async (ev) => {
    await withBtnLoading(ev.currentTarget, () => _exportLedgerCsv())
  })

  await _loadMoreLedger(mySeq)
}

async function _loadMoreLedger(renderSeq) {
  if (LEDGER_STATE.done) return
  const myLoadSeq = ++LEDGER_STATE.loadSeq

  const sp = new URLSearchParams({ limit: String(LEDGER_PAGE_SIZE) })
  if (LEDGER_STATE.userId) sp.set('user_id', LEDGER_STATE.userId)
  if (LEDGER_STATE.reason) sp.set('reason', LEDGER_STATE.reason)
  if (LEDGER_STATE.from) sp.set('from', LEDGER_STATE.from)
  if (LEDGER_STATE.to) sp.set('to', LEDGER_STATE.to)
  if (LEDGER_STATE.nextBefore) sp.set('before', LEDGER_STATE.nextBefore)

  const isFirstPage = LEDGER_STATE.rows.length === 0 && !LEDGER_STATE.nextBefore

  let data
  try {
    data = await apiGet(`/api/admin/ledger?${sp.toString()}`)
  } catch (err) {
    if (renderSeq !== LEDGER_STATE.renderSeq || _currentTab !== 'ledger') return
    if (myLoadSeq !== LEDGER_STATE.loadSeq) return
    if (isFirstPage) {
      const tc = $('l-table-container')
      if (tc) tc.innerHTML = `<div class="empty" style="color:var(--danger)">加载失败:${escapeHtml(err.message || String(err))}</div>`
      const lm = $('l-load-more'); if (lm) lm.style.display = 'none'
    } else {
      toast(`加载失败:${err.message}`, 'danger', toastOptsFromError(err))
    }
    return
  }
  if (renderSeq !== LEDGER_STATE.renderSeq || _currentTab !== 'ledger') return
  if (myLoadSeq !== LEDGER_STATE.loadSeq) return

  const newRows = data?.rows ?? []
  LEDGER_STATE.rows.push(...newRows)
  LEDGER_STATE.nextBefore = data?.next_before ?? null
  if (!LEDGER_STATE.nextBefore) LEDGER_STATE.done = true

  _renderLedgerTable()
}

function _renderLedgerTable() {
  const cnt = $('l-count')
  if (cnt) cnt.textContent = `共 ${LEDGER_STATE.rows.length} 条${LEDGER_STATE.done ? '' : '+'}`
  const tc = $('l-table-container')
  if (!tc) return

  const rows = LEDGER_STATE.rows
  if (rows.length === 0) {
    tc.innerHTML = '<div class="empty">无记录</div>'
  } else {
    tc.innerHTML = `
      <table class="data">
        <thead>
          <tr><th>id</th><th>用户</th><th>delta</th><th>余额</th>
              <th>reason</th><th>渠道</th><th>模型</th><th>memo</th><th>时间</th></tr>
        </thead>
        <tbody>
          ${rows.map((r) => {
            const negative = String(r.delta).startsWith('-')
            const model = r.model || '—'
            return `
            <tr>
              <td class="mono">${escapeHtml(r.id)}</td>
              <td class="mono">${escapeHtml(r.user_id)}</td>
              <td class="num" style="color:${negative ? 'var(--danger)' : 'var(--ok)'}">
                ${fmtCents(r.delta)}
              </td>
              <td class="num">${fmtCents(r.balance_after)}</td>
              <td><span class="badge muted">${escapeHtml(LEDGER_REASON_LABELS[r.reason] || r.reason)}</span></td>
              <td>${ledgerChannelBadge(r.channel)}</td>
              <td class="mono" title="${escapeHtml(model)}">${escapeHtml(model)}</td>
              <td>${escapeHtml(r.memo || '')}</td>
              <td class="mono">${fmtDate(r.created_at)}</td>
            </tr>`
          }).join('')}
        </tbody>
      </table>`
  }

  const lm = $('l-load-more')
  if (lm) lm.style.display = LEDGER_STATE.done ? 'none' : 'block'
}

async function _exportLedgerCsv() {
  const sp = new URLSearchParams()
  if (LEDGER_STATE.userId) sp.set('user_id', LEDGER_STATE.userId)
  if (LEDGER_STATE.reason) sp.set('reason', LEDGER_STATE.reason)
  if (LEDGER_STATE.from) sp.set('from', LEDGER_STATE.from)
  if (LEDGER_STATE.to) sp.set('to', LEDGER_STATE.to)
  // 用 apiFetch 走 401→refresh→retry 路径,不能 window.open(token 在 Authorization
  // header,不在 cookie 里)。一次性内存读 ≤ 50k 行 CSV(~10MB)再触发下载。
  let res
  try {
    res = await apiFetch(`/api/admin/ledger.csv?${sp.toString()}`, { headers: authHeaders() })
  } catch (e) {
    toast(`导出失败:${e.message}`, 'danger', toastOptsFromError(e))
    return
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try { const j = await res.json(); msg = j?.error?.message || msg } catch {}
    toast(`导出失败:${msg}`, 'danger')
    return
  }
  const blob = await res.blob()
  // Content-Disposition filename 已由后端给出,但 a.download 也要赋值 — 浏览器
  // 没有 server-driven filename 接口,只能从 header 抠或本地生成。后端格式稳定,
  // 这里直接重生成同样的文件名。
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `ledger-${stamp}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 等异步触发后再 revoke,Safari/Firefox 立即 revoke 会让下载半路失败
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
  toast('CSV 已开始下载')
}

// ─── Tab: Orders (P0-3 订单管理)──────────────────────────────────
//
// 后端:
//   GET /api/admin/orders?status&user_id&from&to&before_created_at&before_id&limit
//   GET /api/admin/orders/:order_no            → 详情(含 callback_payload)
//   GET /api/admin/orders/kpi                  → 顶部 KPI 卡片
//
// 前端:status / user_id 过滤 + 复合游标翻页;异常状态(expired / refunded /
// canceled)行高亮;详情 modal 显示完整 callback_payload(支付方原始回调)用于排查。
//
// 缓存 in-memory(切 tab 不保留)— 翻页参数在 sessionStorage 持久化以便回到 tab
// 时回到上次的过滤状态(与 ledger tab 一致)。

const ORDER_STATUSES = ['pending', 'paid', 'expired', 'refunded', 'canceled']
const ORDER_STATUS_LABELS = {
  pending:  '待支付',
  paid:     '已支付',
  expired:  '已过期',
  refunded: '已退款',
  canceled: '已取消',
}
function _orderStatusBadge(s) {
  const cls = s === 'paid' ? 'ok'
    : s === 'pending' ? 'warn'
    : (s === 'expired' || s === 'refunded' || s === 'canceled') ? 'danger'
    : 'muted'
  return `<span class="badge ${cls}">${escapeHtml(ORDER_STATUS_LABELS[s] || s)}</span>`
}

// 复合游标分页状态(沿用 USERS_STATE 模式)
const ORDERS_STATE = {
  renderSeq: 0,
  loadSeq: 0,
  rows: [],
  nextBeforeCreatedAt: null,
  nextBeforeId: null,
  status: '',
  userId: '',
  done: false,
}
const ORDERS_PAGE_SIZE = 50

async function renderOrdersTab() {
  const mySeq = ++ORDERS_STATE.renderSeq

  // 过滤参数:status (sessionStorage 持久化 — 仪表盘 KPI 卡片可预过滤)、user_id
  ORDERS_STATE.status = sessionStorage.getItem('admin_orders_status') || ''
  if (ORDERS_STATE.status && !ORDER_STATUSES.includes(ORDERS_STATE.status)) {
    sessionStorage.removeItem('admin_orders_status')
    ORDERS_STATE.status = ''
  }
  ORDERS_STATE.userId = sessionStorage.getItem('admin_orders_user') || ''
  ORDERS_STATE.rows = []
  ORDERS_STATE.nextBeforeCreatedAt = null
  ORDERS_STATE.nextBeforeId = null
  ORDERS_STATE.done = false

  view().innerHTML = `
    <div class="panel">
      <h2>订单 <small id="o-count">加载中…</small></h2>
      <div id="o-kpis"></div>
      <div class="toolbar">
        <select id="o-status">
          <option value="">全部状态</option>
          ${ORDER_STATUSES.map((s) =>
            `<option value="${s}" ${ORDERS_STATE.status === s ? 'selected' : ''}>${ORDER_STATUS_LABELS[s]}</option>`).join('')}
        </select>
        <input type="text" id="o-uid" placeholder="user_id 过滤" value="${escapeHtml(ORDERS_STATE.userId)}" />
        <button class="btn btn-primary" id="o-go">查询</button>
        <button class="btn" id="o-clear">清空过滤</button>
      </div>
      <div id="o-table-container"><div class="skeleton-row"><div class="skeleton-bar w60"></div></div></div>
      <div id="o-load-more" style="margin-top:var(--s-3);display:none;text-align:center;">
        <button class="btn" id="o-load-more-btn">加载更多</button>
      </div>
    </div>
  `

  $('o-go').addEventListener('click', () => {
    const newStatus = $('o-status').value
    const newUid = $('o-uid').value.trim()
    if (newStatus) sessionStorage.setItem('admin_orders_status', newStatus)
    else sessionStorage.removeItem('admin_orders_status')
    if (newUid) sessionStorage.setItem('admin_orders_user', newUid)
    else sessionStorage.removeItem('admin_orders_user')
    applyHash()
  })
  $('o-clear').addEventListener('click', () => {
    sessionStorage.removeItem('admin_orders_status')
    sessionStorage.removeItem('admin_orders_user')
    applyHash()
  })
  $('o-load-more-btn').addEventListener('click', async (ev) => {
    await withBtnLoading(ev.currentTarget, () => _loadMoreOrders(mySeq))
  })

  // KPI 独立失败,不阻塞列表
  apiGet('/api/admin/orders/kpi').then((r) => {
    if (mySeq !== ORDERS_STATE.renderSeq || _currentTab !== 'orders') return
    _renderOrdersKpiStrip(r?.kpi || null)
  }).catch(() => { /* KPI 拉失败保持空 */ })

  await _loadMoreOrders(mySeq)
}

function _renderOrdersKpiStrip(kpi) {
  const el = $('o-kpis')
  if (!el) return
  if (!kpi) { el.innerHTML = ''; return }
  el.innerHTML = `
    <div class="toolbar" style="gap:var(--s-3);flex-wrap:wrap;">
      <span class="stat-chip ${kpi.pending_overdue_24h > 0 ? 'warn' : 'ok'}">
        24h 卡单 · <b>${kpi.pending_overdue_24h}</b>
      </span>
      <span class="stat-chip ${kpi.pending_overdue > 0 ? 'warn' : 'ok'}">
        累计卡单 · <b>${kpi.pending_overdue}</b>
      </span>
      <span class="stat-chip ${kpi.callback_conflicts_24h > 0 ? 'danger' : 'ok'}">
        24h 回调冲突 · <b>${kpi.callback_conflicts_24h}</b>
      </span>
      <span class="stat-chip ok">
        24h 已付 · <b>${kpi.paid_24h_count}</b>
        <span style="opacity:0.7">(${fmtCents(kpi.paid_24h_amount_cents)})</span>
      </span>
    </div>`
}

async function _loadMoreOrders(renderSeq) {
  if (ORDERS_STATE.done) return
  const myLoadSeq = ++ORDERS_STATE.loadSeq

  const sp = new URLSearchParams({ limit: String(ORDERS_PAGE_SIZE) })
  if (ORDERS_STATE.status) sp.set('status', ORDERS_STATE.status)
  if (ORDERS_STATE.userId) sp.set('user_id', ORDERS_STATE.userId)
  if (ORDERS_STATE.nextBeforeCreatedAt) sp.set('before_created_at', ORDERS_STATE.nextBeforeCreatedAt)
  if (ORDERS_STATE.nextBeforeId) sp.set('before_id', ORDERS_STATE.nextBeforeId)

  const isFirstPage = ORDERS_STATE.rows.length === 0 && !ORDERS_STATE.nextBeforeId

  let data
  try {
    data = await apiGet(`/api/admin/orders?${sp.toString()}`)
  } catch (err) {
    if (renderSeq !== ORDERS_STATE.renderSeq || _currentTab !== 'orders') return
    if (myLoadSeq !== ORDERS_STATE.loadSeq) return
    if (isFirstPage) {
      const tc = $('o-table-container')
      if (tc) tc.innerHTML = `<div class="empty" style="color:var(--danger)">加载失败:${escapeHtml(err.message || String(err))}</div>`
      const lm = $('o-load-more'); if (lm) lm.style.display = 'none'
    } else {
      toast(`加载失败:${err.message}`, 'danger', toastOptsFromError(err))
    }
    return
  }
  if (renderSeq !== ORDERS_STATE.renderSeq || _currentTab !== 'orders') return
  if (myLoadSeq !== ORDERS_STATE.loadSeq) return

  const newRows = data?.rows ?? []
  ORDERS_STATE.rows.push(...newRows)
  ORDERS_STATE.nextBeforeCreatedAt = data?.next_before_created_at ?? null
  ORDERS_STATE.nextBeforeId = data?.next_before_id ?? null
  if (!ORDERS_STATE.nextBeforeCreatedAt || !ORDERS_STATE.nextBeforeId) ORDERS_STATE.done = true

  _renderOrdersTable()
}

function _renderOrdersTable() {
  const cnt = $('o-count')
  if (cnt) cnt.textContent = `共 ${ORDERS_STATE.rows.length} 条${ORDERS_STATE.done ? '' : '+'}`
  const tc = $('o-table-container')
  if (!tc) return

  const rows = ORDERS_STATE.rows
  if (rows.length === 0) {
    tc.innerHTML = '<div class="empty">无订单</div>'
  } else {
    tc.innerHTML = `
      <table class="data">
        <thead>
          <tr>
            <th>order_no</th><th>用户</th><th>provider</th>
            <th class="num">金额</th><th class="num">积分</th>
            <th>状态</th><th>paid_at</th><th>created_at</th>
            <th class="actions">操作</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => {
            // 异常状态行加底色提示
            const rowCls = (r.status === 'expired' || r.status === 'refunded' || r.status === 'canceled')
              ? ' style="background:rgba(220,80,80,0.06)"' : ''
            const userLabel = r.username
              ? `${escapeHtml(r.username)} <code style="opacity:0.6">#${escapeHtml(r.user_id)}</code>`
              : `<code>#${escapeHtml(r.user_id)}</code>`
            return `
            <tr${rowCls}>
              <td class="mono">${escapeHtml(r.order_no)}</td>
              <td>${userLabel}</td>
              <td><span class="badge muted">${escapeHtml(r.provider)}</span></td>
              <td class="num">${fmtCents(r.amount_cents)}</td>
              <td class="num">${escapeHtml(r.credits)}</td>
              <td>${_orderStatusBadge(r.status)}</td>
              <td class="mono">${fmtDate(r.paid_at)}</td>
              <td class="mono">${fmtDate(r.created_at)}</td>
              <td class="actions">
                <button data-act="view-order" data-no="${escapeHtml(r.order_no)}">查看</button>
              </td>
            </tr>`
          }).join('')}
        </tbody>
      </table>`
  }

  const lm = $('o-load-more')
  if (lm) lm.style.display = ORDERS_STATE.done ? 'none' : 'block'

  for (const b of view().querySelectorAll('button[data-act="view-order"]')) {
    b.addEventListener('click', () => openOrderDetailModal(b.dataset.no))
  }
}

async function openOrderDetailModal(orderNo) {
  openModal(`<h3>订单 · ${escapeHtml(orderNo)}</h3>
    <div class="loading">加载中…</div>`)
  let data
  try {
    data = await apiGet(`/api/admin/orders/${encodeURIComponent(orderNo)}`)
  } catch (e) {
    openModal(`<h3>订单 · ${escapeHtml(orderNo)}</h3>
      <div class="empty" style="color:var(--danger)">加载失败:${escapeHtml(e.message || String(e))}</div>
      <div class="form-actions"><button id="o-close">关闭</button></div>`)
    $('o-close')?.addEventListener('click', closeModal)
    return
  }
  const o = data?.order
  if (!o) {
    openModal(`<h3>订单 · ${escapeHtml(orderNo)}</h3>
      <div class="empty">未找到该订单</div>
      <div class="form-actions"><button id="o-close">关闭</button></div>`)
    $('o-close')?.addEventListener('click', closeModal)
    return
  }

  // callback_payload 是支付方回调原文,排查异常时最关键 → JSON 美化展示
  const payloadText = o.callback_payload
    ? JSON.stringify(o.callback_payload, null, 2)
    : '(无 callback,可能未到账或还在 pending)'

  openModal(`
    <h3>订单 · ${escapeHtml(o.order_no)}</h3>
    <div class="form-row">
      <label>状态</label>
      <div>${_orderStatusBadge(o.status)}</div>
    </div>
    <div class="form-row">
      <label>用户</label>
      <div>${o.username ? `${escapeHtml(o.username)} ` : ''}<code>#${escapeHtml(o.user_id)}</code></div>
    </div>
    <div class="form-row">
      <label>支付通道</label>
      <div><span class="badge muted">${escapeHtml(o.provider)}</span>
           ${o.provider_order ? `<code style="margin-left:8px">${escapeHtml(o.provider_order)}</code>` : ''}</div>
    </div>
    <div class="form-row">
      <label>金额 / 积分</label>
      <div>${fmtCents(o.amount_cents)} → ${escapeHtml(o.credits)} 积分</div>
    </div>
    <div class="form-row">
      <label>时间</label>
      <div class="mono" style="font-size:12px">
        created: ${fmtDate(o.created_at)}<br>
        paid:    ${fmtDate(o.paid_at)}<br>
        expires: ${fmtDate(o.expires_at)}<br>
        updated: ${fmtDate(o.updated_at)}
      </div>
    </div>
    ${o.ledger_id ? `
      <div class="form-row">
        <label>积分流水</label>
        <div><code>#${escapeHtml(o.ledger_id)}</code>${o.refunded_ledger_id ? ` · 退款 <code>#${escapeHtml(o.refunded_ledger_id)}</code>` : ''}</div>
      </div>` : ''}
    <div class="form-row">
      <label>callback_payload</label>
      <pre class="mono" style="background:var(--bg-2);padding:var(--s-3);border-radius:6px;
           max-height:280px;overflow:auto;font-size:11px;line-height:1.5;">${escapeHtml(payloadText)}</pre>
    </div>
    <div class="form-actions">
      <button id="o-close">关闭</button>
    </div>
  `)
  $('o-close')?.addEventListener('click', closeModal)
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
                          data-enabled="${p.enabled ? '1' : '0'}"
                          data-extra="${escapeHtml(p.extra_system_prompt ?? '')}">编辑</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>`}
    </div>
  `
  for (const b of view().querySelectorAll('button[data-act="edit-pricing"]')) {
    b.addEventListener('click', () =>
      openEditPricingModal(b.dataset.id, b.dataset.mult, b.dataset.enabled === '1', b.dataset.extra ?? ''))
  }
}

function openEditPricingModal(modelId, multiplier, enabled, extraSystemPrompt) {
  openModal(`
    <h3>编辑定价 · ${escapeHtml(modelId)}</h3>
    <div class="form-row">
      <label>multiplier(decimal,例如 2.000)</label>
      <input type="text" id="p-mult" value="${escapeHtml(multiplier)}" />
    </div>
    <div class="form-row">
      <label><input type="checkbox" id="p-enabled" ${enabled ? 'checked' : ''} /> 启用</label>
    </div>
    <div class="form-row">
      <label>extra_system_prompt(per-model 行为补丁)</label>
      <textarea id="p-extra" rows="4" maxlength="4096"
                placeholder="留空=不注入。例:完成一个步骤后,不要 yield,继续推进至全部目标完成">${escapeHtml(extraSystemPrompt)}</textarea>
      <small class="muted">作为 system prompt 注入到 extra-prompt.md 末尾,与 persona/tools/research 冲突时以后置优先级为准。修改仅对<b>新 spawn</b>的 CCB/codex 生效,运行中的会话不会被换文案。上限 4096 字。</small>
    </div>
    <div class="form-actions">
      <button id="p-cancel">取消</button>
      <button class="btn-primary" id="p-ok">保存</button>
    </div>
  `)
  $('p-cancel').addEventListener('click', closeModal)
  $('p-ok').addEventListener('click', async (ev) => {
    const m = $('p-mult').value.trim()
    if (!/^\d+(\.\d{1,3})?$/.test(m)) { toast('multiplier 格式不对', 'danger'); return }
    // extra_system_prompt:trim 后空 → 显式发 null(清空);非空 → 原文(后端再 trim)
    const extraRaw = $('p-extra').value
    const extra = extraRaw.trim() === '' ? null : extraRaw
    await withBtnLoading(ev.currentTarget, async () => {
      try {
        await apiJson('PATCH', `/api/admin/pricing/${encodeURIComponent(modelId)}`,
          { multiplier: m, enabled: $('p-enabled').checked, extra_system_prompt: extra })
        toast('已保存')
        closeModal()
        applyHash()
      } catch (e) {
        toast(`失败: ${e.message}`, 'danger', toastOptsFromError(e))
      }
    })
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
            <tr><th>code</th><th>label</th><th>支付金额</th><th>到账余额</th>
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
    <div class="form-row"><label>amount_cents(支付金额,单位:分;¥1 = 100)</label>
      <input type="text" id="pl-amount" value="${escapeHtml(d.amount)}" /></div>
    <div class="form-row"><label>credits(到账余额,单位:分;¥1 = 100,可大于 amount 表赠送)</label>
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
  $('pl-ok').addEventListener('click', async (ev) => {
    await withBtnLoading(ev.currentTarget, async () => {
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
        toast(`失败: ${e.message}`, 'danger', toastOptsFromError(e))
      }
    })
  })
}

// ─── Tab: Model Grants(0049 模型可见性 / 用户级灰度授权)─────────
//
// 数据流:
//   1. GET /api/admin/pricing → 全部定价行(含 visibility)
//      visibility=public 不需要授权,所有人可见
//      visibility=admin  默认 admin 可见,普通用户需 grant
//      visibility=hidden 任何 role 都需 grant 才可见 / 才能用
//   2. 输入 user_email/uid → GET /api/admin/users?q=... 取 uid
//   3. GET /api/admin/users/:uid/model-grants → 当前 grants
//   4. POST /api/admin/users/:uid/model-grants { model_id } → 添加
//   5. DELETE /api/admin/users/:uid/model-grants/:model_id → 撤销
//
// 安全边界:不在前端做拦截,后端 canUseModel + WS bridge 双重校验。前端
// 只是 admin 的可视化操作面板。
//
// 简化:不分页(visibility=admin/hidden 模型在可见未来都不会很多,< 50 行)。

const MODEL_GRANTS_STATE = {
  selectedUid: '',     // 选中用户的 uid 字符串(后端 BIGINT)
  selectedEmail: '',   // 显示用
  pricingRows: null,   // 全量定价行(缓存,不随用户切换重拉)
  grantedSet: null,    // 当前选中用户已授权的 model_id Set
}

async function renderModelGrantsTab() {
  view().innerHTML = `
    <div class="panel">
      <h2>用户模型授权 <small>visibility = admin / hidden 的模型按用户灰度</small></h2>
      <div class="toolbar">
        <input type="text" id="mg-q" placeholder="用户邮箱 或 UID"
               value="${escapeHtml(MODEL_GRANTS_STATE.selectedEmail || '')}"
               style="min-width:240px;" />
        <button class="btn btn-primary" id="mg-search">查询</button>
        ${MODEL_GRANTS_STATE.selectedUid
          ? `<span style="color:var(--muted);font-size:13px;">当前:${escapeHtml(MODEL_GRANTS_STATE.selectedEmail)} (uid=${escapeHtml(MODEL_GRANTS_STATE.selectedUid)})</span>`
          : ''}
      </div>
      <div id="mg-body" style="margin-top:var(--s-3);">
        ${MODEL_GRANTS_STATE.selectedUid ? '<div class="loading">加载中…</div>' : '<div class="empty">输入用户邮箱或 UID 开始</div>'}
      </div>
    </div>
  `
  $('mg-search').addEventListener('click', _onModelGrantsSearch)
  $('mg-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') _onModelGrantsSearch() })

  if (MODEL_GRANTS_STATE.selectedUid) {
    await _loadAndRenderModelGrants()
  }
}

async function _onModelGrantsSearch() {
  const q = $('mg-q').value.trim()
  if (!q) { toast('输入邮箱或 UID', 'warn'); return }
  let uid = ''
  let email = ''
  // 纯数字按 uid 直查;否则当 email 模糊搜
  if (/^\d+$/.test(q)) {
    try {
      const detail = await apiGet(`/api/admin/users/${encodeURIComponent(q)}/detail`)
      uid = String(detail?.user?.id ?? q)
      email = detail?.user?.email ?? ''
    } catch (err) {
      toast(`找不到用户 uid=${q}: ${err.message}`, 'danger', toastOptsFromError(err))
      return
    }
  } else {
    try {
      const sp = new URLSearchParams({ q, limit: '5' })
      const data = await apiGet(`/api/admin/users?${sp.toString()}`)
      const rows = data?.rows ?? []
      const exact = rows.find((r) => (r.email || '').toLowerCase() === q.toLowerCase())
      const hit = exact || rows[0]
      if (!hit) { toast('未找到用户', 'warn'); return }
      uid = String(hit.id)
      email = hit.email || ''
    } catch (err) {
      toast(`查询失败: ${err.message}`, 'danger', toastOptsFromError(err))
      return
    }
  }
  MODEL_GRANTS_STATE.selectedUid = uid
  MODEL_GRANTS_STATE.selectedEmail = email
  await _loadAndRenderModelGrants()
  // 更新 toolbar 状态文字
  await renderModelGrantsTab()
}

async function _loadAndRenderModelGrants() {
  const uid = MODEL_GRANTS_STATE.selectedUid
  if (!uid) return
  const body = $('mg-body')
  if (body) body.innerHTML = '<div class="loading">加载中…</div>'

  try {
    // pricing 缓存:模型不会高频变,缓存到 STATE.pricingRows
    if (!MODEL_GRANTS_STATE.pricingRows) {
      const pr = await apiGet('/api/admin/pricing')
      MODEL_GRANTS_STATE.pricingRows = pr?.rows ?? []
    }
    const grantsResp = await apiGet(`/api/admin/users/${encodeURIComponent(uid)}/model-grants`)
    const granted = grantsResp?.rows ?? []
    MODEL_GRANTS_STATE.grantedSet = new Set(granted.map((g) => g.model_id))
  } catch (err) {
    if (body) body.innerHTML = `<div class="empty" style="color:var(--danger)">加载失败:${escapeHtml(err.message)}</div>`
    return
  }

  // 只展示需要授权的模型(visibility != public)。public 模型对所有用户可见,
  // 列出来无意义。
  const restricted = (MODEL_GRANTS_STATE.pricingRows || []).filter(
    (p) => (p.visibility || 'public') !== 'public',
  )
  const html = restricted.length === 0
    ? '<div class="empty">无受限模型(所有定价均为 visibility=public)</div>'
    : `<table class="data">
        <thead><tr>
          <th>model_id</th><th>显示名</th><th>visibility</th>
          <th>启用</th><th class="actions">授权</th>
        </tr></thead>
        <tbody>
          ${restricted.map((p) => {
            const isGranted = MODEL_GRANTS_STATE.grantedSet.has(p.model_id)
            return `<tr>
              <td class="mono">${escapeHtml(p.model_id)}</td>
              <td>${escapeHtml(p.display_name || '')}</td>
              <td>${escapeHtml(p.visibility || 'public')}</td>
              <td>${p.enabled ? '<span class="badge ok">on</span>' : '<span class="badge muted">off</span>'}</td>
              <td class="actions">
                <button data-act="${isGranted ? 'mg-revoke' : 'mg-grant'}"
                        data-model="${escapeHtml(p.model_id)}">
                  ${isGranted ? '撤销' : '授权'}
                </button>
              </td>
            </tr>`
          }).join('')}
        </tbody>
      </table>`
  if (body) body.innerHTML = html
  for (const b of view().querySelectorAll('button[data-act="mg-grant"], button[data-act="mg-revoke"]')) {
    b.addEventListener('click', async (ev) => {
      const modelId = b.dataset.model
      const action = b.dataset.act === 'mg-grant' ? 'grant' : 'revoke'
      await withBtnLoading(ev.currentTarget, () => _toggleModelGrant(modelId, action))
    })
  }
}

async function _toggleModelGrant(modelId, action) {
  const uid = MODEL_GRANTS_STATE.selectedUid
  if (!uid) return
  try {
    if (action === 'grant') {
      await apiJson('POST', `/api/admin/users/${encodeURIComponent(uid)}/model-grants`,
        { model_id: modelId })
      toast(`已授权 ${modelId}`)
    } else {
      await apiJson('DELETE', `/api/admin/users/${encodeURIComponent(uid)}/model-grants/${encodeURIComponent(modelId)}`, null)
      toast(`已撤销 ${modelId}`)
    }
    await _loadAndRenderModelGrants()
  } catch (err) {
    toast(`失败: ${err.message}`, 'danger', toastOptsFromError(err))
  }
}

// ─── Tab: Feedback (P1-2 用户反馈管理)──────────────────────────────
//
// 后端:
//   GET  /api/admin/feedback?status&user_id&before_created_at&before_id&limit
//   POST /api/admin/feedback/:id/ack            → 改 status=acked + admin_audit
//
// 前端:status / user_id 过滤 + 复合游标翻页;详情 modal 显示完整 description +
// meta(JSON pretty)+ 反查命令建议。
//
// 列表 UI 上明确区分 open / acked / closed:open 行高亮(运营要看到的)。

const FEEDBACK_STATUSES = ['open', 'acked', 'closed']
const FEEDBACK_STATUS_LABELS = {
  open:   '未处理',
  acked:  '已确认',
  closed: '已关闭',
}
function _feedbackStatusBadge(s) {
  const cls = s === 'open' ? 'warn'
    : s === 'acked' ? 'ok'
    : s === 'closed' ? 'muted'
    : 'muted'
  return `<span class="badge ${cls}">${escapeHtml(FEEDBACK_STATUS_LABELS[s] || s)}</span>`
}

// 复合游标分页状态(沿用 USERS_STATE / ORDERS_STATE 模式)
const FEEDBACK_STATE = {
  renderSeq: 0,
  loadSeq: 0,
  rows: [],
  nextBeforeCreatedAt: null,
  nextBeforeId: null,
  status: '',
  userId: '',
  done: false,
}
const FEEDBACK_PAGE_SIZE = 50

async function renderFeedbackTab() {
  const mySeq = ++FEEDBACK_STATE.renderSeq

  FEEDBACK_STATE.status = sessionStorage.getItem('admin_feedback_status') || ''
  if (FEEDBACK_STATE.status && !FEEDBACK_STATUSES.includes(FEEDBACK_STATE.status)) {
    sessionStorage.removeItem('admin_feedback_status')
    FEEDBACK_STATE.status = ''
  }
  FEEDBACK_STATE.userId = sessionStorage.getItem('admin_feedback_user') || ''
  FEEDBACK_STATE.rows = []
  FEEDBACK_STATE.nextBeforeCreatedAt = null
  FEEDBACK_STATE.nextBeforeId = null
  FEEDBACK_STATE.done = false

  view().innerHTML = `
    <div class="panel">
      <h2>用户反馈 <small id="f-count">加载中…</small></h2>
      <div class="toolbar">
        <select id="f-status">
          <option value="">全部状态</option>
          ${FEEDBACK_STATUSES.map((s) =>
            `<option value="${s}" ${FEEDBACK_STATE.status === s ? 'selected' : ''}>${FEEDBACK_STATUS_LABELS[s]}</option>`).join('')}
        </select>
        <input type="text" id="f-uid" placeholder="user_id 过滤" value="${escapeHtml(FEEDBACK_STATE.userId)}" />
        <button class="btn btn-primary" id="f-go">查询</button>
        <button class="btn" id="f-clear">清空过滤</button>
      </div>
      <div id="f-table-container"><div class="skeleton-row"><div class="skeleton-bar w60"></div></div></div>
      <div id="f-load-more" style="margin-top:var(--s-3);display:none;text-align:center;">
        <button class="btn" id="f-load-more-btn">加载更多</button>
      </div>
    </div>
  `

  $('f-go').addEventListener('click', () => {
    const newStatus = $('f-status').value
    const newUid = $('f-uid').value.trim()
    if (newStatus) sessionStorage.setItem('admin_feedback_status', newStatus)
    else sessionStorage.removeItem('admin_feedback_status')
    if (newUid) sessionStorage.setItem('admin_feedback_user', newUid)
    else sessionStorage.removeItem('admin_feedback_user')
    applyHash()
  })
  $('f-clear').addEventListener('click', () => {
    sessionStorage.removeItem('admin_feedback_status')
    sessionStorage.removeItem('admin_feedback_user')
    applyHash()
  })
  $('f-load-more-btn').addEventListener('click', async (ev) => {
    await withBtnLoading(ev.currentTarget, () => _loadMoreFeedback(mySeq))
  })

  await _loadMoreFeedback(mySeq)
}

async function _loadMoreFeedback(renderSeq) {
  if (FEEDBACK_STATE.done) return
  const myLoadSeq = ++FEEDBACK_STATE.loadSeq

  const sp = new URLSearchParams({ limit: String(FEEDBACK_PAGE_SIZE) })
  if (FEEDBACK_STATE.status) sp.set('status', FEEDBACK_STATE.status)
  if (FEEDBACK_STATE.userId) sp.set('user_id', FEEDBACK_STATE.userId)
  if (FEEDBACK_STATE.nextBeforeCreatedAt) sp.set('before_created_at', FEEDBACK_STATE.nextBeforeCreatedAt)
  if (FEEDBACK_STATE.nextBeforeId) sp.set('before_id', FEEDBACK_STATE.nextBeforeId)

  const isFirstPage = FEEDBACK_STATE.rows.length === 0 && !FEEDBACK_STATE.nextBeforeId

  let data
  try {
    data = await apiGet(`/api/admin/feedback?${sp.toString()}`)
  } catch (err) {
    if (renderSeq !== FEEDBACK_STATE.renderSeq || _currentTab !== 'feedback') return
    if (myLoadSeq !== FEEDBACK_STATE.loadSeq) return
    if (isFirstPage) {
      const tc = $('f-table-container')
      if (tc) tc.innerHTML = `<div class="empty" style="color:var(--danger)">加载失败:${escapeHtml(err.message || String(err))}</div>`
      const lm = $('f-load-more'); if (lm) lm.style.display = 'none'
    } else {
      toast(`加载失败:${err.message}`, 'danger', toastOptsFromError(err))
    }
    return
  }
  if (renderSeq !== FEEDBACK_STATE.renderSeq || _currentTab !== 'feedback') return
  if (myLoadSeq !== FEEDBACK_STATE.loadSeq) return

  const newRows = data?.rows ?? []
  FEEDBACK_STATE.rows.push(...newRows)
  FEEDBACK_STATE.nextBeforeCreatedAt = data?.next_before_created_at ?? null
  FEEDBACK_STATE.nextBeforeId = data?.next_before_id ?? null
  if (!FEEDBACK_STATE.nextBeforeCreatedAt || !FEEDBACK_STATE.nextBeforeId) FEEDBACK_STATE.done = true

  _renderFeedbackTable()
}

function _renderFeedbackTable() {
  const rows = FEEDBACK_STATE.rows
  const openCount = rows.filter((r) => r.status === 'open').length
  const cnt = $('f-count')
  if (cnt) {
    cnt.innerHTML = `共 ${rows.length} 条${FEEDBACK_STATE.done ? '' : '+'}` +
      (openCount > 0 ? ` · <span style="color:var(--warn)">${openCount} 条未处理</span>` : '')
  }
  const tc = $('f-table-container')
  if (!tc) return

  if (rows.length === 0) {
    tc.innerHTML = '<div class="empty">无反馈</div>'
  } else {
    tc.innerHTML = `
      <table class="data">
        <thead>
          <tr>
            <th>id</th><th>created_at</th><th>用户</th>
            <th>category</th><th>描述</th><th>request_id</th>
            <th>version</th><th>状态</th>
            <th class="actions">操作</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => {
            const rowCls = r.status === 'open' ? ' style="background:rgba(232,182,76,0.06)"' : ''
            const userLabel = r.user_id
              ? (r.username
                  ? `${escapeHtml(r.username)} <code style="opacity:0.6">#${escapeHtml(r.user_id)}</code>`
                  : `<code>#${escapeHtml(r.user_id)}</code>`)
              : '<span style="opacity:0.6">匿名</span>'
            const desc = r.description.length > 80
              ? escapeHtml(r.description.slice(0, 80)) + '…'
              : escapeHtml(r.description)
            const ackBtn = r.status === 'open'
              ? `<button data-act="ack-feedback" data-id="${escapeHtml(r.id)}" class="btn-primary">确认</button>`
              : ''
            return `
            <tr${rowCls}>
              <td class="mono">${escapeHtml(r.id)}</td>
              <td class="mono">${fmtDate(r.created_at)}</td>
              <td>${userLabel}</td>
              <td><span class="badge muted">${escapeHtml(r.category)}</span></td>
              <td title="${escapeHtml(r.description)}" style="max-width:380px">${desc}</td>
              <td class="mono" style="font-size:11px">${escapeHtml((r.request_id || '').slice(0, 12))}${r.request_id && r.request_id.length > 12 ? '…' : ''}</td>
              <td class="mono" style="font-size:11px">${escapeHtml(r.version || '—')}</td>
              <td>${_feedbackStatusBadge(r.status)}</td>
              <td class="actions">
                <button data-act="view-feedback" data-id="${escapeHtml(r.id)}">查看</button>
                ${ackBtn}
              </td>
            </tr>`
          }).join('')}
        </tbody>
      </table>`
  }

  const lm = $('f-load-more')
  if (lm) lm.style.display = FEEDBACK_STATE.done ? 'none' : 'block'

  // 内存缓存当前累积 rows,modal 直接读不再多发一次请求
  const rowMap = new Map(rows.map((r) => [r.id, r]))

  for (const b of view().querySelectorAll('button[data-act="view-feedback"]')) {
    b.addEventListener('click', () => openFeedbackDetailModal(rowMap.get(b.dataset.id)))
  }
  for (const b of view().querySelectorAll('button[data-act="ack-feedback"]')) {
    b.addEventListener('click', async (ev) => {
      const id = b.dataset.id
      try {
        await withBtnLoading(ev.currentTarget, () =>
          apiJson('POST', `/api/admin/feedback/${encodeURIComponent(id)}/ack`, {}))
        toast(`已确认反馈 #${id}`, 'ok')
        applyHash() // 重新拉列表
      } catch (e) {
        toast(`确认失败: ${e.message}`, 'danger', toastOptsFromError(e))
      }
    })
  }
}

function openFeedbackDetailModal(r) {
  if (!r) return
  // meta JSON pretty;结合 request_id 给一个 grep 命令模板让运维直接复制
  const metaText = r.meta && Object.keys(r.meta).length > 0
    ? JSON.stringify(r.meta, null, 2)
    : '(无 meta)'
  const grepCmd = r.request_id
    ? `journalctl -u openclaude --since "1 hour ago" | grep "${r.request_id}"`
    : '# 此反馈无 request_id,无法 grep'

  openModal(`
    <h3>反馈 · #${escapeHtml(r.id)}</h3>
    <div class="form-row">
      <label>状态 / 时间</label>
      <div>${_feedbackStatusBadge(r.status)}
           <span class="mono" style="margin-left:8px;font-size:12px;opacity:0.7">${fmtDate(r.created_at)}</span>
           ${r.handled_by ? `<br><span style="font-size:12px;opacity:0.7">已由 admin <code>#${escapeHtml(r.handled_by)}</code> 于 ${fmtDate(r.handled_at)} 确认</span>` : ''}</div>
    </div>
    <div class="form-row">
      <label>用户</label>
      <div>${r.user_id
        ? (r.username
            ? `${escapeHtml(r.username)} <code style="opacity:0.6">#${escapeHtml(r.user_id)}</code>`
            : `<code>#${escapeHtml(r.user_id)}</code>`)
        : '<span style="opacity:0.6">匿名</span>'}</div>
    </div>
    <div class="form-row">
      <label>category</label>
      <div><span class="badge muted">${escapeHtml(r.category)}</span></div>
    </div>
    <div class="form-row">
      <label>描述</label>
      <pre class="mono" style="background:var(--bg-2);padding:var(--s-3);border-radius:6px;
           max-height:200px;overflow:auto;font-size:13px;line-height:1.5;
           white-space:pre-wrap;word-break:break-word;">${escapeHtml(r.description)}</pre>
    </div>
    <div class="form-row">
      <label>上下文</label>
      <div class="mono" style="font-size:12px">
        ${r.request_id ? `request_id: <code>${escapeHtml(r.request_id)}</code><br>` : ''}
        ${r.version    ? `version:    <code>${escapeHtml(r.version)}</code><br>` : ''}
        ${r.session_id ? `session_id: <code>${escapeHtml(r.session_id)}</code><br>` : ''}
        ${r.user_agent ? `UA:         ${escapeHtml(r.user_agent)}<br>` : ''}
      </div>
    </div>
    <div class="form-row">
      <label>meta(JSON)</label>
      <pre class="mono" style="background:var(--bg-2);padding:var(--s-3);border-radius:6px;
           max-height:240px;overflow:auto;font-size:11px;line-height:1.5;">${escapeHtml(metaText)}</pre>
    </div>
    <div class="form-row">
      <label>反查命令</label>
      <pre class="mono" style="background:var(--bg-2);padding:var(--s-3);border-radius:6px;
           font-size:11px;user-select:all;">${escapeHtml(grepCmd)}</pre>
    </div>
    <div class="form-actions">
      ${r.status === 'open'
        ? '<button id="f-modal-ack" class="btn-primary">确认</button>'
        : ''}
      <button id="f-modal-close">关闭</button>
    </div>
  `)
  $('f-modal-close')?.addEventListener('click', closeModal)
  if (r.status === 'open') {
    $('f-modal-ack')?.addEventListener('click', async (ev) => {
      try {
        await withBtnLoading(ev.currentTarget, () =>
          apiJson('POST', `/api/admin/feedback/${encodeURIComponent(r.id)}/ack`, {}))
        closeModal()
        toast(`已确认反馈 #${r.id}`, 'ok')
        applyHash()
      } catch (e) {
        toast(`确认失败: ${e.message}`, 'danger', toastOptsFromError(e))
      }
    })
  }
}

// ─── Tab: 站内信(in-app inbox)─────────────────────────────────────
//
// 端点(已审计 admin_audit:inbox.create / inbox.delete):
//   GET    /api/admin/messages?limit=20&offset=0     → { messages, total }
//   POST   /api/admin/messages  body=...             → 201 { message }
//   DELETE /api/admin/messages/:id                   → 200 { deleted: true }
//
// 表单字段:audience (all|user) / user_id (audience=user 必填) / title /
//   body_md (Markdown) / level (info|notice|promo|warning) / expires_at (可选)
//
// 列表默认 50 条,本 MVP 不做分页(发送频次低,日均 < 10);超过 50 条
// 再补 limit/offset toolbar。delete 是硬删,reads CASCADE 自动清。

const INBOX_LEVELS = ['info', 'notice', 'promo', 'warning']
const INBOX_LEVEL_LABELS = {
  info: '普通',
  notice: '通知',
  promo: '运营',
  warning: '警告',
}

async function renderInboxTab() {
  view().innerHTML = `
    <div class="panel">
      <h2>新建站内信 <small>admin 写入 → 用户铃铛实时拉取</small></h2>
      <div class="form-row">
        <label>收件范围</label>
        <select id="im-audience">
          <option value="all">全员广播</option>
          <option value="user">单个用户</option>
        </select>
      </div>
      <div class="form-row" id="im-user-row" style="display:none">
        <label>user_id</label>
        <input type="text" id="im-user-id" placeholder="例如 1234" inputmode="numeric" />
      </div>
      <div class="form-row">
        <label>标题</label>
        <input type="text" id="im-title" maxlength="200" placeholder="≤200 字" />
      </div>
      <div class="form-row">
        <label>正文 (Markdown)</label>
        <textarea id="im-body" rows="6" maxlength="16384" placeholder="支持完整 Markdown,最长 16KB"></textarea>
      </div>
      <div class="form-row">
        <label>级别</label>
        <select id="im-level">
          ${INBOX_LEVELS.map((l) => `<option value="${l}">${INBOX_LEVEL_LABELS[l]}</option>`).join('')}
        </select>
      </div>
      <div class="form-row">
        <label>过期时间</label>
        <input type="datetime-local" id="im-expires" />
        <small style="color:var(--muted);margin-left:8px">可选;留空则永不过期</small>
      </div>
      <div class="form-row" id="im-email-row">
        <label>邮件推送</label>
        <div>
          <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer">
            <input type="checkbox" id="im-notify-email" />
            <span>同时发邮件到用户邮箱(快照创建时刻 active+已验证 的用户)</span>
          </label>
          <div id="im-email-hint" style="margin-top:4px;font-size:12px;color:var(--muted)">加载中…</div>
        </div>
      </div>
      <div class="form-row">
        <button class="btn btn-primary" id="im-send">发送</button>
      </div>
    </div>
    <div class="panel" style="margin-top:var(--s-3)">
      <h2>历史消息 <small id="im-count">加载中…</small></h2>
      <div id="im-table-container"><div class="loading">加载中…</div></div>
    </div>
  `

  $('im-audience').addEventListener('change', _toggleInboxUserRow)
  $('im-send').addEventListener('click', _onInboxSend)
  // 探测邮件 worker 状态 —— 失败也继续渲染,只是 checkbox 不允许勾
  _probeInboxEmailConfig().catch(() => {})
  await _loadInboxList()
}

/**
 * 探测 /api/admin/messages/email-config,决定 checkbox 是否可勾 + 提示文案.
 * 后端 worker 关闭或 provider=stub 时显式提示,避免误以为已发真邮件.
 */
async function _probeInboxEmailConfig() {
  const cb = $('im-notify-email')
  const hint = $('im-email-hint')
  if (!cb || !hint) return
  try {
    const cfg = await apiGet('/api/admin/messages/email-config')
    if (cfg.enabled === false) {
      cb.disabled = true
      cb.checked = false
      hint.textContent = '邮件 worker 已禁用(COMMERCIAL_INBOX_EMAIL_DISABLED=1)。勾选无效。'
      hint.style.color = 'var(--danger)'
    } else if (cfg.provider === 'stub') {
      cb.disabled = false
      hint.textContent = '当前为 stub mailer(未配 RESEND_API_KEY),邮件只打日志,不真发出。'
      hint.style.color = 'var(--warn, #d97706)'
    } else {
      cb.disabled = false
      hint.textContent = `已启用,provider=${cfg.provider}。勾选后同事务锁定快照,异步发送。`
      hint.style.color = 'var(--muted)'
    }
  } catch (e) {
    cb.disabled = true
    hint.textContent = `探测邮件配置失败:${e.message || String(e)}`
    hint.style.color = 'var(--danger)'
  }
}

function _toggleInboxUserRow() {
  const row = $('im-user-row')
  if (!row) return
  row.style.display = $('im-audience').value === 'user' ? '' : 'none'
}

async function _onInboxSend(ev) {
  const audience = $('im-audience').value
  const title = $('im-title').value.trim()
  const body_md = $('im-body').value
  const level = $('im-level').value
  const expiresRaw = $('im-expires').value
  const userIdRaw = $('im-user-id').value.trim()

  if (!title) { toast('标题不能为空', 'danger'); return }
  if (!body_md.trim()) { toast('正文不能为空', 'danger'); return }
  if (audience === 'user' && !/^[1-9]\d{0,19}$/.test(userIdRaw)) {
    toast('user_id 必须是正整数', 'danger'); return
  }

  const payload = { audience, title, body_md, level }
  if (audience === 'user') payload.user_id = userIdRaw
  if (expiresRaw) {
    // datetime-local 是 'YYYY-MM-DDTHH:mm';转成带本地 TZ 的 ISO
    const d = new Date(expiresRaw)
    if (Number.isNaN(d.getTime())) { toast('过期时间格式不对', 'danger'); return }
    payload.expires_at = d.toISOString()
  }
  const notifyEmailCb = $('im-notify-email')
  if (notifyEmailCb && notifyEmailCb.checked && !notifyEmailCb.disabled) {
    payload.notify_email = true
  }

  try {
    const r = await withBtnLoading(ev.currentTarget, () =>
      apiJson('POST', '/api/admin/messages', payload))
    if (r?.message?.notify_email) {
      const t = r.message.email_summary?.total ?? 0
      toast(`已发送,邮件 worker 将异步发出 ${t} 封`, 'ok')
    } else {
      toast('已发送', 'ok')
    }
    // 清表单(audience / level / user_id / notify_email 保留方便连发)
    $('im-title').value = ''
    $('im-body').value = ''
    $('im-expires').value = ''
    await _loadInboxList()
  } catch (e) {
    toast(`发送失败: ${e.message}`, 'danger', toastOptsFromError(e))
  }
}

async function _loadInboxList() {
  const tc = $('im-table-container')
  if (!tc) return
  let data
  try {
    data = await apiGet('/api/admin/messages?limit=50')
  } catch (e) {
    tc.innerHTML = `<div class="empty" style="color:var(--danger)">加载失败:${escapeHtml(e.message || String(e))}</div>`
    return
  }
  const rows = data?.messages ?? []
  const total = data?.total ?? rows.length
  const cnt = $('im-count')
  if (cnt) cnt.textContent = `共 ${total} 条`

  if (rows.length === 0) {
    tc.innerHTML = '<div class="empty">暂无消息</div>'
    return
  }

  tc.innerHTML = `
    <table class="data">
      <thead>
        <tr>
          <th>id</th>
          <th>created_at</th>
          <th>范围</th>
          <th>级别</th>
          <th>标题</th>
          <th>过期</th>
          <th>已读 / 收件人</th>
          <th>邮件</th>
          <th class="actions">操作</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((r) => {
          const audLabel = r.audience === 'all'
            ? '<span class="badge muted">全员</span>'
            : `<span class="badge">单发 #${escapeHtml(r.user_id || '')}</span>`
          const expLabel = r.expires_at ? fmtDate(r.expires_at) : '<span style="opacity:0.5">永不</span>'
          const titlePreview = r.title.length > 40
            ? escapeHtml(r.title.slice(0, 40)) + '…'
            : escapeHtml(r.title)
          return `
            <tr>
              <td class="mono">${escapeHtml(r.id)}</td>
              <td class="mono">${fmtDate(r.created_at)}</td>
              <td>${audLabel}</td>
              <td><span class="badge">${INBOX_LEVEL_LABELS[r.level] || r.level}</span></td>
              <td title="${escapeHtml(r.title)}" style="max-width:300px">${titlePreview}</td>
              <td class="mono" style="font-size:12px">${expLabel}</td>
              <td class="mono">${escapeHtml(String(r.read_count))} / ${escapeHtml(String(r.recipients))}</td>
              <td>${_renderInboxEmailChip(r)}</td>
              <td class="actions">
                <button data-act="view-inbox" data-id="${escapeHtml(r.id)}">查看</button>
                <button data-act="del-inbox" data-id="${escapeHtml(r.id)}" class="btn-danger">删除</button>
              </td>
            </tr>`
        }).join('')}
      </tbody>
    </table>`

  const rowMap = new Map(rows.map((r) => [r.id, r]))
  for (const b of view().querySelectorAll('button[data-act="view-inbox"]')) {
    b.addEventListener('click', () => _openInboxDetail(rowMap.get(b.dataset.id)))
  }
  for (const b of view().querySelectorAll('button[data-act="del-inbox"]')) {
    b.addEventListener('click', async (ev) => {
      const id = b.dataset.id
      if (!confirm(`确认删除站内信 #${id}?所有用户的已读记录会一起清除。`)) return
      try {
        await withBtnLoading(ev.currentTarget, () =>
          apiJson('DELETE', `/api/admin/messages/${encodeURIComponent(id)}`, null))
        toast(`已删除 #${id}`, 'ok')
        await _loadInboxList()
      } catch (e) {
        toast(`删除失败: ${e.message}`, 'danger', toastOptsFromError(e))
      }
    })
  }
}

/**
 * 列表里的邮件状态徽章 — 紧凑显示 status + sent/total + tooltip 显示完整 summary.
 * 未启用 notify_email → "—" 静默.
 */
function _renderInboxEmailChip(r) {
  if (!r.notify_email) {
    return '<span style="opacity:0.4">—</span>'
  }
  const s = r.email_summary || { total: 0, sent: 0, failed: 0, interrupted: 0, dropped: 0 }
  const status = r.email_send_status || 'queued'
  const labelMap = {
    queued: { text: '排队中', color: '#3b82f6' },
    done: { text: '已发完', color: 'var(--ok, #16a34a)' },
    partial: { text: '部分失败', color: 'var(--warn, #d97706)' },
    interrupted: { text: '中断', color: 'var(--danger)' },
  }
  const lab = labelMap[status] || { text: status, color: 'var(--muted)' }
  const tip = [
    `total=${s.total}`,
    `sent=${s.sent}`,
    s.failed > 0 ? `failed=${s.failed}` : null,
    s.interrupted > 0 ? `interrupted=${s.interrupted}` : null,
    s.dropped > 0 ? `dropped=${s.dropped}` : null,
    r.email_sent_at ? `at=${r.email_sent_at}` : null,
  ].filter(Boolean).join(' / ')
  return `<span class="badge" title="${escapeHtml(tip)}" style="background:${lab.color};color:#fff">
    ${escapeHtml(lab.text)} ${escapeHtml(String(s.sent))}/${escapeHtml(String(s.total))}
  </span>`
}

function _openInboxDetail(r) {
  if (!r) return
  openModal(`
    <h3>站内信 · #${escapeHtml(r.id)}</h3>
    <div class="form-row">
      <label>范围 / 时间</label>
      <div>
        ${r.audience === 'all'
          ? '<span class="badge muted">全员</span>'
          : `<span class="badge">单发 #${escapeHtml(r.user_id || '')}</span>`}
        <span class="mono" style="margin-left:8px;font-size:12px;opacity:0.7">${fmtDate(r.created_at)}</span>
      </div>
    </div>
    <div class="form-row">
      <label>级别</label>
      <div><span class="badge">${INBOX_LEVEL_LABELS[r.level] || r.level}</span></div>
    </div>
    <div class="form-row">
      <label>过期</label>
      <div class="mono" style="font-size:12px">${r.expires_at ? fmtDate(r.expires_at) : '永不过期'}</div>
    </div>
    <div class="form-row">
      <label>已读 / 收件人</label>
      <div class="mono">${escapeHtml(String(r.read_count))} / ${escapeHtml(String(r.recipients))}</div>
    </div>
    ${r.notify_email ? `
    <div class="form-row">
      <label>邮件推送</label>
      <div>
        ${_renderInboxEmailChip(r)}
        <div class="mono" style="font-size:12px;margin-top:4px;opacity:0.7">
          status=${escapeHtml(r.email_send_status || 'queued')}
          ${r.email_sent_at ? '· sent_at=' + escapeHtml(fmtDate(r.email_sent_at)) : ''}
        </div>
      </div>
    </div>
    ` : ''}
    <div class="form-row">
      <label>标题</label>
      <div>${escapeHtml(r.title)}</div>
    </div>
    <div class="form-row">
      <label>正文 (Markdown 源码)</label>
      <pre style="white-space:pre-wrap;background:var(--panel-2);padding:8px;border-radius:6px;max-height:300px;overflow:auto;font-size:12px">${escapeHtml(r.body_md)}</pre>
    </div>
    <div class="form-row" style="justify-content:flex-end">
      <button class="btn" id="im-detail-close">关闭</button>
    </div>
  `)
  $('im-detail-close')?.addEventListener('click', closeModal)
}

// ─── Tab: Settings(4I)─────────────────────────────────────────────
//
// 渲染 GET /api/admin/settings 全 key 表单。每行独立 form,改完点 "保存"
// → PUT /api/admin/settings/:key,成功 toast + 局部刷新该行的 updated_at。
// 不做"批量保存" —— 单 key UPSERT 是 4H 设计,失败回滚也是单 key,简单清晰。
//
// 表单类型由 server 返的 meta.kind 决定:boolean / number / enum。
// description 字段(运营自由文本)单独一栏,所有 kind 共用。

async function renderSettingsTab() {
  const data = await apiGet('/api/admin/settings')
  const rows = data?.rows ?? []
  view().innerHTML = `
    <div class="panel">
      <h2>系统设置 <small>共 ${rows.length} 项 · 改完逐项 "保存" 立即生效</small></h2>
      <div style="color:var(--muted);font-size:12px;margin-bottom:12px">
        ⚠ 当前未生效 key(默认值)显示
        <span class="badge muted">默认</span>;改动一次后会持久化到 system_settings 表。
        所有改动会同事务写 admin_audit。
      </div>
      <table class="data">
        <thead>
          <tr><th>key</th><th>类型/范围</th><th>当前值</th><th>说明 description</th>
              <th>更新时间</th><th class="actions">操作</th></tr>
        </thead>
        <tbody>
          ${rows.map(_renderSettingRow).join('')}
        </tbody>
      </table>
    </div>
  `
  for (const btn of view().querySelectorAll('button[data-act="save-setting"]')) {
    btn.addEventListener('click', (ev) => saveSetting(btn.dataset.key, ev.currentTarget))
  }
}

function _renderSettingRow(r) {
  // 用 ${key} 而非 ${r.key} 与 saveSetting 里的 $(`set-${key}-value`) 对齐,
  // 让静态 DOM 完整性测试能匹配模板字符串里的 id 与 $() 引用。
  const key = r.key
  const meta = r.meta || {}
  const isDefault = r.is_default ? '<span class="badge muted">默认</span>' : ''
  let valueEditor
  if (meta.kind === 'boolean') {
    valueEditor = `
      <select id="set-${key}-value">
        <option value="true" ${r.value === true ? 'selected' : ''}>true</option>
        <option value="false" ${r.value === false ? 'selected' : ''}>false</option>
      </select>`
  } else if (meta.kind === 'enum') {
    valueEditor = `
      <select id="set-${key}-value">
        ${(meta.enumValues || []).map((v) =>
          `<option value="${escapeHtml(v)}" ${r.value === v ? 'selected' : ''}>${escapeHtml(v)}</option>`,
        ).join('')}
      </select>`
  } else if (meta.kind === 'string_array') {
    // 一行一个;saveSetting 按 \n / , split → trim → lowercase → filter empty,
    // server 端 zod 还会再二次校验每项是合法域名。
    const items = Array.isArray(r.value) ? r.value : []
    valueEditor = `
      <textarea id="set-${key}-value" rows="8" style="width:100%;font-family:monospace"
                placeholder="一行一个,例如:tempmail.com">${escapeHtml(items.join('\n'))}</textarea>
      <div style="color:var(--muted);font-size:12px;margin-top:4px">当前 ${items.length} 项</div>`
  } else {
    // number — 用 type=text 让用户自己看出范围,client 只做基本校验,server 二次校验
    valueEditor = `
      <input type="number" id="set-${key}-value"
             min="${meta.min ?? ''}" max="${meta.max ?? ''}" step="1"
             value="${escapeHtml(String(r.value))}" style="width:120px" />`
  }
  const range = meta.kind === 'number' ? `${meta.min}..${meta.max}`
              : meta.kind === 'enum' ? (meta.enumValues || []).join('/')
              : meta.kind === 'string_array' ? `max=${meta.max ?? '?'} 项`
              : 'true/false'
  return `
    <tr>
      <td class="mono"><strong>${escapeHtml(key)}</strong></td>
      <td><span class="badge muted">${escapeHtml(meta.kind || '?')}</span>
          <small style="color:var(--muted)">${escapeHtml(range)}</small></td>
      <td>${valueEditor} ${isDefault}</td>
      <td><input type="text" id="set-${key}-desc"
                 value="${escapeHtml(r.description || meta.description || '')}"
                 style="width:100%" /></td>
      <td class="mono">${r.is_default ? '—' : fmtDate(r.updated_at)}</td>
      <td class="actions">
        <button data-act="save-setting" data-key="${escapeHtml(key)}">保存</button>
      </td>
    </tr>
  `
}

async function saveSetting(key, btn) {
  const valEl = $(`set-${key}-value`)
  const descEl = $(`set-${key}-desc`)
  if (!valEl) { toast(`找不到 ${key} 输入框`, 'danger'); return }
  let value
  // server 已做严格 zod;这里仅把 string→正确 JS 类型即可
  if (valEl.tagName === 'SELECT' && (valEl.value === 'true' || valEl.value === 'false')) {
    value = valEl.value === 'true'
  } else if (valEl.type === 'number') {
    if (valEl.value === '') { toast(`${key}: 不能为空`, 'danger'); return }
    const n = Number(valEl.value)
    if (!Number.isFinite(n)) { toast(`${key}: 不是有效数字`, 'danger'); return }
    value = n
  } else if (valEl.tagName === 'TEXTAREA') {
    // string_array:换行/逗号分隔 → trim+lowercase+filter empty,server zod 二次校验
    value = valEl.value.split(/[\n,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)
  } else {
    value = valEl.value
  }
  await withBtnLoading(btn, async () => {
    try {
      await apiJson('PUT', `/api/admin/settings/${encodeURIComponent(key)}`, {
        value,
        description: descEl?.value ?? null,
      })
      toast(`${key} 已保存`)
      applyHash()
    } catch (e) {
      toast(`${key} 保存失败: ${e.message}`, 'danger', toastOptsFromError(e))
    }
  })
}

// ─── Tab: Literature (DeepXiv) ─────────────────────────────────────
//
// 平台级单例配置(literature_deepxiv_config id=1)。后端三个端点:
//   GET    /api/admin/literature        → { config: { enabled, base_url, token_set,
//                                                     token_hint, daily_cap, default_size,
//                                                     timeout_sec, updated_at, updated_by } }
//   PATCH  /api/admin/literature        → 局部更新;token 用显式 action 协议:
//                                          { action: 'keep' | 'set' | 'clear', value? }
//   POST   /api/admin/literature/test   → 真发 transformers/size=1 探测一次
//                                          { result: { ok, status, result_count,
//                                                     elapsed_ms, error? } }
//
// UI 策略:单页内联表单(非 modal),token 用 radio 三态显式区分,避免 mask 回显歧义。
// 保存时只把 form 当前值打包成 PATCH(等同"覆盖式"),后端 normalize 时同样的 patch
// 输入对当前 DB 没变的字段不会写 audit(等效 no-op),前端不做 diff。

async function renderLiteratureTab() {
  const data = await apiGet('/api/admin/literature')
  const c = data?.config ?? {}
  view().innerHTML = `
    <div class="panel">
      <h2>文献检索 (DeepXiv) <small>平台级单例配置 · 改完点保存立即生效</small></h2>
      <div style="color:var(--muted);font-size:12px;margin-bottom:12px">
        启用后,容器 LLM 系统 prompt 会注入 <code>SKILLS_LITERATURE</code> 段,
        引导其调用 <code>POST /v3/literature/search</code>;同时 admin 自检按钮可绕过
        daily_cap 真发一次 transformers&amp;size=1 探测上游。token 在 DB 端 AEAD 加密,
        本页永远只显示 <code>****last4</code> 掩码,不回显明文。
      </div>
      <div style="display:flex;flex-direction:column;gap:14px;max-width:680px">
        <div>
          <label style="display:flex;align-items:center;gap:8px;font-weight:500">
            <input type="checkbox" id="lit-enabled" ${c.enabled ? 'checked' : ''} />
            启用文献检索
          </label>
          <small style="color:var(--muted)">关闭时 <code>/v3/literature/search</code>
            直接 503,容器侧 prompt 不注入 SKILLS_LITERATURE 段。</small>
        </div>
        <div>
          <label style="display:block;font-weight:500;margin-bottom:4px">
            base_url
          </label>
          <input type="text" id="lit-base"
                 value="${escapeHtml(c.base_url ?? '')}"
                 style="width:100%;max-width:480px"
                 placeholder="https://data.rag.ac.cn" />
          <small style="color:var(--muted)">纯 origin(scheme + host + 可选 port),
            不允许 path/query/fragment/userinfo。proxy 拼路径时自动加
            <code>/arxiv/?type=retrieve&amp;...</code>。</small>
        </div>
        <div>
          <label style="display:block;font-weight:500;margin-bottom:4px">
            Token <small style="color:var(--muted)">(AEAD 加密存储,永不明文回显)</small>
          </label>
          <div style="margin-bottom:6px">
            当前: <code id="lit-token-hint">${
              c.token_set
                ? escapeHtml(c.token_hint ?? '****????')
                : '<span class="badge muted">未设置</span>'
            }</code>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px">
            <label style="display:flex;align-items:center;gap:6px">
              <input type="radio" name="lit-token-action" value="keep" checked />
              保持不变
            </label>
            <label style="display:flex;align-items:center;gap:6px">
              <input type="radio" name="lit-token-action" value="set" />
              写入新值
              <input type="password" id="lit-token-new"
                     placeholder="新 token(8..256 可见 ASCII)"
                     style="flex:1;min-width:240px" disabled />
            </label>
            <label style="display:flex;align-items:center;gap:6px">
              <input type="radio" name="lit-token-action" value="clear" />
              清空 token(等同关闭文献检索能力)
            </label>
          </div>
        </div>
        <div style="display:flex;gap:24px;flex-wrap:wrap">
          <div>
            <label style="display:block;font-weight:500;margin-bottom:4px">
              daily_cap
            </label>
            <input type="number" id="lit-cap" min="1" max="1000000" step="1"
                   value="${escapeHtml(String(c.daily_cap ?? 10000))}"
                   style="width:140px" />
            <small style="display:block;color:var(--muted)">UTC 日上限,1..1000000</small>
          </div>
          <div>
            <label style="display:block;font-weight:500;margin-bottom:4px">
              default_size
            </label>
            <input type="number" id="lit-size" min="1" max="100" step="1"
                   value="${escapeHtml(String(c.default_size ?? 10))}"
                   style="width:140px" />
            <small style="display:block;color:var(--muted)">LLM 缺省条数,1..100</small>
          </div>
          <div>
            <label style="display:block;font-weight:500;margin-bottom:4px">
              timeout_sec
            </label>
            <input type="number" id="lit-timeout" min="3" max="120" step="1"
                   value="${escapeHtml(String(c.timeout_sec ?? 20))}"
                   style="width:140px" />
            <small style="display:block;color:var(--muted)">upstream 超时,3..120</small>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn-primary" id="lit-save">保存</button>
          <button class="btn" id="lit-test">测试连接</button>
        </div>
        <div id="lit-test-result" style="margin-top:4px;min-height:20px"></div>
        <div style="color:var(--muted);font-size:12px">
          最后更新: ${c.updated_at ? escapeHtml(fmtDate(c.updated_at)) : '—'}
          ${c.updated_by ? `by <span class="mono">${escapeHtml(c.updated_by)}</span>` : ''}
        </div>
      </div>
    </div>
  `

  // Token radio:set 时启用 password 输入,其他状态 disabled 并清空(避免误传 stale 值)
  const tokenNewInput = $('lit-token-new')
  for (const r of view().querySelectorAll('input[name="lit-token-action"]')) {
    r.addEventListener('change', () => {
      if (r.checked && r.value === 'set') {
        tokenNewInput.disabled = false
        tokenNewInput.focus()
      } else if (r.checked) {
        tokenNewInput.disabled = true
        tokenNewInput.value = ''
      }
    })
  }

  $('lit-save').addEventListener('click', (ev) => saveLiterature(ev.currentTarget))
  $('lit-test').addEventListener('click', (ev) => testLiterature(ev.currentTarget))
}

function _readLiteratureTokenPatch() {
  // radio 默认 checked=keep,前端永远会有一个选中(form 渲染时硬编码 checked),
  // querySelector(':checked') 失败时 fail-soft 返 keep(等同不改),不抛 toast 阻断保存。
  const checked = view().querySelector('input[name="lit-token-action"]:checked')
  const action = checked?.value ?? 'keep'
  if (action === 'set') {
    const value = $('lit-token-new').value
    // 客户端只做"非空"检查,不在浏览器复刻 server 的 [\x21-\x7e]{8,256} 字符集校验 ——
    // 避免双源校验漂移,server normalize 抛 RangeError 时通过 toast 暴露给 admin。
    if (value === '') {
      throw new Error('token 不能为空(选了"写入新值"但未填)')
    }
    return { action: 'set', value }
  }
  if (action === 'clear') return { action: 'clear' }
  return { action: 'keep' }
}

async function saveLiterature(btn) {
  let tokenPatch
  try {
    tokenPatch = _readLiteratureTokenPatch()
  } catch (e) {
    toast(e.message, 'danger')
    return
  }
  // 数值字段:空串/NaN 直接挡掉,不发请求 —— 与 saveSetting 同型守则。
  // 注意 Number('') === 0 且 Number.isFinite(0) === true,必须先 trim 空串再 Number,
  // 否则清空字段会绕过前端守门,靠后端 range 报错走出非预期 UX。
  const capRaw = $('lit-cap').value.trim()
  const sizeRaw = $('lit-size').value.trim()
  const timeoutRaw = $('lit-timeout').value.trim()
  if (capRaw === '' || sizeRaw === '' || timeoutRaw === '') {
    toast('daily_cap / default_size / timeout_sec 不能为空', 'danger')
    return
  }
  const cap = Number(capRaw)
  const size = Number(sizeRaw)
  const timeout = Number(timeoutRaw)
  // 客户端只 finite check,整数 + 范围校验交给 server normalize(避双源漂移);
  // 非整数走到 server 会用 RangeError → "invalid_daily_cap" 等,toast 给 admin 看
  if (!Number.isFinite(cap) || !Number.isFinite(size) || !Number.isFinite(timeout)) {
    toast('数值字段必须是有效数字', 'danger')
    return
  }
  const patch = {
    enabled: $('lit-enabled').checked,
    base_url: $('lit-base').value.trim(),
    token: tokenPatch,
    daily_cap: cap,
    default_size: size,
    timeout_sec: timeout,
  }
  await withBtnLoading(btn, async () => {
    try {
      await apiJson('PATCH', '/api/admin/literature', patch)
      toast('文献检索配置已保存')
      applyHash()
    } catch (e) {
      toast(`保存失败: ${e.message}`, 'danger', toastOptsFromError(e))
    }
  })
}

async function testLiterature(btn) {
  const resultEl = $('lit-test-result')
  resultEl.innerHTML = '<small style="color:var(--muted)">探测中…</small>'
  await withBtnLoading(btn, async () => {
    try {
      const data = await apiJson('POST', '/api/admin/literature/test', {})
      const r = data?.result ?? {}
      if (r.ok) {
        resultEl.innerHTML = `
          <span class="badge ok">ok</span>
          status=<code>${escapeHtml(String(r.status ?? ''))}</code>
          result_count=<code>${escapeHtml(String(r.result_count ?? ''))}</code>
          elapsed=<code>${escapeHtml(String(r.elapsed_ms ?? ''))}ms</code>
        `
      } else {
        resultEl.innerHTML = `
          <span class="badge muted">failed</span>
          error=<code>${escapeHtml(String(r.error ?? 'unknown'))}</code>
          ${r.status !== null && r.status !== undefined
            ? `status=<code>${escapeHtml(String(r.status))}</code>` : ''}
          elapsed=<code>${escapeHtml(String(r.elapsed_ms ?? ''))}ms</code>
        `
      }
    } catch (e) {
      resultEl.innerHTML = `<span class="badge muted">error</span> ${escapeHtml(e.message)}`
      // 429 冷却 / 401 鉴权这类要再用 toast 提示,resultEl 旁路只是 inline 摘要
      toast(`测试失败: ${e.message}`, 'danger', toastOptsFromError(e))
    }
  })
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
  // 把当前页 row by id 缓存,diff modal 点击时按 id 取(避免在 onclick 里塞 JSON 大对象)
  _AUDIT_ROWS_BY_ID.clear()
  for (const r of rows) _AUDIT_ROWS_BY_ID.set(String(r.id), r)
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
                <th>变更</th><th>ip</th><th>时间</th></tr>
          </thead>
          <tbody>
            ${rows.map((r) => `
              <tr>
                <td class="mono">${escapeHtml(r.id)}</td>
                <td class="mono">${escapeHtml(r.admin_id)}</td>
                <td><span class="badge muted">${escapeHtml(r.action)}</span></td>
                <td class="mono">${escapeHtml(r.target || '—')}</td>
                <td>
                  <button class="btn" data-act="audit-diff" data-id="${escapeHtml(r.id)}"
                    style="padding:2px 8px;font-size:12px;">查看 diff</button>
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
  for (const b of view().querySelectorAll('button[data-act="audit-diff"]')) {
    b.addEventListener('click', () => {
      const row = _AUDIT_ROWS_BY_ID.get(b.dataset.id)
      if (row) openAuditDiffModal(row)
    })
  }
}

// P2-28 — Audit diff modal: 完整展开 before → after,top-level key by key 对比。
// 不递归深度 diff(audit 实践里一行 before/after 都是 ≤ 5-10 个 top-level 字段,
// 嵌套对象直接 JSON.stringify(2) 显示原文足够看懂)。

const _AUDIT_ROWS_BY_ID = new Map()

function _formatJsonValue(v) {
  if (v === undefined) return '<i style="opacity:0.5">undefined</i>'
  if (v === null) return '<i style="opacity:0.5">null</i>'
  if (typeof v === 'string') return escapeHtml(v)
  if (typeof v === 'number' || typeof v === 'boolean') return escapeHtml(String(v))
  // object/array: 紧凑 + 缩进 2,UI 显示用 <pre> 保格式
  try {
    return `<pre style="margin:0;white-space:pre-wrap;font-family:var(--font-mono);font-size:12px;">${escapeHtml(JSON.stringify(v, null, 2))}</pre>`
  } catch {
    return escapeHtml(String(v))
  }
}

function _shallowEq(a, b) {
  if (a === b) return true
  if (a === null || b === null || a === undefined || b === undefined) return false
  if (typeof a !== 'object' || typeof b !== 'object') return false
  try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false }
}

function openAuditDiffModal(r) {
  const before = (r.before && typeof r.before === 'object') ? r.before : {}
  const after = (r.after && typeof r.after === 'object') ? r.after : {}
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort()

  const rowsHtml = keys.length === 0
    ? `<tr><td colspan="3" class="empty">无字段变更(audit 行 before/after 都为空)</td></tr>`
    : keys.map((k) => {
        const bv = before[k]
        const av = after[k]
        const changed = !_shallowEq(bv, av)
        const cls = changed ? 'background:rgba(220,180,80,0.10);' : ''
        return `<tr style="${cls}">
          <td class="mono" style="vertical-align:top;font-weight:600">${escapeHtml(k)}</td>
          <td style="vertical-align:top;max-width:360px;overflow:auto">${_formatJsonValue(bv)}</td>
          <td style="vertical-align:top;max-width:360px;overflow:auto">${_formatJsonValue(av)}</td>
        </tr>`
      }).join('')

  openModal(`
    <h3>审计 diff · #${escapeHtml(r.id)}</h3>
    <div style="display:grid;grid-template-columns:auto 1fr;gap:8px 16px;margin-bottom:var(--s-3);font-size:13px;">
      <div style="opacity:0.7">action</div><div><span class="badge muted">${escapeHtml(r.action)}</span></div>
      <div style="opacity:0.7">admin</div><div class="mono">#${escapeHtml(r.admin_id)}</div>
      <div style="opacity:0.7">target</div><div class="mono">${escapeHtml(r.target || '—')}</div>
      <div style="opacity:0.7">ip</div><div class="mono">${escapeHtml(r.ip || '—')}</div>
      <div style="opacity:0.7">user_agent</div><div class="mono" style="word-break:break-all">${escapeHtml(r.user_agent || '—')}</div>
      <div style="opacity:0.7">时间</div><div class="mono">${escapeHtml(fmtDate(r.created_at))}</div>
    </div>
    <table class="data" style="font-size:12px">
      <thead><tr><th style="width:160px">字段</th><th>before</th><th>after</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <div class="form-actions"><button class="btn" id="a-diff-close">关闭</button></div>
  `)
  $('a-diff-close')?.addEventListener('click', closeModal)
}

// ─── Tab: Health(4L)──────────────────────────────────────────────
//
// 直接拉 /api/admin/metrics 的 Prometheus 文本(text/plain),前端解析成 series
// → cards。不引 chart.js,卡片 + 表足够看趋势对比;后续要长时段图再接外部
// Prometheus/Grafana。
//
// 说明: /api/admin/metrics 优先认 COMMERCIAL_METRICS_BEARER(scrape token),
// 没设时回落到 admin JWT —— 我们登录态本身就带 admin token,所以直接 GET 即可。

/**
 * 解析一行 Prometheus exposition,如:
 *   gateway_http_requests_total{route="/api/me",method="GET",status="200"} 42
 *   anthropic_proxy_ttft_seconds_bucket{model="sonnet",le="0.5"} 12
 * 返回 {name, labels, value} 或 null(注释/空行/HELP/TYPE)。
 */
function _parsePromLine(line) {
  if (!line || line.startsWith('#')) return null
  const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+(.+?)$/)
  if (!m) return null
  const name = m[1]
  const labelStr = m[3] || ''
  const valStr = m[4].trim().split(/\s+/)[0] // 末尾可能跟 timestamp,只取数字
  const value = Number(valStr)
  if (!Number.isFinite(value)) return null
  const labels = {}
  if (labelStr) {
    // Prom exposition 规则: label value 转义 \\, \", \n。这里一并反转义,
    // 否则两条仅在转义形式上不同的 series 会被算成不同 key。
    const re = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g
    let lm
    while ((lm = re.exec(labelStr))) {
      labels[lm[1]] = lm[2]
        .replace(/\\\\/g, '\u0001')   // 占位避免 \\\" 被先吃 \"
        .replace(/\\"/g, '"')
        .replace(/\\n/g, '\n')
        .replace(/\u0001/g, '\\')
    }
  }
  return { name, labels, value }
}

/** 解析整段 text,按 metric name 分桶。返回 Map<name, Array<{labels, value}>> */
function _parsePromText(text) {
  const out = new Map()
  for (const line of text.split('\n')) {
    const r = _parsePromLine(line)
    if (!r) continue
    if (!out.has(r.name)) out.set(r.name, [])
    out.get(r.name).push({ labels: r.labels, value: r.value })
  }
  return out
}

function _sumSeries(samples) {
  if (!samples) return 0
  return samples.reduce((s, x) => s + x.value, 0)
}

/** 返回 {[label_value]: sum_value} 按指定 label 聚合。 */
function _groupByLabel(samples, labelName) {
  const out = {}
  if (!samples) return out
  for (const s of samples) {
    const k = s.labels[labelName] ?? '?'
    out[k] = (out[k] || 0) + s.value
  }
  return out
}

/**
 * Histogram 平均(sum/count),用 _bucket/_sum/_count 三件套。
 * model label 按 shortModel 已在 server 折叠过,前端不再聚合,直接返回每 model 的 (count, sum, avg)。
 */
function _histogramByLabel(metrics, baseName, labelName) {
  const sumSamples = metrics.get(`${baseName}_sum`) || []
  const countSamples = metrics.get(`${baseName}_count`) || []
  const sums = {}
  const counts = {}
  for (const s of sumSamples) {
    const k = s.labels[labelName] ?? '?'
    sums[k] = (sums[k] || 0) + s.value
  }
  for (const s of countSamples) {
    const k = s.labels[labelName] ?? '?'
    counts[k] = (counts[k] || 0) + s.value
  }
  const out = []
  for (const k of Object.keys(counts)) {
    const c = counts[k]
    const sum = sums[k] || 0
    out.push({ key: k, count: c, sum, avg: c > 0 ? sum / c : 0 })
  }
  return out
}

async function renderHealthTab() {
  view().innerHTML = `<div class="loading">正在抓取 /api/admin/metrics …</div>`
  let text
  try {
    text = await apiText('/api/admin/metrics')
  } catch (e) {
    showError(`拉取 metrics 失败: ${e.message}`, e)
    return
  }
  const metrics = _parsePromText(text)

  // 总览数字
  const reqTotal = _sumSeries(metrics.get('gateway_http_requests_total'))
  const reqByStatus = _groupByLabel(metrics.get('gateway_http_requests_total'), 'status')
  const debitByResult = _groupByLabel(metrics.get('billing_debit_total'), 'result')
  const claudeByStatus = _groupByLabel(metrics.get('claude_api_requests_total'), 'status')
  const settleByKind = _groupByLabel(metrics.get('anthropic_proxy_settle_total'), 'kind')
  const rejectByReason = _groupByLabel(metrics.get('anthropic_proxy_reject_total'), 'reason')
  const auditFailByAction = _groupByLabel(metrics.get('admin_audit_write_failures_total'), 'action')
  const containersRunning = _sumSeries(metrics.get('agent_containers_running'))

  // 账号池健康(每条一行)
  const acctSamples = metrics.get('account_pool_health') || []
  const acctRows = acctSamples
    .map((s) => ({
      account_id: s.labels.account_id || '?',
      status: s.labels.status || '?',
      health: s.value,
    }))
    .sort((a, b) => a.health - b.health)

  // 代理延迟(直方图 — 按 model 平均)
  const ttftHist = _histogramByLabel(metrics, 'anthropic_proxy_ttft_seconds', 'model')
  const streamHist = _histogramByLabel(metrics, 'anthropic_proxy_stream_duration_seconds', 'model')

  // 桥指标
  const bridgeBufferedHist = _histogramByLabel(metrics, 'ws_bridge_buffered_bytes', 'side')
  const bridgeSessionHist = _histogramByLabel(metrics, 'ws_bridge_session_duration_seconds', 'cause')

  const okStatusSum =
    (reqByStatus['200'] || 0) + (reqByStatus['201'] || 0) + (reqByStatus['204'] || 0)
  const errStatusSum = Object.entries(reqByStatus)
    .filter(([k]) => /^5/.test(k))
    .reduce((s, [, v]) => s + v, 0)

  const fmtN = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })
  const fmtMs = (sec) => sec > 0 ? `${(sec * 1000).toFixed(0)} ms` : '—'
  const fmtKB = (bytes) => bytes > 0 ? `${(bytes / 1024).toFixed(1)} KB` : '—'

  view().innerHTML = `
    <div class="panel">
      <h2>健康面板 <small>聚合自 /api/admin/metrics · 实时快照,刷新看变化</small></h2>
      <div class="toolbar">
        <button class="btn" id="h-refresh">刷新</button>
        <span class="spacer"></span>
        <button class="btn btn-secondary" id="h-raw">查看原始 metrics →</button>
      </div>

      <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:12px; margin-bottom:16px;">
        ${_kpiCard('总请求', fmtN(reqTotal), `OK ${fmtN(okStatusSum)} · 5xx ${fmtN(errStatusSum)}`)}
        ${_kpiCard('运行中容器', fmtN(containersRunning), `agent_containers_running`)}
        ${_kpiCard('计费 success', fmtN(debitByResult.success || 0),
            `insufficient ${fmtN(debitByResult.insufficient || 0)} · error ${fmtN(debitByResult.error || 0)}`)}
        ${_kpiCard('Claude 调用 success', fmtN(claudeByStatus.success || 0),
            `error ${fmtN(claudeByStatus.error || 0)}`)}
      </div>
    </div>

    <div class="panel">
      <h2>HTTP 请求按状态码</h2>
      ${_renderKvTable(reqByStatus, ['status', 'count'])}
    </div>

    <div class="panel">
      <h2>Anthropic 代理 settle / reject</h2>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
        <div><h3 style="font-size:13px; color:var(--muted);">settle (成功收尾种类)</h3>
          ${_renderKvTable(settleByKind, ['kind', 'count'])}</div>
        <div><h3 style="font-size:13px; color:var(--muted);">reject (拒绝原因)</h3>
          ${_renderKvTable(rejectByReason, ['reason', 'count'])}</div>
      </div>
    </div>

    <div class="panel">
      <h2>账号池健康 <small>共 ${acctRows.length} 个账号</small></h2>
      ${acctRows.length === 0 ? '<div class="empty">无数据</div>' : `
      <table class="data">
        <thead><tr><th>account_id</th><th>status</th><th class="num">health_score</th></tr></thead>
        <tbody>
          ${acctRows.map((r) => `
            <tr>
              <td class="mono">${escapeHtml(r.account_id)}</td>
              <td>${statusBadge(r.status)}</td>
              <td class="num">${r.health.toFixed(0)}</td>
            </tr>`).join('')}
        </tbody>
      </table>`}
    </div>

    <div class="panel">
      <h2>代理延迟(按模型 / 平均)</h2>
      ${_renderHistTable(ttftHist, '模型', '请求数', 'TTFT 平均', (h) => fmtMs(h.avg))}
      <h3 style="margin-top:12px; font-size:13px; color:var(--muted);">流式总时长</h3>
      ${_renderHistTable(streamHist, '模型', '请求数', '总时长平均', (h) => fmtMs(h.avg))}
    </div>

    <div class="panel">
      <h2>WS Bridge</h2>
      <h3 style="font-size:13px; color:var(--muted);">缓冲字节(按方向)</h3>
      ${_renderHistTable(bridgeBufferedHist, '方向', '采样数', '平均', (h) => fmtKB(h.avg))}
      <h3 style="margin-top:12px; font-size:13px; color:var(--muted);">会话时长(按结束原因)</h3>
      ${_renderHistTable(bridgeSessionHist, '原因', '会话数', '平均时长', (h) => h.avg > 0 ? `${h.avg.toFixed(1)} s` : '—')}
    </div>

    ${Object.keys(auditFailByAction).length > 0 ? `
    <div class="panel">
      <h2 style="color:var(--warn);">⚠️ admin_audit 写失败</h2>
      ${_renderKvTable(auditFailByAction, ['action', 'count'])}
    </div>` : ''}
  `
  $('h-refresh').addEventListener('click', applyHash)
  // 查看原始 metrics —— 直接用浏览器 <a href> 会丢 Authorization header,改走
  // JS fetch 带 token 拉文本,包成 blob 再新窗口打开。
  $('h-raw')?.addEventListener('click', async () => {
    try {
      const txt = await apiText('/api/admin/metrics')
      const blob = new Blob([txt], { type: 'text/plain; charset=utf-8' })
      const url = URL.createObjectURL(blob)
      window.open(url, '_blank', 'noopener,noreferrer')
      // 让浏览器有足够时间读 URL 再释放
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (e) {
      showError(`拉取 metrics 失败: ${e.message}`, e)
    }
  })
}

function _kpiCard(title, value, sub) {
  return `
    <div style="background:var(--panel-2); border:1px solid var(--border); border-radius:8px; padding:12px;">
      <div style="color:var(--muted); font-size:12px;">${escapeHtml(title)}</div>
      <div style="font-size:24px; font-variant-numeric:tabular-nums; margin:4px 0;">${escapeHtml(value)}</div>
      <div style="color:var(--muted); font-size:12px;">${escapeHtml(sub)}</div>
    </div>
  `
}

function _renderKvTable(obj, headers) {
  const entries = Object.entries(obj).sort((a, b) => b[1] - a[1])
  if (entries.length === 0) return '<div class="empty">无数据</div>'
  return `
    <table class="data">
      <thead><tr><th>${escapeHtml(headers[0])}</th><th class="num">${escapeHtml(headers[1])}</th></tr></thead>
      <tbody>
        ${entries.map(([k, v]) => `
          <tr>
            <td class="mono">${escapeHtml(k)}</td>
            <td class="num">${Number(v).toLocaleString()}</td>
          </tr>`).join('')}
      </tbody>
    </table>
  `
}

function _renderHistTable(histRows, keyHdr, countHdr, avgHdr, avgFmt) {
  if (!histRows || histRows.length === 0) return '<div class="empty">无数据</div>'
  const sorted = [...histRows].sort((a, b) => b.count - a.count)
  return `
    <table class="data">
      <thead><tr><th>${escapeHtml(keyHdr)}</th><th class="num">${escapeHtml(countHdr)}</th>
        <th class="num">${escapeHtml(avgHdr)}</th></tr></thead>
      <tbody>
        ${sorted.map((h) => `
          <tr>
            <td class="mono">${escapeHtml(h.key)}</td>
            <td class="num">${Number(h.count).toLocaleString()}</td>
            <td class="num">${escapeHtml(avgFmt(h))}</td>
          </tr>`).join('')}
      </tbody>
    </table>
  `
}

// ─── Tab: Alerts(T-63 告警中心) ─────────────────────────────────────
//
// 四区:
//   1. 通道 channels —— 列、绑定 iLink 微信(QR 扫码流程)、改订阅、发测试、删
//   2. 投递 outbox  —— 事件/严重度/状态过滤 + 分页
//   3. 静默 silences —— 7d 窗口内压制某类事件
//   4. 规则状态 rule_states —— polled rule 快照,只读诊断
//
// 后端全部路由在 /api/admin/alerts/*(见 commercial/src/http/adminAlerts.ts)。
//
// iLink 扫码 UX:
//   - 点"绑定" → modal 内显示 base64 QR + 文案"请用已登录该机器人的微信扫码"
//   - 前端 setInterval 每 ~3s POST /api/admin/alerts/ilink/poll(qrcode)
//   - server side 自己 long-poll 35s;返 pending → 继续;confirmed → 关 modal 刷新列表
//   - modal 关掉会设 abortFlag 停轮询;QR 在 iLink 侧大约 120s 过期,超时直接报红
//
// 关键状态徽章(channel):
//   activation_status = pending → "等待首次对话"(要先用微信给机器人发任意一句话,worker 抓 context_token)
//                     = active  + has_context_token → "就绪"
//                     = active  - has_context_token → "已激活但尚无 token"(异常态,提示再发一条)
//                     = disabled/error → 红字

const ALERTS_STATE = {
  events: null,           // 事件目录缓存(按 group 渲染订阅 UI)
  outboxFilter: { event_type: '', status: '', severity: '' },
  qrAbortFlag: null,      // { aborted: boolean } —— modal 关时置 true
}

async function renderAlertsTab() {
  // 先把事件目录吃到内存,subscribe modal 会复用
  if (!ALERTS_STATE.events) {
    try {
      const d = await apiGet('/api/admin/alerts/events')
      ALERTS_STATE.events = d?.rows ?? []
    } catch (e) {
      // 不致命;订阅 UI 会退化成 raw input
      ALERTS_STATE.events = []
      console.warn('[alerts] 加载事件目录失败:', e.message)
    }
  }

  view().innerHTML = `
    <!-- P3 Plan v10:事件覆盖矩阵 — admin 一眼看清"哪些事件没人收 / 订阅了但被卡住" -->
    <div class="panel">
      <h2>事件覆盖矩阵 <small>EVENT_META × channels.event_types — 谁能收、最近一次入队</small></h2>
      <div class="toolbar">
        <button class="btn" id="al-cv-refresh">刷新</button>
      </div>
      <div id="al-coverage">加载中…</div>
    </div>

    <div class="panel">
      <h2>告警通道 <small>微信 iLink / Telegram,只发给绑定了的超管</small></h2>
      <div class="toolbar">
        <button class="btn" id="al-ch-refresh">刷新</button>
        <span class="spacer"></span>
        <button class="btn btn-primary" id="al-ch-bind">+ 绑定 iLink 微信</button>
        <button class="btn btn-primary" id="al-ch-tg">+ 添加 Telegram</button>
      </div>
      <div id="al-channels">加载中…</div>
    </div>

    <div class="panel">
      <h2>投递历史 outbox</h2>
      <div class="toolbar">
        <label>事件:<select id="al-ob-event">
          <option value="">全部</option>
          ${(ALERTS_STATE.events || []).map((e) =>
            `<option value="${escapeHtml(e.event_type)}">${escapeHtml(e.event_type)}</option>`,
          ).join('')}
        </select></label>
        <label>严重度:<select id="al-ob-severity">
          <option value="">全部</option>
          <option value="critical">critical</option>
          <option value="warning">warning</option>
          <option value="info">info</option>
        </select></label>
        <label>状态:<select id="al-ob-status">
          <option value="">全部</option>
          <option value="pending">pending</option>
          <option value="sent">sent</option>
          <option value="failed">failed</option>
          <option value="suppressed">suppressed</option>
          <option value="skipped">skipped</option>
        </select></label>
        <button class="btn" id="al-ob-refresh">刷新</button>
      </div>
      <div id="al-outbox">加载中…</div>
    </div>

    <div class="panel">
      <h2>静默 silences <small>最长 7 天</small></h2>
      <div class="toolbar">
        <button class="btn" id="al-sl-refresh">刷新</button>
        <span class="spacer"></span>
        <button class="btn btn-primary" id="al-sl-new">+ 新建静默</button>
      </div>
      <div id="al-silences">加载中…</div>
    </div>

    <div class="panel">
      <h2>规则状态 rule_states <small>polled scheduler 诊断</small></h2>
      <div class="toolbar">
        <button class="btn" id="al-rs-refresh">刷新</button>
      </div>
      <div id="al-rule-states">加载中…</div>
    </div>
  `

  // 五区并行拉数据 —— 互不阻塞(coverage 是新加的 P3 panel)
  _refreshAlertCoverage()
  _refreshAlertChannels()
  _refreshAlertOutbox()
  _refreshAlertSilences()
  _refreshAlertRuleStates()

  $('al-cv-refresh').addEventListener('click', _refreshAlertCoverage)
  $('al-ch-refresh').addEventListener('click', _refreshAlertChannels)
  $('al-ch-bind').addEventListener('click', _openBindIlinkModal)
  $('al-ch-tg').addEventListener('click', _openCreateTelegramModal)
  $('al-ob-refresh').addEventListener('click', () => {
    ALERTS_STATE.outboxFilter.event_type = $('al-ob-event').value
    ALERTS_STATE.outboxFilter.severity = $('al-ob-severity').value
    ALERTS_STATE.outboxFilter.status = $('al-ob-status').value
    _refreshAlertOutbox()
  })
  $('al-sl-refresh').addEventListener('click', _refreshAlertSilences)
  $('al-sl-new').addEventListener('click', _openCreateSilenceModal)
  $('al-rs-refresh').addEventListener('click', _refreshAlertRuleStates)
}

// ── coverage matrix (P3 Plan v10) ───────────────────────────────────

// 7 group label 顺序按业务重要性排:account_pool / payment / container 在前
const COVERAGE_GROUP_LABEL = {
  account_pool: '账号池',
  payment: '支付',
  container: '容器',
  risk: '风控',
  health: '健康',
  security: '安全',
  system: '系统',
}
const COVERAGE_GROUP_ORDER = ['account_pool', 'payment', 'container', 'risk', 'health', 'security', 'system']

const COVERAGE_SEV_TONE = { critical: 'danger', warning: 'warn', info: 'muted' }

async function _refreshAlertCoverage() {
  const el = $('al-coverage')
  if (!el) return
  el.innerHTML = '<div class="loading">加载中…</div>'
  try {
    const d = await apiGet('/api/admin/alerts/events/coverage')
    const rows = d?.rows ?? []
    if (rows.length === 0) {
      el.innerHTML = '<div class="empty">暂无事件 — EVENT_META 为空?</div>'
      return
    }
    // 按 group 分桶,保持后端给的 EVENT_META 顺序(已按业务排过)
    const byGroup = {}
    for (const r of rows) {
      if (!byGroup[r.group]) byGroup[r.group] = []
      byGroup[r.group].push(r)
    }
    const html = COVERAGE_GROUP_ORDER
      .filter((g) => byGroup[g] && byGroup[g].length > 0)
      .map((g) => `
        <div class="coverage-group">
          <h4 style="margin:12px 0 6px 0;">${escapeHtml(COVERAGE_GROUP_LABEL[g] || g)} <small style="color:var(--muted);font-weight:400;">(${byGroup[g].length})</small></h4>
          <table class="data-table">
            <thead>
              <tr>
                <th>事件</th>
                <th>严重度</th>
                <th>触发</th>
                <th class="num">订阅</th>
                <th class="num">可投递</th>
                <th>最近一次入队</th>
              </tr>
            </thead>
            <tbody>${byGroup[g].map(_renderCoverageRow).join('')}</tbody>
          </table>
        </div>
      `).join('')
    el.innerHTML = html
  } catch (e) {
    el.innerHTML = `<div class="chip chip-danger">加载失败:${escapeHtml(e.message || String(e))}</div>`
  }
}

function _renderCoverageRow(r) {
  const sevTone = COVERAGE_SEV_TONE[r.severity] || 'muted'
  // subscriber=0 → 红:没人订阅
  // subscriber>0 && deliverable=0 → 黄:订阅了但 severity_min 卡住 / iLink 未激活
  // subscriber>0 && deliverable>0 → 灰:正常
  let subTone = 'muted', delTone = 'muted', delHint = ''
  if (r.subscriber_count === 0) {
    subTone = 'warn'; delTone = 'warn'; delHint = '没人订阅这个事件'
  } else if (r.deliverable_count === 0) {
    delTone = 'warn'; delHint = '有 channel 订阅但 severity_min 卡住 / iLink 未激活'
  }
  const lastCell = r.last_fired_at
    ? `<span class="mono" title="最近 severity: ${escapeHtml(r.last_severity || '')}">${escapeHtml(fmtRelative(r.last_fired_at))}</span>`
    : '<span class="muted">从未</span>'
  return `
    <tr>
      <td>
        <span class="mono">${escapeHtml(r.event_type)}</span>
        <div class="muted" style="font-size:12px;">${escapeHtml(r.description || '')}</div>
      </td>
      <td><span class="chip chip-${sevTone}">${escapeHtml(r.severity)}</span></td>
      <td><span class="chip chip-muted" title="${escapeHtml(r.trigger === 'polled' ? '轮询 scheduler' : r.trigger === 'passive' ? '代码路径被动 enqueue' : '两者都有')}">${escapeHtml(r.trigger)}</span></td>
      <td class="num"><span class="chip chip-${subTone}">${r.subscriber_count}</span></td>
      <td class="num"><span class="chip chip-${delTone}" ${delHint ? `title="${escapeHtml(delHint)}"` : ''}>${r.deliverable_count}</span></td>
      <td>${lastCell}</td>
    </tr>
  `
}

// ── channels ────────────────────────────────────────────────────────

async function _refreshAlertChannels() {
  const el = $('al-channels')
  if (!el) return
  el.innerHTML = '<div class="loading">加载中…</div>'
  try {
    const d = await apiGet('/api/admin/alerts/channels')
    const rows = d?.rows ?? []
    if (rows.length === 0) {
      el.innerHTML = '<div class="empty">暂无通道。点右上「绑定微信」开始。</div>'
      return
    }
    el.innerHTML = `
      <table class="data">
        <thead>
          <tr>
            <th>#</th><th>标签</th><th>类型</th><th>启用</th>
            <th>最低严重度</th><th>订阅</th><th>激活状态</th>
            <th>最近发送</th><th>最近错误</th>
            <th class="actions">操作</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(_renderChannelRow).join('')}
        </tbody>
      </table>
    `
    for (const btn of el.querySelectorAll('button[data-act]')) {
      const act = btn.dataset.act
      const id = btn.dataset.id
      btn.addEventListener('click', (ev) => _handleChannelAction(act, id, ev.currentTarget))
    }
  } catch (e) {
    el.innerHTML = `<div class="error">加载通道失败: ${escapeHtml(e.message)}</div>`
  }
}

function _renderChannelRow(c) {
  const actBadge = _activationBadge(c)
  const subs = c.event_types && c.event_types.length > 0
    ? `<span class="badge muted">${c.event_types.length} 种</span>`
    : '<span class="badge ok">全部</span>'
  const enabled = c.enabled
    ? '<span class="badge ok">ON</span>'
    : '<span class="badge muted">OFF</span>'
  const typeLabel = c.channel_type === 'ilink_wechat'
    ? '<span class="badge muted">微信 iLink</span>'
    : c.channel_type === 'telegram'
      ? '<span class="badge muted">Telegram</span>'
      : `<span class="badge muted">${escapeHtml(c.channel_type)}</span>`
  return `
    <tr>
      <td class="mono">${escapeHtml(c.id)}</td>
      <td>${escapeHtml(c.label)}</td>
      <td>${typeLabel}</td>
      <td>${enabled}</td>
      <td><span class="badge ${c.severity_min === 'critical' ? 'danger' : c.severity_min === 'warning' ? 'warn' : 'muted'}">${escapeHtml(c.severity_min)}</span></td>
      <td>${subs}</td>
      <td>${actBadge}</td>
      <td class="mono">${fmtDate(c.last_send_at)}</td>
      <td class="mono" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
          title="${escapeHtml(c.last_error || '')}">${escapeHtml(c.last_error || '—')}</td>
      <td class="actions">
        <button data-act="edit" data-id="${escapeHtml(c.id)}">编辑</button>
        <button data-act="${c.enabled ? 'disable' : 'enable'}" data-id="${escapeHtml(c.id)}">${c.enabled ? '停用' : '启用'}</button>
        <button data-act="test" data-id="${escapeHtml(c.id)}">测试</button>
        ${c.activation_status === 'error' && c.channel_type === 'ilink_wechat' ? `<button data-act="rebind" data-id="${escapeHtml(c.id)}" title="把 activation_status=error 推回 pending,worker 会重新 long-poll。不重新扫码。">重新激活</button>` : ''}
        <button data-act="delete" data-id="${escapeHtml(c.id)}" class="btn-danger">删</button>
      </td>
    </tr>
  `
}

function _activationBadge(c) {
  // Telegram 通道没有 context_token / pending 等 iLink 专属阶段 —— 创建即 active,
  // 只有 permanent-error (401/403/404) 会把 activation_status 推到 error。
  if (c.channel_type === 'telegram') {
    if (c.activation_status === 'active') return '<span class="badge ok">就绪</span>'
    if (c.activation_status === 'disabled') return '<span class="badge muted">disabled</span>'
    return `<span class="badge danger" title="${escapeHtml(c.last_error || '')}">${escapeHtml(c.activation_status)}</span>`
  }
  if (c.activation_status === 'active' && c.has_context_token) {
    return '<span class="badge ok">就绪</span>'
  }
  if (c.activation_status === 'active' && !c.has_context_token) {
    return '<span class="badge warn" title="已激活但尚未捕获 context_token。请用微信再向该机器人发一条消息。">已激活·待 token</span>'
  }
  if (c.activation_status === 'pending') {
    return '<span class="badge warn" title="请用已扫码的微信向机器人发任意一句话,worker 会自动抓取 context_token。">等待首次对话</span>'
  }
  if (c.activation_status === 'disabled') return '<span class="badge muted">disabled</span>'
  return `<span class="badge danger">${escapeHtml(c.activation_status)}</span>`
}

// 把 /test 路径常见的 409 翻译成中文 actionable 指引。后端 message 是英文,
// admin.js 自家 toast 又不渲染 issues,boss 直接看到 "channel not active: pending"
// 一脸懵。优先匹配后端结构化 issues[].path,fallback 才到 message.includes()。
// 范围严格限定 act === 'test':rebind 自己有 outcome=='reactivated' 友好文案,
// 其他 action(enable/disable/delete/edit) 走原 e.message 透传。
function _friendlyTestError(e) {
  const msg = String(e?.message || '')
  const issueMsg = String(
    e?.issues?.find?.((x) => x?.path === 'activation')?.message || '',
  )
  if (
    issueMsg.includes('awaiting first inbound message') ||
    msg.includes('channel not active: pending')
  ) {
    return '通道还在等待激活 — 请用扫码绑定的微信向 bot 发任意一句话,worker 抓到首条消息会自动转为 active,几秒后再点测试'
  }
  if (msg.includes('channel not active: error')) {
    return '通道处于错误状态,请点「重新激活」后,再用微信发一条消息触发激活'
  }
  if (msg.includes('channel not active: disabled')) {
    return '通道处于 disabled 状态,请联系管理员或删除重建'
  }
  if (msg.includes('channel missing context_token')) {
    return '通道已激活,但还未抓到 context_token — 请再用微信向 bot 发一条消息触发抓取,几秒后再点测试'
  }
  if (msg.includes('channel disabled')) {
    return '通道未启用,请先点「启用」再测试'
  }
  return null
}

async function _handleChannelAction(act, id, btn) {
  try {
    if (act === 'enable' || act === 'disable') {
      await withBtnLoading(btn, () =>
        apiJson('PATCH', `/api/admin/alerts/channels/${id}`, { enabled: act === 'enable' }),
      )
      toast(`通道已${act === 'enable' ? '启用' : '停用'}`)
      _refreshAlertChannels()
    } else if (act === 'test') {
      await withBtnLoading(btn, () =>
        apiJson('POST', `/api/admin/alerts/channels/${id}/test`, {}),
      )
      toast('测试已入队,数秒后检查微信 / outbox')
      setTimeout(_refreshAlertOutbox, 3000)
    } else if (act === 'delete') {
      if (!confirm(`确认删除通道 #${id}?此操作会立刻停止发送,但历史 outbox 会保留。`)) return
      await withBtnLoading(btn, () => apiJson('DELETE', `/api/admin/alerts/channels/${id}`, null))
      toast('已删除')
      _refreshAlertChannels()
    } else if (act === 'rebind') {
      // 重新激活:error → pending,worker 会重新 long-poll。不重新扫码。
      // 后端幂等:already_active/already_pending 也返 200,按 outcome 分支。
      // 若 bot_token 已失效,worker 会再次降级 error,此时用户要删掉重新扫码绑。
      const r = await withBtnLoading(btn, () =>
        apiJson('POST', `/api/admin/alerts/channels/${id}/rebind`, {}),
      )
      if (r?.outcome === 'reactivated') {
        toast(r.next_step || '通道已重置为 pending,请用微信给 bot 发一条消息触发激活')
      } else if (r?.outcome === 'already_active') {
        toast('通道已是 active,无需重新激活', 'info')
      } else if (r?.outcome === 'already_pending') {
        toast('通道已是 pending,worker 将在下轮 tick 尝试 long-poll', 'info')
      } else {
        toast('重新激活请求已处理')
      }
      _refreshAlertChannels()
    } else if (act === 'edit') {
      await _openEditChannelModal(id)
    }
  } catch (e) {
    const friendly = act === 'test' ? _friendlyTestError(e) : null
    toast(friendly || `失败: ${e.message}`, 'danger', toastOptsFromError(e))
  }
}

async function _openEditChannelModal(id) {
  // 从当前列表快速拿(再查一次 /channels 也行,但展示已有数据更快)
  const d = await apiGet('/api/admin/alerts/channels')
  const c = (d?.rows || []).find((x) => x.id === id)
  if (!c) { toast(`通道 #${id} 不存在`, 'danger'); return }

  const checkbox = (evType, subs) =>
    `<label style="display:inline-block;margin-right:8px;font-weight:normal">
       <input type="checkbox" data-event="${escapeHtml(evType)}" ${subs.includes(evType) ? 'checked' : ''}>
       ${escapeHtml(evType)}
     </label>`
  const currentSubs = c.event_types || []
  const groups = {}
  for (const e of (ALERTS_STATE.events || [])) {
    groups[e.group] = groups[e.group] || []
    groups[e.group].push(e)
  }
  const allEmpty = currentSubs.length === 0
  openModal(`
    <h3>编辑通道 #${escapeHtml(c.id)} — ${escapeHtml(c.label)}</h3>
    <div class="form-row">
      <label>标签 label</label>
      <input type="text" id="al-ed-label" value="${escapeHtml(c.label)}" maxlength="64" />
    </div>
    <div class="form-row">
      <label>最低严重度(低于此级别的不发)</label>
      <select id="al-ed-severity">
        <option value="info" ${c.severity_min === 'info' ? 'selected' : ''}>info(所有)</option>
        <option value="warning" ${c.severity_min === 'warning' ? 'selected' : ''}>warning(默认)</option>
        <option value="critical" ${c.severity_min === 'critical' ? 'selected' : ''}>critical(只发严重)</option>
      </select>
    </div>
    <div class="form-row">
      <label>订阅事件
        <small style="color:var(--muted)">
          (留空 / 全勾 = <em>全部订阅</em>;部分勾 = 白名单)
        </small>
      </label>
      <div id="al-ed-events" style="max-height:260px;overflow-y:auto;border:1px solid var(--border);padding:8px;border-radius:4px">
        <div style="margin-bottom:6px">
          <button class="btn" id="al-ed-all">全选</button>
          <button class="btn" id="al-ed-none">全不选</button>
          <small style="color:var(--muted);margin-left:8px">当前 ${allEmpty ? '全部订阅' : `订阅 ${currentSubs.length} 种`}</small>
        </div>
        ${Object.entries(groups).map(([g, list]) => `
          <fieldset style="border:1px solid var(--border);margin-bottom:6px;padding:6px">
            <legend style="color:var(--muted);font-size:12px">${escapeHtml(g)}</legend>
            ${list.map((e) => checkbox(e.event_type, allEmpty ? list.map((x) => x.event_type) : currentSubs)).join('')}
          </fieldset>
        `).join('')}
      </div>
    </div>
    <div class="form-actions">
      <button id="al-ed-cancel">取消</button>
      <button class="btn-primary" id="al-ed-ok">保存</button>
    </div>
  `)
  const container = $('al-ed-events')
  $('al-ed-all').addEventListener('click', (ev) => {
    ev.preventDefault()
    for (const cb of container.querySelectorAll('input[type=checkbox]')) cb.checked = true
  })
  $('al-ed-none').addEventListener('click', (ev) => {
    ev.preventDefault()
    for (const cb of container.querySelectorAll('input[type=checkbox]')) cb.checked = false
  })
  $('al-ed-cancel').addEventListener('click', closeModal)
  $('al-ed-ok').addEventListener('click', async (ev) => {
    const checked = Array.from(container.querySelectorAll('input[type=checkbox]:checked'))
      .map((cb) => cb.dataset.event)
    // 全选等价于"空数组=全部订阅" —— 显式写空数组避免一旦目录扩展了老白名单就漏新事件
    const all = ALERTS_STATE.events || []
    const eventTypes = (all.length > 0 && checked.length === all.length) ? [] : checked
    const label = $('al-ed-label').value.trim()
    if (label.length === 0 || label.length > 64) { toast('label 长度 1..64', 'danger'); return }
    await withBtnLoading(ev.currentTarget, async () => {
      try {
        await apiJson('PATCH', `/api/admin/alerts/channels/${c.id}`, {
          label,
          severity_min: $('al-ed-severity').value,
          event_types: eventTypes,
        })
        toast('已保存')
        closeModal()
        _refreshAlertChannels()
      } catch (e) {
        toast(`失败: ${e.message}`, 'danger', toastOptsFromError(e))
      }
    })
  })
}

// ── 绑定 iLink 微信(QR 扫码)──────────────────────────────────────

// 用 /vendor/qrcode.min.js (qrcode-generator) 把任意字符串 encode 成 data:url QR 图。
// 与 modules/wechat.js 的 qrDataUrl 同一套路,不抽公共模块是因为 admin bundle 独立,
// 而那边是 SPA import,两边 HTML 各自引 vendor 脚本。
function _qrDataUrl(text, size = 240) {
  const maker = typeof window !== 'undefined' ? window.qrcode : undefined
  if (typeof maker !== 'function') {
    throw new Error('QR 渲染库未加载 (qrcode-generator)')
  }
  const qr = maker(0, 'M')
  qr.addData(String(text))
  qr.make()
  const modules = qr.getModuleCount()
  const cellSize = Math.max(1, Math.floor(size / (modules + 4)))
  return qr.createDataURL(cellSize, 2)
}

async function _openBindIlinkModal() {
  openModal(`
    <h3>绑定微信告警通道</h3>
    <div id="al-qr-box" style="text-align:center;padding:20px">
      <div class="loading">正在向 iLink 申请二维码…</div>
    </div>
    <div class="form-actions">
      <button id="al-qr-cancel">取消</button>
    </div>
  `)
  const abort = { aborted: false }
  ALERTS_STATE.qrAbortFlag = abort
  $('al-qr-cancel').addEventListener('click', () => {
    abort.aborted = true
    closeModal()
  })

  let qrResp
  try {
    qrResp = await apiJson('POST', '/api/admin/alerts/ilink/qrcode', {})
  } catch (e) {
    if (!abort.aborted) {
      $('al-qr-box').innerHTML = `<div class="error">申请二维码失败: ${escapeHtml(e.message)}</div>`
    }
    return
  }
  if (abort.aborted) return

  const qrcode = qrResp.qrcode
  // iLink 给的 qrcode_img_content 是"扫码后要跳转的 liteapp.weixin.qq.com 短链",
  // 不是图片 URL 也不是 base64 PNG —— 必须客户端自己把这段字符串 encode 成 QR 图。
  // 复用 SPA 侧 wechat.js 用的 qrcode-generator 库(admin.html 已引入 /vendor/qrcode.min.js,
  // 挂到 window.qrcode)。fallback:万一哪天 iLink 真返 data:/https://图片 URL,也能直接塞。
  const raw = qrResp.qrcode_img_content || ''
  let imgSrc = ''
  if (raw) {
    if (raw.startsWith('data:')) {
      imgSrc = raw
    } else if (/^https?:\/\/.*\.(png|jpe?g|gif|svg|webp)(\?|$)/i.test(raw)) {
      // 罕见:iLink 以后直接返真图片 URL 时直接用
      imgSrc = raw
    } else {
      try {
        imgSrc = _qrDataUrl(raw)
      } catch (e) {
        console.error('[alerts] QR encode failed:', e)
      }
    }
  }
  $('al-qr-box').innerHTML = `
    <div style="color:var(--muted);font-size:13px;margin-bottom:8px">
      用<strong>已注册该机器人的微信</strong>扫码,然后点确认;确认后请再向机器人发任意一句话以捕获 context_token。
    </div>
    ${imgSrc
      ? `<img src="${escapeHtml(imgSrc)}" alt="iLink QR" style="max-width:240px;border:1px solid var(--border)" />`
      : `<div class="error">iLink 没返回 QR 图片</div>`}
    <div id="al-qr-status" style="margin-top:8px;color:var(--muted);font-size:12px">等待扫码… (会长轮询直到 ~120s 过期)</div>
  `

  // ~120s 超时(iLink QR 过期大致这个时间)—— 每轮 poll 自己 ~35s,所以最多 3~4 轮
  const deadline = Date.now() + 125_000
  while (!abort.aborted && Date.now() < deadline) {
    let poll
    try {
      poll = await apiJson('POST', '/api/admin/alerts/ilink/poll', { qrcode })
    } catch (e) {
      if (abort.aborted) return
      $('al-qr-status').innerHTML = `<span style="color:var(--danger)">poll 失败: ${escapeHtml(e.message)}</span>`
      break
    }
    if (abort.aborted) return
    if (poll?.status === 'confirmed') {
      $('al-qr-status').innerHTML = '<span style="color:var(--ok)">扫码成功 ✓</span>'
      toast(`通道已绑定: ${poll.channel?.label ?? ''}`)
      closeModal()
      _refreshAlertChannels()
      return
    }
    // pending 继续下一轮
  }
  if (!abort.aborted) {
    $('al-qr-status').innerHTML = '<span style="color:var(--warn)">超时,请重新打开</span>'
  }
}

async function _openCreateTelegramModal() {
  // Telegram 通道没有扫码流程 —— admin 从 BotFather 拿到 bot_token,
  // 再把 bot 拉进目标 chat 拿到 chat_id(数字 ID 或 @username),直接填表创建。
  // severity_min 默认 warning;event_types 留空 = 订阅全部(跟 iLink 一致)。
  const groups = {}
  for (const e of (ALERTS_STATE.events || [])) {
    groups[e.group] = groups[e.group] || []
    groups[e.group].push(e)
  }
  const groupNames = Object.keys(groups)
  const eventsHtml = groupNames.length === 0
    ? '<div class="muted" style="font-size:12px">事件目录未加载</div>'
    : groupNames.map((g) => `
        <div style="margin-bottom:6px">
          <div style="font-weight:600;font-size:12px;color:var(--muted);margin-bottom:2px">${escapeHtml(g)}</div>
          ${groups[g].map((e) => `
            <label style="display:inline-block;margin-right:8px;font-weight:normal;font-size:12px">
              <input type="checkbox" data-event="${escapeHtml(e.event_type)}">
              ${escapeHtml(e.event_type)}
            </label>
          `).join('')}
        </div>
      `).join('')
  openModal(`
    <h3>添加 Telegram 告警通道</h3>
    <div style="color:var(--muted);font-size:12px;margin-bottom:10px;line-height:1.5">
      步骤:<br>
      1. 用 Telegram 找 <code>@BotFather</code>,<code>/newbot</code> 拿 bot_token (形如 <code>123456:ABC-xxx</code>)<br>
      2. 把 bot 添加到目标 chat / channel,或直接跟它私聊<br>
      3. 获取 chat_id:数字 ID(私聊填数字,群聊填 <code>-100…</code>)或 <code>@channelusername</code>
    </div>
    <div class="form-row">
      <label>标签 label(必填,1..64)</label>
      <input type="text" id="al-tg-label" maxlength="64" placeholder="例如 ops-alert-tg" />
    </div>
    <div class="form-row">
      <label>Bot Token(必填)</label>
      <input type="password" id="al-tg-token" autocomplete="new-password" placeholder="123456:ABC-xxx…" spellcheck="false" />
    </div>
    <div class="form-row">
      <label>Chat ID(必填,数字 或 @username)</label>
      <input type="text" id="al-tg-chat" maxlength="64" placeholder="-1001234567890 或 @my_channel" spellcheck="false" />
    </div>
    <div class="form-row">
      <label>最低严重度</label>
      <select id="al-tg-severity">
        <option value="info">info</option>
        <option value="warning" selected>warning</option>
        <option value="critical">critical</option>
      </select>
    </div>
    <div class="form-row">
      <label>订阅事件(留空 = 全部)</label>
      <div id="al-tg-events" style="max-height:180px;overflow:auto;border:1px solid var(--border);padding:8px;border-radius:4px">
        ${eventsHtml}
      </div>
    </div>
    <div class="form-actions">
      <button id="al-tg-cancel">取消</button>
      <button class="btn-primary" id="al-tg-ok">创建</button>
    </div>
  `)
  $('al-tg-cancel').addEventListener('click', closeModal)
  $('al-tg-ok').addEventListener('click', async (ev) => {
    const label = $('al-tg-label').value.trim()
    const bot_token = $('al-tg-token').value.trim()
    const chat_id = $('al-tg-chat').value.trim()
    const severity_min = $('al-tg-severity').value
    if (!label) { toast('label 必填', 'danger'); return }
    if (!bot_token) { toast('bot_token 必填', 'danger'); return }
    if (!chat_id) { toast('chat_id 必填', 'danger'); return }
    const event_types = []
    for (const cb of $('al-tg-events').querySelectorAll('input[type=checkbox]')) {
      if (cb.checked) event_types.push(cb.dataset.event)
    }
    await withBtnLoading(ev.currentTarget, async () => {
      try {
        const r = await apiJson('POST', '/api/admin/alerts/channels/telegram', {
          label, bot_token, chat_id, severity_min, event_types,
        })
        toast(`通道已创建: ${r.channel?.label ?? label}`)
        closeModal()
        _refreshAlertChannels()
      } catch (e) {
        toast(`失败: ${e.message}`, 'danger', toastOptsFromError(e))
      }
    })
  })
}

// ── outbox ──────────────────────────────────────────────────────────

async function _refreshAlertOutbox() {
  const el = $('al-outbox')
  if (!el) return
  el.innerHTML = '<div class="loading">加载中…</div>'
  const sp = new URLSearchParams({ limit: '50' })
  const f = ALERTS_STATE.outboxFilter
  if (f.event_type) sp.set('event_type', f.event_type)
  if (f.status) sp.set('status', f.status)
  // severity 后端不支持直接过滤,前端 filter
  try {
    const d = await apiGet(`/api/admin/alerts/outbox?${sp.toString()}`)
    let rows = d?.rows ?? []
    if (f.severity) rows = rows.filter((r) => r.severity === f.severity)
    if (rows.length === 0) {
      el.innerHTML = '<div class="empty">无记录。</div>'
      return
    }
    el.innerHTML = `
      <table class="data">
        <thead>
          <tr>
            <th>#</th><th>时间</th><th>事件</th><th>严重度</th>
            <th>状态</th><th>通道</th><th>尝试</th><th>标题 / 错误</th>
            <th class="actions">操作</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(_renderOutboxRow).join('')}
        </tbody>
      </table>
    `
    for (const btn of el.querySelectorAll('button[data-act="retry-outbox"]')) {
      btn.addEventListener('click', (ev) => _retryOutbox(btn.dataset.id, ev.currentTarget))
    }
  } catch (e) {
    el.innerHTML = `<div class="error">加载 outbox 失败: ${escapeHtml(e.message)}</div>`
  }
}

function _renderOutboxRow(r) {
  const sevBadge = `<span class="badge ${r.severity === 'critical' ? 'danger' : r.severity === 'warning' ? 'warn' : 'muted'}">${escapeHtml(r.severity)}</span>`
  const statBadge = r.status === 'sent' ? '<span class="badge ok">sent</span>'
    : r.status === 'failed' ? '<span class="badge danger">failed</span>'
    : r.status === 'pending' ? '<span class="badge warn">pending</span>'
    : r.status === 'suppressed' ? '<span class="badge muted">suppressed</span>'
    : `<span class="badge muted">${escapeHtml(r.status)}</span>`
  const titleOrErr = r.status === 'failed' && r.last_error
    ? `<span style="color:var(--danger)" title="${escapeHtml(r.last_error)}">${escapeHtml(r.last_error.slice(0, 80))}</span>`
    : escapeHtml(r.title || '')
  // 仅 status=failed 且 attempts<10 才显示重试。MAX_ATTEMPTS=10 在后端,前端
  // 用 attempts>=10 当 dead-letter 阈值;若后端拒绝(NOT_RETRYABLE)则前端
  // 提示并刷新即可。
  const canRetry = r.status === 'failed' && Number(r.attempts || 0) < 10
  const action = canRetry
    ? `<button class="btn btn-sm" data-act="retry-outbox" data-id="${escapeHtml(r.id)}">重试</button>`
    : ''
  return `
    <tr>
      <td class="mono">${escapeHtml(r.id)}</td>
      <td class="mono">${fmtDate(r.created_at)}</td>
      <td class="mono">${escapeHtml(r.event_type)}</td>
      <td>${sevBadge}</td>
      <td>${statBadge}</td>
      <td class="mono">${escapeHtml(r.channel_id || '—')}</td>
      <td class="num">${Number(r.attempts || 0)}</td>
      <td style="max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${titleOrErr}</td>
      <td class="actions">${action}</td>
    </tr>
  `
}

async function _retryOutbox(id, btn) {
  if (!id) return
  if (btn) { btn.disabled = true; btn.textContent = '重试中…' }
  try {
    await apiJson('POST', `/api/admin/alerts/outbox/${encodeURIComponent(id)}/retry`)
    toast('已排入重试,dispatcher 5s 内执行')
    _refreshAlertOutbox()
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '重试' }
    if (e.code === 'NOT_RETRYABLE') {
      toast('该行不可重试(已发送 / 已耗尽预算 / 状态变更)', 'danger')
      _refreshAlertOutbox()
    } else {
      toast('重试失败: ' + e.message, 'danger', toastOptsFromError(e))
    }
  }
}

// ── silences ────────────────────────────────────────────────────────

async function _refreshAlertSilences() {
  const el = $('al-silences')
  if (!el) return
  el.innerHTML = '<div class="loading">加载中…</div>'
  try {
    const d = await apiGet('/api/admin/alerts/silences')
    const rows = d?.rows ?? []
    if (rows.length === 0) {
      el.innerHTML = '<div class="empty">当前无静默。</div>'
      return
    }
    el.innerHTML = `
      <table class="data">
        <thead>
          <tr>
            <th>#</th><th>状态</th><th>matcher</th><th>开始</th><th>结束</th>
            <th>原因</th><th>创建人</th><th class="actions">操作</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(_renderSilenceRow).join('')}
        </tbody>
      </table>
    `
    for (const btn of el.querySelectorAll('button[data-act="delete-silence"]')) {
      btn.addEventListener('click', (ev) => _deleteSilence(btn.dataset.id, ev.currentTarget))
    }
  } catch (e) {
    el.innerHTML = `<div class="error">加载 silences 失败: ${escapeHtml(e.message)}</div>`
  }
}

function _renderSilenceRow(s) {
  const m = s.matcher || {}
  const parts = []
  if (m.event_type) parts.push(`event=${escapeHtml(m.event_type)}`)
  if (m.severity) parts.push(`severity=${escapeHtml(m.severity)}`)
  if (m.rule_id) parts.push(`rule=${escapeHtml(m.rule_id)}`)
  const matcher = parts.length > 0
    ? `<span class="mono" style="font-size:12px">${parts.join(' · ')}</span>`
    : '<span class="badge danger">空 matcher</span>'
  const status = s.active
    ? '<span class="badge warn">生效中</span>'
    : '<span class="badge muted">已结束</span>'
  return `
    <tr>
      <td class="mono">${escapeHtml(s.id)}</td>
      <td>${status}</td>
      <td>${matcher}</td>
      <td class="mono">${fmtDate(s.starts_at)}</td>
      <td class="mono">${fmtDate(s.ends_at)}</td>
      <td>${escapeHtml(s.reason)}</td>
      <td class="mono">${escapeHtml(s.created_by || '—')}</td>
      <td class="actions">
        ${s.active
          ? `<button data-act="delete-silence" data-id="${escapeHtml(s.id)}" class="btn-danger">撤销</button>`
          : '—'}
      </td>
    </tr>
  `
}

async function _deleteSilence(id, btn) {
  if (!confirm(`撤销静默 #${id}?被它压制的事件会立即恢复告警。`)) return
  try {
    await withBtnLoading(btn, () => apiJson('DELETE', `/api/admin/alerts/silences/${id}`, null))
    toast('已撤销')
    _refreshAlertSilences()
  } catch (e) {
    toast(`失败: ${e.message}`, 'danger', toastOptsFromError(e))
  }
}

function _openCreateSilenceModal() {
  // 默认 1 小时后结束,最长 7d
  const now = new Date()
  const endDefault = new Date(now.getTime() + 60 * 60 * 1000)
  const localIso = (d) => {
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  openModal(`
    <h3>新建静默</h3>
    <div style="color:var(--muted);font-size:12px;margin-bottom:8px">
      matcher 三字段任选其一或多选(AND 关系,命中则不发)。窗口最长 7 天。
    </div>
    <div class="form-row">
      <label>事件类型(可选)</label>
      <select id="al-ns-event">
        <option value="">—</option>
        ${(ALERTS_STATE.events || []).map((e) =>
          `<option value="${escapeHtml(e.event_type)}">${escapeHtml(e.event_type)}</option>`,
        ).join('')}
      </select>
    </div>
    <div class="form-row">
      <label>严重度(可选)</label>
      <select id="al-ns-severity">
        <option value="">—</option>
        <option value="info">info</option>
        <option value="warning">warning</option>
        <option value="critical">critical</option>
      </select>
    </div>
    <div class="form-row">
      <label>rule_id(可选,用于静默 polled 规则)</label>
      <input type="text" id="al-ns-rule" placeholder="如 account_pool.all_down" maxlength="64" />
    </div>
    <div class="form-row">
      <label>结束时间</label>
      <input type="datetime-local" id="al-ns-ends" value="${localIso(endDefault)}" />
    </div>
    <div class="form-row">
      <label>原因(必填,1..200)</label>
      <input type="text" id="al-ns-reason" maxlength="200" placeholder="例如 周五例行演习" />
    </div>
    <div class="form-actions">
      <button id="al-ns-cancel">取消</button>
      <button class="btn-primary" id="al-ns-ok">创建</button>
    </div>
  `)
  $('al-ns-cancel').addEventListener('click', closeModal)
  $('al-ns-ok').addEventListener('click', async (ev) => {
    const event_type = $('al-ns-event').value
    const severity = $('al-ns-severity').value
    const rule_id = $('al-ns-rule').value.trim()
    const endsStr = $('al-ns-ends').value
    const reason = $('al-ns-reason').value.trim()
    const matcher = {}
    if (event_type) matcher.event_type = event_type
    if (severity) matcher.severity = severity
    if (rule_id) matcher.rule_id = rule_id
    if (Object.keys(matcher).length === 0) { toast('至少填一个 matcher 字段', 'danger'); return }
    if (!endsStr) { toast('结束时间必填', 'danger'); return }
    const endsAt = new Date(endsStr)
    if (Number.isNaN(endsAt.getTime()) || endsAt.getTime() <= Date.now()) {
      toast('结束时间必须晚于当前', 'danger'); return
    }
    if (endsAt.getTime() - Date.now() > 7 * 24 * 60 * 60 * 1000) {
      toast('窗口最长 7 天', 'danger'); return
    }
    if (!reason) { toast('原因必填', 'danger'); return }
    await withBtnLoading(ev.currentTarget, async () => {
      try {
        await apiJson('POST', '/api/admin/alerts/silences', {
          matcher,
          ends_at: endsAt.toISOString(),
          reason,
        })
        toast('已创建')
        closeModal()
        _refreshAlertSilences()
      } catch (e) {
        toast(`失败: ${e.message}`, 'danger', toastOptsFromError(e))
      }
    })
  })
}

// ── rule_states ─────────────────────────────────────────────────────

async function _refreshAlertRuleStates() {
  const el = $('al-rule-states')
  if (!el) return
  el.innerHTML = '<div class="loading">加载中…</div>'
  try {
    const d = await apiGet('/api/admin/alerts/rule-states')
    const rows = d?.rows ?? []
    if (rows.length === 0) {
      el.innerHTML = '<div class="empty">尚无规则状态(scheduler 还没跑过一轮)。</div>'
      return
    }
    el.innerHTML = `
      <table class="data">
        <thead>
          <tr>
            <th>rule_id</th><th>状态</th><th>ack</th><th>dedupe_key</th>
            <th>最近翻转</th><th>最近评估</th><th>最近 payload</th>
            <th class="actions">操作</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(_renderRuleStateRow).join('')}
        </tbody>
      </table>
    `
    for (const btn of el.querySelectorAll('button[data-act="ack-rule"]')) {
      btn.addEventListener('click', (ev) => _ackRule(btn.dataset.ruleId, ev.currentTarget))
    }
  } catch (e) {
    el.innerHTML = `<div class="error">加载 rule_states 失败: ${escapeHtml(e.message)}</div>`
  }
}

function _renderRuleStateRow(r) {
  // 三态:firing=true,acked=false → open; firing=true,acked=true → acked;
  // firing=false → resolved(acked 字段无意义)。
  let statusBadge, ackCol, action
  if (!r.firing) {
    statusBadge = '<span class="badge ok">resolved</span>'
    ackCol = '<span style="color:var(--muted)">—</span>'
    action = ''
  } else if (r.acked) {
    statusBadge = '<span class="badge warn">ACKED</span>'
    ackCol = `#${escapeHtml(r.acked_by || '?')} <span class="mono" style="color:var(--muted);font-size:11px">${fmtDate(r.acked_at)}</span>`
    action = ''
  } else {
    statusBadge = '<span class="badge danger">FIRING</span>'
    ackCol = '<span style="color:var(--muted)">未确认</span>'
    action = `<button class="btn btn-sm" data-act="ack-rule" data-rule-id="${escapeHtml(r.rule_id)}">确认</button>`
  }
  const payload = JSON.stringify(r.last_payload || {})
  return `
    <tr>
      <td class="mono">${escapeHtml(r.rule_id)}</td>
      <td>${statusBadge}</td>
      <td>${ackCol}</td>
      <td class="mono" style="font-size:12px">${escapeHtml(r.dedupe_key || '—')}</td>
      <td class="mono">${fmtDate(r.last_transition_at)}</td>
      <td class="mono">${fmtDate(r.last_evaluated_at)}</td>
      <td class="mono" style="font-size:12px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
          title="${escapeHtml(payload)}">${escapeHtml(payload)}</td>
      <td class="actions">${action}</td>
    </tr>
  `
}

async function _ackRule(ruleId, btn) {
  if (!ruleId) return
  if (btn) { btn.disabled = true; btn.textContent = '确认中…' }
  try {
    await apiJson('POST', `/api/admin/alerts/rules/${encodeURIComponent(ruleId)}/ack`)
    toast('已确认')
    _refreshAlertRuleStates()
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '确认' }
    if (e.code === 'NOT_FIRING') {
      toast('规则当前未在 firing,无需确认', 'danger')
      _refreshAlertRuleStates()
    } else {
      toast('确认失败: ' + e.message, 'danger', toastOptsFromError(e))
    }
  }
}

// ─── Tab: Hosts (V3 D.4 虚机池) ─────────────────────────────────────
//
// 后端路由:
//   GET  /api/admin/v3/compute-hosts
//   POST /api/admin/v3/compute-hosts/add
//   GET  /api/admin/v3/compute-hosts/:id/bootstrap-log
//   POST /api/admin/v3/compute-hosts/:id/drain|remove|quarantine-clear
//   GET  /api/admin/v3/baseline-version
//
// 刷新策略:首屏并行拉 list + baseline-version,进入 tab 后每 5s 轮询一次。
// 切 tab 时 TAB_CLEANUPS.hosts 清 interval,不泄漏。

const HOSTS_STATE = {
  rows: [],
  baseline: null,
  renderSeq: 0,
  refreshTimer: null,
  focusUuid: '',  // deeplink 高亮用,render 时读 sessionStorage / pendingDeeplink
}

async function renderHostsTab() {
  const mySeq = ++HOSTS_STATE.renderSeq

  // deeplink:pendingDeeplink 优先,fallback sessionStorage(刷新页保活)
  HOSTS_STATE.focusUuid = sessionStorage.getItem('admin_h_focus_uuid') || ''
  if (pendingDeeplink && pendingDeeplink.tab === 'hosts') {
    const p = pendingDeeplink.params
    if (p.has('focus_uuid')) HOSTS_STATE.focusUuid = p.get('focus_uuid')
    pendingDeeplink = null
  }

  view().innerHTML = `
    <div class="panel">
      <h1 style="margin-top:0">虚机池 <small style="color:var(--muted);font-weight:400;font-size:14px" id="h-count">加载中…</small></h1>
      <div id="h-baseline" style="margin-bottom:16px"></div>
      <div class="toolbar">
        <button class="btn" id="h-refresh">刷新</button>
        <span class="spacer"></span>
        <button class="btn btn-primary" id="h-new">+ 添加虚机</button>
      </div>
      <div id="h-table-container"><div class="empty">加载中…</div></div>
    </div>
  `
  $('h-refresh').addEventListener('click', () => _loadHostsData(HOSTS_STATE.renderSeq))
  $('h-new').addEventListener('click', openAddHostModal)

  await _loadHostsData(mySeq)

  // 5s 轮询 —— bootstrap/health 状态会自行推进,让 UI 跟上
  if (HOSTS_STATE.refreshTimer) clearInterval(HOSTS_STATE.refreshTimer)
  HOSTS_STATE.refreshTimer = setInterval(() => {
    if (_currentTab !== 'hosts') return
    _loadHostsData(HOSTS_STATE.renderSeq)
  }, 5000)
}

async function _loadHostsData(renderSeq) {
  let listRes, baselineRes
  try {
    ;[listRes, baselineRes] = await Promise.all([
      apiGet('/api/admin/v3/compute-hosts'),
      apiGet('/api/admin/v3/baseline-version'),
    ])
  } catch (err) {
    if (renderSeq !== HOSTS_STATE.renderSeq || _currentTab !== 'hosts') return
    const el = $('h-table-container')
    if (el) el.innerHTML = `<div class="empty" style="color:var(--danger)">加载失败:${escapeHtml(err.message)}</div>`
    const cnt = $('h-count'); if (cnt) cnt.textContent = '—'
    return
  }
  if (renderSeq !== HOSTS_STATE.renderSeq || _currentTab !== 'hosts') return

  HOSTS_STATE.rows = listRes?.hosts ?? []
  HOSTS_STATE.baseline = baselineRes ?? null
  _renderBaselineCard()
  _renderHostsTable()
}

function _renderBaselineCard() {
  const el = $('h-baseline')
  if (!el) return
  const b = HOSTS_STATE.baseline
  if (!b) { el.innerHTML = ''; return }
  const masterV = b.master_version
    ? `<code style="font-size:13px">${escapeHtml(b.master_version)}</code>`
    : `<span style="color:var(--danger)">未初始化${b.master_err ? ` · ${escapeHtml(b.master_err)}` : ''}</span>`
  const perHost = b.per_host || []
  const perHostHtml = perHost.length === 0
    ? '<span style="color:var(--muted);font-size:13px">(暂无远程虚机)</span>'
    : perHost.map((h) => {
        const match = b.master_version && h.remote_version === b.master_version
        const cls = h.err ? 'chip-danger' : match ? 'chip-ok' : 'chip-warn'
        const label = h.err
          ? `${h.name}: ERR`
          : `${h.name}: ${h.remote_version || '—'}`
        const title = h.err ? h.err : (h.remote_version || '')
        return `<span class="chip ${cls}" title="${escapeHtml(title)}" style="margin-right:4px">${escapeHtml(label)}</span>`
      }).join('')
  el.innerHTML = `
    <div style="background:var(--panel-2); border:1px solid var(--border); border-radius:8px; padding:10px 12px;">
      <div style="font-size:12px;color:var(--muted);margin-bottom:4px">Baseline 版本</div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">
        <span>master: ${masterV}</span>
        <span style="color:var(--muted)">·</span>
        <span>per-host: ${perHostHtml}</span>
      </div>
    </div>
  `
}

function _hostStatusBadge(status) {
  const cls = status === 'ready' ? 'ok'
    : status === 'bootstrapping' || status === 'draining' ? 'warn'
    : status === 'quarantined' ? 'warn'
    : status === 'broken' || status === 'removed' ? 'danger'
    : 'muted'
  return `<span class="badge ${cls}">${escapeHtml(status)}</span>`
}

// 0042: 显示真实 placement gate(后端 SQL 与调度路径同一份 PLACEMENT_GATE_PREDICATE 算出)。
// status='ready' 不等于真的可调度;loaded_image_id ≠ desired / 任一维度 stale 都会让 gate 关闭。
// open=true → 绿色 "gate open"
// open=false → 黄色 "gate closed",tooltip 列出**诊断/可能原因**(不权威 — 真值以后端 predicate 为准)
function _placementGateChip(h) {
  if (h.placement_gate_open === true) {
    return `<span class="chip chip-ok" title="placement gate 通过 — 调度路径会考虑这台 host">gate open</span>`
  }
  if (h.placement_gate_open !== false) {
    // 老后端 / 字段缺失 → 不渲染避免误导
    return ''
  }
  // 拼诊断/可能原因(本地观测 — 与后端 NOW() 可能有秒级偏差,仅供人工 debug)
  const reasons = []
  if (h.status !== 'ready') reasons.push(`状态 = ${h.status}(非 ready)`)
  if (h.desired_image_id == null) reasons.push('desired_image_id 未初始化(pool 还在 warmup?)')
  else if (h.loaded_image_id == null) reasons.push('loaded_image_id 未上报(node-agent selfprobe 没跑过)')
  else if (h.loaded_image_id !== h.desired_image_id) {
    reasons.push(`镜像不一致: loaded=${(h.loaded_image_id || '').slice(0, 19)}… ≠ desired=${(h.desired_image_id || '').slice(0, 19)}…`)
  }
  // self host 跳过维度新鲜度 — 仅当 name!=='self' 时检查
  if (h.name !== 'self') {
    const nowMs = Date.now()
    const FRESH_MS = 60 * 1000
    const checkDim = (label, ok, atIso) => {
      if (ok === false) reasons.push(`${label} = false`)
      else if (ok == null) reasons.push(`${label} 未上报`)
      else if (atIso == null) {
        // SQL gate 显式要求 last_*_at IS NOT NULL,即使 ok=true 这里也会关闭
        reasons.push(`${label} timestamp 未上报`)
      }
      else {
        const t = new Date(atIso).getTime()
        if (Number.isFinite(t) && nowMs - t > FRESH_MS) {
          const ageS = Math.round((nowMs - t) / 1000)
          reasons.push(`${label} 过期(${ageS}s 前)`)
        }
      }
    }
    checkDim('health endpoint', h.last_health_endpoint_ok, h.last_health_poll_at)
    checkDim('uplink', h.last_uplink_ok, h.last_uplink_at)
    checkDim('egress', h.last_egress_probe_ok, h.last_egress_probe_at)
  }
  const tip = reasons.length > 0
    ? `诊断/可能原因(以后端为准):\n- ${reasons.join('\n- ')}`
    : '诊断/可能原因:placement gate 关闭,但客户端无法定位具体维度(后端 predicate 与本地观测可能有秒级偏差)'
  return `<span class="chip chip-warn" title="${escapeHtml(tip)}">gate closed</span>`
}

function _certChipForHost(h) {
  if (!h.cert_not_after) return '<span style="color:var(--muted)">—</span>'
  const ms = new Date(h.cert_not_after).getTime() - Date.now()
  if (Number.isNaN(ms)) return escapeHtml(h.cert_not_after)
  const days = Math.floor(ms / 86400000)
  if (days < 0) return `<span class="chip chip-danger" title="${escapeHtml(fmtDate(h.cert_not_after))}">已过期</span>`
  if (days < 7) return `<span class="chip chip-warn" title="${escapeHtml(fmtDate(h.cert_not_after))}">${days}d</span>`
  return `<span class="chip chip-muted" title="${escapeHtml(fmtDate(h.cert_not_after))}">${days}d</span>`
}

// 0041: VPS 租期到期 chip。
// 无值 → 灰底"—"按钮(点击设置);有值 → 按"剩余天数"红/黄/灰,点击编辑。
// 可点击区域用 button data-act="h-set-exp" 让外层 event delegation 接管(避免 inline onclick)。
function _expiresChipForHost(h) {
  const idAttr = escapeHtml(h.id || '')
  const nameAttr = escapeHtml(h.name || '')
  if (!h.expires_at) {
    return `<button class="chip chip-muted" data-act="h-set-exp" data-id="${idAttr}" data-name="${nameAttr}" data-current="" title="点击设置 VPS 到期" style="cursor:pointer">设置</button>`
  }
  const ms = new Date(h.expires_at).getTime() - Date.now()
  const tipFull = escapeHtml(fmtDate(h.expires_at))
  const dataCurrent = escapeHtml(h.expires_at)
  const baseAttrs = `data-act="h-set-exp" data-id="${idAttr}" data-name="${nameAttr}" data-current="${dataCurrent}" style="cursor:pointer"`
  if (Number.isNaN(ms)) {
    return `<button class="chip chip-muted" ${baseAttrs} title="${tipFull}">${escapeHtml(h.expires_at)}</button>`
  }
  const days = Math.floor(ms / 86400000)
  if (days < 0) {
    return `<button class="chip chip-danger" ${baseAttrs} title="${tipFull}">已过期</button>`
  }
  if (days < 7) {
    return `<button class="chip chip-warn" ${baseAttrs} title="${tipFull}">${days}d</button>`
  }
  return `<button class="chip chip-muted" ${baseAttrs} title="${tipFull}">${days}d</button>`
}

// 0041: 把 ISO8601(UTC)转成 datetime-local 控件能消费的"北京时间(UTC+8)墙钟"字符串
// `YYYY-MM-DDTHH:mm`。手算 +8h offset 用 UTC 字段读出墙钟,避免依赖浏览器本地时区。
function isoToShanghaiInputValue(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const sh = new Date(d.getTime() + 8 * 3600 * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${sh.getUTCFullYear()}-${pad(sh.getUTCMonth() + 1)}-${pad(sh.getUTCDate())}T${pad(sh.getUTCHours())}:${pad(sh.getUTCMinutes())}`
}

// 0041: datetime-local 输入(`YYYY-MM-DDTHH:mm`)+ 北京时区 → ISO8601 with offset。
// 空串 → null。返回值直接 POST 到后端(后端正则校验只接 +08:00 这种带冒号 offset)。
function shanghaiInputToIso(val) {
  const s = (val ?? '').trim()
  if (!s) return null
  // datetime-local 缺秒:补 ":00";拼上东八区 offset 让后端把这串当北京时间解析
  return `${s}:00+08:00`
}

function _renderHostsTable() {
  const el = $('h-table-container')
  if (!el) return
  const rows = HOSTS_STATE.rows
  const cnt = $('h-count'); if (cnt) cnt.textContent = `共 ${rows.length} 台`
  if (rows.length === 0) {
    el.innerHTML = '<div class="empty">无虚机</div>'
    return
  }
  el.innerHTML = `
    <table class="data">
      <thead>
        <tr>
          <th>name</th>
          <th>host:port</th>
          <th>状态</th>
          <th class="num">active / max</th>
          <th title="磁盘 / 内存 / load1 (1min) / 5min 请求数 — 每 5min 采集一次">资源</th>
          <th>cert 到期</th>
          <th>VPS 到期</th>
          <th>最近健康</th>
          <th>最近 bootstrap</th>
          <th class="actions">操作</th>
        </tr>
      </thead>
      <tbody>${rows.map(_renderHostRow).join('')}</tbody>
    </table>
  `
  for (const b of el.querySelectorAll('button[data-act="h-log"]')) {
    b.addEventListener('click', () => openBootstrapLogModal(b.dataset.id, b.dataset.name))
  }
  for (const b of el.querySelectorAll('button[data-act="h-drain"]')) {
    b.addEventListener('click', (ev) => drainHost(b.dataset.id, b.dataset.name, ev.currentTarget))
  }
  for (const b of el.querySelectorAll('button[data-act="h-remove"]')) {
    b.addEventListener('click', (ev) => removeHost(b.dataset.id, b.dataset.name, ev.currentTarget))
  }
  for (const b of el.querySelectorAll('button[data-act="h-clearq"]')) {
    b.addEventListener('click', (ev) => clearHostQuarantine(b.dataset.id, b.dataset.name, ev.currentTarget))
  }
  // 0041:VPS 到期 chip 点击 → 编辑模态
  for (const b of el.querySelectorAll('button[data-act="h-set-exp"]')) {
    b.addEventListener('click', () => openSetExpiresModal(b.dataset.id, b.dataset.name, b.dataset.current || ''))
  }
  // active/max 链跳:跳 containers tab + host_uuid 过滤
  for (const a of el.querySelectorAll('a[data-nav]')) {
    a.addEventListener('click', (e) => {
      e.preventDefault()
      navigate(a.dataset.nav, _navQueryFrom(a))
    })
  }
  // focus 高亮 + scrollIntoView(deeplink 跳过来时)
  if (HOSTS_STATE.focusUuid) {
    const tr = el.querySelector(`tr[data-host-uuid="${CSS.escape(HOSTS_STATE.focusUuid)}"]`)
    if (tr) {
      tr.classList.add('is-focused')
      tr.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }
}

function _renderHostRow(h) {
  const healthChip = h.last_health_ok === true
    ? `<span class="chip chip-ok" title="${escapeHtml(fmtDate(h.last_health_at || ''))}">OK</span>`
    : h.last_health_ok === false
      ? `<span class="chip chip-danger" title="${escapeHtml(h.last_health_err || '')}">FAIL</span>`
      : '<span style="color:var(--muted)">—</span>'
  // 连续 OK/FAIL 计数(3 次切换 quarantined ↔ ready)。新机两个都 0,不渲染避免噪声。
  const okN = (h.consecutive_health_ok | 0)
  const failN = (h.consecutive_health_fail | 0)
  const healthCounter = (okN > 0 || failN > 0)
    ? ` <small style="color:var(--muted)" title="连续 OK / 连续 FAIL(各 3 次切换状态)">${okN}/${failN}</small>`
    : ''
  const bootstrapChip = h.last_bootstrap_err
    ? `<span class="chip chip-danger" title="${escapeHtml(h.last_bootstrap_err)}">ERR</span>`
    : h.last_bootstrap_at
      ? `<span class="chip chip-ok" title="${escapeHtml(fmtDate(h.last_bootstrap_at))}">OK</span>`
      : '<span style="color:var(--muted)">—</span>'
  const isSelf = h.name === 'self'
  const canDrain = !isSelf && (h.status === 'ready' || h.status === 'quarantined' || h.status === 'broken')
  const canRemove = !isSelf && h.status === 'draining' && (h.active_containers | 0) === 0
  const canClearQ = h.status === 'quarantined'
  const nameAttr = escapeHtml(h.name)
  const idAttr = escapeHtml(h.id)
  const btns = []
  btns.push(`<button data-act="h-log" data-id="${idAttr}" data-name="${nameAttr}">日志</button>`)
  if (canClearQ) btns.push(`<button data-act="h-clearq" data-id="${idAttr}" data-name="${nameAttr}">解除隔离</button>`)
  if (canDrain) btns.push(`<button data-act="h-drain" data-id="${idAttr}" data-name="${nameAttr}">排空</button>`)
  if (canRemove) btns.push(`<button data-act="h-remove" data-id="${idAttr}" data-name="${nameAttr}" style="color:var(--danger)">删除</button>`)
  // active/max 链跳容器列表 + host_uuid 过滤
  const activeStr = `${h.active_containers | 0} / ${h.max_containers | 0}`
  const activeCell = h.id
    ? `<a class="num" data-nav="containers" data-q-host_uuid="${escapeHtml(h.id)}" title="查看该 host 上的容器">${activeStr}</a>`
    : `<span class="num">${activeStr}</span>`
  return `
    <tr data-host-uuid="${escapeHtml(h.id || '')}">
      <td><strong>${escapeHtml(h.name)}</strong>${isSelf ? ' <small style="color:var(--muted)">(master)</small>' : ''}</td>
      <td class="mono">${escapeHtml(h.host)}:${h.ssh_port}${h.agent_port && h.agent_port !== 9443 ? ` <small style="color:var(--muted)">(agent ${h.agent_port})</small>` : ''}</td>
      <td>${_hostStatusBadge(h.status)} ${_placementGateChip(h)}</td>
      <td>${activeCell}</td>
      <td>${_metricsCellForHost(h)}</td>
      <td>${_certChipForHost(h)}</td>
      <td>${_expiresChipForHost(h)}</td>
      <td>${healthChip}${healthCounter}</td>
      <td>${bootstrapChip}</td>
      <td class="actions">${btns.join(' ')}</td>
    </tr>
  `
}

// 0045 — 主机系统层资源 cell。4 chip 紧凑横排:磁盘 / 内存 / load / 5min req。
// metrics_at 为 null 或 > 10min 旧时整行灰化并加 stale tag。
//
// 阈值与 alerts_disk_high_warn_pct/critical_pct (默认 85/95) 对齐,UX 一致性:
// 用户看到 84% 行黄色 = 没收到告警;88% 行黄色 = 已发 warn 告警。
function _metricsCellForHost(h) {
  const STALE_MS = 10 * 60 * 1000
  const now = Date.now()
  const at = h.metrics_at ? Date.parse(h.metrics_at) : NaN
  const isStale = !Number.isFinite(at) || (now - at) > STALE_MS

  const pctChip = (label, val, warnPct, critPct) => {
    if (val === null || val === undefined) return `<span class="chip" style="background:transparent;color:var(--muted);padding:0 4px">${label}—</span>`
    let cls = 'chip-ok'
    if (val >= critPct) cls = 'chip-danger'
    else if (val >= warnPct) cls = 'chip-warn'
    return `<span class="chip ${cls}" style="padding:0 6px" title="${label} ${val}%">${label}${val}%</span>`
  }
  const loadChip = () => {
    if (h.load1 === null || h.load1 === undefined) return '<span class="chip" style="background:transparent;color:var(--muted);padding:0 4px">load—</span>'
    const cpu = (h.cpu_count | 0) || 1
    const ratio = h.load1 / cpu
    let cls = 'chip-ok'
    if (ratio >= 1.5) cls = 'chip-danger'
    else if (ratio >= 1.0) cls = 'chip-warn'
    const loadStr = Number(h.load1).toFixed(2)
    return `<span class="chip ${cls}" style="padding:0 6px" title="load1=${loadStr} / ${cpu} cpu = ${ratio.toFixed(2)}/cpu">L${loadStr}</span>`
  }
  const reqChip = () => {
    const n = h.req_5m | 0
    return `<span class="chip" style="padding:0 6px;background:var(--panel-2);color:var(--fg)" title="过去 5 分钟内 /v1/messages 请求数(in-memory 计数器)">${n} req</span>`
  }
  const stale = isStale
    ? '<small style="color:var(--muted);margin-left:6px" title="metrics 未更新或超过 10 分钟未刷新 — 等下一轮 5min tick">stale</small>'
    : ''
  const opacity = isStale ? 'opacity:0.55;' : ''
  return `<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;${opacity}">${pctChip('D', h.disk_pct, 85, 95)}${pctChip('M', h.mem_pct, 85, 95)}${loadChip()}${reqChip()}${stale}</div>`
}

// ─── Hosts: add modal ────────────────────────────────────────────────

function openAddHostModal() {
  openModal(`
    <h3>添加虚机</h3>
    <div style="font-size:12px;color:var(--muted);margin-bottom:10px">
      master 会 SSH 到目标机装 node-agent、签证书、起代理。完成后轮询 bootstrap 日志可看进度。
    </div>
    <div class="form-row"><label>name</label>
      <input type="text" id="nh-name" placeholder="tk-01" maxlength="64" />
    </div>
    <div class="form-row"><label>host</label>
      <input type="text" id="nh-host" placeholder="1.2.3.4 或 host.example.com" />
    </div>
    <div class="form-row"><label>ssh_port</label>
      <input type="number" id="nh-ssh-port" value="22" min="1" max="65535" />
    </div>
    <div class="form-row"><label>ssh_user</label>
      <input type="text" id="nh-ssh-user" value="root" maxlength="64" />
    </div>
    <div class="form-row"><label>password</label>
      <input type="password" id="nh-password" placeholder="SSH 密码(AES-GCM 存库)" autocomplete="new-password" />
    </div>
    <div class="form-row"><label>agent_port</label>
      <input type="number" id="nh-agent-port" value="9443" min="1024" max="65535" />
    </div>
    <div class="form-row"><label>bridge_cidr</label>
      <input type="text" id="nh-bridge-cidr" placeholder="172.30.1.0/24" />
      <small style="color:var(--muted);font-size:12px">容器网段,各虚机不能重叠</small>
    </div>
    <div class="form-row"><label>max_containers</label>
      <input type="number" id="nh-max" value="20" min="1" max="200" />
    </div>
    <div class="form-row"><label>VPS 到期</label>
      <input type="datetime-local" id="nh-expires" />
      <small style="color:var(--muted);font-size:12px">北京时间(UTC+8),可留空</small>
    </div>
    <div class="form-actions">
      <button id="nh-cancel">取消</button>
      <button class="btn-primary" id="nh-ok">添加并 Bootstrap</button>
    </div>
  `)
  $('nh-cancel').addEventListener('click', closeModal)
  $('nh-ok').addEventListener('click', async (ev) => {
    const body = {
      name: $('nh-name').value.trim(),
      host: $('nh-host').value.trim(),
      ssh_port: Number($('nh-ssh-port').value),
      ssh_user: $('nh-ssh-user').value.trim(),
      password: $('nh-password').value,
      agent_port: Number($('nh-agent-port').value),
      bridge_cidr: $('nh-bridge-cidr').value.trim(),
      max_containers: Number($('nh-max').value),
      expires_at: shanghaiInputToIso($('nh-expires').value),
    }
    if (!body.name || !body.host || !body.password || !body.bridge_cidr) {
      toast('请填完必填项', 'danger'); return
    }
    await withBtnLoading(ev.currentTarget, async () => {
      try {
        const r = await apiJson('POST', '/api/admin/v3/compute-hosts/add', body)
        toast(`已添加 ${body.name}(status=${r?.status || 'bootstrapping'})`)
        closeModal()
        // 立刻打开 bootstrap-log 让用户看进度
        if (r?.hostId) openBootstrapLogModal(r.hostId, body.name)
        _loadHostsData(HOSTS_STATE.renderSeq)
      } catch (e) {
        toast(`添加失败: ${e.message}`, 'danger', toastOptsFromError(e))
      }
    })
  })
}

// ─── Hosts: bootstrap-log modal (带轮询) ─────────────────────────────

let _bootstrapLogTimer = null
function openBootstrapLogModal(hostId, name) {
  // 关掉老 timer(反复打开时)
  if (_bootstrapLogTimer) { clearInterval(_bootstrapLogTimer); _bootstrapLogTimer = null }
  openModal(`
    <h3>Bootstrap 日志 · ${escapeHtml(name)}</h3>
    <div id="bl-body"><div class="loading">加载中…</div></div>
    <div class="form-actions">
      <button id="bl-close">关闭</button>
    </div>
  `)
  const stopPoll = () => { if (_bootstrapLogTimer) { clearInterval(_bootstrapLogTimer); _bootstrapLogTimer = null } }
  $('bl-close').addEventListener('click', () => { stopPoll(); closeModal() })

  const tick = async () => {
    // modal 已关(无 bl-body) → 停
    if (!$('bl-body')) { stopPoll(); return }
    let data
    try {
      data = await apiGet(`/api/admin/v3/compute-hosts/${encodeURIComponent(hostId)}/bootstrap-log`)
    } catch (e) {
      if (!$('bl-body')) { stopPoll(); return }
      $('bl-body').innerHTML = `<div class="error">读取失败: ${escapeHtml(e.message)}</div>`
      stopPoll()
      return
    }
    if (!$('bl-body')) { stopPoll(); return }
    const stepChip = data.failed_step
      ? `<span class="chip chip-danger" style="margin-left:6px">失败步骤: ${escapeHtml(data.failed_step)}</span>`
      : ''
    $('bl-body').innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
        <span>状态: ${_hostStatusBadge(data.status)}</span>
        ${stepChip}
      </div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:4px">最近 bootstrap 时间</div>
      <div class="mono" style="margin-bottom:10px">${data.last_bootstrap_at ? escapeHtml(fmtDate(data.last_bootstrap_at)) : '—'}</div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:4px">最近错误</div>
      <pre style="max-height:240px;overflow:auto;background:var(--panel-2);padding:10px;border-radius:6px;white-space:pre-wrap;word-break:break-word">${data.last_bootstrap_err ? escapeHtml(data.last_bootstrap_err) : '(无)'}</pre>
    `
    // bootstrapping 时继续轮询,其他终态停
    if (data.status !== 'bootstrapping') stopPoll()
  }
  tick()
  _bootstrapLogTimer = setInterval(tick, 3000)
}

// ─── Hosts: 0041 set expires_at modal ────────────────────────────────

function openSetExpiresModal(hostId, name, currentIso) {
  const initVal = isoToShanghaiInputValue(currentIso)
  openModal(`
    <h3>设置 VPS 到期 · ${escapeHtml(name)}</h3>
    <div style="font-size:12px;color:var(--muted);margin-bottom:10px">
      北京时间(UTC+8)。清空(永久/未填)请点"清空"按钮,直接留空保存会被拒绝。
    </div>
    <div class="form-row"><label>到期时间</label>
      <input type="datetime-local" id="he-input" value="${escapeHtml(initVal)}" />
    </div>
    <div class="form-actions">
      <button id="he-cancel">取消</button>
      <button id="he-clear">清空</button>
      <button class="btn-primary" id="he-ok">保存</button>
    </div>
  `)
  $('he-cancel').addEventListener('click', closeModal)
  const submit = async (ev, expiresAt /* string|null */) => {
    await withBtnLoading(ev.currentTarget, async () => {
      try {
        await apiJson('POST', `/api/admin/v3/compute-hosts/${encodeURIComponent(hostId)}/expires-at`, {
          expires_at: expiresAt,
        })
        toast(expiresAt ? `${name} 到期已更新` : `${name} 到期已清空`)
        closeModal()
        _loadHostsData(HOSTS_STATE.renderSeq)
      } catch (e) {
        toast(`保存失败: ${e.message}`, 'danger', toastOptsFromError(e))
      }
    })
  }
  $('he-clear').addEventListener('click', (ev) => submit(ev, null))
  $('he-ok').addEventListener('click', (ev) => {
    const iso = shanghaiInputToIso($('he-input').value)
    if (!iso) {
      toast('请先填写到期时间,或点"清空"', 'danger')
      return
    }
    submit(ev, iso)
  })
}

// ─── Hosts: drain / remove / clearQuarantine ─────────────────────────

async function drainHost(id, name, btn) {
  if (!window.confirm(`排空虚机 ${name}?新容器不会再调度到它,但已有容器继续跑。`)) return
  await withBtnLoading(btn, async () => {
    try {
      await apiJson('POST', `/api/admin/v3/compute-hosts/${encodeURIComponent(id)}/drain`, {})
      toast(`${name} 已进入 draining`)
      _loadHostsData(HOSTS_STATE.renderSeq)
    } catch (e) {
      toast(`排空失败: ${e.message}`, 'danger', toastOptsFromError(e))
    }
  })
}

async function removeHost(id, name, btn) {
  if (!window.confirm(`从虚机池删除 ${name}?要求 draining + active=0,不可逆。`)) return
  await withBtnLoading(btn, async () => {
    try {
      await apiJson('POST', `/api/admin/v3/compute-hosts/${encodeURIComponent(id)}/remove`, {})
      toast(`${name} 已删除`)
      _loadHostsData(HOSTS_STATE.renderSeq)
    } catch (e) {
      toast(`删除失败: ${e.message}`, 'danger', toastOptsFromError(e))
    }
  })
}

async function clearHostQuarantine(id, name, btn) {
  if (!window.confirm(`解除 ${name} 的隔离状态?之后新容器可能调度到它。`)) return
  await withBtnLoading(btn, async () => {
    try {
      await apiJson('POST', `/api/admin/v3/compute-hosts/${encodeURIComponent(id)}/quarantine-clear`, {})
      toast(`${name} 已解除隔离`)
      _loadHostsData(HOSTS_STATE.renderSeq)
    } catch (e) {
      toast(`解除失败: ${e.message}`, 'danger', toastOptsFromError(e))
    }
  })
}

// ─── Boot ──────────────────────────────────────────────────────────

bootstrap().catch((e) => {
  console.error('admin bootstrap failed', e)
  showError(`bootstrap failed: ${e.message}`, e)
})
