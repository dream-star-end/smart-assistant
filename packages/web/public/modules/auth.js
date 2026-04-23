// OpenClaude (commercial v3) — auth module
//
// 多模态登录页:登录 / 注册 / 忘记密码 / 邮箱回调 / 重置密码 / 验证邮箱。
//
// 接入端点:
//   POST /api/auth/register           { email, password, turnstile_token }
//   POST /api/auth/login              { email, password, turnstile_token }
//   POST /api/auth/refresh            ()  ← cookie oc_rt 自动携带,迁移期兼容 body { refresh_token }
//   POST /api/auth/logout             ()  ← 同上
//   POST /api/auth/verify-email       { token }
//   POST /api/auth/resend-verification{ email }
//   POST /api/auth/request-password-reset { email, turnstile_token }
//   POST /api/auth/confirm-password-reset { token, new_password }
//   GET  /api/public/config           → { turnstile_site_key, turnstile_bypass, require_email_verified }
//
// URL 参数(邮件链接落地):
//   ?verify_email=<token>      → 自动切到 verify 模式并提交
//   ?reset_password=<token>    → 切到 confirm-reset 模式
//
// Token 存储(2026-04-21 HIGH#4 后):
//   - access JWT + access_exp → localStorage(openclaude_access_token / openclaude_access_exp)
//   - refresh JWT             → 服务器 Set-Cookie HttpOnly oc_rt(JS 不可见)
//   - 以上由 main.js 经 onLoginSuccess 回调统一处理,本模块只 dispatch result

// NB: bare `./api.js` 必须与其他模块保持一致 —— ESM 按 URL 唯一性分 instance,
// 加 ?v= 会与 main.js 等共享的 api.js 分叉两个实例,_refreshInflight 这类 module
// singleton 全废。CF 边缘缓存对 api.js 改动靠 sw.js VERSION bump 触发 SW 新一轮
// 预缓存 + 运行时 `cache: 'no-store'` 接管。
import { apiFetch } from './api.js'
import { state } from './state.js'

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

// ───────── Session cookie mint / clear (V3 file-proxy) ─────────
// V3 commercial 给 <img src="/api/file?...">、<a href="/api/media/...">download 这类
// 浏览器原生发起的、没有 Authorization header 的 GET 请求加 HttpOnly 会话 cookie
// `oc_session`(Path=/api/,SameSite=Strict,HttpOnly,Max-Age=min(exp-now, 30d))。
//
// 时机:login success / silentRefresh success / app 启动时 state.token 有效
// 清除:_forceLogout 前调用 clearSessionCookie
//
// **身份切换竞态硬化**(Codex R1 BLOCKER):
//   裸 fire-and-forget 的 mint/clear 在共享浏览器多账号切换场景有 "旧 A 的 mint
//   响应在新 B 登录后到达,覆盖 B 的 oc_session 成 A 的" 问题 —— 随后 <img>/<a>
//   请求只带 cookie,HOST 按 A 的身份代理到 A 容器,B 看到 A 的文件。
//   解法:
//     a) 每次 mint/clear 各挂自己的 AbortController,登录/登出/mint/clear 之间互相
//        abort(缩短请求悬挂时间)
//     b) mint 传入发起时的 authEpoch;响应回来后如果 epoch 已变,发起一次 self-clear
//        抵消可能已被 Set-Cookie 的旧身份 cookie(Set-Cookie 在 response header
//        到达时就被浏览器应用,abort 无法收回 —— 必须用反向操作消除影响)
//     c) 登录流程:caller 先 abortInflightMintClear(),再 mint 新 token;
//        登出流程:先 abortInflightMintClear(),再 clear
let _mintClearAbort = null

export function abortInflightMintClear() {
  try { _mintClearAbort?.abort(new DOMException('auth epoch changed', 'AbortError')) } catch {}
  _mintClearAbort = null
}

