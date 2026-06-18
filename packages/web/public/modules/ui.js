// OpenClaude — UI helpers (toast, modal, lightbox)
import { $, htmlSafeEscape } from './dom.js?v=3ef84d0a'

let _toastTimer = null
/**
 * toast(msg, kind, opts?)
 *   - kind: 'error' | 'warn' | ...(由 CSS 决定)。'error' 显示更久(8s vs 2.5s)。
 *   - opts.code       : 后端 error.code(UNAUTHORIZED / RATE_LIMITED / …)
 *   - opts.requestId  : 后端 error.request_id,渲染成尾徽章,点击 → 复制到剪贴板
 *   - opts.issues     : 后端 validation issues(保留,渲染详情)
 *
 * 2026-04-23 改造:之前所有 catch 只打 e.message,用户截图无任何 trace;
 * 现在 toast 尾部稳定地渲染 `[CODE · req_abc123]`,点 request_id 可复制。
 * 运维拿到这串可直接 grep journalctl -u openclaude 回追单次请求全量上下文。
 */
export function toast(msg, kind, opts) {
  const el = $('toast')
  const code = opts?.code
  const reqId = opts?.requestId
  let tail = ''
  if (code || reqId) {
    const codePart = code ? `<span style="opacity:0.75;margin-right:6px">${htmlSafeEscape(String(code))}</span>` : ''
    const reqPart = reqId
      ? `<button type="button" data-copy-reqid="${htmlSafeEscape(String(reqId))}" title="点击复制 request_id" style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);color:inherit;cursor:pointer;font-family:var(--font-mono,ui-monospace,monospace);font-size:11px;padding:1px 6px;border-radius:3px;margin-left:4px;opacity:0.8">req:${htmlSafeEscape(String(reqId).slice(0,8))}…</button>`
      : ''
    tail = `<div style="margin-top:4px;font-size:11px;opacity:0.85">${codePart}${reqPart}</div>`
  }
  el.innerHTML = `<div>${htmlSafeEscape(msg)} <button onclick="this.closest('.toast').classList.remove('show')" style="margin-left:8px;background:none;border:none;color:inherit;cursor:pointer;opacity:0.7;font-size:14px">&times;</button></div>${tail}`
  el.className = `toast show${kind ? ` ${kind}` : ''}`
  el.style.pointerEvents = 'auto'
  // 点击 req 徽章 → 复制完整 request_id 到剪贴板(带回显"已复制")
  // 注意:按钮只显示前 8 位 + "…",真正要复制的是 data-copy-reqid 里的完整串。
  // fallback 必须把完整串塞进临时 textarea 再 select,否则退回到 Ctrl+C 只能
  // 拿到截断显示文本(codex R2 #4)。
  const copyBtn = el.querySelector('[data-copy-reqid]')
  if (copyBtn) {
    copyBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation()
      const v = copyBtn.getAttribute('data-copy-reqid') || ''
      const flash = () => {
        copyBtn.textContent = '已复制'
        setTimeout(() => {
          // toast 可能已 dismiss 被复用 → 元素不在就跳过
          if (copyBtn.isConnected) copyBtn.textContent = `req:${v.slice(0,8)}…`
        }, 1500)
      }
      try {
        await navigator.clipboard.writeText(v)
        flash()
        return
      } catch {}
      // fallback:临时 textarea 承载完整 request_id,execCommand copy 拉过去
      try {
        const ta = document.createElement('textarea')
        ta.value = v
        ta.setAttribute('readonly', '')
        ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0'
        document.body.appendChild(ta)
        ta.select()
        ta.setSelectionRange(0, v.length)
        const ok = document.execCommand && document.execCommand('copy')
        document.body.removeChild(ta)
        if (ok) flash()
      } catch {}
    })
  }
  if (_toastTimer) clearTimeout(_toastTimer)
  // error 类型带 code/reqId 时延到 8s,给用户时间看/点复制
  const duration = kind === 'error' ? (code || reqId ? 8000 : 5000) : 2500
  _toastTimer = setTimeout(() => {
    el.classList.remove('show')
    el.style.pointerEvents = ''
  }, duration)
}

/**
 * 从 Error 对象里抽 toast opts —— 任何 catch(e) { toast(...) } 都可以走这里,
 * 不用每处手搓 { code: e.code, requestId: e.requestId }。
 */
export function toastOptsFromError(e) {
  if (!e) return undefined
  return { code: e.code, requestId: e.requestId, issues: e.issues }
}

let _modalFocusReturn = null
let _activeFocusTrap = null
const _focusTrapStack = []  // Stack for nested modals

function _getFocusable(container) {
  return container.querySelectorAll(
    'input:not([disabled]),textarea:not([disabled]),select:not([disabled]),button:not([disabled]),[tabindex]:not([tabindex="-1"])'
  )
}

export function openModal(id) {
  _modalFocusReturn = document.activeElement
  $(id).classList.add('open')
  const modal = $(id).querySelector('.modal')
  if (modal) {
    // Focus first actionable button (skip readonly fields like in permission modal)
    const actionBtn = modal.querySelector('button:not([disabled]):not([data-close-modal])')
    const fallback = modal.querySelector('input:not([readonly]),textarea:not([readonly]),select,button:not([disabled])')
    const target = actionBtn || fallback
    if (target) setTimeout(() => target.focus(), 50)
    // Focus trap: Tab cycles within the modal. Stacked for nested modals.
    if (_activeFocusTrap) _focusTrapStack.push(_activeFocusTrap)
    _activeFocusTrap = (e) => {
      if (e.key !== 'Tab') return
      const focusable = _getFocusable(modal)
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus() }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', _activeFocusTrap)
  }
}

