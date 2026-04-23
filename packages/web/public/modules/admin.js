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
import { apiFetch, apiGet, apiJson, authHeaders, onAuthExpired } from './api.js'
import { lineChart, barChart, donutChart, destroyChart, fmt as cfmt } from './charts.js'

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
  dashboard: renderDashboardTab,
  users: renderUsersTab,
  accounts: renderAccountsTab,
  containers: renderContainersTab,
  ledger: renderLedgerTab,
  pricing: renderPricingTab,
  plans: renderPlansTab,
  settings: renderSettingsTab,
  audit: renderAuditTab,
  health: renderHealthTab,
  alerts: renderAlertsTab,
}

function navigate(tab) {
  if (window.location.hash !== `#tab=${tab}`) {
    window.location.hash = `#tab=${tab}`
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
}
let _currentTab = null

function applyHash() {
  const m = /#tab=([a-z]+)/.exec(window.location.hash)
  const tab = (m && TABS[m[1]]) ? m[1] : 'dashboard'
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
  TABS[tab]().catch((e) => showError(`加载失败: ${e.message}`))
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

      <div class="stat-grid" id="dash-kpis">
        ${[
          '活跃用户 DAU','窗口新注册','付费用户','返场用户',
          '24h 请求数','24h Token','账号池 可用','告警 · 待处理',
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
            <h3>账号池状态</h3>
            <a class="admin-link" data-nav="accounts">详情 →</a>
          </div>
          <div class="chart-card-body"><canvas id="dash-chart-pool"></canvas></div>
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
            <h3>告警概况 · 24h</h3>
            <a class="admin-link" data-nav="alerts">告警中心 →</a>
          </div>
          <div class="chart-card-body" id="dash-alerts-body">
            <div class="skeleton-row"><div class="skeleton-bar w60"></div></div>
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
      navigate(a.dataset.nav)
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

async function loadDashboardData(seq) {
  const dauW = DASH_STATE.dauWindow
  const reqH = DASH_STATE.reqHours
  // R3 Codex L1:timer + 手动刷新 + toggle 连点 可能并发触发两次 loadDashboardData。
  // 网络/后端延迟不保证"后发先到",旧请求若晚返回会把新结果覆盖回去(或"加载失败"
  // 覆盖成功态)。用独立 loadSeq 判定"我是不是最新一次 load",非最新直接 bail。
  const myLoadSeq = ++DASH_STATE.loadSeq

  // 并行拉 5 条新 stats + 2 条明细 (accounts / ledger)。
  // 每个端点独立 fulfilled/rejected,失败的不传染其他卡片(R1 Codex M3)。
  const [dauR, revR, reqR, alertsR, poolR, accountsR, ledgerR] = await Promise.allSettled([
    apiGet(`/api/admin/stats/dau?window=${encodeURIComponent(dauW)}`),
    apiGet(`/api/admin/stats/revenue-by-day?days=14`),
    apiGet(`/api/admin/stats/request-series?hours=${reqH}`),
    apiGet(`/api/admin/stats/alerts-summary`),
    apiGet(`/api/admin/stats/account-pool`),
    apiGet(`/api/admin/accounts`),
    apiGet(`/api/admin/ledger?limit=8`),
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
  const alertsOk   = alertsR.status === 'fulfilled'
  const poolOk     = poolR.status === 'fulfilled'
  const accountsOk = accountsR.status === 'fulfilled'
  const ledgerOk   = ledgerR.status  === 'fulfilled'
  const rev        = revOk    ? (revR.value?.rows || []) : []
  const reqSeries  = reqOk    ? (reqR.value?.rows || []) : []
  const alerts     = alertsOk ? alertsR.value : null
  const pool       = poolOk   ? poolR.value : null
  const accounts   = accountsOk ? (accountsR.value?.rows || []) : []
  const ledger     = ledgerOk  ? (ledgerR.value?.rows  || []) : []

  // ─── KPI 卡片(8 项) ───
  const statCards = view().querySelectorAll('#dash-kpis .stat-card')
  const wLabel = dauW === '24h' ? '24 小时' : dauW === '7d' ? '7 天' : '30 天'

  // 1-4. DAU 相关四张卡 — /stats/dau 失败 → 保持骨架,不显示 0
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

  // 5-6. request series — 失败 → "—"
  if (reqOk) {
    const totalReq = reqSeries.reduce((a, r) => a + (Number(r.total) || 0), 0)
    const totalErr = reqSeries.reduce((a, r) => a + (Number(r.error) || 0), 0)
    const errRate = totalReq > 0 ? (totalErr / totalReq) : 0
    updateStat(statCards[4], totalReq.toLocaleString(),
      totalReq > 0 ? `错误率 ${(errRate * 100).toFixed(2)}%` : `窗口 ${reqH}h 无请求`,
      totalReq === 0 ? null : (errRate > 0.05 ? 'danger' : errRate > 0.01 ? 'warning' : 'success'))
    const totalTokens = reqSeries.reduce((a, r) => {
      const t = Number(r.tokens || 0)
      return Number.isFinite(t) ? a + t : a
    }, 0)
    updateStat(statCards[5], cfmt.compact(totalTokens), `窗口 ${reqH}h 总 token`, null)
  } else {
    updateStat(statCards[4], '—', '加载失败', 'danger')
    updateStat(statCards[5], '—', '加载失败', 'danger')
  }

  // 7. 账号池
  if (pool) {
    const avail = pool.active
    const tot = pool.total
    const tone = tot === 0 ? null : (avail === tot ? 'success'
      : pool.cooldown > 0 ? 'warning' : 'danger')
    const meta = pool.cooldown > 0 ? `${pool.cooldown} 冷却`
      : (pool.disabled + pool.banned > 0 ? `${pool.disabled + pool.banned} 禁用/封禁` : '全部健康')
    updateStat(statCards[6], `${avail} / ${tot}`, meta, tone)
  } else {
    updateStat(statCards[6], '—', '加载失败', 'danger')
  }

  // 8. 告警待处理
  if (alerts) {
    const p = alerts.outbox.pending + alerts.outbox.failed
    const sev = alerts.events_24h_by_severity
    const tone = alerts.outbox.failed > 0 ? 'danger'
      : alerts.outbox.pending > 0 ? 'warning'
      : sev.critical > 0 ? 'danger' : null
    updateStat(statCards[7], p.toLocaleString(),
      `发送 24h · ${alerts.outbox.sent_24h}  规则 firing · ${alerts.rules.firing}`,
      tone)
  } else {
    updateStat(statCards[7], '—', '加载失败', 'danger')
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

  // ─── Chart: 账号池环形 ───
  const poolCanvas = document.getElementById('dash-chart-pool')
  if (poolCanvas) {
    if (pool) {
      DASH_STATE.charts.pool = poolCanvas
      donutChart(poolCanvas, {
        labels: ['active', 'cooldown', 'disabled', 'banned'],
        values: [pool.active, pool.cooldown, pool.disabled, pool.banned],
        colors: ['--ok', '--warn', '--muted', '--danger'],
      })
    } else {
      _renderChartError(poolCanvas, '加载失败')
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

  // ─── 告警概况列表 ───
  const alertsEl = $('dash-alerts-body')
  if (alertsEl && !alertsOk) {
    alertsEl.innerHTML = '<div class="empty" style="padding:var(--s-3);font-size:13px;color:var(--danger)">加载失败</div>'
  } else if (alertsEl && alerts) {
    const sev = alerts.events_24h_by_severity
    const bars = `
      <div style="display:flex;gap:var(--s-3);flex-wrap:wrap;">
        <span class="stat-chip danger">critical · ${sev.critical}</span>
        <span class="stat-chip warn">warning · ${sev.warning}</span>
        <span class="stat-chip ok">info · ${sev.info}</span>
      </div>
      <div style="font-size:12px;color:var(--muted);margin-top:8px;">
        outbox: <b>${alerts.outbox.pending}</b> 待发
        · <b>${alerts.outbox.failed}</b> 失败
        · <b>${alerts.outbox.sent_24h}</b> 24h 已发
        ${alerts.outbox.oldest_pending_age_sec > 0
          ? `<br>最老 pending 等待 <b>${fmtAgeSec(alerts.outbox.oldest_pending_age_sec)}</b>`
          : ''}
      </div>
      <div class="dash-alerts" style="margin-top:var(--s-3);">
        <div style="font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:0.06em;">最近 firing 规则</div>
        ${alerts.rules.recent_firing.length === 0
          ? `<div class="empty" style="padding:8px;font-size:12px;color:var(--muted)">当前无规则处于 firing</div>`
          : alerts.rules.recent_firing.map((r) => `
              <div class="dash-alert-row">
                <code>${escapeHtml(r.rule_id)}</code>
                <span class="dash-alert-time">${escapeHtml(fmtDate(r.fired_at))}</span>
              </div>`).join('')}
      </div>`
    alertsEl.innerHTML = bars
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

/** 人类可读的等待秒数 ("5分02秒" / "1小时23分" / "3天")。 */
function fmtAgeSec(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0))
  if (s < 60) return `${s} 秒`
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`
  if (s < 86400) {
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    return `${h} 小时 ${m} 分`
  }
  return `${Math.floor(s / 86400)} 天`
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
}

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
  USERS_STATE.rows = []
  USERS_STATE.nextCursor = null

  const q = USERS_STATE.q
  const status = USERS_STATE.status

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

      <div id="u-table-container">
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

  await Promise.all([
    _loadUsersKpis(mySeq),
    _loadMoreUsers(mySeq),  // 首次加载 = 首页加载 = "加载更多"的第一次
  ])
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
  if (USERS_STATE.nextCursor) sp.set('cursor', USERS_STATE.nextCursor)

  const isFirstPage = USERS_STATE.rows.length === 0 && !USERS_STATE.nextCursor
  let data
  try {
    data = await apiGet(`/api/admin/users?${sp.toString()}`)
  } catch (err) {
    if (renderSeq !== USERS_STATE.renderSeq || _currentTab !== 'users') return
    toast(`加载失败:${err.message}`, 'danger')
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
    b.addEventListener('click', () => openAdjustCreditsModal(b.dataset.id))
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

  return `
    <tr>
      <td class="mono">${escapeHtml(u.id)}</td>
      <td>
        ${escapeHtml(u.email || '')}
        ${u.email_verified
          ? '<span class="badge ok" title="已验证">✓</span>'
          : '<span class="badge warn" title="未验证邮箱">未验证</span>'}
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
        toast(`失败: ${e.message}`, 'danger')
      }
    })
  })
}

// ─── Tab: Accounts(CRUD)───────────────────────────────────────────
//
// 4J 实装:状态过滤 + 新建/编辑/删除。
// 后端字段: label / plan(pro|max|team) / status(active|cooldown|disabled|banned)
// / oauth_token / oauth_refresh_token / oauth_expires_at / egress_proxy
// (后端会 mask egress_proxy 里的密码,前端表单输入新值才会写库)

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

      <div id="acc-table-container"><div class="empty">加载中…</div></div>
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
  updateStat(cards[2], `${s.expiring_24h} + ${s.expired}`,
    `24h 内到期 / 已过期`,
    (s.expired > 0) ? 'danger' : (s.expiring_24h > 0 ? 'warning' : 'success'))
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
    toast(`加载失败:${err.message}`, 'danger')
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
        chips.push(`<span class="chip chip-danger" title="${escapeHtml(fmtDate(a.oauth_expires_at))}">OAuth 已过期</span>`)
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
  return chips.length > 0 ? `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:3px">${chips.join('')}</div>` : ''
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
      <td class="mono">${cdChip}</td>
      <td class="mono">${fmtRelative(a.last_used_at)}</td>
      <td class="mono" title="${escapeHtml(a.egress_proxy || '')}">${escapeHtml(a.egress_proxy || '—')}</td>
      <td class="actions">
        ${showReset ? `<button data-act="reset-cooldown" data-id="${escapeHtml(a.id)}" data-label="${escapeHtml(a.label)}" title="清冷却 + last_error">释放冷却</button>` : ''}
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
      toast(`释放失败:${e.message}`, 'danger')
    }
  })
}

