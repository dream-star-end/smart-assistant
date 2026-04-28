// OpenClaude — Real .docx export
//
// Builds a real OOXML document (not HTML-as-doc) using the vendored `docx` library.
// Prefers the already-rendered DOM so that Mermaid SVGs, Chart canvases, KaTeX nodes
// and highlighted code are captured "what you see is what you get". Falls back to
// markdown re-rendering when a message is not in the DOM (e.g. off-screen history).

import { renderMarkdown } from './markdown.js?v=794d698'
import { toast } from './ui.js?v=794d698'

// ── Lazy loader for the ~840KB docx library ──
let _docxLoadPromise = null
function _loadDocx() {
  if (window.docx) return Promise.resolve(window.docx)
  if (_docxLoadPromise) return _docxLoadPromise
  _docxLoadPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = '/vendor/docx.min.js'
    s.onload = () => {
      if (window.docx) resolve(window.docx)
      else {
        _docxLoadPromise = null
        reject(new Error('docx global missing after load'))
      }
    }
    s.onerror = () => {
      _docxLoadPromise = null
      reject(new Error('Failed to load docx library'))
    }
    document.head.appendChild(s)
  })
  return _docxLoadPromise
}

function _ts() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

function _triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function _sanitizeFilename(name) {
  return (name || 'openclaude').replace(/[^\p{L}\p{N}_.-]/gu, '_').slice(0, 80)
}

// ── Image pipeline ──
// docx 9 `ImageRun` only accepts the raw types "png" | "jpg" | "gif" | "bmp" (SVG has a separate
// variant that requires a PNG fallback). We therefore MUST NOT mislabel e.g. webp bytes as "png".
// Unsupported formats are rasterized to PNG through a canvas. All network reads go through a
// timed fetch that checks Content-Type, so ad-hoc same-origin GETs can't be laundered through the
// export path.
const FETCH_TIMEOUT_MS = 10000
const MAX_DEPTH = 24 // guard against pathological markdown nesting

async function _fetchWithTimeout(url, ms, init) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...(init || {}), signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function _probeDims(blob) {
  const url = URL.createObjectURL(blob)
  try {
    return await new Promise((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve({ width: i.naturalWidth || 600, height: i.naturalHeight || 400 })
      i.onerror = () => reject(new Error('image dims load failed'))
      i.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

// Rasterize any image Blob (webp/svg/avif/apng/…) to a PNG ArrayBuffer.
async function _rasterizeBlobToPng(blob) {
  const url = URL.createObjectURL(blob)
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error('rasterize image load failed'))
      i.src = url
    })
    const width = Math.max(1, img.naturalWidth || 600)
    const height = Math.max(1, img.naturalHeight || 400)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2d context unavailable')
    ctx.drawImage(img, 0, 0)
    const data = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => {
        if (!b) return reject(new Error('canvas toBlob null'))
        b.arrayBuffer().then(resolve).catch(reject)
      }, 'image/png')
    })
    return { data, type: 'png', width, height }
  } finally {
    URL.revokeObjectURL(url)
  }
}

// Normalize a Blob into { data, type, width, height } where type is one of docx's supported formats.
async function _blobToSupported(blob) {
  const mime = (blob.type || '').toLowerCase().split(';')[0].trim()
  let type = null
  if (mime === 'image/png') type = 'png'
  else if (mime === 'image/jpeg' || mime === 'image/jpg') type = 'jpg'
  else if (mime === 'image/gif') type = 'gif'
  else if (mime === 'image/bmp' || mime === 'image/x-ms-bmp' || mime === 'image/x-bmp') type = 'bmp'
  if (type) {
    const data = await blob.arrayBuffer()
    const dims = await _probeDims(blob)
    return { data, type, ...dims }
  }
  // SVG Blobs get the dedicated _svgToPng path so we pick up xmlns normalization and viewBox-based
  // dimension fallback (important for SVGs whose <img> sizes aren't layout-computed). Before
  // rasterization we strip scripts/foreignObject and any external href/url(...) references —
  // otherwise the raster step could cause the browser to issue additional requests on behalf of
  // untrusted fetched SVG content (Codex-flagged network-boundary risk).
  if (mime === 'image/svg+xml') {
    try {
      const text = await blob.text()
      const parser = new DOMParser()
      const svgDoc = parser.parseFromString(text, 'image/svg+xml')
      const svgEl = svgDoc.documentElement
      if (svgEl && svgEl.tagName && svgEl.tagName.toLowerCase() === 'svg') {
        _sanitizeExternalRefsInSvg(svgEl)
        return await _svgToPng(svgEl)
      }
    } catch (_) {
      // fall through to generic rasterization
    }
  }
  // Unsupported natively (webp, avif, apng, etc.) → rasterize to PNG via canvas.
  return await _rasterizeBlobToPng(blob)
}