export function closeModal(id) {
  const el = $(id)
  if (!el?.classList.contains('open')) return  // Already closed, don't tear down traps
  el.classList.remove('open')
  if (_activeFocusTrap) {
    document.removeEventListener('keydown', _activeFocusTrap)
    _activeFocusTrap = _focusTrapStack.pop() || null
    // Re-attach parent trap if nested
    if (_activeFocusTrap) document.addEventListener('keydown', _activeFocusTrap)
  }
  if (_modalFocusReturn) {
    try {
      _modalFocusReturn.focus()
    } catch {}
    _modalFocusReturn = null
  }
}

// ── confirmDialog ────────────────────────────────────────────────────────
// 可访问的应用内确认弹窗,替代原生 confirm()(原生弹窗无暗色/无焦点陷阱,且可被
// 浏览器"阻止此页弹窗"压制 → 危险操作无确认直接执行)。返回 Promise<boolean>。
// 复用 openModal/closeModal(焦点陷阱栈 + 焦点归还),内容用 textContent(无 XSS)。
const _CONFIRM_MODAL_ID = 'oc-confirm-modal'
let _confirmChain = Promise.resolve()

function _ensureConfirmModal() {
  let modal = $(_CONFIRM_MODAL_ID)
  if (modal) return modal
  modal = document.createElement('div')
  modal.id = _CONFIRM_MODAL_ID
  modal.className = 'modal-backdrop'
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-modal', 'true')
  modal.setAttribute('aria-labelledby', 'oc-confirm-title')
  modal.innerHTML = `
    <div class="modal settings-modal" style="max-width:420px">
      <div class="modal-head">
        <div class="modal-title-block">
          <div class="modal-title-row"><span class="modal-icon" aria-hidden="true" data-c-icon></span><h3 id="oc-confirm-title" data-c-title></h3></div>
          <p class="modal-subtitle" id="oc-confirm-body" data-c-body></p>
        </div>
        <button class="modal-close" data-c-cancel aria-label="关闭">×</button>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" data-c-cancel></button>
        <button class="btn" data-c-ok></button>
      </div>
    </div>`
  document.body.appendChild(modal)
  return modal
}

export function confirmDialog(opts = {}) {
  const {
    title = '',
    body = '',
    confirmText = '确定',
    cancelText = '取消',
    danger = false,
    icon = '',
  } = opts
  // 串行化:并发调用时排队,避免第二次 clobber 共享弹窗的内容/监听器。
  const run = () =>
    new Promise((resolve) => {
      const modal = _ensureConfirmModal()
      const iconEl = modal.querySelector('[data-c-icon]')
      const titleEl = modal.querySelector('[data-c-title]')
      const bodyEl = modal.querySelector('[data-c-body]')
      const okBtn = modal.querySelector('[data-c-ok]')
      const cancelBtns = Array.from(modal.querySelectorAll('[data-c-cancel]'))
      const ghostCancel = modal.querySelector('.btn[data-c-cancel]')
      iconEl.textContent = icon || ''
      iconEl.style.display = icon ? '' : 'none'
      titleEl.textContent = title || ''
      bodyEl.textContent = body || ''
      bodyEl.style.display = body ? '' : 'none'
      // aria-describedby 仅在有正文时指向正文节点
      if (body) modal.setAttribute('aria-describedby', 'oc-confirm-body')
      else modal.removeAttribute('aria-describedby')
      okBtn.textContent = confirmText
      okBtn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`
      if (ghostCancel) ghostCancel.textContent = cancelText // × 保持 "×"
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        okBtn.removeEventListener('click', onOk)
        for (const b of cancelBtns) b.removeEventListener('click', onCancel)
        modal.removeEventListener('click', onBackdrop)
        document.removeEventListener('keydown', onKey, true)
        closeModal(_CONFIRM_MODAL_ID)
        resolve(value)
      }
      const onOk = () => finish(true)
      const onCancel = () => finish(false)
      const onBackdrop = (e) => {
        if (e.target === modal) finish(false)
      }
      const onKey = (e) => {
        if (e.key === 'Escape' && modal.classList.contains('open')) {
          // capture 阶段 + stopImmediatePropagation:阻止全局 Escape(bubble)把
          // 底层 modal 一起关掉(嵌套确认场景)。只关确认弹窗本身。
          e.preventDefault()
          e.stopImmediatePropagation()
          finish(false)
        }
      }
      okBtn.addEventListener('click', onOk)
      for (const b of cancelBtns) b.addEventListener('click', onCancel)
      modal.addEventListener('click', onBackdrop)
      document.addEventListener('keydown', onKey, true)
      openModal(_CONFIRM_MODAL_ID)
    })
  const p = _confirmChain.then(run, run)
  _confirmChain = p.catch(() => {})
  return p
}

export function openLightbox(el) {
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

export function closeLightbox() {
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
