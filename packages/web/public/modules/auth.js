// OpenClaude (commercial v3) — auth module
//
// 多模态登录页:登录 / 注册 / 忘记密码 / 邮箱回调 / 重置密码 / 验证邮箱。
//
// 接入端点:
//   POST /api/auth/register           { email, password, turnstile_token }
//   POST /api/auth/login              { email, password, turnstile_token }
//   POST /api/auth/refresh            ()  ← cookie oc_rt 自动携带,迁移期兼容 body { refresh_token }
//   POST /api/auth/logout             ()  ← 同上
//   POST /api/auth/verify-email       { email, code }      (2026-04-23 改 code-based)
//   POST /api/auth/resend-verification{ email }
//   POST /api/auth/request-password-reset { email, turnstile_token }
//   POST /api/auth/confirm-password-reset { token, new_password }
//   GET  /api/public/config           → { turnstile_site_key, turnstile_bypass, require_email_verified }
//
// URL 参数(邮件链接落地):
//   ?reset_password=<token>    → 切到 confirm-reset 模式
//   (verify_email 不再走 URL,改为用户输入 6 位数字 code)
//
// Token 存储(2026-04-24 "记住我" 之后):
//   - access JWT + access_exp → localStorage(勾选"记住我",默认)或
//                                sessionStorage(不勾,浏览器关窗口即清)
//     具体读写全走 state.js 的 _readStoredAccessToken / _writeStoredAccessToken /
//     _clearStoredAccessToken 三个 helper,不要再直接访问 localStorage。
//   - refresh JWT             → 服务器 Set-Cookie HttpOnly oc_rt(JS 不可见),
//                                persistent 属性跟着 remember 走(handlers.ts)。
//   - 以上由 main.js 经 onLoginSuccess 回调统一处理,本模块只 dispatch result。

// NB:这两行 import 必须与其他模块对 ./api.js / ./state.js 的引用共享同一 URL。
// ESM 按 URL 唯一性分 instance —— 一旦「裸 import」和「带 ?v= 的 import」并存,
// 浏览器会建出两个 module instance,_refreshInflight 这类 module-level singleton
// 全废。v1.0.15 起的机制是「所有模块统一带 ?v=<token>」由 scripts/bump-version.ts
// 同步替换 + --check 防退化;手工把这两行改回 bare 会重新破坏 URL 一致性。
//
// CF 边缘缓存对 api.js/state.js 自身的改动仍靠 sw.js VERSION bump 触发 SW 新一轮
// 预缓存 + 运行时 `cache: 'no-store'` 接管。
import { apiFetch } from './api.js?v=8ad8aaa'
import { state } from './state.js?v=8ad8aaa'

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

/**
 * 给当前身份种 oc_session HttpOnly cookie(file-proxy 用,没 cookie file 链接 401)。
 *
 * 返回值(2026-04-28 SSO 接入新增):
 *   - true  → 服务端 200 且 epoch 在请求前后未变(cookie 与当前身份一致)
 *   - false → 任何失败:network、!r.ok、aborted、或请求中 epoch 已变(self-clear 后)
 *
 * SSO oauthCallback 路径 caller(main.js runPostLoginPipeline)需要据此判断是否
 * 需要降级提示用户"file 预览暂时不可用"—— 旧版 swallow error 的语义对登录
 * 主链路是合理的(mint 失败不该挡 access token 写入),但对 SSO 整体 UX 来说,
 * 知道 mint 是否成功能让 toast 文案更精准。
 */
