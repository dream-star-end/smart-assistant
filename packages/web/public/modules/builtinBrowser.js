// OpenClaude — built-in browser drawer + element selection context
import { $, htmlSafeEscape } from './dom.js'

const TEXT_LIMIT = 500
const OUTER_HTML_LIMIT = 2000
const ATTR_LIMIT = 200
const MAX_ANCESTORS = 6
const BLOCKED_CAPTURE_TAGS = new Set(['script', 'style', 'template', 'noscript'])
const CAPTURE_ATTRS = new Set([
  'id',
  'class',
  'role',
  'aria-label',
  'aria-labelledby',
  'title',
  'alt',
  'href',
  'src',
  'placeholder',
  'name',
  'type',
])
const VALUE_CAPTURE_TYPES = new Set(['button', 'submit', 'reset'])

let _deps = { sendBrowserContext: null, toast: () => {} }
let _currentUrl = ''
let _currentUrlIsExact = true
let _frameLoadCount = 0
let _selection = null
let _selecting = false
let _domPickerCleanup = null

export function truncateText(value, limit = TEXT_LIMIT) {
  const s = String(value || '').replace(/\s+/g, ' ').trim()
  if (s.length <= limit) return s
  return `${s.slice(0, Math.max(0, limit - 1))}…`
}

export function normalizeBrowserUrl(raw, baseHref) {
  const text = String(raw || '').trim()
  if (!text) return null
  if (/^(?:javascript|data|file|blob|mailto|tel|vbscript):/i.test(text)) return null

  const base = baseHref || (typeof window !== 'undefined' ? window.location.href : 'http://localhost/')
  let candidate = text
  if (/^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:.]+\])(?::\d+)?(?:[/?#]|$)/i.test(candidate)) {
    candidate = `http://${candidate}`
  } else if (/^[\w.-]+\.[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(candidate)) {
    candidate = `https://${candidate}`
  } else if (candidate.startsWith('//')) {
    const baseUrl = new URL(base)
    candidate = `${baseUrl.protocol}${candidate}`
  }

  try {
    const url = new URL(candidate, base)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.href
  } catch {
    return null
  }
}

export function isBuiltinBrowserUrl(raw, baseHref) {
  return !!normalizeBrowserUrl(raw, baseHref)
}

export function getBuiltinBrowserUrlForClick(event, anchor, baseHref) {
  if (!anchor) return null
  if (event?.defaultPrevented) return null
  if (typeof event?.button === 'number' && event.button !== 0) return null
  if (event?.metaKey || event?.ctrlKey || event?.shiftKey || event?.altKey) return null
  if (anchor.hasAttribute?.('download')) return null
  if (anchor.closest?.('[data-no-builtin-browser], .doc-card, .media-wrap')) return null

  const hrefAttr = anchor.getAttribute?.('href') || ''
  if (!hrefAttr || hrefAttr.startsWith('#')) return null
  const url = normalizeBrowserUrl(hrefAttr, baseHref)
  if (!url) return null

  try {
    const parsed = new URL(url)
    const appOrigin = new URL(baseHref || window.location.href).origin
    if (parsed.origin === appOrigin) {
      return null
    }
  } catch {}
  return url
}

export function buildBrowserSelectionPrompt(context, requirement) {
  const req = String(requirement || '').trim()
  const ctx = context || {}
  const lines = [
    '请根据下面的内置浏览器上下文调整项目/页面。',
    '',
    '## 用户要求',
    req || '(用户未填写具体要求)',
    '',
    '## 内置浏览器上下文',
    `- URL: ${ctx.url || '(未知)'}`,
  ]
  if (ctx.urlNote) lines.push(`- URL 备注: ${ctx.urlNote}`)
  if (ctx.title) lines.push(`- 页面标题: ${ctx.title}`)

  if (ctx.mode === 'dom') {
    lines.push('- 选择方式: DOM 元素')
    if (ctx.selector) lines.push(`- CSS selector: \`${ctx.selector}\``)
    if (ctx.tag) lines.push(`- 标签: ${ctx.tag}`)
    if (ctx.attributes && Object.keys(ctx.attributes).length > 0) {
      lines.push('- 关键属性:')
      lines.push('```json')
      lines.push(JSON.stringify(ctx.attributes, null, 2))
      lines.push('```')
    }
    if (ctx.rect) {
      lines.push(
        `- 位置尺寸: x=${ctx.rect.x}, y=${ctx.rect.y}, w=${ctx.rect.width}, h=${ctx.rect.height}`,
      )
    }
    if (ctx.ancestry?.length) lines.push(`- 层级路径: ${ctx.ancestry.join(' > ')}`)
    if (ctx.text) {
      lines.push('- 元素文本:')
      lines.push('```text')
      lines.push(ctx.text)
      lines.push('```')
    }
    if (ctx.outerHTML) {
      lines.push('- outerHTML 摘要:')
      lines.push('```html')
      lines.push(ctx.outerHTML)
      lines.push('```')
    }
  } else if (ctx.mode === 'coordinate') {
    lines.push('- 选择方式: 坐标 fallback (页面 DOM 因跨域/iframe 策略不可读取)')
    if (ctx.click) {
      lines.push(
        `- 点击位置: x=${ctx.click.x}, y=${ctx.click.y} (${ctx.click.xPct}%, ${ctx.click.yPct}%)`,
      )
    }
    if (ctx.viewport) lines.push(`- iframe 视口: ${ctx.viewport.width} × ${ctx.viewport.height}`)
  } else {
    lines.push('- 选择方式: 整页 / 未选择具体元素')
  }

  lines.push('', '如果需要进一步核实，请优先使用浏览器工具打开上述 URL，并按 selector 或坐标定位。')
  return lines.join('\n')
}

export function collectElementAttributes(el) {
  const attrs = {}
  if (!el?.attributes) return attrs
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase()
    if (!CAPTURE_ATTRS.has(name) && name !== 'data-testid' && name !== 'data-test-id') continue
    if (name === 'value') continue
    attrs[name] = truncateText(attr.value, ATTR_LIMIT)
  }
  const tag = el.tagName?.toLowerCase() || ''
  const type = String(el.getAttribute?.('type') || '').toLowerCase()
  if (tag === 'button' || VALUE_CAPTURE_TYPES.has(type)) {
    const value = el.getAttribute?.('value')
    if (value) attrs.value = truncateText(value, ATTR_LIMIT)
  }
  return attrs
}

