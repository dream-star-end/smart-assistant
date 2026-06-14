// Official Claude Code terminal modal.
// Runs the official `claude` CLI inside a gateway-owned PTY over /ws/claude-terminal.
import { apiFetch, apiJson, authHeaders } from './api.js'
import { $ } from './dom.js'
import { state } from './state.js'
import { closeModal, openModal, toast } from './ui.js'

const MODAL_ID = 'claude-terminal-modal'
const CONTAINER_ID = 'claude-terminal-container'
const SCROLL_CAPTURE_ID = 'claude-terminal-scroll-capture'
const CONTEXT_MENU_ID = 'claude-terminal-context-menu'
const STATUS_ID = 'claude-terminal-status'
const KILL_BTN_ID = 'claude-terminal-kill-btn'
const RECONNECT_BTN_ID = 'claude-terminal-reconnect-btn'
const NEW_OUTPUT_BTN_ID = 'claude-terminal-new-output-btn'
const MOBILE_INPUT_ID = 'claude-terminal-mobile-input'
const MOBILE_SEND_BTN_ID = 'claude-terminal-mobile-send-btn'
const MOBILE_FOCUS_BTN_ID = 'claude-terminal-mobile-focus-btn'
const COPY_BTN_ID = 'claude-terminal-copy-btn'
const SESSIONS_BTN_ID = 'claude-terminal-sessions-btn'
const SESSIONS_MENU_ID = 'claude-terminal-sessions-menu'
const SESSIONS_LIST_ID = 'claude-terminal-sessions-list'
const SESSIONS_NEW_BTN_ID = 'claude-terminal-sessions-new-btn'
const FILE_INPUT_ID = 'claude-terminal-file-input'
const FILE_UPLOAD_BTN_ID = 'claude-terminal-upload-btn'
const FILE_PANEL_BTN_ID = 'claude-terminal-files-btn'
const FILE_MODAL_ID = 'claude-terminal-files-modal'
const FILE_MODAL_UPLOAD_BTN_ID = 'claude-terminal-file-modal-upload-btn'
const FILE_PANEL_ID = 'claude-terminal-file-panel'
const FILE_DROP_HINT_ID = 'claude-terminal-drop-hint'
const FILE_UPLOAD_LIST_ID = 'claude-terminal-upload-list'
const FILE_RECENT_LIST_ID = 'claude-terminal-recent-list'
const FILE_BROWSE_PATH_ID = 'claude-terminal-browse-path'
const FILE_BROWSE_OPEN_BTN_ID = 'claude-terminal-browse-open-btn'
const FILE_BROWSE_LIST_ID = 'claude-terminal-browse-list'
const FILE_PATH_INPUT_ID = 'claude-terminal-path-input'
const FILE_DOWNLOAD_BTN_ID = 'claude-terminal-download-btn'
const FILE_PREVIEW_BTN_ID = 'claude-terminal-preview-btn'
const CLOSE_SELECTOR = '[data-claude-terminal-close]'
const FILE_MODAL_CLOSE_SELECTOR = '[data-claude-terminal-files-close]'
const CONTEXT_MENU_ACTION_SELECTOR = '[data-claude-terminal-menu-action]'
const MAX_TERMINAL_INPUT_BYTES = 32 * 1024
const RECONNECT_ATTEMPT_MIN_MS = 1500
const STALE_BACKGROUND_RECONNECT_MS = 30 * 1000
const TERMINAL_RECENT_FILES_KEY = 'openclaude:claude-terminal:recent-files'
const MAX_RECENT_TERMINAL_FILES = 40
const TERMINAL_UPLOAD_RETRY_LIMIT = 3
const QUICK_KEYS = {
  enter: '\r',
  tab: '\t',
  'ctrl-c': '\x03',
  esc: '\x1b',
  up: '\x1b[A',
  down: '\x1b[B',
}

let TerminalCtor = null
let FitAddonCtor = null
let terminal = null
let fitAddon = null
let socket = null
let resizeObserver = null
let terminalScrollDisposable = null
let reconnectRequested = false
let initialized = false
let lastMobileControlPointerAt = 0
let lastTerminalCopyPointerAt = 0
// Claude Code 是持续重绘的 TUI，xterm 会在重绘时清掉选区；这里缓存「最近一次非空选区」，
// 让用户选完到点复制之间即便发生重绘也仍能复制到刚选的内容。
// 为避免陈旧选区误导（如选后只用键盘、稍后 Ctrl+C 本应透传 SIGINT），缓存有三重边界：
// ①TTL 过期失效 ②被一次复制消费后清空 ③终端内左键起新交互/dispose 时清空。
let lastTerminalSelection = ''
let lastTerminalSelectionAt = 0
const TERMINAL_SELECTION_CACHE_TTL_MS = 4000
let terminalTouchScrollY = null
let terminalTouchScrollRemainder = 0
let terminalTouchScrollTargets = []
let terminalScrollCaptureCleanup = null
let terminalScrollPointerId = null
let terminalScrollPointerTarget = null
let terminateInFlight = false
let lastReconnectAttemptAt = 0
let pendingConnectIntent = null
let terminalSessions = []
let sessionsLoading = false
let sessionsMenuOpen = false
let terminalHiddenAt = null
let terminalReconnectTimer = null
let terminalRecentFiles = []
let terminalContextSelectionText = ''
const terminalUploads = []
let terminalBrowsePath = ''
let terminalBrowseRequestSeq = 0
let terminalFileDragDepth = 0

function byteLength(text) {
  return new TextEncoder().encode(text).length
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return ''
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`
}

function copyText(text) {
  void copyTextToClipboard(text)
}

function fallbackCopyText(text) {
  if (!text) return false
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.left = '0'
  ta.style.top = '0'
  ta.style.opacity = '0'
  ta.setAttribute('readonly', '')
  document.body.appendChild(ta)
  ta.focus({ preventScroll: true })
  ta.select()
  ta.setSelectionRange(0, ta.value.length)
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {}
  ta.remove()
  return ok
}

async function copyTextToClipboard(text) {
  if (!text) return false
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {}
  }
  return fallbackCopyText(text)
}

function visibleTerminalText() {
  if (!terminal) return ''
  const buffer = terminal.buffer.active
  const start = Number.isFinite(buffer.viewportY) ? buffer.viewportY : 0
  const end = Math.min(buffer.length, start + terminal.rows)
  const lines = []
  for (let i = start; i < end; i += 1) {
    lines.push(buffer.getLine(i)?.translateToString(true) || '')
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

function clearTerminalSelectionCache() {
  lastTerminalSelection = ''
  lastTerminalSelectionAt = 0
}

// TTL 内的缓存选区才有效，避免长时间后的陈旧选区误导复制/Ctrl+C。
function cachedTerminalSelection() {
  if (!lastTerminalSelection.trim()) return ''
  if (Date.now() - lastTerminalSelectionAt > TERMINAL_SELECTION_CACHE_TTL_MS) {
    clearTerminalSelectionCache()
    return ''
  }
  return lastTerminalSelection
}

function selectedTerminalText() {
  const xtermSelection = terminal?.hasSelection?.() ? terminal.getSelection() : ''
  if (xtermSelection.trim()) return xtermSelection
  // 实时选区已被 TUI 重绘清掉时，用最近捕获的选区兜底（TTL/消费/新交互三重边界，不发陈旧值）。
  const cached = cachedTerminalSelection()
  if (cached.trim()) return cached

  const selection = window.getSelection?.()
  const text = selection?.toString() || ''
  const container = $(CONTAINER_ID)
  if (!text.trim() || !container || !selection?.rangeCount) return ''
  if (selection.anchorNode && container.contains(selection.anchorNode)) return text
  if (selection.focusNode && container.contains(selection.focusNode)) return text
  return ''
}

async function copyTerminalContent({ mode = 'auto', selection = selectedTerminalText() } = {}) {
  const hasSelection = Boolean(selection.trim())
  let text = ''
  if (mode === 'selection') {
    text = selection
  } else if (mode === 'visible') {
    text = visibleTerminalText()
  } else {
    text = hasSelection ? selection : visibleTerminalText()
  }
  if (!text.trim()) {
    toast(mode === 'selection' ? '没有选中的终端内容' : '没有可复制的终端内容', 'warning')
    return
  }
  const ok = await copyTextToClipboard(text)
  if (!ok) {
    toast('复制失败，请检查浏览器剪贴板权限', 'error')
    return
  }
  const copiedSelection = mode === 'selection' || (mode === 'auto' && hasSelection)
  // 选区已被这次复制消费，清空缓存：后续 Ctrl+C 应恢复透传 SIGINT，复制按钮应回到复制可见内容。
  if (copiedSelection) clearTerminalSelectionCache()
  toast(copiedSelection ? '已复制选中内容' : '已复制当前可见终端内容', 'success')
}

async function pasteClipboardToTerminal() {
  if (!terminal) return
  if (!navigator.clipboard?.readText) {
    toast('浏览器不允许读取剪贴板，请用系统粘贴快捷键', 'error')
    return
  }
  let text = ''
  try {
    text = await navigator.clipboard.readText()
  } catch {
    toast('读取剪贴板失败，请检查浏览器权限', 'error')
    return
  }
  if (!text) {
    toast('剪贴板没有可粘贴文本', 'warning')
    return
  }
  const normalized = text.replace(/\r?\n/g, '\r')
  sendTerminalInput(normalized)
  focusTerminalIfDesktop()
}

function shellQuotePath(path) {
  return `'${String(path || '').replace(/'/g, `'\\''`)}'`
}