// Strip external href / url(...) references and scripting-capable elements from an SVG DOM tree.
// Only applied to SVGs fetched from arbitrary remote origins — live-DOM SVGs that already rendered
// on the page are trusted. Preserved: `#id` fragments (internal gradient/filter defs) and
// binary-only `data:` URIs (png/jpg/gif/bmp/webp/avif/apng). Stripped: `data:image/svg+xml`,
// `data:text/*`, `data:application/xml` and other text-based data URIs — they can re-embed
// external refs that the rasterizer would honour on second parse.
//
// Why cover every attribute + <style> text: SVG painter attrs (`fill`/`stroke`/`filter`/`mask`/
// `clip-path`/`marker-*`) can take `url(...)` values, and a `<style>` block can pull external
// resources via `@import` or `url(...)` declarations. Missing any of these lets the rasterizer
// still issue network requests.
function _sanitizeExternalRefsInSvg(svgEl) {
  // `data:` URIs carrying text-based formats (SVG/CSS/XML/HTML) can themselves embed external
  // references which the rasterizer will honour on second parse — effectively a side-channel
  // around this sanitizer. We therefore treat those as "external" and strip them. Opaque binary
  // image types (png/jpg/gif/bmp/webp/avif/apng) stay local because they can't re-fetch anything.
  const SAFE_DATA_PREFIX = /^data:image\/(png|jpe?g|gif|bmp|webp|avif|apng)(;|,)/i
  const isExternal = (v) => {
    const t = (v || '').trim()
    if (!t) return false
    if (t.startsWith('#')) return false
    const lower = t.toLowerCase()
    if (lower.startsWith('data:')) return !SAFE_DATA_PREFIX.test(lower)
    return true // http(s), protocol-relative, absolute-path, file:, etc. — all non-local, strip.
  }
  // Remove every url(...) whose target is external; leaves #fragment and safe-binary data: intact.
  const stripCssUrls = (css) =>
    (css || '').replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (m, _q, u) => (isExternal(u) ? 'none' : m))
  // Also strip @import statements pointing external.
  const stripImports = (css) =>
    (css || '').replace(/@import[^;]*;?/gi, (stmt) => {
      const m = /url\(\s*(['"]?)([^)'"]+)\1\s*\)|(['"])([^'"]+)\3/.exec(stmt)
      const target = m ? (m[2] || m[4] || '') : ''
      return isExternal(target) ? '' : stmt
    })

  // Gather all elements (documentElement + descendants). NodeFilter.SHOW_ELEMENT = 0x1.
  const doc = svgEl.ownerDocument || document
  const walker = doc.createTreeWalker(svgEl, 0x1)
  const els = [svgEl]
  let n
  while ((n = walker.nextNode())) els.push(n)

  const removeLater = []
  for (const e of els) {
    const tag = (e.tagName || '').toLowerCase()
    // Drop <script> and <foreignObject> entirely — both can bring in external resources or escape
    // the SVG sandbox (foreignObject reparses HTML with its own href/src handling).
    if (tag === 'script' || tag === 'foreignobject') {
      removeLater.push(e)
      continue
    }
    // <style>: try to scrub external url(...)/@import; if nothing sensible remains, drop it.
    if (tag === 'style') {
      const cleaned = stripImports(stripCssUrls(e.textContent || ''))
      if (cleaned.trim()) e.textContent = cleaned
      else removeLater.push(e)
      continue
    }
    if (!e.attributes) continue
    for (const attr of Array.from(e.attributes)) {
      const name = attr.name.toLowerCase()
      const val = attr.value || ''
      // Any href-like attribute: drop if external.
      if ((name === 'href' || name === 'xlink:href' || name.endsWith(':href') || name === 'src')) {
        if (isExternal(val)) e.removeAttribute(attr.name)
        continue
      }
      // Any attribute containing url(...): scrub external targets but keep local ones.
      if (/url\(/i.test(val)) {
        const cleaned = stripCssUrls(val)
        if (cleaned !== val) e.setAttribute(attr.name, cleaned)
      }
    }
  }
  for (const e of removeLater) e.parentNode?.removeChild(e)
  return svgEl
}

// Convert an SVG element to PNG by serializing and rasterizing through a 2x-scaled canvas.
async function _svgToPng(svgEl) {
  const serializer = new XMLSerializer()
  let svgStr = serializer.serializeToString(svgEl)
  if (!/xmlns=["']http:\/\/www\.w3\.org\/2000\/svg["']/.test(svgStr)) {
    // Match both `<svg ` (with attrs) and `<svg>` (bare). Guard with a lookahead so `<svgfoo` doesn't match.
    svgStr = svgStr.replace(/^<svg(?=[\s>])/i, '<svg xmlns="http://www.w3.org/2000/svg"')
  }
  const bbox = svgEl.getBoundingClientRect()
  const viewBox = svgEl.viewBox?.baseVal
  const width = Math.max(1, Math.round(viewBox?.width || bbox.width || 600))
  const height = Math.max(1, Math.round(viewBox?.height || bbox.height || 400))
  const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error('svg image load failed'))
      i.src = url
    })
    const scale = 2 // hidpi raster for readable diagrams
    const canvas = document.createElement('canvas')
    canvas.width = width * scale
    canvas.height = height * scale
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2d context unavailable')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const data = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => {
        if (!b) return reject(new Error('canvas toBlob null'))
        b.arrayBuffer().then(resolve).catch(reject)
      }, 'image/png')
    })
    return { data, type: 'png', width, height }
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function _canvasToPng(canvasEl) {
  const blob = await new Promise((resolve, reject) => {
    canvasEl.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas toBlob null'))), 'image/png')
  })
  const data = await blob.arrayBuffer()
  return {
    data,
    type: 'png',
    width: Math.max(1, canvasEl.width || canvasEl.clientWidth || 600),
    height: Math.max(1, canvasEl.height || canvasEl.clientHeight || 400),
  }
}

