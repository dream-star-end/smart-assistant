// OpenClaude — DOM helpers
export const $ = (id) => document.getElementById(id)
export const _isMac = /Mac|iPhone|iPad/.test(navigator.platform)
export const _mod = _isMac ? '⌘' : 'Ctrl+'
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
