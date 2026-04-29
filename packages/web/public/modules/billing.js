// OpenClaude (commercial v3) — billing module
//
// Phase 4B 范围:
//   - 顶栏「积分 pill」展示当前用户 X 积分(DOM id 仍为 balance-pill,向后兼容),点击打开充值模态。
//   - 充值模态三段式 stage:
//       a) plans  — GET /api/payment/plans,用户选套餐
//       b) qr     — POST /api/payment/hupi/create,展示虎皮椒返回的 url_qrcode 图,
//                   每 3s 轮询 GET /api/payment/orders/:order_no 直到 paid / expired。
//       c) done   — 支付成功:刷新积分显示、提示、2s 后自动关闭。
//
// 单位约定(很重要,见 CLAUDE.md / 个人版 memory「claudeai.chat credits 单位=分」):
//   user.credits / plan.amount_cents / plan.credits / order.amount_cents / order.credits
//   全部是 BigInt-as-string,以「分」为单位。
//   2026-04-21 起展示口径改为「积分」:「1 积分 = 1 分 = ¥0.01」,credits 字段原值即积分,
//   整数显示无精度损失。用 `formatCredits()` 格式化为「X,XXX 积分」。
//   `formatYuan()` 保留给仍需展示人民币金额的场景(充值下单时显示实际付款 ¥XX)。
//
// 端点契约(见 packages/commercial/src/http/{handlers.ts,payment.ts}):
//   GET  /api/me                          → { user: { id, email, credits, ... } }
//   GET  /api/payment/plans               → { ok, data: { plans: [{code,label,amount_cents,credits}] } }
//   POST /api/payment/hupi/create         → { ok, data: { order_no, qrcode_url, mobile_url, amount_cents, credits, expires_at } }
//   GET  /api/payment/orders/:order_no    → { ok, data: { order_no, status, amount_cents, credits, expires_at, paid_at, ... } }
//
// 关键不变量:
//   - qrcode_url 已经是「PNG 图片 URL」(虎皮椒 url_qrcode 字段),前端必须 <img src=…>。
//     绝不能再用 qrcode.js 把它编码成二维码 —— 微信扫到的将是 url 而不是 weixin:// 协议,
//     用户被迫扫两次。详见 packages/commercial/src/payment/hupijiao/client.ts 注释。
//   - 个人版 (master) 不带 commercial 路由 — /api/me 会 404,balance pill 自动保持隐藏。
//
// 模块外部接口(在 main.js 的 init 中调一次):
//   import { initBilling, refreshBalance } from './billing.js?v=3b22cc4'
//   initBilling()        — 一次性 wire 静态 DOM 事件
//   refreshBalance()     — 拉一次 /api/me,更新 pill;失败静默(commercial 未启用时)
//                          返回 Promise<{ shown: boolean, credits: string|null }>

import { apiGet, apiJson } from './api.js?v=3b22cc4'
import { closeModal, openModal, toast } from './ui.js?v=3b22cc4'
import { state } from './state.js?v=3b22cc4'

// ── 常量 ───────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 3000
const POLL_MAX_FAILURES = 5
const SUCCESS_AUTOCLOSE_MS = 2000
// sessionStorage key,手机 H5 支付路径上把订单状态持久化 —— location.href 同 tab
// 跨站导航会卸载 JS context,原来 in-memory 的 _activeOrderNo / setInterval 不可指望。
// 用户从微信/虎皮椒 H5 返回时,本模块 initBilling 会检查此 key 并恢复 qr stage + 轮询。
const PENDING_ORDER_KEY = 'openclaude_pending_order'
// 虎皮椒 H5 收银台域名白名单 —— 前端在 location.href 前做最后一道校验,
// 即使上游 client 吐出异常 url,也不会变成开放重定向 / 反射型 XSS 载体。
// 覆盖官方主域 + 官方备用域(dpweixin.com 是虎皮椒 backup gateway,
// 文档 https://www.xunhupay.com/doc/api/pay.html)+ 历史曾用的 hupijiao.com。
// 若虎皮椒后续换域,这里同步补。
const HUPIJIAO_HOST_ALLOW = /(^|\.)xunhupay\.com$|(^|\.)hupijiao\.com$|(^|\.)dpweixin\.com$/i

// ── 模块状态 ────────────────────────────────────────────────────────
let _wired = false
let _commercialMode = null       // null=unknown, true/false
let _pollTimer = null
let _pollFailures = 0
let _activeOrderNo = null
let _expiryCountdownTimer = null