export async function mintSessionCookie(accessToken, expectedEpoch) {
  // R3 BLOCKER:发请求前先做 epoch 预检 —— 防止 silentRefresh 成功回调里那个
  // fire-and-forget 的 dynamic-import mint callback 跨身份漂移。
  //   场景:A 的 refresh 还在路上 → B 登录成功(bump epoch + 串行 await clear→mint)
  //   → A 的 refresh 响应到达 → _doRefreshOnce 内部 epoch check 已拦下(没 commit token),
  //     但 success 分支的 `import('./auth.js?v=8ad8aaa').then(mint)` 异步链晚一 tick 才跑,到那时
  //     epoch 已是 B 的,旧 A 的 mint 仍会:
  //       1) abortInflightMintClear() 中断 B 的 mint/clear 请求
  //       2) 发一个带 A token 的 /api/auth/session(Bearer 已用 data.access_token 参数拷贝)
  //     结果 Set-Cookie 写 A 的 oc_session,才靠 response 后 mismatch self-clear 补救。
  // 一行预检把第 1/2 步直接跳过,留"请求期间 epoch 变化"这一条窄边界给 self-clear 兜底。
  if (typeof expectedEpoch === 'number' && (state.authEpoch || 0) !== expectedEpoch) return false
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
    return false
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
    // self-clear 走过 = 当前 cookie 已不属于 caller 期望的 epoch,返 false
    return false
  }
  return ok
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
  el.style.removeProperty('display')
  el.hidden = !msg
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
  // Per-attempt guard: only this attempt's failure handlers may reset the
  // global inflight pointer, otherwise a stale A-attempt onerror could clobber
  // a later B-attempt's inflight marker and cause duplicate script injection.
  const promise = new Promise((resolve, reject) => {
    const resetIfCurrent = () => {
      if (_turnstileScriptInflight === promise) _turnstileScriptInflight = null
    }
    const timer = setTimeout(() => {
      resetIfCurrent()
      reject(new Error('turnstile script load timeout'))
    }, 15000)
    // Global ready hook required by ?onload=__ocTurnstileReady
    window.__ocTurnstileReady = () => {
      clearTimeout(timer)
      _turnstileScriptLoaded = true
      resolve()
    }
    const s = document.createElement('script')
    s.src = TURNSTILE_SCRIPT
    s.async = true
    s.defer = true
    s.onerror = () => {
      clearTimeout(timer)
      resetIfCurrent()
      reject(new Error('failed to load turnstile script'))
    }
    document.head.appendChild(s)
  })
  _turnstileScriptInflight = promise
  return promise
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
  // bypass mode: no widget, hide the slot entirely (.login-turnstile has
  // min-height:65px + margin → 即使 innerHTML='' 也会留 65px 空白,所以用
  // hidden 整块隐藏,后端 bypass 路径不变。
  if (cfg.turnstile_bypass || !cfg.turnstile_site_key) {
    container.innerHTML = ''
    container.hidden = true
    return () => 'bypass'
  }
  // 必须先查 existing,再决定要不要写 placeholder —— 之前 render 过的话,
  // CF widget 的 DOM 节点是 container 的子树,任何 innerHTML 写入都会把它
  // 物理销毁。CF 内部 widgetId map 仍指向旧节点 → reset/getResponse 都失败,
  // console 会出现 "Cannot find Widget cf-chl-widget-XXX",用户停在 placeholder
  // 上提交时 token 是空 → 后端 TURNSTILE_FAILED。(2026-04-26 boss 反馈)
  const existing = _widgetIdByContainer.get(container)
  if (existing != null) {
    try { window.turnstile?.reset(existing) } catch {}
    return () => {
      try { return window.turnstile?.getResponse(existing) || '' } catch { return '' }
    }
  }
  // 首次 mount 才走 placeholder + script load + render 路径。
  // CF challenges.cloudflare.com 可能慢或被墙;空 div 看起来像坏了,所以放
  // placeholder。render() 成功时下面的 innerHTML='' 会覆盖它。
  // 对偶恢复:若先前在 bypass 分支被 hidden,这里要 unhide,否则 turnstile.render
  // 进 0×0 容器会静默失败。
  container.hidden = false
  container.innerHTML = '<div class="muted" style="font-size:var(--text-xs);padding:8px 0">正在加载人机验证…</div>'
  try {
    await _loadTurnstileScript()
  } catch {
    container.innerHTML = '<div style="color:var(--danger);font-size:var(--text-xs);padding:8px 0">人机验证加载失败,请检查网络后刷新页面</div>'
    return () => ''
  }
  // Don't try to render into an invisible container — Turnstile bails silently
  // inside a 0×0 parent,但 render() 仍返回 widgetId;后续 setMode 只做 reset 而
  // 不 re-render → widget 永远卡死,用户必须 F5 才能恢复。
  // 正确做法:容器仍不可见就 no-op(留 "正在加载…" placeholder,且**不**写
  // _widgetIdByContainer)。下次调用(登录按钮触发 setMode,此时可见)会再走
  // 这段 existing==null 分支完成首次真实渲染。
  const visible = await _waitForVisible(container)
  if (!visible) return () => ''
  container.innerHTML = ''
  const widgetId = window.turnstile.render(container, {
    sitekey: cfg.turnstile_site_key,
    theme: document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
    size: 'normal',
    retry: 'auto',
    'error-callback': () => {
      _showError('人机验证出现问题,请稍后重试或刷新页面')
    },
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
// 2026-04-23:verify 模式从 URL token 改为用户输入 6 位 code,绑定到 email。
// register 成功 / login EMAIL_NOT_VERIFIED / "重发" 都会把 email 暂存到这里,
// 供 verify 模式面板回填 + _doVerifyCode 提交时使用。
let _verifyEmail = ''

// resend cooldown:30s。避免用户连点 resend —— 服务端每次 resend 都会作废
// 上一张 code,若刚收到邮件就再点一下,旧码作废、新邮件还在路上,窗口期无码
// 可用;加之 handler 层 IP 10/min 限流,多连点几次还会被 429。
const _RESEND_COOLDOWN_MS = 30_000
const _resendNextAt = new Map() // btnId → epoch ms
let _resendTimer = null
function _resendLockUntil(btnId, untilMs) {
  _resendNextAt.set(btnId, untilMs)
  _tickResendCooldowns()
}
function _tickResendCooldowns() {
  const now = Date.now()
  let anyActive = false
  for (const [btnId, until] of _resendNextAt) {
    const btn = $(btnId)
    if (!btn) continue
    const remain = Math.max(0, Math.ceil((until - now) / 1000))
    if (remain > 0) {
      anyActive = true
      btn.disabled = true
      btn.setAttribute('data-cooldown-label', btn.getAttribute('data-cooldown-label') || btn.textContent || '重发验证码')
      btn.textContent = `${remain}s 后可重发`
    } else {
      const orig = btn.getAttribute('data-cooldown-label')
      if (orig) { btn.textContent = orig; btn.removeAttribute('data-cooldown-label') }
      btn.disabled = false
      _resendNextAt.delete(btnId)
    }
  }
  if (anyActive && !_resendTimer) {
    _resendTimer = setInterval(() => {
      _tickResendCooldowns()
      if (_resendNextAt.size === 0 && _resendTimer) { clearInterval(_resendTimer); _resendTimer = null }
    }, 1000)
  }
}
const _getTokenFns = {} // mode → fn returning turnstile response

export function getCurrentMode() { return _currentMode }

export function setMode(mode) {
  if (!MODES.includes(mode)) mode = 'login'
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
    verify: { t: '邮箱验证', s: '输入邮件里的 6 位验证码' },
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
  // 进入 verify 模式时回填 email + 清空上次的 code / 状态行,聚焦 code 输入框
  if (mode === 'verify') {
    const emailEl = $('auth-verify-email')
    if (emailEl) emailEl.textContent = _verifyEmail || '你的邮箱'
    const codeEl = $('auth-verify-code'); if (codeEl) codeEl.value = ''
    const statusEl = $('auth-verify-status')
    if (statusEl) { statusEl.textContent = ''; statusEl.hidden = true }
    const resendStatus = $('auth-verify-resend-status')
    if (resendStatus) { resendStatus.textContent = ''; resendStatus.hidden = true }
  }
  // Focus first input
  setTimeout(() => {
    const focusId = {
      login: 'auth-login-email',
      register: 'auth-register-email',
      forgot: 'auth-forgot-email',
      reset: 'auth-reset-password',
      verify: 'auth-verify-code',
    }[mode]
    if (focusId) $(focusId)?.focus()
  }, 30)
}

// ───────── Init ─────────
export async function initAuth() {
  // URL 邮件落地:现在只剩 reset_password 链接(verify_email 改 code,不再走 URL)
  const params = new URLSearchParams(window.location.search)
  const resetParam = params.get('reset_password')

  // Wire tab/toggle clicks (bottom inline links in design-kit layout)
  $('auth-tab-login')?.addEventListener('click', () => setMode('login'))
  $('auth-tab-register')?.addEventListener('click', () => setMode('register'))
  $('auth-tab-forgot')?.addEventListener('click', () => setMode('forgot'))
  // Duplicate ID-free bottom toggle inside register pane: "已有账号? 直接登录"
  $('auth-tab-login-from-register')?.addEventListener('click', () => setMode('login'))

  // Wire form submit handlers
  // 2026-04-25 login 改成 <form> + submit 监听(而非 button click),
  // 让浏览器密码管理器能识别为登录表单、offer 保存并下次自动填充。
  // Enter 在 form 内原生触发 submit,下方 Enter-key 映射中已移除 password→btn 以免双提交。
  $('auth-mode-login')?.addEventListener('submit', (e) => {
    e.preventDefault()
    _doLogin()
  })
  $('auth-register-btn')?.addEventListener('click', _doRegister)
  $('auth-forgot-btn')?.addEventListener('click', _doRequestReset)
  $('auth-reset-btn')?.addEventListener('click', _doConfirmReset)
  // 登录页"重发验证邮件":从 login 流程被 EMAIL_NOT_VERIFIED 拦下时,
  // 入口变成跳 verify 模式 + 调用 resend。用户随后在 verify 模式输 code。
  $('auth-resend-verify-btn')?.addEventListener('click', _doResendFromLogin)
  $('auth-verify-submit-btn')?.addEventListener('click', _doVerifyCode)
  $('auth-verify-resend-btn')?.addEventListener('click', _doResendFromVerify)
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

  // Enter key submits
  // login-password → login-btn 的映射已移除:login 区已是 <form>,Enter 原生触发 submit,
  // 再手动 .click() 会双提交。其它 mode 仍用 <div>,保留手动链式触发。
  for (const [inputId, btnId] of [
    ['auth-register-confirm', 'auth-register-btn'],
    ['auth-forgot-email', 'auth-forgot-btn'],
    ['auth-reset-confirm', 'auth-reset-btn'],
    ['auth-verify-code', 'auth-verify-submit-btn'],
  ]) {
    $(inputId)?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) $(btnId)?.click()
    })
  }

  // code 输入框:自动过滤非数字 + 输满 6 位自动提交(常用 UX)
  const codeEl = $('auth-verify-code')
  if (codeEl) {
    codeEl.addEventListener('input', () => {
      const cleaned = codeEl.value.replace(/\D/g, '').slice(0, 6)
      if (cleaned !== codeEl.value) codeEl.value = cleaned
      if (cleaned.length === 6) $('auth-verify-submit-btn')?.click()
    })
  }

  // Pre-warm config so first widget render is snappy
  loadPublicConfig().catch(() => {})

  // URL-driven modes win over default
  if (resetParam) {
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
  // "记住我":默认勾选;取消勾选 → 后端 cookie 不带 Max-Age(session),前端
  // access token 同步走 sessionStorage,关窗口即清,下次访问必须重新登录。
  const remember = $('auth-login-remember')?.checked !== false
  await _withBusy('auth-login-btn', '登录中…', async () => {
    const r = await apiFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, turnstile_token, remember }),
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
        // 2026-04-23:现在邮箱验证走 "6 位 code 输入",不再是 "点击邮件链接"。
        // 把用户送进 verify 模式,预填 email,让他粘贴 code 直接输。
        // 旧的 auth-resend-verify-btn 入口改为"去 verify 模式 + 触发一次 resend"。
        _verifyEmail = email
        setMode('verify')
        const status = $('auth-verify-status')
        if (status) {
          status.textContent = '邮箱尚未验证 — 请输入邮件中的 6 位验证码'
          status.hidden = false
        }
        return
      }
      _showError(_friendlyAuthError(data, r.status))
      return
    }
    // Success — emit to main.js
    // HIGH#4 后 refresh token 不再出现在 body,只通过 HttpOnly cookie 下发;
    // refresh_exp 仍保留作为"会话剩余时间"展示用。
    // 2026-04-24:回传 remember 让 main.js 决定 access token 用 sessionStorage
    // 还是 localStorage(与后端 cookie 生命周期对齐)。
    _onLoginSuccess?.({
      user: data.user,
      access_token: data.access_token,
      access_exp: data.access_exp,
      refresh_exp: data.refresh_exp,
      remember: data.remember !== false,
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
    // 2026-04-23:注册成功后直接进入 verify 模式(6 位 code 输入)。
    // 不再需要跨设备 polling —— 用户在同一页面输 code 就完成验证。
    _verifyEmail = email
    setMode('verify')
  })
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

