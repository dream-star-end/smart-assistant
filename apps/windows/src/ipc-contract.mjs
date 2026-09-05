export const IPC_CHANNELS = Object.freeze({
  command: 'aurora:shell-command',
  state: 'aurora:shell-state',
})

export const SHELL_ORIGIN = 'app://aurora-shell'
export const MAX_SHELL_COMMAND_ID_LENGTH = 128

const SIMPLE_COMMANDS = new Set([
  'ready',
  'back',
  'forward',
  'reload',
  'home',
  'open-more-menu',
  'focus-product',
  'downloads-open',
  'downloads-close',
  'open-downloads-folder',
  'zoom-in',
  'zoom-out',
  'zoom-reset',
])
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]+$/

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function parseShellCommand(payload) {
  if (!isPlainRecord(payload) || typeof payload.type !== 'string') return null
  const keys = Object.keys(payload)

  if (SIMPLE_COMMANDS.has(payload.type)) {
    return keys.length === 1 && keys[0] === 'type' ? { type: payload.type } : null
  }

  if (payload.type !== 'show-download' || keys.length !== 2) return null
  if (!Object.hasOwn(payload, 'id') || typeof payload.id !== 'string') return null
  if (
    payload.id.length < 1 ||
    payload.id.length > MAX_SHELL_COMMAND_ID_LENGTH ||
    !OPAQUE_ID_PATTERN.test(payload.id)
  ) {
    return null
  }
  return { type: 'show-download', id: payload.id }
}

function exactOrigin(value) {
  try {
    const parsed = new URL(value)
    if (parsed.username || parsed.password || parsed.port) return ''
    if (parsed.protocol === 'app:') return `app://${parsed.hostname}`
    return parsed.origin
  } catch {
    return ''
  }
}

/** Validate both Electron's sender and main-frame provenance for shell IPC. */
export function isTrustedShellEvent(event, shellWebContents, expectedOrigin = SHELL_ORIGIN) {
  try {
    if (!event || !shellWebContents || event.sender !== shellWebContents) return false
    if (shellWebContents.isDestroyed?.()) return false
    const senderFrame = event.senderFrame
    if (!senderFrame || senderFrame !== shellWebContents.mainFrame) return false
    if (senderFrame.parent != null) return false
    return exactOrigin(senderFrame.url) === expectedOrigin
  } catch {
    return false
  }
}
