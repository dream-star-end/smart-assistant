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
export function openModal(id) {
  _modalFocusReturn = document.activeElement
  $(id).classList.add('open')
  // Focus trap: focus first focusable element inside modal
  const modal = $(id).querySelector('.modal')
  if (modal) {
    const focusable = modal.querySelector('input,textarea,select,button:not([disabled])')
    if (focusable) setTimeout(() => focusable.focus(), 50)
  }
}

export function closeModal(id) {
  $(id).classList.remove('open')
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
