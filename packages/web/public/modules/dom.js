// OpenClaude — DOM helpers
export const $ = (id) => document.getElementById(id)
export const _isMac = /Mac|iPhone|iPad/.test(navigator.platform)
export const _mod = _isMac ? '⌘' : 'Ctrl+'
export const htmlSafeEscape = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )

export function fallbackCopy(text) {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.cssText = 'position:fixed;opacity:0'
  document.body.appendChild(ta)
  ta.select()
  try {
    document.execCommand('copy')
  } catch {}
  document.body.removeChild(ta)
}