function terminalFileUrl(path, disposition = 'attachment') {
  const q = new URLSearchParams({ path })
  if (disposition === 'inline') q.set('disposition', 'inline')
  return `/api/claude-terminal/download?${q.toString()}`
}

async function ensureSessionCookieForTerminalFiles() {
  if (!state.token) return false
  try {
    const res = await apiFetch('/api/auth/session', {
      method: 'POST',
      headers: authHeaders(),
      timeout: 5000,
      suppressAuthRedirect: true,
    })
    return res.ok
  } catch {
    return false
  }
}

async function openTerminalFilePath(path, disposition = 'attachment', name = '') {
  if (!path) return
  const cookieOk = await ensureSessionCookieForTerminalFiles()
  if (!cookieOk) {
    toast('文件下载认证失败，请刷新或重新登录', 'error')
    return
  }
  const a = document.createElement('a')
  a.href = terminalFileUrl(path, disposition)
  if (disposition === 'inline') {
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
  } else {
    a.download = name || path.split('/').pop() || 'download'
  }
  document.body.appendChild(a)
  a.click()
  a.remove()
}

function normalizedTerminalFile(file) {
  if (!file || typeof file !== 'object') return null
  const path = typeof file.path === 'string' ? file.path : ''
  if (!path) return null
  return {
    id: file.id || `${path}:${file.size || 0}`,
    name: file.name || path.split('/').pop() || 'file',
    path,
    size: Number.isFinite(file.size) ? file.size : null,
    mimeType: file.mimeType || '',
    isDirectory: file.isDirectory === true,
    isPreviewable: file.isPreviewable === true,
    mtimeMs: Number.isFinite(file.mtimeMs) ? file.mtimeMs : null,
  }
}

function loadTerminalRecentFiles() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TERMINAL_RECENT_FILES_KEY) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.map(normalizedTerminalFile).filter(Boolean).slice(0, MAX_RECENT_TERMINAL_FILES)
  } catch {
    return []
  }
}

function saveTerminalRecentFiles() {
  try {
    localStorage.setItem(TERMINAL_RECENT_FILES_KEY, JSON.stringify(terminalRecentFiles))
  } catch {}
}

function rememberTerminalFile(file) {
  const normalized = normalizedTerminalFile(file)
  if (!normalized || normalized.isDirectory) return
  terminalRecentFiles = [
    normalized,
    ...terminalRecentFiles.filter((item) => item.path !== normalized.path),
  ].slice(0, MAX_RECENT_TERMINAL_FILES)
  saveTerminalRecentFiles()
  renderTerminalRecentFiles()
}

function pasteTerminalFilePath(path) {
  if (!path) return
  // 末尾补一个空格，便于连续插入多个路径或紧接着继续输入。
  sendTerminalInput(`${shellQuotePath(path)} `)
}

function makeTerminalFileButton(label, title, handler) {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.title = title || label
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    handler()
  })
  return button
}

function appendTerminalFileActions(row, file, options = {}) {
  const actions = document.createElement('div')
  actions.className = 'claude-terminal-file-actions'
  if (file.isDirectory) {
    actions.appendChild(
      makeTerminalFileButton('打开', '打开目录', () => loadTerminalBrowse(file.path)),
    )
  } else if (file.path && file.path !== '上传中…') {
    actions.appendChild(
      makeTerminalFileButton('下载', '下载文件', () =>
        openTerminalFilePath(file.path, 'attachment', file.name),
      ),
    )
    actions.appendChild(
      makeTerminalFileButton('预览', '预览文件', () =>
        openTerminalFilePath(file.path, 'inline', file.name),
      ),
    )
    actions.appendChild(
      makeTerminalFileButton('贴路径', '贴到终端', () => pasteTerminalFilePath(file.path)),
    )
  }
  if (file.path && file.path !== '上传中…') {
    actions.appendChild(
      makeTerminalFileButton('复制', '复制路径', () => {
        copyText(file.path)
        toast('已复制路径')
      }),
    )
  }
  if (options.cancel) actions.appendChild(options.cancel)
  row.appendChild(actions)
}

function createTerminalFileRow(file, options = {}) {
  const row = document.createElement('div')
  row.className = file.isDirectory ? 'claude-terminal-file-row is-dir' : 'claude-terminal-file-row'
  const icon = document.createElement('span')
  icon.className = 'claude-terminal-file-icon'
  icon.textContent = file.isDirectory ? '📁' : file.mimeType?.startsWith('image/') ? '🖼️' : '📄'
  row.appendChild(icon)
  const meta = document.createElement('div')
  meta.className = 'claude-terminal-file-meta'
  const name = document.createElement('div')
  name.className = 'claude-terminal-file-name'
  name.textContent = file.name
  meta.appendChild(name)
  const path = document.createElement('div')
  path.className = 'claude-terminal-file-path'
  path.textContent = file.path
  meta.appendChild(path)
  const detail = document.createElement('div')
  detail.className = 'claude-terminal-file-detail'
  detail.textContent = [
    file.isDirectory ? '目录' : formatBytes(file.size || 0),
    file.mimeType || '',
  ]
    .filter(Boolean)
    .join(' · ')
  meta.appendChild(detail)
  row.appendChild(meta)
  appendTerminalFileActions(row, file, options)
  return row
}

function renderTerminalRecentFiles() {
  const list = $(FILE_RECENT_LIST_ID)
  if (!list) return
  list.innerHTML = ''
  if (!terminalRecentFiles.length) {
    const empty = document.createElement('div')
    empty.className = 'claude-terminal-file-empty'
    empty.textContent = '还没有终端上传/下载记录'
    list.appendChild(empty)
    return
  }
  for (const file of terminalRecentFiles) list.appendChild(createTerminalFileRow(file))
}

function renderTerminalUploads() {
  const list = $(FILE_UPLOAD_LIST_ID)
  if (!list) return
  list.innerHTML = ''
  if (!terminalUploads.length) {
    const empty = document.createElement('div')
    empty.className = 'claude-terminal-file-empty'
    empty.textContent = '拖拽、粘贴或点击“上传”把文件送到服务器终端可读路径'
    list.appendChild(empty)
    return
  }
  for (const upload of terminalUploads) {
    const file = normalizedTerminalFile(upload.file) || {
      name: upload.name,
      path: upload.path || '上传中…',
      size: upload.size,
      mimeType: upload.mimeType || '',
      isDirectory: false,
      isPreviewable: false,
    }
    const cancel =
      upload.status === 'uploading'
        ? makeTerminalFileButton('取消', '取消上传', () => cancelTerminalUpload(upload))
        : null
    const row = createTerminalFileRow(file, { cancel })
    row.classList.add(`status-${upload.status}`)
    const progress = document.createElement('div')
    progress.className = 'claude-terminal-upload-progress'
    const bar = document.createElement('span')
    bar.style.width = `${Math.max(0, Math.min(100, Math.round(upload.progress || 0)))}%`
    progress.appendChild(bar)
    row.appendChild(progress)
    const status = document.createElement('div')
    status.className = 'claude-terminal-upload-status'
    status.textContent = upload.message || ''
    row.appendChild(status)
    list.appendChild(row)
  }
}

async function terminalApiGet(path) {
  const res = await apiFetch(path, { headers: authHeaders(), timeout: 60000 })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || `GET ${path} failed`)
  return data
}

async function loadTerminalBrowse(path = '') {
  const requestSeq = ++terminalBrowseRequestSeq
  const input = $(FILE_BROWSE_PATH_ID)
  if (input && path) input.value = path
  const targetPath = path || input?.value?.trim() || terminalBrowsePath || ''
  const list = $(FILE_BROWSE_LIST_ID)
  if (list) {
    list.innerHTML = ''
    const loading = document.createElement('div')
    loading.className = 'claude-terminal-file-empty'
    loading.textContent = '加载中…'
    list.appendChild(loading)
  }
  try {
    const data = await terminalApiGet(
      `/api/claude-terminal/list?path=${encodeURIComponent(targetPath)}`,
    )
    if (requestSeq !== terminalBrowseRequestSeq) return
    terminalBrowsePath = data.path || targetPath
    if (input) input.value = terminalBrowsePath
    renderTerminalBrowse(data)
  } catch (err) {
    if (requestSeq !== terminalBrowseRequestSeq) return
    if (list) {
      list.innerHTML = ''
      const empty = document.createElement('div')
      empty.className = 'claude-terminal-file-empty is-error'
      empty.textContent = err instanceof Error ? err.message : String(err)
      list.appendChild(empty)
    }
  }
}

