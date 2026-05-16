// OpenClaude — Attachments
// Plan B (2026-05-09): 附件不再 base64 进 messages JSON。所有 image/audio/video/file
// 走 POST /api/uploads → 服务端 sha256-named 落盘 → 拿到 url。message 里只存 url 引用。
// Text 仍按阈值二分:≤64KB 内联为 kind:'text'(走 buildMessageText),>64KB 重分类为
// 'file' 同样上传。任何 _media[i].base64 字段都不应再产生。
import { $ } from './dom.js?v=292cfd9a'
import { state } from './state.js?v=292cfd9a'
import { toast } from './ui.js?v=292cfd9a'
import { _basename, formatSize } from './util.js?v=292cfd9a'

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

// 文本扩展名白名单 — 必须明确命中才走 'text' inline 分支,否则当 binary 'file' 上传。
// 用于限定 classifyFile 的 'text' 出口。删 accept 白名单后,默认必须 'file' 而不是 'text',
// 否则用户传 .bin/.epub/.apk 等 ≤64KB 二进制小文件会被 fileToText 当文本读出乱码塞进 messages JSON。
const TEXT_EXTS = /\.(txt|md|json|yaml|yml|csv|log|xml|html|js|ts|tsx|py|go|rs|java|c|cpp|h|sh|sql)$/i

// 压缩档扩展名 — 浏览器给的 MIME(如 application/x-rar-compressed / x-7z-compressed /
// x-tar / gzip)不在后端 UPLOAD_MIME_PREFIXES 白名单内会 415;_uploadOne 对这类
// 文件主动把 content-type 降级为 application/octet-stream(后端显式 fallback)。
// 注意:这里不含 .zip — application/zip 后端原生接受,无需降级,降级反而会让落盘
// 文件变成 .octetstream 失去扩展名信息(server.ts uploadExtForMime 用 ctype 决定后缀)。
// 也不含 .exe/.apk/.jar/.dmg/.iso/.msi — 这类可执行/安装包浏览器多半给空 MIME 或
// application/octet-stream,后端两者都接受,实际能上传成功;少数浏览器会给具体 MIME
// (.exe → application/x-msdownload, .jar → application/java-archive)那种情况会 415。
// 不为它们主动降级是出于谨慎:product/security 上 boss 没明确要放开,我们让浏览器
// 默认行为决定;若未来要明确允许或拒绝可执行文件,需在前端或后端加 denylist/allowlist。
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
  // 其余一律 'file' — 包括已知文档(.pdf/.docx/...)、压缩档(.zip/.rar/.7z/...)、
  // 可执行/安装包(.exe/.apk/.jar/...)以及任何浏览器没识别出 MIME 的未知二进制。
  // 后端 isUploadMimeAllowed 决定哪些 MIME 通得过;_uploadOne 对压缩档做 octet-stream 兜底。
  return 'file'
}

// 上传单个附件到 /api/uploads。出错或被 abort 时把 att 从 state.attachments 里摘掉
// 并 toast 用户。成功时把返回的 url/serverPath 写回 att,清掉 _uploading + _objectUrl。
async function _uploadOne(att, file) {
  try {
    const ctrl = new AbortController()
    att._abort = ctrl
    // 决定上传请求的 content-type:
    //   - 压缩档(.rar/.7z/.tar/.gz/.tgz/.bz2/.xz/.zst)→ 显式 application/octet-stream
    //     绕过后端 UPLOAD_MIME_PREFIXES 拒绝。att.type 仍保留(messages JSON 用)。
    //   - 其他文件 → 用浏览器给的真实 MIME(空时 fallback 到 octet-stream,后端也接受)。
    //   保持真实 MIME 对于 PDF/DOCX/ZIP 等"后端原生支持"的格式很重要 —
    //   server.ts uploadExtForMime(ctype) 用 content-type 决定落盘扩展名,降级会丢类型。
    const name = (att.name || '').toLowerCase()
    const isArchive = att.kind === 'file' && ARCHIVE_EXTS_OCTET_FALLBACK.test(name)
    const uploadCtype = isArchive
      ? 'application/octet-stream'
      : (att.type || 'application/octet-stream')
    const resp = await fetch('/api/uploads', {
      method: 'POST',
      headers: {
        'content-type': uploadCtype,
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
