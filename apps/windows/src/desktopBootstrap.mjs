import { X509Certificate } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { pinsMatch } from './tunnel/bootstrap.mjs'
import { PINNED_APP_ORIGIN } from './security-policy.mjs'

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

export const BOOTSTRAP_TIMEOUT_MS = 10_000
export const BOOTSTRAP_PIN_CHANGED_MESSAGE = '服务端证书已更换,需要重新绑定'
export const BOOTSTRAP_UNAVAILABLE_MESSAGE = '服务端未开放本地模式'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function defaultBootstrapCachePath({ env = process.env, platform = process.platform } = {}) {
  if (env.OPENCLAUDE_DESKTOP_BOOTSTRAP_CACHE) return env.OPENCLAUDE_DESKTOP_BOOTSTRAP_CACHE
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || path.join(env.USERPROFILE || '', 'AppData', 'Local')
    return path.join(base, 'Clarvy', 'bootstrap.json')
  }
  return path.join(env.XDG_CACHE_HOME || os.tmpdir(), 'clarvy-bootstrap.json')
}

export function publicOriginFromProductUrl(devUrl, { isPackaged = true } = {}) {
  if (!isPackaged && typeof devUrl === 'string' && devUrl) {
    try {
      return new URL(devUrl).origin
    } catch {
      /* */
    }
  }
  return PINNED_APP_ORIGIN
}

function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(String(hostname || '').toLowerCase())
}

function parseRequiredUrl(value, { protocol, allowLoopback, label }) {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, error: `${label} missing` }
  }
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return { ok: false, error: `${label} invalid url` }
  }
  if (parsed.protocol !== protocol) {
    return { ok: false, error: `${label} protocol` }
  }
  if (!allowLoopback && isLoopbackHost(parsed.hostname)) {
    return { ok: false, error: `${label} loopback` }
  }
  return { ok: true, url: parsed }
}

export function validateOriginSpkiPin(value) {
  if (typeof value !== 'string' || value.length === 0) return { ok: false, error: 'pin missing' }
  let buf
  try {
    buf = Buffer.from(value, 'base64')
  } catch {
    return { ok: false, error: 'pin encoding' }
  }
  if (buf.length !== 32) return { ok: false, error: 'pin length' }
  if (buf.toString('base64') !== value && buf.toString('base64url') !== value.replace(/=+$/, '')) {
    // accept standard or url-safe base64; reject truncated garbage
  }
  return { ok: true, pin: value }
}

export function validateDeviceCaPem(value) {
  if (typeof value !== 'string' || !value.includes('BEGIN CERTIFICATE')) {
    return { ok: false, error: 'ca missing' }
  }
  try {
    const cert = new X509Certificate(value)
    if (!cert.fingerprint256) return { ok: false, error: 'ca unreadable' }
  } catch {
    return { ok: false, error: 'ca unreadable' }
  }
  return { ok: true, pem: value }
}

export function validateBootstrapDocument(doc, { allowLoopback = false } = {}) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, error: 'INVALID_BOOTSTRAP' }
  }
  if (doc.v !== 1) return { ok: false, error: 'INVALID_BOOTSTRAP_VERSION' }
  const register = parseRequiredUrl(doc.register_wss, { protocol: 'wss:', allowLoopback, label: 'register_wss' })
  if (!register.ok) return register
  const master = parseRequiredUrl(doc.master_https, { protocol: 'https:', allowLoopback, label: 'master_https' })
  if (!master.ok) return master
  const egress = parseRequiredUrl(doc.egress_https, { protocol: 'https:', allowLoopback, label: 'egress_https' })
  if (!egress.ok) return egress
  const pin = validateOriginSpkiPin(doc.origin_spki_pin)
  if (!pin.ok) return pin
  const ca = validateDeviceCaPem(doc.device_ca_pem)
  if (!ca.ok) return ca
  let runtimeManifestUrl = ''
  if (doc.runtime_manifest_url != null && doc.runtime_manifest_url !== '') {
    const manifest = parseRequiredUrl(doc.runtime_manifest_url, {
      protocol: 'https:',
      allowLoopback,
      label: 'runtime_manifest_url',
    })
    if (!manifest.ok) return manifest
    runtimeManifestUrl = doc.runtime_manifest_url
  }
  return {
    ok: true,
    doc: {
      v: 1,
      register_wss: doc.register_wss,
      master_https: doc.master_https,
      egress_https: doc.egress_https,
      device_ca_pem: doc.device_ca_pem,
      origin_spki_pin: doc.origin_spki_pin,
      runtime_manifest_url: runtimeManifestUrl,
      min_app_version: typeof doc.min_app_version === 'string' ? doc.min_app_version : '',
    },
  }
}

export function mapBootstrapToHostConfig(doc, envConfig = {}) {
  return {
    registerOrigin: doc.register_wss,
    egressOrigin: doc.egress_https,
    masterHttps: doc.master_https,
    spkiPin: doc.origin_spki_pin,
    deviceCaPem: doc.device_ca_pem,
    runtimeManifestUrl: doc.runtime_manifest_url || '',
    minAppVersion: doc.min_app_version || '',
    keyringFp: envConfig.keyringFp || '',
    gatewayCommand: envConfig.gatewayCommand,
    gatewayArgs: envConfig.gatewayArgs,
    gatewayPort: envConfig.gatewayPort,
    ready: true,
    source: 'bootstrap',
  }
}

