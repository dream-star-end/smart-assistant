import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  buildDesktopGatewayConfig,
  packPolicyFromBuilderYaml,
  resolveGatewayProfileDir,
  writeDesktopGatewayProfile,
} from '../src/host/desktopGatewayProfile.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

test('resolveGatewayProfileDir uses LOCALAPPDATA\\Clarvy\\gateway on win32', () => {
  assert.equal(
    resolveGatewayProfileDir({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
    }),
    'C:\\Users\\u\\AppData\\Local\\Clarvy\\gateway',
  )
  const tmp = resolveGatewayProfileDir({
    platform: 'linux',
    env: {},
    tmpdir: '/tmp',
  })
  assert.equal(tmp, '/tmp/clarvy-gateway')
  assert.equal(
    resolveGatewayProfileDir({ env: { OPENCLAUDE_HOME: '/tmp/oc-home' } }),
    '/tmp/oc-home',
  )
})

test('writeDesktopGatewayProfile writes openclaude.json with loopback bind and ccb runtime', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clarvy-gw-profile-'))
  const cfg = buildDesktopGatewayConfig({
    gatewayPort: 18789,
    claudeCodePath: '/tmp/fake-ccb.mjs',
    claudeCodeRuntime: 'node',
    accessToken: 'tok',
  })
  const written = writeDesktopGatewayProfile(dir, cfg)
  const raw = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
  assert.equal(raw.gateway.bind, '127.0.0.1')
  assert.equal(raw.gateway.port, 18789)
  assert.equal(raw.auth.claudeCodeRuntime, 'node')
  assert.equal(raw.auth.mode, 'custom_platform')
  assert.equal(fs.existsSync(written.agentsPath), true)
})

test('electron-builder unpacks Host modules, bakes runtime-manifest, and does not pack fake-ccb', () => {
  const yaml = fs.readFileSync(path.join(here, '../electron-builder.yml'), 'utf8')
  const policy = packPolicyFromBuilderYaml(yaml)
  assert.equal(policy.hasAsarTrue, true)
  assert.equal(policy.unpacksHost, true)
  assert.equal(policy.includesManifest, true)
  assert.equal(policy.packagesFakeCcb, false)
})
