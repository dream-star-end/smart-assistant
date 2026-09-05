import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ElectronToHost, HostToElectron, HOST_IPC_VERSION, isIpcRecord } from './host/ipc.mjs'
import { killProcessTree } from './host/gatewayProcess.mjs'
import { spawnHostProcess } from './host/hostTransport.mjs'
import { TunnelState } from './tunnel/tunnelClient.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_HOST_ENTRY = path.join(HERE, 'host', 'hostMain.mjs')

const MAX_RESTARTS = 5
const RESTART_WINDOW_MS = 10 * 60 * 1000

export function readDesktopHostConfigFromEnv(env = process.env) {
  const registerOrigin = env.OPENCLAUDE_DESKTOP_REGISTER_ORIGIN || ''
  const egressOrigin = env.OPENCLAUDE_DESKTOP_EGRESS_ORIGIN || ''
  const spkiPin = env.OPENCLAUDE_DESKTOP_SPKI_PIN || ''
  const deviceCaPem = env.OPENCLAUDE_DESKTOP_DEVICE_CA || ''
  const keyringFp = env.OPENCLAUDE_DESKTOP_KEYRING_FP || ''
  const gatewayCommand = env.OPENCLAUDE_GATEWAY_ENTRY || ''
  const gatewayPort = env.OPENCLAUDE_GATEWAY_PORT ? Number(env.OPENCLAUDE_GATEWAY_PORT) : undefined
  return {
    registerOrigin,
    egressOrigin,
    spkiPin,
    deviceCaPem,
    keyringFp,
    gatewayCommand: gatewayCommand || undefined,
    gatewayArgs: gatewayCommand ? [] : undefined,
    gatewayPort,
    ready: Boolean(registerOrigin && egressOrigin && spkiPin && deviceCaPem),
  }
}