function renderTerminalBrowse(data) {
  const list = $(FILE_BROWSE_LIST_ID)
  if (!list) return
  list.innerHTML = ''
  const header = document.createElement('div')
  header.className = 'claude-terminal-file-browser-head'
  header.appendChild(
    makeTerminalFileButton('上一级', '打开上一级目录', () =>
      loadTerminalBrowse(data.parent || '/'),
    ),
  )
  header.appendChild(
    makeTerminalFileButton('刷新', '刷新目录', () =>
      loadTerminalBrowse(data.path || terminalBrowsePath),
    ),
  )
  list.appendChild(header)
  if (!data.entries?.length) {
    const empty = document.createElement('div')
    empty.className = 'claude-terminal-file-empty'
    empty.textContent = '目录为空'
    list.appendChild(empty)
    return
  }
  for (const entry of data.entries) {
    const file = normalizedTerminalFile(entry)
    if (file) list.appendChild(createTerminalFileRow(file))
  }
}

function setTerminalFilePanelTab(name) {
  const panel = $(FILE_PANEL_ID)
  if (!panel) return
  panel.querySelectorAll('[data-terminal-file-tab]').forEach((button) => {
    const active = button.dataset.terminalFileTab === name
    button.dataset.active = active ? 'true' : 'false'
    button.setAttribute('aria-selected', active ? 'true' : 'false')
  })
  panel.querySelectorAll('[data-terminal-file-pane]').forEach((pane) => {
    pane.hidden = pane.dataset.terminalFilePane !== name
  })
  if (name === 'recent') renderTerminalRecentFiles()
  if (name === 'uploads') renderTerminalUploads()
  if (name === 'browse' && !terminalBrowsePath) void loadTerminalBrowse('')
}

function isTerminalFileModalOpen() {
  return $(FILE_MODAL_ID)?.classList.contains('open') === true
}

function closeTerminalFileModal() {
  closeModal(FILE_MODAL_ID)
}

function toggleTerminalFilePanel(forceOpen = null) {
  const panel = $(FILE_PANEL_ID)
  const modal = $(FILE_MODAL_ID)
  if (!panel || !modal) return
  const open = forceOpen ?? !isTerminalFileModalOpen()
  if (!open) {
    closeTerminalFileModal()
    return
  }
  panel.hidden = false
  openModal(FILE_MODAL_ID)
  setTerminalFilePanelTab('recent')
  renderTerminalRecentFiles()
  renderTerminalUploads()
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

async function uploadTerminalFiles(fileList, { insertPaths = false } = {}) {
  const files = [...fileList]
  if (!files.length) return
  // 拖拽/粘贴流(insertPaths)只在后台上传并把服务器路径写进终端输入，不抢占式弹出
  // 文件 modal（否则路径写进了被 modal 挡住的终端）；手动上传仍打开 uploads 面板看进度。
  if (!insertPaths) {
    toggleTerminalFilePanel(true)
    setTerminalFilePanelTab('uploads')
  }
  for (const file of files) {
    const path = await uploadOneTerminalFile(file)
    if (insertPaths && path) pasteTerminalFilePath(path)
  }
}

async function uploadOneTerminalFile(file) {
  const upload = {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: file.name || 'upload.bin',
    size: file.size || 0,
    mimeType: file.type || 'application/octet-stream',
    progress: 0,
    status: 'uploading',
    message: '准备上传…',
    uploadId: null,
    abort: false,
  }
  terminalUploads.unshift(upload)
  renderTerminalUploads()
  try {
    const start = await apiJson(
      'POST',
      '/api/claude-terminal/upload/start',
      { name: upload.name, size: upload.size, mimeType: upload.mimeType },
      { timeout: 60000 },
    )
    upload.uploadId = start.uploadId
    const chunkSize = Math.max(64 * 1024, start.chunkSize || 768 * 1024)
    let offset = 0
    let index = 0
    while (offset < file.size) {
      if (upload.abort) throw new Error('已取消')
      const end = Math.min(file.size, offset + chunkSize)
      const data = arrayBufferToBase64(await file.slice(offset, end).arrayBuffer())
      let lastErr = null
      for (let attempt = 1; attempt <= TERMINAL_UPLOAD_RETRY_LIMIT; attempt += 1) {
        try {
          await apiJson(
            'POST',
            '/api/claude-terminal/upload/chunk',
            { uploadId: upload.uploadId, offset, index, data },
            { timeout: 120000 },
          )
          lastErr = null
          break
        } catch (err) {
          lastErr = err
          upload.message = `第 ${index + 1} 块重试 ${attempt}/${TERMINAL_UPLOAD_RETRY_LIMIT}`
          renderTerminalUploads()
          await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
        }
      }
      if (lastErr) throw lastErr
      offset = end
      index += 1
      upload.progress = file.size > 0 ? (offset / file.size) * 100 : 100
      upload.message = `${formatBytes(offset)} / ${formatBytes(file.size)}`
      renderTerminalUploads()
    }
    const finished = await apiJson(
      'POST',
      '/api/claude-terminal/upload/finish',
      { uploadId: upload.uploadId },
      { timeout: 60000 },
    )
    upload.status = 'done'
    upload.progress = 100
    upload.message = '上传完成'
    upload.file = finished.file
    upload.path = finished.file?.path
    rememberTerminalFile(finished.file)
    renderTerminalUploads()
    toast(`已上传 ${upload.name}`, 'success')
    return upload.path || null
  } catch (err) {
    upload.status = upload.abort ? 'canceled' : 'error'
    upload.message = err instanceof Error ? err.message : String(err)
    if (upload.abort && upload.uploadId) {
      try {
        await apiJson('POST', '/api/claude-terminal/upload/cancel', { uploadId: upload.uploadId })
      } catch {}
    }
    renderTerminalUploads()
    if (!upload.abort) toast(`上传失败: ${upload.name}`, 'error')
    return null
  }
}

async function cancelTerminalUpload(upload) {
  upload.abort = true
  upload.status = 'canceled'
  upload.message = '已取消'
  renderTerminalUploads()
  if (!upload.uploadId) return
  try {
    await apiJson('POST', '/api/claude-terminal/upload/cancel', { uploadId: upload.uploadId })
  } catch {}
}

function setTerminalFileDropActive(active) {
  const modal = $(MODAL_ID)
  const hint = $(FILE_DROP_HINT_ID)
  modal?.classList.toggle('terminal-file-dragging', active)
  if (hint) hint.hidden = !active
}

function modalEventHasFiles(event) {
  return [...(event.dataTransfer?.types || [])].includes('Files')
}

function handleTerminalDragEnter(event) {
  if (!isModalOpen() || !modalEventHasFiles(event)) return
  event.preventDefault()
  terminalFileDragDepth += 1
  setTerminalFileDropActive(true)
}

function handleTerminalDragOver(event) {
  if (!isModalOpen() || !modalEventHasFiles(event)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}

function handleTerminalDragLeave(event) {
  if (!isModalOpen() || !modalEventHasFiles(event)) return
  event.preventDefault()
  terminalFileDragDepth = Math.max(0, terminalFileDragDepth - 1)
  if (terminalFileDragDepth === 0) setTerminalFileDropActive(false)
}

function handleTerminalDrop(event) {
  if (!isModalOpen() || !event.dataTransfer?.files?.length) return
  event.preventDefault()
  terminalFileDragDepth = 0
  setTerminalFileDropActive(false)
  void uploadTerminalFiles(event.dataTransfer.files, { insertPaths: true })
}

// 粘贴的截图常以 clipboardData.items(kind==='file') 而非 .files 出现，两路都要收。
function clipboardFilesFromEvent(event) {
  const out = [...(event.clipboardData?.files || [])]
  if (!out.length && event.clipboardData?.items) {
    for (const item of event.clipboardData.items) {
      if (item.kind === 'file') {
        const f = item.getAsFile?.()
        if (f) out.push(f)
      }
    }
  }
  return out
}

function handleTerminalPaste(event) {
  if (!isModalOpen()) return
  const files = clipboardFilesFromEvent(event)
  if (!files.length) return
  event.preventDefault()
  void uploadTerminalFiles(files, { insertPaths: true })
}

function statusLabel(stateName, fallback = '') {
  if (stateName === 'connecting') return '连接中'
  if (stateName === 'running') return '运行中'
  if (stateName === 'closed') return '已关闭'
  if (stateName === 'error') return '错误'
  if (stateName === 'disabled') return '已禁用'
  if (stateName === 'exited') return '进程已退出'
  return fallback || '未连接'
}

function setStatus(stateName, message = '') {
  const el = $(STATUS_ID)
  if (!el) return
  el.dataset.state = stateName || 'idle'
  el.textContent = message ? `${statusLabel(stateName)} · ${message}` : statusLabel(stateName)
  updateTerminalBusyButtons()
}

function terminalStatusState() {
  return $(STATUS_ID)?.dataset.state || 'idle'
}

// Give clear feedback while a connect/terminate is in flight instead of silently swallowing clicks.
function updateTerminalBusyButtons() {
  const connecting = terminalStatusState() === 'connecting'
  const kill = $(KILL_BTN_ID)
  const reconnect = $(RECONNECT_BTN_ID)
  if (kill) kill.disabled = terminateInFlight
  if (reconnect) reconnect.disabled = connecting || terminateInFlight
}

async function ensureTerminalDeps() {
  if (TerminalCtor && FitAddonCtor) return
  const [xterm, fit] = await Promise.all([
    import('/vendor/xterm/xterm.js'),
    import('/vendor/xterm/addon-fit.js'),
  ])
  TerminalCtor = xterm.Terminal
  FitAddonCtor = fit.FitAddon
}

function cssVar(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

// 终端配色随全局明暗主题切换：背景/前景/光标取实时 CSS 变量，ANSI 调色板按
// 明暗各备一套（深色面板沿用原值；浅色下另调一套更深、对比更足的色，避免发灰）。
function buildTerminalTheme() {
  const isLight = document.documentElement.dataset.theme === 'light'
  const surface = cssVar('--code-bg', isLight ? '#ffffff' : '#141418')
  const base = {
    background: surface,
    foreground: cssVar('--fg', isLight ? '#1a1a1d' : '#f2f2f2'),
    cursor: cssVar('--accent', '#d97757'),
    cursorAccent: surface,
    selectionBackground: cssVar('--accent-border', 'rgba(217,119,87,0.35)'),
  }
  const dark = {
    black: '#000000',
    red: '#d14d41',
    green: '#5ca66b',
    yellow: '#c99a2e',
    blue: '#4f8fd9',
    magenta: '#b46ad8',
    cyan: '#4fa7a8',
    white: '#d7d7d7',
    brightBlack: '#666666',
    brightRed: '#e06c64',
    brightGreen: '#7cc386',
    brightYellow: '#e0b84a',
    brightBlue: '#6aa6e8',
    brightMagenta: '#c98df0',
    brightCyan: '#72c6c8',
    brightWhite: '#ffffff',
  }
  const light = {
    black: '#2a2a30',
    red: '#c0392b',
    green: '#3f7e4e',
    yellow: '#9a6b00',
    blue: '#2d6fc0',
    magenta: '#9b3dbd',
    cyan: '#2a8385',
    white: '#5a5750',
    brightBlack: '#8a8780',
    brightRed: '#d14d41',
    brightGreen: '#4e9a63',
    brightYellow: '#b5832a',
    brightBlue: '#3f8fd9',
    brightMagenta: '#b46ad8',
    brightCyan: '#3fa7a8',
    brightWhite: '#1a1a1d',
  }
  return { ...base, ...(isLight ? light : dark) }
}

// 主题切换后由 main.js 经 late-bound 回调调用，让已打开的终端实时重着色。
export function applyTerminalTheme() {
  if (!terminal) return
  try {
    terminal.options.theme = buildTerminalTheme()
  } catch {}
}

function createTerminal() {
  disposeTerminal()
  terminal = new TerminalCtor({
    cursorBlink: true,
    convertEol: false,
    fontFamily: cssVar('--font-mono', 'ui-monospace, SFMono-Regular, Menlo, monospace'),
    fontSize: 13,
    scrollback: 4000,
    theme: buildTerminalTheme(),
  })
  fitAddon = new FitAddonCtor()
  terminal.loadAddon(fitAddon)
  terminal.onData((data) => {
    sendTerminalInput(data, false)
  })
  terminal.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }))
  // 选区一出现就捕获，避免 TUI 重绘把它清掉后复制取不到（见 lastTerminalSelection 注释）。
  terminal.onSelectionChange?.(() => {
    const selected = terminal?.getSelection?.() || ''
    if (selected.trim()) {
      lastTerminalSelection = selected
      lastTerminalSelectionAt = Date.now()
    }
  })
  terminalScrollDisposable = terminal.onScroll?.(() => {
    updateNewOutputButton()
    hideTerminalContextMenu()
  })
}

