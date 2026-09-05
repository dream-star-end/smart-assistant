import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import net from 'node:net'

import {
  assertGatewayEnvSafe,
  buildGatewayEnv,
  createGatewayProcess,
  healthzHasFileProxy,
} from '../src/host/gatewayProcess.mjs'
import { createLahGwToken, createLocalBridgeToken, FORBIDDEN_GATEWAY_ENV } from '../src/host/tokens.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const stubGateway = path.join(here, 'fixtures/stub-gateway.mjs')

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port
      s.close(() => resolve(port))
    })
    s.on('error', reject)
  })
}

test('buildGatewayEnv strips TRUST_BRIDGE trio and never puts oc-v3 in child env', () => {
  const env = buildGatewayEnv({
    baseEnv: {
      PATH: process.env.PATH,
      OPENCLAUDE_TRUST_BRIDGE_IP: '127.0.0.1',
      OC_CONTAINER_ID: '9',
      OC_BRIDGE_NONCE: 'deadbeef',
    },
    localBridgeToken: 'aa'.repeat(32),
    lahGwToken: createLahGwToken(),
    masterProxyPort: 18792,
    extraEnv: { OPENCLAUDE_V3_CONTAINER_TOKEN: 'oc-v3.should.not.win' },
  })
  for (const key of FORBIDDEN_GATEWAY_ENV) {
    assert.equal(Object.hasOwn(env, key), false, key)
  }
  assert.equal(env.OPENCLAUDE_V3_CONTAINER_TOKEN.startsWith('oc-lah-gw.'), true)
  assert.equal(env.OPENCLAUDE_GATEWAY_BIND, '127.0.0.1')
  assertGatewayEnvSafe(env)
})

test('healthzHasFileProxy detects the capability string', () => {
  assert.equal(healthzHasFileProxy(JSON.stringify({ capabilities: ['durable-turn-dispatch-v1'] })), false)
  assert.equal(healthzHasFileProxy(JSON.stringify({ capabilities: ['file-proxy-v1'] })), true)
  assert.equal(healthzHasFileProxy('file-proxy-v1'), true)
})

test('gateway spawn env probe has bridge token and no TRUST_BRIDGE trio', async () => {
  const port = await freePort()
  const proc = createGatewayProcess({
    command: process.execPath,
    args: [stubGateway],
    localBridgeToken: createLocalBridgeToken(),
    lahGwToken: createLahGwToken(),
    masterProxyPort: 18792,
    gatewayPort: port,
  })
  await proc.start()
  try {
    const body = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/env-probe`, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
      }).on('error', reject)
    })
    assert.equal(body.hasTrust, false)
    assert.equal(body.hasCid, false)
    assert.equal(body.hasNonce, false)
    assert.equal(body.hasBridge, true)
    assert.equal(body.bind, '127.0.0.1')
    assert.equal(body.tokenIsOcV3, false)
    assert.equal(body.tokenPrefix.startsWith('oc-lah-gw.'), true)
  } finally {
    await proc.stop()
  }
})

test('healthz advertising file-proxy-v1 marks the gateway degraded', async () => {
  const port = await freePort()
  const alarms = []
  const proc = createGatewayProcess({
    command: process.execPath,
    args: [stubGateway],
    localBridgeToken: createLocalBridgeToken(),
    lahGwToken: createLahGwToken(),
    masterProxyPort: 18792,
    gatewayPort: port,
    extraEnv: { STUB_HEALTHZ_CAPS: 'durable-turn-dispatch-v1,file-proxy-v1' },
    onDegraded: (info) => alarms.push(info),
  })
  await proc.start()
  try {
    assert.equal(proc.degraded, true)
    assert.equal(proc.degradedReason, 'file-proxy-v1')
    assert.ok(alarms.length >= 1)
  } finally {
    await proc.stop()
  }
})
