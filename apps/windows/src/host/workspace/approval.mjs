import crypto from 'node:crypto'

import { isPathWithinWorkspace } from './guard.mjs'

export const APPROVAL_TIMEOUT_MS = 120_000

export const REQUIRED_APPROVAL_KINDS = Object.freeze([
  'delete-directory',
  'git-reset-hard',
  'git-push-force',
  'rm-rf',
  'format',
  'system-disk',
])

const WIN32_SYSTEM_ROOTS = Object.freeze(['C:\\Windows', 'C:\\Windows\\System32'])
const POSIX_SYSTEM_ROOTS = Object.freeze(['/bin', '/etc', '/usr', '/sbin', '/System'])

function asText(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(asText).join(' ')
  return String(value)
}

function collectText({ kind, detail = {}, command } = {}) {
  return [kind, command, detail.command, detail.argv, detail.path, detail.target]
    .map(asText)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isDriveRoot(value, platform) {
  if (typeof value !== 'string' || value.length === 0) return false
  if (platform === 'win32') return /^[a-z]:\\?$/i.test(value.trim())
  return value === '/'
}

function isSystemPath(value, platform) {
  if (typeof value !== 'string' || value.length === 0) return false
  if (isDriveRoot(value, platform)) return true
  const roots = platform === 'win32' ? WIN32_SYSTEM_ROOTS : POSIX_SYSTEM_ROOTS
  const identity = (input) => input
  return roots.some((root) => isPathWithinWorkspace(root, value, { platform, realpath: identity }))
}

export function classifyDestructiveOp({ kind, detail = {}, command, platform = process.platform } = {}) {
  if (typeof kind === 'string' && REQUIRED_APPROVAL_KINDS.includes(kind)) {
    return { needsApproval: true, reason: kind }
  }

  const text = collectText({ kind, detail, command }).toLowerCase()
  const targetPath = typeof detail.path === 'string' ? detail.path : typeof detail.target === 'string' ? detail.target : ''

  if (/\brm\s+-[a-z]*r[a-z]*f\b|\brm\s+-[a-z]*f[a-z]*r\b|\brm\s+-rf\b|\brm\s+-fr\b/.test(text) || kind === 'rm-rf') {
    return { needsApproval: true, reason: 'rm-rf' }
  }
  if (/git\s+reset\b.*--hard/.test(text) || kind === 'git-reset-hard') {
    return { needsApproval: true, reason: 'git-reset-hard' }
  }
  if (/git\s+push\b.*(--force\b|--force-with-lease\b|\s-f\b)/.test(text) || kind === 'git-push-force') {
    return { needsApproval: true, reason: 'git-push-force' }
  }
  if (/\bformat\s+[a-z]:|\bmkfs\b|\bdiskpart\b/.test(text) || kind === 'format') {
    return { needsApproval: true, reason: 'format' }
  }
  if (
    kind === 'delete-directory' ||
    /\brmdir\s+\/s\b|\brd\s+\/s\b|rmsync\s*\(.*recursive:\s*true/.test(text)
  ) {
    return { needsApproval: true, reason: 'delete-directory' }
  }
  if (kind === 'system-disk' || isSystemPath(targetPath, platform) || isDriveRoot(targetPath, platform)) {
    return { needsApproval: true, reason: 'system-disk' }
  }
  return { needsApproval: false, reason: 'not-destructive' }
}

function randomOpId() {
  return `op-${crypto.randomBytes(8).toString('hex')}`
}

/**
 * Host-side approval engine (design §7.2.3).
 * Default deny, 120s timeout deny. S6 wires real CCB permission events.
 */
export function createApprovalController({
  timeoutMs = APPROVAL_TIMEOUT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  prompt = async () => {},
  audit = () => {},
  now = () => Date.now(),
} = {}) {
  const pending = new Map()

  function finish(id, approved, reason) {
    const item = pending.get(id)
    if (!item) return { ok: false, error: 'unknown-op', approved: false }
    pending.delete(id)
    if (item.timer) clearTimer(item.timer)
    const result = { ok: true, approved: approved === true, reason, id }
    try {
      audit({
        event: approved === true ? 'approval_granted' : 'approval_denied',
        id,
        kind: item.kind,
        reason,
      })
    } catch {
      /* audit must not throw into the waiter */
    }
    item.resolve(result)
    return result
  }

  async function requestApproval({ kind, detail = {}, command } = {}) {
    const classified = classifyDestructiveOp({ kind, detail, command })
    const id = randomOpId()
    const request = {
      id,
      kind: kind || classified.reason,
      detail,
      command: command || '',
      needsApproval: classified.needsApproval,
      classified: classified.reason,
      createdAt: now(),
    }

    const outcome = await new Promise((resolve) => {
      const timer = setTimer(() => {
        finish(id, false, 'timeout')
      }, timeoutMs)
      pending.set(id, { ...request, timer, resolve })
      Promise.resolve(prompt(request)).catch(() => {
        finish(id, false, 'prompt-failed')
      })
    })
    return outcome
  }

  return {
    classify: classifyDestructiveOp,
    requestApproval,
    approve(id) {
      if (typeof id !== 'string' || id.length === 0) return { ok: false, error: 'invalid-id', approved: false }
      if (!pending.has(id)) return { ok: false, error: 'unknown-op', approved: false }
      return finish(id, true, 'approved')
    },
    deny(id) {
      if (typeof id !== 'string' || id.length === 0) return { ok: false, error: 'invalid-id', approved: false }
      if (!pending.has(id)) return { ok: false, error: 'unknown-op', approved: false }
      return finish(id, false, 'denied')
    },
    hasPending(id) {
      return pending.has(id)
    },
    pendingCount() {
      return pending.size
    },
  }
}