// ── 工具 ────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id) }

/**
 * 粗略判断当前设备是否应走"H5 拉起微信支付"路径而不是扫码。
 * 虎皮椒返回的 `mobile_url` 是 wap 收银台 H5,手机浏览器 `location.href=` 过去会触发
 * "调起微信" 流程,用户无需截图/长按识别二维码(且微信内置浏览器本身禁止识别页面二维码)。
 * 判定保守:只认 iPhone / iPad / Android Mobile,其它(Windows/macOS/平板 landscape)
 * 仍走 PC 二维码。误判 PC 为 mobile 会把用户带到 H5 → 体验退化;误判 mobile 为 PC
 * 用户还能截图扫,但微信内浏览器无法识别。两害相权,保守一点没有实际损失。
 */
function _isMobileUA() {
  const ua = navigator.userAgent || ''
  return /iPhone|iPad|iPod|Android.*Mobile/i.test(ua)
}

/**
 * 校验上游 mobile_url 只允许 http(s) + 虎皮椒域名。失败返回 null,调用方必须 fallback。
 * Codex review 指出:client.ts 未对 json.url 做域名/协议校验,直接 location.href 有开放
 * 重定向 / 反射型 XSS 风险,这里前端补齐。
 */
function _sanitizeMobileUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let u
  try { u = new URL(raw) } catch { return null }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  if (!HUPIJIAO_HOST_ALLOW.test(u.hostname)) return null
  return u.toString()
}

function _savePendingOrder(obj) {
  try { sessionStorage.setItem(PENDING_ORDER_KEY, JSON.stringify(obj)) } catch { /* Safari private mode 可能 throw,忽略 */ }
}
function _loadPendingOrder() {
  try {
    const raw = sessionStorage.getItem(PENDING_ORDER_KEY)
    if (!raw) return null
    const o = JSON.parse(raw)
    if (!o || typeof o.order_no !== 'string') return null
    return o
  } catch { return null }
}
function _clearPendingOrder() {
  try { sessionStorage.removeItem(PENDING_ORDER_KEY) } catch { /* */ }
}

/**
 * 把「分」格式化为「¥X.XX」(带千分位)。
 * @param {string|number|bigint|null|undefined} cents
 */