function _accountFormFields(prefill) {
  // prefill = null → 新建;否则 = 现有 account 对象。
  // oauth_token 在 PATCH 模式下必须用户主动输入才发送(避免误覆盖)。
  const isCreate = !prefill
  const a = prefill || {}
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
      <label>egress_proxy ${isCreate ? '(可选 http(s)://[user:pass@]host:port)' : '(留空不动;输入 NULL 清空;输入新 URL 覆盖)'}</label>
      <input type="text" id="acc-egress" placeholder="可选;留空走本机"
             value="${isCreate ? '' : ''}" />
      ${!isCreate && a.has_egress_proxy ? `<small style="color:var(--muted)">当前(已 mask): ${escapeHtml(a.egress_proxy || '')}</small>` : ''}
    </div>
  `
}

// 把 form 字段读成 PATCH/CREATE body。空 string 在 PATCH 模式下表示 "不动",
// 字符串 "NULL"(大小写不敏感)表示显式置空。
function _readAccountForm(isCreate) {
  const label = $('acc-label').value.trim()
  const plan = $('acc-plan').value
  const tokenRaw = $('acc-token').value.trim()
  const refreshRaw = $('acc-refresh').value.trim()
  const expiresRaw = $('acc-expires').value.trim()
  const egressRaw = $('acc-egress').value.trim()
  const isNull = (v) => v.toUpperCase() === 'NULL'

  if (!label) throw new Error('label 必填')
  const body = { label, plan }

  if (isCreate) {
    if (!tokenRaw) throw new Error('oauth_token 必填')
    body.oauth_token = tokenRaw
    if (refreshRaw) body.oauth_refresh_token = isNull(refreshRaw) ? null : refreshRaw
    if (expiresRaw) body.oauth_expires_at = isNull(expiresRaw) ? null : expiresRaw
    if (egressRaw) body.egress_proxy = isNull(egressRaw) ? null : egressRaw
  } else {
    body.status = $('acc-status-edit').value
    if (tokenRaw) body.oauth_token = tokenRaw
    if (refreshRaw) body.oauth_refresh_token = isNull(refreshRaw) ? null : refreshRaw
    if (expiresRaw) body.oauth_expires_at = isNull(expiresRaw) ? null : expiresRaw
    if (egressRaw) body.egress_proxy = isNull(egressRaw) ? null : egressRaw
  }
  return body
}

// 模块级 state:OAuth 拿到的 state 跟 modal 共享
let _oauthPendingState = null

function openCreateAccountModal() {
  _oauthPendingState = null
  openModal(`
    <h3>新建账号</h3>

    <div class="oauth-box" style="
      border:1px solid #6366f1; border-radius:8px;
      padding:14px; margin-bottom:16px; background:rgba(99,102,241,0.08);
    ">
      <div style="font-weight:600;margin-bottom:8px">🔐 用 Claude 订阅授权 (推荐)</div>
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

    ${_accountFormFields(null)}
    <div class="form-actions">
      <button id="acc-cancel">取消</button>
      <button class="btn-primary" id="acc-ok">创建</button>
    </div>
  `)
  $('acc-cancel').addEventListener('click', closeModal)
  $('acc-oauth-open').addEventListener('click', oauthStartStep)
  $('acc-oauth-submit').addEventListener('click', oauthExchangeStep)
  $('acc-ok').addEventListener('click', async (ev) => {
    let body
    try { body = _readAccountForm(true) }
    catch (e) { toast(e.message, 'danger'); return }
    await withBtnLoading(ev.currentTarget, async () => {
      try {
        const r = await apiJson('POST', '/api/admin/accounts', body)
        toast(`已创建账号 ${r?.account?.id || ''}`)
        closeModal()
        applyHash()
      } catch (e) {
        toast(`创建失败: ${e.message}`, 'danger')
      }
    })
  })
}

// 步骤一:让后端发 PKCE state、生成 authUrl,新页签打开
async function oauthStartStep() {
  let started
  try {
    started = await apiJson('POST', '/api/admin/accounts/oauth/start', {})
  } catch (e) {
    toast(`OAuth 启动失败: ${e.message}`, 'danger')
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
    toast(`Token 交换失败: ${e.message}`, 'danger')
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
  try {
    const r = await apiGet(`/api/admin/accounts/${encodeURIComponent(id)}`)
    account = r?.account
    if (!account) throw new Error('未找到账号')
  } catch (e) {
    toast(`读取失败: ${e.message}`, 'danger'); return
  }
  openModal(`
    <h3>编辑账号 #${escapeHtml(account.id)}</h3>
    ${_accountFormFields(account)}
    <div class="form-actions">
      <button id="acc-cancel">取消</button>
      <button class="btn-primary" id="acc-ok">保存</button>
    </div>
  `)
  $('acc-cancel').addEventListener('click', closeModal)
  $('acc-ok').addEventListener('click', async (ev) => {
    let body
    try { body = _readAccountForm(false) }
    catch (e) { toast(e.message, 'danger'); return }
    await withBtnLoading(ev.currentTarget, async () => {
      try {
        await apiJson('PATCH', `/api/admin/accounts/${encodeURIComponent(account.id)}`, body)
        toast(`#${account.id} 已保存`)
        closeModal()
        applyHash()
      } catch (e) {
        toast(`保存失败: ${e.message}`, 'danger')
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
      toast(`删除失败: ${e.message}`, 'danger')
    }
  })
}