export function createHostSupervisor({
  execPath = process.execPath,
  hostEntry = DEFAULT_HOST_ENTRY,
  env = process.env,
  identityLoader,
  config,
  utilityProcess,
  forkImpl,
  versions = process.versions,
  onState,
  onError,
  onMessage,
  onFallback,
  onApprovalRequest,
  now = () => Date.now(),
  restartWindowMs = RESTART_WINDOW_MS,
  maxRestarts = MAX_RESTARTS,
  stopTimeoutMs = 5_000,
} = {}) {
  let child = null
  let transportKind = null
  let stopped = true
  let tunnelState = TunnelState.OFFLINE
  let lastStatus = null
  let pendingIdentity = null
  let pendingConfig = config || null
  const restartTimes = []
  let restartTimer = null
  let stopWait = null

  function send(message) {
    if (!child) return
    if (typeof child.send === 'function') child.send(message)
    else if (typeof child.postMessage === 'function') child.postMessage(message)
  }

  function handleMessage(raw) {
    if (!isIpcRecord(raw)) return
    onMessage?.(raw)
    if (raw.type === HostToElectron.READY) {
      send({ type: ElectronToHost.HELLO, v: HOST_IPC_VERSION })
      return
    }
    if (raw.type === HostToElectron.HELLO_OK) {
      if (pendingIdentity && pendingConfig) {
        send({
          type: ElectronToHost.START,
          identity: pendingIdentity,
          config: pendingConfig,
        })
      }
      return
    }
    if (raw.type === HostToElectron.STATE) {
      tunnelState = raw.state || tunnelState
      onState?.(tunnelState)
      return
    }
    if (raw.type === HostToElectron.STARTED || raw.type === HostToElectron.STATUS) {
      lastStatus = raw
      if (raw.tunnelState) {
        tunnelState = raw.tunnelState
        onState?.(tunnelState)
      }
      return
    }
    if (raw.type === HostToElectron.DEGRADED) {
      tunnelState = TunnelState.DEGRADED
      onState?.(tunnelState)
      return
    }
    if (raw.type === HostToElectron.FALLBACK) {
      onFallback?.(raw)
    }
    if (raw.type === HostToElectron.APPROVAL_REQUEST) {
      onApprovalRequest?.(raw)
    }
    if (raw.type === HostToElectron.ERROR) {
      onError?.(raw)
      if (raw.code === 'HOST_RESTART_LIMIT' || raw.code === 'UPDATE_REQUIRED') {
        onFallback?.({ reason: raw.code })
      }
    }
    if (raw.type === HostToElectron.STOPPED && stopWait) {
      stopWait()
    }
  }

  function spawnHost() {
    const spawned = spawnHostProcess({
      hostEntry,
      execPath,
      env,
      utilityProcess,
      forkImpl,
      versions,
    })
    child = spawned.child
    transportKind = spawned.kind
    child.stderr?.on?.('data', () => {})
    child.stdout?.on?.('data', () => {})
    child.on('message', handleMessage)
    child.on('exit', (code, signal) => {
      if (child === spawned.child) child = null
      if (stopped) return
      const t = now()
      restartTimes.push(t)
      while (restartTimes.length && t - restartTimes[0] > restartWindowMs) restartTimes.shift()
      if (restartTimes.length > maxRestarts) {
        tunnelState = TunnelState.OFFLINE
        onState?.(tunnelState)
        onError?.({ code: 'HOST_RESTART_LIMIT', message: 'host crashed too many times' })
        onFallback?.({ reason: 'host_unavailable' })
        return
      }
      const delay = Math.min(8_000, 400 * 2 ** Math.max(0, restartTimes.length - 1))
      restartTimer = setTimeout(() => {
        restartTimer = null
        if (!stopped) spawnHost()
      }, delay)
      restartTimer.unref?.()
      void code
      void signal
    })
    sendHello(child)
  }

  function sendHello(target) {
    try {
      if (typeof target.send === 'function') {
        target.send({ type: ElectronToHost.HELLO, v: HOST_IPC_VERSION })
      } else if (typeof target.postMessage === 'function') {
        target.postMessage({ type: ElectronToHost.HELLO, v: HOST_IPC_VERSION })
      }
    } catch { /* */ }
  }

  async function start() {
    stopped = false
    if (typeof identityLoader === 'function') {
      try {
        pendingIdentity = await identityLoader()
      } catch {
        pendingIdentity = null
      }
    }
    if (!pendingConfig) pendingConfig = config || readDesktopHostConfigFromEnv(env)
    spawnHost()
  }

  async function sendEnrollResult(identity, nextConfig) {
    pendingIdentity = identity
    if (nextConfig) pendingConfig = nextConfig
    if (!child) {
      if (!stopped) spawnHost()
      return
    }
    send({
      type: ElectronToHost.ENROLL_RESULT,
      identity,
      config: pendingConfig,
    })
  }

  async function stop() {
    stopped = true
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    const current = child
    if (!current) {
      tunnelState = TunnelState.OFFLINE
      return
    }
    send({ type: ElectronToHost.SHUTDOWN })
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        killProcessTree(current.pid)
        try { current.kill?.('SIGKILL') } catch { /* */ }
        resolve()
      }, stopTimeoutMs)
      stopWait = () => {
        clearTimeout(timer)
        resolve()
      }
      current.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    child = null
    tunnelState = TunnelState.OFFLINE
    stopWait = null
  }

  return {
    start,
    stop,
    sendEnrollResult,
    sendPower(event) {
      send({ type: ElectronToHost.POWER_EVENT, event })
    },
    sendApprovalResult(id, approved) {
      send({ type: ElectronToHost.APPROVAL_RESULT, id, approved: approved === true })
    },
    get state() {
      return tunnelState
    },
    get pid() {
      return child?.pid ?? null
    },
    get lastStatus() {
      return lastStatus
    },
    get child() {
      return child
    },
    get transportKind() {
      return transportKind
    },
  }
}