function isModalOpen() {
  return Boolean($(MODAL_ID)?.classList.contains('open'))
}

function shouldFocusTerminal() {
  return !window.matchMedia?.('(pointer: coarse)')?.matches
}

function focusTerminalIfDesktop() {
  if (shouldFocusTerminal()) terminal?.focus()
}

function attachTerminal() {
  const container = $(CONTAINER_ID)
  if (!container || !terminal) return
  container.innerHTML = ''
  terminal.open(container)
  bindTerminalTouchScrollTargets()
  bindTerminalScrollCapture()
  fitTerminal()
  // Web 字体(JetBrains Mono)常晚于首次 fit 加载，cell 高度随之变化会把末行切掉一半；
  // 字体就绪后重新 fit 并同步 PTY 尺寸。
  document.fonts?.ready
    ?.then(() => {
      if (!terminal || !isModalOpen()) return
      fitTerminal()
      if (socket?.readyState === WebSocket.OPEN) {
        send({ type: 'resize', cols: terminal.cols, rows: terminal.rows })
      }
    })
    .catch(() => {})
  focusTerminalIfDesktop()
  resizeObserver = new ResizeObserver(() => fitTerminal())
  resizeObserver.observe(container)
}

function disposeTerminal() {
  hideNewOutputButton()
  hideTerminalContextMenu()
  clearTerminalSelectionCache()
  cleanupTerminalScrollCapture()
  cleanupTerminalTouchScrollTargets()
  if (terminalScrollDisposable) {
    try {
      terminalScrollDisposable.dispose()
    } catch {}
    terminalScrollDisposable = null
  }
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  if (terminal) {
    try {
      terminal.dispose()
    } catch {}
    terminal = null
  }
  fitAddon = null
  const container = $(CONTAINER_ID)
  if (container) container.innerHTML = ''
}

function fitTerminal() {
  if (!terminal || !fitAddon) return
  if (!isModalOpen()) return
  try {
    fitAddon.fit()
  } catch {}
}

function fitVisibleTerminalSoon(focus = false) {
  requestAnimationFrame(() => {
    fitTerminal()
    if (terminal && socket?.readyState === WebSocket.OPEN) {
      send({ type: 'resize', cols: terminal.cols, rows: terminal.rows })
    }
    if (focus) focusTerminalIfDesktop()
  })
}

function activeTerminalBuffer() {
  try {
    return terminal?.buffer?.active || null
  } catch {
    return null
  }
}

function terminalAtBottom() {
  const buffer = activeTerminalBuffer()
  if (!buffer) return true
  return buffer.viewportY >= buffer.baseY
}

function showNewOutputButton() {
  const button = $(NEW_OUTPUT_BTN_ID)
  if (!button) return
  button.hidden = false
  button.setAttribute('aria-hidden', 'false')
  button.classList.add('is-visible')
}

function hideNewOutputButton() {
  const button = $(NEW_OUTPUT_BTN_ID)
  if (!button) return
  button.classList.remove('is-visible')
  button.setAttribute('aria-hidden', 'true')
  button.hidden = true
}

function updateNewOutputButton() {
  if (!terminal || terminalAtBottom()) {
    hideNewOutputButton()
  }
}

function scrollTerminalToBottom() {
  if (!terminal) return
  terminal.scrollToBottom()
  hideNewOutputButton()
}

function restoreTerminalViewport(line) {
  if (!terminal || typeof terminal.scrollToLine !== 'function') return
  const buffer = activeTerminalBuffer()
  const maxLine = Number.isFinite(buffer?.baseY) ? buffer.baseY : line
  const targetLine = Math.max(0, Math.min(line, maxLine))
  terminal.scrollToLine(targetLine)
}

function writeTerminalOutput(data) {
  if (!terminal) return
  const buffer = activeTerminalBuffer()
  const wasAtBottom = terminalAtBottom()
  const previousViewportY = Number.isFinite(buffer?.viewportY) ? buffer.viewportY : 0
  let finished = false
  const afterWrite = () => {
    if (finished || !terminal) return
    finished = true
    if (!wasAtBottom) {
      restoreTerminalViewport(previousViewportY)
      showNewOutputButton()
      return
    }
    hideNewOutputButton()
  }
  try {
    if (terminal.write.length >= 2) {
      terminal.write(data, afterWrite)
    } else {
      terminal.write(data)
      requestAnimationFrame(afterWrite)
    }
  } catch {
    try {
      terminal.write(data)
    } catch {}
    requestAnimationFrame(afterWrite)
  }
}