export async function mintSessionCookie(accessToken, expectedEpoch) {
  // R3 BLOCKER:发请求前先做 epoch 预检 —— 防止 silentRefresh 成功回调里那个
  // fire-and-forget 的 dynamic-import mint callback 跨身份漂移。
  //   场景:A 的 refresh 还在路上 → B 登录成功(bump epoch + 串行 await clear→mint)
  //   → A 的 refresh 响应到达 → _doRefreshOnce 内部 epoch check 已拦下(没 commit token),
  //     但 success 分支的 `import('./auth.js').then(mint)` 异步链晚一 tick 才跑,到那时
  //     epoch 已是 B 的,旧 A 的 mint 仍会:
  //       1) abortInflightMintClear() 中断 B 的 mint/clear 请求
  //       2) 发一个带 A token 的 /api/auth/session(Bearer 已用 data.access_token 参数拷贝)
  //     结果 Set-Cookie 写 A 的 oc_session,才靠 response 后 mismatch self-clear 补救。
  // 一行预检把第 1/2 步直接跳过,留"请求期间 epoch 变化"这一条窄边界给 self-clear 兜底。
  if (typeof expectedEpoch === 'number' && (state.authEpoch || 0) !== expectedEpoch) return
  abortInflightMintClear()
  const ctrl = new AbortController()
  _mintClearAbort = ctrl
  let ok = false
  try {
    const r = await fetch('/api/auth/session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: ctrl.signal,
    })
    ok = r.ok
  } catch {
    // aborted / network — cookie not affected
    return
  } finally {
    if (_mintClearAbort === ctrl) _mintClearAbort = null
  }
  // R1 加固:response 已到,Set-Cookie 已生效。如果 authEpoch 在请求过程中
  // 变过(login→logout / logout→login / multi-tab race),当前 oc_session 可能
  // 反映的是已失效身份的 JWT。发一次 clear 把它擦掉;后续持有新身份 access token
  // 的 caller 会再 mint 一次,最终 cookie 跟当前 epoch 对齐。
  if (ok && typeof expectedEpoch === 'number' && (state.authEpoch || 0) !== expectedEpoch) {
    try {
      await fetch('/api/auth/session/logout', {
        method: 'POST',
        credentials: 'same-origin',
      })
    } catch {
      // 最后一道防护线挂了就算了;HttpOnly 且 Max-Age 短,等 JWT exp 自然失效
    }
  }
}