// Resolve an <img src> to a supported image buffer. Accepts http(s), data:, blob: (same-origin
// object URLs produced by this page) and same-origin root-relative; rejects any other scheme.
// fetch() natively decodes both base64 and plain data: URLs, so we don't parse them by hand anymore.
// Note on cross-origin http(s): images that display without CORS headers will fail to fetch here —
// we intentionally degrade to an "[图片加载失败]" placeholder rather than proxy, because a proxy
// would expand the export path's network reach.
async function _fetchImageBySrc(src) {
  const isData = src.startsWith('data:')
  const isBlobUrl = src.startsWith('blob:')
  const isHttp = src.startsWith('http://') || src.startsWith('https://')
  const isRootRel = src.startsWith('/') && !src.startsWith('//')
  if (!isData && !isBlobUrl && !isHttp && !isRootRel) {
    throw new Error(`refusing unsupported image scheme: ${src.slice(0, 16)}`)
  }
  // data: / blob: URLs are local, so credentials/timeout don't really apply, but we still run them
  // through the shared fetch helper for consistency and cheap bounds on pathological resolvers.
  const init = isData || isBlobUrl ? {} : { credentials: 'same-origin' }
  const res = await _fetchWithTimeout(src, FETCH_TIMEOUT_MS, init)
  if (!res.ok) throw new Error(`fetch ${src} -> ${res.status}`)
  const ct = (res.headers.get('content-type') || '').toLowerCase()
  // data:/blob: always produce a typed Blob from fetch(); we only sanity-check network fetches.
  // Network fetches must advertise an image/* content-type — missing headers are treated as a
  // reject so the export path can't be coerced into a generic GET channel.
  if (!isData && !isBlobUrl && !ct.startsWith('image/')) {
    throw new Error(`unexpected content-type: ${ct || '(empty)'}`)
  }
  const blob = await res.blob()
  return await _blobToSupported(blob)
}

// Parents where a whitespace-only text node is source-formatting noise, not content.
const BLOCK_WS_PARENTS = new Set([
  'ul', 'ol', 'li', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'div', 'section', 'article',
])

function _scaleDims(w, h, maxWidth = 560) {
  if (!w || !h) return { width: maxWidth, height: Math.round(maxWidth * 0.6) }
  if (w <= maxWidth) return { width: w, height: h }
  return { width: maxWidth, height: Math.round((h * maxWidth) / w) }
}

// ── Core: DOM -> docx blocks ──
// Context is passed down so list/heading/code-block state survives recursion.
function _makeCtx(docx) {
  return {
    docx,
    numberingRefs: [], // {reference, levels: [{level, format, text}]}
    _numId: 0,
  }
}

// Allocate a new numbering reference for a single <ul> or <ol>. We allocate one per list element
// (including nested children) rather than sharing references across nesting levels, because the
// ul/ol chain in Markdown doesn't follow a fixed bullet-then-decimal cycle — each nested list's
// type is determined by its own tag. Indentation communicates nesting depth.
function _allocNumbering(ctx, ordered, depth) {
  const { LevelFormat, AlignmentType } = ctx.docx
  const reference = `num-${ctx._numId++}`
  const bullets = ['\u2022', '\u25E6', '\u25AA']
  const levels = [
    {
      level: 0,
      format: ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
      text: ordered ? '%1.' : bullets[depth % bullets.length],
      alignment: AlignmentType.LEFT,
      style: {
        paragraph: { indent: { left: 360 * (depth + 1), hanging: 260 } },
      },
    },
  ]
  ctx.numberingRefs.push({ reference, levels })
  return reference
}

