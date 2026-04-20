// OpenClaude (commercial v3) — auth module
//
// 多模态登录页:登录 / 注册 / 忘记密码 / 邮箱回调 / 重置密码 / 验证邮箱。
//
// 接入端点:
//   POST /api/auth/register           { email, password, turnstile_token }
//   POST /api/auth/login              { email, password, turnstile_token }
//   POST /api/auth/refresh            { refresh_token }
//   POST /api/auth/logout             { refresh_token }
//   POST /api/auth/verify-email       { token }
//   POST /api/auth/resend-verification{ email }
//   POST /api/auth/request-password-reset { email }
//   POST /api/auth/confirm-password-reset { token, new_password }
//   GET  /api/public/config           → { turnstile_site_key, turnstile_bypass, require_email_verified }
//
// URL 参数(邮件链接落地):
//   ?verify_email=<token>      → 自动切到 verify 模式并提交
//   ?reset_password=<token>    → 切到 confirm-reset 模式
//
// Token 存储:access_token + refresh_token + expiry 全部写到 localStorage
//   - openclaude_access_token / openclaude_refresh_token / openclaude_access_exp
//   - 以上由 main.js 经 onLoginSuccess 回调统一写入,本模块只 dispatch result

import { apiFetch } from './api.js'

const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__ocTurnstileReady&render=explicit'
let _publicConfig = null
let _publicConfigInflight = null
let _turnstileScriptLoaded = false
let _turnstileScriptInflight = null
let _widgetIdByContainer = new WeakMap()

let _onLoginSuccess = null

export function onLoginSuccess(cb) {
  _onLoginSuccess = cb
}

function $(id) { return document.getElementById(id) }
function _showError(msg) {
  const el = $('login-error')
  if (!el) return
  el.textContent = msg || ''
  el.style.display = msg ? 'block' : 'none'
}
function _clearError() { _showError('') }

// ───────── Public config (turnstile site key etc.) ─────────
export async function loadPublicConfig() {
  if (_publicConfig) return _publicConfig
  if (_publicConfigInflight) return _publicConfigInflight
  _publicConfigInflight = (async () => {
    try {
      const r = await apiFetch('/api/public/config', { suppressAuthRedirect: true })
      const j = await r.json().catch(() => ({}))
      _publicConfig = {
        turnstile_site_key: typeof j.turnstile_site_key === 'string' ? j.turnstile_site_key : '',
        turnstile_bypass: j.turnstile_bypass === true,
        require_email_verified: j.require_email_verified === true,
      }
    } catch {
      _publicConfig = { turnstile_site_key: '', turnstile_bypass: true, require_email_verified: false }
    }
    return _publicConfig
  })().finally(() => { _publicConfigInflight = null })
  return _publicConfigInflight
}

// ───────── Turnstile widget loader ─────────
function _loadTurnstileScript() {
  if (_turnstileScriptLoaded) return Promise.resolve()
  if (_turnstileScriptInflight) return _turnstileScriptInflight
  _turnstileScriptInflight = new Promise((resolve, reject) => {
    // Global ready hook required by ?onload=__ocTurnstileReady
    window.__ocTurnstileReady = () => {
      _turnstileScriptLoaded = true
      resolve()
    }
    const s = document.createElement('script')
    s.src = TURNSTILE_SCRIPT
    s.async = true
    s.defer = true
    s.onerror = () => reject(new Error('failed to load turnstile script'))
    document.head.appendChild(s)
  })
  return _turnstileScriptInflight
}

// Wait until the container is actually painted (non-zero dimensions).
// Cloudflare Turnstile silently fails to draw the iframe when rendered into a
// hidden / 0×0 parent — the hidden cf-turnstile-response input gets created but
// the visible challenge never appears, leaving the user staring at blank space.
async function _waitForVisible(container, maxFrames = 30) {
  for (let i = 0; i < maxFrames; i++) {
    if (container.offsetWidth > 0 && container.offsetHeight > 0) return true
    await new Promise((r) => requestAnimationFrame(r))
  }
  return container.offsetWidth > 0 && container.offsetHeight > 0
}