export function applyDesktopEnvOverlay(config, env = process.env) {
  const overlay = readDesktopHostConfigFromEnv(env)
  const next = { ...config }
  if (overlay.registerOrigin) next.registerOrigin = overlay.registerOrigin
  if (overlay.egressOrigin) next.egressOrigin = overlay.egressOrigin
  if (overlay.spkiPin) next.spkiPin = overlay.spkiPin
  if (overlay.deviceCaPem) next.deviceCaPem = overlay.deviceCaPem
  if (overlay.keyringFp) next.keyringFp = overlay.keyringFp
  if (overlay.gatewayCommand) {
    next.gatewayCommand = overlay.gatewayCommand
    next.gatewayArgs = overlay.gatewayArgs
  }
  if (overlay.gatewayPort != null) next.gatewayPort = overlay.gatewayPort
  if (env.OPENCLAUDE_DESKTOP_RUNTIME_MANIFEST_URL) {
    next.runtimeManifestUrl = env.OPENCLAUDE_DESKTOP_RUNTIME_MANIFEST_URL
  }
  next.ready = Boolean(next.registerOrigin && next.egressOrigin && next.spkiPin && next.deviceCaPem)
  return next
}

function readCacheFile(cachePath) {
  try {
    const raw = readFileSync(cachePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

function writeCacheFile(cachePath, doc, now) {
  mkdirSync(path.dirname(cachePath), { recursive: true })
  writeFileSync(
    cachePath,
    JSON.stringify({ ...doc, fetchedAt: new Date(now()).toISOString() }),
    { encoding: 'utf8', mode: 0o600 },
  )
}

function bootstrapErrorCode(json, status) {
  const code = json?.error?.code || json?.error || json?.code
  if (typeof code === 'string' && code) return code
  if (status === 503) return 'DESKTOP_BOOTSTRAP_UNCONFIGURED'
  if (status === 404) return 'DESKTOP_BOOTSTRAP_UNAVAILABLE'
  return 'DESKTOP_BOOTSTRAP_HTTP'
}

async function fetchBootstrapJson({ publicOrigin, fetchImpl, timeoutMs }) {
  const origin = String(publicOrigin || '').replace(/\/$/, '')
  if (!origin) throw new Error('publicOrigin required')
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null
  try {
    const response = await fetchImpl(`${origin}/api/desktop/bootstrap`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller?.signal,
    })
    const text = await response.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { status: response.status, ok: response.ok, json }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Bootstrap first, env overlay second. Cache pin/CA changes fail closed.
 */
export async function loadDesktopHostConfig({
  publicOrigin,
  env = process.env,
  fetchImpl = globalThis.fetch,
  cachePath = defaultBootstrapCachePath({ env }),
  now = () => Date.now(),
  timeoutMs = BOOTSTRAP_TIMEOUT_MS,
} = {}) {
  const allowLoopback = env.OPENCLAUDE_DESKTOP_ALLOW_LOOPBACK === '1'
  const envConfig = readDesktopHostConfigFromEnv(env)
  const cachedRaw = cachePath ? readCacheFile(cachePath) : null
  const cached = cachedRaw ? validateBootstrapDocument(cachedRaw, { allowLoopback }) : { ok: false }

  let remote
  try {
    remote = await fetchBootstrapJson({ publicOrigin, fetchImpl, timeoutMs })
  } catch (error) {
    if (cached.ok) {
      return {
        ...applyDesktopEnvOverlay(mapBootstrapToHostConfig(cached.doc, envConfig), env),
        fromCache: true,
        stale: true,
        disabled: false,
      }
    }
    if (envConfig.ready) {
      return { ...envConfig, source: 'env', disabled: false }
    }
    return {
      ready: false,
      disabled: false,
      error: error instanceof Error ? error.message : String(error),
      source: 'error',
    }
  }

  if (remote.status === 404 || remote.status === 503) {
    return {
      ready: false,
      disabled: true,
      disabledReason: bootstrapErrorCode(remote.json, remote.status),
      message: BOOTSTRAP_UNAVAILABLE_MESSAGE,
      source: 'bootstrap',
    }
  }

  if (!remote.ok || !remote.json) {
    if (cached.ok) {
      return {
        ...applyDesktopEnvOverlay(mapBootstrapToHostConfig(cached.doc, envConfig), env),
        fromCache: true,
        stale: true,
        disabled: false,
      }
    }
    if (envConfig.ready) return { ...envConfig, source: 'env', disabled: false }
    return {
      ready: false,
      disabled: true,
      disabledReason: 'INVALID_BOOTSTRAP',
      source: 'bootstrap',
    }
  }

  const validated = validateBootstrapDocument(remote.json, { allowLoopback })
  if (!validated.ok) {
    return {
      ready: false,
      disabled: true,
      disabledReason: 'INVALID_BOOTSTRAP',
      error: validated.error,
      source: 'bootstrap',
    }
  }

  if (cached.ok && cached.doc.origin_spki_pin) {
    const pinChanged = !pinsMatch(cached.doc.origin_spki_pin, validated.doc.origin_spki_pin)
    const caChanged = cached.doc.device_ca_pem !== validated.doc.device_ca_pem
    if (pinChanged || caChanged) {
      return {
        ready: false,
        disabled: true,
        pinChanged: true,
        disabledReason: 'PIN_CHANGED',
        message: BOOTSTRAP_PIN_CHANGED_MESSAGE,
        source: 'bootstrap',
      }
    }
  }

  if (cachePath) {
    try {
      writeCacheFile(cachePath, validated.doc, now)
    } catch {
      /* cache is best-effort */
    }
  }

  return {
    ...applyDesktopEnvOverlay(mapBootstrapToHostConfig(validated.doc, envConfig), env),
    disabled: false,
    fromCache: false,
  }
}
