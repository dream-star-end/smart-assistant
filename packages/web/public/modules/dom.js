// OpenClaude — DOM helpers
export const $ = (id) => document.getElementById(id)
export const _isMac = /Mac|iPhone|iPad/.test(navigator.platform)
export const _mod = _isMac ? '⌘' : 'Ctrl+'

/**
 * 粗略判断当前设备是否为"手机浏览器"(基于 UA)。保守:只认 iPhone / iPad /
 * iPod / Android Mobile,其余(Windows/macOS/平板 landscape / desktop emulation)
 * 都视为非 mobile。
 *
 * 此 helper 中性使用:支付链路(billing.js)用来决定是走 H5 拉起还是 PC 二维码;
 * 诊断埋点(mediaSign / main 下载失败分支)用来回答"用户当时在不在移动浏览器"
 * 这个问题。**不**作为安全或鉴权判断 — UA 可伪造,且 navigator.userAgentData
 * 在 Chromium 系会更准。
 */
export function _isMobileUA() {
  const ua = navigator.userAgent || ''
  return /iPhone|iPad|iPod|Android.*Mobile/i.test(ua)
}
export const htmlSafeEscape = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )

/**
 * 把一个"点击展开/收起"的卡片头做成无障碍 disclosure(WAI-ARIA button 模式)。
 *
 * 历史上聊天流里的折叠卡片头是 `<div onclick>`,键盘和读屏用户完全无法操作
 * (审计 P1)。本 helper 纯增量:鼠标点击行为不变,额外补 role=button、tabindex、
 * aria-expanded、以及 Enter/Space 键盘触发。聚焦环:父卡片是 overflow:hidden 会裁掉
 * 全局 `:focus-visible` 的外阴影,故 style.css 为这几个 header 类补了 **inset** 焦点环。
 *
 * @param headerEl   可点击的头元素(disclosure trigger)
 * @param controlledEl 带/去 `collapsed` 类的容器(collapsed = 收起)
 * @param opts.onToggle 自定义 toggle(默认 `controlledEl.classList.toggle('collapsed')`);
 *                      用于需要同时记录用户意图(如 msg._userCollapsed)的卡片
 * @returns syncAria 函数 —— 当 `collapsed` 被**头之外**的代码改动(如流结束自动收起)
 *          且头未重建时,调用方可手动调它把 aria-expanded 同步回去
 */
export function makeDisclosure(headerEl, controlledEl, opts = {}) {
  const { onToggle } = opts
  headerEl.setAttribute('role', 'button')
  if (!headerEl.hasAttribute('tabindex')) headerEl.setAttribute('tabindex', '0')
  const syncAria = () => {
    headerEl.setAttribute(
      'aria-expanded',
      controlledEl.classList.contains('collapsed') ? 'false' : 'true',
    )
  }
  syncAria()
  const toggle = () => {
    if (onToggle) onToggle()
    else controlledEl.classList.toggle('collapsed')
    syncAria()
  }
  headerEl.addEventListener('click', toggle)
  headerEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault()
      toggle()
    }
  })
  return syncAria
}

// 返回值:true = execCommand('copy') 真的成功;false = 失败(权限拒/非安全上下文/
// mobile WebView 不支持)。历史调用者不读返回值(假定成功),保持向前兼容;新代码
// 想区分成功失败的可消费此值显示对的 toast。
export function fallbackCopy(text) {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.cssText = 'position:fixed;opacity:0'
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy') === true
  } catch {}
  document.body.removeChild(ta)
  return ok
}