// Ensures a widget exists in the given container; returns getResponseFn.
async function _mountWidget(container) {
  const cfg = await loadPublicConfig()
  // bypass mode: no widget, return fixed token
  if (cfg.turnstile_bypass || !cfg.turnstile_site_key) {
    container.innerHTML = '<div style="color:var(--fg-muted);font-size:var(--text-xs)">[turnstile bypass]</div>'
    return () => 'bypass'
  }
  await _loadTurnstileScript()
  const existing = _widgetIdByContainer.get(container)
  if (existing != null) {
    try { window.turnstile?.reset(existing) } catch {}
    return () => {
      try { return window.turnstile?.getResponse(existing) || '' } catch { return '' }
    }
  }
  // Don't try to render into an invisible container — Turnstile bails silently.
  await _waitForVisible(container)
  container.innerHTML = ''
  const widgetId = window.turnstile.render(container, {
    sitekey: cfg.turnstile_site_key,
    theme: document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
    size: 'normal',
  })
  _widgetIdByContainer.set(container, widgetId)
  return () => {
    try { return window.turnstile?.getResponse(widgetId) || '' } catch { return '' }
  }
}

// ───────── Mode switching ─────────
const MODES = ['login', 'register', 'forgot', 'reset', 'verify']
let _currentMode = 'login'
let _resetToken = ''
let _verifyToken = ''
const _getTokenFns = {} // mode → fn returning turnstile response

// Cross-device verification poll state (started after register success).
// Cleared on mode switch / page hide / verified=true.
let _verifyPollTimer = null
let _verifyPollEmail = ''
let _verifyPollStartedAt = 0
const VERIFY_POLL_INTERVAL_MS = 4000
const VERIFY_POLL_MAX_MS = 10 * 60 * 1000 // 10 min

export function getCurrentMode() { return _currentMode }

export function setMode(mode) {
  if (!MODES.includes(mode)) mode = 'login'
  // Switching away from register kills any verify-pending poll
  if (mode !== 'register') _stopVerifyPoll()
  _currentMode = mode
  _clearError()
  for (const m of MODES) {
    const view = $(`auth-mode-${m}`)
    if (view) view.hidden = m !== mode
  }
  // Update tab styling (segmented control)
  for (const m of ['login', 'register', 'forgot']) {
    const tab = $(`auth-tab-${m}`)
    if (tab) {
      tab.classList.toggle('is-active', m === mode)
    }
  }
  // Hide tabs for URL-driven modes
  const tabs = $('auth-tabs')
  if (tabs) tabs.hidden = mode === 'reset' || mode === 'verify'

  // Mount turnstile widget for the current mode (only modes that need it)
  const widgetContainerId = {
    login: 'turnstile-login',
    register: 'turnstile-register',
    forgot: 'turnstile-forgot',
  }[mode]
  if (widgetContainerId) {
    const c = $(widgetContainerId)
    if (c) {
      _mountWidget(c).then((fn) => { _getTokenFns[mode] = fn })
        .catch(() => { _getTokenFns[mode] = () => '' })
    }
  }
  // Auto-trigger verify-email when entering verify mode
  if (mode === 'verify' && _verifyToken) {
    void _doVerifyEmail()
  }
  // Focus first input
  setTimeout(() => {
    const focusId = {
      login: 'auth-login-email',
      register: 'auth-register-email',
      forgot: 'auth-forgot-email',
      reset: 'auth-reset-password',
    }[mode]
    if (focusId) $(focusId)?.focus()
  }, 30)
}

