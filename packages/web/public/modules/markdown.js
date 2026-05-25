// OpenClaude — Markdown rendering, media embedding, rich blocks
import { htmlSafeEscape } from './dom.js?v=638e97a0'
import { TRANSPARENT_PIXEL_DATA_URL, getCachedSignedUrl } from './mediaSign.js?v=638e97a0'
import { effectiveTheme } from './theme.js?v=638e97a0'
import { _basename } from './util.js?v=638e97a0'

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
      s.onerror = (err) => {
        _mermaidLoadPromise = null
        reject(err)
      }
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
  //
  // Inline-context display math: "$$...$$" (and "\[...\]" further below) inside
  // a markdown table cell / list item / paragraph-internal inline run. marked
  // routes those contexts through the **inline** lexer, where block-level
  // mathBlock/codexDisplayMath never fire and mathInline/codexInlineMath
  // explicitly reject the `$$`/`\[` delimiters. Without an inline-level handler
  // for display math, raw `$$...$$` leaks out as text. The symmetric fix is to
  // register inline-level siblings of the block-level display extensions.
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
      {
        // Inline-level "$$...$$" — only matters in inline contexts (table cell,
        // mid-paragraph) where block-level mathBlock cannot fire. mathInline
        // never reports `$$` (right-OK check rejects `$` next char) and its
        // tokenizer rejects `$$` opening too, so we own this delimiter here
        // without contention.
        name: 'mathDisplayInline',
        level: 'inline',
        start(src) {
          const idx = src.indexOf('$$')
          return idx < 0 ? undefined : idx
        },
        tokenizer(src) {
          // marked may call tokenizer with full remaining src on first try
          // (before honoring start()) — guard that we're actually on `$$`.
          if (src[0] !== '$' || src[1] !== '$') return
          const result = _scanDollarDisplayBody(src, 2)
          if (result.closer < 0) return
          const tex = src.slice(2, result.closer).trim()
          if (!tex) return
          const raw = src.slice(0, result.closer + 2)
          return { type: 'mathDisplayInline', raw, text: tex }
        },
        renderer(token) {
          if (_isStreamingParse) {
            return htmlSafeEscape(`$$${token.text}$$`)
          }
          const id = `math-${Math.random().toString(36).slice(2, 10)}`
          // displayMode KaTeX renders to `<span class="katex-display">`, so a
          // `<span>` placeholder is the only HTML-valid choice inside `<td>` /
          // `<p>` (a `<div>` would get reparented out by the HTML parser).
          pendingMath.push({ id, tex: token.text, display: true })
          return `<span class="math-inline" id="${id}"></span>`
        },
      },
    ],
  })
}