/**
 * 2026-04-23:邮箱验证走"输入 6 位 code"。
 *
 * verify 模式面板(auth-mode-verify)提交入口,body = { email, code }。
 * 成功 → 切 login + 预填 email + banner 提示"验证成功,请登录"。
 */
async function _doVerifyCode() {
  _clearError()
  const statusEl = $('auth-verify-status')
  const show = (text, kind) => {
    if (!statusEl) return
    statusEl.textContent = text
    statusEl.hidden = false
    statusEl.style.color = kind === 'error'
      ? 'var(--danger, #d32f2f)'
      : (kind === 'ok' ? 'var(--success, #2da44e)' : '')
  }
  const email = (_verifyEmail || '').trim().toLowerCase()
  const code = ($('auth-verify-code')?.value || '').trim()
  if (!_emailValid(email)) {
    show('缺少邮箱 — 请返回登录重新开始', 'error'); return
  }
  if (!/^\d{6}$/.test(code)) {
    show('请输入 6 位数字验证码', 'error'); return
  }
  await _withBusy('auth-verify-submit-btn', '验证中…', async () => {
    const r = await apiFetch('/api/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code }),
      suppressAuthRedirect: true,
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) {
      show(_friendlyAuthError(data, r.status), 'error')
      return
    }
    show(data?.newly_verified ? '✓ 邮箱验证成功!' : '✓ 邮箱已验证。', 'ok')
    // 切登录模式 + 预填 email + 顶部成功横幅,与原旧链接流程体验一致
    setTimeout(() => {
      const savedEmail = email
      setMode('login')
      const loginEmail = $('auth-login-email')
      if (loginEmail) loginEmail.value = savedEmail
      const banner = $('login-error')
      if (banner) {
        banner.style.color = 'var(--success, #2da44e)'
        banner.textContent = '✓ 邮箱验证成功 — 现在可以登录了'
        banner.hidden = false
        setTimeout(() => {
          if (banner.textContent && banner.textContent.startsWith('✓')) {
            banner.style.color = ''
            banner.hidden = true
            banner.textContent = ''
          }
        }, 6000)
      }
      $('auth-login-password')?.focus()
    }, 800)
  })
}