// Inline: collect TextRun/ExternalHyperlink from an inline-ish node tree.
// Block-level children encountered inside (should be rare for markdown AI output) are flattened.
function _inlineRuns(node, style, ctx) {
  const { TextRun, ExternalHyperlink } = ctx.docx
  const runs = []
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.nodeValue || ''
    // Drop whitespace-only text nodes that sit between block-level siblings (e.g. "<li>foo\n<ul>…").
    // Inline whitespace (between <strong>/<em>/<code>/etc.) is preserved since those parents aren't
    // in BLOCK_WS_PARENTS.
    if (!/\S/.test(text)) {
      const parentTag = node.parentNode?.tagName?.toLowerCase() || ''
      if (BLOCK_WS_PARENTS.has(parentTag)) return runs
    }
    runs.push(new TextRun({ text, ...style }))
    return runs
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return runs
  const el = node
  const tag = el.tagName.toLowerCase()
  if (tag === 'br') {
    runs.push(new TextRun({ break: 1, ...style }))
    return runs
  }
  if (tag === 'img') {
    // Images inside paragraphs are handled at block level; inline skip to avoid recursion complexity.
    return runs
  }
  const nextStyle = { ...style }
  if (tag === 'strong' || tag === 'b') nextStyle.bold = true
  else if (tag === 'em' || tag === 'i') nextStyle.italics = true
  else if (tag === 'del' || tag === 's' || tag === 'strike') nextStyle.strike = true
  else if (tag === 'u') nextStyle.underline = {}
  else if (tag === 'code') {
    nextStyle.font = { name: 'Consolas' }
    nextStyle.shading = { type: 'clear', fill: 'F5F5F5' }
  } else if (tag === 'sup') nextStyle.superScript = true
  else if (tag === 'sub') nextStyle.subScript = true

  if (tag === 'a') {
    const href = el.getAttribute('href') || ''
    const childRuns = []
    for (const c of el.childNodes) childRuns.push(..._inlineRuns(c, nextStyle, ctx))
    if (href && /^https?:/i.test(href) && childRuns.length) {
      runs.push(new ExternalHyperlink({ link: href, children: childRuns }))
    } else {
      runs.push(...childRuns)
    }
    return runs
  }

  // KaTeX: the original LaTeX source is available on .katex-mathml <annotation> or katex-html textContent.
  // We emit the plain textContent in italics as a readable fallback.
  if (el.classList && el.classList.contains('katex')) {
    const mathml = el.querySelector('annotation[encoding="application/x-tex"]')
    const tex = mathml?.textContent || el.textContent || ''
    if (tex) runs.push(new TextRun({ text: tex, italics: true, font: { name: 'Cambria Math' } }))
    return runs
  }

  for (const c of el.childNodes) runs.push(..._inlineRuns(c, nextStyle, ctx))
  return runs
}

// Build an ImageRun wrapped in a Paragraph, given a source element (img/svg/canvas).
async function _embedImage(el, ctx) {
  const { Paragraph, ImageRun, AlignmentType } = ctx.docx
  try {
    const tag = el.tagName.toLowerCase()
    let buf
    if (tag === 'svg') buf = await _svgToPng(el)
    else if (tag === 'canvas') buf = await _canvasToPng(el)
    else {
      // Prefer currentSrc so <picture>/srcset-selected assets are exported, not the fallback src.
      const src = el.currentSrc || el.getAttribute('src') || ''
      if (!src) return null
      buf = await _fetchImageBySrc(src)
    }
    const { width, height } = _scaleDims(buf.width, buf.height)
    return new Paragraph({
      alignment: AlignmentType.LEFT,
      children: [
        new ImageRun({
          data: buf.data,
          type: buf.type, // always one of png|jpg|gif|bmp after normalization
          transformation: { width, height },
        }),
      ],
      spacing: { before: 120, after: 120 },
    })
  } catch (e) {
    // Image unreachable / rejected — degrade to alt-text placeholder so the reader isn't confused.
    const alt = el.getAttribute?.('alt') || ''
    const txt = alt ? `[图片: ${alt}]` : '[图片加载失败]'
    return new Paragraph({
      children: [new ctx.docx.TextRun({ text: txt, italics: true, color: '888888' })],
    })
  }
}

function _headingLevel(tag, HeadingLevel) {
  const map = { h1: HeadingLevel.HEADING_1, h2: HeadingLevel.HEADING_2, h3: HeadingLevel.HEADING_3, h4: HeadingLevel.HEADING_4, h5: HeadingLevel.HEADING_5, h6: HeadingLevel.HEADING_6 }
  return map[tag]
}

// Render a <pre><code>…</code></pre> — emit one paragraph per line, monospace + shaded.
function _codeBlockParagraphs(preEl, ctx) {
  const { Paragraph, TextRun } = ctx.docx
  const codeEl = preEl.querySelector('code') || preEl
  const text = codeEl.textContent || ''
  const lines = text.replace(/\n$/, '').split('\n')
  const out = []
  // Optional language label (messages.js wraps it in <span class="code-lang">)
  const langEl = preEl.querySelector('.code-lang')
  if (langEl) {
    out.push(
      new Paragraph({
        spacing: { before: 120, after: 40 },
        children: [new TextRun({ text: langEl.textContent || '', italics: true, color: '888888', size: 18 })],
      }),
    )
  }
  for (const line of lines) {
    out.push(
      new Paragraph({
        shading: { type: 'clear', fill: 'F5F5F5' },
        spacing: { before: 0, after: 0, line: 300 },
        children: [new TextRun({ text: line || ' ', font: { name: 'Consolas' }, size: 20 })],
      }),
    )
  }
  out.push(new Paragraph({ spacing: { before: 0, after: 120 }, children: [] }))
  return out
}

