// OpenClaude — UI helpers (toast, modal, lightbox)
import { $, htmlSafeEscape } from './dom.js'

let _toastTimer = null
export function toast(msg, kind) {
  const el = $('toast')
  el.innerHTML = `${htmlSafeEscape(msg)} <button onclick="this.parentElement.classList.remove('show')" style="margin-left:8px;background:none;border:none;color:inherit;cursor:pointer;opacity:0.7;font-size:14px">&times;</button>`
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
