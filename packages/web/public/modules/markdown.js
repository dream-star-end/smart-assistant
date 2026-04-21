// OpenClaude — Markdown rendering, media embedding, rich blocks
import { htmlSafeEscape } from './dom.js'
import { effectiveTheme } from './theme.js'
import { _basename } from './util.js'

// ── Mermaid lazy loader ──
// A single shared promise prevents concurrent callers from each injecting a <script>.
// _mermaidInitialized tracks whether initialize() completed — distinct from window.mermaid
// being truthy (the script may load but initialize() may still throw).
let _mermaidLoadPromise = null
let _mermaidInitialized = false
async function ensureMermaid() {
  if (_mermaidInitialized) return
  if (_mermaidLoadPromise) return _mermaidLoadPromise
  _mermaidLoadPromise = new Promise((resolve, reject) => {
    const _doInit = () => {
      try {
        mermaid.initialize({
          startOnLoad: false,
          theme: effectiveTheme() === 'light' ? 'default' : 'dark',
          securityLevel: 'strict',
        })
        _mermaidInitialized = true
        resolve()
      } catch (err) {
        _mermaidLoadPromise = null
        reject(err)
      }
    }
    if (window.mermaid) {
      // Script already present externally — just initialize
      _doInit()
    } else {
      const s = document.createElement('script')
      s.src = '/vendor/mermaid.min.js'
      s.onload = _doInit
      s.onerror = (err) => { _mermaidLoadPromise = null; reject(err) }
      document.head.appendChild(s)
    }
  })
  return _mermaidLoadPromise
}

const pendingMermaid = []
const pendingHtmlPreviews = []
const pendingCharts = []
const pendingMath = [] // { id, tex, display }
const _chartInstances = new Map() // id -> Chart instance, for cleanup

// Streaming flag — when true, math extensions render to plain text instead of
// pushing to pendingMath, so incomplete `$...$` during streaming doesn't
// leave orphaned placeholders.
let _isStreamingParse = false

