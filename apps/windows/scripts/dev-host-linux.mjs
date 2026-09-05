#!/usr/bin/env node
/**
 * Linux-only fixture for S4/S6: stub 18445/18446 + Local Agent Host + real
 * local-bridge gateway (checkLocalBridge). Not part of the Windows installer.
 *
 *   node apps/windows/scripts/dev-host-linux.mjs
 *
 * Env:
 *   OPENCLAUDE_DEV_FIXED_PORTS=1  bind 18789/18791/18792/18445 instead of ephemeral
 *
 * Ctrl-C / SIGTERM stops Host, gateway child, and the stub.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

import { createHostRuntime } from '../src/host/runtime.mjs'
import { spkiSha256Base64FromPem } from '../src/tunnel/bootstrap.mjs'
import { TunnelState } from '../src/tunnel/tunnelClient.mjs'
import { createStub18445 } from '../test/fixtures/stub-18445.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const windowsRoot = path.resolve(here, '..')
const tlsDir = path.join(windowsRoot, 'test/fixtures/tls')
const realGateway = path.join(windowsRoot, 'test/fixtures/real-local-bridge-gateway.mjs')

function pem(name) {
  const p = path.join(tlsDir, name)
  if (!fs.existsSync(p)) throw new Error(`missing TLS fixture ${p}`)
  return fs.readFileSync(p, 'utf8')
}

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

function sampleRecord() {
  return {
    deviceId: '11111111-1111-1111-1111-111111111111',
    containerId: 42,
    device_cert: pem('device.crt'),
    device_key: pem('device.key'),
    device_credential: 'oc-dv.11111111-1111-1111-1111-111111111111.' + 'ab'.repeat(32),
  }
}

async function main() {
  if (process.platform === 'win32') {
    console.error('dev-host-linux.mjs is a Linux fixture; Windows true-host is S6.')
    process.exit(2)
  }
  const fixed = process.env.OPENCLAUDE_DEV_FIXED_PORTS === '1'
  const originKey = pem('origin.key')
  const originCert = pem('origin.crt')
  const caCert = pem('ca.crt')
  const stub = createStub18445({ originKey, originCert, caCert })
  const originPort = fixed ? 18445 : await stub.listen()
  if (fixed) {
    await new Promise((resolve, reject) => {
      stub.server.listen({ host: '127.0.0.1', port: 18445, exclusive: true }, resolve)
      stub.server.once('error', reject)
    })
  }
  const origin = `https://127.0.0.1:${originPort}`
  const gatewayPort = fixed ? 18789 : await freePort()
  const repoRoot = path.resolve(windowsRoot, '../..')
  const tsx = path.join(repoRoot, 'node_modules/.bin/tsx')
  const gatewayCommand = fs.existsSync(tsx) ? tsx : process.execPath
  const gatewayArgs = fs.existsSync(tsx) ? [realGateway] : [realGateway]
  const runtime = createHostRuntime({
    registerOrigin: origin,
    egressOrigin: origin,
    spkiPin: spkiSha256Base64FromPem(originCert),
    deviceCaPem: caCert,
    keyringFp: 'abc',
    gatewayCommand,
    gatewayArgs,
    gatewayExtraEnv: fs.existsSync(tsx) ? { OC_S3C_GATEWAY_LOADER: '1' } : {},
    gatewayPort,
    egressPort: fixed ? 18791 : 0,
    masterPort: fixed ? 18792 : 0,
    onState: (state) => {
      if (state === TunnelState.REGISTERED) console.error('[dev-host] tunnel registered')
    },
    onDegraded: (info) => console.error('[dev-host] gateway degraded', info),
  })

  const shutdown = async (signal) => {
    console.error(`[dev-host] ${signal}, stopping`)
    try { await runtime.stop(signal) } catch (err) { console.error(err) }
    try { await stub.close() } catch { /* */ }
    process.exit(0)
  }
  process.on('SIGINT', () => { void shutdown('SIGINT') })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })

  const status = await runtime.start(sampleRecord())
  const ports = status.ports
  console.log(JSON.stringify({
    ok: true,
    ports: {
      register: originPort,
      gateway: ports.gateway,
      egress: ports.egress,
      master: ports.master,
    },
    urls: {
      stub18445: origin,
      gateway: `http://127.0.0.1:${ports.gateway}`,
      egress: `http://127.0.0.1:${ports.egress}`,
      master: `http://127.0.0.1:${ports.master}`,
    },
    tokens: {
      location: 'Host process memory (runtime.tokens); not written to disk',
      localBridgeBytes: 32,
      localBridgeHexChars: 64,
      lahGwPrefix: 'oc-lah-gw.',
    },
    degraded: status.degraded,
  }, null, 2))
  console.error('Ctrl-C stops stub 18445 + Host proxies + gateway.')
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
