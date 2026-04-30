// OpenClaude — Theme management
import { $ } from './dom.js?v=06a7c180'

let _toast = () => {} // late-bound, set by main.js after ui.js loads
export function setToastFn(fn) {
  _toast = fn
}

const THEME_KEY = 'openclaude_theme'

export function effectiveTheme() {
  const saved = localStorage.getItem(THEME_KEY) || 'system'
  if (saved === 'system')
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  return saved
}

export function applyTheme() {
  const theme = effectiveTheme()
  document.documentElement.dataset.theme = theme
  // Swap hljs stylesheet
  const hljsSheet = document.querySelector(
    'link[href*="github-dark.min.css"], link[href*="github.min.css"]',
  )
  if (hljsSheet) {
    const dark = '/vendor/github-dark.min.css'
    const light = '/vendor/github.min.css'
    const target = theme === 'light' ? light : dark
    if (hljsSheet.href !== target) hljsSheet.href = target
  }
  // Update theme button icon to reflect current state
  const curr = localStorage.getItem(THEME_KEY) || 'system'
  const iconEl = $('theme-icon')
  if (iconEl) {
    if (curr === 'dark')
      iconEl.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'
    else if (curr === 'light')
      iconEl.innerHTML =
        '<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>'
    else
      iconEl.innerHTML =
        '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/><path d="M12 6a6 6 0 0 0 0 12" fill="currentColor" opacity="0.3"/>'
  }
  // Re-init mermaid for theme
  if (window.mermaid) {
    try {
      mermaid.initialize({
        startOnLoad: false,
        theme: theme === 'light' ? 'default' : 'dark',
        securityLevel: 'strict',
      })
    } catch {}
  }
}

export function cycleTheme() {
  const curr = localStorage.getItem(THEME_KEY) || 'system'
  const next = curr === 'dark' ? 'light' : curr === 'light' ? 'system' : 'dark'
  localStorage.setItem(THEME_KEY, next)
  applyTheme()
  _toast(`主题: ${next === 'system' ? '跟随系统' : next === 'dark' ? '暗色' : '亮色'}`)
}
