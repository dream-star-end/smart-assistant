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

import { apiGet, apiJson } from './api.js'
import { $ } from './dom.js'
import { closeModal, openModal, toast } from './ui.js'

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
    const { binding } = await apiGet('/api/wechat/binding')
    if (!binding) {
      showState('unbound')
      return null
    }
    $('wechat-account').textContent = `account_id=${binding.accountId}\nlogin_user_id=${binding.loginUserId || '(未知)'}`
    const statusColor = binding.status === 'active' ? 'var(--success, #22c55e)'
      : binding.status === 'expired' ? 'var(--danger, #ef4444)'
      : 'var(--fg-muted)'
    $('wechat-status').innerHTML = `<span style="color:${statusColor}">${binding.status}</span>` +
      (binding.lastEventAt ? ` · 最近消息 ${new Date(binding.lastEventAt).toLocaleString()}` : '')
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
    setError(`获取二维码失败: ${e?.message || e}`)
    showState('unbound')
  }
}

async function pollLoop(qrcode) {
  if (_pollAbort) _pollAbort.abort()
  const ctrl = new AbortController()
  _pollAbort = ctrl
  let retries = 0
  while (!ctrl.signal.aborted && _currentQrcode === qrcode) {
    let resp
    try {
      resp = await apiJson('POST', '/api/wechat/pair/poll', { qrcode }, { signal: ctrl.signal, timeout: 45000 })
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
