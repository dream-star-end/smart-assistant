import { spawn } from 'node:child_process'
import http from 'node:http'
import { FORBIDDEN_GATEWAY_ENV, LOCAL_BRIDGE_HEADER_CANON, stripForbiddenGatewayEnv } from './tokens.mjs'

export const GATEWAY_PORT = 18789
export const FILE_PROXY_CAP = 'file-proxy-v1'

function killProcessTree(pid, signal = 'SIGTERM') {
  if (!pid) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
    } catch { /* */ }
    return
  }
  try { process.kill(-pid, signal) } catch { /* */ }
  try { process.kill(pid, signal) } catch { /* */ }
}

export function buildGatewayEnv({
  baseEnv = process.env,
  localBridgeToken,
  lahGwToken,
  masterProxyPort,
  gatewayBind = '127.0.0.1',
  gatewayPort = GATEWAY_PORT,
  extraEnv = {},
}) {
  const env = stripForbiddenGatewayEnv({
    ...baseEnv,
    ...extraEnv,
    OPENCLAUDE_LOCAL_BRIDGE_TOKEN: localBridgeToken,
    OPENCLAUDE_GATEWAY_BIND: gatewayBind,
    OPENCLAUDE_GATEWAY_PORT: String(gatewayPort),
    OPENCLAUDE_V3_MASTER_BASE_URL: `http://127.0.0.1:${masterProxyPort}`,
    OPENCLAUDE_V3_CONTAINER_TOKEN: lahGwToken,
  })
  for (const key of FORBIDDEN_GATEWAY_ENV) delete env[key]
  return env
}

export function assertGatewayEnvSafe(env) {
  for (const key of FORBIDDEN_GATEWAY_ENV) {
    if (Object.prototype.hasOwnProperty.call(env, key) && env[key] != null && env[key] !== '') {
      throw new Error(`gateway env must not contain ${key}`)
    }
  }
  if (typeof env.OPENCLAUDE_V3_CONTAINER_TOKEN === 'string' && env.OPENCLAUDE_V3_CONTAINER_TOKEN.startsWith('oc-v3.')) {
    throw new Error('gateway env must not contain oc-v3')
  }
}

function getJson(url, headers = {}, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode, raw, headers: res.headers })
      })
    })
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      reject(new Error('healthz timeout'))
    })
    req.on('error', reject)
  })
}

export function healthzHasFileProxy(raw) {
  if (typeof raw !== 'string') return false
  if (raw.includes(FILE_PROXY_CAP)) return true
  try {
    const json = JSON.parse(raw)
    const caps = json.capabilities || json.caps || json.features
    if (Array.isArray(caps)) return caps.includes(FILE_PROXY_CAP)
  } catch { /* */ }
  return false
}

export function createGatewayProcess({
  command,
  args = [],
  execPath,
  localBridgeToken,
  lahGwToken,
  masterProxyPort,
  gatewayPort = GATEWAY_PORT,
  extraEnv = {},
  healthzPath = '/healthz',
  healthzTimeoutMs = 8_000,
  restartBackoffMs = 400,
  maxBackoffMs = 8_000,
  onDegraded,
  onExit,
  onSpawn,
}) {
  let child = null
  let stopped = true
  let degraded = false
  let degradedReason = null
  let restartTimer = null
  let backoff = restartBackoffMs
  let lastEnv = null
  const spawnLog = []

  async function waitHealthy() {
    const deadline = Date.now() + healthzTimeoutMs
    let lastErr = null
    while (Date.now() < deadline) {
      try {
        const result = await getJson(`http://127.0.0.1:${gatewayPort}${healthzPath}`, {
          [LOCAL_BRIDGE_HEADER_CANON]: localBridgeToken,
        })
        if (result.status === 200) {
          if (healthzHasFileProxy(result.raw)) {
            degraded = true
            degradedReason = 'file-proxy-v1'
            onDegraded?.({ reason: 'file-proxy-v1', body: result.raw.slice(0, 200) })
          } else {
            degraded = false
            degradedReason = null
          }
          return result
        }
        lastErr = new Error(`healthz HTTP ${result.status}`)
      } catch (err) {
        lastErr = err
      }
      await new Promise((r) => setTimeout(r, 80))
    }
    throw lastErr || new Error('gateway healthz failed')
  }

  function spawnChild() {
    const env = buildGatewayEnv({
      localBridgeToken,
      lahGwToken,
      masterProxyPort,
      gatewayPort,
      extraEnv,
    })
    assertGatewayEnvSafe(env)
    lastEnv = env
    const cmd = command || execPath
    const childArgs = command ? args : args
    const spawned = spawn(cmd, childArgs, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    child = spawned
    spawnLog.push({ pid: spawned.pid, at: Date.now(), envKeys: Object.keys(env).sort() })
    onSpawn?.({ pid: spawned.pid, env })
    spawned.on('exit', (code, signal) => {
      onExit?.({ code, signal, pid: spawned.pid })
      if (child === spawned) child = null
      if (stopped) return
      if (restartTimer) return
      restartTimer = setTimeout(() => {
        restartTimer = null
        backoff = Math.min(maxBackoffMs, backoff * 2)
        spawnChild()
        void waitHealthy().catch(() => {})
      }, backoff)
      restartTimer.unref?.()
    })
    spawned.stderr?.on('data', () => {})
    spawned.stdout?.on('data', () => {})
    return spawned
  }

  return {
    get pid() {
      return child?.pid ?? null
    },
    get degraded() {
      return degraded
    },
    get degradedReason() {
      return degradedReason
    },
    get lastEnv() {
      return lastEnv
    },
    get spawnLog() {
      return spawnLog.slice()
    },
    async start() {
      stopped = false
      backoff = restartBackoffMs
      spawnChild()
      await waitHealthy()
    },
    async stop() {
      stopped = true
      if (restartTimer) {
        clearTimeout(restartTimer)
        restartTimer = null
      }
      const current = child
      const pid = current?.pid
      if (pid) {
        const exited = new Promise((resolve) => {
          if (!current.exitCode && current.exitCode !== 0 && current.killed !== true) {
            current.once('exit', () => resolve())
          } else resolve()
        })
        if (process.platform === 'win32') {
          killProcessTree(pid)
          try { current.kill() } catch { /* */ }
        } else {
          try { process.kill(-pid, 'SIGTERM') } catch { /* */ }
          try { current.kill('SIGTERM') } catch { /* */ }
        }
        const timer = new Promise((r) => setTimeout(r, 400))
        await Promise.race([exited, timer])
        if (current.exitCode == null && !current.killed) {
          if (process.platform === 'win32') killProcessTree(pid)
          else {
            try { process.kill(-pid, 'SIGKILL') } catch { /* */ }
            try { current.kill('SIGKILL') } catch { /* */ }
          }
          await Promise.race([exited, new Promise((r) => setTimeout(r, 200))])
        }
      }
      child = null
    },
    waitHealthy,
    killProcessTree,
  }
}

export { killProcessTree }