export async function clearSessionCookie() {
  abortInflightMintClear()
  const ctrl = new AbortController()
  _mintClearAbort = ctrl
  try {
    await fetch('/api/auth/session/logout', {
      method: 'POST',
      credentials: 'same-origin',
      signal: ctrl.signal,
    })
  } catch {
    // logout 本来就是 best-effort
  } finally {
    if (_mintClearAbort === ctrl) _mintClearAbort = null
  }
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

// 失败后 reset widget —— Cloudflare Turnstile token 是**一次性**的,CF 内部
// verify 过一次之后再用同一个 token 会返回 `timeout-or-duplicate` (success=false),
// 后端翻译成 TURNSTILE_FAILED。如果前端登录失败不 reset,下次提交仍然拿老
// token,用户就卡在一直 rejected 里。
// 只在**请求已发出到后端、CF token 已被消费**的失败路径上调用。
function _resetTurnstileFor(mode) {
  const containerId = {
    login: 'turnstile-login',
    register: 'turnstile-register',
    forgot: 'turnstile-forgot',
  }[mode]
  if (!containerId) return
  const c = $(containerId)
  if (!c) return
  const wid = _widgetIdByContainer.get(c)
  if (wid == null) return // bypass 模式或 widget 还没挂载 → 无需 reset
  try { window.turnstile?.reset(wid) } catch {}
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
  // Update card head title/subtitle (design-kit variant uses per-mode copy)
  const HEADS = {
    login: { t: '欢迎回来', s: '登录你的 OpenClaude 账号' },
    register: { t: '创建账号', s: '1 分钟开始使用满血 Opus' },
    forgot: { t: '找回密码', s: '我们会发送重置链接到你的邮箱' },
    reset: { t: '重置密码', s: '请设置一个新的登录密码' },
    verify: { t: '邮箱验证', s: '正在完成邮箱验证…' },
  }
  const head = HEADS[mode] || HEADS.login
  const tEl = $('auth-card-title'); if (tEl) tEl.textContent = head.t
  const sEl = $('auth-card-sub'); if (sEl) sEl.textContent = head.s

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

  // Wire tab/toggle clicks (bottom inline links in design-kit layout)
  $('auth-tab-login')?.addEventListener('click', () => setMode('login'))
  $('auth-tab-register')?.addEventListener('click', () => setMode('register'))
  $('auth-tab-forgot')?.addEventListener('click', () => setMode('forgot'))
  // Duplicate ID-free bottom toggle inside register pane: "已有账号? 直接登录"
  $('auth-tab-login-from-register')?.addEventListener('click', () => setMode('login'))

  // Wire form submit handlers
  $('auth-login-btn')?.addEventListener('click', _doLogin)
  $('auth-register-btn')?.addEventListener('click', _doRegister)
  $('auth-forgot-btn')?.addEventListener('click', _doRequestReset)
  $('auth-reset-btn')?.addEventListener('click', _doConfirmReset)
  $('auth-resend-verify-btn')?.addEventListener('click', _doResendVerification)
  $('auth-verify-back-btn')?.addEventListener('click', () => setMode('login'))
  $('auth-forgot-back-btn')?.addEventListener('click', () => setMode('login'))
  $('auth-forgot-success-back-btn')?.addEventListener('click', () => {
    // 重置 forgot 子视图回到 form,以便下次进入仍是邮箱输入态
    const form = $('auth-forgot-form')
    const ok = $('auth-forgot-success')
    if (form) form.hidden = false
    if (ok) ok.hidden = true
    setMode('login')
  })
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
      // 请求已发出,CF token 已被 verify(无论通没通),必须 reset 下次才能拿新 token
      _resetTurnstileFor('login')
      // 2026-04-23 修复:data.error 是对象不是字符串(后端标准 shape),
      // 之前 `data?.error === 'EMAIL_NOT_VERIFIED'` 永远 false,用户看到泛文案
      // 而不是"重发验证邮件"入口
      const errCode =
        data?.error && typeof data.error === 'object' ? data.error.code : data?.error
      if (r.status === 403 && errCode === 'EMAIL_NOT_VERIFIED') {
        _showError('邮箱尚未验证 — 请检查收件箱,或点击下方"重发验证邮件"')
        $('auth-login-resend-row').hidden = false
        return
      }
      _showError(_friendlyAuthError(data, r.status))
      return
    }
    // Success — emit to main.js
    // HIGH#4 后 refresh token 不再出现在 body,只通过 HttpOnly cookie 下发;
    // refresh_exp 仍保留作为"会话剩余时间"展示用。
    _onLoginSuccess?.({
      user: data.user,
      access_token: data.access_token,
      access_exp: data.access_exp,
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
      _resetTurnstileFor('register')
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
    // Backend enforces turnstile (HIGH#3) — must include token in body, otherwise
    // 400 TURNSTILE_FAILED. Token is captured client-side via _getTokenFns.forgot
    // (set when this mode was mounted).
    const r = await apiFetch('/api/auth/request-password-reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, turnstile_token }),
      suppressAuthRedirect: true,
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) { _resetTurnstileFor('forgot'); _showError(_friendlyAuthError(data, r.status)); return }
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
  // 新版:添加 .is-loading class (纯 spinner,文本保留以防回退),保留 disabled
  // busyText 参数仅在浏览器不支持 CSS loading 态时作为 fallback(已弃用,保留签名兼容)
  btn.disabled = true
  btn.classList.add('is-loading')
  btn.setAttribute('aria-busy', 'true')
  try {
    await fn()
  } catch (e) {
    _showError(`网络错误:${String(e?.message || e)}`)
  } finally {
    btn.disabled = false
    btn.classList.remove('is-loading')
    btn.removeAttribute('aria-busy')
  }
}

/**
 * 从后端响应 body 里抽取友好文案。
 *
 * 2026-04-23 修复:之前写的是 `const code = data?.error || ''`,但后端标准错误
 * shape 是 `{error: {code, message, request_id}}` —— data.error 是对象不是
 * 字符串,code 永远 = `[object Object]`,所有 switch 分支全走 default,用户看
 * 到的永远是 `认证失败` / `请求失败(401)` 这种泛文案。TURNSTILE_FAILED /
 * RATE_LIMITED / EMAIL_NOT_VERIFIED 的友好中文文案全都 dead code。
 *
 * 一并兜 legacy 格式(`{error: "CODE_STRING"}` 或 `{message: "..."}`),保持
 * 向下兼容 —— 旧后端/中转层如果还返老 shape,fallback 仍能抽到 code/message。
 */
function _friendlyAuthError(data, status) {
  let code = ''
  let msg = ''
  if (data && typeof data === 'object') {
    if (data.error && typeof data.error === 'object') {
      // 后端标准:{ error: { code, message, request_id, issues? } }
      code = typeof data.error.code === 'string' ? data.error.code : ''
      msg = typeof data.error.message === 'string' ? data.error.message : ''
    } else if (typeof data.error === 'string') {
      // legacy:{ error: "CODE_STRING" }
      code = data.error
      msg = typeof data.message === 'string' ? data.message : ''
    } else if (typeof data.message === 'string') {
      // legacy:{ message: "..." }
      msg = data.message
    }
  }
  switch (code) {
    case 'INVALID_CREDENTIALS': return '邮箱或密码错误'
    case 'EMAIL_NOT_VERIFIED':  return '邮箱尚未验证,请检查收件箱'
    case 'CONFLICT':            return '该邮箱已注册'
    case 'TURNSTILE_FAILED':    return '人机验证失败,请重试'
    case 'VALIDATION':          return msg || '输入格式不合法'
    case 'INVALID_TOKEN':       return '链接已失效或被使用过,请重新获取'
    case 'RATE_LIMITED':        return '操作过于频繁,请稍后再试'
    default:
      if (status === 401) return msg || '认证失败'
      if (status === 403) return msg || '无权访问'
      return msg || code || `请求失败(${status})`
  }
}