// Tags that should break the inline run inside a <p> or <li>: inline images, explicit media
// children, and any known block-level wrapper (div/section/figure + markdown-block containers).
const LI_BLOCK_TAGS = new Set([
  'p', 'ul', 'ol', 'pre', 'table', 'blockquote', 'hr',
  'div', 'section', 'figure', 'figcaption',
  'img', 'svg', 'canvas',
])

// CSS classes that host already-rendered rich content (the live-DOM WYSIWYG path). If one of these
// appears inside a <li>/<p>, we must treat it as a block chunk or the structure is lost.
const RICH_CONTAINER_CLASSES = ['mermaid-block', 'chart-block', 'katex-display', 'htmlpreview-block']

function _hasRichClass(el) {
  if (el.nodeType !== Node.ELEMENT_NODE || !el.classList) return false
  for (const c of RICH_CONTAINER_CLASSES) if (el.classList.contains(c)) return true
  return false
}

// If `el` is an <a> whose only significant child is a single <img>/<svg>/<canvas>, return that
// media element. This lets `[![alt](img)](url)` be exported as a block image instead of dropping it
// (the hyperlink can't be wrapped around the ImageRun without special-case docx APIs, so we keep
// the image visible and accept losing the click-through — the URL is still in the message text).
function _linkedMediaChild(el) {
  if (el.nodeType !== Node.ELEMENT_NODE) return null
  if ((el.tagName || '').toLowerCase() !== 'a') return null
  let media = null
  for (const c of el.childNodes) {
    if (c.nodeType === Node.TEXT_NODE) {
      if (!/\S/.test(c.nodeValue || '')) continue
      return null // text content — not a pure media link
    }
    if (c.nodeType === Node.ELEMENT_NODE) {
      const t = (c.tagName || '').toLowerCase()
      if (t === 'img' || t === 'svg' || t === 'canvas') {
        if (media) return null // more than one media child — bail
        media = c
        continue
      }
      return null // other element (br, span with text, …) — not a pure media link
    }
  }
  return media
}

// Split a <p> into alternating inline/media chunks so that inline images (e.g. `- ![alt](x.png)`)
// stay attached to the list item instead of being dropped by _inlineRuns(). Shared between the
// list path and the top-level <p> path.
function _decomposeParagraph(pEl, ctx) {
  const chunks = [] // [{kind:'inline', runs}|{kind:'block', el}]
  let currentRuns = []
  const flushInline = () => {
    if (currentRuns.length) {
      chunks.push({ kind: 'inline', runs: currentRuns })
      currentRuns = []
    }
  }
  for (const c of pEl.childNodes) {
    if (c.nodeType === Node.ELEMENT_NODE) {
      const t = c.tagName.toLowerCase()
      if (t === 'img' || t === 'svg' || t === 'canvas' || _hasRichClass(c)) {
        flushInline()
        chunks.push({ kind: 'block', el: c })
        continue
      }
      // `[![alt](img)](url)` → `<a><img/></a>`: promote the wrapped image to a block chunk so it isn't lost.
      const linked = _linkedMediaChild(c)
      if (linked) {
        flushInline()
        chunks.push({ kind: 'block', el: linked })
        continue
      }
    }
    currentRuns.push(..._inlineRuns(c, {}, ctx))
  }
  flushInline()
  return chunks
}

// Render a list element (`<ul>` / `<ol>`) into paragraphs. Each list allocates its own numbering
// reference; nesting depth drives left indent. Block-level children of `<li>` (nested lists,
// `<pre>`, `<table>`, `<blockquote>`, additional `<p>`, div/section/figure wrappers, inline
// images, and rich-content containers like .mermaid-block) are emitted as independent paragraphs
// / tables keeping the bullet on the first chunk and indented continuation on the rest —
// otherwise they'd be flattened or dropped.
async function _listParagraphs(listEl, ctx, depth = 0, stackDepth = 0) {
  if (stackDepth > MAX_DEPTH) return [_depthOverflowParagraph(listEl, ctx)]
  const { Paragraph, TextRun } = ctx.docx
  const ordered = listEl.tagName.toLowerCase() === 'ol'
  const reference = _allocNumbering(ctx, ordered, depth)
  const indentLeft = 360 * (depth + 1)
  const out = []
  for (const li of listEl.children) {
    if (li.tagName.toLowerCase() !== 'li') continue
    // Split li contents into "chunks" in source order. Each chunk becomes one paragraph / table:
    // first chunk gets the bullet/number, subsequent chunks are indented but unnumbered.
    const chunks = [] // [{kind:'inline', runs}|{kind:'block', el}]
    let currentInline = []
    const flushInline = () => {
      if (currentInline.length) {
        chunks.push({ kind: 'inline', runs: currentInline })
        currentInline = []
      }
    }
    for (const child of li.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const t = child.tagName.toLowerCase()
        if (t === 'p') {
          // Decompose <p> so inline images inside it become their own block chunks. This preserves
          // markdown like `- ![x](x.png) trailing text`.
          flushInline()
          chunks.push(..._decomposeParagraph(child, ctx))
          continue
        }
        if (LI_BLOCK_TAGS.has(t) || _hasRichClass(child)) {
          flushInline()
          chunks.push({ kind: 'block', el: child })
          continue
        }
        // `<a><img/></a>` directly under <li>: promote the wrapped media to a block chunk.
        const linked = _linkedMediaChild(child)
        if (linked) {
          flushInline()
          chunks.push({ kind: 'block', el: linked })
          continue
        }
      }
      currentInline.push(..._inlineRuns(child, {}, ctx))
    }
    flushInline()

    let bulleted = false
    const emitBullet = (runs) => {
      out.push(new Paragraph({ numbering: { reference, level: 0 }, children: runs }))
      bulleted = true
    }
    for (const chunk of chunks) {
      if (chunk.kind === 'inline') {
        if (!bulleted) emitBullet(chunk.runs)
        else out.push(new Paragraph({ indent: { left: indentLeft }, children: chunk.runs }))
      } else {
        if (!bulleted) emitBullet([new TextRun({ text: '' })])
        const el = chunk.el
        const t = el.tagName.toLowerCase()
        if (t === 'ul' || t === 'ol') {
          out.push(...(await _listParagraphs(el, ctx, depth + 1, stackDepth + 1)))
        } else if (t === 'img' || t === 'svg' || t === 'canvas') {
          const p = await _embedImage(el, ctx)
          if (p) out.push(p)
        } else {
          out.push(...(await _blockFromEl(el, ctx, stackDepth + 1)))
        }
      }
    }
    if (!chunks.length) emitBullet([new TextRun({ text: '' })])
  }
  return out
}