function _cssEscape(value) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value)
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`)
}

function _selectorPart(el) {
  const tag = (el.tagName || 'element').toLowerCase()
  const id = el.getAttribute?.('id')
  if (id) return `${tag}#${_cssEscape(id)}`
  const testAttr = el.getAttribute?.('data-testid') ? 'data-testid' : el.getAttribute?.('data-test-id') ? 'data-test-id' : ''
  const testId = testAttr ? el.getAttribute?.(testAttr) : ''
  if (testId) return `${tag}[${testAttr}="${_cssEscape(testId)}"]`
  const classes = Array.from(el.classList || []).slice(0, 3)
  let part = tag + classes.map((c) => `.${_cssEscape(c)}`).join('')
  if (el.parentElement) {
    const siblings = Array.from(el.parentElement.children).filter((n) => n.tagName === el.tagName)
    if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(el) + 1})`
  }
  return part
}

export function buildCssSelector(el) {
  if (!el?.tagName) return ''
  const parts = []
  let cur = el
  while (cur?.tagName && cur.nodeType === 1 && parts.length < MAX_ANCESTORS) {
    parts.unshift(_selectorPart(cur))
    if (cur.getAttribute?.('id')) break
    cur = cur.parentElement
  }
  return parts.join(' > ')
}

function _normalizeSelectableElement(el) {
  let cur = el
  while (cur?.tagName && BLOCKED_CAPTURE_TAGS.has(cur.tagName.toLowerCase())) {
    cur = cur.parentElement
  }
  return cur?.tagName ? cur : el
}

function _outerHtmlSnippet(el) {
  if (!el?.cloneNode) return ''
  const clone = el.cloneNode(true)
  clone.querySelectorAll?.('script,style,template,noscript').forEach((n) => n.remove())
  return truncateText(clone.outerHTML || '', OUTER_HTML_LIMIT)
}

function _elementText(el) {
  const text = el?.innerText || el?.textContent || ''
  return truncateText(text, TEXT_LIMIT)
}

function _rectInfo(el) {
  const rect = el.getBoundingClientRect?.()
  if (!rect) return null
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

export function buildElementContext(el, frameWindow) {
  const target = _normalizeSelectableElement(el)
  const doc = target?.ownerDocument
  const win = frameWindow || doc?.defaultView
  const ancestry = []
  let cur = target
  while (cur?.tagName && ancestry.length < MAX_ANCESTORS) {
    ancestry.unshift(_selectorPart(cur))
    cur = cur.parentElement
  }
  return {
    mode: 'dom',
    url: win?.location?.href || doc?.location?.href || _currentUrl,
    title: doc?.title || '',
    selector: buildCssSelector(target),
    tag: target?.tagName?.toLowerCase() || '',
    attributes: collectElementAttributes(target),
    rect: _rectInfo(target),
    ancestry,
    text: _elementText(target),
    outerHTML: _outerHtmlSnippet(target),
  }
}

function _sandboxForUrl(url) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return 'allow-scripts allow-forms allow-same-origin'
    }
  } catch {}
  return 'allow-scripts allow-forms'
}

function _setStatus(text, kind = '') {
  const el = $('builtin-browser-status')
  if (!el) return
  el.textContent = text || ''
  el.className = `builtin-browser-status${kind ? ` ${kind}` : ''}`
}

function _renderSelection(ctx) {
  const el = $('builtin-browser-selection')
  if (!el) return
  if (!ctx) {
    el.hidden = true
    el.innerHTML = ''
    return
  }
  el.hidden = false
  const title = ctx.mode === 'dom' ? ctx.selector || ctx.tag || '已选择元素' : '已选择坐标'
  const sub =
    ctx.mode === 'dom'
      ? ctx.text || JSON.stringify(ctx.attributes || {})
      : `x=${ctx.click?.x}, y=${ctx.click?.y} (${ctx.click?.xPct}%, ${ctx.click?.yPct}%)`
  el.innerHTML = `<strong>${htmlSafeEscape(title)}</strong><span>${htmlSafeEscape(sub || '')}</span>`
}

function _openDrawer() {
  const drawer = $('builtin-browser-drawer')
  const backdrop = $('builtin-browser-backdrop')
  drawer?.classList.add('open')
  drawer?.setAttribute('aria-hidden', 'false')
  backdrop?.classList.add('open')
  backdrop?.setAttribute('aria-hidden', 'false')
}

function _closeDrawer() {
  _stopSelectionMode()
  const drawer = $('builtin-browser-drawer')
  const backdrop = $('builtin-browser-backdrop')
  drawer?.classList.remove('open')
  drawer?.setAttribute('aria-hidden', 'true')
  backdrop?.classList.remove('open')
  backdrop?.setAttribute('aria-hidden', 'true')
}

function _canAccessFrameDom() {
  const frame = $('builtin-browser-frame')
  try {
    return !!frame?.contentDocument?.body
  } catch {
    return false
  }
}

function _cleanupDomPicker() {
  if (_domPickerCleanup) {
    _domPickerCleanup()
    _domPickerCleanup = null
  }
}

function _installDomPicker() {
  _cleanupDomPicker()
  const frame = $('builtin-browser-frame')
  let doc
  let win
  try {
    doc = frame.contentDocument
    win = frame.contentWindow
  } catch {
    return false
  }
  if (!doc?.body) return false

  let style = doc.querySelector('style[data-openclaude-builtin-browser-picker]')
  if (!style) {
    style = doc.createElement('style')
    style.dataset.openclaudeBuiltinBrowserPicker = '1'
    style.textContent =
      '.__openclaude_builtin_browser_hover{outline:2px solid #d97757!important;outline-offset:2px!important;cursor:crosshair!important}'
    doc.head?.appendChild(style)
  }
  let hover = null
  const clearHover = () => {
    hover?.classList?.remove('__openclaude_builtin_browser_hover')
    hover = null
  }
  const onMouseOver = (ev) => {
    clearHover()
    hover = _normalizeSelectableElement(ev.target)
    hover?.classList?.add('__openclaude_builtin_browser_hover')
  }
  const onClick = (ev) => {
    ev.preventDefault()
    ev.stopPropagation()
    _selection = buildElementContext(ev.target, win)
    _renderSelection(_selection)
    _setStatus('已选择元素，可输入修改要求。', 'success')
    _stopSelectionMode({ keepStatus: true })
  }
  doc.addEventListener('mouseover', onMouseOver, true)
  doc.addEventListener('click', onClick, true)
  _domPickerCleanup = () => {
    clearHover()
    doc.removeEventListener('mouseover', onMouseOver, true)
    doc.removeEventListener('click', onClick, true)
  }
  return true
}

function _showCoordinateOverlay() {
  const overlay = $('builtin-browser-overlay')
  if (!overlay) return
  overlay.hidden = false
  overlay.innerHTML = '<div>跨域页面无法直接读取 DOM。点击目标位置后，我会把 URL + 坐标发给 AI。</div>'
}

function _hideCoordinateOverlay() {
  const overlay = $('builtin-browser-overlay')
  if (overlay) overlay.hidden = true
}

function _startSelectionMode() {
  if (!_currentUrl) {
    _deps.toast('先打开一个链接', 'error')
    return
  }
  _selecting = true
  $('builtin-browser-select')?.classList.add('active')
  if (_canAccessFrameDom() && _installDomPicker()) {
    _hideCoordinateOverlay()
    _setStatus('选择模式：点击预览页面里的目标元素。')
  } else {
    _cleanupDomPicker()
    _showCoordinateOverlay()
    _setStatus('跨域页面 DOM 不可读取，已切换为坐标选择。', 'warning')
  }
}

function _stopSelectionMode(opts = {}) {
  _selecting = false
  $('builtin-browser-select')?.classList.remove('active')
  _cleanupDomPicker()
  _hideCoordinateOverlay()
  if (!opts.keepStatus) _setStatus(_currentUrl ? '预览已打开。' : '')
}

function _toggleSelectionMode() {
  if (_selecting) _stopSelectionMode()
  else _startSelectionMode()
}

function _openUrl(raw) {
  const url = normalizeBrowserUrl(raw)
  if (!url) {
    _deps.toast('只支持 http(s) 链接', 'error')
    return
  }
  _selection = null
  _renderSelection(null)
  _currentUrl = url
  _currentUrlIsExact = true
  _frameLoadCount = 0
  const input = $('builtin-browser-url')
  const frame = $('builtin-browser-frame')
  if (input) input.value = url
  if (frame) {
    frame.setAttribute('sandbox', _sandboxForUrl(url))
    frame.src = url
  }
  _openDrawer()
  _setStatus(
    window.location.protocol === 'https:' && url.startsWith('http:')
      ? '正在打开。注意：HTTPS 页面内的 HTTP 预览可能会被浏览器拦截。'
      : '正在打开…',
    'loading',
  )
}

function _currentFrameTitle() {
  try {
    return $('builtin-browser-frame')?.contentDocument?.title || ''
  } catch {
    return ''
  }
}

function _currentUrlContext() {
  if (!_currentUrl) return { url: '' }
  return _currentUrlIsExact
    ? { url: _currentUrl }
    : {
        url: _currentUrl,
        urlNote:
          '当前 iframe URL 因跨域策略不可读取；这里是打开/上次可读到的地址，页面如果发生跳转可能不再准确。',
      }
}

function _readFrameUrlIfAllowed() {
  try {
    const href = $('builtin-browser-frame')?.contentWindow?.location?.href || ''
    if (href && href !== 'about:blank') return href
  } catch {}
  return ''
}

function _clearSelectionIfUrlChanged(nextUrl) {
  if (!nextUrl || !_selection?.url || _selection.url === nextUrl) return
  _selection = null
  _renderSelection(null)
}

function _handleFrameLoad() {
  _frameLoadCount += 1
  const readableUrl = _readFrameUrlIfAllowed()
  if (readableUrl) {
    _clearSelectionIfUrlChanged(readableUrl)
    _currentUrl = readableUrl
    _currentUrlIsExact = true
    const input = $('builtin-browser-url')
    if (input) input.value = readableUrl
  } else {
    _currentUrlIsExact = false
    if (_frameLoadCount > 1) _clearSelectionIfUrlChanged('__cross_origin_navigation__')
  }

  if (_selecting) {
    _startSelectionMode()
  } else if (!_currentUrlIsExact && _frameLoadCount > 1) {
    _setStatus('预览已跳转，但当前 URL 因跨域策略不可读取；发给 AI 时会标注可能不准确。', 'warning')
  } else {
    _setStatus('预览已打开。')
  }
}

async function _submitRequest() {
  const ta = $('builtin-browser-request')
  const req = ta?.value?.trim() || ''
  if (!req) {
    _deps.toast('先输入你希望 AI 调整什么', 'error')
    ta?.focus()
    return
  }
  const ctx = _selection || { mode: 'page', ..._currentUrlContext(), title: _currentFrameTitle() }
  const prompt = buildBrowserSelectionPrompt(ctx, req)
  const result = await _deps.sendBrowserContext?.(prompt)
  if (result?.sent) {
    ta.value = ''
    _deps.toast('已把浏览器上下文发给 AI', 'success')
  } else {
    _deps.toast('已追加到输入框，请确认后发送', 'success')
  }
}

function _handleOverlayClick(ev) {
  if (!_selecting) return
  const overlay = $('builtin-browser-overlay')
  const rect = overlay.getBoundingClientRect()
  const x = Math.max(0, Math.round(ev.clientX - rect.left))
  const y = Math.max(0, Math.round(ev.clientY - rect.top))
  const width = Math.max(1, Math.round(rect.width))
  const height = Math.max(1, Math.round(rect.height))
  _selection = {
    mode: 'coordinate',
    ..._currentUrlContext(),
    title: '',
    click: {
      x,
      y,
      xPct: Number(((x / width) * 100).toFixed(1)),
      yPct: Number(((y / height) * 100).toFixed(1)),
    },
    viewport: { width, height },
  }
  _renderSelection(_selection)
  _setStatus('已记录坐标，可输入修改要求。', 'success')
  _stopSelectionMode({ keepStatus: true })
}

function _handleMessageLinkClick(ev) {
  const messages = $('messages')
  const anchor = ev.target?.closest?.('a[href]')
  if (!messages || !anchor || !messages.contains(anchor)) return
  const url = getBuiltinBrowserUrlForClick(ev, anchor, window.location.href)
  if (!url) return
  ev.preventDefault()
  _openUrl(url)
}

export function openBuiltinBrowser(url) {
  _openUrl(url)
}

export function initBuiltinBrowser(deps = {}) {
  _deps = { ..._deps, ...deps }
  $('builtin-browser-btn')?.addEventListener('click', () => {
    _openDrawer()
    $('builtin-browser-url')?.focus()
  })
  $('builtin-browser-backdrop')?.addEventListener('click', _closeDrawer)
  $('builtin-browser-close')?.addEventListener('click', _closeDrawer)
  $('builtin-browser-open')?.addEventListener('click', () => _openUrl($('builtin-browser-url')?.value))
  $('builtin-browser-reload')?.addEventListener('click', () => {
    const frame = $('builtin-browser-frame')
    if (frame?.src) frame.src = frame.src
  })
  $('builtin-browser-external')?.addEventListener('click', () => {
    if (_currentUrl && !_currentUrlIsExact) {
      _deps.toast('当前 iframe URL 不可读取，将打开已知地址', 'warning')
    }
    if (_currentUrl) window.open(_currentUrl, '_blank', 'noopener,noreferrer')
  })
  $('builtin-browser-select')?.addEventListener('click', _toggleSelectionMode)
  $('builtin-browser-send')?.addEventListener('click', _submitRequest)
  $('builtin-browser-clear')?.addEventListener('click', () => {
    _selection = null
    _renderSelection(null)
    _setStatus(_currentUrl ? '已清除选择。' : '')
  })
  $('builtin-browser-url')?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') _openUrl(ev.currentTarget.value)
  })
  $('builtin-browser-request')?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) _submitRequest()
  })
  $('builtin-browser-overlay')?.addEventListener('click', _handleOverlayClick)
  $('builtin-browser-frame')?.addEventListener('load', _handleFrameLoad)
  document.addEventListener('click', _handleMessageLinkClick)
}
