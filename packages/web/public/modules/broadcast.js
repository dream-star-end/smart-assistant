// 多 tab 认证状态广播。同源同 origin 的所有 tab 共享一个 BroadcastChannel('oc-auth')。
//
// 设计原则:
//   - 广播是 opportunistic 优化。丢/失败时,接收 tab 各自走 reactive 路径(401 / WS 1008)兜底,
//     功能不丢失,只是没了"省一次 reactive refresh"的优化
//   - 不广播 login。跨账号污染风险显著大于"省一次 reactive showLogin":
//     A tab 老身份残留 ws/state 被 B tab 新身份触发的 login 强制接管,远比单纯 reactive showLogin 危险
//   - 不上 storage event 兜底承载 access_token —— localStorage 持久写 access token 违反 remember=false 语义。
//     仅 logout 在 BroadcastChannel 不存在的浏览器上回退 storage event(payload 仅是时间戳信号,不含 token)
//   - sender tab 自己发的消息要被自己忽略(BroadcastChannel 标准上不回送给 sender,但保险起见加 senderTabId)

const CHANNEL_NAME = 'oc-auth'
const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
const STORAGE_LOGOUT_KEY = 'oc_auth_logout_signal' // 仅 fallback 用,不含 token

let _bc = null
let _handler = null

function _hasBC() {
  return typeof BroadcastChannel === 'function'
}

function _ensureChannel() {
  if (_bc || !_hasBC()) return _bc
  try {
    _bc = new BroadcastChannel(CHANNEL_NAME)
  } catch {
    _bc = null
  }
  return _bc
}

/**
 * 通知同源其他 tab 当前 tab 已登出,让它们 in-place 切到登录页。
 * 优先 BroadcastChannel;不可用时回退 storage event(只发"信号",不含 token)。
 * 同 origin 同浏览器实际上不会出现"一边 BC 可用、一边不可用"的混合环境,
 * 因此 BC 路径不再额外双发 storage 事件,避免对端重复处理。
 */
export function publishLogout() {
  const ch = _ensureChannel()
  if (ch) {
    try {
      ch.postMessage({ type: 'logout', senderTabId: TAB_ID, ts: Date.now() })
    } catch {}
    return
  }
  // BC 不可用 → 写"信号"时间戳,storage 事件会 fire。立即清掉,只为触发跨 tab 通知
  try {
    localStorage.setItem(STORAGE_LOGOUT_KEY, String(Date.now()))
    localStorage.removeItem(STORAGE_LOGOUT_KEY)
  } catch {}
}

/**
 * 通知同源其他 tab 当前 tab 拿到了新 access token,让它们直接接管避免再打 /api/auth/refresh。
 *
 * 安全要求:
 *   - userId 必填。缺失则不广播 —— 接收方无法校验同身份就会 drift。广播是优化,丢一次可接受
 *   - BC 不可用时静默不广播。接收方走 reactive 401 refresh 兜底
 *   - access_token 不落 storage,仅过同 origin BC 内存通道(与既有 localStorage/sessionStorage 同等级别,都依赖 same-origin policy)
 */
export function publishTokenRefresh({ access_token, access_exp, remember, userId }) {
  if (userId == null) return
  const ch = _ensureChannel()
  if (!ch) return
  try {
    ch.postMessage({
      type: 'token_refresh',
      senderTabId: TAB_ID,
      access_token,
      access_exp,
      remember: remember !== false,
      userId: String(userId), // 统一 string 比较,避免 number/string 不等
      ts: Date.now(),
    })
  } catch {}
}

/**
 * Pure 校验:本 tab 是否应当接管 token_refresh 广播消息。
 * 抽出来纯函数化,便于单元测试覆盖错误路径矩阵。
 *
 * 五重 guard,任一不过 → 丢弃:
 *   - msg 形状(type/access_token/access_exp 合法)
 *   - 本 tab 已登录(state.token 非空,不复活已登出 tab)
 *   - 同身份(msg.userId == state.userId,字符串严格相等)
 *   - 本 tab 已知身份(state.userId != null,早期 race 不接受)
 *   - 新于本 tab 当前(msg.access_exp > state.tokenExp,旧广播被超越)
 */
export function shouldAdoptTokenRefresh(state, msg) {
  if (!msg || typeof msg !== 'object') return false
  if (msg.type !== 'token_refresh') return false
  if (typeof msg.access_token !== 'string' || !msg.access_token) return false
  if (!Number.isFinite(msg.access_exp)) return false
  if (!state || !state.token) return false
  if (!msg.userId) return false
  if (state.userId == null) return false
  if (String(state.userId) !== String(msg.userId)) return false
  if (msg.access_exp <= (state.tokenExp || 0)) return false
  return true
}

/**
 * 注册广播 listener。当前 init-only 设计,调多次会覆盖前一个 handler;
 * 不返回 unsubscribe(YAGNI)。
 *
 * handler 签名:(msg) => void。msg 形如:
 *   { type: 'logout', senderTabId, ts }
 *   { type: 'token_refresh', senderTabId, access_token, access_exp, remember, userId, ts }
 *
 * 自己 senderTabId 发的消息会被忽略(BC 标准上不回送给 sender,保险起见加判断)。
 */
export function onAuthBroadcast(handler) {
  _handler = handler
  const ch = _ensureChannel()
  if (ch) {
    ch.onmessage = (ev) => {
      const m = ev?.data
      if (!m || typeof m !== 'object') return
      if (m.senderTabId === TAB_ID) return
      try {
        _handler?.(m)
      } catch {}
    }
  }
  // logout 的 storage fallback:即便本 tab BC 可用,也要监听 storage —— 这样
  // 一个 BC 不可用的 tab 发 logout 时,本 tab 也能收到。token_refresh 不走 storage。
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (ev) => {
      if (ev.key !== STORAGE_LOGOUT_KEY || !ev.newValue) return
      try {
        _handler?.({ type: 'logout', senderTabId: '', ts: Number(ev.newValue) || Date.now() })
      } catch {}
    })
  }
}