// ── marked renderer setup ──
if (window.marked) {
  marked.setOptions({ breaks: true, gfm: true })
  const renderer = new marked.Renderer()
  // marked v12+ changed renderer signatures: callbacks receive a single object parameter
  // instead of positional args. We handle both for safety.
  renderer.code = (codeOrObj, infostring) => {
    let code, lang
    if (typeof codeOrObj === 'object' && codeOrObj !== null) {
      // marked v12+: { text, lang, escaped }
      code = codeOrObj.text || ''
      lang = (codeOrObj.lang || '').match(/\S*/)?.[0] || ''
    } else {
      // marked v4/v5: (code, infostring, escaped)
      code = codeOrObj || ''
      lang = (infostring || '').match(/\S*/)?.[0] || ''
    }
    if (lang === 'mermaid') {
      const id = `mmd-${Math.random().toString(36).slice(2, 10)}`
      pendingMermaid.push({ id, code })
      return `<div class="mermaid-block" id="${id}">...</div>`
    }
    if (lang === 'chart') {
      const id = `chart-${Math.random().toString(36).slice(2, 10)}`
      pendingCharts.push({ id, code })
      return `<div class="chart-block" id="${id}"><canvas></canvas></div>`
    }
    if (lang === 'htmlpreview' || lang === 'preview') {
      const id = `htmlpv-${Math.random().toString(36).slice(2, 10)}`
      pendingHtmlPreviews.push({ id, code })
      return `<div class="html-preview-wrap" id="${id}"></div>`
    }
    let highlighted
    try {
      if (lang && window.hljs && hljs.getLanguage(lang)) {
        highlighted = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
      } else if (window.hljs) {
        highlighted = hljs.highlightAuto(code).value
      } else {
        highlighted = htmlSafeEscape(code)
      }
    } catch {
      highlighted = htmlSafeEscape(code)
    }
    const langLabel = lang ? `<span class="code-lang">${lang}</span>` : ''
    return `<pre class="code-block">${langLabel}<button class="code-copy" type="button" data-copy>复制</button><code class="hljs language-${lang}">${highlighted}</code></pre>`
  }
  // marked v12+: image receives { href, title, text } object
  renderer.image = (hrefOrObj, title, text) => {
    if (typeof hrefOrObj === 'object' && hrefOrObj !== null) {
      return _imgHtml(hrefOrObj.href || '', hrefOrObj.title || hrefOrObj.text || '')
    }
    return _imgHtml(hrefOrObj || '', title || text || '')
  }
  marked.setOptions({ renderer })

  // ── LaTeX math extensions ──
  // Block math: "$$...$$" beginning at line start, closed at end-of-line / EOF.
  // Inline math: "$...$" with strict boundaries:
  //   - Opening $ must be at start-of-src OR preceded by a non-word / non-$ / non-\ char
  //   - Opening $ must NOT be followed by whitespace / digit / $
  //   - Closing $ must NOT be preceded by whitespace / $ / \
  //   - Closing $ must NOT be followed by a word character (letter/digit)
  //   - Backslash escapes (e.g. \$) inside are skipped
  // No regex lookbehind is used, for Safari <16.4 compatibility.
  marked.use({
    extensions: [
      {
        name: 'mathBlock',
        level: 'block',
        // Only hint positions that are at a line start, to avoid splitting
        // paragraphs like "text $$x$$ more" into broken block tokens.
        start(src) {
          const m = /(?:^|\n)\$\$/.exec(src)
          if (!m) return undefined
          return src[m.index] === '$' ? m.index : m.index + 1
        },
        tokenizer(src) {
          const m = /^\$\$([\s\S]+?)\$\$(?=\n|$)/.exec(src)
          if (!m) return
          const tex = m[1].trim()
          if (!tex) return
          return { type: 'mathBlock', raw: m[0], text: tex }
        },
        renderer(token) {
          if (_isStreamingParse) {
            return `<p>${htmlSafeEscape(`$$${token.text}$$`)}</p>`
          }
          const id = `math-${Math.random().toString(36).slice(2, 10)}`
          pendingMath.push({ id, tex: token.text, display: true })
          return `<div class="math-block" id="${id}"></div>`
        },
      },
      {
        name: 'mathInline',
        level: 'inline',
        // Scan for the earliest $ that satisfies the strict opening boundary.
        // Skips over $ preceded by word-char/$/backslash (e.g. a$b, $$, \$)
        // or followed by whitespace/digit/$ (e.g. $ x, $5, $$).
        start(src) {
          const n = src.length
          let i = 0
          while (i < n) {
            const idx = src.indexOf('$', i)
            if (idx < 0) return undefined
            const prev = idx > 0 ? src[idx - 1] : ''
            const next = src[idx + 1] || ''
            const leftOK = !prev || !/[A-Za-z0-9_$\\]/.test(prev)
            const rightOK = next && !/[\s$\d]/.test(next)
            if (leftOK && rightOK) return idx
            i = idx + 1
          }
          return undefined
        },
        tokenizer(src) {
          // IMPORTANT: marked calls tokenizer with the full remaining src on the
          // first try; only after returning undefined does it advance to the
          // position hinted by start(). So we MUST guard that src begins with
          // a valid opening $ — otherwise the prefix text would be swallowed.
          if (src[0] !== '$' || src[1] === '$') return
          const next = src[1] || ''
          if (!next || /[\s$\d]/.test(next)) return
          // Scan forward for a valid closing $ on the same line.
          const n = src.length
          let j = 1
          while (j < n) {
            const c = src[j]
            if (c === '\n') return
            if (c === '\\' && j + 1 < n) {
              j += 2
              continue
            }
            if (c === '$') {
              const bef = src[j - 1]
              const aft = src[j + 1] || ''
              // Closing $ must not be preceded by space/$/backslash
              if (/[\s$\\]/.test(bef)) {
                j++
                continue
              }
              // Closing $ must not be followed by a word character
              if (/[A-Za-z0-9]/.test(aft)) {
                j++
                continue
              }
              const tex = src.slice(1, j)
              if (!tex) return
              return { type: 'mathInline', raw: src.slice(0, j + 1), text: tex }
            }
            j++
          }
        },
        renderer(token) {
          if (_isStreamingParse) {
            return htmlSafeEscape(`$${token.text}$`)
          }
          const id = `math-${Math.random().toString(36).slice(2, 10)}`
          pendingMath.push({ id, tex: token.text, display: false })
          return `<span class="math-inline" id="${id}"></span>`
        },
      },
    ],
  })
}

