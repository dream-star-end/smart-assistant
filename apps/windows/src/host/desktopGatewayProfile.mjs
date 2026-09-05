/**
 * Minimal onboard profile so Host can spawn the real `Gateway` class (S3c leftover, E2).
 * Windows: %LOCALAPPDATA%\Clarvy\gateway\
 * Linux tests: tmp / OPENCLAUDE_HOME.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const GATEWAY_PROFILE_PRODUCT = 'Clarvy'
export const GATEWAY_PROFILE_DIRNAME = 'gateway'

export function resolveGatewayProfileDir({
  platform = process.platform,
  env = process.env,
  tmpdir = os.tmpdir(),
} = {}) {
  if (typeof env.OPENCLAUDE_HOME === 'string' && env.OPENCLAUDE_HOME.trim()) {
    return env.OPENCLAUDE_HOME.trim()
  }
  if (platform === 'win32' && typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA) {
    return path.win32.join(env.LOCALAPPDATA, GATEWAY_PROFILE_PRODUCT, GATEWAY_PROFILE_DIRNAME)
  }
  if (typeof env.CLARVY_GATEWAY_HOME === 'string' && env.CLARVY_GATEWAY_HOME.trim()) {
    return env.CLARVY_GATEWAY_HOME.trim()
  }
  return path.join(tmpdir, 'clarvy-gateway')
}

export function randomGatewayAccessToken() {
  return crypto.randomBytes(24).toString('hex')
}

export function buildDesktopGatewayConfig({
  gatewayPort = 18789,
  claudeCodePath = '',
  claudeCodeEntry = '',
  claudeCodeRuntime = 'node',
  accessToken,
} = {}) {
  return {
    gateway: {
      bind: '127.0.0.1',
      port: Number(gatewayPort) || 18789,
      accessToken: accessToken || randomGatewayAccessToken(),
    },
    auth: {
      mode: 'custom_platform',
      claudeCodePath: claudeCodePath || '',
      ...(claudeCodeEntry ? { claudeCodeEntry } : {}),
      claudeCodeRuntime: claudeCodeRuntime === 'bun' ? 'bun' : 'node',
    },
    defaults: {
      model: 'claude-sonnet-4-6',
      permissionMode: 'default',
    },
    channels: {
      webchat: { enabled: true },
    },
    terminal: {
      type: 'local',
    },
  }
}

export function writeDesktopGatewayProfile(profileDir, config) {
  if (typeof profileDir !== 'string' || profileDir.length === 0) {
    throw new TypeError('profileDir required')
  }
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  const configPath = path.join(profileDir, 'openclaude.json')
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  const agentsPath = path.join(profileDir, 'agents.yaml')
  if (!fs.existsSync(agentsPath)) {
    fs.writeFileSync(agentsPath, 'agents:\n  - id: main\nroutes: []\ndefault: main\n', { mode: 0o600 })
  }
  return { configPath, agentsPath, profileDir }
}

export function packPolicyFromBuilderYaml(yamlText) {
  const text = String(yamlText || '').replace(/#.*$/gm, '')
  const hasAsarTrue = /^\s*asar:\s*true\s*$/m.test(text)
  const unpacksHost = /asarUnpack:[\s\S]*src\/host/m.test(text)
  const includesManifest = /runtime-manifest\.json/.test(text)
  const filesIncludeTest = /(?:^|\n)\s*-\s*test\//.test(text)
  const filesIncludeFakeCcb = /(?:^|\n)\s*-\s*.*fake-ccb/.test(text)
  return {
    hasAsarTrue,
    unpacksHost,
    includesManifest,
    packagesFakeCcb: filesIncludeTest || filesIncludeFakeCcb,
  }
}
