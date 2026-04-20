// OpenClaude (commercial v3) — billing module
//
// Phase 4B 范围:
//   - 顶栏「余额 pill」展示当前用户 ¥X.XX,点击打开充值模态。
//   - 充值模态三段式 stage:
//       a) plans  — GET /api/payment/plans,用户选套餐
//       b) qr     — POST /api/payment/hupi/create,展示虎皮椒返回的 url_qrcode 图,
//                   每 3s 轮询 GET /api/payment/orders/:order_no 直到 paid / expired。
//       c) done   — 支付成功:刷新余额、提示、2s 后自动关闭。
//
// 单位约定(很重要,见 CLAUDE.md / 个人版 memory「claudeai.chat credits 单位=分」):
//   user.credits / plan.amount_cents / plan.credits / order.amount_cents / order.credits
//   全部是 BigInt-as-string,以「分」为单位。前端用 `formatYuan()` 格式化为「¥X.XX」。
//   不写「积分」字眼,统一 ¥ 表达。
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
//   import { initBilling, refreshBalance } from './billing.js'
//   initBilling()        — 一次性 wire 静态 DOM 事件
//   refreshBalance()     — 拉一次 /api/me,更新 pill;失败静默(commercial 未启用时)
//                          返回 Promise<{ shown: boolean, credits: string|null }>

import { apiGet, apiJson } from './api.js'
import { closeModal, openModal, toast } from './ui.js'

// ── 常量 ───────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 3000
const POLL_MAX_FAILURES = 5
const SUCCESS_AUTOCLOSE_MS = 2000

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

// ── 余额刷新 ────────────────────────────────────────────────────────

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
    _setPillText(formatYuan(credits))
    _showPill(true)
    _commercialMode = true
    _setAdminLinkVisible(user.role === 'admin')
    return { shown: true, credits: String(credits), role: user.role || null }
  } catch (err) {
    // 个人版无此接口;商用版 401 已被 api.js 处理,此处其它失败一律静默。
    _showPill(false)
    _setAdminLinkVisible(false)
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
      const credits = formatYuan(p.credits)
      const hasBonus = String(p.credits) !== String(p.amount_cents)
      const bonusHtml = hasBonus
        ? `<div class="plan-card-bonus">到账 ${credits}</div>`
        : ''
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
    const got = formatYuan(data.credits)
    const bonus = String(data.credits) !== String(data.amount_cents)
      ? ` <span class="topup-bonus">(到账 ${_escape(got)})</span>`
      : ''
    orderInfo.innerHTML = `<strong>${_escape(plan.label || plan.code)}</strong> · ${_escape(amt)}${bonus} · 订单号 <code>${_escape(data.order_no)}</code>`
  }

  // 渲染 QR(注意: qrcode_url 已是 PNG URL,直接 <img>)
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

  // 启动倒计时 + 轮询
  _startExpiryCountdown(data.expires_at)
  _activeOrderNo = data.order_no
  _pollFailures = 0
  _setPollStatus('正在等待支付…')
  _startPolling(data.order_no)
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
      _onOrderPaid(j.data)
      return
    }
    if (status === 'expired' || status === 'canceled' || status === 'refunded') {
      _stopPolling()
      _stopExpiryCountdown()
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
    const got = formatYuan(orderData.credits)
    el.innerHTML = `支付成功!余额已增加 <strong>${_escape(got)}</strong>`
  }
  refreshBalance().catch(() => {})
  setTimeout(() => {
    if (_activeOrderNo === orderData.order_no) {
      _closeTopupModal()
    }
  }, SUCCESS_AUTOCLOSE_MS)
}

// ── 模态打开 / 关闭 ─────────────────────────────────────────────────

function _openTopupModal() {
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
  closeModal('topup-modal')
}

function _backToPlans() {
  _stopPolling()
  _stopExpiryCountdown()
  _activeOrderNo = null
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
  // delegated handler 处理 → 我们只需在那个时机停掉轮询。
  const modal = $('topup-modal')
  if (modal) {
    modal.addEventListener('click', (e) => {
      const closeBtn = e.target?.closest?.('[data-close-modal]')
      if (closeBtn) {
        _stopPolling()
        _stopExpiryCountdown()
        _activeOrderNo = null
      }
    }, true)
  }
}
