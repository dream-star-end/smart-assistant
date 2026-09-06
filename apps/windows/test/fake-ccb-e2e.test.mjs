import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { createIdentityBridge } from '../src/host/identityBridge.mjs'
import { createLahToken } from '../src/host/tokens.mjs'
import { createEgressProxy } from '../src/host/localProxy.mjs'
import { buildGatewayEnv, assertGatewayEnvSafe } from '../src/host/gatewayProcess.mjs'
import { spkiSha256Base64FromPem } from '../src/tunnel/bootstrap.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const fakeCcb = path.join(here, 'fixtures/fake-ccb.mjs')
const tlsDir = path.join(here, 'fixtures/tls')

function pem(name) {
  return fs.readFileSync(path.join(tlsDir, name), 'utf8')
}

function identityWithSession() {
  const identity = createIdentityBridge({
    deviceId: '11111111-1111-1111-1111-111111111111',
    containerId: 42,
    device_cert: pem('device.crt'),
    device_key: pem('device.key'),
    device_credential: 'oc-dv.11111111-1111-1111-1111-111111111111.' + 'ab'.repeat(32),
  })
  identity.setSession('oc-v3.42.' + 'e'.repeat(64), 1, 42)
  return identity
}

function serveSseOrigin() {
  const server = https.createServer({
    key: pem('origin.key'),
    cert: pem('origin.crt'),
    ca: pem('ca.crt'),
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.3',
    maxVersion: 'TLSv1.3',
  }, (req, res) => {
    const url = new URL(req.url || '/', 'https://127.0.0.1')
    req.resume()
    req.on('end', () => {
      if (req.method === 'POST' && url.pathname === '/v1/messages') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: {"delta":{"text":"pong-from-18446"}}\n\n')
        res.end()
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

function runFakeCcb({ env, userText = 'hello' }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fakeCcb, '-p', '--input-format=stream-json', ''], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const out = []
    const err = []
    child.stdout.on('data', (c) => out.push(c))
    child.stderr.on('data', (c) => err.push(c))
    child.on('error', reject)
    child.on('exit', (code) => {
      const stdout = Buffer.concat(out).toString('utf8')
      const lines = stdout.split('\n').filter(Boolean).map((line) => {
        try { return JSON.parse(line) } catch { return { raw: line } }
      })
      resolve({ code, lines, stdout, stderr: Buffer.concat(err).toString('utf8') })
    })
    const userMsg = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: userText }] },
    }
    child.stdin.write(`${JSON.stringify(userMsg)}\n`)
    child.stdin.end()
    setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* */ }
    }, 8_000).unref?.()
  })
}

test('buildGatewayEnv injects loopback CCB proxy env with oc-lah token and no API key', () => {
  const lah = createLahToken()
  const env = buildGatewayEnv({
    baseEnv: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'sk-real-should-go' },
    localBridgeToken: 'aa'.repeat(32),
    lahGwToken: 'oc-lah-gw.' + 'bb'.repeat(32),
    lahToken: lah,
    masterProxyPort: 18792,
    egressProxyPort: 18791,
    claudeCodePath: fakeCcb,
    claudeCodeRuntime: 'node',
  })
  assertGatewayEnvSafe(env)
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:18791')
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, lah)
  assert.equal(env.OPENCLAUDE_ENGINES, 'ccb')
  assert.equal(env.OPENCLAUDE_CLAUDE_CODE_PATH, fakeCcb)
  assert.equal(env.OPENCLAUDE_CLAUDE_CODE_RUNTIME, 'node')
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1')
  assert.equal(env.CLAUDE_CODE_MAX_RETRIES, '2')
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
  assert.equal(env.OPENCLAUDE_V3_CONTAINER_TOKEN.startsWith('oc-lah-gw.'), true)
})

test('fake-ccb uses gateway env to round-trip 18791 -> stub 18446 SSE', { timeout: 15_000 }, async () => {
  const origin = await serveSseOrigin()
  const lah = createLahToken()
  const proxy = createEgressProxy({
    port: 0,
    lahToken: lah,
    identity: identityWithSession(),
    egressOrigin: `https://127.0.0.1:${origin.port}`,
    spkiPin: spkiSha256Base64FromPem(pem('origin.crt')),
    deviceCaPem: pem('ca.crt'),
  })
  await proxy.start()
  try {
    const env = buildGatewayEnv({
      baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME },
      localBridgeToken: 'aa'.repeat(32),
      lahGwToken: 'oc-lah-gw.' + 'cc'.repeat(32),
      lahToken: lah,
      masterProxyPort: 18792,
      egressProxyPort: proxy.port,
      claudeCodePath: fakeCcb,
      claudeCodeEntry: fakeCcb,
      claudeCodeRuntime: 'node',
    })
    const result = await runFakeCcb({ env, userText: 'ping' })
    const assistant = result.lines.find((line) => line.type === 'assistant')
    const final = result.lines.find((line) => line.type === 'result')
    assert.ok(assistant, `missing assistant: ${result.stdout} ${result.stderr}`)
    assert.match(JSON.stringify(assistant), /pong-from-18446/)
    assert.equal(final?.is_error, false)
    assert.equal(final?.session_id, 'fake-ccb')
    assert.equal(proxy.stats.success >= 1, true)
    assert.equal(proxy.stats.unauth, 0)
  } finally {
    await proxy.stop()
    await origin.close()
  }
})
