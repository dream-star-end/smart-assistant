;(() => {
  const $ = (id) => document.getElementById(id)
  const _isMac = /Mac|iPhone|iPad/.test(navigator.platform)
  const _mod = _isMac ? '⌘' : 'Ctrl+'
  const htmlSafeEscape = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    )

  // ═══════════════ THEME ═══════════════
  const THEME_KEY = 'openclaude_theme'
  function effectiveTheme() {
    const saved = localStorage.getItem(THEME_KEY) || 'system'
    if (saved === 'system')
      return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
    return saved
  }
  function applyTheme() {
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
  function cycleTheme() {
    const curr = localStorage.getItem(THEME_KEY) || 'system'
    const next = curr === 'dark' ? 'light' : curr === 'light' ? 'system' : 'dark'
    localStorage.setItem(THEME_KEY, next)
    applyTheme()
    toast(`主题: ${next === 'system' ? '跟随系统' : next === 'dark' ? '暗色' : '亮色'}`)
  }
  applyTheme()
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if ((localStorage.getItem(THEME_KEY) || 'system') === 'system') applyTheme()
  })

  // ═══════════════ MARKDOWN + HIGHLIGHT + MERMAID ═══════════════
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
  const _chartInstances = new Map() // id → Chart instance, for cleanup

  if (window.marked) {
    marked.setOptions({ breaks: true, gfm: true })
    const renderer = new marked.Renderer()
    renderer.code = (code, infostring) => {
      const lang = (infostring || '').match(/\S*/)?.[0] || ''
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
    // Override image renderer so markdown ![alt](url) also produces inline-img with actions
    renderer.image = (href, title, text) => _imgHtml(href, title || text || '')
    marked.setOptions({ renderer })
  }

  // ── Media URL auto-detection and inline embedding ──
  const _IMG_EXTS = /\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?[^\s"')<]*)?$/i
  const _AUD_EXTS = /\.(mp3|wav|ogg|aac|flac|m4a)(\?[^\s"')<]*)?$/i
  const _VID_EXTS = /\.(mp4|webm|mov)(\?[^\s"')<]*)?$/i
  const _PDF_EXTS = /\.pdf(\?[^\s"')<]*)?$/i

  // Convert a local absolute path to a gateway-served URL
  function localPathToUrl(absPath) {
    return `/api/file?path=${encodeURIComponent(absPath)}`
  }

  function _imgHtml(url, title) {
    const svgCopy =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
    const svgDl =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>'
    const svgOpen =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>'
    const t = title ? ` title="${htmlSafeEscape(title)}"` : ''
    return `<div class="media-wrap"><img class="inline-img" src="${url}" loading="lazy"${t}><div class="img-actions"><button data-img-action="copy" data-img-src="${url}" title="复制图片">${svgCopy}</button><button data-img-action="download" data-img-src="${url}" title="下载">${svgDl}</button><button data-img-action="open" data-img-src="${url}" title="新标签页打开">${svgOpen}</button></div></div>`
  }

  function _basename(p) {
    // Handle both Unix / and Windows \ separators
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
    return i >= 0 ? p.slice(i + 1) : p
  }

  function _renderLocalMedia(filePath) {
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

  function embedMediaUrls(html) {
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

    // Match bare absolute paths (not inside tags)
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
          // file?path=%2Froot%2F... → decode to /root/...
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
          if (rootIdx >= 0) absPath = '/' + parts.slice(rootIdx).join('/')
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
          if (rootIdx >= 0) absPath = '/' + parts.slice(rootIdx).join('/')
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

  function renderMarkdown(text) {
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

  async function processRichBlocks() {
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
          config.options.scales[axis].grid.color =
            config.options.scales[axis].grid.color || gridColor
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

  // Global click for copy + view source
  document.addEventListener('click', (e) => {
    const srcBtn = e.target.closest?.('[data-view-source]')
    if (srcBtn) {
      const id = srcBtn.dataset.viewSource
      const iframe = document.getElementById(id)
      if (!iframe) return
      const wrap = iframe.parentElement
      const showing = wrap.dataset.showingSource === '1'
      if (showing) {
        const pre = wrap.querySelector('pre.src-view')
        if (pre) pre.remove()
        iframe.style.display = ''
        wrap.dataset.showingSource = '0'
        srcBtn.textContent = 'view source'
      } else {
        iframe.style.display = 'none'
        const pre = document.createElement('pre')
        pre.className = 'src-view'
        pre.style.cssText =
          'background:var(--code-bg);color:var(--fg);padding:14px 16px;margin:0;max-height:400px;overflow:auto;font-family:var(--font-mono);font-size:12px;white-space:pre-wrap;word-break:break-all'
        pre.textContent = iframe.dataset.source || ''
        wrap.appendChild(pre)
        wrap.dataset.showingSource = '1'
        srcBtn.textContent = 'hide source'
      }
      return
    }
    const btn = e.target.closest?.('[data-copy]')
    if (!btn) return
    const pre = btn.closest('pre')
    const code = pre?.querySelector('code')
    if (!code) return
    const text = code.innerText
    const done = () => {
      btn.textContent = '已复制'
      btn.classList.add('copied')
      setTimeout(() => {
        btn.textContent = '复制'
        btn.classList.remove('copied')
      }, 1500)
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(done)
        .catch(() => {
          fallbackCopy(text)
          done()
        })
    } else {
      fallbackCopy(text)
      done()
    }
  })
  function fallbackCopy(text) {
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

  // ═══════════════ PER-SESSION SENDING STATE ═══════════════
  // sendingInFlight is per-session: each session tracks its own state.
  // The global `state.sendingInFlight` acts as a cache for the CURRENT session only.
  function isSending() {
    const sess = getSession()
    return sess?._sendingInFlight || false
  }
  function setSending(val) {
    const sess = getSession()
    if (sess) sess._sendingInFlight = val
    state.sendingInFlight = val
  }

  // ═══════════════ UTILITIES ═══════════════
  const uuid = () => `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const msgId = () => `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  function formatSize(n) {
    if (n < 1024) return `${n} B`
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / 1048576).toFixed(1)} MB`
  }
  function shortTime(ts) {
    const diff = (Date.now() - ts) / 1000
    if (diff < 60) return '刚刚'
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
    if (diff < 604800) return `${Math.floor(diff / 86400)} 天前`
    return new Date(ts).toLocaleDateString('zh-CN')
  }
  function sessionGroup(ts) {
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const yesterdayStart = todayStart - 86400000
    const weekStart = todayStart - 6 * 86400000
    const monthStart = todayStart - 30 * 86400000
    if (ts >= todayStart) return '今天'
    if (ts >= yesterdayStart) return '昨天'
    if (ts >= weekStart) return '本周'
    if (ts >= monthStart) return '本月'
    return '更早'
  }
  const GROUP_ORDER = ['今天', '昨天', '本周', '本月', '更早']

  // ═══════════════ INDEXEDDB ═══════════════
  const DB_NAME = 'openclaude'
  const DB_VERSION = 1
  let _db = null
  function openDB() {
    if (_db) return Promise.resolve(_db)
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('sessions'))
          db.createObjectStore('sessions', { keyPath: 'id' })
      }
      req.onsuccess = () => {
        _db = req.result
        res(_db)
      }
      req.onerror = () => rej(req.error)
    })
  }
  async function dbGetAll() {
    const db = await openDB()
    return new Promise((res, rej) => {
      const tx = db.transaction('sessions', 'readonly')
      const req = tx.objectStore('sessions').getAll()
      req.onsuccess = () => res(req.result || [])
      req.onerror = () => rej(req.error)
    })
  }
  async function dbPut(obj) {
    const db = await openDB()
    return new Promise((res, rej) => {
      const tx = db.transaction('sessions', 'readwrite')
      tx.objectStore('sessions').put(obj)
      tx.oncomplete = () => res()
      tx.onerror = () => rej(tx.error)
    })
  }
  async function dbDelete(id) {
    const db = await openDB()
    return new Promise((res, rej) => {
      const tx = db.transaction('sessions', 'readwrite')
      tx.objectStore('sessions').delete(id)
      tx.oncomplete = () => res()
      tx.onerror = () => rej(tx.error)
    })
  }

  // ═══════════════ STATE ═══════════════
  const state = {
    token: localStorage.getItem('openclaude_token') || '',
    ws: null,
    wsStatus: 'disconnected',
    sessions: new Map(),
    currentSessionId: null,
    reconnectTimer: null,
    sendingInFlight: false,
    agentsList: [],
    defaultAgentId: 'main',
    attachments: [],
    recognition: null,
    recognizing: false,
    windowFocused: document.hasFocus(),
    offlineQueue: [], // messages queued while disconnected
  }
  document.addEventListener('visibilitychange', () => {
    state.windowFocused = !document.hidden
  })
  window.addEventListener('focus', () => {
    state.windowFocused = true
  })
  // Auto-resize htmlpreview iframes based on content height
  window.addEventListener('message', (e) => {
    if (e.data?.type === 'iframe-resize' && e.data.id && e.data.h) {
      const iframe = document.getElementById(e.data.id)
      if (iframe) iframe.style.height = `${Math.min(Math.max(e.data.h + 10, 200), 800)}px`
    }
  })
  window.addEventListener('blur', () => {
    state.windowFocused = false
  })

  // ═══════════════ API ═══════════════
  function authHeaders(extra) {
    return { Authorization: `Bearer ${state.token}`, ...(extra || {}) }
  }
  async function apiGet(path) {
    const res = await fetch(path, { headers: authHeaders() })
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`)
    return res.json()
  }
  async function apiJson(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data?.error || `${method} ${path} failed`)
    return data
  }

  // ═══════════════ TOAST + MODAL ═══════════════
  let _toastTimer = null
  function toast(msg, kind) {
    const el = $('toast')
    el.innerHTML = `${htmlSafeEscape(msg)} <button onclick="this.parentElement.classList.remove(\'show\')" style="margin-left:8px;background:none;border:none;color:inherit;cursor:pointer;opacity:0.7;font-size:14px">&times;</button>`
    el.className = `toast show${kind ? ` ${kind}` : ''}`
    el.style.pointerEvents = 'auto'
    if (_toastTimer) clearTimeout(_toastTimer)
    const duration = kind === 'error' ? 5000 : 2500
    _toastTimer = setTimeout(() => {
      el.classList.remove('show')
      el.style.pointerEvents = ''
    }, duration)
  }
  let _modalFocusReturn = null
  function openModal(id) {
    _modalFocusReturn = document.activeElement
    $(id).classList.add('open')
    // Focus trap: focus first focusable element inside modal
    const modal = $(id).querySelector('.modal')
    if (modal) {
      const focusable = modal.querySelector('input,textarea,select,button:not([disabled])')
      if (focusable) setTimeout(() => focusable.focus(), 50)
    }
  }
  function closeModal(id) {
    $(id).classList.remove('open')
    if (_modalFocusReturn) {
      try {
        _modalFocusReturn.focus()
      } catch {}
      _modalFocusReturn = null
    }
  }
  document.addEventListener('click', (e) => {
    const btn = e.target.closest?.('[data-close-modal]')
    if (btn) closeModal(btn.dataset.closeModal)
    // close modal on backdrop click
    const backdrop = e.target.classList?.contains('modal-backdrop') ? e.target : null
    if (backdrop) backdrop.classList.remove('open')
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document
        .querySelectorAll('.modal-backdrop.open, .palette-backdrop.open')
        .forEach((el) => el.classList.remove('open'))
    }
  })

  // ═══════════════ LIGHTBOX ═══════════════
  function openLightbox(el) {
    const lb = $('lightbox')
    const body = lb.querySelector('.lightbox-body')
    body.innerHTML = ''
    if (el.tagName === 'IMG') {
      const img = document.createElement('img')
      img.src = el.src
      img.alt = el.alt || ''
      body.appendChild(img)
    } else if (el.tagName === 'VIDEO') {
      const vid = document.createElement('video')
      vid.src = el.src
      vid.controls = true
      vid.autoplay = true
      body.appendChild(vid)
    }
    lb.hidden = false
    document.body.style.overflow = 'hidden'
  }
  function closeLightbox() {
    const lb = $('lightbox')
    lb.hidden = true
    const vid = lb.querySelector('video')
    if (vid) {
      vid.pause()
      vid.src = ''
    }
    lb.querySelector('.lightbox-body').innerHTML = ''
    document.body.style.overflow = ''
  }
  document.addEventListener('click', (e) => {
    const img = e.target.closest?.('.inline-img')
    if (img) {
      e.preventDefault()
      openLightbox(img)
      return
    }
    const vid = e.target.closest?.('.inline-video')
    if (vid && !e.target.closest('.lightbox-body')) {
      e.preventDefault()
      openLightbox(vid)
      return
    }
    if (e.target.closest?.('.lightbox-close')) {
      closeLightbox()
      return
    }
    if (e.target.id === 'lightbox' || e.target.classList?.contains('lightbox-backdrop')) {
      closeLightbox()
      return
    }
  })
  // ── Image action buttons (copy/download/open) ──
  document.addEventListener('click', (e) => {
    const btn = e.target.closest?.('[data-img-action]')
    if (!btn) return
    e.preventDefault()
    e.stopPropagation()
    const action = btn.dataset.imgAction
    const src = btn.dataset.imgSrc
    if (!src) return

    if (action === 'copy') {
      fallbackCopy(src)
      toast('已复制图片链接')
    } else if (action === 'download') {
      const a = document.createElement('a')
      a.href = src
      a.download = src.split('/').pop()?.split('?')[0] || 'image.jpg'
      a.target = '_blank'
      a.click()
    } else if (action === 'open') {
      window.open(src, '_blank')
    }
  })

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('lightbox').hidden) {
      closeLightbox()
      e.stopPropagation()
    }
  })

  // ═══════════════ ATTACHMENTS ═══════════════
  const MAX_FILE_SIZE_SMALL = 5 * 1024 * 1024 // 5MB for images/text
  const MAX_FILE_SIZE_LARGE = 25 * 1024 * 1024 // 25MB for audio/video/docs
  const MAX_TOTAL_SIZE = 50 * 1024 * 1024 // 50MB total (matches server limit)
  const MAX_FILES = 5

  function fileToDataURL(file) {
    return new Promise((res, rej) => {
      const r = new FileReader()
      r.onload = () => res(r.result)
      r.onerror = () => rej(r.error)
      r.readAsDataURL(file)
    })
  }
  function fileToText(file) {
    return new Promise((res, rej) => {
      const r = new FileReader()
      r.onload = () => res(r.result)
      r.onerror = () => rej(r.error)
      r.readAsText(file)
    })
  }

  function classifyFile(file) {
    const t = file.type || ''
    if (t.startsWith('image/')) return 'image'
    if (t.startsWith('audio/')) return 'audio'
    if (t.startsWith('video/')) return 'video'
    // Binary document types → 'file' kind (sent as base64)
    const binExts = /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|zip|rar|7z)$/i
    if (
      binExts.test(file.name) ||
      t === 'application/pdf' ||
      t.includes('officedocument') ||
      t.includes('msword') ||
      t.includes('ms-excel') ||
      t.includes('ms-powerpoint')
    ) {
      return 'file'
    }
    return 'text' // fallback: treat as text
  }

  async function addFiles(fileList) {
    for (const f of fileList) {
      if (state.attachments.length >= MAX_FILES) {
        toast(`最多 ${MAX_FILES} 个附件`, 'error')
        break
      }
      const kind = classifyFile(f)
      const maxSize =
        kind === 'audio' || kind === 'video' || kind === 'file'
          ? MAX_FILE_SIZE_LARGE
          : MAX_FILE_SIZE_SMALL
      if (f.size > maxSize) {
        toast(`${f.name} 超过 ${maxSize / 1024 / 1024}MB`, 'error')
        continue
      }
      // Check total budget before reading file into memory
      const currentTotal = state.attachments.reduce((sum, a) => sum + (a.size || 0), 0)
      if (currentTotal + f.size > MAX_TOTAL_SIZE) {
        toast(`总附件大小超过 ${MAX_TOTAL_SIZE / 1024 / 1024}MB 限制`, 'error')
        break
      }
      try {
        const att = { name: f.name, size: f.size, type: f.type || 'application/octet-stream', kind }
        if (kind === 'text') {
          att.text = await fileToText(f)
        } else {
          att.dataUrl = await fileToDataURL(f)
        }
        state.attachments.push(att)
      } catch (err) {
        toast(`读取 ${f.name} 失败: ${err}`, 'error')
      }
    }
    renderAttachments()
  }
  function removeAttachment(idx) {
    state.attachments.splice(idx, 1)
    renderAttachments()
  }
  function renderAttachments() {
    const wrap = $('attachments')
    if (!wrap) return
    if (state.attachments.length === 0) {
      wrap.hidden = true
      wrap.innerHTML = ''
      return
    }
    wrap.hidden = false
    wrap.innerHTML = ''
    state.attachments.forEach((a, i) => {
      const item = document.createElement('div')
      item.className = 'attach-item'
      if (a.kind === 'image' && a.dataUrl) {
        const img = document.createElement('img')
        img.className = 'attach-thumb'
        img.src = a.dataUrl
        item.appendChild(img)
      } else {
        const icons = { audio: '🎵', video: '🎬', file: '📄', text: '📝' }
        item.insertAdjacentHTML(
          'beforeend',
          `<span style="font-size:16px">${icons[a.kind] || '📎'}</span>`,
        )
      }
      const name = document.createElement('span')
      name.className = 'attach-name'
      name.textContent = a.name
      item.appendChild(name)
      const size = document.createElement('span')
      size.className = 'attach-size'
      size.textContent = formatSize(a.size)
      item.appendChild(size)
      const rm = document.createElement('button')
      rm.className = 'attach-remove'
      rm.textContent = '×'
      rm.title = '移除'
      rm.onclick = () => removeAttachment(i)
      item.appendChild(rm)
      wrap.appendChild(item)
    })
  }

  // ═══════════════ VOICE ═══════════════
  function initSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) return null
    const rec = new SR()
    rec.lang = 'zh-CN'
    rec.continuous = true
    rec.interimResults = true
    let finalText = ''
    rec.onstart = () => {
      state.recognizing = true
      $('voice-btn').classList.add('recording')
      finalText = $('input').value
      if (finalText && !finalText.endsWith(' ')) finalText += ' '
    }
    rec.onresult = (ev) => {
      let interim = ''
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const txt = ev.results[i][0].transcript
        if (ev.results[i].isFinal) finalText += txt
        else interim += txt
      }
      $('input').value = finalText + interim
      autoResize()
    }
    rec.onerror = (ev) => {
      toast(`语音识别出错: ${ev.error}`, 'error')
    }
    rec.onend = () => {
      state.recognizing = false
      $('voice-btn').classList.remove('recording')
    }
    return rec
  }
  function toggleVoice() {
    if (!state.recognition) state.recognition = initSpeech()
    if (!state.recognition) {
      toast('浏览器不支持语音识别 (建议 Chrome/Edge)', 'error')
      return
    }
    if (state.recognizing) state.recognition.stop()
    else
      try {
        state.recognition.start()
      } catch {}
  }

  // ═══════════════ NOTIFICATIONS ═══════════════
  // ── Notification sound ──
  const _notifSound = (() => {
    try {
      // Short gentle chime as data URI (base64 WAV, ~0.2s)
      const ctx = new (window.AudioContext || window.webkitAudioContext)()
      return () => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.connect(gain)
        gain.connect(ctx.destination)
        osc.type = 'sine'
        osc.frequency.value = 880
        gain.gain.setValueAtTime(0.15, ctx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3)
        osc.start(ctx.currentTime)
        osc.stop(ctx.currentTime + 0.3)
      }
    } catch {
      return () => {}
    }
  })()

  // ── Title bar status ──
  const _originalTitle = document.title
  function setTitleBusy(busy) {
    if (busy) {
      document.title = '⏳ 思考中... — OpenClaude'
    } else {
      const sess = getSession()
      document.title = sess?.title ? `${sess.title} — OpenClaude` : _originalTitle
    }
  }

  function maybeNotify(title, body) {
    // Play sound if tab not focused
    if (!state.windowFocused) _notifSound()
    if (state.windowFocused) return
    if (!('Notification' in window)) return
    // Request permission on first background notification (not on login)
    if (Notification.permission === 'default') {
      requestNotifyPermission()
      return
    }
    if (Notification.permission !== 'granted') return
    try {
      const n = new Notification(title, {
        body: body ? body.slice(0, 200) : '',
        icon: '/icon.svg',
        badge: '/icon.svg',
        tag: 'openclaude',
        silent: false,
      })
      n.onclick = () => {
        window.focus()
        n.close()
      }
    } catch {}
  }
  async function requestNotifyPermission() {
    if (!('Notification' in window)) return
    if (Notification.permission === 'default') {
      try {
        await Notification.requestPermission()
      } catch {}
    }
  }

  // ═══════════════ PERMISSION REQUESTS ═══════════════
  // Queue pending permission requests; show modal for the head of the queue.
  const permQueue = []
  let permCurrent = null
  function enqueuePermission(frame) {
    const req = frame.permissionRequest
    if (!req || !req.id) return
    // Dedupe: if we've already got this reqId, skip
    if (permCurrent && permCurrent.id === req.id) return
    if (permQueue.some((p) => p.id === req.id)) return
    // Extract reason + detail from the block text body
    const blockText = (frame.blocks || []).map((b) => b.text || '').join('\n')
    const enriched = {
      id: req.id,
      tool: req.tool,
      summary: req.summary,
      rawText: blockText,
    }
    permQueue.push(enriched)
    if (!permCurrent) showNextPermission()
  }
  function showNextPermission() {
    if (permCurrent) return
    permCurrent = permQueue.shift()
    if (!permCurrent) return
    $('perm-tool').value = permCurrent.tool || ''
    const m = /规则:\s*([^\n]+)/.exec(permCurrent.rawText || '')
    $('perm-reason').value = m ? m[1].trim() : '(unknown)'
    $('perm-detail').value = permCurrent.summary || ''
    const pendingMsg = permQueue.length > 0 ? `(后面还有 ${permQueue.length} 个待审批)` : ''
    $('perm-pending-count').textContent = pendingMsg
    openModal('permission-modal')
  }
  function respondPermission(decision) {
    if (!permCurrent) return
    if (!state.ws || state.ws.readyState !== 1) {
      toast('未连接,无法响应', 'error')
      return
    }
    state.ws.send(
      JSON.stringify({
        type: 'inbound.permission_response',
        requestId: permCurrent.id,
        decision,
      }),
    )
    toast(decision === 'allow' ? '已批准' : '已拒绝', decision === 'allow' ? 'success' : 'error')
    permCurrent = null
    closeModal('permission-modal')
    setTimeout(showNextPermission, 150)
  }

  // ═══════════════ MEMORY + SKILLS ═══════════════
  let _memoryTab = 'memory'
  // ═══════════════ CLAUDE OAUTH ═══════════════
  let _oauthState = null
  function openOAuthModal() {
    $('oauth-step1').hidden = false
    $('oauth-step2').hidden = true
    $('oauth-error').hidden = true
    $('oauth-code-input').value = ''
    openModal('oauth-modal')
  }
  $('oauth-start-btn').onclick = async () => {
    try {
      const oauthProvider = $('oauth-provider').value
      const r = await fetch('/api/auth/claude/start', {
        method: 'POST',
        headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: oauthProvider }),
      })
      const data = await r.json()
      if (data.authUrl) {
        _oauthState = data.state
        window.open(data.authUrl, '_blank')
        $('oauth-code-input').focus()
        // For Codex, show extra hint about copying URL code
        if (oauthProvider === 'codex') {
          $('oauth-code-input').placeholder = '授权后从浏览器地址栏复制 code=XXX 的值...'
        } else {
          $('oauth-code-input').placeholder = '粘贴授权代码或完整回调 URL...'
        }
      } else {
        $('oauth-error').textContent = '生成授权链接失败'
        $('oauth-error').hidden = false
      }
    } catch (e) {
      $('oauth-error').textContent = `请求失败: ${e}`
      $('oauth-error').hidden = false
    }
  }
  $('oauth-submit-btn').onclick = async () => {
    let code = $('oauth-code-input').value.trim()
    if (!code) {
      $('oauth-error').textContent = '请粘贴授权代码或回调 URL'
      $('oauth-error').hidden = false
      return
    }
    if (!_oauthState) {
      $('oauth-error').textContent = '请先点击"打开授权页面"'
      $('oauth-error').hidden = false
      return
    }
    // Auto-parse: if user pasted the full callback URL, extract code from it
    if (code.includes('code=')) {
      try {
        const u = new URL(code.startsWith('http') ? code : `http://x?${code}`)
        code = u.searchParams.get('code') || code
      } catch {}
    }
    $('oauth-submit-btn').disabled = true
    $('oauth-submit-btn').textContent = '验证中...'
    $('oauth-error').hidden = true
    try {
      const r = await fetch('/api/auth/claude/callback', {
        method: 'POST',
        headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, state: _oauthState }),
      })
      const data = await r.json()
      if (data.ok) {
        $('oauth-step1').hidden = true
        $('oauth-step2').hidden = false
        const provName = $('oauth-provider').value === 'codex' ? 'OpenAI Codex' : 'Claude.ai'
        $('oauth-result-text').textContent =
          `已连接 ${provName} · Token 有效期 ${Math.round((data.expiresIn || 3600) / 60)} 分钟`
        toast(`${provName} 登录成功!`, 'success')
        setTimeout(() => closeModal('oauth-modal'), 2000)
      } else {
        $('oauth-error').textContent = data.error || '登录失败'
        $('oauth-error').hidden = false
      }
    } catch (e) {
      $('oauth-error').textContent = `请求失败: ${e}`
      $('oauth-error').hidden = false
    } finally {
      $('oauth-submit-btn').disabled = false
      $('oauth-submit-btn').textContent = '完成登录'
    }
  }

  async function openMemoryModal(agentId) {
    const id = agentId || (getSession()?.agentId ?? state.defaultAgentId)
    _memoryTab = 'memory'
    const title = $('memory-modal-title')
    title.textContent = `Memory — ${id}`
    title.dataset.agentId = id
    await loadMemoryTab('memory', id)
    $('memory-tab-memory').className = 'btn btn-secondary'
    $('memory-tab-user').className = 'btn btn-ghost'
    openModal('memory-modal')
  }
  async function loadMemoryTab(target, agentId) {
    _memoryTab = target
    const id = agentId || $('memory-modal-title').dataset.agentId
    try {
      const data = await apiGet(`/api/agents/${encodeURIComponent(id)}/memory/${target}`)
      $('memory-text').value = data.text || ''
      $('memory-label').innerHTML =
        `${target === 'memory' ? 'MEMORY.md (我的观察)' : 'USER.md (用户画像)'} — <span id="memory-count">${data.charCount ?? 0}</span> chars`
    } catch (err) {
      toast(String(err), 'error')
    }
  }
  async function saveMemory() {
    const id = $('memory-modal-title').dataset.agentId
    try {
      await apiJson('PUT', `/api/agents/${encodeURIComponent(id)}/memory/${_memoryTab}`, {
        text: $('memory-text').value,
      })
      toast('已保存', 'success')
      closeModal('memory-modal')
    } catch (err) {
      toast(String(err), 'error')
    }
  }
  async function openSkillsModal(agentId) {
    const id = agentId || (getSession()?.agentId ?? state.defaultAgentId)
    const wrap = $('skills-list-wrap')
    wrap.innerHTML = '<p style="color:var(--fg-muted);font-size:var(--text-sm)">加载中...</p>'
    openModal('skills-modal')
    try {
      const data = await apiGet(`/api/agents/${encodeURIComponent(id)}/skills`)
      if (!data.skills || data.skills.length === 0) {
        wrap.innerHTML =
          '<p style="color:var(--fg-muted);font-size:var(--text-sm);margin:0">还没有任何 skill。让 agent 完成一个复杂任务后,它会通过 <code>skill_save</code> MCP 工具自动积累 skill。</p>'
        return
      }
      wrap.innerHTML = ''
      for (const s of data.skills) {
        const row = document.createElement('div')
        row.className = 'agent-row'
        const info = document.createElement('div')
        info.className = 'agent-row-info'
        const title = document.createElement('div')
        title.className = 'agent-row-title'
        title.textContent = s.name
        if (s.tags && s.tags.length > 0) {
          for (const tag of s.tags.slice(0, 3)) {
            const badge = document.createElement('span')
            badge.className = 'badge'
            badge.textContent = tag
            badge.style.marginLeft = '6px'
            title.appendChild(badge)
          }
        }
        const sub = document.createElement('div')
        sub.className = 'agent-row-sub'
        sub.style.whiteSpace = 'normal'
        sub.style.fontFamily = 'var(--font-sans)'
        sub.style.fontSize = 'var(--text-sm)'
        sub.textContent = s.description
        info.appendChild(title)
        info.appendChild(sub)
        const delBtn = document.createElement('button')
        delBtn.className = 'btn btn-ghost'
        delBtn.style.padding = '6px 14px'
        delBtn.style.minHeight = '36px'
        delBtn.style.fontSize = 'var(--text-sm)'
        delBtn.textContent = '删除'
        delBtn.onclick = async () => {
          if (!confirm(`删除 skill "${s.name}"?`)) return
          try {
            await apiJson(
              'DELETE',
              `/api/agents/${encodeURIComponent(id)}/skills/${encodeURIComponent(s.name)}`,
            )
            toast('已删除')
            await openSkillsModal(id)
          } catch (err) {
            toast(String(err), 'error')
          }
        }
        row.appendChild(info)
        row.appendChild(delBtn)
        wrap.appendChild(row)
      }
    } catch (err) {
      wrap.innerHTML = `<p style="color:var(--danger)">加载失败: ${htmlSafeEscape(String(err))}</p>`
    }
  }

  // ═══════════════ SCHEDULED TASKS ═══════════════
  function _cronHuman(cron) {
    const p = (cron || '').split(/\s+/)
    if (p.length < 5) return cron
    const [min, hr, dom, mon, dow] = p
    const dayNames = ['日', '一', '二', '三', '四', '五', '六']
    let s = ''
    if (dom !== '*' && mon !== '*') s += `${mon}月${dom}日 `
    else if (dow !== '*') {
      const days = dow.split(',').map((d) => dayNames[+d] || d)
      s += `每周${days.join(',')} `
    } else if (dom !== '*') s += `每月${dom}日 `
    else s += '每天 '
    if (hr !== '*' && min !== '*') s += `${hr.padStart(2, '0')}:${min.padStart(2, '0')}`
    else if (hr !== '*') s += `${hr}:00`
    else if (min !== '*') s += `每小时第${min}分`
    else s += '每分钟'
    return s
  }

  async function openTasksModal() {
    const list = $('tasks-list')
    const empty = $('tasks-empty')
    list.innerHTML = ''
    empty.style.display = 'block'
    openModal('tasks-modal')
    try {
      const data = await apiGet('/api/cron')
      const jobs = data.jobs || []
      if (jobs.length === 0) {
        empty.style.display = 'block'
        return
      }
      empty.style.display = 'none'
      for (const job of jobs) {
        const row = document.createElement('div')
        row.className = 'agent-row'
        row.style.gap = '8px'
        const info = document.createElement('div')
        info.className = 'agent-row-info'
        info.style.flex = '1'
        const title = document.createElement('div')
        title.className = 'agent-row-title'
        title.style.fontSize = '13px'
        title.textContent = job.label || job.id
        if (job.oneshot) {
          const badge = document.createElement('span')
          badge.className = 'badge'
          badge.textContent = '一次性'
          badge.style.marginLeft = '6px'
          title.appendChild(badge)
        }
        const sub = document.createElement('div')
        sub.className = 'agent-row-sub'
        sub.style.fontSize = '12px'
        const schedText = _cronHuman(job.schedule)
        const nextText = job.nextRunAt ? ` · 下次: ${new Date(job.nextRunAt).toLocaleString()}` : ''
        sub.textContent = `${schedText}${nextText} · agent: ${job.agent}`
        info.appendChild(title)
        info.appendChild(sub)
        // Enable/disable toggle
        const toggle = document.createElement('button')
        toggle.className = 'btn btn-ghost'
        toggle.style.cssText = 'padding:4px 10px;min-height:28px;font-size:12px'
        toggle.textContent = job.enabled !== false ? '暂停' : '启用'
        toggle.onclick = async () => {
          try {
            await apiJson('PUT', `/api/cron/${encodeURIComponent(job.id)}`, {
              enabled: job.enabled === false,
            })
            await openTasksModal()
          } catch (err) {
            toast(String(err), 'error')
          }
        }
        // Delete button
        const del = document.createElement('button')
        del.className = 'btn btn-ghost'
        del.style.cssText = 'padding:4px 10px;min-height:28px;font-size:12px;color:var(--danger)'
        del.textContent = '删除'
        del.onclick = async () => {
          if (!confirm(`删除任务 "${job.label || job.id}"?`)) return
          try {
            await apiJson('DELETE', `/api/cron/${encodeURIComponent(job.id)}`)
            toast('已删除')
            await openTasksModal()
          } catch (err) {
            toast(String(err), 'error')
          }
        }
        row.appendChild(info)
        row.appendChild(toggle)
        row.appendChild(del)
        list.appendChild(row)
      }
    } catch (err) {
      list.innerHTML = `<p style="color:var(--danger)">加载失败: ${htmlSafeEscape(String(err))}</p>`
    }
  }

  // Tab switching for tasks modal
  let _currentTasksTab = 'cron'
  function switchTasksTab(tab) {
    _currentTasksTab = tab
    for (const t of ['cron', 'bg', 'log']) {
      const panel = $(`tasks-panel-${t}`)
      const btn = $(`tasks-tab-${t}`)
      if (panel) panel.hidden = t !== tab
      if (btn) btn.className = t === tab ? 'btn btn-secondary' : 'btn btn-ghost'
    }
    if (tab === 'bg') loadBgTasks()
    if (tab === 'log') loadExecLog()
  }
  for (const btn of document.querySelectorAll('[data-tasks-tab]')) {
    btn.addEventListener('click', () => switchTasksTab(btn.dataset.tasksTab))
  }

  async function loadBgTasks() {
    const list = $('bg-tasks-list')
    const empty = $('bg-tasks-empty')
    if (!list) return
    list.innerHTML = ''
    try {
      const data = await apiGet('/api/tasks')
      const tasks = data.tasks || []
      empty.style.display = tasks.length === 0 ? 'block' : 'none'
      for (const t of tasks) {
        const row = document.createElement('div')
        row.className = 'agent-row'
        row.style.gap = '8px'
        const info = document.createElement('div')
        info.className = 'agent-row-info'
        info.style.flex = '1'
        const title = document.createElement('div')
        title.className = 'agent-row-title'
        title.style.fontSize = '13px'
        title.textContent = t.title || t.id
        const statusBadge = document.createElement('span')
        statusBadge.className = 'badge'
        statusBadge.style.marginLeft = '6px'
        statusBadge.textContent = t.status
        title.appendChild(statusBadge)
        const sub = document.createElement('div')
        sub.className = 'agent-row-sub'
        sub.style.fontSize = '12px'
        const parts = [`${t.trigger} · agent: ${t.agent} · runs: ${t.runCount}`]
        if (t.lastRunAt) parts.push(`last: ${new Date(t.lastRunAt).toLocaleString()}`)
        sub.textContent = parts.join(' · ')
        info.appendChild(title)
        info.appendChild(sub)
        const runBtn = document.createElement('button')
        runBtn.className = 'btn btn-ghost'
        runBtn.style.cssText = 'padding:4px 10px;min-height:28px;font-size:12px'
        runBtn.textContent = '执行'
        runBtn.onclick = async () => {
          try {
            await apiJson('POST', `/api/tasks/${encodeURIComponent(t.id)}`)
            toast('任务已触发')
          } catch (err) {
            toast(String(err), 'error')
          }
        }
        const del = document.createElement('button')
        del.className = 'btn btn-ghost'
        del.style.cssText = 'padding:4px 10px;min-height:28px;font-size:12px;color:var(--danger)'
        del.textContent = '删除'
        del.onclick = async () => {
          if (!confirm(`删除任务 "${t.title}"?`)) return
          try {
            await apiJson('DELETE', `/api/tasks/${encodeURIComponent(t.id)}`)
            toast('已删除')
            await loadBgTasks()
          } catch (err) {
            toast(String(err), 'error')
          }
        }
        row.appendChild(info)
        row.appendChild(runBtn)
        row.appendChild(del)
        list.appendChild(row)
      }
    } catch (err) {
      list.innerHTML = `<p style="color:var(--danger)">加载失败: ${htmlSafeEscape(String(err))}</p>`
    }
  }

  async function loadExecLog() {
    const list = $('exec-log-list')
    const empty = $('exec-log-empty')
    if (!list) return
    list.innerHTML = ''
    try {
      const data = await apiGet('/api/tasks-executions')
      const execs = (data.executions || []).reverse() // newest first
      empty.style.display = execs.length === 0 ? 'block' : 'none'
      for (const ex of execs.slice(0, 30)) {
        const row = document.createElement('div')
        row.style.cssText =
          'display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px'
        const statusIcon = ex.status === 'completed' ? '✅' : ex.status === 'failed' ? '❌' : '⏳'
        const time = new Date(ex.startedAt).toLocaleString()
        const duration = ex.completedAt
          ? `${((ex.completedAt - ex.startedAt) / 1000).toFixed(1)}s`
          : '...'
        row.innerHTML = `<span>${statusIcon}</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${htmlSafeEscape(ex.taskId)}</span><span style="color:var(--text-secondary)">${time} · ${duration}</span>`
        if (ex.error) {
          row.title = `Error: ${ex.error}`
          row.style.color = 'var(--danger)'
        }
        list.appendChild(row)
      }
    } catch (err) {
      list.innerHTML = `<p style="color:var(--danger)">加载失败: ${htmlSafeEscape(String(err))}</p>`
    }
  }

  // Wire up add-task modal
  $('tasks-add-btn')?.addEventListener('click', () => {
    $('task-message').value = ''
    $('task-cron').value = ''
    $('task-oneshot').checked = true
    openModal('add-task-modal')
  })
  $('task-save-btn')?.addEventListener('click', async () => {
    const message = $('task-message').value.trim()
    const cron = $('task-cron').value.trim()
    if (!message || !cron) {
      toast('请填写提醒内容和 cron 表达式', 'error')
      return
    }
    try {
      await apiJson('POST', '/api/cron', {
        schedule: cron,
        prompt: `请直接输出以下提醒内容,不要添加任何额外文字:\n\n⏰ 提醒: ${message}`,
        deliver: 'webchat',
        oneshot: $('task-oneshot').checked,
        label: message,
      })
      toast('提醒已创建', 'success')
      closeModal('add-task-modal')
      await openTasksModal()
    } catch (err) {
      toast(String(err), 'error')
    }
  })

  // ═══════════════ AGENTS ═══════════════
  async function reloadAgents() {
    try {
      const data = await apiGet('/api/agents')
      state.agentsList = data.agents || []
      state.defaultAgentId = data.default || 'main'
      renderAgentDropdown()
      renderAgentsManagementList()
    } catch (err) {
      console.warn('load agents failed:', err)
    }
  }
  function renderAgentDropdown() {
    const sel = $('agent-select')
    if (!sel) return
    sel.innerHTML = ''
    for (const a of state.agentsList) {
      const opt = document.createElement('option')
      opt.value = a.id
      opt.textContent = a.id + (a.id === state.defaultAgentId ? ' (default)' : '')
      sel.appendChild(opt)
    }
    const sess = getSession()
    if (sess) sel.value = sess.agentId || state.defaultAgentId
  }
  function renderAgentsManagementList() {
    const wrap = $('agents-list-wrap')
    if (!wrap) return
    wrap.innerHTML = ''
    if (state.agentsList.length === 0) {
      wrap.innerHTML =
        '<p style="color:var(--fg-muted);font-size:var(--text-sm);margin:0">没有 agents</p>'
      return
    }
    for (const a of state.agentsList) {
      const row = document.createElement('div')
      row.className = 'agent-row'
      const info = document.createElement('div')
      info.className = 'agent-row-info'
      const title = document.createElement('div')
      title.className = 'agent-row-title'
      title.textContent = (a.avatarEmoji ? `${a.avatarEmoji} ` : '') + (a.displayName || a.id)
      if (a.id === state.defaultAgentId) {
        const badge = document.createElement('span')
        badge.className = 'badge'
        badge.textContent = 'default'
        title.appendChild(badge)
      }
      const sub = document.createElement('div')
      sub.className = 'agent-row-sub'
      sub.textContent = a.model || '—'
      info.appendChild(title)
      info.appendChild(sub)
      const editBtn = document.createElement('button')
      editBtn.className = 'btn btn-secondary'
      editBtn.style.padding = '8px 16px'
      editBtn.style.minHeight = '38px'
      editBtn.style.fontSize = 'var(--text-sm)'
      editBtn.textContent = '编辑'
      editBtn.onclick = () => openPersonaEditor(a.id)
      row.appendChild(info)
      row.appendChild(editBtn)
      wrap.appendChild(row)
    }
  }
  async function openPersonaEditor(agentId) {
    try {
      const [info, persona] = await Promise.all([
        apiGet(`/api/agents/${encodeURIComponent(agentId)}`),
        apiGet(`/api/agents/${encodeURIComponent(agentId)}/persona`),
      ])
      $('persona-modal-title').textContent = `编辑: ${info.agent.displayName || agentId}`
      $('persona-display-name').value = info.agent.displayName || ''
      $('persona-avatar-emoji').value = info.agent.avatarEmoji || ''
      $('persona-greeting').value = info.agent.greeting || ''
      $('persona-model').value = info.agent.model || ''
      // Sync preset dropdown
      const preset = $('persona-model-preset')
      const modelVal = info.agent.model || ''
      preset.value = [...preset.options].some((o) => o.value === modelVal) ? modelVal : ''
      $('persona-provider').value = info.agent.provider || ''
      $('persona-permission').value = info.agent.permissionMode || 'default'
      $('persona-cwd').value = info.agent.cwd || ''
      $('persona-toolsets').value = (info.agent.toolsets || []).join(', ')
      $('persona-text').value = persona.text || ''
      const delBtn = $('delete-agent-btn')
      delBtn.disabled = agentId === state.defaultAgentId
      delBtn.style.display = agentId === state.defaultAgentId ? 'none' : ''
      delBtn.onclick = async () => {
        if (!confirm(`删除 agent "${agentId}"?`)) return
        try {
          await apiJson('DELETE', `/api/agents/${encodeURIComponent(agentId)}`)
          toast('agent 已删除', 'success')
          closeModal('persona-modal')
          await reloadAgents()
        } catch (err) {
          toast(String(err), 'error')
        }
      }
      $('save-persona-btn').onclick = async () => {
        try {
          await apiJson('PUT', `/api/agents/${encodeURIComponent(agentId)}`, {
            model: $('persona-model').value.trim(),
            permissionMode: $('persona-permission').value,
            provider: $('persona-provider').value || undefined,
            displayName: $('persona-display-name').value.trim() || undefined,
            avatarEmoji: $('persona-avatar-emoji').value.trim() || undefined,
            greeting: $('persona-greeting').value.trim() || undefined,
            cwd: $('persona-cwd').value.trim() || undefined,
            toolsets: $('persona-toolsets').value.trim()
              ? $('persona-toolsets')
                  .value.split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
              : undefined,
          })
          await apiJson('PUT', `/api/agents/${encodeURIComponent(agentId)}/persona`, {
            text: $('persona-text').value,
          })
          toast('已保存', 'success')
          closeModal('persona-modal')
          await reloadAgents()
        } catch (err) {
          toast(String(err), 'error')
        }
      }
      openModal('persona-modal')
    } catch (err) {
      toast(String(err), 'error')
    }
  }

  // ═══════════════ SESSIONS ═══════════════
  function getSession(id) {
    return state.sessions.get(id || state.currentSessionId)
  }
  function createSession(agentId) {
    const id = uuid()
    const s = {
      id,
      title: '新会话',
      createdAt: Date.now(),
      lastAt: Date.now(),
      messages: [],
      agentId: agentId || state.defaultAgentId,
    }
    state.sessions.set(id, s)
    state.currentSessionId = id
    scheduleSave(s)
    return s
  }
  function switchSession(id) {
    if (!state.sessions.has(id)) return
    // Save sending state on old session, restore from new
    const oldSess = getSession()
    if (oldSess) oldSess._sendingInFlight = state.sendingInFlight
    state.currentSessionId = id
    const newSess = getSession()
    state.sendingInFlight = newSess?._sendingInFlight || false
    updateSendEnabled()
    if (state.sendingInFlight) showTypingIndicator()
    else hideTypingIndicator()
    renderSidebar()
    renderMessages()
    renderAgentDropdown()
    $('sidebar').classList.remove('open')
    $('sidebar-backdrop').classList.remove('open')
  }
  async function deleteSession(id) {
    state.sessions.delete(id)
    try {
      await dbDelete(id)
    } catch {}
    if (state.currentSessionId === id) {
      const arr = [...state.sessions.values()].sort((a, b) => b.lastAt - a.lastAt)
      if (arr.length > 0) state.currentSessionId = arr[0].id
      else createSession()
      renderMessages()
    }
    renderSidebar()
  }
  const _saveTimers = new Map()
  // Search index: build a single lowercase string per session covering message text.
  // Fills from newest messages first so recent topics are always searchable,
  // then appends older messages until the 50K char budget is exhausted.
  const _SEARCH_INDEX_CAP = 50000
  function _rebuildSearchIndex(sess) {
    if (!sess) return
    const title = (sess.title || '').toLowerCase()
    let len = title.length
    const msgs = sess.messages || []
    const parts = []
    // Pass 1: newest → oldest (guarantees recent content is indexed)
    for (let i = msgs.length - 1; i >= 0 && len < _SEARCH_INDEX_CAP; i--) {
      const m = msgs[i]
      if (m.role !== 'user' && m.role !== 'assistant') continue
      const t = (m.text || '').toLowerCase()
      const remaining = _SEARCH_INDEX_CAP - len
      parts.push(remaining >= t.length ? t : t.slice(0, remaining))
      len += Math.min(t.length, remaining)
    }
    // Reverse so the concatenated string is still chronological (nice-to-have, not critical)
    parts.reverse()
    sess._searchText = `${title} ${parts.join(' ')}`
  }

  function scheduleSave(s) {
    const sess = s || getSession()
    if (!sess) return
    _rebuildSearchIndex(sess)
    const prev = _saveTimers.get(sess.id)
    if (prev) clearTimeout(prev)
    const t = setTimeout(async () => {
      _saveTimers.delete(sess.id)
      const { _streamingAssistant, _streamingThinking, _blockIdToMsgId, ...persist } = sess
      try {
        await dbPut(persist)
      } catch (e) {
        console.warn('dbPut', e)
      }
    }, 400)
    _saveTimers.set(sess.id, t)
  }

  // ═══════════════ RENDERING ═══════════════
  function ensureInner() {
    let inner = document.querySelector('.messages-inner')
    if (!inner) {
      inner = document.createElement('div')
      inner.className = 'messages-inner'
      $('messages').appendChild(inner)
    }
    return inner
  }
  function isAtBottom() {
    const m = $('messages')
    return m.scrollHeight - m.scrollTop - m.clientHeight < 120
  }
  // Track whether user has manually scrolled up during streaming — if so, don't auto-scroll
  let _userScrolledUp = false
  let _scrollDebounce = null
  $('messages')?.addEventListener('wheel', () => {
    if (state.sendingInFlight) {
      _userScrolledUp = !isAtBottom()
      // Reset after 3s of no manual scroll — user probably wants to follow again
      clearTimeout(_scrollDebounce)
      _scrollDebounce = setTimeout(() => {
        _userScrolledUp = false
      }, 3000)
    }
  })

  function scrollBottom(force) {
    const m = $('messages')
    // During streaming: always scroll unless user explicitly scrolled up
    if (force || (state.sendingInFlight && !_userScrolledUp) || isAtBottom()) {
      m.scrollTop = m.scrollHeight
    }
  }
  function _buildMessageEl(msg) {
    const el = document.createElement('div')
    el.className = `msg ${msg.role}`
    if (msg.error) el.classList.add('error')
    el.dataset.msgId = msg.id
    if (msg.role === 'assistant') {
      if (msg.cronPush) {
        el.classList.add('cron-push')
      }
      const avatar = document.createElement('div')
      avatar.className = 'avatar'
      // Use agent persona emoji if available, fallback to 'O'
      const agentInfo = state.agentsList.find(
        (a) => a.id === (getSession()?.agentId || state.defaultAgentId),
      )
      avatar.textContent = agentInfo?.avatarEmoji || 'O'
      el.appendChild(avatar)
      // Cron push badge — visually marks system-generated messages
      if (msg.cronPush) {
        const badge = document.createElement('div')
        badge.className = 'cron-push-badge'
        badge.textContent = `📋 ${msg.cronLabel || '定时任务'}`
        el.appendChild(badge)
      }
      const body = document.createElement('div')
      body.className = 'msg-body'
      body.innerHTML = renderMarkdown(msg.text || '')
      el.appendChild(body)
      // ── Message action bar ──
      const actions = document.createElement('div')
      actions.className = 'msg-actions'
      actions.innerHTML =
        '<button data-action="copy" title="复制"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>' +
        '<button data-action="regen" title="重新生成"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>' +
        '<button data-action="tts" title="朗读"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg></button>' +
        '<button data-action="del" title="删除"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg></button>'
      actions.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]')
        if (!btn) return
        const action = btn.dataset.action
        const sess = getSession()
        if (!sess) return
        const _svgCopy =
          '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
        const _svgCheck =
          '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
        const _svgVol =
          '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>'
        const _svgStop =
          '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>'
        if (action === 'copy') {
          const _doCopied = () => {
            btn.classList.add('copied')
            btn.innerHTML = _svgCheck
            setTimeout(() => {
              btn.classList.remove('copied')
              btn.innerHTML = _svgCopy
            }, 1500)
          }
          if (navigator.clipboard?.writeText) {
            navigator.clipboard
              .writeText(msg.text || '')
              .then(_doCopied)
              .catch(() => {
                fallbackCopy(msg.text || '')
                _doCopied()
              })
          } else {
            fallbackCopy(msg.text || '')
            _doCopied()
          }
        } else if (action === 'regen') {
          // Find the last user message before this assistant message
          const idx = sess.messages.indexOf(msg)
          if (idx < 0) return
          let lastUserMsg = null
          for (let i = idx - 1; i >= 0; i--) {
            if (sess.messages[i].role === 'user') {
              lastUserMsg = sess.messages[i]
              break
            }
          }
          if (!lastUserMsg) {
            toast('没有找到可重发的用户消息', 'error')
            return
          }
          // Remove messages from this one onwards
          sess.messages.splice(idx)
          renderMessages()
          // Re-send the user message
          sess._sendingInFlight = true
          state.sendingInFlight = true
          updateSendEnabled()
          showTypingIndicator()
          setTitleBusy(true)
          state.ws.send(
            JSON.stringify({
              type: 'inbound.message',
              idempotencyKey: `regen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              channel: 'webchat',
              peer: { id: sess.id, kind: 'dm' },
              agentId: sess.agentId || state.defaultAgentId,
              content: { text: lastUserMsg.text || '' },
              ts: Date.now(),
            }),
          )
          scheduleSave(sess)
        } else if (action === 'tts') {
          // Use Web Speech API for quick read-aloud
          const text = (msg.text || '').replace(/[#*`>_~\[\]()]/g, '').slice(0, 2000)
          if (!text) return
          if (window.speechSynthesis) {
            window.speechSynthesis.cancel()
            const utter = new SpeechSynthesisUtterance(text)
            utter.lang = 'zh-CN'
            utter.rate = 1.1
            window.speechSynthesis.speak(utter)
            btn.innerHTML = _svgStop
            btn.title = '停止朗读'
            utter.onend = () => {
              btn.innerHTML = _svgVol
              btn.title = '朗读'
            }
            btn.onclick = () => {
              window.speechSynthesis.cancel()
              btn.innerHTML = _svgVol
              btn.title = '朗读'
            }
          } else {
            toast('浏览器不支持语音合成', 'error')
          }
        } else if (action === 'del') {
          const idx = sess.messages.indexOf(msg)
          if (idx < 0) return
          // Soft delete with undo toast
          sess.messages.splice(idx, 1)
          el.style.display = 'none'
          const undoToast = document.createElement('div')
          undoToast.className = 'toast show'
          undoToast.innerHTML =
            '消息已删除 <button class="undo-btn" style="margin-left:12px;color:var(--accent);background:none;border:none;cursor:pointer;font-weight:600;text-decoration:underline">撤销</button>'
          document.body.appendChild(undoToast)
          let undone = false
          undoToast.querySelector('.undo-btn').onclick = () => {
            undone = true
            sess.messages.splice(idx, 0, msg)
            el.style.display = ''
            undoToast.remove()
            scheduleSave(sess)
          }
          setTimeout(() => {
            if (!undone) {
              el.remove()
              scheduleSave(sess)
            }
            undoToast.remove()
          }, 4000)
        }
      })
      el.appendChild(actions)
      if (msg.metaText) {
        const meta = document.createElement('div')
        meta.className = 'msg-meta'
        renderMetaInto(meta, msg.metaText)
        el.appendChild(meta)
      }
    } else if (msg.role === 'agent-group') {
      el.className = 'agent-group'
      const svgBot =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="7" width="16" height="12" rx="2"/><line x1="12" y1="3" x2="12" y2="7"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/></svg>'
      const svgChevron =
        '<svg class="agent-group-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>'
      const statusText = msg._completed
        ? msg._isError
          ? '<span class="agent-group-status" style="color:var(--danger)">失败</span>'
          : `<span class="agent-group-status" style="color:var(--success)">完成 (${(msg._duration / 1000).toFixed(1)}s)</span>`
        : '<span class="agent-group-status">运行中...</span>'
      const header = document.createElement('div')
      header.className = 'agent-group-header'
      header.innerHTML = `${svgBot}<span>子任务: ${htmlSafeEscape(msg.text || '')}</span>${statusText}${svgChevron}`
      header.onclick = () => el.classList.toggle('collapsed')
      el.appendChild(header)
      const body = document.createElement('div')
      body.className = 'agent-group-body'
      if (msg._resultPreview) {
        const preview = document.createElement('div')
        preview.className = 'msg tool'
        preview.style.cssText = 'padding:6px 10px;border:none;background:transparent;font-size:12px'
        preview.innerHTML = `<span class="tool-icon">${msg._isError ? '⚠️' : '✓'}</span><div class="tool-body">${htmlSafeEscape(msg._resultPreview)}</div>`
        body.appendChild(preview)
      }
      el.appendChild(body)
    } else if (msg.role === 'tool') {
      const icon = document.createElement('span')
      icon.className = 'tool-icon'
      icon.textContent = msg.toolIcon || '🔧'
      const body = document.createElement('div')
      body.className = 'tool-body'
      body.textContent = msg.text || ''
      el.appendChild(icon)
      el.appendChild(body)
    } else {
      // User messages: render with media URL embedding but XSS-safe
      const body = document.createElement('div')
      body.className = 'msg-body'
      const safeHtml = htmlSafeEscape(msg.text || '').replace(/\n/g, '<br>')
      body.innerHTML = embedMediaUrls(safeHtml)
      el.appendChild(body)
      // Status indicator for user messages
      if (msg.status) {
        const statusEl = document.createElement('div')
        statusEl.className = `msg-status ${msg.status}`
        statusEl.innerHTML = `${_STATUS_SVG[msg.status] || ''}<span>${_STATUS_LABEL[msg.status] || ''}</span>`
        el.appendChild(statusEl)
      }
    }
    return el
  }
  function renderMessage(msg) {
    const main = ensureInner()
    const el = _buildMessageEl(msg)
    main.appendChild(el)
    processRichBlocks()
  }
  function updateMessageEl(msg, streaming) {
    const el = document.querySelector(`[data-msg-id="${msg.id}"]`)
    if (!el) return
    if (msg.role === 'assistant') {
      const body = el.querySelector('.msg-body')
      if (body) {
        if (streaming) {
          // Streaming: lightweight escape + newline → <br>, skip heavy Markdown/Mermaid/Chart
          body.textContent = msg.text || ''
          body.style.whiteSpace = 'pre-wrap'
        } else {
          body.style.whiteSpace = ''
          body.innerHTML = renderMarkdown(msg.text || '')
        }
      }
      if (msg.metaText) {
        let meta = el.querySelector('.msg-meta')
        if (!meta) {
          meta = document.createElement('div')
          meta.className = 'msg-meta'
          el.appendChild(meta)
        }
        renderMetaInto(meta, msg.metaText)
      }
    } else if (msg.role === 'agent-group') {
      // Re-render the whole card (simpler than partial updates)
      el.innerHTML = ''
      el.className = 'agent-group'
      const svgBot =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="7" width="16" height="12" rx="2"/><line x1="12" y1="3" x2="12" y2="7"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/></svg>'
      const svgChevron =
        '<svg class="agent-group-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>'
      const statusText = msg._completed
        ? msg._isError
          ? '<span class="agent-group-status" style="color:var(--danger)">失败</span>'
          : `<span class="agent-group-status" style="color:var(--success)">完成 (${(msg._duration / 1000).toFixed(1)}s)</span>`
        : '<span class="agent-group-status">运行中...</span>'
      const header = document.createElement('div')
      header.className = 'agent-group-header'
      header.innerHTML = `${svgBot}<span>子任务: ${htmlSafeEscape(msg.text || '')}</span>${statusText}${svgChevron}`
      header.onclick = () => el.classList.toggle('collapsed')
      el.appendChild(header)
      if (msg._resultPreview) {
        const body = document.createElement('div')
        body.className = 'agent-group-body'
        const preview = document.createElement('div')
        preview.className = 'msg tool'
        preview.style.cssText = 'padding:6px 10px;border:none;background:transparent;font-size:12px'
        preview.innerHTML = `<span class="tool-icon">${msg._isError ? '⚠️' : '✓'}</span><div class="tool-body">${htmlSafeEscape(msg._resultPreview)}</div>`
        body.appendChild(preview)
        el.appendChild(body)
      }
    } else if (msg.role === 'tool') {
      const body = el.querySelector('.tool-body')
      if (body) body.textContent = msg.text || ''
      el.classList.toggle('error', !!msg.error)
    } else {
      const body = el.querySelector('.msg-body')
      if (body) {
        const safeHtml = htmlSafeEscape(msg.text || '').replace(/\n/g, '<br>')
        body.innerHTML = embedMediaUrls(safeHtml)
      }
    }
    processRichBlocks()
  }
  function renderMetaInto(container, metaText) {
    container.innerHTML = ''
    const parts = (metaText || '').split(' · ')
    for (const p of parts) {
      if (!p) continue
      const span = document.createElement('span')
      span.className = 'msg-meta-item'
      span.textContent = p
      container.appendChild(span)
    }
  }
  function renderMessages() {
    // Cleanup Chart.js instances before DOM wipe
    for (const [id, chart] of _chartInstances) {
      try {
        chart.destroy()
      } catch {}
    }
    _chartInstances.clear()
    const main = $('messages')
    main.innerHTML = ''
    const s = getSession()
    if (!s) {
      $('session-title').textContent = '无会话'
      $('session-sub').textContent = ''
      return
    }
    $('session-title').textContent = s.title
    updateSessionSub(s)
    if (s.messages.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'empty-state'
      const _ai = state.agentsList.find((a) => a.id === (s.agentId || state.defaultAgentId))
      const _name = _ai?.displayName || 'OpenClaude'
      const _av = _ai?.avatarEmoji || 'O'
      empty.innerHTML = `<div class="empty-brand">${_av}</div><h1>${htmlSafeEscape(_name)}</h1><p>你的个人 AI 助理，随时待命</p><div class="hint-kbd">按 <kbd>${_mod}K</kbd> 打开命令面板 · 输入 <kbd>/</kbd> 查看命令</div>`
      main.appendChild(empty)
      return
    }
    const inner = document.createElement('div')
    inner.className = 'messages-inner'
    main.appendChild(inner)
    // Performance: only render last 100 messages; show "load more" for older ones
    const MAX_INITIAL = 100
    const msgs = s.messages
    if (msgs.length > MAX_INITIAL) {
      const LOAD_BATCH = 50
      let _loadedUpTo = msgs.length - MAX_INITIAL // index: messages before this are not yet rendered
      const loadMore = document.createElement('button')
      loadMore.className = 'load-more-btn'
      loadMore.textContent = `加载更早的 ${_loadedUpTo} 条消息`
      const _doLoadMore = () => {
        const batchStart = Math.max(0, _loadedUpTo - LOAD_BATCH)
        const batchEnd = _loadedUpTo
        if (batchStart >= batchEnd) return
        const scrollBefore = main.scrollHeight
        const frag = document.createDocumentFragment()
        for (let i = batchStart; i < batchEnd; i++) {
          const el = _buildMessageEl(msgs[i])
          frag.appendChild(el)
        }
        _loadedUpTo = batchStart
        if (_loadedUpTo > 0) {
          // Still more to load — update button text and keep it
          loadMore.textContent = `加载更早的 ${_loadedUpTo} 条消息`
          loadMore.after(frag)
        } else {
          // All loaded — remove button
          loadMore.replaceWith(frag)
        }
        processRichBlocks()
        main.scrollTop += main.scrollHeight - scrollBefore
      }
      loadMore.onclick = _doLoadMore
      // Auto-load when scrolled to top (IntersectionObserver)
      if (window.IntersectionObserver) {
        const obs = new IntersectionObserver(
          ([entry]) => {
            if (entry.isIntersecting) {
              obs.disconnect()
              _doLoadMore()
            }
          },
          { root: main },
        )
        obs.observe(loadMore)
      }
      inner.appendChild(loadMore)
      for (let i = msgs.length - MAX_INITIAL; i < msgs.length; i++) renderMessage(msgs[i])
    } else {
      for (const m of msgs) renderMessage(m)
    }
    scrollBottom(true)
  }
  function updateSessionSub(s) {
    const el = $('session-sub')
    if (!s) {
      el.textContent = ''
      return
    }
    const n = s.messages.filter((m) => m.role === 'user').length
    el.textContent = (n > 0 ? `${n} 轮 · ` : '') + shortTime(s.lastAt)
  }
  // ── Context menu ──
  let _ctxMenu = null
  function showContextMenu(x, y, items) {
    hideContextMenu()
    const menu = document.createElement('div')
    menu.className = 'ctx-menu'
    for (const it of items) {
      if (it.divider) {
        menu.insertAdjacentHTML('beforeend', '<div class="ctx-divider"></div>')
        continue
      }
      const btn = document.createElement('button')
      btn.className = `ctx-item${it.danger ? ' danger' : ''}`
      btn.textContent = it.label
      btn.onclick = () => {
        hideContextMenu()
        it.run()
      }
      menu.appendChild(btn)
    }
    document.body.appendChild(menu)
    // Position: ensure within viewport
    const rect = menu.getBoundingClientRect()
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8
    menu.style.left = `${Math.max(4, x)}px`
    menu.style.top = `${Math.max(4, y)}px`
    _ctxMenu = menu
    setTimeout(() => document.addEventListener('click', hideContextMenu, { once: true }), 10)
  }
  function hideContextMenu() {
    if (_ctxMenu) {
      _ctxMenu.remove()
      _ctxMenu = null
    }
  }

  // ── Export session as markdown ──
  function exportSessionMd(sess) {
    const lines = [
      `# ${sess.title}`,
      '',
      `> Exported from OpenClaude · ${new Date().toLocaleString()}`,
      '',
    ]
    for (const m of sess.messages) {
      if (m.role === 'user') lines.push('## 👤 User', '', m.text || '', '')
      else if (m.role === 'assistant') lines.push('## 🤖 Assistant', '', m.text || '', '')
      else if (m.role === 'tool') lines.push(`> 🔧 ${m.text || ''}`, '')
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown; charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${(sess.title || 'session').replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_')}.md`
    a.click()
    URL.revokeObjectURL(a.href)
    toast('已导出')
  }

  // ── Inline rename ──
  function startInlineRename(titleEl, sess) {
    const input = document.createElement('input')
    input.className = 'session-rename-input'
    input.value = sess.title
    input.maxLength = 60
    const finish = () => {
      const v = input.value.trim()
      if (v && v !== sess.title) {
        sess.title = v
        scheduleSave(sess)
        if (sess.id === state.currentSessionId) $('session-title').textContent = v
      }
      renderSidebar()
    }
    input.onblur = finish
    input.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        input.blur()
      } else if (e.key === 'Escape') {
        input.value = sess.title
        input.blur()
      }
    }
    titleEl.replaceWith(input)
    input.focus()
    input.select()
  }

  function renderSidebar() {
    const body = $('sessions-body')
    body.innerHTML = ''
    const searchQuery = ($('sidebar-search')?.value || '').trim().toLowerCase()
    const allSessions = [...state.sessions.values()].sort((a, b) => {
      if (a.pinned && !b.pinned) return -1
      if (!a.pinned && b.pinned) return 1
      return b.lastAt - a.lastAt
    })
    // Filter by search query — uses pre-built _searchText index (title + last 10 msgs)
    const sessions = searchQuery
      ? allSessions.filter((s) => (s._searchText || s.title.toLowerCase()).includes(searchQuery))
      : allSessions

    // Pinned group
    const pinned = sessions.filter((s) => s.pinned)
    const unpinned = sessions.filter((s) => !s.pinned)

    if (pinned.length > 0) {
      const label = document.createElement('div')
      label.className = 'sessions-group-label'
      label.textContent = '⭐ 置顶'
      body.appendChild(label)
      for (const s of pinned) body.appendChild(_buildSessionItem(s))
    }

    // Time groups for unpinned
    const groups = new Map()
    for (const s of unpinned) {
      const g = sessionGroup(s.lastAt)
      if (!groups.has(g)) groups.set(g, [])
      groups.get(g).push(s)
    }
    for (const groupName of GROUP_ORDER) {
      const items = groups.get(groupName)
      if (!items || items.length === 0) continue
      const label = document.createElement('div')
      label.className = 'sessions-group-label'
      label.textContent = groupName
      body.appendChild(label)
      for (const s of items) body.appendChild(_buildSessionItem(s))
    }
  }

  function _buildSessionItem(s) {
    const item = document.createElement('div')
    item.className = `session-item${s.id === state.currentSessionId ? ' active' : ''}${s.pinned ? ' pinned' : ''}`
    item.setAttribute('role', 'option')
    item.setAttribute('aria-selected', s.id === state.currentSessionId ? 'true' : 'false')
    item.setAttribute('tabindex', '0')
    item.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        switchSession(s.id)
      }
    }
    const title = document.createElement('div')
    title.className = 'session-item-title'
    title.textContent = (s.pinned ? '⭐ ' : '') + s.title
    // Double-click to rename
    title.ondblclick = (e) => {
      e.stopPropagation()
      startInlineRename(title, s)
    }

    const del = document.createElement('button')
    del.className = 'session-item-delete'
    del.title = '删除'
    del.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>'
    del.onclick = async (e) => {
      e.stopPropagation()
      if (!confirm(`删除会话 "${s.title}"?`)) return
      await deleteSession(s.id)
    }

    item.appendChild(title)
    item.appendChild(del)
    item.onclick = () => switchSession(s.id)

    // Right-click context menu
    item.oncontextmenu = (e) => {
      e.preventDefault()
      e.stopPropagation()
      showContextMenu(e.clientX, e.clientY, [
        {
          label: '重命名',
          run: () => {
            switchSession(s.id)
            setTimeout(() => {
              const t = body.querySelector('.session-item.active .session-item-title')
              if (t) startInlineRename(t, s)
            }, 50)
          },
        },
        {
          label: s.pinned ? '取消置顶' : '置顶',
          run: () => {
            s.pinned = !s.pinned
            scheduleSave(s)
            renderSidebar()
          },
        },
        { label: '导出 Markdown', run: () => exportSessionMd(s) },
        { divider: true },
        {
          label: '删除',
          danger: true,
          run: async () => {
            if (!confirm(`删除会话 "${s.title}"?`)) return
            await deleteSession(s.id)
          },
        },
      ])
    }

    // Mobile long-press
    let _lpt = null
    item.ontouchstart = (e) => {
      _lpt = setTimeout(() => {
        const touch = e.touches[0]
        showContextMenu(touch.clientX, touch.clientY, [
          { label: '重命名', run: () => startInlineRename(title, s) },
          {
            label: s.pinned ? '取消置顶' : '置顶',
            run: () => {
              s.pinned = !s.pinned
              scheduleSave(s)
              renderSidebar()
            },
          },
          { label: '导出 Markdown', run: () => exportSessionMd(s) },
          { divider: true },
          {
            label: '删除',
            danger: true,
            run: async () => {
              if (!confirm('删除?')) return
              await deleteSession(s.id)
            },
          },
        ])
      }, 600)
    }
    item.ontouchend = () => clearTimeout(_lpt)
    item.ontouchmove = () => clearTimeout(_lpt)

    return item
  }

  // ═══════════════ TYPING INDICATOR ═══════════════
  function showTypingIndicator() {
    const inner = ensureInner()
    if (inner.querySelector('.typing-indicator')) return
    const el = document.createElement('div')
    el.className = 'typing-indicator'
    el.id = '__typing'
    const sess = getSession()
    const agentInfo = state.agentsList.find((a) => a.id === (sess?.agentId || state.defaultAgentId))
    const av = agentInfo?.avatarEmoji || 'O'
    const name = agentInfo?.displayName || sess?.agentId || 'AI'
    el.innerHTML = `<div class="avatar">${av}</div><div class="typing-dots"><span></span><span></span><span></span></div><span class="typing-label">${htmlSafeEscape(name)} 思考中</span>`
    el._startTime = Date.now()
    // Show elapsed time after 5s
    el._timer = setInterval(() => {
      const secs = Math.round((Date.now() - el._startTime) / 1000)
      const label = el.querySelector('.typing-label')
      if (label && secs >= 5) label.textContent = `${name} 思考中 (${secs}s)`
    }, 1000)
    inner.appendChild(el)
    scrollBottom(true)
  }
  function hideTypingIndicator() {
    const el = document.getElementById('__typing')
    if (el?._timer) clearInterval(el._timer)
    el?.remove()
  }

  // ═══════════════ MESSAGES ═══════════════
  function addMessage(sess, role, text, extra) {
    extra = extra || {}
    const msg = Object.assign({ id: msgId(), role, text: text || '', ts: Date.now() }, extra)
    sess.messages.push(msg)
    sess.lastAt = Date.now()
    if (role === 'user') {
      const userCount = sess.messages.filter((m) => m.role === 'user').length
      if (userCount === 1) {
        sess.title = (text || '').slice(0, 50) + ((text || '').length > 50 ? '…' : '')
        if (sess.id === state.currentSessionId) $('session-title').textContent = sess.title
      }
    }
    if (sess.id === state.currentSessionId) {
      renderMessage(msg)
      scrollBottom(role === 'user')
    }
    return msg
  }
  function updateMessage(sess, msg, newText, streaming) {
    msg.text = newText
    if (sess.id === state.currentSessionId) {
      updateMessageEl(msg, streaming)
      scrollBottom()
    }
  }
  function setMeta(sess, msg, metaText) {
    msg.metaText = metaText
    if (sess.id === state.currentSessionId) updateMessageEl(msg)
  }

  // ── Message status rendering ──
  const _STATUS_SVG = {
    sending:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10" stroke-dasharray="20" stroke-dashoffset="10"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></circle></svg>',
    queued:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    sent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>',
    read: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 6 7 17 2 12"/><polyline points="22 6 11 17 8 14"/></svg>',
    replied:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 6 7 17 2 12"/><polyline points="22 6 11 17 8 14"/></svg>',
  }
  const _STATUS_LABEL = {
    sending: '发送中',
    queued: '排队中',
    sent: '已发送',
    read: '已读',
    replied: '已回复',
  }

  function updateMsgStatus(msg) {
    if (msg.role !== 'user' || !msg.status) return
    const el = document.querySelector(`[data-msg-id="${msg.id}"]`)
    if (!el) return
    let statusEl = el.querySelector('.msg-status')
    if (!statusEl) {
      statusEl = document.createElement('div')
      statusEl.className = 'msg-status'
      el.appendChild(statusEl)
    }
    statusEl.className = `msg-status ${msg.status || ''}`
    statusEl.innerHTML = `${_STATUS_SVG[msg.status] || ''}<span>${_STATUS_LABEL[msg.status] || ''}</span>`
  }

  // ═══════════════ WEBSOCKET ═══════════════
  function setStatus(label, klass) {
    state.wsStatus = klass
    const el = $('status')
    if (!el) return
    el.className = `status-pill ${klass}`
    $('status-text').textContent = label
    updateSendEnabled()
  }
  function updateSendEnabled() {
    const btn = $('send')
    const svg = btn.querySelector('svg')
    if (state.wsStatus !== 'connected') {
      btn.disabled = true
      btn.classList.remove('stopping')
      if (svg)
        svg.innerHTML = '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>'
      return
    }
    if (state.sendingInFlight) {
      btn.disabled = false
      btn.classList.add('stopping')
      if (svg) svg.innerHTML = '<rect x="6" y="6" width="12" height="12" rx="1"/>'
    } else {
      btn.disabled = false
      btn.classList.remove('stopping')
      if (svg)
        svg.innerHTML = '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>'
    }
  }
  function stopCurrentTurn() {
    if (!state.sendingInFlight) return
    if (!state.ws || state.ws.readyState !== 1) return
    const sess = getSession()
    if (!sess) return
    state.ws.send(
      JSON.stringify({
        type: 'inbound.control.stop',
        channel: 'webchat',
        peer: { id: sess.id, kind: 'dm' },
        agentId: sess.agentId || state.defaultAgentId,
      }),
    )
    toast('已发送停止指令')
  }
  function connect() {
    if (state.ws && state.ws.readyState < 2) return
    setStatus('connecting…', 'connecting')
    // Use Sec-WebSocket-Protocol for auth instead of query string (avoids token in URL/logs)
    const url = `${(location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host}/ws`
    const ws = new WebSocket(url, ['bearer', state.token])
    state.ws = ws
    ws.onopen = () => {
      setStatus('connected', 'connected')
      // Flush offline queue — send one at a time to avoid interleaving responses
      if (state.offlineQueue.length > 0) {
        const queue = [...state.offlineQueue]
        state.offlineQueue = []
        // Send only the first queued message now; rest will be sent after each response completes
        const sendNext = () => {
          if (queue.length === 0) return
          const item = queue.shift()
          try {
            ws.send(JSON.stringify(item.payload))
            const sess = state.sessions.get(item.sessId)
            if (sess) {
              const msg = sess.messages.find((m) => m.id === item.msgId)
              if (msg) {
                msg.status = 'sent'
                updateMsgStatus(msg)
              }
            }
          } catch {}
          // Queue the next message to send after current response finishes (isFinal)
          if (queue.length > 0) {
            const _origHandler = ws.onmessage
            const _waitFinal = (ev) => {
              try {
                const f = JSON.parse(ev.data)
                if (f.type === 'outbound.message' && f.isFinal) {
                  ws.onmessage = _origHandler
                  setTimeout(sendNext, 500)
                }
              } catch {}
              if (_origHandler) _origHandler(ev)
            }
            ws.onmessage = _waitFinal
          }
        }
        sendNext()
        if (queue.length >= 0) {
          toast(`${queue.length} 条离线消息已发送`)
          // Mark the first queued item's session as sending
          const firstItem = queue[0] || item
          const qSess = firstItem ? state.sessions.get(firstItem.sessId) : null
          if (qSess) qSess._sendingInFlight = true
          // Only update global UI if queued session is currently visible
          if (qSess && qSess.id === state.currentSessionId) {
            state.sendingInFlight = true
            updateSendEnabled()
            showTypingIndicator()
            setTitleBusy(true)
          }
        }
      }
    }
    // Client-side keepalive: prevent mobile browser from killing WS during long tasks
    const _wsKeepAlive = setInterval(() => {
      if (ws.readyState === 1)
        try {
          ws.send('{"type":"ping"}')
        } catch {}
    }, 30000)

    ws.onclose = (e) => {
      clearInterval(_wsKeepAlive)
      setStatus('disconnected', 'disconnected')
      // Clear all sessions' sending state on disconnect
      for (const [, s] of state.sessions) s._sendingInFlight = false
      state.sendingInFlight = false
      updateSendEnabled()
      hideTypingIndicator()
      if (e.code === 1008) {
        localStorage.removeItem('openclaude_token')
        state.token = ''
        showLogin()
        return
      }
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer)
      state.reconnectTimer = setTimeout(connect, 2000)
    }
    ws.onerror = () => {}
    ws.onmessage = (ev) => {
      try {
        const f = JSON.parse(ev.data)
        if (f.type === 'outbound.message') handleOutbound(f)
      } catch {}
    }
  }
  function formatMeta(m) {
    if (!m) return ''
    const parts = []
    if (typeof m.cost === 'number') parts.push(`$${m.cost.toFixed(4)}`)
    if (typeof m.totalCost === 'number' && m.totalCost !== m.cost)
      parts.push(`total $${m.totalCost.toFixed(4)}`)
    if (typeof m.inputTokens === 'number') parts.push(`in ${m.inputTokens}`)
    if (typeof m.outputTokens === 'number') parts.push(`out ${m.outputTokens}`)
    if (m.cacheReadTokens > 0) parts.push(`cache-r ${m.cacheReadTokens}`)
    if (m.cacheCreationTokens > 0) parts.push(`cache-w ${m.cacheCreationTokens}`)
    if (typeof m.turn === 'number') parts.push(`T${m.turn}`)
    return parts.join(' · ')
  }
  function buildToolUseLabel(block) {
    const name = block.toolName || 'unknown'
    const preview = (block.inputPreview || '').trim()
    const ellipsis = block.partial && preview ? ' …' : ''
    const body = preview ? `  ${preview}${ellipsis}` : block.partial ? '  …' : ''
    return name + body
  }
  function handleOutbound(frame) {
    // Permission requests are a special channel — they don't belong to any
    // chat session, they pop a modal for the user to answer.
    if (frame.permissionRequest) {
      enqueuePermission(frame)
      return
    }
    const peerId = frame.peer?.id
    let sess = state.sessions.get(peerId)
    // If session not found (e.g. proactive push from cron/reminder), show in current active session
    if (!sess) {
      sess = getSession()
      if (!sess) return
    }
    if (!sess._blockIdToMsgId) sess._blockIdToMsgId = new Map()
    // Any output → hide typing indicator ONLY if this is the currently viewed session
    if (((frame.blocks?.length || 0) > 0 || frame.isFinal) && sess.id === state.currentSessionId)
      hideTypingIndicator()
    // Update last user message status: first block = "read", isFinal = "replied"
    const _lastUserMsg = [...sess.messages]
      .reverse()
      .find((m) => m.role === 'user' && m.status && m.status !== 'replied')
    if (_lastUserMsg) {
      if (
        frame.blocks?.length > 0 &&
        _lastUserMsg.status !== 'read' &&
        _lastUserMsg.status !== 'replied'
      ) {
        _lastUserMsg.status = 'read'
        updateMsgStatus(_lastUserMsg)
      }
      if (frame.isFinal) {
        _lastUserMsg.status = 'replied'
        updateMsgStatus(_lastUserMsg)
      }
    }
    // Detect non-heartbeat cron/task push — mark as system notification
    const isCronPush = frame.cronJob && !frame.cronJob.heartbeat

    for (const block of frame.blocks || []) {
      if (block.kind === 'text') {
        sess._streamingThinking = null
        if (!sess._streamingAssistant) {
          sess._streamingAssistant = addMessage(
            sess,
            'assistant',
            '',
            isCronPush ? { cronPush: true, cronLabel: frame.cronJob?.label } : {},
          )
        }
        sess._streamingAssistant.text += block.text
        _checkTaskNotifications(block.text)
        // Throttled render: batch streaming updates via rAF instead of per-delta
        if (!sess._streamRafPending) {
          sess._streamRafPending = true
          requestAnimationFrame(() => {
            sess._streamRafPending = false
            if (sess._streamingAssistant) {
              updateMessage(sess, sess._streamingAssistant, sess._streamingAssistant.text, true)
              scrollBottom()
            }
          })
        }
      } else if (block.kind === 'thinking') {
        if (!sess._streamingThinking) sess._streamingThinking = addMessage(sess, 'thinking', '')
        sess._streamingThinking.text += block.text
        if (!sess._thinkRafPending) {
          sess._thinkRafPending = true
          requestAnimationFrame(() => {
            sess._thinkRafPending = false
            if (sess._streamingThinking) {
              updateMessage(sess, sess._streamingThinking, sess._streamingThinking.text, true)
              scrollBottom()
            }
          })
        }
      } else if (block.kind === 'tool_use') {
        sess._streamingAssistant = null
        sess._streamingThinking = null
        const isAgent = /^Agent$/i.test(block.toolName || '')
        const label = buildToolUseLabel(block)

        if (isAgent) {
          // Sub-agent: create a collapsible group card
          if (!sess._agentGroups) sess._agentGroups = new Map()
          if (block.blockId && !sess._agentGroups.has(block.blockId)) {
            const desc = (block.inputPreview || '').replace(/[{}"]/g, '').slice(0, 80) || '子任务'
            const groupMsg = addMessage(sess, 'agent-group', desc, {
              blockId: block.blockId,
              toolName: 'Agent',
              startTime: Date.now(),
              childBlocks: [],
            })
            sess._agentGroups.set(block.blockId, groupMsg.id)
            if (block.blockId) sess._blockIdToMsgId.set(block.blockId, groupMsg.id)
          }
        } else if (block.blockId && sess._blockIdToMsgId.has(block.blockId)) {
          const mid = sess._blockIdToMsgId.get(block.blockId)
          const existing = sess.messages.find((m) => m.id === mid)
          if (existing) {
            existing.text = label
            if (sess.id === state.currentSessionId) updateMessageEl(existing)
          }
        } else {
          const m = addMessage(sess, 'tool', label, {
            toolIcon: '🔧',
            toolName: block.toolName,
            blockId: block.blockId,
          })
          if (block.blockId) sess._blockIdToMsgId.set(block.blockId, m.id)
        }
      } else if (block.kind === 'tool_result') {
        sess._streamingAssistant = null
        sess._streamingThinking = null

        // Check if this result belongs to a sub-agent group
        const isAgentResult = /^Agent$/i.test(block.toolName || '')
        if (isAgentResult && block.blockId && sess._agentGroups?.has(block.blockId)) {
          const groupMsgId = sess._agentGroups.get(block.blockId)
          const groupMsg = sess.messages.find((m) => m.id === groupMsgId)
          if (groupMsg) {
            groupMsg._completed = true
            groupMsg._duration = Date.now() - (groupMsg.startTime || Date.now())
            groupMsg._resultPreview = (block.preview || '').slice(0, 200)
            groupMsg._isError = !!block.isError
            if (sess.id === state.currentSessionId) updateMessageEl(groupMsg)
          }
          continue
        }

        if (!block.preview) continue
        const label = (block.toolName ? `${block.toolName}: ` : '') + block.preview
        if (block.blockId && sess._blockIdToMsgId.has(block.blockId)) {
          const mid = sess._blockIdToMsgId.get(block.blockId)
          const existing = sess.messages.find((m) => m.id === mid)
          if (existing) {
            existing.text = label
            existing.error = !!block.isError
            if (sess.id === state.currentSessionId) updateMessageEl(existing)
            continue
          }
        }
        const m = addMessage(sess, 'tool', label, {
          toolIcon: block.isError ? '⚠️' : '↳',
          toolName: block.toolName,
          blockId: block.blockId,
          error: !!block.isError,
        })
        if (block.blockId) sess._blockIdToMsgId.set(block.blockId, m.id)
      }
    }
    sess.lastAt = Date.now()
    if (frame.isFinal) {
      const metaText = formatMeta(frame.meta)
      if (metaText && sess._streamingAssistant) setMeta(sess, sess._streamingAssistant, metaText)
      // Final rich render: re-render all streaming messages with full Markdown/Mermaid/Chart
      if (sess._streamingAssistant && sess.id === state.currentSessionId) {
        updateMessageEl(sess._streamingAssistant, false)
        processRichBlocks()
      }
      if (sess._streamingThinking && sess.id === state.currentSessionId) {
        updateMessageEl(sess._streamingThinking, false)
      }
      const lastAssistant = [...sess.messages].reverse().find((m) => m.role === 'assistant')
      const preview = lastAssistant?.text?.replace(/[`*_#>]/g, '').trim() || ''
      if (preview) maybeNotify(`OpenClaude · ${sess.title}`, preview)
      sess._streamingAssistant = null
      sess._streamingThinking = null
      sess._sendingInFlight = false
      // Only update global UI state if this is the currently viewed session
      if (sess.id === state.currentSessionId) {
        state.sendingInFlight = false
        updateSendEnabled()
        hideTypingIndicator()
        setTitleBusy(false)
      }
      // Complete any bg tasks linked to this session's last user message
      const lastUser = [...sess.messages].reverse().find((m) => m.role === 'user')
      if (lastUser?.text?.startsWith('🔄 [后台]')) {
        // Find bg task by matching the idempotencyKey pattern
        for (const [id, t] of _bgTasks) {
          if (t.status === 'running' && lastUser.text.includes(t.desc.slice(0, 30))) {
            completeBgTask(id, 'done', { preview: preview?.slice(0, 100) })
            break
          }
        }
      }
    }
    if (sess.id === state.currentSessionId) updateSessionSub(sess)
    scheduleSave(sess)
    // Only rebuild sidebar on final message (not every streaming delta)
    if (frame.isFinal) renderSidebar()
  }

  // ═══════════════ SLASH COMMANDS ═══════════════
  // ═══════════════ BACKGROUND TASKS ═══════════════
  const _bgTasks = new Map() // id → { desc, status, startTime, duration, error }

  function addBgTask(id, desc) {
    _bgTasks.set(id, { desc, status: 'running', startTime: Date.now() })
    _updateTasksBadge()
  }
  function completeBgTask(id, status, meta) {
    const t = _bgTasks.get(id)
    if (!t) return
    t.status = status || 'done'
    t.duration = Date.now() - t.startTime
    if (meta?.error) t.error = meta.error
    if (meta?.preview) t.preview = meta.preview
    _updateTasksBadge()
    // Notify if tab not focused
    if (!state.windowFocused) {
      _notifSound()
      toast(`${status === 'done' ? '✓' : '✗'} 后台任务完成: ${t.desc}`)
    }
  }
  function _updateTasksBadge() {
    const running = [..._bgTasks.values()].filter((t) => t.status === 'running').length
    const btn = $('tasks-btn')
    const badge = $('tasks-badge')
    if (!btn) return
    btn.hidden = _bgTasks.size === 0
    badge.textContent = running > 0 ? running : ''
    badge.hidden = running === 0
    // Stop spin animation if nothing running
    const svg = btn.querySelector('svg')
    if (svg) svg.style.animation = running > 0 ? '' : 'none'
  }
  function _renderTasksPanel() {
    let panel = $('tasks-panel')
    if (!panel) {
      panel = document.createElement('div')
      panel.id = 'tasks-panel'
      panel.className = 'tasks-panel'
      panel.hidden = true
      $('tasks-btn').parentElement.style.position = 'relative'
      $('tasks-btn').parentElement.insertBefore(panel, $('tasks-btn').nextSibling)
    }
    panel.innerHTML = '<div class="tasks-panel-header">后台任务</div>'
    if (_bgTasks.size === 0) {
      panel.innerHTML += '<div class="tasks-panel-empty">暂无后台任务</div>'
      return panel
    }
    const sorted = [..._bgTasks.entries()].sort((a, b) => b[1].startTime - a[1].startTime)
    for (const [id, t] of sorted) {
      const iconCls = t.status === 'running' ? 'running' : t.status === 'done' ? 'done' : 'failed'
      const iconChar = t.status === 'running' ? '⟳' : t.status === 'done' ? '✓' : '✗'
      const dur = t.duration ? ` · ${(t.duration / 1000).toFixed(1)}s` : ''
      const item = document.createElement('div')
      item.className = 'tasks-panel-item'
      item.innerHTML = `<span class="tasks-panel-icon ${iconCls}">${iconChar}</span><div class="tasks-panel-info"><div class="tasks-panel-desc">${htmlSafeEscape(t.desc)}</div><div class="tasks-panel-meta">${t.status}${dur}</div></div>`
      panel.appendChild(item)
    }
    return panel
  }

  // Detect <task-notification> in assistant text output
  function _checkTaskNotifications(text) {
    const re = /<task-notification>([\s\S]*?)<\/task-notification>/g
    let match
    while ((match = re.exec(text)) !== null) {
      const body = match[1]
      const id = (body.match(/<task_id>(.*?)<\/task_id>/) || [])[1] || 'unknown'
      const status = (body.match(/<status>(.*?)<\/status>/) || [])[1] || 'completed'
      const preview = (body.match(/<output_file>(.*?)<\/output_file>/) || [])[1] || ''
      completeBgTask(id, status === 'completed' ? 'done' : 'failed', { preview })
    }
  }

  function addSystemMessage(text) {
    const sess = getSession()
    if (!sess) return
    addMessage(sess, 'assistant', text, { system: true })
    scheduleSave(sess)
  }

  const slashCommands = [
    {
      cmd: '/help',
      desc: '显示所有可用命令',
      run() {
        const lines = ['**可用命令:**', '']
        for (const c of slashCommands) lines.push(`\`${c.cmd}\` — ${c.desc}`)
        lines.push('', `也可以用 \`${_mod}K\` 打开命令面板`)
        addSystemMessage(lines.join('\n'))
      },
    },
    {
      cmd: '/new',
      desc: '新建会话',
      run() {
        createNewChat()
      },
    },
    {
      cmd: '/clear',
      desc: '清空当前会话消息和上下文',
      run() {
        const sess = getSession()
        if (!sess) return
        sess.messages = []
        sess._streamingAssistant = null
        sess._streamingThinking = null
        renderMessages()
        scheduleSave(sess)
        // Notify gateway to kill the CCB subprocess so context is truly reset
        // Next message will spawn a fresh process with no history
        if (state.ws && state.ws.readyState === 1) {
          state.ws.send(
            JSON.stringify({
              type: 'inbound.control.reset',
              channel: 'webchat',
              peer: { id: sess.id, kind: 'dm' },
              agentId: sess.agentId || state.defaultAgentId,
            }),
          )
        }
        toast('会话已清空，上下文已重置')
      },
    },
    {
      cmd: '/stop',
      desc: '停止当前生成',
      run() {
        const sess = getSession()
        if (!sess || !state.ws) return
        state.ws.send(
          JSON.stringify({
            type: 'inbound.control.stop',
            channel: 'webchat',
            peer: { id: sess.id, kind: 'dm' },
            agentId: sess.agentId || state.defaultAgentId,
          }),
        )
        sess._sendingInFlight = false
        state.sendingInFlight = false
        updateSendEnabled()
        hideTypingIndicator()
        setTitleBusy(false)
        toast('已发送停止信号')
      },
    },
    {
      cmd: '/memory',
      desc: '打开记忆管理',
      run() {
        openMemoryModal()
      },
    },
    {
      cmd: '/skills',
      desc: '打开技能管理',
      run() {
        openSkillsModal()
      },
    },
    {
      cmd: '/persona',
      desc: '编辑 agent 人格',
      run() {
        const sess = getSession()
        openPersonaEditor(sess?.agentId || state.defaultAgentId)
      },
    },
    {
      cmd: '/tasks',
      desc: '管理定时任务',
      run() {
        openTasksModal()
      },
    },
    {
      cmd: '/theme',
      desc: '切换主题',
      run() {
        cycleTheme()
      },
    },
    {
      cmd: '/config',
      desc: '查看当前配置 (调试)',
      async run() {
        ;(async () => {
          try {
            const r = await fetch('/api/config', {
              headers: { Authorization: `Bearer ${state.token}` },
            })
            const cfg = await r.json()
            addSystemMessage(`**当前配置:**\n\`\`\`json\n${JSON.stringify(cfg, null, 2)}\n\`\`\``)
          } catch {
            toast('获取配置失败', 'error')
          }
        })()
      },
    },
  ]

  function handleSlashCommand(text) {
    const parts = text.match(/^(\/\S+)\s*(.*)$/)
    if (!parts) return false
    const cmdName = parts[1].toLowerCase()
    const args = parts[2] || ''
    const cmd = slashCommands.find((c) => c.cmd === cmdName)
    if (!cmd) {
      addSystemMessage(`未知命令: \`${cmdName}\`。输入 \`/help\` 查看可用命令。`)
      return true
    }
    cmd.run(args)
    return true
  }

  // ── Slash command autocomplete ──
  let slashPopupVisible = false
  let _slashSelected = 0
  let _slashMatches = []

  function showSlashPopup(filter) {
    let popup = $('slash-popup')
    if (!popup) {
      popup = document.createElement('div')
      popup.id = 'slash-popup'
      popup.className = 'slash-popup'
      // Mount on .composer so it floats above the input area
      document.querySelector('.composer').appendChild(popup)
    }
    const q = filter.toLowerCase().slice(1) // remove leading /
    _slashMatches = slashCommands.filter(
      (c) => !q || c.cmd.slice(1).includes(q) || c.desc.includes(q),
    )
    if (_slashMatches.length === 0) {
      hideSlashPopup()
      return
    }
    _slashSelected = 0
    _renderSlashPopup(popup)
    popup.hidden = false
    slashPopupVisible = true
  }

  function _renderSlashPopup(popup) {
    popup.innerHTML = '<div class="slash-popup-header">命令</div>'
    _slashMatches.forEach((c, i) => {
      const item = document.createElement('div')
      item.className = `slash-popup-item${i === _slashSelected ? ' active' : ''}`
      item.innerHTML = `<div class="slash-item-left"><span class="slash-cmd">${c.cmd}</span></div><span class="slash-desc">${c.desc}</span>`
      item.onmouseenter = () => {
        _slashSelected = i
        popup
          .querySelectorAll('.slash-popup-item')
          .forEach((el, j) => el.classList.toggle('active', j === i))
      }
      item.onclick = (e) => {
        e.preventDefault()
        e.stopPropagation()
        _selectSlashItem(c)
      }
      popup.appendChild(item)
    })
  }

  function _selectSlashItem(c) {
    // For commands that take args, put cursor after the space
    // For commands that don't, execute immediately
    const noArgCmds = [
      '/help',
      '/new',
      '/clear',
      '/stop',
      '/memory',
      '/skills',
      '/persona',
      '/tasks',
      '/theme',
      '/config',
    ]
    if (noArgCmds.includes(c.cmd)) {
      $('input').value = c.cmd
      hideSlashPopup()
      send()
    } else {
      $('input').value = `${c.cmd} `
      $('input').focus()
      hideSlashPopup()
    }
  }

  function hideSlashPopup() {
    const popup = $('slash-popup')
    if (popup) popup.hidden = true
    slashPopupVisible = false
    _slashMatches = []
  }

  // ═══════════════ SEND ═══════════════
  function inferLangFromExt(name) {
    const m = /\.([^.]+)$/.exec(name)
    if (!m) return ''
    const ext = m[1].toLowerCase()
    const map = {
      js: 'javascript',
      ts: 'typescript',
      tsx: 'typescript',
      py: 'python',
      go: 'go',
      rs: 'rust',
      java: 'java',
      c: 'c',
      cpp: 'cpp',
      h: 'c',
      md: 'markdown',
      json: 'json',
      yml: 'yaml',
      yaml: 'yaml',
      sh: 'bash',
      bash: 'bash',
      html: 'html',
      css: 'css',
      sql: 'sql',
      xml: 'xml',
      toml: 'ini',
      ini: 'ini',
    }
    return map[ext] || ''
  }
  const MAX_INLINE_TEXT_CHARS = 30000 // ~30K chars inline, larger files get truncated

  function buildMessageText(userText, attachments) {
    if (!attachments || attachments.length === 0) return userText
    const parts = [userText]
    const textFiles = attachments.filter((a) => a.kind === 'text')
    if (textFiles.length > 0) {
      parts.push('')
      parts.push('---')
      parts.push('Attached files:')
      for (const a of textFiles) {
        const lang = inferLangFromExt(a.name)
        const content = a.text || ''
        const truncated = content.length > MAX_INLINE_TEXT_CHARS
        parts.push('')
        parts.push(`### ${a.name}  _(${formatSize(a.size)})_`)
        parts.push(`\`\`\`${lang}`)
        parts.push(truncated ? content.slice(0, MAX_INLINE_TEXT_CHARS) : content)
        parts.push('```')
        if (truncated) {
          parts.push(
            `_(truncated: showing first ${MAX_INLINE_TEXT_CHARS} of ${content.length} chars)_`,
          )
        }
      }
    }
    const imageFiles = attachments.filter((a) => a.kind === 'image')
    if (imageFiles.length > 0) {
      parts.push('')
      parts.push('---')
      parts.push(`Attached images (${imageFiles.length}):`)
      for (const im of imageFiles)
        parts.push(`- ${im.name}  _(${im.type}, ${formatSize(im.size)})_`)
      parts.push('')
      parts.push(
        '_(note: if you cannot see the image contents directly, tell the user so they can describe it)_',
      )
    }
    return parts.join('\n')
  }
  function send() {
    const text = $('input').value.trim()
    if (!text && state.attachments.length === 0) return
    // Intercept slash commands
    if (text.startsWith('/') && state.attachments.length === 0) {
      hideSlashPopup()
      if (handleSlashCommand(text)) {
        $('input').value = ''
        autoResize()
        return
      }
    }
    const sess = getSession()
    if (!sess) return
    const displayText =
      (text || '(file upload)') +
      (state.attachments.length > 0
        ? `\n\n📎 ${state.attachments.map((a) => a.name).join(', ')}`
        : '')
    const modelText = buildMessageText(text, state.attachments)
    const media = state.attachments
      .filter((a) => a.kind !== 'text')
      .map((a) => ({
        kind: a.kind,
        base64: a.dataUrl,
        mimeType: a.type,
        filename: a.name,
      }))
    const wsPayload = {
      type: 'inbound.message',
      idempotencyKey: `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      channel: 'webchat',
      peer: { id: sess.id, kind: 'dm' },
      agentId: sess.agentId || state.defaultAgentId,
      content: { text: modelText, media: media.length > 0 ? media : undefined },
      ts: Date.now(),
    }
    // Add user message with status tracking
    const userMsg = addMessage(sess, 'user', displayText, { status: 'sending' })
    sess._streamingAssistant = null
    sess._streamingThinking = null
    sess._blockIdToMsgId = new Map()
    if (state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify(wsPayload))
      userMsg.status = 'sent'
      updateMsgStatus(userMsg)
      setSending(true)
      updateSendEnabled()
      showTypingIndicator()
      setTitleBusy(true)
    } else {
      // Offline: queue for later
      state.offlineQueue.push({ sessId: sess.id, payload: wsPayload, msgId: userMsg.id })
      userMsg.status = 'queued'
      updateMsgStatus(userMsg)
      toast('离线排队中，重连后自动发送')
    }
    $('input').value = ''
    state.attachments = []
    renderAttachments()
    autoResize()
    scheduleSave(sess)
    renderSidebar()
  }
  function autoResize() {
    const el = $('input')
    el.style.height = 'auto'
    el.style.height = `${Math.min(window.innerHeight * 0.35, el.scrollHeight)}px`
  }

  // ═══════════════ COMMAND PALETTE ═══════════════
  const paletteActions = [
    {
      id: 'new-chat',
      label: '新建会话',
      kbd: `${_mod}N`,
      section: '动作',
      icon: 'plus',
      run: () => {
        createNewChat()
        closePalette()
      },
    },
    {
      id: 'toggle-sidebar',
      label: '切换侧栏',
      kbd: `${_mod}B`,
      section: '动作',
      icon: 'menu',
      run: () => {
        $('sidebar').classList.toggle('open')
        $('sidebar-backdrop').classList.toggle('open')
        closePalette()
      },
    },
    {
      id: 'open-memory',
      label: '查看 / 编辑 Memory',
      kbd: `${_mod}M`,
      section: '学习循环',
      icon: 'brain',
      run: () => {
        closePalette()
        openMemoryModal()
      },
    },
    {
      id: 'open-skills',
      label: '查看 / 管理 Skills',
      section: '学习循环',
      icon: 'bot',
      run: () => {
        closePalette()
        openSkillsModal()
      },
    },
    {
      id: 'open-tasks',
      label: '定时任务 / 提醒',
      section: '学习循环',
      icon: 'clock',
      run: () => {
        closePalette()
        openTasksModal()
      },
    },
    {
      id: 'manage-agents',
      label: '管理 Agents',
      section: '动作',
      icon: 'settings',
      run: () => {
        closePalette()
        openModal('agents-modal')
      },
    },
    {
      id: 'theme-cycle',
      label: '切换主题',
      section: '设置',
      icon: 'sun',
      run: () => {
        cycleTheme()
        closePalette()
      },
    },
    {
      id: 'logout',
      label: '退出登录',
      section: '设置',
      icon: 'logout',
      run: () => {
        $('logout-btn').click()
        closePalette()
      },
    },
  ]
  const ICON_SVG = {
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>',
    settings:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4"/></svg>',
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/></svg>',
    logout:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
    bot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="7" width="16" height="12" rx="2"/><line x1="12" y1="3" x2="12" y2="7"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    brain:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/></svg>',
  }
  let paletteItems = []
  let paletteSelected = 0
  function buildPaletteItems(query) {
    const q = query.trim().toLowerCase()
    const items = []
    // Actions
    for (const a of paletteActions) {
      if (!q || a.label.toLowerCase().includes(q)) {
        items.push({ ...a, section: a.section })
      }
    }
    // Agents
    for (const a of state.agentsList) {
      const label = `切换 agent → ${a.id}`
      if (!q || label.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)) {
        items.push({
          id: `switch-agent-${a.id}`,
          label,
          section: 'Agents',
          icon: 'bot',
          run: () => {
            const sess = getSession()
            if (sess) {
              sess.agentId = a.id
              scheduleSave(sess)
              renderAgentDropdown()
              toast(`已切换到 ${a.id}`)
            }
            closePalette()
          },
        })
      }
    }
    // Sessions
    const sessions = [...state.sessions.values()].sort((a, b) => b.lastAt - a.lastAt)
    for (const s of sessions) {
      if (!q || s.title.toLowerCase().includes(q)) {
        items.push({
          id: `switch-session-${s.id}`,
          label: s.title,
          hint: shortTime(s.lastAt),
          section: '会话',
          icon: 'chat',
          run: () => {
            switchSession(s.id)
            closePalette()
          },
        })
      }
    }
    return items
  }
  function renderPalette() {
    const list = $('palette-list')
    list.innerHTML = ''
    if (paletteItems.length === 0) {
      list.innerHTML = '<div class="palette-empty">没有匹配的命令</div>'
      return
    }
    let lastSection = null
    paletteItems.forEach((item, idx) => {
      if (item.section !== lastSection) {
        const label = document.createElement('div')
        label.className = 'palette-section-label'
        label.textContent = item.section
        list.appendChild(label)
        lastSection = item.section
      }
      const btn = document.createElement('button')
      btn.className = `palette-item${idx === paletteSelected ? ' active' : ''}`
      btn.type = 'button'
      btn.innerHTML = `${ICON_SVG[item.icon] || ''}<span class="palette-item-label">${htmlSafeEscape(item.label)}</span>${item.hint ? `<span class="palette-item-hint">${htmlSafeEscape(item.hint)}</span>` : ''}${item.kbd ? `<span class="palette-item-hint">${item.kbd}</span>` : ''}`
      btn.onclick = () => item.run()
      btn.onmouseenter = () => {
        paletteSelected = idx
        document
          .querySelectorAll('.palette-item')
          .forEach((e, i) => e.classList.toggle('active', i === idx))
      }
      list.appendChild(btn)
    })
  }
  function openPalette() {
    $('palette-input').value = ''
    paletteItems = buildPaletteItems('')
    paletteSelected = 0
    renderPalette()
    $('palette-backdrop').classList.add('open')
    setTimeout(() => $('palette-input').focus(), 20)
  }
  function closePalette() {
    $('palette-backdrop').classList.remove('open')
  }

  // ═══════════════ VIEWS ═══════════════
  function showLogin() {
    $('login-view').hidden = false
    $('app-view').hidden = true
    setTimeout(() => $('token').focus(), 50)
  }
  function showApp() {
    $('login-view').hidden = true
    $('app-view').hidden = false
    // Set HttpOnly session cookie for media preview (img/audio/video can't send Bearer headers)
    fetch('/api/auth/session', { method: 'POST', headers: authHeaders() }).catch(() => {})
  }
  function createNewChat() {
    // Inherit current session's agent, fallback to default
    const currentSess = getSession()
    const agentId = currentSess?.agentId || state.defaultAgentId
    createSession(agentId)
    renderSidebar()
    renderMessages()
    renderAgentDropdown()
    // Close sidebar on mobile
    $('sidebar').classList.remove('open')
    $('sidebar-backdrop').classList.remove('open')
    // Show agent greeting if configured
    const sess = getSession()
    const agentInfo = state.agentsList.find((a) => a.id === (sess?.agentId || state.defaultAgentId))
    if (agentInfo?.greeting && sess) {
      addMessage(sess, 'assistant', agentInfo.greeting, { system: true })
      scheduleSave(sess)
    }
    $('input').focus()
  }

  // ═══════════════ INIT ═══════════════
  async function init() {
    // Sidebar search
    let _searchDebounce = null
    // Tasks panel toggle
    $('tasks-btn').onclick = (e) => {
      e.stopPropagation()
      const panel = _renderTasksPanel()
      panel.hidden = !panel.hidden
      if (!panel.hidden)
        setTimeout(
          () =>
            document.addEventListener(
              'click',
              () => {
                panel.hidden = true
              },
              { once: true },
            ),
          10,
        )
    }
    $('sidebar-search').addEventListener('input', () => {
      clearTimeout(_searchDebounce)
      _searchDebounce = setTimeout(renderSidebar, 150)
    })
    // Replace hardcoded ⌘ in HTML with platform-appropriate modifier
    if (!_isMac) {
      document.querySelectorAll('.kbd, kbd').forEach((el) => {
        el.textContent = el.textContent.replace(/⌘/g, 'Ctrl+')
      })
      $('new-chat-btn')?.setAttribute('title', '新建会话 (Ctrl+N)')
    }
    $('new-chat-btn').onclick = createNewChat
    $('logout-btn').onclick = async () => {
      // Expire the HttpOnly oc_session cookie on server
      try {
        await fetch('/api/auth/logout', { method: 'POST' })
      } catch {}
      localStorage.removeItem('openclaude_token')
      state.token = ''
      if (state.ws) state.ws.close(1000)
      showLogin()
    }
    $('theme-btn').onclick = cycleTheme
    $('toggle-sidebar').onclick = () => {
      $('sidebar').classList.toggle('open')
      $('sidebar-backdrop').classList.toggle('open')
    }
    $('sidebar-backdrop').onclick = () => {
      $('sidebar').classList.remove('open')
      $('sidebar-backdrop').classList.remove('open')
    }
    $('agent-select').onchange = (e) => {
      const sess = getSession()
      if (!sess) return
      sess.agentId = e.target.value
      // Reset streaming state to prevent cross-agent message contamination
      sess._streamingAssistant = null
      sess._streamingThinking = null
      sess._sendingInFlight = false
      state.sendingInFlight = false
      hideTypingIndicator()
      updateSendEnabled()
      setTitleBusy(false)
      scheduleSave(sess)
      toast(`已切换到 ${sess.agentId}`)
    }
    // Settings dropdown
    $('manage-agents-btn').onclick = (e) => {
      e.stopPropagation()
      const dd = $('settings-dropdown')
      dd.hidden = !dd.hidden
      if (!dd.hidden) {
        setTimeout(
          () =>
            document.addEventListener(
              'click',
              () => {
                dd.hidden = true
              },
              { once: true },
            ),
          10,
        )
      }
    }
    document.addEventListener('click', (e) => {
      const btn = e.target.closest?.('[data-settings]')
      if (!btn) return
      const action = btn.dataset.settings
      $('settings-dropdown').hidden = true
      if (action === 'persona') {
        const sess = getSession()
        openPersonaEditor(sess?.agentId || state.defaultAgentId)
      } else if (action === 'agents') openModal('agents-modal')
      else if (action === 'memory') openMemoryModal()
      else if (action === 'skills') openSkillsModal()
      else if (action === 'tasks') openTasksModal()
      else if (action === 'theme') cycleTheme()
      else if (action === 'config') {
        ;(async () => {
          try {
            const r = await fetch('/api/config', {
              headers: { Authorization: `Bearer ${state.token}` },
            })
            const cfg = await r.json()
            addSystemMessage(`**当前配置:**\n\`\`\`json\n${JSON.stringify(cfg, null, 2)}\n\`\`\``)
          } catch {
            toast('获取配置失败', 'error')
          }
        })()
      } else if (action === 'claude-oauth') openOAuthModal()
      else if (action === 'logout') $('logout-btn').click()
    })
    // Memory modal events
    $('memory-tab-memory').onclick = async () => {
      $('memory-tab-memory').className = 'btn btn-secondary'
      $('memory-tab-user').className = 'btn btn-ghost'
      await loadMemoryTab('memory')
    }
    $('memory-tab-user').onclick = async () => {
      $('memory-tab-user').className = 'btn btn-secondary'
      $('memory-tab-memory').className = 'btn btn-ghost'
      await loadMemoryTab('user')
    }
    $('save-memory-btn').onclick = saveMemory
    // Permission modal buttons
    $('perm-allow-btn').onclick = () => respondPermission('allow')
    $('perm-deny-btn').onclick = () => respondPermission('deny')
    $('voice-btn').onclick = toggleVoice
    $('upload-btn').onclick = () => $('file-input').click()
    $('file-input').addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) addFiles(e.target.files)
      e.target.value = ''
    })
    // Drag-drop
    const dropZone = $('messages')
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault()
      dropZone.style.outline = '2px dashed var(--accent)'
    })
    dropZone.addEventListener('dragleave', () => {
      dropZone.style.outline = ''
    })
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault()
      dropZone.style.outline = ''
      if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files)
    })
    // Input events — single keydown handler for both slash popup and send
    $('input').addEventListener('keydown', (e) => {
      // Slash popup navigation takes priority when visible
      if (slashPopupVisible) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          _slashSelected = Math.min(_slashSelected + 1, _slashMatches.length - 1)
          const popup = $('slash-popup')
          if (popup)
            popup
              .querySelectorAll('.slash-popup-item')
              .forEach((el, i) => el.classList.toggle('active', i === _slashSelected))
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          _slashSelected = Math.max(_slashSelected - 1, 0)
          const popup = $('slash-popup')
          if (popup)
            popup
              .querySelectorAll('.slash-popup-item')
              .forEach((el, i) => el.classList.toggle('active', i === _slashSelected))
          return
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && _slashMatches.length > 0)) {
          e.preventDefault()
          if (_slashMatches[_slashSelected]) _selectSlashItem(_slashMatches[_slashSelected])
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          hideSlashPopup()
          return
        }
      }
      // Normal Enter → send
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        if (state.sendingInFlight) stopCurrentTurn()
        else send()
      }
    })
    $('input').addEventListener('input', () => {
      autoResize()
      const val = $('input').value
      if (val.startsWith('/') && !val.includes('\n') && val.length < 40) {
        showSlashPopup(val)
      } else {
        hideSlashPopup()
      }
    })
    $('input').addEventListener('blur', () => {
      setTimeout(hideSlashPopup, 200)
    })
    $('send').onclick = () => {
      if (state.sendingInFlight) stopCurrentTurn()
      else send()
    }
    // Agents modal
    $('create-agent-btn').onclick = async () => {
      const id = $('new-agent-id').value.trim()
      if (!id) return
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
        toast('非法 id', 'error')
        return
      }
      try {
        await apiJson('POST', '/api/agents', { id })
        $('new-agent-id').value = ''
        toast(`已创建 ${id}`, 'success')
        await reloadAgents()
      } catch (err) {
        toast(String(err), 'error')
      }
    }
    // Login
    $('login-btn').onclick = () => {
      const t = $('token').value.trim()
      if (!t) return
      state.token = t
      localStorage.setItem('openclaude_token', t)
      showApp()
      renderSidebar()
      renderMessages()
      connect()
      reloadAgents()
      // Don't request notification permission on login — wait until first background notification
    }
    $('token').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('login-btn').click()
    })
    // Palette input
    $('palette-input').addEventListener('input', (e) => {
      paletteItems = buildPaletteItems(e.target.value)
      paletteSelected = 0
      renderPalette()
    })
    $('palette-input').addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (paletteItems.length) {
          paletteSelected = (paletteSelected + 1) % paletteItems.length
          renderPalette()
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (paletteItems.length) {
          paletteSelected = (paletteSelected - 1 + paletteItems.length) % paletteItems.length
          renderPalette()
        }
      } else if (e.key === 'Enter') {
        e.preventDefault()
        paletteItems[paletteSelected]?.run()
      }
    })
    // Global shortcuts
    document.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        openPalette()
      } else if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        createNewChat()
      } else if (mod && e.key.toLowerCase() === 'm') {
        e.preventDefault()
        openMemoryModal()
      } else if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        $('sidebar').classList.toggle('open')
        $('sidebar-backdrop').classList.toggle('open')
      }
    })

    // Load sessions
    try {
      const all = await dbGetAll()
      for (const s of all) {
        _rebuildSearchIndex(s)
        state.sessions.set(s.id, s)
      }
    } catch (e) {
      console.warn('IDB load failed', e)
    }
    const arr = [...state.sessions.values()].sort((a, b) => b.lastAt - a.lastAt)
    if (arr.length > 0) state.currentSessionId = arr[0].id
    else createSession()

    if (state.token) {
      showApp()
      renderSidebar()
      renderMessages()
      connect()
      reloadAgents()
      // Don't request notification permission on login — wait until first background notification
    } else {
      showLogin()
    }

    // Service worker
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {})
      })
    }

    // Periodic time refresh
    // Update time labels only (not full sidebar rebuild) every 30s
    setInterval(() => {
      const s = getSession()
      if (s) updateSessionSub(s)
      // Only update time hints in sidebar, not full rebuild
      document.querySelectorAll('.session-item .session-time-hint').forEach((el) => {
        if (el.dataset.ts) el.textContent = shortTime(Number(el.dataset.ts))
      })
    }, 30000)
  }

  // Debug helper for Mermaid/HTML preview tests
  window.__oc_render = (text) => {
    const inner = ensureInner()
    const wrap = document.createElement('div')
    wrap.className = 'msg assistant'
    wrap.dataset.msgId = `__oc_debug_${Date.now()}`
    wrap.innerHTML = `<div class="avatar">O</div><div class="msg-body">${renderMarkdown(text)}</div>`
    inner.appendChild(wrap)
    processRichBlocks()
  }

  init()
})()
