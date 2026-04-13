// OpenClaude — Markdown rendering, media embedding, rich blocks
import { htmlSafeEscape } from './dom.js'
import { effectiveTheme } from './theme.js'
import { _basename } from './util.js'

// ── Mermaid init ──
if (window.mermaid) {
  try {
    mermaid.initialize({
      startOnLoad: false,
      theme: effectiveTheme() === 'light' ? 'default' : 'dark',
      securityLevel: 'strict',
    })
  } catch {}
}

const pendingMermaid = []
const pendingHtmlPreviews = []
const pendingCharts = []
const _chartInstances = new Map() // id -> Chart instance, for cleanup

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

export function _imgHtml(url, title) {
  const svgCopy =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
  const svgDl =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>'
  const svgOpen =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>'
  const t = title ? ` title="${htmlSafeEscape(title)}"` : ''
  return `<div class="media-wrap"><img class="inline-img" src="${url}" loading="lazy"${t}><div class="img-actions"><button data-img-action="copy" data-img-src="${url}" title="复制图片">${svgCopy}</button><button data-img-action="download" data-img-src="${url}" title="下载">${svgDl}</button><button data-img-action="open" data-img-src="${url}" title="新标签页打开">${svgOpen}</button></div></div>`
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
      ADD_TAGS: ['iframe'],
      ADD_ATTR: [
        'sandbox',
        'srcdoc',
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

export function clearChartInstances() {
  for (const [id, chart] of _chartInstances) {
    try {
      chart.destroy()
    } catch {}
  }
  _chartInstances.clear()
}

export async function processRichBlocks() {
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
