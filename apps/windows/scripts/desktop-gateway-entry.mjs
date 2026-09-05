#!/usr/bin/env node
/**
 * Spawn the real `packages/gateway` Gateway class for desktop Host (S6 / E2).
 * Writes a minimal OPENCLAUDE_HOME profile, then createGateway().start().
 *
 * Self-reexecs under Node 22 `--experimental-strip-types` or repo-root `tsx`
 * so TypeScript modules resolve. Windows installer does not ship this file
 * as the production CCB path — Host uses OPENCLAUDE_GATEWAY_ENTRY.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  buildDesktopGatewayConfig,
  resolveGatewayProfileDir,
  writeDesktopGatewayProfile,
} from '../src/host/desktopGatewayProfile.mjs'

const self = fileURLToPath(import.meta.url)
const windowsRoot = path.resolve(path.dirname(self), '..')
const repoRoot = path.resolve(windowsRoot, '../..')

function nodeMajor() {
  return Number(String(process.versions.node).split('.')[0])
}

function tsxBin() {
  const base = path.join(repoRoot, 'node_modules', '.bin')
  if (process.platform === 'win32') {
    const cmd = path.join(base, 'tsx.cmd')
    if (fs.existsSync(cmd)) return cmd
  }
  const plain = path.join(base, 'tsx')
  return fs.existsSync(plain) ? plain : null
}

if (!process.env.OC_DESKTOP_GATEWAY_LOADER) {
  const env = { ...process.env, OC_DESKTOP_GATEWAY_LOADER: '1' }
  let command
  let args
  if (nodeMajor() >= 22) {
    command = process.execPath
    args = ['--experimental-strip-types', self]
  } else {
    const tsx = tsxBin()
    if (!tsx) {
      console.error('desktop-gateway-entry: need Node >= 22 or repo-root tsx')
      process.exit(2)
    }
    command = tsx
    args = [self]
  }
  const child = spawn(command, args, {
    env,
    stdio: 'inherit',
    windowsHide: true,
    cwd: repoRoot,
  })
  const forward = (signal) => {
    try { child.kill(signal) } catch { /* */ }
  }
  process.on('SIGTERM', () => forward('SIGTERM'))
  process.on('SIGINT', () => forward('SIGINT'))
  child.on('exit', (code, signal) => {
    if (signal) {
      process.exit(1)
      return
    }
    process.exit(code ?? 1)
  })
} else {
  void main()
}

async function main() {
  const profileDir = resolveGatewayProfileDir({ env: process.env })
  const gatewayPort = Number(process.env.OPENCLAUDE_GATEWAY_PORT) || 18789
  const config = buildDesktopGatewayConfig({
    gatewayPort,
    claudeCodePath: process.env.OPENCLAUDE_CLAUDE_CODE_PATH || '',
    claudeCodeEntry: process.env.OPENCLAUDE_CLAUDE_CODE_ENTRY || '',
    claudeCodeRuntime: process.env.OPENCLAUDE_CLAUDE_CODE_RUNTIME || 'node',
    accessToken: process.env.OPENCLAUDE_GATEWAY_TOKEN || undefined,
  })
  writeDesktopGatewayProfile(profileDir, config)
  process.env.OPENCLAUDE_HOME = profileDir
  process.env.OPENCLAUDE_ENGINES = process.env.OPENCLAUDE_ENGINES || 'ccb'
  delete process.env.OPENCLAUDE_TRUST_BRIDGE_IP
  delete process.env.OC_CONTAINER_ID
  delete process.env.OC_BRIDGE_NONCE
  delete process.env.COMMERCIAL_ENABLED

  const gatewayIndex = pathToFileURL(path.join(repoRoot, 'packages/gateway/src/index.ts')).href
  const storageIndex = pathToFileURL(path.join(repoRoot, 'packages/storage/src/index.ts')).href
  const [{ createGateway }, storage] = await Promise.all([
    import(gatewayIndex),
    import(storageIndex),
  ])
  if (typeof storage.writeConfig === 'function') {
    await storage.writeConfig(config)
  }
  const gw = await createGateway()
  await gw.start()
  const shutdown = async () => {
    try { await gw.shutdown?.(false) } catch { /* */ }
    process.exit(0)
  }
  process.on('SIGTERM', () => { void shutdown() })
  process.on('SIGINT', () => { void shutdown() })
}