// ───────── Init ─────────
export async function initAuth() {
  // Parse URL params for email-link-driven modes
  const params = new URLSearchParams(window.location.search)
  const verifyParam = params.get('verify_email')
  const resetParam = params.get('reset_password')

  // Wire tab clicks
  $('auth-tab-login')?.addEventListener('click', () => setMode('login'))
  $('auth-tab-register')?.addEventListener('click', () => setMode('register'))
  $('auth-tab-forgot')?.addEventListener('click', () => setMode('forgot'))

  // Wire form submit handlers
  $('auth-login-btn')?.addEventListener('click', _doLogin)
  $('auth-register-btn')?.addEventListener('click', _doRegister)
  $('auth-forgot-btn')?.addEventListener('click', _doRequestReset)
  $('auth-reset-btn')?.addEventListener('click', _doConfirmReset)
  $('auth-resend-verify-btn')?.addEventListener('click', _doResendVerification)
  $('auth-verify-back-btn')?.addEventListener('click', () => setMode('login'))
  $('auth-register-back-btn')?.addEventListener('click', () => {
    // Reset register sub-view back to the form for next time
    const form = $('auth-register-form')
    const ok = $('auth-register-success')
    if (form) form.hidden = false
    if (ok) ok.hidden = true
    setMode('login')
  })

  // Pause polling while tab is hidden — saves bandwidth + dodges throttling
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (_verifyPollTimer) {
        clearTimeout(_verifyPollTimer)
        _verifyPollTimer = null
      }
    } else if (_verifyPollEmail && !_verifyPollTimer && _currentMode === 'register') {
      // Resume + check immediately on tab focus (catches verifications that
      // happened while we were backgrounded)
      _scheduleVerifyPoll(0)
    }
  })

  // Enter key submits
  for (const [inputId, btnId] of [
    ['auth-login-password', 'auth-login-btn'],
    ['auth-register-confirm', 'auth-register-btn'],
    ['auth-forgot-email', 'auth-forgot-btn'],
    ['auth-reset-confirm', 'auth-reset-btn'],
  ]) {
    $(inputId)?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) $(btnId)?.click()
    })
  }

  // Pre-warm config so first widget render is snappy
  loadPublicConfig().catch(() => {})

  // URL-driven modes win over default
  if (verifyParam) {
    _verifyToken = verifyParam
    setMode('verify')
    // Strip token from URL so a refresh doesn't re-submit
    history.replaceState(null, '', window.location.pathname + window.location.hash)
  } else if (resetParam) {
    _resetToken = resetParam
    setMode('reset')
    history.replaceState(null, '', window.location.pathname + window.location.hash)
  } else {
    setMode('login')
  }
}

// ───────── Handlers ─────────
function _emailValid(s) { return typeof s === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) }

async function _doLogin() {
  _clearError()
  const email = $('auth-login-email').value.trim().toLowerCase()
  const password = $('auth-login-password').value
  if (!_emailValid(email)) { _showError('请输入有效邮箱'); return }
  if (!password) { _showError('请输入密码'); return }
  const turnstile_token = (_getTokenFns.login?.() || '').trim()
  if (!turnstile_token) { _showError('请完成人机验证'); return }
  await _withBusy('auth-login-btn', '登录中…', async () => {
    const r = await apiFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, turnstile_token }),
      suppressAuthRedirect: true,
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) {
      if (r.status === 403 && data?.error === 'EMAIL_NOT_VERIFIED') {
        _showError('邮箱尚未验证 — 请检查收件箱,或点击下方"重发验证邮件"')
        $('auth-login-resend-row').hidden = false
        return
      }
      _showError(_friendlyAuthError(data, r.status))
      return
    }
    // Success — emit to main.js
    _onLoginSuccess?.({
      user: data.user,
      access_token: data.access_token,
      access_exp: data.access_exp,
      refresh_token: data.refresh_token,
      refresh_exp: data.refresh_exp,
    })
  })
}

