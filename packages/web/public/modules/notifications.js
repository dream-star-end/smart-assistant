// OpenClaude — Notifications
import { getSession, state } from './state.js?v=be8d76a'

// ── Notification sound ──
const _notifSound = (() => {
  try {
    // Short gentle chime as data URI (base64 WAV, ~0.2s)
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    return () => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.type = 'sine'
      osc.frequency.value = 880
      gain.gain.setValueAtTime(0.15, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3)
      osc.start(ctx.currentTime)
      osc.stop(ctx.currentTime + 0.3)
    }
  } catch {
    return () => {}
  }
})()

// ── Title bar status ──
const _originalTitle = document.title
const _BUSY_TITLE = '⏳ 思考中... — OpenClaude'
export function setTitleBusy(busy) {
  if (busy) {
    document.title = _BUSY_TITLE
  } else {
    const sess = getSession()
    document.title = sess?.title ? `${sess.title} — OpenClaude` : _originalTitle
  }
}

// Refresh the browser tab title from the current session's title WITHOUT
// clobbering the "思考中..." busy indicator. Used when session metadata is
// adopted from the server (409 local-dominates) — we need the tab title to
// track `sess.title`, but the streaming indicator must survive. Setting
// `setTitleBusy(false)` would incorrectly clear the indicator during a
// turn-in-flight conflict.
export function refreshDocumentTitle() {
  if (document.title === _BUSY_TITLE) return
  const sess = getSession()
  document.title = sess?.title ? `${sess.title} — OpenClaude` : _originalTitle
}

export function maybeNotify(title, body) {
  // Play sound if tab not focused
  if (!state.windowFocused) _notifSound()
  if (state.windowFocused) return
  if (!('Notification' in window)) return
  // Request permission on first background notification (not on login)
  if (Notification.permission === 'default') {
    requestNotifyPermission()
    return
  }
  if (Notification.permission !== 'granted') return
  try {
    const n = new Notification(title, {
      body: body ? body.slice(0, 200) : '',
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: 'openclaude',
      silent: false,
    })
    n.onclick = () => {
      window.focus()
      n.close()
    }
  } catch {}
}
export async function requestNotifyPermission() {
  if (!('Notification' in window)) return
  if (Notification.permission === 'default') {
    try {
      await Notification.requestPermission()
    } catch {}
  }
}