// ─── Tab: Containers ───────────────────────────────────────────────

// R4 — containers tab 重写(KPI 卡 + 客户端 status/email 过滤 + 日志 modal)

const CONTAINER_STATUSES = ['provisioning', 'running', 'stopped', 'removed', 'error']

const CONTAINERS_STATE = {
  renderSeq: 0, loadSeq: 0,
  rows: [], filterStatus: '', filterEmail: '',
}

async function renderContainersTab() {
  const mySeq = ++CONTAINERS_STATE.renderSeq
  CONTAINERS_STATE.rows = []
  CONTAINERS_STATE.filterStatus = sessionStorage.getItem('admin_ct_status') || ''
  CONTAINERS_STATE.filterEmail = sessionStorage.getItem('admin_ct_email') || ''

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

  let data
  try {
    data = await apiGet(`/api/admin/agent-containers?${sp.toString()}`)
  } catch (err) {
    if (renderSeq !== CONTAINERS_STATE.renderSeq || _currentTab !== 'containers') return
    toast(`加载失败:${err.message}`, 'danger')
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
  return `
    <tr>
      <td class="mono">${idStr}</td>
      <td><span class="badge ${kindClass}">${escapeHtml(c.row_kind || '?')}</span></td>
      <td>${user}${_containerWarningChips(c)}</td>
      <td>${sub}</td>
      <td>${statusBadge(c.lifecycle || c.status || c.state || '—')}</td>
      <td class="mono" title="${escapeHtml(c.image || '')}">${escapeHtml((c.image || '').split('/').pop() || '—')}</td>
      <td class="mono" title="${escapeHtml(c.docker_name || c.docker_id || '')}">${escapeHtml(dockerRef)}</td>
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
      toast(`失败: ${e.message}`, 'danger')
    }
  })
}

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
  const body = $('lg-body')
  if (!body) return
  body.textContent = '加载中…'
  const lines = $('lg-lines')?.value || '200'
  try {
    const data = await apiGet(`/api/admin/agent-containers/${encodeURIComponent(id)}/logs?lines=${encodeURIComponent(lines)}`)
    if (data.missing) {
      body.textContent = `容器已不存在(docker_ref=${data.docker_ref ?? 'null'})。数据库行仍可见,可在 users tab 按 user 追查。`
      return
    }
    const combined = data.combined || '(无输出)'
    body.textContent = combined
    // 自动滚到底
    body.scrollTop = body.scrollHeight
  } catch (e) {
    body.textContent = `加载失败:${e.message}`
  }
}

// ─── Tab: Ledger ───────────────────────────────────────────────────

async function renderLedgerTab() {
  const userId = sessionStorage.getItem('admin_ledger_user') || ''
  // R2 Codex M2:sessionStorage 里残留的 reason 可能来自旧版本(比如 "expire" 已
  // 不在白名单里);后端 ledger.ts 对 unknown reason 会 400 拒。启动时先按当前
  // LEDGER_REASONS 白名单卫生一次 —— 不认的一律归为"全部"并清掉。
  let reason = sessionStorage.getItem('admin_ledger_reason') || ''
  if (reason && !LEDGER_REASONS.includes(reason)) {
    reason = ''
    sessionStorage.removeItem('admin_ledger_reason')
  }
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
          ${LEDGER_REASONS.map((r) =>
            `<option value="${r}" ${reason === r ? 'selected' : ''}>${LEDGER_REASON_LABELS[r]}</option>`).join('')}
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
  $('p-ok').addEventListener('click', async (ev) => {
    const m = $('p-mult').value.trim()
    if (!/^\d+(\.\d{1,3})?$/.test(m)) { toast('multiplier 格式不对', 'danger'); return }
    await withBtnLoading(ev.currentTarget, async () => {
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
        toast(`失败: ${e.message}`, 'danger')
      }
    })
  })
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
  } else {
    // number — 用 type=text 让用户自己看出范围,client 只做基本校验,server 二次校验
    valueEditor = `
      <input type="number" id="set-${key}-value"
             min="${meta.min ?? ''}" max="${meta.max ?? ''}" step="1"
             value="${escapeHtml(String(r.value))}" style="width:120px" />`
  }
  const range = meta.kind === 'number' ? `${meta.min}..${meta.max}`
              : meta.kind === 'enum' ? (meta.enumValues || []).join('/')
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
      toast(`${key} 保存失败: ${e.message}`, 'danger')
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
    const res = await apiFetch('/api/admin/metrics', { headers: authHeaders() })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    text = await res.text()
  } catch (e) {
    showError(`拉取 metrics 失败: ${e.message}`)
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
      const res = await apiFetch('/api/admin/metrics', { headers: authHeaders() })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const txt = await res.text()
      const blob = new Blob([txt], { type: 'text/plain; charset=utf-8' })
      const url = URL.createObjectURL(blob)
      window.open(url, '_blank', 'noopener,noreferrer')
      // 让浏览器有足够时间读 URL 再释放
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (e) {
      showError(`拉取 metrics 失败: ${e.message}`)
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
    <div class="panel">
      <h2>告警通道 <small>微信 iLink,只发给绑定了的超管</small></h2>
      <div class="toolbar">
        <button class="btn" id="al-ch-refresh">刷新</button>
        <span class="spacer"></span>
        <button class="btn btn-primary" id="al-ch-bind">+ 绑定微信</button>
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

  // 四区并行拉数据 —— 互不阻塞
  _refreshAlertChannels()
  _refreshAlertOutbox()
  _refreshAlertSilences()
  _refreshAlertRuleStates()

  $('al-ch-refresh').addEventListener('click', _refreshAlertChannels)
  $('al-ch-bind').addEventListener('click', _openBindIlinkModal)
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
  return `
    <tr>
      <td class="mono">${escapeHtml(c.id)}</td>
      <td>${escapeHtml(c.label)}</td>
      <td class="mono">${escapeHtml(c.channel_type)}</td>
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
        ${c.activation_status === 'error' ? `<button data-act="rebind" data-id="${escapeHtml(c.id)}" title="把 activation_status=error 推回 pending,worker 会重新 long-poll。不重新扫码。">重新激活</button>` : ''}
        <button data-act="delete" data-id="${escapeHtml(c.id)}" class="btn-danger">删</button>
      </td>
    </tr>
  `
}

function _activationBadge(c) {
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
    toast(`失败: ${e.message}`, 'danger')
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
        toast(`失败: ${e.message}`, 'danger')
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
          </tr>
        </thead>
        <tbody>
          ${rows.map(_renderOutboxRow).join('')}
        </tbody>
      </table>
    `
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
    </tr>
  `
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
    toast(`失败: ${e.message}`, 'danger')
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
        toast(`失败: ${e.message}`, 'danger')
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
            <th>rule_id</th><th>firing</th><th>dedupe_key</th>
            <th>最近翻转</th><th>最近评估</th><th>最近 payload</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td class="mono">${escapeHtml(r.rule_id)}</td>
              <td>${r.firing ? '<span class="badge danger">FIRING</span>' : '<span class="badge ok">ok</span>'}</td>
              <td class="mono" style="font-size:12px">${escapeHtml(r.dedupe_key || '—')}</td>
              <td class="mono">${fmtDate(r.last_transition_at)}</td>
              <td class="mono">${fmtDate(r.last_evaluated_at)}</td>
              <td class="mono" style="font-size:12px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                  title="${escapeHtml(JSON.stringify(r.last_payload || {}))}">${escapeHtml(JSON.stringify(r.last_payload || {}))}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `
  } catch (e) {
    el.innerHTML = `<div class="error">加载 rule_states 失败: ${escapeHtml(e.message)}</div>`
  }
}

// ─── Boot ──────────────────────────────────────────────────────────

bootstrap().catch((e) => {
  console.error('admin bootstrap failed', e)
  showError(`bootstrap failed: ${e.message}`)
})
