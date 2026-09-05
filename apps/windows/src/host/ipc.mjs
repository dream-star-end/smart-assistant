export const HOST_IPC_VERSION = 1

export const HostToElectron = Object.freeze({
  HELLO_OK: 'hello-ok',
  STARTED: 'started',
  STATUS: 'status',
  STATE: 'tunnel-state',
  ERROR: 'error',
  DEGRADED: 'degraded',
  STOPPED: 'stopped',
  APPROVAL_REQUEST: 'approval-request',
  WORKSPACE_UPDATED: 'workspace-updated',
})

export const ElectronToHost = Object.freeze({
  HELLO: 'hello',
  START: 'start',
  STOP: 'stop',
  STATUS: 'status',
  ENROLL_RESULT: 'enroll-result',
  SHUTDOWN: 'shutdown',
  SET_WORKSPACE: 'set-workspace',
  APPROVAL_RESULT: 'approval-result',
})

export function isIpcRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && typeof value.type === 'string'
}

export function assertNoSecretLeak(message) {
  if (!isIpcRecord(message)) return
  const json = JSON.stringify(message)
  if (/\boc-v3\./.test(json) && message.type !== ElectronToHost.START && message.type !== ElectronToHost.ENROLL_RESULT) {
    throw new Error('oc-v3 must not appear on Host→Electron IPC')
  }
}
