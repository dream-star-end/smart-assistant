import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ElectronToHost, HostToElectron, HOST_IPC_VERSION, isIpcRecord } from './host/ipc.mjs'
import { killProcessTree } from './host/gatewayProcess.mjs'
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
  onState,
  onError,
  onMessage,
  now = () => Date.now(),
  restartWindowMs = RESTART_WINDOW_MS,
  maxRestarts = MAX_RESTARTS,
  stopTimeoutMs = 5_000,
} = {}) {
  let child = null
  let stopped = true
  let tunnelState = TunnelState.OFFLINE
  let lastStatus = null
  let pendingIdentity = null
  let pendingConfig = config || null
  const restartTimes = []
  let restartTimer = null
  let stopWait = null

  const childEnv = () => {
    const next = { ...env, ELECTRON_RUN_AS_NODE: '1' }
    delete next.OPENCLAUDE_TRUST_BRIDGE_IP
    delete next.OC_CONTAINER_ID
    delete next.OC_BRIDGE_NONCE
    return next
  }

  function send(message) {
    if (child && typeof child.send === 'function') child.send(message)
  }

  function handleMessage(raw) {
    if (!isIpcRecord(raw)) return
    onMessage?.(raw)
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
    if (raw.type === HostToElectron.ERROR) {
      onError?.(raw)
    }
    if (raw.type === HostToElectron.STOPPED && stopWait) {
      stopWait()
    }
  }

  function spawnHost() {
    const spawned = spawn(execPath, [hostEntry], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: childEnv(),
      windowsHide: true,
    })
    child = spawned
    spawned.stderr?.on('data', () => {})
    spawned.stdout?.on('data', () => {})
    spawned.on('message', handleMessage)
    spawned.on('exit', (code, signal) => {
      if (child === spawned) child = null
      if (stopped) return
      const t = now()
      restartTimes.push(t)
      while (restartTimes.length && t - restartTimes[0] > restartWindowMs) restartTimes.shift()
      if (restartTimes.length > maxRestarts) {
        tunnelState = TunnelState.OFFLINE
        onState?.(tunnelState)
        onError?.({ code: 'HOST_RESTART_LIMIT', message: 'host crashed too many times' })
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
    sendHello(spawned)
  }

  function sendHello(target) {
    try {
      target.send({ type: ElectronToHost.HELLO, v: HOST_IPC_VERSION })
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
        if (process.platform !== 'win32') {
          try { current.kill('SIGKILL') } catch { /* */ }
        }
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
  }
}
