export const IPC_CHANNELS = Object.freeze({
  command: 'aurora:shell-command',
  state: 'aurora:shell-state',
  localHost: 'clarvy:local-host',
})

export const SHELL_ORIGIN = 'app://aurora-shell'
export const LOCAL_HOST_ORIGIN = 'app://clarvy-local'
export const MAX_SHELL_COMMAND_ID_LENGTH = 128
export const MAX_LOCAL_HOST_PATH_LENGTH = 4096

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
const SIMPLE_LOCAL_HOST_COMMANDS = new Set([
  'get-status',
  'choose-workspace',
  'fallback-cloud',
  'start-enroll',
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

export function parseLocalHostCommand(payload) {
  if (!isPlainRecord(payload) || typeof payload.type !== 'string') return null
  const keys = Object.keys(payload)

  if (SIMPLE_LOCAL_HOST_COMMANDS.has(payload.type)) {
    return keys.length === 1 && keys[0] === 'type' ? { type: payload.type } : null
  }

  if (payload.type === 'set-workspace') {
    if (keys.length !== 2 || !Object.hasOwn(payload, 'path') || typeof payload.path !== 'string') {
      return null
    }
    if (payload.path.length < 1 || payload.path.length > MAX_LOCAL_HOST_PATH_LENGTH) return null
    return { type: 'set-workspace', path: payload.path }
  }

  if (payload.type === 'approve-op' || payload.type === 'deny-op') {
    if (keys.length !== 2 || !Object.hasOwn(payload, 'id') || typeof payload.id !== 'string') {
      return null
    }
    if (
      payload.id.length < 1 ||
      payload.id.length > MAX_SHELL_COMMAND_ID_LENGTH ||
      !OPAQUE_ID_PATTERN.test(payload.id)
    ) {
      return null
    }
    return { type: payload.type, id: payload.id }
  }

  return null
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

export function isTrustedLocalHostEvent(event, localWebContents) {
  return isTrustedShellEvent(event, localWebContents, LOCAL_HOST_ORIGIN)
}

/**
 * Privileged `clarvy:local-host` gate. Forged product-origin frames are rejected
 * before any command dispatch. Renderer never sees certs or tokens.
 */
export function createLocalHostIpcHandler({
  getLocalWebContents,
  enrollment,
  audit = () => {},
} = {}) {
  return async function handleLocalHostIpc(event, payload) {
    const webContents = typeof getLocalWebContents === 'function' ? getLocalWebContents() : null
    if (!isTrustedLocalHostEvent(event, webContents)) {
      audit({ event: 'ipc_rejected' })
      return { ok: false, error: 'forbidden' }
    }

    const command = parseLocalHostCommand(payload)
    if (!command) {
      return { ok: false, error: 'invalid-payload' }
    }

    if (command.type === 'start-enroll') {
      if (typeof enrollment?.start !== 'function') {
        return { ok: false, error: 'not-implemented' }
      }
      try {
        const result = await enrollment.start()
        return {
          ok: true,
          enrollmentId: result.enrollmentId,
          authUrl: result.authUrl,
        }
      } catch {
        return { ok: false, error: 'enroll-failed' }
      }
    }

    if (command.type === 'get-status') {
      const status =
        typeof enrollment?.getStatus === 'function'
          ? enrollment.getStatus()
          : { phase: 'idle', hasIdentity: false, enrollmentId: null }
      return { ok: true, status }
    }

    return { ok: false, error: 'not-implemented' }
  }
}