function terminalViewportElement() {
  return $(CONTAINER_ID)?.querySelector?.('.xterm-viewport') || null
}

function terminalLineHeight() {
  const viewport = terminalViewportElement()
  if (viewport?.clientHeight && terminal?.rows) {
    return Math.max(8, viewport.clientHeight / terminal.rows)
  }
  return 16
}

function terminalViewportY() {
  const buffer = activeTerminalBuffer()
  return Number.isFinite(buffer?.viewportY) ? buffer.viewportY : null
}

function fallbackScrollTerminalViewport(lines, lineHeight) {
  const viewport = terminalViewportElement()
  if (!viewport || !Number.isFinite(lines) || lines === 0) return false
  const before = viewport.scrollTop
  const max = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
  const next = Math.max(0, Math.min(max, before + lines * lineHeight))
  if (next === before) return false
  viewport.scrollTop = next
  return true
}

function resetTerminalTouchScroll() {
  terminalTouchScrollY = null
  terminalTouchScrollRemainder = 0
  terminalScrollPointerId = null
  terminalScrollPointerTarget = null
}

function beginTerminalTouchScroll(clientY) {
  if (!terminal || !Number.isFinite(clientY)) {
    resetTerminalTouchScroll()
    return false
  }
  terminalTouchScrollY = clientY
  terminalTouchScrollRemainder = 0
  return true
}

function moveTerminalTouchScroll(clientY, event = null) {
  if (terminalTouchScrollY == null || !terminal || !Number.isFinite(clientY)) return false
  if (event?.cancelable) event.preventDefault()
  event?.stopPropagation?.()

  const currentY = clientY
  const rawDelta = terminalTouchScrollY - currentY + terminalTouchScrollRemainder
  const lineHeight = terminalLineHeight()
  const lines = rawDelta > 0 ? Math.floor(rawDelta / lineHeight) : Math.ceil(rawDelta / lineHeight)
  if (lines === 0) return true

  const beforeViewportY = terminalViewportY()
  terminal.scrollLines(lines)
  const afterViewportY = terminalViewportY()
  if (beforeViewportY == null || afterViewportY == null || beforeViewportY === afterViewportY) {
    fallbackScrollTerminalViewport(lines, lineHeight)
  }
  terminalTouchScrollY = currentY
  terminalTouchScrollRemainder = rawDelta - lines * lineHeight
  updateNewOutputButton()
  return true
}

function endTerminalTouchScroll() {
  if (terminalScrollPointerTarget && terminalScrollPointerId != null) {
    try {
      terminalScrollPointerTarget.releasePointerCapture?.(terminalScrollPointerId)
    } catch {}
  }
  resetTerminalTouchScroll()
}

function handleTerminalTouchStart(event) {
  if (event.touches.length !== 1) {
    resetTerminalTouchScroll()
    return
  }
  beginTerminalTouchScroll(event.touches[0].clientY)
}

function handleTerminalTouchMove(event) {
  if (event.touches.length !== 1) return
  moveTerminalTouchScroll(event.touches[0].clientY, event)
}

function isTerminalScrollPointer(event) {
  return event.pointerType === 'touch' || event.pointerType === 'pen'
}

function handleScrollCapturePointerDown(event) {
  if (!isTerminalScrollPointer(event)) return
  if (!beginTerminalTouchScroll(event.clientY)) return
  terminalScrollPointerId = event.pointerId
  terminalScrollPointerTarget = event.currentTarget
  try {
    event.currentTarget?.setPointerCapture?.(event.pointerId)
  } catch {}
  if (event.cancelable) event.preventDefault()
  event.stopPropagation()
}

function handleScrollCapturePointerMove(event) {
  if (terminalScrollPointerId !== event.pointerId || !isTerminalScrollPointer(event)) return
  moveTerminalTouchScroll(event.clientY, event)
}

function handleScrollCapturePointerEnd(event) {
  if (terminalScrollPointerId != null && event.pointerId !== terminalScrollPointerId) return
  if (event?.cancelable) event.preventDefault()
  event?.stopPropagation?.()
  endTerminalTouchScroll()
}

function handleScrollCaptureLostPointer(event) {
  if (terminalScrollPointerId != null && event.pointerId !== terminalScrollPointerId) return
  resetTerminalTouchScroll()
}

function handleScrollCaptureTouchStart(event) {
  if (event.touches.length !== 1) {
    resetTerminalTouchScroll()
    return
  }
  if (!beginTerminalTouchScroll(event.touches[0].clientY)) return
  if (event.cancelable) event.preventDefault()
  event.stopPropagation()
}

function handleScrollCaptureTouchMove(event) {
  if (event.touches.length !== 1) return
  moveTerminalTouchScroll(event.touches[0].clientY, event)
}

function handleScrollCaptureTouchEnd(event) {
  if (event?.cancelable) event.preventDefault()
  event?.stopPropagation?.()
  endTerminalTouchScroll()
}

function cleanupTerminalScrollCapture() {
  endTerminalTouchScroll()
  if (!terminalScrollCaptureCleanup) return
  try {
    terminalScrollCaptureCleanup()
  } catch {}
  terminalScrollCaptureCleanup = null
}

function bindTerminalScrollCapture() {
  cleanupTerminalScrollCapture()
  const overlay = $(SCROLL_CAPTURE_ID)
  if (!overlay) return

  const cleanup = []
  const add = (target, type, handler, options) => {
    target.addEventListener(type, handler, options)
    cleanup.push(() => target.removeEventListener(type, handler, options))
  }

  if (window.PointerEvent) {
    add(overlay, 'pointerdown', handleScrollCapturePointerDown, { passive: false })
    add(overlay, 'pointermove', handleScrollCapturePointerMove, { passive: false })
    add(overlay, 'pointerup', handleScrollCapturePointerEnd, { passive: false })
    add(overlay, 'pointercancel', handleScrollCapturePointerEnd, { passive: false })
    add(overlay, 'lostpointercapture', handleScrollCaptureLostPointer)
  } else {
    add(overlay, 'touchstart', handleScrollCaptureTouchStart, { passive: false })
    add(overlay, 'touchmove', handleScrollCaptureTouchMove, { passive: false })
    add(overlay, 'touchend', handleScrollCaptureTouchEnd, { passive: false })
    add(overlay, 'touchcancel', handleScrollCaptureTouchEnd, { passive: false })
  }
  add(window, 'blur', endTerminalTouchScroll)

  terminalScrollCaptureCleanup = () => {
    for (const dispose of cleanup) {
      try {
        dispose()
      } catch {}
    }
  }
}

function terminalTouchScrollTargetElements() {
  const container = $(CONTAINER_ID)
  if (!container) return []
  return [
    container,
    container.querySelector('.xterm'),
    container.querySelector('.xterm-viewport'),
    container.querySelector('.xterm-screen'),
  ].filter(Boolean)
}

function cleanupTerminalTouchScrollTargets() {
  for (const target of terminalTouchScrollTargets) {
    target.removeEventListener('touchstart', handleTerminalTouchStart, true)
    target.removeEventListener('touchmove', handleTerminalTouchMove, true)
    target.removeEventListener('touchend', endTerminalTouchScroll, true)
    target.removeEventListener('touchcancel', endTerminalTouchScroll, true)
  }
  terminalTouchScrollTargets = []
  endTerminalTouchScroll()
}

function bindTerminalTouchScrollTargets() {
  cleanupTerminalTouchScrollTargets()
  terminalTouchScrollTargets = [...new Set(terminalTouchScrollTargetElements())]
  for (const target of terminalTouchScrollTargets) {
    target.addEventListener('touchstart', handleTerminalTouchStart, {
      capture: true,
      passive: true,
    })
    target.addEventListener('touchmove', handleTerminalTouchMove, {
      capture: true,
      passive: false,
    })
    target.addEventListener('touchend', endTerminalTouchScroll, {
      capture: true,
      passive: true,
    })
    target.addEventListener('touchcancel', endTerminalTouchScroll, {
      capture: true,
      passive: true,
    })
  }
}

function scrollTerminal(action) {
  if (!terminal) return
  if (action === 'page-up') {
    terminal.scrollPages(-1)
  } else if (action === 'page-down') {
    terminal.scrollPages(1)
  } else if (action === 'bottom') {
    scrollTerminalToBottom()
  }
  updateNewOutputButton()
}

function send(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify(payload))
}

function sendTerminalInput(data, notifyDisconnected = true) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    if (notifyDisconnected) toast('终端尚未连接', 'error')
    return false
  }
  if (byteLength(data) > MAX_TERMINAL_INPUT_BYTES) {
    toast('终端输入过大，已拦截', 'error')
    return false
  }
  send({ type: 'input', data })
  return true
}

