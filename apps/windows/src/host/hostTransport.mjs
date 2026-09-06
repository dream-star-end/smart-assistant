/**
 * Spawn Local Agent Host without ELECTRON_RUN_AS_NODE.
 * Electron production: utilityProcess.fork (independent of runAsNode fuse).
 * Node tests: child_process.fork. Electron without utilityProcess fails closed.
 */
import { fork as defaultFork } from 'node:child_process'

export function electronHasUtilityProcess(versions = process.versions, utilityProcess) {
  return Boolean(versions && typeof versions.electron === 'string' && versions.electron)
    && Boolean(utilityProcess && typeof utilityProcess.fork === 'function')
}

export function assertElectronHostTransport({ versions = process.versions, utilityProcess } = {}) {
  if (versions && typeof versions.electron === 'string' && versions.electron) {
    if (!utilityProcess || typeof utilityProcess.fork !== 'function') {
      const err = new Error('Host must be spawned with utilityProcess.fork in Electron (runAsNode fuse is off)')
      err.code = 'HOST_TRANSPORT_REQUIRED'
      throw err
    }
  }
}

function wrapUtilityChild(proc, hostEntry) {
  const child = {
    get pid() {
      return proc.pid ?? null
    },
    get stdout() {
      return proc.stdout
    },
    get stderr() {
      return proc.stderr
    },
    spawnfile: 'utilityProcess',
    spawnargs: [hostEntry],
    send(message) {
      proc.postMessage(message)
    },
    postMessage(message) {
      proc.postMessage(message)
    },
    kill() {
      try { proc.kill() } catch { /* */ }
    },
    on(event, handler) {
      proc.on(event, handler)
      return child
    },
    once(event, handler) {
      proc.once(event, handler)
      return child
    },
  }
  return child
}

export function spawnHostProcess({
  hostEntry,
  execPath = process.execPath,
  env = process.env,
  utilityProcess,
  forkImpl = defaultFork,
  versions = process.versions,
} = {}) {
  if (!hostEntry) throw new TypeError('hostEntry required')
  assertElectronHostTransport({ versions, utilityProcess })

  const childEnv = { ...env }
  delete childEnv.ELECTRON_RUN_AS_NODE
  delete childEnv.OPENCLAUDE_TRUST_BRIDGE_IP
  delete childEnv.OC_CONTAINER_ID
  delete childEnv.OC_BRIDGE_NONCE

  if (utilityProcess && typeof utilityProcess.fork === 'function') {
    const proc = utilityProcess.fork(hostEntry, [], {
      stdio: ['ignore', 'pipe', 'pipe'],
      serviceName: 'clarvy-lah',
      env: childEnv,
    })
    return { child: wrapUtilityChild(proc, hostEntry), kind: 'utilityProcess' }
  }

  const child = forkImpl(hostEntry, [], {
    execPath,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: childEnv,
    windowsHide: true,
  })
  return { child, kind: 'fork' }
}
