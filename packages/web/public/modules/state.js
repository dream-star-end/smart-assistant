// OpenClaude — Application state
//
// Token storage (Phase 4A → 2026-04-21 安全审计 HIGH#4):
//   - state.token         = access JWT (short-lived, ~15min) — sent as Bearer
//   - state.tokenExp      = unix seconds when access expires (proactive pre-expiry refresh)
//   - refresh token       = HttpOnly cookie (oc_rt, Path=/api/auth, SameSite=Strict)
//                           浏览器自动随 /api/auth/* 携带,JS 读不到、写不到。
//
// 迁移期(2 周):state.refreshToken 仅用来"消费"老用户 localStorage 里残留的 refresh token,
// 让他们在升级后第一次 silentRefresh / logout 还能走 body 兼容路径,server 同时把 cookie
// 种回去之后,localStorage 立刻清掉。新登录不再产生这个字段。
//
// 2026-06-08 商业版安全审计修正:
//   - access token 一律只存 sessionStorage(或当前 JS 内存),不再写 localStorage。
//   - "记住我" 只控制 HttpOnly refresh cookie 是否持久化;新 tab / 新浏览器会话
//     通过冷启动 silentRefresh 从 cookie 换取短期 access token。
//   - 旧版 localStorage access token 仍读取一次以兼容已登录用户;任意新版
//     login/refresh 成功都会通过 _writeStoredAccessToken 清掉 localStorage 残留。

function _safeStorageGet(store, key) {
  try { return store?.getItem?.(key) || '' } catch { return '' }
}

function _safeStorageSet(store, key, value) {
  try { store?.setItem?.(key, value); return true } catch { return false }
}

function _safeStorageRemove(store, key) {
  try { store?.removeItem?.(key) } catch {}
}

function _safeStorageNumber(store, key) {
  return Number(_safeStorageGet(store, key) || '0') || 0
}

/**
 * 读取 access token(冷启动 / 刷新页面时)。
 * 新版优先 sessionStorage;旧版 localStorage 仅作迁移兜底。
 */
export function _readStoredAccessToken() {
  const tokS = _safeStorageGet(sessionStorage, 'openclaude_access_token')
  if (tokS) {
    return {
      token: tokS,
      exp: _safeStorageNumber(sessionStorage, 'openclaude_access_exp'),
    }
  }
  const tokL = _safeStorageGet(localStorage, 'openclaude_access_token')
  if (tokL) {
    const exp = _safeStorageNumber(localStorage, 'openclaude_access_exp')
    // 迁移旧持久化 access token:本次页面保留会话,但立即从 localStorage 删除。
    _safeStorageSet(sessionStorage, 'openclaude_access_token', tokL)
    _safeStorageSet(sessionStorage, 'openclaude_access_exp', String(exp))
    // 删除必须独立执行:Safari 隐私模式 / 受限 WebView 下 sessionStorage.setItem
    // 可能抛错,但安全目标仍是尽力清掉 localStorage 里的长期 bearer。
    _safeStorageRemove(localStorage, 'openclaude_access_token')
    _safeStorageRemove(localStorage, 'openclaude_access_exp')
    return {
      token: tokL,
      exp,
    }
  }
  return { token: '', exp: 0 }
}

/**
 * 写入 access token。
 * `remember` 仅保留为调用点兼容参数;access token 不再落 localStorage。
 */
export function _writeStoredAccessToken(token, exp, _remember) {
  // 清旧版持久化残留,避免 XSS 能从 localStorage 直接拿到 bearer。
  _safeStorageRemove(localStorage, 'openclaude_access_token')
  _safeStorageRemove(localStorage, 'openclaude_access_exp')
  _safeStorageSet(sessionStorage, 'openclaude_access_token', token || '')
  if (exp != null) _safeStorageSet(sessionStorage, 'openclaude_access_exp', String(exp))
}

/** 退出登录 / auth-expired 时清两处,防止漏清导致冷启动又被认证。 */
export function _clearStoredAccessToken() {
  for (const s of [localStorage, sessionStorage]) {
    _safeStorageRemove(s, 'openclaude_access_token')
    _safeStorageRemove(s, 'openclaude_access_exp')
  }
}

