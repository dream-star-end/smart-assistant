/**
 * ChatGPT direct-connect proxy feature flags.
 *
 * env 关 → settings 无权打开(fail-closed)。30s TTL cache 热读 system_settings。
 * 结构照抄 desktop/flags.ts。
 */

import { getSystemSetting } from '../admin/systemSettings.js'

const SETTINGS_TTL_MS = 30_000
const DEFAULT_PORT = 8443
const DEFAULT_UPSTREAM = 'http://127.0.0.1:18991'

export interface ChatGptProxyEnv {
  /** OC_CHATGPT_PROXY_ENABLED === "1" */
  enabled: boolean
  /** Public hostname browsers dial (also the TLS SAN). */
  publicHost: string
  /** Public TLS listen port. */
  port: number
  tlsCertPath: string
  tlsKeyPath: string
  /** Upstream HTTP CONNECT proxy (subscription egress). */
  upstream: URL | null
  /** Non-empty when enabled but misconfigured; callers must treat as disabled. */
  configError: string | null
}

export function readChatGptProxyEnv(env: NodeJS.ProcessEnv = process.env): ChatGptProxyEnv {
  const enabled = env.OC_CHATGPT_PROXY_ENABLED === '1'
  const publicHost = (env.OC_CHATGPT_PROXY_PUBLIC_HOST ?? '').trim().toLowerCase()
  const portRaw = (env.OC_CHATGPT_PROXY_PORT ?? '').trim()
  const port = portRaw === '' ? DEFAULT_PORT : Number(portRaw)
  const tlsCertPath = (env.OC_CHATGPT_PROXY_TLS_CERT ?? '').trim()
  const tlsKeyPath = (env.OC_CHATGPT_PROXY_TLS_KEY ?? '').trim()
  const upstreamRaw = (env.OC_CHATGPT_PROXY_UPSTREAM ?? DEFAULT_UPSTREAM).trim()
  let upstream: URL | null = null
  let configError: string | null = null
  try {
    upstream = new URL(upstreamRaw)
    if (upstream.protocol !== 'http:') configError = 'OC_CHATGPT_PROXY_UPSTREAM must be http://'
  } catch {
    configError = 'OC_CHATGPT_PROXY_UPSTREAM is not a URL'
  }
  if (enabled && !configError) {
    if (!publicHost) configError = 'OC_CHATGPT_PROXY_PUBLIC_HOST is required'
    else if (!Number.isInteger(port) || port < 1 || port > 65_535)
      configError = 'OC_CHATGPT_PROXY_PORT is invalid'
    else if (!tlsCertPath || !tlsKeyPath)
      configError = 'OC_CHATGPT_PROXY_TLS_CERT / OC_CHATGPT_PROXY_TLS_KEY are required'
  }
  return { enabled, publicHost, port, tlsCertPath, tlsKeyPath, upstream, configError }
}

export interface ChatGptProxyFlagSnapshot {
  envEnabled: boolean
  /** system_settings.chatgpt_proxy_enabled */
  settingsOn: boolean
  allowlist: readonly number[]
  /** env on AND settings on */
  assembled: boolean
}

type SettingsLoader = () => Promise<{ settingsOn: boolean; allowlist: readonly number[] }>

let cache: { at: number; settingsOn: boolean; allowlist: readonly number[] } | null = null
let loader: SettingsLoader | null = null

export function setChatGptProxySettingsLoader(fn: SettingsLoader | null): void {
  loader = fn
  cache = null
}

export function resetChatGptProxyFlagCache(): void {
  cache = null
}

async function loadSettings(
  now: number,
): Promise<{ settingsOn: boolean; allowlist: readonly number[] }> {
  if (cache && now - cache.at < SETTINGS_TTL_MS) {
    return { settingsOn: cache.settingsOn, allowlist: cache.allowlist }
  }
  const fn = loader ?? defaultLoadSettings
  const snap = await fn()
  cache = { at: now, settingsOn: snap.settingsOn, allowlist: snap.allowlist }
  return snap
}

async function defaultLoadSettings(): Promise<{
  settingsOn: boolean
  allowlist: readonly number[]
}> {
  const [flag, list] = await Promise.all([
    getSystemSetting('chatgpt_proxy_enabled'),
    getSystemSetting('chatgpt_proxy_allowlist'),
  ])
  const allowlist = Array.isArray(list.value)
    ? list.value.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0)
    : []
  return { settingsOn: flag.value === true, allowlist }
}

export async function getChatGptProxyFlagSnapshot(
  now = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChatGptProxyFlagSnapshot> {
  const e = readChatGptProxyEnv(env)
  const envEnabled = e.enabled && e.configError === null
  const settings = envEnabled
    ? await loadSettings(now)
    : { settingsOn: false, allowlist: [] as const }
  return {
    envEnabled,
    settingsOn: settings.settingsOn,
    allowlist: settings.allowlist,
    assembled: envEnabled && settings.settingsOn,
  }
}

export function isChatGptProxyEntitled(
  uid: number,
  role: string,
  allowlist: readonly number[],
): boolean {
  if (role === 'admin') return true
  return allowlist.includes(uid)
}
