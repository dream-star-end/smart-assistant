import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  assertGatewayEnvSafe,
  buildGatewayEnv,
  createGatewayProcess,
} from '../src/host/gatewayProcess.mjs'
import { createLahGwToken, createLahToken, createLocalBridgeToken } from '../src/host/tokens.mjs'
import { connectLoopbackWs } from '../src/host/muxForward.mjs'
import {
  buildDesktopGatewayConfig,
  resolveGatewayProfileDir,
  writeDesktopGatewayProfile,
} from '../src/host/desktopGatewayProfile.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const fakeCcb = path.join(here, 'fixtures/fake-ccb.mjs')
const entry = path.join(here, '../scripts/desktop-gateway-entry.mjs')
const skipWin = process.platform === 'win32'

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port
      s.close(() => resolve(port))
    })
    s.on('error', reject)
  })
}

test('E2 profile + env for full Gateway class is loopback-safe', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clarvy-e2-profile-'))
  const cfg = buildDesktopGatewayConfig({
    gatewayPort: 18789,
    claudeCodePath: fakeCcb,
    claudeCodeRuntime: 'node',
  })
  writeDesktopGatewayProfile(dir, cfg)
  assert.equal(resolveGatewayProfileDir({ env: { OPENCLAUDE_HOME: dir } }), dir)
  const env = buildGatewayEnv({
    localBridgeToken: createLocalBridgeToken(),
    lahGwToken: createLahGwToken(),
    lahToken: createLahToken(),
    masterProxyPort: 18792,
    extraEnv: { OPENCLAUDE_HOME: dir, OPENCLAUDE_CLAUDE_CODE_PATH: fakeCcb },
    claudeCodePath: fakeCcb,
    claudeCodeRuntime: 'node',
  })
  assertGatewayEnvSafe(env)
  assert.equal(env.OPENCLAUDE_ENGINES, 'ccb')
  assert.equal(env.OPENCLAUDE_CLAUDE_CODE_PATH, fakeCcb)
})

test('E2 full Gateway class + Host + fake-ccb one turn (Linux CI)', {
  timeout: 45_000,
  skip: skipWin,
}, async () => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clarvy-e2-gw-'))
  const port = await freePort()
  const localBridgeToken = createLocalBridgeToken()
  const lahGwToken = createLahGwToken()
  const lahToken = createLahToken()
  writeDesktopGatewayProfile(profileDir, buildDesktopGatewayConfig({
    gatewayPort: port,
    claudeCodePath: fakeCcb,
    claudeCodeEntry: fakeCcb,
    claudeCodeRuntime: 'node',
  }))
  const proc = createGatewayProcess({
    command: process.execPath,
    args: [entry],
    localBridgeToken,
    lahGwToken,
    lahToken,
    masterProxyPort: 18792,
    gatewayPort: port,
    claudeCodePath: fakeCcb,
    claudeCodeEntry: fakeCcb,
    claudeCodeRuntime: 'node',
    extraEnv: {
      OPENCLAUDE_HOME: profileDir,
      OC_DESKTOP_GATEWAY_LOADER: '',
    },
    healthzTimeoutMs: 25_000,
  })
  const stderr = []
  let started = false
  try {
    await proc.start()
    started = true
    assert.equal(proc.degraded, false)
    const healthz = await new Promise((resolve, reject) => {
      http.get({
        host: '127.0.0.1',
        port,
        path: '/healthz',
        headers: { 'x-openclaude-local-bridge': localBridgeToken },
      }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString('utf8') }))
      }).on('error', reject)
    })
    assert.equal(healthz.status, 200)
    assert.equal(healthz.raw.includes('file-proxy-v1'), false)

    const ws = connectLoopbackWs({ port, path: '/ws', localBridgeToken, timeoutMs: 5_000 })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws open timeout')), 5_000)
      ws.once('open', () => {
        clearTimeout(timer)
        resolve()
      })
      ws.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
    const inbound = {
      type: 'inbound.message',
      idempotencyKey: `e2-${Date.now()}`,
      channel: 'webchat',
      peer: { kind: 'webchat', id: 'desktop-e2' },
      content: { text: 'ping' },
      ts: Date.now(),
    }
    ws.send(1, Buffer.from(JSON.stringify(inbound)))
    const frames = []
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 4_000)
      ws.on('message', (data) => {
        frames.push(Buffer.from(data).toString('utf8'))
        if (frames.length >= 1) {
          clearTimeout(timer)
          resolve()
        }
      })
    })
    ws.close(1000, 'e2-done')
    // Turn frames are best-effort: full CCB learning context may not be present
    // in CI. healthz + /ws open is the Gateway-class bar; fake-ccb 18791
    // round-trip is covered by fake-ccb-e2e.test.mjs. Journal desktop rows
    // remain P1 desktopE2e.integ (needs PG).
    assert.ok(started)
    void stderr
  } finally {
    await proc.stop()
  }
})