export function formatYuan(cents) {
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
 * 把「积分」(= 分) 格式化为「X,XXX 积分」(带千分位,无小数)。
 * 语义上 1 积分 = 1 分,所以 credits 字段原值直接就是积分数,不需要除法。
 * @param {string|number|bigint|null|undefined} credits
 */
export function formatCredits(credits) {
  if (credits == null) return '0 积分'
  const s = String(credits)
  if (!/^-?\d+$/.test(s)) return '0 积分'
  const negative = s.startsWith('-')
  const digits = negative ? s.slice(1) : s
  const fmt = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}${fmt} 积分`
}

function _setPillText(text) {
  const el = $('balance-text')
  if (el) el.textContent = text
}

function _showPill(visible) {
  const el = $('balance-pill')
  if (!el) return
  if (visible) el.removeAttribute('hidden')
  else el.setAttribute('hidden', '')
}

// ── 积分刷新 ────────────────────────────────────────────────────────

/**
 * 拉 /api/me,更新 balance pill。
 * 失败(包括 404 = 个人版未启用 commercial)→ 静默隐藏 pill。
 * 成功 → 缓存 _commercialMode=true,以后 click 才会打开模态。
 *
 * V3 Phase 4E:同一个 /api/me 响应里也带 role,顺手切换设置菜单里的
 * "超管控制台" 入口可见性 —— role=admin 显示,其它一律隐藏。这样:
 *   1) 不增加额外 round-trip;refreshBalance 是唯一的 /api/me 入口。
 *   2) 用户不是 admin 时菜单不出现这一条,降低误点 + UI 噪声。
 *   3) 失败路径(404 个人版 / 401 已退出)走 _hideAdminLink,保持菜单干净。
 */
export async function refreshBalance() {
  try {
    const data = await apiGet('/api/me')
    const user = data?.user || {}
    const credits = user.credits ?? '0'
    _setPillText(formatCredits(credits))
    _showPill(true)
    _commercialMode = true
    // 2026-04-21 安全审计 HIGH#F1:把稳定 user.id 存到 state,changelog_seen /
    // effort_by_agent 等用户级 localStorage 桶改用这个而不是 JWT 末 8 字节
    // (JWT 每次 refresh 会变,不是稳定身份,会让"已读"状态反复丢失)。
    if (user.id != null) {
      const uid = String(user.id)
      if (uid) state.userId = uid
    }
    _setAdminLinkVisible(user.role === 'admin')
    _setHostAgentEntriesVisible(user.role === 'admin')
    _hostAgentAdmin = user.role === 'admin'
    return { shown: true, credits: String(credits), role: user.role || null }
  } catch (err) {
    // 个人版无此接口;商用版 401 已被 api.js 处理,此处其它失败一律静默。
    _showPill(false)
    _setAdminLinkVisible(false)
    _setHostAgentEntriesVisible(false)
    _hostAgentAdmin = false
    if (_commercialMode === null) _commercialMode = false
    return { shown: false, credits: null, role: null }
  }
}

function _setAdminLinkVisible(visible) {
  const el = $('admin-console-link')
  if (!el) return
  if (visible) el.removeAttribute('hidden')
  else el.setAttribute('hidden', '')
}

/**
 * V3 商用版多租户防火墙(PR1)把 /api/agents/*、/api/agents/:id/memory/*、
 * /api/agents/:id/skills、/api/cron、/api/tasks 这些 host-scope 单例端点
 * 对 commercial user 403 掉了 —— 普通用户点了只会看到 403/404,徒增困惑。
 * 所以同步把对应设置菜单入口(人格编辑/管理 Agents/记忆/技能/定时任务)
 * 默认隐藏,仅 admin 可见(admin 绕过防火墙能正常用)。注意:这只是 UX 层,
 * 安全边界仍在 PR1 的服务端拦截 —— 用户就算 devtools 强行解 hidden,请求
 * 也会被 403。
 *
 * 个人版:refreshBalance 404 走 catch 路径保持隐藏,不影响,因为个人版
 * 前端 (/opt/openclaude/openclaude/packages/web/) 是单独的 index.html,
 * 不引用本段代码。
 */
function _setHostAgentEntriesVisible(visible) {
  for (const id of ['settings-section-agent', 'settings-section-learning']) {
    const el = document.getElementById(id)
    if (!el) continue
    if (visible) el.removeAttribute('hidden')
    else el.setAttribute('hidden', '')
  }
}

// ── Host-scope admin 权限快照(命令面板 / 斜杠命令读取)───────────────
//
// 同一批入口(memory/skills/tasks/persona/agents)除了出现在 settings
// dropdown,还出现在 Ctrl+K 命令面板 和 slash 命令(/memory /skills
// /persona /tasks)。它们全部命中 PR1 防火墙会 403 的端点。用 module
// 级 flag 集中承载状态,refreshBalance 更新它,其它模块读 isHostAgentAdmin()
// 做显示过滤。默认 false —— 在 /api/me 返回前不把入口暴露给非 admin。
let _hostAgentAdmin = false

export function isHostAgentAdmin() {
  return _hostAgentAdmin
}

// ── Stage 切换 ──────────────────────────────────────────────────────

function _setStage(name) {
  for (const stage of ['plans', 'qr', 'done']) {
    const el = $(`topup-stage-${stage}`)
    if (!el) continue
    if (stage === name) el.removeAttribute('hidden')
    else el.setAttribute('hidden', '')
  }
}

// ── 套餐列表 ────────────────────────────────────────────────────────

async function _loadPlans() {
  const wrap = $('topup-plans-list')
  if (!wrap) return
  wrap.innerHTML = '<div class="topup-loading">加载套餐中…</div>'
  try {
    const j = await apiGet('/api/payment/plans')
    const plans = Array.isArray(j?.data?.plans) ? j.data.plans : []
    if (plans.length === 0) {
      wrap.innerHTML = '<div class="topup-empty">暂无可用充值套餐,请联系管理员</div>'
      return
    }
    wrap.innerHTML = ''
    for (const p of plans) {
      const card = document.createElement('button')
      card.type = 'button'
      card.className = 'plan-card'
      card.dataset.planCode = String(p.code || '')
      const amount = formatYuan(p.amount_cents)
      const credits = formatCredits(p.credits)
      // 积分口径下始终展示「到账 X 积分」,让用户看到面值等价关系(¥10 → 1,000 积分)。
      const bonusHtml = `<div class="plan-card-bonus">到账 ${credits}</div>`
      card.innerHTML = `
        <div class="plan-card-label">${_escape(String(p.label || p.code || ''))}</div>
        <div class="plan-card-price">${amount}</div>
        ${bonusHtml}
      `
      card.addEventListener('click', () => _onPlanSelected(p))
      wrap.appendChild(card)
    }
  } catch (err) {
    wrap.innerHTML = `<div class="topup-error">加载失败: ${_escape(String(err?.message || err))}</div>`
  }
}

function _escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

// ── 创建订单 + 进入 QR stage ────────────────────────────────────────

async function _onPlanSelected(plan) {
  const orderInfo = $('topup-order-info')
  const qrFrame = $('topup-qr-frame')
  const statusEl = $('topup-qr-status')
  if (orderInfo) orderInfo.textContent = '创建订单中…'
  if (qrFrame) qrFrame.innerHTML = ''
  if (statusEl) statusEl.textContent = ''
  _setStage('qr')

  let resp
  try {
    resp = await apiJson('POST', '/api/payment/hupi/create', { plan_code: plan.code })
  } catch (err) {
    if (statusEl) statusEl.textContent = '创建订单失败: ' + (err?.message || err)
    return
  }
  const data = resp?.data
  if (!data?.order_no || !data?.qrcode_url) {
    if (statusEl) statusEl.textContent = '订单创建成功但缺少二维码,请稍后重试'
    return
  }

  if (orderInfo) {
    const amt = formatYuan(data.amount_cents)
    const got = formatCredits(data.credits)
    // 订单摘要:付款金额 ¥ 仍保留(微信支付需要让用户知道实际扣款),到账换成积分口径。
    orderInfo.innerHTML = `<strong>${_escape(plan.label || plan.code)}</strong> · 支付 ${_escape(amt)} <span class="topup-bonus">(到账 ${_escape(got)})</span> · 订单号 <code>${_escape(data.order_no)}</code>`
  }

  // 分支:手机 UA 且后端给了合法 mobile_url → 持久化订单状态到 sessionStorage,
  // 再 location.href 跳虎皮椒 H5 收银台,由收银台自动调起微信;PC 或 mobile_url
  // 非法 → 回退扫码分支。
  const safeMobileUrl = _isMobileUA() ? _sanitizeMobileUrl(data.mobile_url) : null
  if (safeMobileUrl) {
    // 持久化:原 tab 跨站导航后 JS context 会被卸载,in-memory _activeOrderNo / setInterval
    // 都会丢。返回时 initBilling → _maybeResumePendingOrder 从 sessionStorage 读回订单号,
    // 重新打开 modal → 立刻查一次状态 → 继续轮询直到 paid/expired。
    _savePendingOrder({
      order_no: data.order_no,
      expires_at: data.expires_at,
      summary_html: (orderInfo && orderInfo.innerHTML) || '',
    })

    // 跳转前的过渡画面:手动回退链接,防止某些浏览器把非用户手势 location.href 拦截。
    if (qrFrame) {
      qrFrame.innerHTML = ''
      const tip = document.createElement('div')
      tip.className = 'topup-mobile-tip'
      const lead = document.createElement('div')
      lead.textContent = '正在跳转到微信支付…'
      const fallbackLink = document.createElement('a')
      fallbackLink.href = safeMobileUrl
      fallbackLink.className = 'topup-mobile-fallback'
      fallbackLink.textContent = '如未跳转,请点这里'
      tip.appendChild(lead)
      tip.appendChild(document.createElement('br'))
      tip.appendChild(fallbackLink)
      qrFrame.appendChild(tip)
    }
    _setPollStatus('等待你在微信完成支付后返回本页面')
    // 注意:不在这里 _startPolling —— tab 会立刻被 unload,setInterval 也会随之销毁。
    // 恢复流程由 initBilling 接管,走 _maybeResumePendingOrder 重新启动轮询。
    setTimeout(() => { window.location.href = safeMobileUrl }, 50)
    return
  }

  // PC 分支:渲染 QR(注意: qrcode_url 已是 PNG URL,直接 <img>)+ 启动倒计时/轮询。
  _startExpiryCountdown(data.expires_at)
  _activeOrderNo = data.order_no
  _pollFailures = 0

  if (qrFrame) {
    const img = document.createElement('img')
    img.src = data.qrcode_url
    img.alt = '微信支付二维码'
    img.className = 'topup-qr-img'
    img.onerror = () => {
      qrFrame.innerHTML = '<div class="topup-error">二维码加载失败</div>'
    }
    qrFrame.appendChild(img)
  }

  _setPollStatus('正在等待支付…')
  _startPolling(data.order_no)
}

// 页面加载时从 sessionStorage 恢复"刚从微信跳回来"的订单:打开 modal、进 qr stage、
// 立刻查一次订单状态 + 启动常规轮询。只要 initBilling 跑过就会触发一次。
async function _maybeResumePendingOrder() {
  const pending = _loadPendingOrder()
  if (!pending) return
  // 预占 commercial 态:refreshBalance 可能还没跑完或 /api/me 就 404(个人版),
  // 都不阻塞恢复 —— 因为只有商用版前端链路才会写入 pending order,不存在"被误恢复"。
  _commercialMode = _commercialMode !== false ? true : _commercialMode
  _setStage('qr')
  openModal('topup-modal')

  const orderInfo = $('topup-order-info')
  if (orderInfo && pending.summary_html) orderInfo.innerHTML = pending.summary_html

  const qrFrame = $('topup-qr-frame')
  if (qrFrame) {
    qrFrame.innerHTML = ''
    const tip = document.createElement('div')
    tip.className = 'topup-mobile-tip'
    tip.textContent = '正在确认支付结果…'
    qrFrame.appendChild(tip)
  }

  _startExpiryCountdown(pending.expires_at)
  _activeOrderNo = pending.order_no
  _pollFailures = 0
  _setPollStatus('正在查询订单状态…')
  _startPolling(pending.order_no)
  try { await _pollOnce(pending.order_no) } catch { /* _pollOnce 内部自己 try/catch */ }
}

// ── 倒计时 ─────────────────────────────────────────────────────────

function _startExpiryCountdown(expiresAtIso) {
  _stopExpiryCountdown()
  const el = $('topup-expiry')
  if (!el || !expiresAtIso) return
  const expiresAt = new Date(expiresAtIso).getTime()
  if (!Number.isFinite(expiresAt)) return
  const tick = () => {
    const now = Date.now()
    const remain = Math.max(0, Math.floor((expiresAt - now) / 1000))
    if (remain <= 0) {
      el.textContent = '订单已过期'
      _stopExpiryCountdown()
      return
    }
    const m = Math.floor(remain / 60)
    const s = String(remain % 60).padStart(2, '0')
    el.textContent = `剩余 ${m}:${s}`
  }
  tick()
  _expiryCountdownTimer = setInterval(tick, 1000)
}

function _stopExpiryCountdown() {
  if (_expiryCountdownTimer) {
    clearInterval(_expiryCountdownTimer)
    _expiryCountdownTimer = null
  }
}

// ── 订单轮询 ────────────────────────────────────────────────────────

function _setPollStatus(msg) {
  const el = $('topup-qr-status')
  if (el) el.textContent = msg
}

function _startPolling(orderNo) {
  _stopPolling()
  _pollTimer = setInterval(() => _pollOnce(orderNo), POLL_INTERVAL_MS)
}

function _stopPolling() {
  if (_pollTimer) {
    clearInterval(_pollTimer)
    _pollTimer = null
  }
}

async function _pollOnce(orderNo) {
  // 用户已关模态或切换到别的订单 → 取消
  if (_activeOrderNo !== orderNo) {
    _stopPolling()
    return
  }
  try {
    const j = await apiGet(`/api/payment/orders/${encodeURIComponent(orderNo)}`)
    _pollFailures = 0
    const status = j?.data?.status
    if (status === 'paid') {
      _stopPolling()
      _stopExpiryCountdown()
      _clearPendingOrder()
      _onOrderPaid(j.data)
      return
    }
    if (status === 'expired' || status === 'canceled' || status === 'refunded') {
      _stopPolling()
      _stopExpiryCountdown()
      _clearPendingOrder()
      // 清 _activeOrderNo 后,visibilitychange/initBilling 不会再把这个终态订单
      // 重新捞回来反复查(codex review MINOR: 原代码只 stopPolling,下次切回 tab 又触发)。
      _activeOrderNo = null
      _setPollStatus(`订单${status === 'expired' ? '已过期' : status === 'canceled' ? '已取消' : '已退款'},请返回重新选择套餐`)
      return
    }
    // pending — 继续等
  } catch (err) {
    _pollFailures += 1
    if (_pollFailures >= POLL_MAX_FAILURES) {
      _stopPolling()
      _setPollStatus('查询订单失败次数过多,请稍后手动刷新')
    }
  }
}

function _onOrderPaid(orderData) {
  _setStage('done')
  const el = $('topup-done-summary')
  if (el) {
    const got = formatCredits(orderData.credits)
    el.innerHTML = `支付成功!积分已增加 <strong>${_escape(got)}</strong>`
  }
  refreshBalance().catch(() => {})
  // 订单已终态(paid)—— 清 _activeOrderNo 避免 visibilitychange/pageshow
  // 在 autoclose 的 2s 窗口内再次触发 _pollOnce 重复查询已支付订单
  // (codex review MINOR: 原代码只 stopPolling,下次切回 tab 又拉一次)。
  _activeOrderNo = null
  setTimeout(() => {
    // 只有 done 阶段还在展示(用户没手动关 / 没点返回重开)才自动关。
    const doneEl = $('topup-stage-done')
    if (doneEl && !doneEl.hasAttribute('hidden')) {
      _closeTopupModal()
    }
  }, SUCCESS_AUTOCLOSE_MS)
}

// ── 模态打开 / 关闭 ─────────────────────────────────────────────────

// P1-3: 也由 messages.js 的 outbound.error CTA 调用,export 出去。
export function _openTopupModal() {
  if (!_commercialMode) {
    toast('充值功能未启用', 'error')
    return
  }
  _activeOrderNo = null
  _setStage('plans')
  openModal('topup-modal')
  _loadPlans()
}

function _closeTopupModal() {
  _stopPolling()
  _stopExpiryCountdown()
  _activeOrderNo = null
  _clearPendingOrder()
  closeModal('topup-modal')
}

function _backToPlans() {
  _stopPolling()
  _stopExpiryCountdown()
  _activeOrderNo = null
  _clearPendingOrder()
  _setStage('plans')
  _loadPlans()
}

// ── 入口:wire DOM 事件 ────────────────────────────────────────────

export function initBilling() {
  if (_wired) return
  _wired = true
  const pill = $('balance-pill')
  if (pill) pill.addEventListener('click', _openTopupModal)

  const backBtn = $('topup-back-btn')
  if (backBtn) backBtn.addEventListener('click', _backToPlans)

  // 关闭按钮(modal-close + modal-foot 取消)统一由 main.js 的 [data-close-modal]
  // delegated handler 处理 → 我们只需在那个时机停掉轮询 + 清 pending storage。
  const modal = $('topup-modal')
  if (modal) {
    modal.addEventListener('click', (e) => {
      const closeBtn = e.target?.closest?.('[data-close-modal]')
      if (closeBtn) {
        _stopPolling()
        _stopExpiryCountdown()
        _activeOrderNo = null
        _clearPendingOrder()
      }
    }, true)
  }

  // 手机 H5 支付路径:用户被 location.href 跳到虎皮椒收银台 → 微信。支付完返回本 tab
  // 的实际机制有两种,我们都覆盖:
  //  1) 同一 document 被 BFCache 命中 → pageshow event 触发(Safari / Chrome iOS 常见)
  //  2) 跳回来触发 document 重新加载 → initBilling 里的 _maybeResumePendingOrder 接管
  // 外加:已有 _activeOrderNo(例如 PC 扫码 + 切到别的 tab 做事)切回也补查一次,
  // 避免 setInterval 被后台节流拖长。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    if (!_activeOrderNo) return
    _pollOnce(_activeOrderNo).catch(() => { /* _pollOnce 自己 try/catch,这里兜底 */ })
  })
  window.addEventListener('pageshow', (e) => {
    // 只有 BFCache 命中(persisted=true)时才依赖此路径 —— 非 persisted 时
    // DOM 刚重新构建,轮询定时器是干净的,由 _maybeResumePendingOrder 承接。
    if (!e.persisted) return
    if (_activeOrderNo) {
      _pollOnce(_activeOrderNo).catch(() => {})
    } else {
      _maybeResumePendingOrder().catch(() => {})
    }
  })

  // initBilling 被 main.js 在 app 起步时调一次。这里顺手把"上次从微信跳回来
  // 却没收到 paid 事件"的订单恢复出来 —— sessionStorage 里有就打开 modal + 轮询。
  _maybeResumePendingOrder().catch(() => {})
}
