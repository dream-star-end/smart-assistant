// OpenClaude — Attachments
import { $ } from './dom.js?v=89a853f'
import { state } from './state.js?v=89a853f'
import { toast } from './ui.js?v=89a853f'
import { _basename, formatSize } from './util.js?v=89a853f'

const MAX_FILE_SIZE_SMALL = 200 * 1024 * 1024 // 200MB single file
const MAX_FILE_SIZE_LARGE = 200 * 1024 * 1024 // 200MB single file
const MAX_TOTAL_SIZE = 300 * 1024 * 1024 // 300MB total (matches server limit)
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

export function classifyFile(file) {
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
        att.dataUrl = await fileToDataURL(f)
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