function normalizedMobileCommand(text) {
  const normalized = text.replace(/\r?\n/g, '\r')
  return normalized.endsWith('\r') ? normalized : `${normalized}\r`
}

function focusMobileInput() {
  const input = $(MOBILE_INPUT_ID)
  input?.focus()
}

function sendMobileCommand() {
  const input = $(MOBILE_INPUT_ID)
  if (!input) return
  const text = input.value
  if (!text.trim()) {
    focusMobileInput()
    return
  }
  if (sendTerminalInput(normalizedMobileCommand(text))) {
    input.value = ''
    input.style.height = ''
  }
  focusMobileInput()
}

function autoGrowMobileInput() {
  const input = $(MOBILE_INPUT_ID)
  if (!input) return
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`
}

async function readMessageData(data) {
  if (typeof data === 'string') return data
  if (data instanceof Blob) return data.text()
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
  return String(data)
}

function writeLine(text) {
  if (!terminal) return
  terminal.writeln(`\r\n${text}`)
}

function closeSocket(kill = false) {
  const ws = socket
  socket = null
  if (!ws) return
  try {
    if (kill && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'kill' }))
  } catch {}
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close()
  } catch {}
}

function terminalCanReconnect() {
  if (!isModalOpen() || !terminal || !state.token) return false
  const status = terminalStatusState()
  return status !== 'exited' && status !== 'disabled'
}

function socketIsConnectingOrOpen() {
  return socket?.readyState === WebSocket.CONNECTING || socket?.readyState === WebSocket.OPEN
}

function ensureTerminalConnected(reason = '') {
  if (!terminalCanReconnect()) return false
  if (socketIsConnectingOrOpen()) return false
  const now = Date.now()
  if (now - lastReconnectAttemptAt < RECONNECT_ATTEMPT_MIN_MS) return false
  lastReconnectAttemptAt = now
  connectTerminal(reason)
  return true
}

function clearTerminalReconnectTimer() {
  if (!terminalReconnectTimer) return
  clearTimeout(terminalReconnectTimer)
  terminalReconnectTimer = null
}

function scheduleTerminalReconnect(reason = '') {
  if (!terminalCanReconnect() || document.visibilityState === 'hidden') return false
  if (terminalReconnectTimer) return true
  const delay = Math.max(0, RECONNECT_ATTEMPT_MIN_MS - (Date.now() - lastReconnectAttemptAt))
  terminalReconnectTimer = setTimeout(() => {
    terminalReconnectTimer = null
    if (!terminalCanReconnect() || document.visibilityState === 'hidden') return
    if (!socketIsConnectingOrOpen()) ensureTerminalConnected(reason)
  }, delay)
  return true
}

function forceReconnectTerminal(reason = '') {
  if (!terminalCanReconnect()) return false
  clearTerminalReconnectTimer()
  lastReconnectAttemptAt = Date.now()
  connectTerminal(reason)
  return true
}

function connectTerminal(reason = '') {
  if (!state.token) {
    toast('请先登录 OpenClaude', 'error')
    return
  }
  clearTerminalReconnectTimer()
  lastReconnectAttemptAt = Date.now()
  closeSocket(false)
  reconnectRequested = false
  // A pending intent (new/resume) applies to this connect only; auto-reconnects reuse the live PTY.
  const intent = pendingConnectIntent
  pendingConnectIntent = null
  const intentReason =
    intent?.action === 'resume'
      ? '正在恢复历史会话'
      : intent?.action === 'new'
        ? '正在新建会话'
        : ''
  setStatus('connecting', reason || intentReason)
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  let wsUrl = `${protocol}//${location.host}/ws/claude-terminal`
  if (intent?.action === 'new') {
    wsUrl += '?action=new'
  } else if (intent?.action === 'resume' && intent.sessionId) {
    wsUrl += `?action=resume&sessionId=${encodeURIComponent(intent.sessionId)}`
  }
  const ws = new WebSocket(wsUrl, ['bearer', state.token])
  socket = ws

  ws.onopen = () => {
    if (socket !== ws) return
    setStatus('running', '官方 Claude Code 已连接')
    fitVisibleTerminalSoon(true)
    if (terminal) send({ type: 'resize', cols: terminal.cols, rows: terminal.rows })
  }

  ws.onmessage = async (event) => {
    let payload = null
    try {
      payload = JSON.parse(await readMessageData(event.data))
    } catch {
      return
    }
    if (!payload || typeof payload !== 'object') return
    if (payload.type === 'output' && typeof payload.data === 'string') {
      writeTerminalOutput(payload.data)
      return
    }
    if (payload.type === 'replay' && typeof payload.data === 'string') {
      terminal?.reset()
      if (payload.data) terminal?.write(payload.data)
      hideNewOutputButton()
      fitVisibleTerminalSoon(true)
      return
    }
    if (payload.type === 'status') {
      const message = typeof payload.message === 'string' ? payload.message : ''
      setStatus(payload.state || 'idle', message)
      if (payload.state === 'error' || payload.state === 'disabled') writeLine(message)
      return
    }
    if (payload.type === 'exit') {
      const code = payload.code == null ? 'null' : String(payload.code)
      const signal = payload.signal == null ? 'null' : String(payload.signal)
      setStatus('exited', `code=${code} signal=${signal}`)
      writeLine(`[Claude Code exited: code=${code}, signal=${signal}]`)
    }
  }

  ws.onerror = () => {
    if (socket !== ws) return
    setStatus('error', 'WebSocket 连接失败')
    socket = null
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close()
    } catch {}
    scheduleTerminalReconnect('WebSocket 连接失败，正在重连')
  }

  ws.onclose = () => {
    if (socket !== ws) return
    socket = null
    if (reconnectRequested) return
    const current = $(STATUS_ID)?.dataset.state
    if (current !== 'exited' && current !== 'error' && current !== 'disabled') setStatus('closed')
  }
}

export async function openOfficialClaudeTerminal() {
  await ensureTerminalDeps()
  openModal(MODAL_ID)
  renderTerminalRecentFiles()
  renderTerminalUploads()
  void refreshTerminalSessions()
  if (terminal) {
    fitVisibleTerminalSoon(true)
    if (
      !socket ||
      socket.readyState === WebSocket.CLOSED ||
      socket.readyState === WebSocket.CLOSING
    ) {
      connectTerminal()
    }
    return
  }
  createTerminal()
  attachTerminal()
  terminal?.writeln('OpenClaude official Claude Code terminal')
  terminal?.writeln('Starting `claude` in a server-side PTY...')
  terminal?.writeln('关闭只隐藏窗口，点“终止”才结束进程。\r\n')
  connectTerminal()
}

export function hideOfficialClaudeTerminal() {
  closeSessionsMenu()
  terminalFileDragDepth = 0
  setTerminalFileDropActive(false)
  closeTerminalFileModal()
  hideTerminalContextMenu()
  closeModal(MODAL_ID)
}

export function closeOfficialClaudeTerminal() {
  hideOfficialClaudeTerminal()
}

export function terminateOfficialClaudeTerminal() {
  void terminateOfficialClaudeTerminalAsync()
}

async function terminateOfficialClaudeTerminalAsync() {
  if (terminateInFlight) return
  hideTerminalContextMenu()
  closeSessionsMenu()
  if (!state.token) {
    toast('请先登录 OpenClaude', 'error')
    return
  }
  terminateInFlight = true
  setStatus('connecting', '正在终止 Claude Code')
  try {
    await apiJson('POST', '/api/claude-terminal/terminate', {})
    closeSocket(false)
    disposeTerminal()
    reconnectRequested = false
    setStatus('closed', '已终止，重新打开会新建终端')
  } catch (err) {
    if (socket?.readyState === WebSocket.OPEN) {
      closeSocket(true)
      disposeTerminal()
      reconnectRequested = false
      setStatus('closed', '已通过当前连接发送终止')
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    setStatus('error', '终止失败')
    toast(message || '终止 Claude Code 失败', 'error')
  } finally {
    terminateInFlight = false
    updateTerminalBusyButtons()
  }
}

function reconnectTerminal(intent = null) {
  reconnectRequested = true
  lastReconnectAttemptAt = 0
  clearTerminalReconnectTimer()
  closeSocket(false)
  pendingConnectIntent = intent
  if (!terminal) {
    createTerminal()
    attachTerminal()
  } else {
    terminal.reset()
    terminal.scrollToBottom()
    hideNewOutputButton()
  }
  connectTerminal()
}

function startNewClaudeSession() {
  closeSessionsMenu()
  if (!state.token) {
    toast('请先登录 OpenClaude', 'error')
    return
  }
  reconnectTerminal({ action: 'new' })
  toast('正在新建 Claude 会话', 'info')
}

function resumeClaudeSession(sessionId) {
  if (!sessionId) return
  closeSessionsMenu()
  if (!state.token) {
    toast('请先登录 OpenClaude', 'error')
    return
  }
  reconnectTerminal({ action: 'resume', sessionId })
  toast('正在恢复历史会话', 'info')
}

function formatSessionTime(ms) {
  if (!Number.isFinite(ms)) return ''
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  try {
    return new Date(ms).toLocaleDateString()
  } catch {
    return ''
  }
}

function renderTerminalSessions() {
  const list = $(SESSIONS_LIST_ID)
  if (!list) return
  list.innerHTML = ''
  if (sessionsLoading) {
    const empty = document.createElement('div')
    empty.className = 'claude-terminal-session-empty'
    empty.textContent = '加载中…'
    list.appendChild(empty)
    return
  }
  if (!terminalSessions.length) {
    const empty = document.createElement('div')
    empty.className = 'claude-terminal-session-empty'
    empty.textContent = '暂无历史会话'
    list.appendChild(empty)
    return
  }
  for (const session of terminalSessions) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'claude-terminal-session-item'
    item.setAttribute('role', 'menuitem')
    item.tabIndex = -1
    item.dataset.sessionId = session.sessionId
    const title = document.createElement('span')
    title.className = 'claude-terminal-session-title'
    // Title is derived from user content — render as text only.
    title.textContent = session.title || '(无标题会话)'
    item.appendChild(title)
    const meta = document.createElement('span')
    meta.className = 'claude-terminal-session-meta'
    meta.textContent = formatSessionTime(session.mtimeMs)
    if (session.live) {
      const badge = document.createElement('span')
      badge.className = 'claude-terminal-session-live'
      badge.textContent = '运行中'
      meta.appendChild(badge)
    }
    item.appendChild(meta)
    item.addEventListener('click', () => resumeClaudeSession(session.sessionId))
    list.appendChild(item)
  }
}

