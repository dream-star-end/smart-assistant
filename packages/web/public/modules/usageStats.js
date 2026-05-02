// OpenClaude (commercial v3) — 使用消耗统计(设置 → 使用消耗统计)
//
// 契约:GET /api/me/usage?sessions_limit=20&sessions_offset=0&ledger_limit=20&ledger_before=<id>
//   响应见 packages/commercial/src/http/handlers.ts: handleGetMyUsage
//
// 设计要点(Codex R1→R3 review):
//   - 所有 token / 积分字段是 decimal string(可能越过 2^53),本地格式化不经过 Number
//   - billed_credits ≠ debited_credits(clamp 场景);默认展示 debited,小字注释差额
//   - savings_unavailable=true 时不显示金额,显示说明文案
//   - sessions 按 MAX(created_at) 降序 + offset 分页,`has_more` 来自 LIMIT+1 探测
//   - ledger 用 id 游标 keyset,next_before=null 表示到底
//   - cache_hit_rate = cache_read / (input + cache_read);cache_write 单独展示
//   - 本地 formatYuan,不 import billing.js(避免双 ES module 实例)

import { apiGet } from './api.js?v=99aa929b'
import { closeModal, openModal, toast } from './ui.js?v=99aa929b'
import { state } from './state.js?v=99aa929b'

let _wired = false
// 分页状态:一个当前打开 modal 的快照。关闭后下次 open 会重置。
let _st = {
  sessionsOffset: 0,
  sessionsLimit: 20,
  ledgerLimit: 20,
  ledgerBefore: null,   // 下一页游标(从上次 next_before 承接);null = 从头
  ledgerLoaded: [],     // 已显示的 ledger rows(累加,不清空)
}

function $(id) { return document.getElementById(id) }

// ── 本地格式化(不 import billing.js,避免带 ?v= 和不带两个 ES module 实例) ──
// 分 → ¥X.XX;BigInt-safe(不走 Number)
function formatYuan(cents) {
  if (cents == null) return '¥0.00'
  const s = String(cents)
  if (!/^-?\d+$/.test(s)) return '¥0.00'
  const negative = s.startsWith('-')
  const digits = negative ? s.slice(1) : s
  const padded = digits.padStart(3, '0')
  const yuan = padded.slice(0, -2)
  const fen = padded.slice(-2)
  const yuanFmt = yuan.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return (negative ? '-' : '') + '¥' + yuanFmt + '.' + fen
}