async function _doRegister() {
  _clearError()
  const email = $('auth-register-email').value.trim().toLowerCase()
  const password = $('auth-register-password').value
  const confirm = $('auth-register-confirm').value
  if (!_emailValid(email)) { _showError('请输入有效邮箱'); return }
  if (password.length < 8) { _showError('密码至少 8 位'); return }
  if (password !== confirm) { _showError('两次密码不一致'); return }
  const turnstile_token = (_getTokenFns.register?.() || '').trim()
  if (!turnstile_token) { _showError('请完成人机验证'); return }
  await _withBusy('auth-register-btn', '注册中…', async () => {
    const r = await apiFetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, turnstile_token }),
      suppressAuthRedirect: true,
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) {
      _showError(_friendlyAuthError(data, r.status))
      return
    }
    // Show verify-pending sub-view inside register tab
    $('auth-register-form').hidden = true
    $('auth-register-success').hidden = false
    $('auth-register-success-email').textContent = email
    // Kick off cross-device verification polling
    _startVerifyPoll(email)
  })
}

// ───────── Cross-device email-verify polling ─────────
// After register success we don't know which device the user will open the
// verification mail on. Poll the backend every 4s; when verified=true,
// switch to login mode with email pre-filled.
function _startVerifyPoll(email) {
  _stopVerifyPoll()
  _verifyPollEmail = email
  _verifyPollStartedAt = Date.now()
  _scheduleVerifyPoll(VERIFY_POLL_INTERVAL_MS)
}

function _stopVerifyPoll() {
  if (_verifyPollTimer) {
    clearTimeout(_verifyPollTimer)
    _verifyPollTimer = null
  }
  _verifyPollEmail = ''
  _verifyPollStartedAt = 0
}

function _scheduleVerifyPoll(delayMs) {
  if (_verifyPollTimer) clearTimeout(_verifyPollTimer)
  _verifyPollTimer = setTimeout(_pollVerifyOnce, delayMs)
}

async function _pollVerifyOnce() {
  _verifyPollTimer = null
  if (!_verifyPollEmail) return
  // Time-bound the loop so we don't poll forever if the user wandered off
  if (Date.now() - _verifyPollStartedAt > VERIFY_POLL_MAX_MS) {
    const w = $('auth-register-waiting')
    if (w) w.innerHTML = '<span style="color:var(--fg-muted)">已停止自动检查 — 请手动返回登录</span>'
    _stopVerifyPoll()
    return
  }
  const email = _verifyPollEmail
  try {
    const r = await apiFetch(
      '/api/auth/check-verification?email=' + encodeURIComponent(email),
      { method: 'GET', suppressAuthRedirect: true },
    )
    const data = await r.json().catch(() => ({}))
    if (r.ok && data?.verified === true) {
      // Verified! switch to login with email pre-filled
      _stopVerifyPoll()
      // Reset register sub-view so re-entering shows the form
      const form = $('auth-register-form')
      const ok = $('auth-register-success')
      if (form) form.hidden = false
      if (ok) ok.hidden = true
      setMode('login')
      const loginEmail = $('auth-login-email')
      if (loginEmail) loginEmail.value = email
      // Pre-fill + show a one-shot confirmation banner above the form
      _showError('') // clear
      const banner = $('login-error')
      if (banner) {
        banner.style.display = 'block'
        banner.style.color = 'var(--success, #2da44e)'
        banner.textContent = '✓ 邮箱验证成功 — 现在可以登录了'
        // Restore color on next error
        setTimeout(() => {
          if (banner.textContent && banner.textContent.startsWith('✓')) {
            banner.style.color = ''
            banner.style.display = 'none'
            banner.textContent = ''
          }
        }, 6000)
      }
      $('auth-login-password')?.focus()
      return
    }
  } catch {
    // network blip — fall through and reschedule
  }
  // Not verified yet — reschedule, but only if user is still on register tab
  if (_currentMode === 'register' && _verifyPollEmail && !document.hidden) {
    _scheduleVerifyPoll(VERIFY_POLL_INTERVAL_MS)
  }
}