// 冷启动读取:sessionStorage 优先,旧 localStorage 迁移兜底,最后回退老 openclaude_token。
// 旧 `openclaude_token` 单 bearer 自动迁移到 access_token,避免老 personal-version 用户被踢。
const _legacy = _safeStorageGet(localStorage, 'openclaude_token')
if (_legacy && !_safeStorageGet(sessionStorage, 'openclaude_access_token') && !_safeStorageGet(localStorage, 'openclaude_access_token')) {
  _safeStorageSet(sessionStorage, 'openclaude_access_token', _legacy)
  _safeStorageRemove(localStorage, 'openclaude_token')
}
const _initial = _readStoredAccessToken()
const _access = _initial.token || _legacy || ''
export const state = {
  token: _access,
  // HIGH#4 迁移期:仅承载 localStorage 里的旧 refresh token,api.js 用完一次后清空。
  // 新 login 不再写它(refresh token 走 HttpOnly cookie)。
  refreshToken: _safeStorageGet(localStorage, 'openclaude_refresh_token'),
  tokenExp: _initial.exp || _safeStorageNumber(localStorage, 'openclaude_access_exp'),
  // 2026-04-22 Codex R2 finding:silentRefresh 的异步期间可能跟 _forceLogout /
  // 登另一个账号撞车,导致旧 refresh 响应回来时把已经 logout/切换的 state.token
  // 又写回来。每次 login 成功 / _forceLogout / _tearDownWsAuth 递增这个计数,
  // _doRefreshOnce 在 commit 前比对,epoch 变了就丢掉响应,别覆盖当前身份。
  // 仅 in-memory:新 tab 从 0 起不会干扰其他 tab(那边独立 JS 上下文)。
  authEpoch: 0,
  // 2026-04-21 安全审计 HIGH#F1:changelog_seen / user-bucketed localStorage 此前
  // 用 `state.token.slice(-8)` 做身份桶,但 JWT 末 8 字节并非稳定身份(每次
  // refresh 会变成新 JWT,导致 "已读标志" 在同一用户下反复丢失)。改用真实
  // user.id(来自 /api/me)。refreshBalance 成功时由 billing.js 写入。
  userId: null,
  // 用户注册时间(ISO 字符串,来自 /api/me)。welcome-modal 通过它 + localStorage
  // 三重 gating 判定是否给"新用户"弹欢迎介绍 — 仅 created_at < 24h 才弹,
  // 防止老用户清 localStorage 后被弹一次。refreshBalance 成功时写入。
  userCreatedAt: null,
  ws: null,
  wsStatus: 'disconnected',
  sessions: new Map(),
  currentSessionId: null,
  reconnectTimer: null,
  sendingInFlight: false,
  agentsList: [],
  agentsListIsFallback: false,
  defaultAgentId: 'main',
  agentTeams: [],
  selectedTeamId: '',
  attachments: [],
  recognition: null,
  recognizing: false,
  windowFocused: document.hasFocus(),
  offlineQueue: [], // messages queued while disconnected
  // 2026-04-26 v1.0.4:user_preferences 缓存。modelPicker / effortMode / 发送
  // 帧时塞 frame.model 都走这份。
  //   - null      : 还没拉取(冷启动 / 登录后 race);UI 应隐藏依赖此字段的 pill
  //                 避免"先显 Opus 再切 Sonnet"的闪烁
  //   - {} / 含字段对象 : 已拉取完成(空对象 = 用户没设过任何偏好)
  // 由 main.js 在登录成功 + 冷启动有 token 两条路径下统一通过 loadUserPrefs() 写入。
  userPrefs: null,
}

// P2-24 — offlineQueue 软上限。
// 长时间离线下用户狂发,offlineQueue 无界堆积会:1) 占内存 2) 重连后一次性 drain
// 卡死 UI / 后端。设 200 条,达到时拒收新消息,UI 提示重试。
// _offlineQueuePending 不计入(那是正在 drain 的副本,不会无限增长)。
export const MAX_OFFLINE_QUEUE = 200
export function tryEnqueueOffline(item) {
  if (state.offlineQueue.length >= MAX_OFFLINE_QUEUE) return false
  state.offlineQueue.push(item)
  return true
}

export function getSession(id) {
  return state.sessions.get(id || state.currentSessionId)
}

export function isSending() {
  const sess = getSession()
  return sess?._sendingInFlight || false
}

export function setSending(val) {
  const sess = getSession()
  if (sess) sess._sendingInFlight = val
  state.sendingInFlight = val
}