// BigInt-safe token 千分位
function fmtTokens(cents) {
  if (cents == null) return '0'
  const s = String(cents)
  if (!/^-?\d+$/.test(s)) return '0'
  const negative = s.startsWith('-')
  const digits = negative ? s.slice(1) : s
  return (negative ? '-' : '') + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function fmtPercent(rate) {
  if (rate == null) return '—'
  const pct = rate * 100
  // 比例在 [0,1] 区间,Number 转换安全
  return pct.toFixed(1) + '%'
}

function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  // 本地时区,yyyy-mm-dd HH:MM
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const REASON_ZH = {
  topup: '充值',
  chat: '对话消耗',
  agent_chat: 'Agent 对话',
  agent_subscription: 'Agent 订阅',
  refund: '退款',
  admin_adjust: '管理员调整',
  promotion: '活动赠送',
}

function sessionLabel(sid) {
  // 优先用本地 state.sessions 的 title,否则显示短 id
  try {
    const s = state.sessions?.get?.(sid)
    if (s && s.title) return s.title
  } catch { /* ignore */ }
  const short = String(sid || '').replace(/^web-/, '')
  return short.length > 12 ? short.slice(0, 12) + '…' : short || '(未命名)'
}

// ── 主加载 ────────────────────────────────────────────────────────────

async function _loadUsage() {
  const loading = $('usage-loading')
  const content = $('usage-content')
  const errEl = $('usage-error')
  loading.hidden = false
  content.hidden = true
  errEl.hidden = true

  try {
    const q = new URLSearchParams({
      sessions_limit: String(_st.sessionsLimit),
      sessions_offset: String(_st.sessionsOffset),
      ledger_limit: String(_st.ledgerLimit),
    })
    if (_st.ledgerBefore) q.set('ledger_before', _st.ledgerBefore)
    const data = await apiGet('/api/me/usage?' + q.toString())
    _render(data)
    loading.hidden = true
    content.hidden = false
  } catch (err) {
    loading.hidden = true
    errEl.hidden = false
    errEl.textContent = '加载失败:' + (err?.message || String(err))
  }
}

function _render(data) {
  const s = data.summary || {}
  const legacy = data.legacy_unattributed || {}
  const savings = data.savings || {}
  const cache = data.cache || {}
  const sessions = data.sessions || { rows: [], has_more: false, limit: _st.sessionsLimit, offset: 0 }
  const ledger = data.ledger || { rows: [], next_before: null }

  // 总览
  const billed = s.billed_credits || '0'
  const debited = s.debited_credits || '0'
  $('usage-cost').textContent = formatYuan(debited)
  const clampHint = $('usage-cost-clamp-hint')
  if (billed !== debited) {
    try {
      const diff = BigInt(billed) - BigInt(debited)
      if (diff > 0n) {
        clampHint.hidden = false
        clampHint.textContent = `(名义账单 ${formatYuan(billed)},其中 ${formatYuan(diff.toString())} 因余额不足未扣)`
      } else {
        clampHint.hidden = true
      }
    } catch {
      clampHint.hidden = true
    }
  } else {
    clampHint.hidden = true
  }
  $('usage-requests').textContent = fmtTokens(s.requests_total || '0')
  $('usage-input').textContent = fmtTokens(s.input_tokens || '0')
  $('usage-output').textContent = fmtTokens(s.output_tokens || '0')

  // 缓存区
  $('usage-hit-rate').textContent = fmtPercent(cache.hit_rate)
  const savEl = $('usage-savings')
  const savHint = $('usage-savings-hint')
  if (savings.savings_unavailable) {
    savEl.textContent = '—'
    savHint.textContent = '数据量较大(>10000 条),暂不显示精确节省。'
  } else {
    savEl.textContent = formatYuan(savings.savings_credits || '0')
    let hint = '按每次请求的价格快照精算,仅计算 cache_read 维度的差价(clamp 至 0)。'
    if (savings.savings_is_estimate && savings.savings_rows_skipped > 0) {
      hint += ` 有 ${savings.savings_rows_skipped} 条价格快照异常被跳过。`
    }
    savHint.textContent = hint
  }
  $('usage-cache-write').textContent = fmtTokens(s.cache_write_tokens || '0')

  // cutoff note
  const cutoffEl = $('usage-cutoff-note')
  if (data.cutoff_started_at) {
    cutoffEl.textContent = `会话维度统计从 ${fmtTime(data.cutoff_started_at)} 开始记录,早于此时间的请求归入下方「历史未归属会话」。`
  } else {
    cutoffEl.textContent = '尚未有会话维度的请求记录。'
  }

  // sessions 表
  const tb = $('usage-sessions-tbody')
  tb.innerHTML = ''
  if (sessions.rows.length === 0) {
    const tr = document.createElement('tr')
    const td = document.createElement('td')
    td.colSpan = 7
    td.className = 'usage-empty'
    td.textContent = '无数据'
    tr.appendChild(td)
    tb.appendChild(tr)
  } else {
    for (const r of sessions.rows) {
      const tr = document.createElement('tr')
      const cells = [
        sessionLabel(r.session_id),
        fmtTokens(r.requests),
        fmtTokens(r.input_tokens),
        fmtTokens(r.output_tokens),
        fmtTokens(r.cache_read_tokens),
        formatYuan(r.billed_credits),
        fmtTime(r.last_used_at),
      ]
      for (const c of cells) {
        const td = document.createElement('td')
        td.textContent = c
        tr.appendChild(td)
      }
      // hover 显示完整 session_id
      tr.title = r.session_id
      tb.appendChild(tr)
    }
  }

  // legacy 行
  const legEl = $('usage-legacy-row')
  const legReq = BigInt(legacy.requests || '0')
  if (legReq > 0n) {
    legEl.hidden = false
    legEl.innerHTML = `<span class="usage-legacy-label">历史未归属会话(cutoff 前)</span>
      <span>${fmtTokens(legacy.requests)} 次请求 · 名义 ${formatYuan(legacy.billed_credits)} · 输入 ${fmtTokens(legacy.input_tokens)} / 输出 ${fmtTokens(legacy.output_tokens)}</span>`
  } else {
    legEl.hidden = true
  }

  // sessions 分页按钮
  const prev = $('usage-sessions-prev')
  const next = $('usage-sessions-next')
  const info = $('usage-sessions-info')
  prev.disabled = _st.sessionsOffset <= 0
  next.disabled = !sessions.has_more
  const start = _st.sessionsOffset + 1
  const end = _st.sessionsOffset + sessions.rows.length
  info.textContent = sessions.rows.length > 0 ? `${start}–${end}` : '0 条'

  // ledger 追加(而不是覆盖,以支持"加载更多"累加)
  const lt = $('usage-ledger-tbody')
  if (_st.ledgerBefore === null) {
    // 初次加载 → 清空重来
    lt.innerHTML = ''
  }
  for (const r of ledger.rows) {
    const tr = document.createElement('tr')
    const reasonZh = REASON_ZH[r.reason] || r.reason
    const delta = String(r.delta || '0')
    const deltaCls = delta.startsWith('-') ? 'usage-delta-neg' : 'usage-delta-pos'
    const cells = [
      { text: fmtTime(r.created_at) },
      { text: reasonZh },
      { text: formatYuan(delta), cls: deltaCls },
      { text: formatYuan(r.balance_after) },
      { text: r.memo || '—' },
    ]
    for (const c of cells) {
      const td = document.createElement('td')
      td.textContent = c.text
      if (c.cls) td.className = c.cls
      tr.appendChild(td)
    }
    lt.appendChild(tr)
  }
  if (lt.children.length === 0) {
    const tr = document.createElement('tr')
    const td = document.createElement('td')
    td.colSpan = 5
    td.className = 'usage-empty'
    td.textContent = '无流水记录'
    tr.appendChild(td)
    lt.appendChild(tr)
  }
  const moreBtn = $('usage-ledger-more')
  if (ledger.next_before) {
    moreBtn.hidden = false
    moreBtn.dataset.nextBefore = ledger.next_before
  } else {
    moreBtn.hidden = true
    delete moreBtn.dataset.nextBefore
  }
}

// ── Wire up ───────────────────────────────────────────────────────────

export function openUsageModal() {
  // 重置分页状态,每次打开从头
  _st = {
    sessionsOffset: 0,
    sessionsLimit: 20,
    ledgerLimit: 20,
    ledgerBefore: null,
    ledgerLoaded: [],
  }
  openModal('usage-modal')
  _loadUsage().catch(() => { /* 已在 _loadUsage 内 toast */ })
}

export function initUsageStats() {
  if (_wired) return
  _wired = true

  $('usage-sessions-prev')?.addEventListener('click', () => {
    const next = Math.max(0, _st.sessionsOffset - _st.sessionsLimit)
    if (next === _st.sessionsOffset) return
    _st.sessionsOffset = next
    _st.ledgerBefore = null   // 重载 ledger(保持和 summary 同步刷新)
    _loadUsage().catch(() => {})
  })
  $('usage-sessions-next')?.addEventListener('click', () => {
    _st.sessionsOffset += _st.sessionsLimit
    _st.ledgerBefore = null
    _loadUsage().catch(() => {})
  })
  $('usage-ledger-more')?.addEventListener('click', (e) => {
    const btn = e.currentTarget
    const nb = btn?.dataset?.nextBefore
    if (!nb) return
    _st.ledgerBefore = nb
    _loadUsage().catch(() => {})
  })

  // 关闭按钮:走 data-close-modal 已由 ui.js 全局监听处理
  // (参考 prefs-modal 模式,这里无需再绑)

  // 诊断未用 api: 保留 toast/closeModal import 以便后续扩展;eslint 静音
  void toast; void closeModal
}
