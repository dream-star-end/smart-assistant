// OpenClaude — Attachments
// Plan B (2026-05-09): 附件不再 base64 进 messages JSON。所有 image/audio/video/file
// 走 POST /api/uploads → 服务端 sha256-named 落盘 → 拿到 url。message 里只存 url 引用。
// Text 仍按阈值二分:≤64KB 内联为 kind:'text'(走 buildMessageText),>64KB 重分类为
// 'file' 同样上传。任何 _media[i].base64 字段都不应再产生。
import { $ } from './dom.js?v=a4fc2fb7'
import { state } from './state.js?v=a4fc2fb7'
import { toast } from './ui.js?v=a4fc2fb7'
import { _basename, formatSize } from './util.js?v=a4fc2fb7'

// 与 gateway server.ts 的 MAX_UPLOAD_SINGLE / MAX_UPLOAD_TOTAL 对齐。
// 单文件 200MB,会话内总附件预算 300MB(服务端 dispatchInbound 也按这个聚合校验)。
const MAX_FILE_SIZE = 200 * 1024 * 1024
const MAX_TOTAL_SIZE = 300 * 1024 * 1024
const MAX_FILES = 5
// ≤64KB 文本走 messages JSON 内联;超出则当 'file' 上传走 /api/uploads。
// 这条阈值的目的是"小文本不要绕一圈打 server",而不是空间节省 — 64KB 远小于
// 服务端 4MB 会话上限,稳妥地不会把 messages JSON 撑爆。
const TEXT_INLINE_LIMIT = 64 * 1024

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

// 上传单个附件到 /api/uploads。出错或被 abort 时把 att 从 state.attachments 里摘掉
// 并 toast 用户。成功时把返回的 url/serverPath 写回 att,清掉 _uploading + _objectUrl。
async function _uploadOne(att, file) {
  try {
    const ctrl = new AbortController()
    att._abort = ctrl
    const resp = await fetch('/api/uploads', {
      method: 'POST',
      headers: {
        'content-type': att.type || 'application/octet-stream',
        'x-filename': encodeURIComponent(att.name || 'file'),
      },
      body: file,
      signal: ctrl.signal,
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`HTTP ${resp.status}: ${text || resp.statusText}`)
    }
    const data = await resp.json()
    if (!data || typeof data.url !== 'string') {
      throw new Error('upload response missing url')
    }
    // 成功:把 url 装回 att,释放 transient objectURL,清掉 _uploading 标志
    att.url = data.url
    if (data.serverPath) att.serverPath = data.serverPath
    if (data.size) att.size = data.size
    att._uploading = false
    att._abort = null
    if (att._objectUrl) {
      try { URL.revokeObjectURL(att._objectUrl) } catch {}
      att._objectUrl = null
    }
    renderAttachments()
  } catch (err) {
    // AbortError = 用户主动 remove/clear,不要再 toast(removeAttachment 已处理)
    if (err && err.name === 'AbortError') return
    const idx = state.attachments.indexOf(att)
    if (idx >= 0) state.attachments.splice(idx, 1)
    if (att._objectUrl) {
      try { URL.revokeObjectURL(att._objectUrl) } catch {}
      att._objectUrl = null
    }
    toast(`上传 ${att.name} 失败: ${err && err.message ? err.message : err}`, 'error')
    renderAttachments()
  }
}

export async function addFiles(fileList) {
  for (const f of fileList) {
    if (state.attachments.length >= MAX_FILES) {
      toast(`最多 ${MAX_FILES} 个附件`, 'error')
      break
    }
    let kind = classifyFile(f)

    // 小文本 inline,大文本走上传(reclassify 为 'file')。这一步早于 size cap
    // 检查,但小文本永远不会触发 size cap(TEXT_INLINE_LIMIT << MAX_FILE_SIZE)。
    if (kind === 'text' && f.size > TEXT_INLINE_LIMIT) {
      kind = 'file'
    }

    if (f.size > MAX_FILE_SIZE) {
      toast(`${f.name} 超过 ${MAX_FILE_SIZE / 1024 / 1024}MB`, 'error')
      continue
    }
    const currentTotal = state.attachments.reduce((sum, a) => sum + (a.size || 0), 0)
    if (currentTotal + f.size > MAX_TOTAL_SIZE) {
      toast(`总附件大小超过 ${MAX_TOTAL_SIZE / 1024 / 1024}MB 限制`, 'error')
      break
    }
    try {
      const att = {
        name: f.name,
        size: f.size,
        type: f.type || 'application/octet-stream',
        kind,
      }
      if (kind === 'text') {
        // 小文本仍走 inline:存到 att.text,buildMessageText 会拼进 messages JSON。
        att.text = await fileToText(f)
        state.attachments.push(att)
      } else {
        // image/audio/video/file 走 /api/uploads。先 push,后异步上传 — 这样多个
        // 文件能并行起飞,UI 即时显示 _uploading 占位,不阻塞用户继续添加。
        att._uploading = true
        if (kind === 'image') {
          // 图片预览用 objectURL(transient,不进 messages),上传成功后切回 att.url
          try {
            att._objectUrl = URL.createObjectURL(f)
          } catch {}
        }
        state.attachments.push(att)
        // 不 await — 多文件可以并发上传
        _uploadOne(att, f)
      }
    } catch (err) {
      toast(`读取 ${f.name} 失败: ${err}`, 'error')
    }
  }
  renderAttachments()
}

export function removeAttachment(idx) {
  const a = state.attachments[idx]
  if (!a) return
  // abort 进行中的上传(如有),释放 objectURL,从 state 里摘掉
  if (a._abort) {
    try { a._abort.abort() } catch {}
    a._abort = null
  }
  if (a._objectUrl) {
    try { URL.revokeObjectURL(a._objectUrl) } catch {}
    a._objectUrl = null
  }
  state.attachments.splice(idx, 1)
  renderAttachments()
}

// 统一的"清空所有附件"入口 — 发送消息后 / 切会话 / 用户主动清空时调用。
// 逐项 abort 进行中的上传 + revoke objectURL,避免泄漏 + 避免上传成功后旧 att 被
// 写入新会话(因为 _uploadOne 用的是闭包里的 att 引用,虽然 splice 把它从 state
// 摘掉了,但 abort 是显式 cancel server-side 流量的最稳妥手段)。
export function clearAttachments() {
  for (const a of state.attachments) {
    if (a && a._abort) {
      try { a._abort.abort() } catch {}
      a._abort = null
    }
    if (a && a._objectUrl) {
      try { URL.revokeObjectURL(a._objectUrl) } catch {}
      a._objectUrl = null
    }
  }
  state.attachments = []
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
    if (a._uploading) item.classList.add('attach-uploading')
    if (a.kind === 'image' && (a._objectUrl || a.url)) {
      const img = document.createElement('img')
      img.className = 'attach-thumb'
      img.src = a._objectUrl || a.url
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
    if (a._uploading) {
      const spin = document.createElement('span')
      spin.className = 'attach-spinner'
      spin.textContent = '⏳'
      spin.title = '上传中…'
      item.appendChild(spin)
    }
    const rm = document.createElement('button')
    rm.className = 'attach-remove'
    rm.textContent = '×'
    rm.title = '移除'
    rm.onclick = () => removeAttachment(i)
    item.appendChild(rm)
    wrap.appendChild(item)
  })
}
