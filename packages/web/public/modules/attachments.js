// OpenClaude — Attachments
import { $ } from './dom.js'
import { state } from './state.js'
import { toast } from './ui.js'
import { _basename, formatSize } from './util.js'

const MAX_FILE_SIZE_SMALL = 5 * 1024 * 1024 // 5MB for images/text
const MAX_FILE_SIZE_LARGE = 25 * 1024 * 1024 // 25MB for audio/video/docs
const MAX_TOTAL_SIZE = 50 * 1024 * 1024 // 50MB total (matches server limit)
const MAX_FILES = 5

export function fileToDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(r.result)
    r.onerror = () => rej(r.error)
    r.readAsDataURL(file)
  })
}
export function fileToText(file) {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(r.result)
    r.onerror = () => rej(r.error)
    r.readAsText(file)
  })
}

// 限定 classifyFile 的 'text' 出口。file-input 已无 accept 白名单(鸿蒙/国产内核
// 的系统选择器会按 accept 灰掉文件不可选),任意文件都可能进来 —— 默认必须是
// 'file' 而不是 'text',防 ≤5MB 未知 binary 被 fileToText 读成乱码塞进消息。
const TEXT_EXTS =
  /\.(txt|md|json|yaml|yml|csv|log|xml|html|htm|js|ts|tsx|py|go|rs|java|c|cpp|h|sh|sql)$/i

// 浏览器对部分压缩档给出的 MIME(application/x-rar-compressed 变体等)不在后端
// isUploadMimeAllowed 的稳定前缀里,上传时显式降级 application/octet-stream
// (后端显式接受)。zip/gzip 的标准 MIME 后端本就放行,不需要降级。
const ARCHIVE_EXTS_OCTET_FALLBACK = /\.(rar|7z|tar|gz|tgz|bz2|xz|zst)$/i

export function classifyFile(file) {
  const t = (file.type || '').toLowerCase()
  const name = (file.name || '').toLowerCase()
  if (t.startsWith('image/')) return 'image'
  if (t.startsWith('audio/')) return 'audio'
  if (t.startsWith('video/')) return 'video'
  // 明确文本判定 — MIME 是 text/* 或常见文本 application/* 或扩展名命中文本白名单
  if (
    t.startsWith('text/') ||
    t === 'application/json' ||
    t === 'application/xml' ||
    t === 'application/javascript' ||
    t === 'text/javascript' ||
    TEXT_EXTS.test(name)
  ) {
    return 'text'
  }
  // 其余一律 'file' — 包括已知文档(.pdf/.docx/...)、压缩档(.zip/.rar/.7z/...)
  // 以及任何浏览器没识别出 MIME 的未知二进制。后端 isUploadMimeAllowed 决定
  // 哪些 MIME 通得过;uploadAttachment 对压缩档做 octet-stream 兜底。
  return 'file'
}

export async function addFiles(fileList) {
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
        // dataUrl is kept only for the local thumbnail preview; the bytes are
        // sent over the independent HTTP channel via the original File ref
        // (att.file) — NOT inlined into the WS message frame. att.file is
        // transient (lives only in state.attachments) and is never persisted.
        att.dataUrl = await fileToDataURL(f)
        att.file = f
      }
      state.attachments.push(att)
    } catch (err) {
      toast(`读取 ${f.name} 失败: ${err}`, 'error')
    }
  }
  renderAttachments()
}
export function removeAttachment(idx) {
  state.attachments.splice(idx, 1)
  renderAttachments()
}

// Upload one non-text attachment over the independent HTTP channel.
// Resolves to the server's `{ ok, ref, mimeType, name, sizeHint }`; the caller
// puts `ref` (an `upload:<file>` token) on the WS media frame instead of base64.
// onProgress(pct) is called with an integer 0–100 as bytes go out.
export function uploadAttachment(att, onProgress) {
  return new Promise((resolve, reject) => {
    // 压缩档 MIME 浏览器间不稳定(x-rar-compressed 变体等),显式降级
    // octet-stream 保证过后端 isUploadMimeAllowed;空 MIME 同样兜底。
    const isArchive = att.kind === 'file' && ARCHIVE_EXTS_OCTET_FALLBACK.test(att.name || '')
    const uploadMime = isArchive
      ? 'application/octet-stream'
      : att.type || 'application/octet-stream'
    const qs = new URLSearchParams({ name: att.name, mime: uploadMime, kind: att.kind })
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/attachments?${qs}`)
    if (state.token) xhr.setRequestHeader('Authorization', `Bearer ${state.token}`)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      let body = null
      try {
        body = JSON.parse(xhr.responseText)
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && body?.ok) {
        resolve(body)
      } else {
        reject(new Error(body?.error || `上传失败 (${xhr.status})`))
      }
    }
    xhr.onerror = () => reject(new Error('网络错误'))
    xhr.send(att.file)
  })
}
export function renderAttachments() {
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
    size.textContent = a._uploadPct != null ? `上传 ${a._uploadPct}%` : formatSize(a.size)
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