// Fallback when nesting exceeds MAX_DEPTH — we keep the raw text so the document isn't silently empty.
function _depthOverflowParagraph(el, ctx) {
  const txt = (el.textContent || '').slice(0, 2000)
  return new ctx.docx.Paragraph({
    children: [new ctx.docx.TextRun({ text: txt || '[嵌套过深,已折叠]', italics: true, color: '888888' })],
  })
}

function _tableFromEl(tableEl, ctx) {
  const { Table, TableRow, TableCell, Paragraph, TextRun, WidthType, BorderStyle } = ctx.docx
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'D0D0D0' }
  const borders = { top: border, bottom: border, left: border, right: border }
  const rows = []
  const rowEls = tableEl.querySelectorAll('tr')
  rowEls.forEach((tr, rIdx) => {
    const cells = []
    tr.querySelectorAll('th,td').forEach((td) => {
      const isHeader = td.tagName.toLowerCase() === 'th' || rIdx === 0
      const runs = []
      for (const c of td.childNodes) runs.push(..._inlineRuns(c, isHeader ? { bold: true } : {}, ctx))
      const alignAttr = td.getAttribute('align') || td.style?.textAlign || ''
      const alignment = alignAttr === 'right' ? ctx.docx.AlignmentType.RIGHT : alignAttr === 'center' ? ctx.docx.AlignmentType.CENTER : ctx.docx.AlignmentType.LEFT
      cells.push(
        new TableCell({
          borders,
          shading: isHeader ? { type: 'clear', fill: 'F5F5F5' } : undefined,
          children: [new Paragraph({ alignment, children: runs.length ? runs : [new TextRun({ text: '' })] })],
        }),
      )
    })
    if (cells.length) rows.push(new TableRow({ children: cells }))
  })
  if (!rows.length) return null
  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE }, borders: { ...borders, insideHorizontal: border, insideVertical: border } })
}

