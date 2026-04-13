// OpenClaude — Notifications
import { state, getSession } from './state.js'

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
export function setTitleBusy(busy) {
  if (busy) {
    document.title = '⏳ 思考中... — OpenClaude'
  } else {
    const sess = getSession()
    document.title = sess?.title ? `${sess.title} — OpenClaude` : _originalTitle
  }
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
