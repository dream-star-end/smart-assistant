// OpenClaude — WeChat (iLink) binding panel
//
// Flow:
//   1. User clicks "微信绑定" → openWechatModal()
//   2. Load current binding (GET /api/wechat/binding)
//      - if null → unbound state (show Start button)
//      - if present → bound state (show account + status)
//   3. Click Start → POST /api/wechat/pair/start → render qrcodeImgContent as QR
//   4. Begin poll loop (POST /api/wechat/pair/poll) until status != waiting/scanned
//   5. On confirmed → reload binding, switch to bound state
//
// QR rendering: done FULLY client-side via /vendor/qrcode.min.js
// (qrcode-generator, MIT, global `window.qrcode`). The iLink qrcodeImgContent
// is a sensitive short-lived scan target — sending it to any off-box QR
// service (api.qrserver.com, etc.) would let third parties hijack the pair
// handshake, so we never leave the page with that value.

import { apiGet, apiJson } from './api.js?v=24725e3'
import { $ } from './dom.js?v=24725e3'
import { closeModal, openModal, toast } from './ui.js?v=24725e3'

let _pollAbort = null
let _currentQrcode = null

function setError(msg) {
  const el = $('wechat-error')
  if (!el) return
  if (!msg) {
    el.hidden = true
    el.textContent = ''
  } else {
    el.hidden = false
    el.textContent = msg
  }
}

function showState(name) {
  for (const s of ['unbound', 'pairing', 'bound']) {
    const el = $(`wechat-state-${s}`)
    if (el) el.hidden = s !== name
  }
}

async function loadBinding() {
  try {
    const resp = await apiGet('/api/wechat/binding')
    const { binding, channel_enabled } = resp || {}
    if (!binding) {
      showState('unbound')
      // 2026-04-25 audit P0-1:生产 channels.wechat.enabled=false 时用户点"开始"
      // 会被 409。提前给一行提示让其别白扫。
      if (channel_enabled === false) {
        setError('服务端暂未启用微信通道,请联系管理员')
      } else {
        setError('')
      }
      return null
    }
    $('wechat-account').textContent = `account_id=${binding.accountId}\nlogin_user_id=${binding.loginUserId || '(未知)'}`
    const statusColor = binding.status === 'active' ? 'var(--success, #22c55e)'
      : binding.status === 'expired' ? 'var(--danger, #ef4444)'
      : 'var(--fg-muted)'
    // worker_running=false 但 status=active:DB 记录在,但 manager 没起 worker
    // (config.enabled=false / 新绑定还没 reconcile / init 失败)。告诉用户消息收不到,
    // 避免看到绿色 active 以为一切正常(生产 2026-04-25 踩过坑)。
    const workerWarn = (binding.worker_running === false)
      ? ` <span style="color:var(--danger, #ef4444);margin-left:8px">· 通道未启用,消息收不到</span>`
      : ''
    $('wechat-status').innerHTML = `<span style="color:${statusColor}">${binding.status}</span>` +
      (binding.lastEventAt ? ` · 最近消息 ${new Date(binding.lastEventAt).toLocaleString()}` : '') +
      workerWarn
    showState('bound')
    return binding
  } catch (e) {
    setError(`加载绑定失败: ${e?.message || e}`)
    return null
  }
}

// Render QR client-side into a data URL. Picks the smallest QR version that
// fits the payload. Throws if the global `qrcode` library (qrcode-generator)
// is missing (vendor script didn't load).
function qrDataUrl(text, size = 480) {
  const maker = typeof window !== 'undefined' ? window.qrcode : undefined
  if (typeof maker !== 'function') {
    throw new Error('QR 渲染库未加载 (qrcode-generator)')
  }
  // typeNumber=0 → auto-detect smallest version; ECL 'M' is the standard.
  const qr = maker(0, 'M')
  qr.addData(String(text))
  qr.make()
  // Compute cellSize so the rendered QR ~= `size` px. moduleCount varies by version.
  const modules = qr.getModuleCount()
  const cellSize = Math.max(1, Math.floor(size / (modules + 4)))
  // createDataURL(cellSize, margin). margin=2 modules is the standard quiet zone.
  return qr.createDataURL(cellSize, 2)
}

async function startPairing() {
  setError('')
  try {
    const { qrcode, qrcodeImgContent } = await apiJson('POST', '/api/wechat/pair/start')
    _currentQrcode = qrcode
    $('wechat-qr-img').src = qrDataUrl(qrcodeImgContent)
    $('wechat-pairing-status').textContent = '请用微信扫描二维码,在手机上点击"关注/确认"...'
    showState('pairing')
    pollLoop(qrcode)
  } catch (e) {
    // WECHAT_DISABLED 是服务端 channels.wechat.enabled=false 时的专属 409 码
    // (audit 2026-04-25 P0-1),给明确提示而不是通用"获取二维码失败"。
    // setError 写在 modal 内 banner,另加 toast 是因为弹窗内容被 scroll 遮挡
    // 或用户视线不在 banner 处时 toast 能即时给反馈(Codex R2 IMPORTANT#4)。
    if (e?.code === 'WECHAT_DISABLED') {
      const msg = e.message || '服务端暂未启用微信通道,请联系管理员'
      setError(msg)
      toast(msg, 'error')
    } else {
      setError(`获取二维码失败: ${e?.message || e}`)
    }
    showState('unbound')
  }
}

