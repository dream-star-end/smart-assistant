import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  assertElectronHostTransport,
  electronHasUtilityProcess,
  spawnHostProcess,
} from '../src/host/hostTransport.mjs'
import { runLocalHostSmoke } from '../src/localHostSmoke.mjs'

test('Electron without utilityProcess.fork fails closed and never uses ELECTRON_RUN_AS_NODE', () => {
  assert.equal(electronHasUtilityProcess({ electron: '43.0.0' }, null), false)
  assert.throws(
    () => assertElectronHostTransport({ versions: { electron: '43.0.0' }, utilityProcess: null }),
    /utilityProcess\.fork/,
  )
})

test('node test transport uses child_process.fork and strips ELECTRON_RUN_AS_NODE', () => {
  const forks = []
  const fakeChild = {
    pid: 4242,
    stdout: { on() {} },
    stderr: { on() {} },
    send() {},
    on() { return fakeChild },
    once() { return fakeChild },
    kill() {},
  }
  const { child, kind } = spawnHostProcess({
    hostEntry: '/tmp/hostMain.mjs',
    execPath: process.execPath,
    env: { ELECTRON_RUN_AS_NODE: '1', OPENCLAUDE_TRUST_BRIDGE_IP: '127.0.0.1', PATH: '/bin' },
    versions: { node: process.versions.node },
    forkImpl: (entry, args, opts) => {
      forks.push({ entry, args, opts })
      return fakeChild
    },
  })
  assert.equal(kind, 'fork')
  assert.equal(child.pid, 4242)
  assert.equal(forks.length, 1)
  assert.equal(forks[0].entry, '/tmp/hostMain.mjs')
  assert.equal(forks[0].opts.env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(forks[0].opts.env.OPENCLAUDE_TRUST_BRIDGE_IP, undefined)
  assert.equal(forks[0].opts.stdio.includes('ipc'), true)
})

test('injected utilityProcess.fork is used when Electron is present', () => {
  const forks = []
  const fakeProc = {
    pid: 7,
    stdout: null,
    stderr: null,
    postMessage() {},
    kill() {},
    on() {},
    once() {},
  }
  const { child, kind } = spawnHostProcess({
    hostEntry: '/app/hostMain.mjs',
    versions: { electron: '43.0.0' },
    utilityProcess: {
      fork(entry, args, opts) {
        forks.push({ entry, args, opts })
        return fakeProc
      },
    },
  })
  assert.equal(kind, 'utilityProcess')
  assert.equal(child.spawnfile, 'utilityProcess')
  assert.equal(forks[0].entry, '/app/hostMain.mjs')
  assert.equal(forks[0].opts.serviceName, 'clarvy-lah')
  assert.equal(forks[0].opts.env.ELECTRON_RUN_AS_NODE, undefined)
})


test('production Host spawn sources never set ELECTRON_RUN_AS_NODE', () => {
  const files = [
    '../src/hostSupervisor.mjs',
    '../src/host/hostTransport.mjs',
    '../src/host/hostMain.mjs',
    '../src/main.mjs',
  ]
  for (const rel of files) {
    const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8')
    assert.equal(/ELECTRON_RUN_AS_NODE\s*=/.test(src), false, rel)
  }
})

test('local-host smoke waits for ready then stops', async () => {
  const calls = []
  const code = await runLocalHostSmoke({
    createSupervisor: ({ onMessage }) => {
      calls.push('create')
      queueMicrotask(() => onMessage({ type: 'ready', v: 1, pid: 1 }))
      return {
        async start() { calls.push('start') },
        async stop() { calls.push('stop') },
      }
    },
  })
  assert.equal(code, 0)
  assert.deepEqual(calls, ['create', 'start', 'stop'])
})