// Top-level: map a block-level element to docx paragraphs/tables/[]. `stackDepth` guards against
// pathological markdown (e.g. thousands of nested blockquotes) blowing the JS stack; we truncate.
async function _blockFromEl(el, ctx, stackDepth = 0) {
  if (stackDepth > MAX_DEPTH) return [_depthOverflowParagraph(el, ctx)]
  if (el.nodeType === Node.TEXT_NODE) {
    const txt = (el.nodeValue || '').trim()
    if (!txt) return []
    return [new ctx.docx.Paragraph({ children: [new ctx.docx.TextRun({ text: txt })] })]
  }
  if (el.nodeType !== Node.ELEMENT_NODE) return []
  const tag = el.tagName.toLowerCase()
  const { Paragraph, TextRun, HeadingLevel, BorderStyle } = ctx.docx

  if (/^h[1-6]$/.test(tag)) {
    const runs = []
    for (const c of el.childNodes) runs.push(..._inlineRuns(c, {}, ctx))
    return [new Paragraph({ heading: _headingLevel(tag, HeadingLevel), children: runs })]
  }
  if (tag === 'p') {
    // Paragraphs may contain inline images/svg/canvas/rich-block containers — split them out into
    // their own paragraphs. Reuses the same decomposition as list items so behaviour stays aligned.
    const chunks = _decomposeParagraph(el, ctx)
    const segments = []
    for (const chunk of chunks) {
      if (chunk.kind === 'inline') {
        segments.push(new Paragraph({ children: chunk.runs, spacing: { before: 80, after: 80 } }))
      } else {
        const t = chunk.el.tagName.toLowerCase()
        if (t === 'img' || t === 'svg' || t === 'canvas') {
          const p = await _embedImage(chunk.el, ctx)
          if (p) segments.push(p)
        } else {
          // rich-class container (mermaid/chart/htmlpreview) — route through _blockFromEl so it
          // picks up the svg/canvas lookup logic below.
          segments.push(...(await _blockFromEl(chunk.el, ctx, stackDepth + 1)))
        }
      }
    }
    return segments.length ? segments : [new Paragraph({ children: [new TextRun({ text: '' })] })]
  }
  if (tag === 'pre') return _codeBlockParagraphs(el, ctx)
  if (tag === 'ul' || tag === 'ol') return await _listParagraphs(el, ctx, 0, stackDepth + 1)
  if (tag === 'blockquote') {
    const quoteStyle = {
      indent: { left: 360 },
      border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'D0D0D0', space: 8 } },
      spacing: { before: 80, after: 80 },
    }
    const out = []
    // Each direct child paragraph becomes one indented/bordered paragraph.
    // Non-paragraph children (rare: nested code/list/table) pass through unadorned.
    const pushRuns = (runs) => {
      if (runs.length) out.push(new Paragraph({ ...quoteStyle, children: runs }))
    }
    let pendingRuns = []
    for (const c of el.childNodes) {
      if (c.nodeType === Node.ELEMENT_NODE) {
        const t = c.tagName.toLowerCase()
        if (t === 'p') {
          pushRuns(pendingRuns)
          pendingRuns = []
          const runs = []
          for (const inner of c.childNodes) runs.push(..._inlineRuns(inner, {}, ctx))
          pushRuns(runs)
          continue
        }
        if (t === 'pre' || t === 'ul' || t === 'ol' || t === 'table' || t === 'blockquote') {
          pushRuns(pendingRuns)
          pendingRuns = []
          const nested = await _blockFromEl(c, ctx, stackDepth + 1)
          out.push(...nested)
          continue
        }
      }
      pendingRuns.push(..._inlineRuns(c, {}, ctx))
    }
    pushRuns(pendingRuns)
    return out
  }
  if (tag === 'hr') {
    return [
      new Paragraph({
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC' } },
        children: [],
      }),
    ]
  }
  if (tag === 'table') {
    const t = _tableFromEl(el, ctx)
    return t ? [t, new Paragraph({ children: [] })] : []
  }
  if (tag === 'img') {
    const p = await _embedImage(el, ctx)
    return p ? [p] : []
  }
  if (tag === 'svg') {
    const p = await _embedImage(el, ctx)
    return p ? [p] : []
  }
  if (tag === 'canvas') {
    const p = await _embedImage(el, ctx)
    return p ? [p] : []
  }
  // Mermaid block: already rendered SVG inside .mermaid-block — walk children
  if (el.classList?.contains('mermaid-block') || el.classList?.contains('chart-block')) {
    const svg = el.querySelector('svg')
    if (svg) {
      const p = await _embedImage(svg, ctx)
      return p ? [p] : []
    }
    const canvas = el.querySelector('canvas')
    if (canvas) {
      const p = await _embedImage(canvas, ctx)
      return p ? [p] : []
    }
    // Not yet rendered — fall through to children (text content)
  }
  // Generic container (div/section/figure/…): walk childNodes so mixed inline + block content keeps
  // both. A pure `el.children` loop would silently drop surrounding text (Codex-flagged SHOULD:
  // `<div>前缀 <img> 后缀</div>` would lose "前缀"/"后缀"). Inline children (text + inline tags) are
  // coalesced into paragraphs between block children.
  const out = []
  let pendingRuns = []
  const flushInline = () => {
    if (pendingRuns.length) {
      out.push(new Paragraph({ children: pendingRuns }))
      pendingRuns = []
    }
  }
  for (const c of el.childNodes) {
    if (c.nodeType === Node.ELEMENT_NODE) {
      const t = c.tagName.toLowerCase()
      if (LI_BLOCK_TAGS.has(t) || /^h[1-6]$/.test(t) || _hasRichClass(c)) {
        flushInline()
        out.push(...(await _blockFromEl(c, ctx, stackDepth + 1)))
        continue
      }
      // `<a><img/></a>` inside a generic container: treat as a block image so it isn't silently lost.
      const linked = _linkedMediaChild(c)
      if (linked) {
        flushInline()
        const p = await _embedImage(linked, ctx)
        if (p) out.push(p)
        continue
      }
    }
    // text nodes + inline elements (span/strong/em/code/a/…) → run accumulator
    pendingRuns.push(..._inlineRuns(c, {}, ctx))
  }
  flushInline()
  return out
}