async function refreshTerminalSessions() {
  if (!state.token) {
    terminalSessions = []
    renderTerminalSessions()
    return
  }
  sessionsLoading = true
  renderTerminalSessions()
  try {
    const res = await apiFetch('/api/claude-terminal/sessions', {
      headers: authHeaders(),
      timeout: 15000,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data?.error || '加载历史会话失败')
    terminalSessions = Array.isArray(data.sessions) ? data.sessions : []
  } catch {
    terminalSessions = []
  } finally {
    sessionsLoading = false
    renderTerminalSessions()
  }
}

function sessionsMenuFocusables() {
  const menu = $(SESSIONS_MENU_ID)
  if (!menu) return []
  return [...menu.querySelectorAll('button:not([disabled])')]
}

function openSessionsMenu() {
  const menu = $(SESSIONS_MENU_ID)
  if (!menu) return
  menu.hidden = false
  sessionsMenuOpen = true
  $(SESSIONS_BTN_ID)?.setAttribute('aria-expanded', 'true')
  void refreshTerminalSessions()
  requestAnimationFrame(() => sessionsMenuFocusables()[0]?.focus())
}

function closeSessionsMenu() {
  sessionsMenuOpen = false
  const menu = $(SESSIONS_MENU_ID)
  $(SESSIONS_BTN_ID)?.setAttribute('aria-expanded', 'false')
  if (menu && !menu.hidden) menu.hidden = true
}

function toggleSessionsMenu() {
  if (sessionsMenuOpen) closeSessionsMenu()
  else openSessionsMenu()
}

function handleSessionsMenuKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeSessionsMenu()
    $(SESSIONS_BTN_ID)?.focus()
    return
  }
  if (event.key === 'Tab') {
    closeSessionsMenu()
    return
  }
  const items = sessionsMenuFocusables()
  if (!items.length) return
  const idx = items.indexOf(document.activeElement)
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    items[idx < 0 ? 0 : (idx + 1) % items.length]?.focus()
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    items[idx < 0 ? items.length - 1 : (idx - 1 + items.length) % items.length]?.focus()
  } else if (event.key === 'Home') {
    event.preventDefault()
    items[0]?.focus()
  } else if (event.key === 'End') {
    event.preventDefault()
    items[items.length - 1]?.focus()
  }
}

function handleSessionsMenuOutsidePointer(event) {
  if (!sessionsMenuOpen) return
  const menu = $(SESSIONS_MENU_ID)
  const button = $(SESSIONS_BTN_ID)
  if (menu?.contains(event.target) || button?.contains(event.target)) return
  closeSessionsMenu()
}

function bindTerminalSessionsControls() {
  $(SESSIONS_BTN_ID)?.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    toggleSessionsMenu()
  })
  $(SESSIONS_NEW_BTN_ID)?.addEventListener('click', () => startNewClaudeSession())
  $(SESSIONS_MENU_ID)?.addEventListener('keydown', handleSessionsMenuKeydown)
  document.addEventListener('pointerdown', handleSessionsMenuOutsidePointer, true)
}

function sendQuickKey(key, button) {
  if (!key || !QUICK_KEYS[key]) return
  sendTerminalInput(QUICK_KEYS[key])
  button?.blur?.()
}

function runMobileControl(button) {
  if (button.dataset.claudeTerminalKey) {
    sendQuickKey(button.dataset.claudeTerminalKey, button)
  } else if (button.dataset.claudeTerminalAction) {
    scrollTerminal(button.dataset.claudeTerminalAction)
    button.blur?.()
  }
}

function bindTerminalCopyButton() {
  const button = $(COPY_BTN_ID)
  if (!button) return
  button.addEventListener(
    'pointerdown',
    (event) => {
      event.preventDefault()
      event.stopPropagation()
      lastTerminalCopyPointerAt = Date.now()
      void copyTerminalContent()
      button.blur?.()
    },
    { passive: false },
  )
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (Date.now() - lastTerminalCopyPointerAt < 500) return
    void copyTerminalContent()
  })
}

function isTerminalContextMenuOpen() {
  const menu = $(CONTEXT_MENU_ID)
  return Boolean(menu && !menu.hidden)
}

function hideTerminalContextMenu() {
  const menu = $(CONTEXT_MENU_ID)
  if (!menu) return
  menu.hidden = true
  terminalContextSelectionText = ''
}

function positionTerminalContextMenu(menu, clientX, clientY) {
  menu.hidden = false
  menu.style.visibility = 'hidden'
  menu.style.left = '0px'
  menu.style.top = '0px'
  const rect = menu.getBoundingClientRect()
  const margin = 8
  const left = Math.max(margin, Math.min(clientX, window.innerWidth - rect.width - margin))
  const top = Math.max(margin, Math.min(clientY, window.innerHeight - rect.height - margin))
  menu.style.left = `${left}px`
  menu.style.top = `${top}px`
  menu.style.visibility = ''
}

function showTerminalContextMenu(clientX, clientY) {
  const menu = $(CONTEXT_MENU_ID)
  if (!menu) return
  terminalContextSelectionText = selectedTerminalText()
  const copySelectionButton = menu.querySelector(
    '[data-claude-terminal-menu-action="copy-selection"]',
  )
  if (copySelectionButton) copySelectionButton.disabled = !terminalContextSelectionText.trim()
  positionTerminalContextMenu(menu, clientX, clientY)
  // Move focus into the menu so it is keyboard-operable (matches the sessions popover).
  requestAnimationFrame(() => contextMenuFocusables()[0]?.focus())
}

function contextMenuFocusables() {
  const menu = $(CONTEXT_MENU_ID)
  if (!menu) return []
  return [...menu.querySelectorAll('button[role="menuitem"]:not([disabled])')]
}

function handleTerminalContextMenuKeydown(event) {
  if (!isTerminalContextMenuOpen()) return
  if (event.key === 'Escape') return // handled by the global Escape priority chain
  const items = contextMenuFocusables()
  if (!items.length) return
  const idx = items.indexOf(document.activeElement)
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    items[idx < 0 ? 0 : (idx + 1) % items.length]?.focus()
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    items[idx < 0 ? items.length - 1 : (idx - 1 + items.length) % items.length]?.focus()
  } else if (event.key === 'Home') {
    event.preventDefault()
    items[0]?.focus()
  } else if (event.key === 'End') {
    event.preventDefault()
    items[items.length - 1]?.focus()
  }
}

function isTerminalOutputEventTarget(target) {
  const container = $(CONTAINER_ID)
  const overlay = $(SCROLL_CAPTURE_ID)
  return Boolean(target && (container?.contains(target) || overlay?.contains(target)))
}

function handleTerminalContextMenu(event) {
  if (!isModalOpen() || !isTerminalOutputEventTarget(event.target)) return
  event.preventDefault()
  event.stopPropagation()
  showTerminalContextMenu(event.clientX, event.clientY)
}

function handleTerminalContextMenuPointerDown(event) {
  const menu = $(CONTEXT_MENU_ID)
  if (!menu || menu.hidden) return
  if (menu.contains(event.target)) return
  hideTerminalContextMenu()
}

