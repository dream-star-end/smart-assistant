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

export const READONLY_TOOL_KINDS = Object.freeze([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'WebFetch',
])

const READONLY_BASH_COMMANDS = Object.freeze(['ls', 'cat', 'rg', 'find'])
const READONLY_GIT_SUBCOMMANDS = Object.freeze(['status', 'log', 'diff'])

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
  return value === '/' || value === '~' || value === '~/'
}

function isUserProfileRoot(value) {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed === '~' || trimmed === '~/') return true
  return /^[a-z]:\\Users\\[^\\]+\\?$/i.test(trimmed)
}

function isSystemPath(value, platform) {
  if (typeof value !== 'string' || value.length === 0) return false
  if (isDriveRoot(value, platform) || isUserProfileRoot(value)) return true
  const roots = platform === 'win32' ? WIN32_SYSTEM_ROOTS : POSIX_SYSTEM_ROOTS
  const identity = (input) => input
  return roots.some((root) => isPathWithinWorkspace(root, value, { platform, realpath: identity }))
}

function tokenize(command) {
  return String(command || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
}

function flagLetters(tokens) {
  const letters = []
  for (const token of tokens) {
    if (!token.startsWith('-') || token.startsWith('--')) continue
    for (const ch of token.slice(1)) {
      if (/[a-zA-Z]/.test(ch)) letters.push(ch.toLowerCase())
    }
  }
  return letters
}

function hasLongFlag(tokens, name) {
  return tokens.some((token) => token === name || token.startsWith(`${name}=`))
}

function isRmRecursive(tokens) {
  if (!tokens.length) return false
  const cmd = tokens[0].toLowerCase().replace(/\.exe$/i, '')
  if (cmd !== 'rm') return false
  const letters = flagLetters(tokens)
  return letters.includes('r') || hasLongFlag(tokens, '--recursive')
}

function isRmForceRecursive(tokens) {
  if (!isRmRecursive(tokens)) return false
  const letters = flagLetters(tokens)
  return letters.includes('f') || hasLongFlag(tokens, '--force') || true
}

function classifyShellDestructive(text, tokens) {
  if (isRmRecursive(tokens) || isRmForceRecursive(tokens)) return 'rm-rf'
  if (/\brm\s+--recursive\b/i.test(text)) return 'rm-rf'
  if (/\bremove-item\b/i.test(text) && /(^|\s)-(recurse|r)(?=\s|$)/i.test(text)) return 'rm-rf'
  if (/\bdel\s+\/s\b/i.test(text)) return 'delete-directory'
  if (/\b(rd|rmdir)\s+\/s\b/i.test(text)) return 'delete-directory'
  if (/\bgit\s+reset\b.*--hard/.test(text)) return 'git-reset-hard'
  if (/\bgit\s+push\b.*(--force\b|--force-with-lease\b|\s-f\b)/.test(text)) return 'git-push-force'
  if (/\bgit\s+clean\b.*(-[a-z]*f|-f|--force)/i.test(text) && /\bgit\s+clean\b.*(-[a-z]*d|-d)/i.test(text)) {
    return 'git-reset-hard'
  }
  if (/\bgit\s+checkout\s+--\s+\./.test(text) || /\bgit\s+restore\s+\./.test(text)) return 'git-reset-hard'
  if (/\bgit\s+branch\s+-d\b/.test(text)) return 'git-reset-hard'
  if (/\bformat\s+[a-z]:|\bmkfs\b|\bdiskpart\b/.test(text)) return 'format'
  return null
}

function hasShellMeta(command) {
  return /[|&;`$<>()\n]/.test(command)
}

function isReadonlyBash(command) {
  const trimmed = String(command || '').replace(/\s+/g, ' ').trim()
  if (!trimmed) return false
  if (hasShellMeta(trimmed)) return false
  const tokens = tokenize(trimmed)
  const cmd = tokens[0].toLowerCase().replace(/\.exe$/i, '')
  if (cmd === 'git') {
    const sub = (tokens[1] || '').toLowerCase()
    return READONLY_GIT_SUBCOMMANDS.includes(sub)
  }
  if (cmd === 'find') {
    if (tokens.some((t) => t === '-delete' || t === '-exec' || t === '-execdir')) return false
    return true
  }
  return READONLY_BASH_COMMANDS.includes(cmd)
}

function isReadonlyToolKind(kind) {
  if (typeof kind !== 'string' || !kind) return false
  return READONLY_TOOL_KINDS.some((name) => name.toLowerCase() === kind.toLowerCase())
}

function allowResult(reason) {
  return { needsApproval: false, reason, readOnly: true }
}

function denyResult(reason) {
  return { needsApproval: true, reason, readOnly: false }
}

export function classifyDestructiveOp({ kind, detail = {}, command, platform = process.platform } = {}) {
  const toolName = typeof detail.toolName === 'string' && detail.toolName ? detail.toolName : kind
  const text = collectText({ kind, detail, command })
  const lower = text.toLowerCase()
  const targetPath = typeof detail.path === 'string' ? detail.path : typeof detail.target === 'string' ? detail.target : ''
  const tokens = tokenize(command || detail.command || '')

  if (typeof kind === 'string' && REQUIRED_APPROVAL_KINDS.includes(kind)) {
    return denyResult(kind)
  }

  const shellReason = classifyShellDestructive(lower, tokens)
  if (shellReason) return denyResult(shellReason)

  if (kind === 'system-disk' || isSystemPath(targetPath, platform) || isDriveRoot(targetPath, platform) || isUserProfileRoot(targetPath)) {
    if (targetPath) return denyResult('system-disk')
  }

  const writeKind = typeof toolName === 'string' ? toolName.toLowerCase() : ''
  if ((writeKind === 'write' || writeKind === 'edit') && detail.workspaceRoot && targetPath) {
    const inside = isPathWithinWorkspace(detail.workspaceRoot, targetPath, {
      platform,
      realpath: (input) => input,
    })
    if (!inside) return denyResult('workspace-escape')
  }

  if (isReadonlyToolKind(toolName)) {
    if (String(toolName).toLowerCase() === 'webfetch') {
      const method = String(detail.method || command || 'GET').toUpperCase()
      if (method && method !== 'GET' && method !== 'HEAD') return denyResult('unknown')
    }
    return allowResult('read-only')
  }

  const looksLikeShell = writeKind === 'bash' || writeKind === 'shell' || Boolean(command || detail.command)
  if (looksLikeShell && isReadonlyBash(command || detail.command || '')) {
    return allowResult('read-only')
  }

  if (looksLikeShell) return denyResult('unknown')
  return denyResult('unknown')
}

function randomOpId() {
  return `op-${crypto.randomBytes(8).toString('hex')}`
}

/**
 * Host-side approval engine (design §7.2.3).
 * Default deny, 120s timeout deny. Unknown ops require approval.
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
      readOnly: classified.readOnly === true,
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