// ── Media URL auto-detection and inline embedding ──
const _IMG_EXTS = /\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?[^\s"')<]*)?$/i
const _AUD_EXTS = /\.(mp3|wav|ogg|aac|flac|m4a)(\?[^\s"')<]*)?$/i
const _VID_EXTS = /\.(mp4|webm|mov)(\?[^\s"')<]*)?$/i
const _PDF_EXTS = /\.pdf(\?[^\s"')<]*)?$/i

// Convert a local absolute path to a gateway-served URL
export function localPathToUrl(absPath) {
  return `/api/file?path=${encodeURIComponent(absPath)}`
}

// Validate URL scheme — only allow safe protocols for media action buttons
function _safeMediaUrl(url) {
  if (!url) return ''
  const trimmed = url.trim()
  if (/^(?:https?:|data:|blob:|\/)/i.test(trimmed)) return trimmed
  // Block javascript:, vbscript:, etc.
  return ''
}

export function _imgHtml(url, title) {
  const rawSafeUrl = _safeMediaUrl(url)
  if (!rawSafeUrl) return `<span>[blocked image: unsafe URL]</span>`
  // 2026-04-21 安全审计 Medium#F3:_safeMediaUrl 只做协议白名单,但拿到的字符串
  // 会直接被插进三个 HTML 属性(`src=`、`data-img-src=`、`title=`),如果 URL 里
  // 含 `"` / `<` / `&` 等字符(合法 data: 或攻击者构造 `https://evil.com/x" onerror=...`
  // 都算),就会断开属性并注入 event handler。协议白名单 ≠ 可直接插 HTML,必须
  // 再走一次 HTML-attribute escape。
  const safeUrl = htmlSafeEscape(rawSafeUrl)
  const svgCopy =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
  const svgDl =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>'
  const svgOpen =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>'
  const t = title ? ` title="${htmlSafeEscape(title)}"` : ''
  return `<div class="media-wrap"><img class="inline-img" src="${safeUrl}" loading="lazy"${t}><div class="img-actions"><button data-img-action="copy" data-img-src="${safeUrl}" title="复制图片">${svgCopy}</button><button data-img-action="download" data-img-src="${safeUrl}" title="下载">${svgDl}</button><button data-img-action="open" data-img-src="${safeUrl}" title="新标签页打开">${svgOpen}</button></div></div>`
}

export function _renderLocalMedia(filePath) {
  const url = localPathToUrl(filePath)
  const name = _basename(filePath) || 'file'
  if (_IMG_EXTS.test(filePath)) {
    return _imgHtml(url, name)
  }
  if (_AUD_EXTS.test(filePath)) {
    return `<div class="media-wrap"><audio controls preload="none" src="${url}"></audio><div class="media-filename">${htmlSafeEscape(name)}</div></div>`
  }
  if (_VID_EXTS.test(filePath)) {
    return `<div class="media-wrap"><video class="inline-video" controls preload="metadata" src="${url}"></video><div class="media-filename">${htmlSafeEscape(name)}</div></div>`
  }
  if (_PDF_EXTS.test(filePath)) {
    return `<a class="doc-card" href="${url}" target="_blank" rel="noopener"><span class="doc-card-icon">📄</span><span class="doc-card-name">${htmlSafeEscape(name)}</span></a>`
  }
  return `<a class="doc-card" href="${url}" target="_blank" rel="noopener" download="${htmlSafeEscape(name)}"><span class="doc-card-icon">📎</span><span class="doc-card-name">${htmlSafeEscape(name)}</span></a>`
}

export function embedMediaUrls(html) {
  // Step 0: Protect <pre> code blocks — replace with placeholders so paths inside
  // code blocks are not turned into media embeds
  const codeBlockPlaceholders = []
  html = html.replace(/<pre[\s\S]*?<\/pre>/gi, (m) => {
    const idx = codeBlockPlaceholders.length
    codeBlockPlaceholders.push(m)
    return `<!--CODE_BLOCK_${idx}-->`
  })

  // Step 1: Detect local file paths — both inline <code>/path/file.mp4</code> and bare /path/file.mp4
  // We need to handle HTML entities: marked converts `/` inside code to `<code>...</code>`
  // and may entity-encode chars. First handle <code>-wrapped paths, then bare paths.
  const _MEDIA_EXTS =
    'jpg|jpeg|png|gif|webp|bmp|svg|mp3|wav|ogg|aac|flac|m4a|mp4|webm|mov|avi|mkv|pdf'

  // Match <code>/path.ext</code> or <code>C:\path.ext</code> — handles both POSIX and Windows paths
  html = html.replace(
    new RegExp(`<code>((?:(?:/|[A-Za-z]:\\\\?)[^<]*?)\\.(?:${_MEDIA_EXTS}))</code>`, 'gi'),
    (match, rawPath) => {
      const filePath = rawPath
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
      return _renderLocalMedia(filePath)
    },
  )

  // Match bare absolute paths: /path/file.ext or C:\path\file.ext
  html = html.replace(
    new RegExp(
      `((?:^|[\\s>])((?:(?:/|[A-Za-z]:[\\\\\\\\])[^\\s<"\'\`>]+?\\.(?:${_MEDIA_EXTS}))))`,
      'gi',
    ),
    (match, full, filePath, offset) => {
      const before = html.substring(Math.max(0, offset - 10), offset)
      if (/(?:src|href|poster)\s*=\s*["']?\s*$/i.test(before)) return match
      // Don't replace if already inside an anchor or media tag
      if (/<(?:a|img|video|audio)[^>]*$/i.test(html.substring(Math.max(0, offset - 100), offset)))
        return match
      const prefix = full.charAt(0) !== '/' ? full.charAt(0) : ''
      return prefix + _renderLocalMedia(filePath)
    },
  )

  // Step 2: Detect HTTP URLs and /api/ paths
  const URL_RE = /((?:https?:\/\/[^\s"'<>)]+|\/api\/(?:media|file)[^\s"'<>)]+))/g

  html = html.replace(URL_RE, (match, url, offset) => {
    const before = html.substring(Math.max(0, offset - 10), offset)
    if (/(?:src|href|poster)\s*=\s*["']?\s*$/i.test(before)) return match
    if (before.endsWith('>') && /src=/.test(html.substring(Math.max(0, offset - 80), offset)))
      return match

    let decodedForExt = url
    try {
      decodedForExt = decodeURIComponent(url.split('?')[0])
    } catch {}

    if (_IMG_EXTS.test(decodedForExt)) {
      return _imgHtml(url, decodedForExt.split('/').pop() || '')
    }
    if (_AUD_EXTS.test(decodedForExt)) {
      return `<div class="media-wrap"><audio controls preload="none" src="${url}"></audio></div>`
    }
    if (_VID_EXTS.test(decodedForExt)) {
      return `<div class="media-wrap"><video class="inline-video" controls preload="metadata" src="${url}"></video></div>`
    }
    if (_PDF_EXTS.test(decodedForExt)) {
      const name = decodedForExt.split('/').pop() || 'document.pdf'
      return `<a class="doc-card" href="${url}" target="_blank" rel="noopener"><span class="doc-card-icon">📄</span><span class="doc-card-name">${htmlSafeEscape(name)}</span></a>`
    }
    return match
  })

  // Step 2.5: Fix ALL Markdown-rendered <img> that aren't proper HTTP URLs.
  // Agents may produce: ![alt](/path.png), ![alt](../path.png), ![alt](file?path=...),
  // ![alt](filename.png). None of these work as raw browser requests.
  // Rewrite anything that looks like a media file to use /api/file.
  const _MEDIA_IMG_EXTS_RE = /\.(?:jpg|jpeg|png|gif|webp|bmp|svg)(?:\?.*)?$/i
  const _MEDIA_AV_EXTS_RE = /\.(?:mp3|wav|ogg|aac|flac|m4a|mp4|webm|mov|pdf)(?:\?.*)?$/i
  html = html.replace(
    /<img\s+([^>]*)src=["']([^"']+)["']([^>]*)>/gi,
    (match, before, src, after) => {
      // Skip if already a proper URL (http/https/data/blob) or already /api/
      if (/^(?:https?:|data:|blob:|\/api\/)/i.test(src)) return match
      // Extract the path — handle relative paths, file?path=..., and absolute paths
      let absPath = src
      if (src.startsWith('file?path=')) {
        // file?path=%2Froot%2F... -> decode to /root/...
        try {
          absPath = decodeURIComponent(src.replace('file?path=', ''))
        } catch {
          absPath = src.replace('file?path=', '')
        }
      } else if (src.includes('/') && !src.startsWith('/')) {
        // Relative path like ../../../root/.openclaude/generated/foo.png
        // Try to extract the absolute part after the last ../
        const parts = src.split('/')
        const rootIdx = parts.findIndex(
          (p) => p === 'root' || p === 'home' || p === 'tmp' || p === 'opt',
        )
        if (rootIdx >= 0) absPath = `/${parts.slice(rootIdx).join('/')}`
      }
      if (_MEDIA_IMG_EXTS_RE.test(absPath)) return _renderLocalMedia(absPath)
      return match
    },
  )
  // Same for <a href="local-media-path"> (audio/video/pdf links from Markdown)
  html = html.replace(
    /<a\s+[^>]*href=["']([^"']+\.(?:mp3|wav|ogg|aac|flac|m4a|mp4|webm|mov|pdf))["'][^>]*>.*?<\/a>/gi,
    (match, src) => {
      if (/^(?:https?:|data:|blob:|\/api\/)/i.test(src)) return match
      let absPath = src
      if (src.includes('/') && !src.startsWith('/')) {
        const parts = src.split('/')
        const rootIdx = parts.findIndex(
          (p) => p === 'root' || p === 'home' || p === 'tmp' || p === 'opt',
        )
        if (rootIdx >= 0) absPath = `/${parts.slice(rootIdx).join('/')}`
      }
      if (_MEDIA_AV_EXTS_RE.test(absPath)) return _renderLocalMedia(absPath)
      return match
    },
  )

  // Step 3: Restore code block placeholders
  html = html.replace(
    /<!--CODE_BLOCK_(\d+)-->/g,
    (_, idx) => codeBlockPlaceholders[Number.parseInt(idx)] || '',
  )

  return html
}

export function renderMarkdown(text) {
  if (!text) return ''
  if (!window.marked) return embedMediaUrls(htmlSafeEscape(text).replace(/\n/g, '<br>'))
  try {
    const html = marked.parse(text)
    if (!window.DOMPurify) {
      // DOMPurify is a security-critical dependency — refuse to render unsanitized HTML
      return '<p style="color:var(--danger)">[安全组件加载失败,无法渲染富文本。请刷新页面。]</p>'
    }
    const sanitized = DOMPurify.sanitize(html, {
      // NOTE: iframe/srcdoc/sandbox NOT allowed here — htmlpreview iframes are created
      // separately in processRichBlocks() with fixed sandbox="allow-scripts"
      ADD_ATTR: [
        'loading',
        'controls',
        'preload',
        'autoplay',
        'data-img-action',
        'data-img-src',
      ],
    })
    return embedMediaUrls(sanitized)
  } catch {
    return htmlSafeEscape(text)
  }
}

// ── Streaming-safe Markdown renderer ──
// Pure function: no side effects on pendingMermaid/Charts/HtmlPreviews queues.
// Skips syntax highlighting (expensive). Renders mermaid/chart/htmlpreview fences
// as plain code blocks. No media URL embedding (deferred to final render).
let _streamingRenderer = null
function _getStreamingRenderer() {
  if (_streamingRenderer) return _streamingRenderer
  if (!window.marked) return null
  _streamingRenderer = new marked.Renderer()
  _streamingRenderer.code = (codeOrObj, infostring) => {
    let code, lang
    if (typeof codeOrObj === 'object' && codeOrObj !== null) {
      code = codeOrObj.text || ''
      lang = (codeOrObj.lang || '').match(/\S*/)?.[0] || ''
    } else {
      code = codeOrObj || ''
      lang = (infostring || '').match(/\S*/)?.[0] || ''
    }
    // Rich blocks: render as plain code placeholder (no side effects)
    if (lang === 'mermaid') {
      return `<pre class="code-block"><span class="code-lang">mermaid</span><code>${htmlSafeEscape(code)}</code></pre>`
    }
    if (lang === 'chart') {
      return `<pre class="code-block"><span class="code-lang">chart</span><code>${htmlSafeEscape(code)}</code></pre>`
    }
    if (lang === 'htmlpreview' || lang === 'preview') {
      return `<pre class="code-block"><span class="code-lang">preview</span><code>${htmlSafeEscape(code)}</code></pre>`
    }
    // Regular code: simple escape, no hljs (too expensive for streaming)
    const langLabel = lang ? `<span class="code-lang">${lang}</span>` : ''
    return `<pre class="code-block">${langLabel}<code>${htmlSafeEscape(code)}</code></pre>`
  }
  // Images: render as text placeholder during streaming to avoid broken 404 requests
  // (embedMediaUrls rewrites local paths, but is only called on final render)
  _streamingRenderer.image = (hrefOrObj, title, text) => {
    const alt = typeof hrefOrObj === 'object' ? (hrefOrObj.text || hrefOrObj.title || '') : (title || text || '')
    return `<span class="streaming-img-placeholder">[图片: ${htmlSafeEscape(alt || '...')}]</span>`
  }
  return _streamingRenderer
}

export function renderStreamingMarkdown(text) {
  if (!text) return ''
  const renderer = _getStreamingRenderer()
  if (!renderer || !window.marked) return htmlSafeEscape(text).replace(/\n/g, '<br>')
  _isStreamingParse = true
  try {
    const html = marked.parse(text, { renderer })
    if (!window.DOMPurify) return htmlSafeEscape(text).replace(/\n/g, '<br>')
    return DOMPurify.sanitize(html, {
      // During streaming: forbid media tags to prevent broken 404 requests
      // (embedMediaUrls rewrites paths only on final render)
      FORBID_TAGS: ['img', 'video', 'audio', 'iframe'],
    })
  } catch {
    return htmlSafeEscape(text).replace(/\n/g, '<br>')
  } finally {
    _isStreamingParse = false
  }
}

export function clearChartInstances() {
  for (const [id, chart] of _chartInstances) {
    try {
      chart.destroy()
    } catch {}
  }
  _chartInstances.clear()
}

export async function processRichBlocks() {
  if (pendingMermaid.length > 0) {
    try { await ensureMermaid() } catch {}
  }
  while (pendingMermaid.length > 0) {
    const { id, code } = pendingMermaid.shift()
    const el = document.getElementById(id)
    if (!el || !window.mermaid) continue
    try {
      const { svg } = await mermaid.render(`${id}-svg`, code)
      el.innerHTML = window.DOMPurify
        ? DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } })
        : svg
    } catch (err) {
      el.className = 'mermaid-error'
      el.textContent = `Mermaid error: ${err?.message || String(err)}`
    }
  }
  while (pendingCharts.length > 0) {
    const { id, code } = pendingCharts.shift()
    const el = document.getElementById(id)
    if (!el || !window.Chart) continue
    const canvas = el.querySelector('canvas')
    if (!canvas) continue
    try {
      const config = JSON.parse(code)
      // Apply theme-aware defaults
      const isDark = effectiveTheme() === 'dark'
      const textColor = isDark ? '#c4b5a0' : '#4a3f35'
      const gridColor = isDark ? 'rgba(196,181,160,0.12)' : 'rgba(74,63,53,0.1)'
      if (!config.options) config.options = {}
      if (!config.options.plugins) config.options.plugins = {}
      if (!config.options.plugins.legend) config.options.plugins.legend = {}
      if (!config.options.plugins.legend.labels) config.options.plugins.legend.labels = {}
      config.options.plugins.legend.labels.color =
        config.options.plugins.legend.labels.color || textColor
      if (!config.options.scales) config.options.scales = {}
      for (const axis of ['x', 'y']) {
        if (!config.options.scales[axis]) config.options.scales[axis] = {}
        if (!config.options.scales[axis].ticks) config.options.scales[axis].ticks = {}
        config.options.scales[axis].ticks.color =
          config.options.scales[axis].ticks.color || textColor
        if (!config.options.scales[axis].grid) config.options.scales[axis].grid = {}
        config.options.scales[axis].grid.color = config.options.scales[axis].grid.color || gridColor
      }
      config.options.responsive = true
      config.options.maintainAspectRatio = true
      // Destroy previous instance if re-rendering
      if (_chartInstances.has(id)) {
        _chartInstances.get(id).destroy()
        _chartInstances.delete(id)
      }
      _chartInstances.set(id, new Chart(canvas, config))
    } catch (err) {
      el.className = 'chart-error'
      el.textContent = `Chart error: ${err?.message || String(err)}`
    }
  }
  while (pendingMath.length > 0) {
    const { id, tex, display } = pendingMath.shift()
    const el = document.getElementById(id)
    if (!el) continue
    if (!window.katex) {
      // KaTeX didn't load — show raw TeX in monospace as graceful degradation
      el.className = display ? 'math-block math-fallback' : 'math-inline math-fallback'
      el.textContent = display ? `$$${tex}$$` : `$${tex}$`
      continue
    }
    try {
      window.katex.render(tex, el, {
        displayMode: display,
        throwOnError: false,
        output: 'html',
        strict: 'ignore',
        trust: false,
      })
    } catch (err) {
      el.className = display ? 'math-block math-error' : 'math-inline math-error'
      el.textContent = `KaTeX error: ${err?.message || String(err)}`
    }
  }
  while (pendingHtmlPreviews.length > 0) {
    const { id, code } = pendingHtmlPreviews.shift()
    const el = document.getElementById(id)
    if (!el) continue
    const iframeId = `${id}-iframe`
    el.innerHTML = `<div class="html-preview-head"><span>HTML preview (sandboxed)</span><button type="button" data-view-source="${iframeId}">view source</button></div><iframe id="${iframeId}" class="html-preview-iframe" sandbox="allow-scripts"></iframe>`
    const iframe = document.getElementById(iframeId)
    if (iframe) {
      // Inject auto-resize script into the HTML content
      const resizeScript = `<script>new ResizeObserver(()=>{parent.postMessage({type:"iframe-resize",id:"${iframeId}",h:document.documentElement.scrollHeight},"*")}).observe(document.documentElement)<\/script>`
      const fullCode = code.includes('</body>')
        ? code.replace('</body>', `${resizeScript}</body>`)
        : code + resizeScript
      try {
        iframe.srcdoc = fullCode
      } catch {
        iframe.contentWindow?.document?.write(fullCode)
        iframe.contentWindow?.document?.close()
      }
      iframe.dataset.source = code
    }
  }
}