// Given a container element holding the rendered message body, produce docx blocks.
// Walks `childNodes` (not `children`) so top-level text + inline-node + block mixes are preserved
// — live `.msg-body` can start with a bare text node, or `<p>` can sit next to a raw `<img>` /
// `<a><img/></a>`. Matches the mixed-content handling the generic container branch uses.
async function _containerToBlocks(container, ctx) {
  const { Paragraph } = ctx.docx
  const blocks = []
  let pendingRuns = []
  const flushInline = () => {
    if (pendingRuns.length) {
      blocks.push(new Paragraph({ children: pendingRuns }))
      pendingRuns = []
    }
  }
  for (const child of container.childNodes) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const t = child.tagName.toLowerCase()
      if (LI_BLOCK_TAGS.has(t) || /^h[1-6]$/.test(t) || _hasRichClass(child)) {
        flushInline()
        blocks.push(...(await _blockFromEl(child, ctx, 0)))
        continue
      }
      const linked = _linkedMediaChild(child)
      if (linked) {
        flushInline()
        const p = await _embedImage(linked, ctx)
        if (p) blocks.push(p)
        continue
      }
    }
    pendingRuns.push(..._inlineRuns(child, {}, ctx))
  }
  flushInline()
  return blocks
}

// Fallback: render markdown to a detached container and convert. Rich blocks (mermaid/chart/katex)
// degrade to plain code/text since they rely on async processors that mutate the live DOM.
function _mdToContainer(text) {
  const html = renderMarkdown(text || '')
  const div = document.createElement('div')
  div.innerHTML = html
  return div
}

function _liveBodyForMessage(msgId) {
  const el = document.querySelector(`.msg[data-msg-id="${CSS.escape(msgId)}"] .msg-body`)
  return el || null
}

async function _buildAndDownload({ blocks, ctx, filename, title, subtitle }) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = ctx.docx
  const header = []
  if (title) {
    header.push(
      new Paragraph({
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.LEFT,
        children: [new TextRun({ text: title })],
      }),
    )
  }
  if (subtitle) {
    header.push(
      new Paragraph({
        spacing: { after: 240 },
        children: [new TextRun({ text: subtitle, italics: true, color: '888888' })],
      }),
    )
  }
  const doc = new Document({
    creator: 'OpenClaude',
    title: title || 'OpenClaude',
    description: 'Exported from OpenClaude',
    numbering: { config: ctx.numberingRefs },
    styles: {
      default: {
        document: { run: { font: 'Microsoft YaHei', size: 22 } },
      },
    },
    sections: [
      {
        properties: {
          page: { margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } },
        },
        children: [...header, ...blocks],
      },
    ],
  })
  const blob = await Packer.toBlob(doc)
  _triggerDownload(blob, filename)
}

// ── Public API ──

export async function exportMessageDocx(msg, opts = {}) {
  try {
    const docx = await _loadDocx()
    const ctx = _makeCtx(docx)
    const liveBody = _liveBodyForMessage(msg.id)
    const container = liveBody || _mdToContainer(msg.text)
    const blocks = await _containerToBlocks(container, ctx)
    if (!blocks.length) {
      blocks.push(new docx.Paragraph({ children: [new docx.TextRun({ text: msg.text || '' })] }))
    }
    const safeTitle = _sanitizeFilename(opts.title || 'openclaude')
    await _buildAndDownload({
      blocks,
      ctx,
      filename: `${safeTitle}-${_ts()}.docx`,
      title: opts.title || '',
      subtitle: opts.subtitle || '',
    })
  } catch (e) {
    console.error('exportMessageDocx failed', e)
    toast('Word 导出失败: ' + (e?.message || e), 'error')
  }
}

export async function exportSessionDocx(sess) {
  if (!sess) return
  try {
    const docx = await _loadDocx()
    const ctx = _makeCtx(docx)
    const { Paragraph, TextRun, HeadingLevel } = docx
    const blocks = []
    for (const m of sess.messages) {
      if (m.role === 'user') {
        blocks.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: '👤 User' })] }))
      } else if (m.role === 'assistant') {
        blocks.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: '🤖 Assistant' })] }))
      } else if (m.role === 'tool') {
        blocks.push(new Paragraph({ children: [new TextRun({ text: `🔧 ${m.text || ''}`, italics: true, color: '888888' })] }))
        continue
      } else {
        continue
      }
      const live = _liveBodyForMessage(m.id)
      const container = live || _mdToContainer(m.text)
      const parts = await _containerToBlocks(container, ctx)
      if (!parts.length && m.text) {
        parts.push(new Paragraph({ children: [new TextRun({ text: m.text })] }))
      }
      blocks.push(...parts)
      blocks.push(new Paragraph({ children: [] }))
    }
    const safeTitle = _sanitizeFilename(sess.title || 'session')
    await _buildAndDownload({
      blocks,
      ctx,
      filename: `${safeTitle}-${_ts()}.docx`,
      title: sess.title || 'OpenClaude 会话',
      subtitle: `Exported from OpenClaude · ${new Date().toLocaleString()}`,
    })
    toast('已导出 Word', 'success')
  } catch (e) {
    console.error('exportSessionDocx failed', e)
    toast('Word 导出失败: ' + (e?.message || e), 'error')
  }
}