// 2026-04-21 安全审计 Medium#F4 + Codex IMPORTANT#2:
//   - 请求超时保持 45s。服务端长轮询到 iLink 是 35s + 最多 5s 内部 slack(见
//     channels/wechat/src/iLink.ts: ILINK_LONG_POLL_TIMEOUT_MS),减到 15s 会让
//     client 每次都在 server 真返回前就 abort,产生 scan 永远 stuck 的重试风暴
//   - 两段死线:
//       * POLL_WAIT_DEADLINE_MS    —— 还在 waiting 状态(没扫)的最大等待
//       * POLL_CONFIRM_DEADLINE_MS —— 一旦进 scanned,允许用户在手机上按确认
//     只用单一死线会让"弱网下 2:55 才扫,1s 后超时"的 UX 惨剧发生(Codex 指出)。
//     分段死线让 scanned→confirmed 的人工确认阶段重新获得 2 分钟窗口。
//   - QR 上游 TTL 10 min,两段死线加起来 <10 min 留足冗余。
const POLL_TIMEOUT_MS = 45_000
const POLL_WAIT_DEADLINE_MS = 3 * 60_000     // 3 min 未扫即视为放弃
const POLL_CONFIRM_DEADLINE_MS = 2 * 60_000  // 扫了之后 2 min 里必须点确认

async function pollLoop(qrcode) {
  if (_pollAbort) _pollAbort.abort()
  const ctrl = new AbortController()
  _pollAbort = ctrl
  let retries = 0
  const startedAt = Date.now()
  let scannedAt = 0  // 0 = 尚未 scanned;>0 = scanned 时间戳,切到 confirm 阶段
  while (!ctrl.signal.aborted && _currentQrcode === qrcode) {
    // 根据当前阶段应用不同死线,同时算出"距死线还剩多少"
    const now = Date.now()
    let remainingUntilDeadline
    if (scannedAt === 0) {
      remainingUntilDeadline = POLL_WAIT_DEADLINE_MS - (now - startedAt)
      if (remainingUntilDeadline <= 0) {
        setError('扫码超时,请重新生成二维码')
        showState('unbound')
        return
      }
    } else {
      remainingUntilDeadline = POLL_CONFIRM_DEADLINE_MS - (now - scannedAt)
      if (remainingUntilDeadline <= 0) {
        setError('确认超时,请重新扫码')
        showState('unbound')
        return
      }
    }
    // 2026-04-22 Codex R1 I8:本轮请求超时 = min(POLL_TIMEOUT_MS, deadlineRemaining)
    // 否则 "deadline 还剩 5s 但 POLL_TIMEOUT_MS=45s" 会导致最后一次 poll 正好阻塞到
    // 45s 后才爆 AbortError,用户看到的"超时提示"比应有时间晚了 40s(弱网 UX 惨剧)。
    // 下限给 1s:避免 0ms/负数打到 apiJson 立即 AbortError 进 retry busy-loop。
    const thisRoundTimeout = Math.max(1_000, Math.min(POLL_TIMEOUT_MS, remainingUntilDeadline))
    let resp
    try {
      resp = await apiJson('POST', '/api/wechat/pair/poll', { qrcode }, { signal: ctrl.signal, timeout: thisRoundTimeout })
    } catch (e) {
      if (ctrl.signal.aborted) return
      retries++
      if (retries > 3) {
        setError(`扫码查询失败: ${e?.message || e}`)
        showState('unbound')
        return
      }
      await new Promise((r) => setTimeout(r, 1500))
      continue
    }
    retries = 0
    if (resp?.status === 'waiting') continue
    if (resp?.status === 'scanned') {
      if (scannedAt === 0) scannedAt = Date.now()  // 只在首次 scanned 时锚
      $('wechat-pairing-status').textContent = '已扫描,请在手机微信中点击"确认"...'
      continue
    }
    if (resp?.status === 'expired') {
      setError('二维码已过期,请重新开始')
      showState('unbound')
      return
    }
    if (resp?.status === 'confirmed') {
      toast('微信绑定成功', 'success')
      _currentQrcode = null
      await loadBinding()
      return
    }
    // unknown → retry slowly
    await new Promise((r) => setTimeout(r, 2000))
  }
}

async function unbind() {
  if (!confirm('确定解绑?该微信号将无法再与此 OC 用户对话。')) return
  try {
    await apiJson('DELETE', '/api/wechat/binding')
    toast('已解绑', 'success')
    showState('unbound')
  } catch (e) {
    setError(`解绑失败: ${e?.message || e}`)
  }
}

export function openWechatModal() {
  setError('')
  showState('unbound')
  openModal('wechat-modal')
  loadBinding()
}

export function initWechatListeners() {
  $('wechat-start-btn').onclick = startPairing
  $('wechat-refresh-btn').onclick = loadBinding
  $('wechat-unbind-btn').onclick = unbind

  // Abort any in-flight pairing poll when the modal closes.
  document.addEventListener('click', (e) => {
    const close = e.target.closest?.('[data-close-modal="wechat-modal"]')
    if (!close) return
    if (_pollAbort) _pollAbort.abort()
    _currentQrcode = null
    closeModal('wechat-modal')
  })
}