// `$$..$$` inline-context body scanner — single-line, TeX-backslash aware.
// Mirrors `_scanCodexMathBody` for the dollar-double delimiter. Hoisted out of
// the marked extension so pureFunctions.test.ts can lock its behavior without a
// browser/marked dependency.
//
// Args:
//   src   — full remaining source the tokenizer sees (must already start with `$$`)
//   start — index to begin scanning the body from (caller passes 2 to skip `$$`)
//
// Returns:
//   { closer:  i, dead: false } — `$$` closer found, src[i]==='$' && src[i+1]==='$'
//   { closer: -1, dead: false } — newline hit OR EOF without closer (single-line)
//
// `dead` always false for inline scans — no whole-render abort semantics (those
// belong to codexDisplayMath block-level dead-flag, where unclosed `\[`
// poisons all subsequent `\[` openers to avoid O(n²)).
function _scanDollarDisplayBody(src, start) {
  const n = src.length
  let p = start
  while (p < n) {
    const c = src[p]
    // Inline display math is single-line: newline aborts the scan, leaves
    // multiline display math to block-level mathBlock.
    if (c === '\n') return { closer: -1, dead: false }
    // TeX escape: `\\` (line break), `\$` (literal $), etc. — skip 2 chars so
    // an escaped `$` inside the body never falsely closes the delimiter.
    if (c === '\\') {
      p += 2
      continue
    }
    if (c === '$' && src[p + 1] === '$') {
      return { closer: p, dead: false }
    }
    p++
  }
  return { closer: -1, dead: false }
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

// 2026-04-22 Codex R1 I9:统一"URL → 安全 HTML 属性值"helper,替代散落各处的
// `src="${url}"` 裸插。协议白名单 + htmlSafeEscape 缺一不可 —— 单独协议白名单放不住
// `https://evil.com/x" onerror=...` 这种以合法 scheme 开头但含属性断开字符的 payload。
// 返回值可直接塞进 src=/href=/data-* 等 HTML 属性,不需要再手动 escape;空串表示协议被拒。
function _safeAttr(url) {
  const rawSafe = _safeMediaUrl(url)
  if (!rawSafe) return ''
  return htmlSafeEscape(rawSafe)
}

// `pendingPath`(可选):本地绝对路径,用于 signed URL 异步替换。
//   - 传入 → 渲染 `data-pending-sign-path` + `data-sign-target="src"`,由
//     main.js MutationObserver + mediaSign.js 负责把 src/data-img-src 改成签名 URL。
//   - 不传 → 行为不变,直接用 url 当 src(用于 HTTP URL / 已签名 URL / 占位图)。
//
// **设计动机**:`<img src="/api/file?...">` 在 iOS Safari CDN 多跳场景偶发丢
// HttpOnly cookie。S3 风格 HMAC signed URL 在 URL 里自带身份,绕过 cookie。
export function _imgHtml(url, title, pendingPath) {
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
  const pendAttr =
    typeof pendingPath === 'string' && pendingPath
      ? ` data-pending-sign-path="${htmlSafeEscape(pendingPath)}" data-sign-target="src"`
      : ''
  return `<div class="media-wrap"><img class="inline-img" src="${safeUrl}" loading="lazy"${t}${pendAttr}><div class="img-actions"><button data-img-action="copy" data-img-src="${safeUrl}" title="复制图片">${svgCopy}</button><button data-img-action="download" data-img-src="${safeUrl}" title="下载">${svgDl}</button><button data-img-action="open" data-img-src="${safeUrl}" title="新标签页打开">${svgOpen}</button></div></div>`
}

export function _renderLocalMedia(filePath) {
  // 本地路径 → signed URL 流程:
  //   - 缓存命中 → 直接拿签名 URL 当 src(无闪烁,SSR-style)
  //   - 缓存未命中 → 占位 src(透明 1x1 PNG for <img>, 空 src for audio/video/anchor)
  //     + `data-pending-sign-path` + `data-sign-target` 属性,
  //     main.js MutationObserver 用 mediaSign.signMediaPath() 异步替换。
  //
  // **没有 cookie fallback**:老的 `<img src="/api/file?path=...">` cookie-auth 路径
  // 正是 iOS Safari + CF CDN 偶发丢 `oc_session` 的破图根因 —— 签不到就保持占位,
  // 不退回那条 path,否则等于把 bug 重新放出来。`localPathToUrl` 已经从 _renderLocalMedia
  // 的渲染路径里彻底移除。
  const name = _basename(filePath) || 'file'
  const safeName = htmlSafeEscape(name)
  const safePending = htmlSafeEscape(filePath)
  const cached = getCachedSignedUrl(filePath)

  if (_IMG_EXTS.test(filePath)) {
    // _imgHtml 内部已能处理"cached 命中走 url、未命中走占位 + pendingPath"两路 —
    // 命中 → url = signed URL, pendingPath = filePath(也带上,过期后 onerror 还能 retry)
    // 未命中 → url = 1x1 PNG,pendingPath = filePath
    const initialUrl = cached || TRANSPARENT_PIXEL_DATA_URL
    return _imgHtml(initialUrl, name, filePath)
  }
  if (_AUD_EXTS.test(filePath)) {
    const srcAttr = cached ? ` src="${htmlSafeEscape(cached)}"` : ''
    return `<div class="media-wrap"><audio controls preload="none"${srcAttr} data-pending-sign-path="${safePending}" data-sign-target="src"></audio><div class="media-filename">${safeName}</div></div>`
  }
  if (_VID_EXTS.test(filePath)) {
    const srcAttr = cached ? ` src="${htmlSafeEscape(cached)}"` : ''
    return `<div class="media-wrap"><video class="inline-video" controls preload="metadata"${srcAttr} data-pending-sign-path="${safePending}" data-sign-target="src"></video><div class="media-filename">${safeName}</div></div>`
  }
  // 容器内文件(包括 PDF)统一走"当前页 attachment 下载",不开新 tab —
  // 1. target="_blank" 在异步签名 await 后丢失 user gesture,被 popup blocker 拦
  // 2. 当前页 + Content-Disposition: attachment(下面 download attr 同源强制覆盖
  //    服务端的 inline)→ 浏览器原生下载 dialog,不离开对话页,WS / 输入框状态全保留
  // 这两条让 PDF 跟 tar.gz 体验一致:点 → 下载到本地 → 系统 PDF viewer 打开
  if (_PDF_EXTS.test(filePath)) {
    const hrefAttr = cached ? ` href="${htmlSafeEscape(cached)}"` : ''
    return `<a class="doc-card"${hrefAttr} rel="noopener" download="${safeName}" data-pending-sign-path="${safePending}" data-sign-target="href"><span class="doc-card-icon">📄</span><span class="doc-card-name">${safeName}</span></a>`
  }
  const hrefAttr = cached ? ` href="${htmlSafeEscape(cached)}"` : ''
  return `<a class="doc-card"${hrefAttr} rel="noopener" download="${safeName}" data-pending-sign-path="${safePending}" data-sign-target="href"><span class="doc-card-icon">📎</span><span class="doc-card-name">${safeName}</span></a>`
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
      `((?:^|[\\s>])((?:(?:/|[A-Za-z]:[\\\\\\\\])[^\\s<"\'\`>]+\\.(?:${_MEDIA_EXTS}))))`,
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

  // Step 1b: 任意扩展名的"约定发布目录"兜底 —— agent 按 platform-capabilities
  // skill 指导把文件写到 /home/agent/.openclaude/ 或 /root/.openclaude/ 下,然后
  // 在消息里写纯绝对路径。Step 1 的 _MEDIA_EXTS 只认媒体扩展,.txt/.zip/.json/.csv
  // 等日常文件被漏掉变纯文字,用户点不开。这里加一条前缀白名单 fallback:路径以
  // 约定目录开头 + 至少带一个扩展名 → 走 _renderLocalMedia 的 📎 文件卡片分支(该
  // 函数已内置 img/audio/video/pdf 分支,其他扩展自动走 doc-card)。
  // 前缀严格限定 .openclaude/ 子树,避免 /etc/passwd 这类路径被误转 —— 容器端白
  // 名单也会拦,但前端不显示成链接更干净。
  // <code> 包裹的路径同样由 step 1 的 <code> 分支只处理媒体,这里再加 <code> 版本
  // 的 fallback 保持两条分支一致。
  // 贪婪 `+` 配合后面 `\.\w{1,10}` 的回溯能正确覆盖多 dot 文件名(.tar.gz / .v2.txt
  // / .json.bak / .d.ts 等):贪婪先吃整段,回溯让最右边的 `. + 短串` 满足扩展名。
  // **不要**改回非贪婪 `+?` —— 那会停在第一个扩展名:research_v7.2_20260515.tar.gz
  // 被截到 research_v7.2,后半段漂出 anchor,渲染坏链。
  const _PUB_PREFIX = '(?:/home/agent|/root)/\\.openclaude/[^\\s<"\'`>]+\\.[A-Za-z0-9]{1,10}'
  html = html.replace(new RegExp(`<code>(${_PUB_PREFIX})</code>`, 'g'), (match, rawPath) => {
    const filePath = rawPath
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
    return _renderLocalMedia(filePath)
  })
  html = html.replace(
    new RegExp(`((?:^|[\\s>])(${_PUB_PREFIX}))`, 'g'),
    (match, full, filePath, offset) => {
      const before = html.substring(Math.max(0, offset - 10), offset)
      if (/(?:src|href|poster)\s*=\s*["']?\s*$/i.test(before)) return match
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

    // `/api/file?path=<absPath>` 是历史 cookie-auth 链接,iOS Safari + CF CDN 会丢
    // cookie → 改走 signed URL 流程。从 query 拿出 path,交给 _renderLocalMedia
    // (内部按扩展名 + cache 命中分发,统一加 data-pending-sign-path)。
    // `/api/media-signed?...` / `/api/media-sign` / 其他 /api/media* 不在此分支:
    // 它们要么已签名,要么不是用户可见 URL,保持原样。
    const fileApiMatch = url.match(/^\/api\/file\?path=([^&]+)/)
    if (fileApiMatch) {
      try {
        const absPath = decodeURIComponent(fileApiMatch[1])
        if (absPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(absPath)) {
          return _renderLocalMedia(absPath)
        }
      } catch {
        // fall through
      }
    }

    let decodedForExt = url
    try {
      decodedForExt = decodeURIComponent(url.split('?')[0])
    } catch {}

    // I9: audio/video/pdf 分支此前直接插 `${url}`,URL_RE 已排除了 `"'<>` 但 `&` 仍会
    // 裸漏,HTML 属性里非 `&amp;` 的 `&` 技术上可解析但某些 parser 策略下会生成警告 /
    // sanitizer 二次改写。统一走 _safeAttr 一次性搞定:协议白名单 + HTML-attr escape。
    // 协议被拒(如极端情况的 `javascript:` URL 被 URL_RE 漏放)→ 返回 match 原样不动。
    const safeAttrUrl = _safeAttr(url)
    if (!safeAttrUrl) return match
    if (_IMG_EXTS.test(decodedForExt)) {
      return _imgHtml(url, decodedForExt.split('/').pop() || '')
    }
    if (_AUD_EXTS.test(decodedForExt)) {
      return `<div class="media-wrap"><audio controls preload="none" src="${safeAttrUrl}"></audio></div>`
    }
    if (_VID_EXTS.test(decodedForExt)) {
      return `<div class="media-wrap"><video class="inline-video" controls preload="metadata" src="${safeAttrUrl}"></video></div>`
    }
    if (_PDF_EXTS.test(decodedForExt)) {
      const name = decodedForExt.split('/').pop() || 'document.pdf'
      return `<a class="doc-card" href="${safeAttrUrl}" target="_blank" rel="noopener"><span class="doc-card-icon">📄</span><span class="doc-card-name">${htmlSafeEscape(name)}</span></a>`
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
      // `/api/file?path=<absPath>` → cookie-auth 链接,iOS 会丢 → 抽出 path 转 signed URL
      const fileApi = src.match(/^\/api\/file\?path=([^&]+)/i)
      if (fileApi) {
        try {
          const absPath = decodeURIComponent(fileApi[1])
          if (absPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(absPath)) {
            return _renderLocalMedia(absPath)
          }
        } catch {
          // fall through
        }
      }
      // 已签名 / http(s) / data / blob → 原样
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
      const fileApi = src.match(/^\/api\/file\?path=([^&]+)/i)
      if (fileApi) {
        try {
          const absPath = decodeURIComponent(fileApi[1])
          if (absPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(absPath)) {
            return _renderLocalMedia(absPath)
          }
        } catch {
          // fall through
        }
      }
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

// ── Codex/KaTeX delimiter extensions (\(...\) and \[...\]) ──
// Codex (and ChatGPT) emit math with LaTeX-standard delimiters \(...\) and \[...\],
// not the $...$ / $$...$$ that mathBlock/mathInline recognize. marked treats `\[`
// and `\(` as escaped ASCII punctuation — the backslash gets eaten and only a bare
// `[` / `(` remains, leaving raw TeX visible to the user.
//
// We register two dedicated marked extensions that recognize these delimiters
// directly, bypassing any $/$$ middleman. An earlier approach normalized to $/$$
// pre-parse, but mathInline's word-boundary heuristics rejected digit-prefix
// inputs like `\(2x\)` even with ZWS sentinel padding. The fix is to stop
// piggy-backing on mathInline's rules and emit our own tokens.
//
// Math body scanner — `\\X` (any X) skip-2 handles TeX backslash escapes
// (`\\\\` line break, `\)` literal closer-paren in body, etc.). Multi-line
// allowed for display, line-bound for inline. Returned shape:
//   { closer: idx, dead: false } — found `\${closeChar}` at idx
//   { closer: -1, dead: true }   — display: scanned EOF, no closer in entire src
//   { closer: -1, dead: false }  — inline: hit newline; display: shouldn't occur
//
// Pulled out of the extension closures so pureFunctions.test.ts can test it
// (the marked extension code itself depends on `marked` + `pendingMath` + DOM).
function _scanCodexMathBody(src, start, closeChar, allowNewline) {
  const n = src.length
  let p = start
  while (p < n) {
    const c = src[p]
    if (c === '\n' && !allowNewline) {
      return { closer: -1, dead: false }
    }
    if (c === '\\') {
      const next = src[p + 1]
      if (next === closeChar) {
        return { closer: p, dead: false }
      }
      if (next === '\\') {
        p += 2
        continue
      }
      p++
      continue
    }
    p++
  }
  // EOF reached — only "dead" if multi-line scan (= unclosed display math
  // means no `\]` exists anywhere from `start` onwards in src).
  return { closer: -1, dead: allowNewline }
}

// Module-level dead flag — set by codexDisplayMath tokenizer when a scan reaches
// EOF without finding `\]`. Subsequent openers in the same parse fast-fail in
// `start()`, preventing O(n²) on inputs with many unclosed `\[` openers. Reset
// at the entry of renderMarkdown / renderStreamingMarkdown so each render call
// gets a fresh budget.
let _codexDisplayMathDead = false

if (window.marked) {
  marked.use({
    extensions: [
      {
        name: 'codexDisplayMath',
        level: 'block',
        start(src) {
          if (_codexDisplayMathDead) return undefined
          // \[ at start of src OR right after a \n (block-level: line-anchored)
          const m = /(?:^|\n)\\\[/.exec(src)
          if (!m) return undefined
          return src[m.index] === '\\' ? m.index : m.index + 1
        },
        tokenizer(src) {
          // marked may call tokenizer with the full remaining src on its first
          // try; guard that we're actually positioned on `\[`. (Same pattern as
          // mathInline above.)
          if (src[0] !== '\\' || src[1] !== '[') return
          const result = _scanCodexMathBody(src, 2, ']', true)
          if (result.dead) {
            _codexDisplayMathDead = true
            return
          }
          if (result.closer < 0) return
          const tex = src.slice(2, result.closer).trim()
          if (!tex) return
          const raw = src.slice(0, result.closer + 2)
          return { type: 'codexDisplayMath', raw, text: tex }
        },
        renderer(token) {
          if (_isStreamingParse) {
            return `<p>${htmlSafeEscape(`\\[${token.text}\\]`)}</p>`
          }
          const id = `math-${Math.random().toString(36).slice(2, 10)}`
          pendingMath.push({ id, tex: token.text, display: true })
          return `<div class="math-block" id="${id}"></div>`
        },
      },
      {
        name: 'codexInlineMath',
        level: 'inline',
        start(src) {
          // No need for word-boundary check — `\(` is unambiguous in Markdown
          // (marked normally would interpret it as escaped `(`, that's the bug).
          const idx = src.indexOf('\\(')
          return idx < 0 ? undefined : idx
        },
        tokenizer(src) {
          if (src[0] !== '\\' || src[1] !== '(') return
          const result = _scanCodexMathBody(src, 2, ')', false)
          if (result.closer < 0) return
          const tex = src.slice(2, result.closer).trim()
          if (!tex) return
          const raw = src.slice(0, result.closer + 2)
          return { type: 'codexInlineMath', raw, text: tex }
        },
        renderer(token) {
          if (_isStreamingParse) {
            return htmlSafeEscape(`\\(${token.text}\\)`)
          }
          const id = `math-${Math.random().toString(36).slice(2, 10)}`
          pendingMath.push({ id, tex: token.text, display: false })
          return `<span class="math-inline" id="${id}"></span>`
        },
      },
      {
        // Inline-level "\[...\]" — symmetric sibling of codexDisplayMath, fires
        // when `\[` appears inside an inline run (table cell, mid-paragraph)
        // where the block-level extension never gets a chance.
        name: 'codexDisplayInline',
        level: 'inline',
        start(src) {
          const idx = src.indexOf('\\[')
          return idx < 0 ? undefined : idx
        },
        tokenizer(src) {
          if (src[0] !== '\\' || src[1] !== '[') return
          // Single-line scan for inline context (mirrors mathDisplayInline);
          // multiline `\[..\]` stays the block extension's domain.
          const result = _scanCodexMathBody(src, 2, ']', false)
          if (result.closer < 0) return
          const tex = src.slice(2, result.closer).trim()
          if (!tex) return
          const raw = src.slice(0, result.closer + 2)
          return { type: 'codexDisplayInline', raw, text: tex }
        },
        renderer(token) {
          if (_isStreamingParse) {
            return htmlSafeEscape(`\\[${token.text}\\]`)
          }
          const id = `math-${Math.random().toString(36).slice(2, 10)}`
          pendingMath.push({ id, tex: token.text, display: true })
          // span placeholder (not div) — see mathDisplayInline for rationale.
          return `<span class="math-inline" id="${id}"></span>`
        },
      },
    ],
  })
}

// Synchronously fill math placeholders in `html` from items pushed onto
// `pendingMath` during the current marked.parse() pass. Items are matched by
// the placeholder id via DOM lookup (not string match — see below). When KaTeX
// is loaded we splice the rendered HTML back in place, eliminating the empty-
// placeholder window that caused the streaming → final 0-height collapse +
// iOS Safari paint lag (bd0486b6).
//
// **Why DOM-based replacement, not string split/join**: the old implementation
// used literal markers like `<div class="math-block" id="${id}"></div>` and
// `out.split(marker).join(katexHtml)`. But `DOMPurify.sanitize` runs the HTML
// through the browser's native parser+serializer, which normalizes attribute
// order — `<span class="math-inline" id="X"></span>` comes out as
// `<span id="X" class="math-inline"></span>`. The literal split markers had 0
// hits, and since `renderMarkdown` already spliced the items out of
// `pendingMath` before calling here, the async `processRichBlocks()` fallback
// also couldn't see them → both KaTeX-render and `$$x$$` text-fallback paths
// were unreachable → users saw permanent blank placeholders for any message
// containing `$..$` / `$$..$$` / `\(..\)` / `\[..\]`.
//
// DOM-based replacement is attribute-order/quote/whitespace agnostic.
//
// **Trust boundary** — KaTeX HTML is NOT routed through DOMPurify (DOMPurify
// would strip the inline `style` and `aria-hidden` attributes that the formula
// rendering depends on). Safety comes from KaTeX's own HTML generator with
// `{ trust:false, throwOnError:false, strict:'ignore', output:'html' }`, which
// bounds output to KaTeX's non-script markup vocabulary. The TeX input is NOT
// HTML — it's a separate language KaTeX parses, so we're not "trusting
// pre-sanitized user HTML"; we're trusting KaTeX's generator with explicit
// `trust:false`.
function _fillMathPlaceholdersSync(html, items) {
  if (!items.length || !window.katex) return html
  // `CSS.escape` is the canonical way to escape an id for a `#selector`. id is
  // currently `math-[a-z0-9]+` (Math.random().toString(36).slice(2, 10)) — entirely
  // selector-safe today, so the helper is effectively a noop. The fallback only
  // escapes `"` and `\` (enough for *this* controlled id space when an old
  // browser lacks `CSS.escape`); it is NOT a general CSS-identifier escape.
  const escapeSel = window.CSS?.escape || ((s) => s.replace(/["\\]/g, '\\$&'))
  const container = document.createElement('div')
  container.innerHTML = html
  for (const { id, tex, display } of items) {
    const el = container.querySelector(`#${escapeSel(id)}`)
    // If the placeholder is missing (DOMPurify dropped the node, or some
    // other transformation removed it) we silently skip — the item has
    // already been spliced from `pendingMath` by the caller, so there's no
    // async fallback. This is strictly stricter than the old behaviour, but
    // DOMPurify default config keeps `id` on `div`/`span`, so a miss here is
    // a real bug to investigate rather than silently fall through.
    if (!el) continue
    let katexHtml
    try {
      katexHtml = window.katex.renderToString(tex, {
        displayMode: display,
        throwOnError: false,
        output: 'html',
        strict: 'ignore',
        trust: false,
      })
    } catch (err) {
      const cls = display ? 'math-block math-error' : 'math-inline math-error'
      const tag = display ? 'div' : 'span'
      katexHtml = `<${tag} class="${cls}">KaTeX error: ${htmlSafeEscape(err?.message || String(err))}</${tag}>`
    }
    // outerHTML replacement detaches `el`; the other placeholder nodes
    // remain reachable via container.querySelector on subsequent loop
    // iterations. KaTeX output is parsed by the browser as a new subtree
    // (no DOMPurify pass — see trust-boundary note above).
    el.outerHTML = katexHtml
  }
  return container.innerHTML
}

export function renderMarkdown(text) {
  if (!text) return ''
  if (!window.marked) return embedMediaUrls(htmlSafeEscape(text).replace(/\n/g, '<br>'))
  _codexDisplayMathDead = false
  // Snapshot pendingMath length so we can splice exactly the items pushed by
  // this parse call (and not race with anything queued by a prior streaming
  // pass that hasn't been drained yet).
  const mathBefore = pendingMath.length
  try {
    const html = marked.parse(text)
    if (!window.DOMPurify) {
      // DOMPurify is a security-critical dependency — refuse to render unsanitized HTML
      return '<p style="color:var(--danger)">[安全组件加载失败,无法渲染富文本。请刷新页面。]</p>'
    }
    const sanitized = DOMPurify.sanitize(html, {
      // NOTE: iframe/srcdoc/sandbox NOT allowed here — htmlpreview iframes are created
      // separately in processRichBlocks() with fixed sandbox="allow-scripts"
      ADD_ATTR: ['loading', 'controls', 'preload', 'autoplay', 'data-img-action', 'data-img-src'],
    })
    // Sync-fill math placeholders before embedMediaUrls so we don't pay the
    // cost of rescanning KaTeX-emitted markup for media-looking tokens.
    let withMath = sanitized
    if (window.katex && pendingMath.length > mathBefore) {
      const items = pendingMath.splice(mathBefore)
      withMath = _fillMathPlaceholdersSync(sanitized, items)
    }
    return embedMediaUrls(withMath)
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
    const alt =
      typeof hrefOrObj === 'object' ? hrefOrObj.text || hrefOrObj.title || '' : title || text || ''
    return `<span class="streaming-img-placeholder">[图片: ${htmlSafeEscape(alt || '...')}]</span>`
  }
  return _streamingRenderer
}

export function renderStreamingMarkdown(text) {
  if (!text) return ''
  const renderer = _getStreamingRenderer()
  if (!renderer || !window.marked) return htmlSafeEscape(text).replace(/\n/g, '<br>')
  _codexDisplayMathDead = false
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
    try {
      await ensureMermaid()
    } catch {}
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