async function _doRequestReset() {
  _clearError()
  const email = $('auth-forgot-email').value.trim().toLowerCase()
  if (!_emailValid(email)) { _showError('请输入有效邮箱'); return }
  const turnstile_token = (_getTokenFns.forgot?.() || '').trim()
  if (!turnstile_token) { _showError('请完成人机验证'); return }
  await _withBusy('auth-forgot-btn', '提交中…', async () => {
    // Note: backend doesn't currently take turnstile on this endpoint, but we still
    // gate client-side to slow down enumeration via UI; safe to omit from body.
    const r = await apiFetch('/api/auth/request-password-reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
      suppressAuthRedirect: true,
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) { _showError(_friendlyAuthError(data, r.status)); return }
    $('auth-forgot-form').hidden = true
    $('auth-forgot-success').hidden = false
    $('auth-forgot-success-email').textContent = email
  })
}

async function _doConfirmReset() {
  _clearError()
  const newPwd = $('auth-reset-password').value
  const confirm = $('auth-reset-confirm').value
  if (newPwd.length < 8) { _showError('密码至少 8 位'); return }
  if (newPwd !== confirm) { _showError('两次密码不一致'); return }
  await _withBusy('auth-reset-btn', '重置中…', async () => {
    const r = await apiFetch('/api/auth/confirm-password-reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: _resetToken, new_password: newPwd }),
      suppressAuthRedirect: true,
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) { _showError(_friendlyAuthError(data, r.status)); return }
    $('auth-reset-form').hidden = true
    $('auth-reset-success').hidden = false
    setTimeout(() => setMode('login'), 1500)
  })
}

async function _doVerifyEmail() {
  _clearError()
  const status = $('auth-verify-status')
  if (status) status.textContent = '正在验证邮箱…'
  try {
    const r = await apiFetch('/api/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: _verifyToken }),
      suppressAuthRedirect: true,
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) {
      if (status) status.textContent = `验证失败:${_friendlyAuthError(data, r.status)}`
      $('auth-verify-back-btn').hidden = false
      return
    }
    if (status) {
      status.textContent = data?.newly_verified ? '✓ 邮箱验证成功!现在可以登录了。' : '✓ 邮箱已验证。'
    }
    $('auth-verify-back-btn').hidden = false
    setTimeout(() => setMode('login'), 1500)
  } catch (e) {
    if (status) status.textContent = `网络错误,请重试:${String(e?.message || e)}`
    $('auth-verify-back-btn').hidden = false
  }
}

async function _doResendVerification() {
  _clearError()
  const email = $('auth-login-email').value.trim().toLowerCase()
  if (!_emailValid(email)) { _showError('请先在登录框填写邮箱'); return }
  await _withBusy('auth-resend-verify-btn', '发送中…', async () => {
    const r = await apiFetch('/api/auth/resend-verification', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
      suppressAuthRedirect: true,
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) { _showError(_friendlyAuthError(data, r.status)); return }
    _showError('') // clear
    $('auth-login-resend-status').textContent = '验证邮件已发送(若邮箱已注册并未验证),请查收'
    $('auth-login-resend-status').hidden = false
  })
}

// ───────── Helpers ─────────
async function _withBusy(btnId, busyText, fn) {
  const btn = $(btnId)
  if (!btn) { await fn(); return }
  const orig = btn.textContent
  btn.disabled = true
  btn.textContent = busyText
  try {
    await fn()
  } catch (e) {
    _showError(`网络错误:${String(e?.message || e)}`)
  } finally {
    btn.disabled = false
    btn.textContent = orig
  }
}

function _friendlyAuthError(data, status) {
  const code = data?.error || ''
  const msg = data?.message || ''
  switch (code) {
    case 'INVALID_CREDENTIALS': return '邮箱或密码错误'
    case 'EMAIL_NOT_VERIFIED':  return '邮箱尚未验证,请检查收件箱'
    case 'CONFLICT':            return '该邮箱已注册'
    case 'TURNSTILE_FAILED':    return '人机验证失败,请重试'
    case 'VALIDATION':          return msg || '输入格式不合法'
    case 'INVALID_TOKEN':       return '链接已失效或被使用过,请重新获取'
    case 'RATE_LIMITED':        return '操作过于频繁,请稍后再试'
    default:
      if (status === 401) return '认证失败'
      if (status === 403) return '无权访问'
      return msg || code || `请求失败(${status})`
  }
}
