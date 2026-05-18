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
