/**
 * Local Agent Host entry. Spawned by Electron with stdio IPC.
 * Identity and tokens arrive over IPC only — never argv/env.
 */
import { createHostRuntime } from './runtime.mjs'
import { ElectronToHost, HostToElectron, HOST_IPC_VERSION, isIpcRecord } from './ipc.mjs'
import { createHostLogger, resolveLogsDirectory } from './log.mjs'

function makeHostLog() {
  try {
    return createHostLogger({
      directory: resolveLogsDirectory({ env: process.env, platform: process.platform }),
    })
  } catch {
    return { error() {}, warn() {}, info() {}, debug() {} }
  }
}
const hostLog = makeHostLog()

function send(message) {
  if (typeof process.send === 'function') process.send(message)
}

function watchParent(shutdown) {
  const startPpid = process.ppid
  const timer = setInterval(() => {
    if (process.ppid === 1 || process.ppid !== startPpid) shutdown('parent_gone')
  }, 1000)
  timer.unref?.()
  process.on('disconnect', () => shutdown('ipc_disconnect'))
  return () => clearInterval(timer)
}

function assertNoIdentityInProcess() {
  const argv = process.argv.join(' ')
  if (argv.includes('oc-v3.') || argv.includes('BEGIN CERTIFICATE') || argv.includes('oc-dv.')) {
    throw new Error('identity material must not appear on argv')
  }
}

async function main() {
  if (typeof process.send !== 'function') {
    hostLog.error('host_ipc_missing', { errCode: 'NO_IPC' })
    console.error('hostMain requires an IPC channel')
    process.exit(2)
  }
  assertNoIdentityInProcess()

  let runtime = null
  let shuttingDown = false

  const shutdown = async (reason) => {
    if (shuttingDown) return
    shuttingDown = true
    try { await runtime?.stop(reason) } catch { /* */ }
    send({ type: HostToElectron.STOPPED, reason })
    process.exit(0)
  }

  watchParent(shutdown)
  try { process.stdin.unref() } catch { /* */ }

  process.on('message', async (raw) => {
    if (!isIpcRecord(raw)) return
    try {
      if (raw.type === ElectronToHost.HELLO) {
        send({ type: HostToElectron.HELLO_OK, v: HOST_IPC_VERSION, pid: process.pid })
        return
      }
      if (raw.type === ElectronToHost.STATUS) {
        send({ type: HostToElectron.STATUS, ...(runtime?.status() ?? { started: false, tunnelState: 'offline' }) })
        return
      }
      if (raw.type === ElectronToHost.STOP || raw.type === ElectronToHost.SHUTDOWN) {
        await shutdown(raw.type)
        return
      }
      if (raw.type === ElectronToHost.POWER_EVENT) {
        runtime?.handlePower(raw.event)
        return
      }
      if (raw.type === ElectronToHost.APPROVAL_RESULT) {
        if (raw.approved === true) runtime?.approve(raw.id)
        else runtime?.deny(raw.id)
        return
      }
      if (raw.type === ElectronToHost.START || raw.type === ElectronToHost.ENROLL_RESULT) {
        const identity = raw.identity
        const config = raw.config || {}
        if (!identity) {
          send({ type: HostToElectron.ERROR, code: 'NO_IDENTITY', message: 'identity required' })
          return
        }
        runtime = createHostRuntime({
          registerOrigin: config.registerOrigin,
          egressOrigin: config.egressOrigin,
          spkiPin: config.spkiPin,
          deviceCaPem: config.deviceCaPem,
          keyringFp: config.keyringFp || '',
          gatewayCommand: config.gatewayCommand,
          gatewayArgs: config.gatewayArgs || [],
          gatewayExtraEnv: config.gatewayExtraEnv || {},
          gatewayPort: config.gatewayPort,
          egressPort: config.egressPort,
          masterPort: config.masterPort,
          claudeCodePath: config.claudeCodePath,
          claudeCodeEntry: config.claudeCodeEntry,
          claudeCodeRuntime: config.claudeCodeRuntime,
          workspaceRoots: config.workspaceRoots || [],
          workspacesPath: config.workspacesPath,
          refreshLeadMs: config.refreshLeadMs,
          onState: (state) => send({ type: HostToElectron.STATE, state }),
          onDegraded: (info) => send({ type: HostToElectron.DEGRADED, ...info }),
          onUpdateRequired: (info) => send({ type: HostToElectron.ERROR, code: 'UPDATE_REQUIRED', ...info }),
          onApprovalRequest: (info) => send({ type: HostToElectron.APPROVAL_REQUEST, ...info }),
          onFallback: (info) => send({ type: HostToElectron.FALLBACK, ...info }),
          onEvent: (event, extra) => {
            if (event === 'workspace_denied') hostLog.warn('workspace_denied', extra)
          },
        })
        const st = await runtime.start(identity)
        send({ type: HostToElectron.STARTED, ...st })
        return
      }
    } catch (err) {
      send({
        type: HostToElectron.ERROR,
        code: err.code || 'HOST_ERROR',
        message: err.message || String(err),
      })
    }
  })

  process.on('SIGTERM', () => { void shutdown('sigterm') })
  process.on('SIGINT', () => { void shutdown('sigint') })
}

void main()
