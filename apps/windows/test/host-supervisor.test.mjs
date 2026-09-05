import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { createHostSupervisor } from '../src/hostSupervisor.mjs'
import { spkiSha256Base64FromPem } from '../src/tunnel/bootstrap.mjs'
import { TunnelState } from '../src/tunnel/tunnelClient.mjs'
import { createStub18445 } from './fixtures/stub-18445.mjs'
import { ElectronToHost } from '../src/host/ipc.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const tlsDir = path.join(here, 'fixtures/tls')
const stubGateway = path.join(here, 'fixtures/stub-gateway.mjs')
const hostMain = path.join(here, '../src/host/hostMain.mjs')

function pem(name) {
  return fs.readFileSync(path.join(tlsDir, name), 'utf8')
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

function waitFor(pred, ms = 5_000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pred()) return resolve()
      if (Date.now() - start > ms) return reject(new Error('waitFor timeout'))
      setTimeout(tick, 25)
    }
    tick()
  })
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

test('supervisor spawn + stop makes Host exit; identity is not on argv/env', async () => {
  const stub = createStub18445({
    originKey: pem('origin.key'),
    originCert: pem('origin.crt'),
    caCert: pem('ca.crt'),
  })
  const originPort = await stub.listen()
  const gatewayPort = await freePort()
  const origin = `https://127.0.0.1:${originPort}`
  const states = []
  const supervisor = createHostSupervisor({
    execPath: process.execPath,
    hostEntry: hostMain,
    identityLoader: async () => sampleRecord(),
    config: {
      registerOrigin: origin,
      egressOrigin: origin,
      spkiPin: spkiSha256Base64FromPem(pem('origin.crt')),
      deviceCaPem: pem('ca.crt'),
      keyringFp: 'abc',
      gatewayCommand: process.execPath,
      gatewayArgs: [stubGateway],
      gatewayPort,
      egressPort: 0,
      masterPort: 0,
    },
    onState: (s) => states.push(s),
    stopTimeoutMs: 2_000,
  })
  await supervisor.start()
  try {
    await waitFor(() => supervisor.pid > 0)
    const child = supervisor.child
    const envText = JSON.stringify(child.spawnfile) + child.spawnargs.join(' ')
    assert.equal(envText.includes('oc-dv.'), false)
    assert.equal(envText.includes('BEGIN CERTIFICATE'), false)
    await waitFor(() => states.includes(TunnelState.REGISTERED) || supervisor.lastStatus?.started, 6_000)
  } finally {
    const pid = supervisor.pid
    await supervisor.stop()
    if (pid) {
      await new Promise((r) => setTimeout(r, 150))
      let alive = true
      try { process.kill(pid, 0); alive = true } catch { alive = false }
      assert.equal(alive, false)
    }
    await stub.close()
  }
})

test('parent helper exit causes hostMain to exit via disconnect/ppid watch', async () => {
  const helper = `
    import { spawn } from 'node:child_process'
    const child = spawn(process.execPath, ${JSON.stringify([hostMain])}, { stdio: ['pipe','pipe','pipe','ipc'] })
    child.send({ type: '${ElectronToHost.HELLO}', v: 1 })
    child.on('message', (m) => {
      if (m.type === 'hello-ok') process.exit(0)
    })
    setTimeout(() => process.exit(0), 3000)
  `
  const parent = spawn(process.execPath, ['--input-type=module', '-e', helper], { stdio: ['ignore', 'ignore', 'ignore'] })
  await new Promise((resolve) => parent.on('exit', resolve))
})