/**
 * verify 模式下的"重发验证码"按钮。
 * 成功提示展示在按钮旁边,不跳 mode。服务端已作废旧 code 只保留最新一张。
 */
async function _doResendFromVerify() {
  _clearError()
  const email = (_verifyEmail || '').trim().toLowerCase()
  if (!_emailValid(email)) { _showError('缺少邮箱 — 请返回登录重新开始'); return }
  // cooldown 过期前直接 noop(按钮在 cooldown 态已 disabled,这里是兜底)
  const next = _resendNextAt.get('auth-verify-resend-btn') || 0
  if (Date.now() < next) return
  const statusEl = $('auth-verify-resend-status')
  await _withBusy('auth-verify-resend-btn', '发送中…', async () => {
    const r = await apiFetch('/api/auth/resend-verification', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
      suppressAuthRedirect: true,
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) { _showError(_friendlyAuthError(data, r.status)); return }
    if (statusEl) {
      statusEl.textContent = '新验证码已发送 — 请查收(含垃圾邮件箱)'
      statusEl.hidden = false
    }
    // 清空之前输错的 code,方便用户直接输新的
    const codeEl = $('auth-verify-code')
    if (codeEl) { codeEl.value = ''; codeEl.focus() }
    _resendLockUntil('auth-verify-resend-btn', Date.now() + _RESEND_COOLDOWN_MS)
  })
}

