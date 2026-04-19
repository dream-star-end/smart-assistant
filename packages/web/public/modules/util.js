// OpenClaude — Utility helpers
export const uuid = () =>
  `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
export const msgId = () => `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

export function formatSize(n) {
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

// Absolute timestamp label for a single chat message. Unlike shortTime()
// (which renders relative labels like "5 分钟前" for session lists), this
// always shows a precise clock time so users can correlate tool executions
// / long-running tasks with when they actually completed.
// Format rules:
//   • same calendar day → HH:MM            (e.g. 14:23)
//   • same calendar year → MM-DD HH:MM     (e.g. 04-17 14:23)
//   • otherwise → YYYY-MM-DD HH:MM         (e.g. 2025-12-31 23:58)
// Returns '' for falsy/invalid ts so caller can skip rendering without
// showing a placeholder.
export function msgTimeLabel(ts) {
  if (!ts || typeof ts !== 'number' || !Number.isFinite(ts)) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (sameDay) return hm
  const sameYear = d.getFullYear() === now.getFullYear()
  if (sameYear) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`
}

export function shortTime(ts) {
  const diff = (Date.now() - ts) / 1000
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 604800) return `${Math.floor(diff / 86400)} 天前`
  return new Date(ts).toLocaleDateString('zh-CN')
}

export function sessionGroup(ts) {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterdayStart = todayStart - 86400000
  const weekStart = todayStart - 6 * 86400000
  const monthStart = todayStart - 30 * 86400000
  if (ts >= todayStart) return '今天'
  if (ts >= yesterdayStart) return '昨天'
  if (ts >= weekStart) return '本周'
  if (ts >= monthStart) return '本月'
  return '更早'
}

export const GROUP_ORDER = ['今天', '昨天', '本周', '本月', '更早']

export function _basename(p) {
  // Handle both Unix / and Windows \ separators
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

export function _cronHuman(cron) {
  const p = (cron || '').split(/\s+/)
  if (p.length < 5) return cron
  const [min, hr, dom, mon, dow] = p
  const dayNames = ['日', '一', '二', '三', '四', '五', '六']
  let s = ''
  if (dom !== '*' && mon !== '*') s += `${mon}月${dom}日 `
  else if (dow !== '*') {
    const days = dow.split(',').map((d) => dayNames[+d] || d)
    s += `每周${days.join(',')} `
  } else if (dom !== '*') s += `每月${dom}日 `
  else s += '每天 '
  if (hr !== '*' && min !== '*') s += `${hr.padStart(2, '0')}:${min.padStart(2, '0')}`
  else if (hr !== '*') s += `${hr}:00`
  else if (min !== '*') s += `每小时第${min}分`
  else s += '每分钟'
  return s
}