function handleTerminalContextMenuAction(event) {
  const button = event.target?.closest?.(CONTEXT_MENU_ACTION_SELECTOR)
  if (!button) return
  event.preventDefault()
  event.stopPropagation()
  const action = button.dataset.claudeTerminalMenuAction
  const selection = terminalContextSelectionText
  hideTerminalContextMenu()
  if (action === 'copy-selection') {
    void copyTerminalContent({ mode: 'selection', selection })
  } else if (action === 'copy-visible') {
    void copyTerminalContent({ mode: 'visible' })
  } else if (action === 'paste') {
    void pasteClipboardToTerminal()
  }
}

function isEditableTerminalUiTarget(target) {
  if (!target?.matches?.('input, textarea, select')) return false
  return !target.classList?.contains('xterm-helper-textarea')
}

function shouldHandleTerminalClipboardShortcut(event) {
  if (!isModalOpen() || isTerminalFileModalOpen()) return false
  const modal = $(MODAL_ID)
  if (!modal) return false
  const target = event.target
  if (isEditableTerminalUiTarget(target)) return false
  return Boolean(
    (target && modal.contains(target)) ||
      (document.activeElement && modal.contains(document.activeElement)),
  )
}

function handleTerminalClipboardShortcut(event) {
  if (!shouldHandleTerminalClipboardShortcut(event)) return
  const key = String(event.key || '').toLowerCase()
  if ((!event.ctrlKey && !event.metaKey) || event.altKey) return

  if (key === 'c') {
    const selection = selectedTerminalText()
    if (!event.shiftKey && !selection.trim()) return
    event.preventDefault()
    event.stopPropagation()
    hideTerminalContextMenu()
    void copyTerminalContent({
      mode: event.shiftKey ? 'auto' : 'selection',
      selection,
    })
    return
  }

  if (key === 'v' && navigator.clipboard?.readText) {
    event.preventDefault()
    event.stopPropagation()
    hideTerminalContextMenu()
    void pasteClipboardToTerminal()
  }
}

function handleTerminalVisibilityResume(reason) {
  const hiddenAt = terminalHiddenAt
  terminalHiddenAt = null
  const hiddenMs = Number.isFinite(hiddenAt) ? Date.now() - hiddenAt : 0
  if (hiddenMs >= STALE_BACKGROUND_RECONNECT_MS) {
    forceReconnectTerminal(reason)
  } else {
    ensureTerminalConnected(reason)
  }
  fitVisibleTerminalSoon(false)
}

export function initOfficialClaudeTerminal() {
  if (initialized) return
  initialized = true
  terminalRecentFiles = loadTerminalRecentFiles()
  $(KILL_BTN_ID)?.addEventListener('click', () => terminateOfficialClaudeTerminal())
  $(RECONNECT_BTN_ID)?.addEventListener('click', () => reconnectTerminal())
  $(NEW_OUTPUT_BTN_ID)?.addEventListener('click', () => scrollTerminalToBottom())
  bindTerminalCopyButton()
  $(FILE_UPLOAD_BTN_ID)?.addEventListener('click', () => $(FILE_INPUT_ID)?.click())
  $(FILE_MODAL_UPLOAD_BTN_ID)?.addEventListener('click', () => $(FILE_INPUT_ID)?.click())
  $(FILE_PANEL_BTN_ID)?.addEventListener('click', () => toggleTerminalFilePanel())
  $(FILE_INPUT_ID)?.addEventListener('change', (event) => {
    if (event.target.files?.length) void uploadTerminalFiles(event.target.files)
    event.target.value = ''
  })
  $(FILE_DOWNLOAD_BTN_ID)?.addEventListener('click', () => {
    const path = $(FILE_PATH_INPUT_ID)?.value?.trim()
    if (!path) return toast('请输入要下载的路径', 'error')
    rememberTerminalFile({ name: path.split('/').pop() || path, path })
    void openTerminalFilePath(path, 'attachment')
  })
  $(FILE_PREVIEW_BTN_ID)?.addEventListener('click', () => {
    const path = $(FILE_PATH_INPUT_ID)?.value?.trim()
    if (!path) return toast('请输入要预览的路径', 'error')
    rememberTerminalFile({ name: path.split('/').pop() || path, path })
    void openTerminalFilePath(path, 'inline')
  })
  $(FILE_BROWSE_PATH_ID)?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    void loadTerminalBrowse(event.currentTarget.value.trim())
  })
  $(FILE_BROWSE_OPEN_BTN_ID)?.addEventListener('click', () => {
    void loadTerminalBrowse($(FILE_BROWSE_PATH_ID)?.value?.trim() || '')
  })
  document.querySelectorAll('[data-terminal-file-tab]').forEach((button) => {
    button.addEventListener('click', () => setTerminalFilePanelTab(button.dataset.terminalFileTab))
  })
  $(MOBILE_SEND_BTN_ID)?.addEventListener('click', () => sendMobileCommand())
  $(MOBILE_FOCUS_BTN_ID)?.addEventListener('click', () => focusMobileInput())
  bindTerminalSessionsControls()
  $(MOBILE_INPUT_ID)?.addEventListener('input', () => {
    autoGrowMobileInput()
  })
  $(MOBILE_INPUT_ID)?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
    event.preventDefault()
    sendMobileCommand()
  })
  window.addEventListener('resize', () => {
    fitTerminal()
    hideTerminalContextMenu()
    closeSessionsMenu()
  })
  document.addEventListener('dragenter', handleTerminalDragEnter)
  document.addEventListener('dragover', handleTerminalDragOver)
  document.addEventListener('dragleave', handleTerminalDragLeave)
  document.addEventListener('drop', handleTerminalDrop)
  document.addEventListener('paste', handleTerminalPaste)
  document.addEventListener('contextmenu', handleTerminalContextMenu, true)
  document.addEventListener('pointerdown', handleTerminalContextMenuPointerDown, true)
  // 在终端输出区开始新交互（左键点击/拖选起点）时清空缓存选区，避免复制到陈旧内容。
  // 只在主键(button 0)清空：右键是为了开上下文菜单复制选区，不能把缓存提前清掉。
  // 绑定在持久容器上一次即可（attachTerminal 可能多次执行，避免重复叠加监听）。
  $(CONTAINER_ID)?.addEventListener('pointerdown', (event) => {
    if (event.button === 0) clearTerminalSelectionCache()
  })
  $(CONTEXT_MENU_ID)?.addEventListener('click', handleTerminalContextMenuAction)
  $(CONTEXT_MENU_ID)?.addEventListener('keydown', handleTerminalContextMenuKeydown)
  document.addEventListener('keydown', handleTerminalClipboardShortcut, true)
  window.addEventListener('focus', () => handleTerminalVisibilityResume('窗口恢复，正在重连'))
  window.addEventListener('online', () => handleTerminalVisibilityResume('网络恢复，正在重连'))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      handleTerminalVisibilityResume('从后台恢复，正在重连')
      return
    }
    terminalHiddenAt = Date.now()
  })

  document
    .querySelectorAll('[data-claude-terminal-key], [data-claude-terminal-action]')
    .forEach((button) => {
      button.tabIndex = -1
      button.addEventListener(
        'pointerdown',
        (event) => {
          event.preventDefault()
          event.stopPropagation()
          lastMobileControlPointerAt = Date.now()
          runMobileControl(button)
        },
        { passive: false },
      )
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (Date.now() - lastMobileControlPointerAt < 500) return
        runMobileControl(button)
      })
    })

  document.addEventListener(
    'click',
    (event) => {
      const fileModal = $(FILE_MODAL_ID)
      const target = event.target
      if (fileModal?.classList.contains('open')) {
        if (target?.id === FILE_MODAL_ID || target?.closest?.(FILE_MODAL_CLOSE_SELECTOR)) {
          event.preventDefault()
          event.stopPropagation()
          closeTerminalFileModal()
          return
        }
      }
      const modal = $(MODAL_ID)
      if (!modal?.classList.contains('open')) return
      if (target?.id === MODAL_ID || target?.closest?.(CLOSE_SELECTOR)) {
        event.preventDefault()
        event.stopPropagation()
        hideOfficialClaudeTerminal()
      }
    },
    true,
  )

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape') return
      if (isTerminalContextMenuOpen()) {
        event.preventDefault()
        event.stopPropagation()
        hideTerminalContextMenu()
        return
      }
      if (sessionsMenuOpen) {
        event.preventDefault()
        event.stopPropagation()
        closeSessionsMenu()
        $(SESSIONS_BTN_ID)?.focus()
        return
      }
      if (isTerminalFileModalOpen()) {
        event.preventDefault()
        event.stopPropagation()
        closeTerminalFileModal()
        return
      }
      const modal = $(MODAL_ID)
      if (!modal?.classList.contains('open')) return
      event.preventDefault()
      event.stopPropagation()
      hideOfficialClaudeTerminal()
    },
    true,
  )
}