/**
 * login 页面"重发验证邮件"按钮(legacy row)。
 * 2026-04-23 后新的 EMAIL_NOT_VERIFIED 失败路径直接 setMode('verify'),
 * 此行通常不可见;但保留按钮 + 处理以防某些边界场景(旧 UI 被缓存)仍命中。
 */
async function _doResendFromLogin() {
  _clearError()
  const email = $('auth-login-email').value.trim().toLowerCase()
  if (!_emailValid(email)) { _showError('请先在登录框填写邮箱'); return }
  const next = _resendNextAt.get('auth-resend-verify-btn') || 0
  if (Date.now() < next) return
  await _withBusy('auth-resend-verify-btn', '发送中…', async () => {
    const r = await apiFetch('/api/auth/resend-verification', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
      suppressAuthRedirect: true,
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) { _showError(_friendlyAuthError(data, r.status)); return }
    // 用户既然点了 resend 说明需要验证 —— 直接送进 verify 模式等他输 code
    _verifyEmail = email
    setMode('verify')
    const statusEl = $('auth-verify-status')
    if (statusEl) {
      statusEl.textContent = '新验证码已发送 — 请查收邮件(含垃圾邮件箱)'
      statusEl.hidden = false
      statusEl.style.color = 'var(--success, #2da44e)'
    }
    // 两个 resend 按钮共享 cooldown 时钟:在 login 页按了就锁 verify 页的,反之亦然
    const until = Date.now() + _RESEND_COOLDOWN_MS
    _resendLockUntil('auth-resend-verify-btn', until)
    _resendLockUntil('auth-verify-resend-btn', until)
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
    case 'INVALID_TOKEN':       return '验证码或链接无效/已过期,请重新获取'
    case 'RATE_LIMITED':        return '操作过于频繁,请稍后再试'
    default:
      if (status === 401) return msg || '认证失败'
      if (status === 403) return msg || '无权访问'
      return msg || code || `请求失败(${status})`
  }
}
