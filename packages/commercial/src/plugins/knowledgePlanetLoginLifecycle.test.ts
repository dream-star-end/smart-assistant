import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex } from 'node:stream'
import { test } from 'node:test'
import type Docker from 'dockerode'
import type { Pool } from 'pg'
import { KnowledgePlanetDockerService, decodeKnowledgePlanetWorkerFramesForTest } from './knowledgePlanet.js'
import { KnowledgePlanetSetupManager } from './knowledgePlanetSetup.js'
import { KNOWLEDGE_PLANET_WORKER_SOURCE } from './knowledgePlanetWorkerSource.js'
import { KNOWLEDGE_PLANET_LOGIN_DIAGNOSTIC_SOURCE } from './knowledgePlanetLoginDiagnostics.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function setupHarness(beforeReturn?: (args: Parameters<KnowledgePlanetDockerService['startLogin']>[0]) => Promise<void>) {
  const workers: Array<{ args: Parameters<KnowledgePlanetDockerService['startLogin']>[0]; done: ReturnType<typeof deferred<void>>; stops: number }> = []
  let creates = 0
  let now = Date.now()
  const manager = new KnowledgePlanetSetupManager({
    async startLogin(args) {
      const worker = { args, done: deferred<void>(), stops: 0 }
      workers.push(worker)
      await beforeReturn?.(args)
      return { sessionId: args.sessionId, done: worker.done.promise, stop: async () => {
        worker.stops++
        worker.done.reject(new Error('stopped'))
      } }
    },
    async closeAndDrain() {},
  } as KnowledgePlanetDockerService, {
    pool: { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool,
    now: () => now,
    loadEntitledVersion: async () => 41,
    resolvePins: async () => [],
    createAccount: async () => { creates++; return { id: '42' } },
  })
  return { manager, workers, creates: () => creates, advance: () => { now += 240_001 } }
}

test('failed setup stops once, permits retry and fences late QR/auth/failure from the old worker', async () => {
  const h = setupHarness()
  try {
    const first = await h.manager.start(4, true)
    h.workers[0].args.onFailed('WORKER_FAILED')
    assert.equal((await h.manager.status(4, first.sessionId)).errorCode, 'QR_GENERATION_FAILED')
    assert.equal(h.workers[0].stops, 1)
    const next = await h.manager.start(4, true)
    assert.notEqual(next.sessionId, first.sessionId)
    h.workers[0].args.onQr(Buffer.from('late'))
    h.workers[0].args.onAuthenticated({ cookies: [], origins: [] })
    h.workers[0].args.onFailed('LOGIN_EXPIRED')
    await h.manager.cancel(4, first.sessionId)
    assert.equal(h.workers[0].stops, 1)
    assert.equal(h.workers[1].stops, 0)
    assert.equal((await h.manager.status(4, next.sessionId)).status, 'waiting_for_scan')
    assert.equal(h.creates(), 0)
  } finally { await h.manager.closeAndDrain() }
})

test('failure before handle publication still stops and exposes QR timeout', async () => {
  const h = setupHarness(async (args) => { args.onFailed('QR_GENERATION_TIMEOUT') })
  try {
    const result = await h.manager.start(4, true)
    assert.equal(result.status, 'failed')
    assert.equal(result.errorCode, 'QR_GENERATION_TIMEOUT')
    assert.equal(h.workers[0].stops, 1)
  } finally { await h.manager.closeAndDrain() }
})

test('cancel while startup is pending stops the late handle without stopping a replacement', async () => {
  const gate = deferred<void>()
  const entered = deferred<string>()
  const h = setupHarness(async (args) => { entered.resolve(args.sessionId); await gate.promise })
  const start = h.manager.start(4, true)
  const id = await entered.promise
  await h.manager.cancel(4, id)
  gate.resolve()
  assert.equal((await start).status, 'cancelled')
  assert.equal(h.workers[0].stops, 1)
  await h.manager.closeAndDrain()
})

test('expiry releases only waiting work; authenticated finalization wins over late timeout/cancel', async () => {
  const h = setupHarness()
  try {
    const first = await h.manager.start(4, true)
    h.workers[0].args.onQr(Buffer.from('qr'))
    h.advance()
    assert.equal((await h.manager.status(4, first.sessionId)).status, 'expired')
    assert.equal(h.workers[0].stops, 1)
    const next = await h.manager.start(4, true)
    h.workers[1].args.onQr(Buffer.from('qr'))
    h.workers[1].args.onAuthenticated({ cookies: [], origins: [] })
    h.workers[1].args.onFailed('LOGIN_EXPIRED')
    h.advance()
    assert.equal((await h.manager.cancel(4, next.sessionId)).status, 'finalizing')
    assert.equal(h.workers[1].stops, 0)
    h.workers[1].done.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal((await h.manager.status(4, next.sessionId)).status, 'active')
    assert.equal(h.creates(), 1)
  } finally { await h.manager.closeAndDrain() }
})

test('a rejected done without a terminal frame cannot accept late authentication', async () => {
  const h = setupHarness()
  try {
    const first = await h.manager.start(4, true)
    h.workers[0].done.reject(new Error('transport'))
    await new Promise((resolve) => setImmediate(resolve))
    h.workers[0].args.onAuthenticated({ cookies: [], origins: [] })
    assert.equal((await h.manager.status(4, first.sessionId)).status, 'failed')
    assert.equal(h.creates(), 0)
  } finally { await h.manager.closeAndDrain() }
})

function frame(value: unknown) {
  const body = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

test('failed frame during Docker startup kills its exact container and releases the single slot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kp-login-lifecycle-'))
  const imageId = `sha256:${'2'.repeat(64)}`
  const containers: Array<{ kills: number; removed: boolean }> = []
  const docker = {
    getImage: () => ({ inspect: async () => ({ Id: imageId }) }),
    listContainers: async () => [],
    modem: { demuxStream: (stream: Duplex, stdout: NodeJS.WritableStream) => stream.pipe(stdout) },
    async createContainer() {
      const state = { kills: 0, removed: false }
      containers.push(state)
      const exited = deferred<{ StatusCode: number }>()
      const stream = new Duplex({
        read() {},
        write(_chunk, _encoding, callback) {
          this.push(frame({ event: 'ready', runtime: 'knowledge-planet-worker-v1.5', playwrightMcpVersion: '0.0.76' }))
          if (containers.length < 3) this.push(frame({ event: 'failed', code: 'QR_GENERATION_TIMEOUT', diagnostic: { stage: 'capture_qr', reason: 'timeout' } }))
          callback()
        },
      })
      return {
        attach: async () => stream,
        start: async () => {},
        kill: async () => { state.kills++; exited.resolve({ StatusCode: 137 }); stream.push(null) },
        wait: () => exited.promise,
        remove: async () => { state.removed = true },
        inspect: async () => { if (state.removed) throw { statusCode: 404 }; return {} },
      }
    },
  } as unknown as Docker
  const service = new KnowledgePlanetDockerService(docker, {
    imageId, workerRoot: join(root, 'worker'), brokerRoot: join(root, 'broker'),
    expectedOwnerUid: process.getuid?.() ?? 0, socketUid: process.getuid?.() ?? 0, maxLoginWorkers: 1,
  })
  try {
    const failures: string[] = []
    const args = { pins: [{ origin: 'https://wx.zsxq.com:443', hostname: 'wx.zsxq.com', port: 443, ip: '1.1.1.1', family: 4 as const }], deadlineMs: Date.now() + 240_000, onQr() {}, onAuthenticated() { assert.fail('unexpected auth') }, onFailed(code: string) { failures.push(code) } }
    const first = await service.startLogin({ ...args, sessionId: 'first' })
    await first.done.catch(() => {})
    assert.equal(containers[0].kills, 1)
    assert.equal(containers[0].removed, true)
    const second = await service.startLogin({ ...args, sessionId: 'second' })
    await second.done.catch(() => {})
    assert.deepEqual(failures, ['QR_GENERATION_TIMEOUT', 'QR_GENERATION_TIMEOUT'])
    assert.equal(containers[1].removed, true)
    const replacement = await service.startLogin({ ...args, sessionId: 'first' })
    await first.stop()
    assert.equal(containers[2].kills, 0, 'stale handle cannot stop a replacement with the same key')
    await replacement.stop()
    await replacement.done.catch(() => {})
    assert.equal(containers[2].removed, true)
  } finally { await service.closeAndDrain(); await rm(root, { recursive: true, force: true }) }
})

for (const mode of ['navigate', 'capture_qr', 'authenticated'] as const) {
  test(`worker ${mode} terminal flush exits even when browser cleanup never resolves`, async () => {
    const source = KNOWLEDGE_PLANET_WORKER_SOURCE
    const helpers = source.slice(source.indexOf('function encodeFrame'), source.indexOf('async function readFrame'))
    const login = source.slice(source.indexOf('async function runLogin'), source.indexOf('\ntry {\n  const input'))
    const program = `import {createHash} from 'node:crypto';
      const MAX_OUTPUT=1048576; const loginDiagnostic={stage:'launch',reason:'unknown'};
      ${KNOWLEDGE_PLANET_LOGIN_DIAGNOSTIC_SOURCE}
      ${helpers}
      const mode=${JSON.stringify(mode)};
      const page={ route:async()=>{}, on:()=>{}, goto:async()=>{if(mode==='navigate')throw new Error('net::ERR_PROXY_CONNECTION_FAILED https://example.invalid/?token=SECRET')}, getByRole:()=>({first:()=>({})}), getByText:()=>({first:()=>({isVisible:async()=>false})}), url:()=> 'https://wx.zsxq.com/', waitForTimeout:async()=>{} };
      const context={newPage:async()=>page,storageState:async()=>({cookies:[],origins:[]})};
      const chromium={launch:async()=>({newContext:async()=>context,close:()=>new Promise(()=>{})})};
      const beforeCaptureDeadline=async(op)=>op();
      const remainingCaptureTimeout=()=>1;
      const captureQr=async()=>{if(mode==='capture_qr')throw new Error('qr');return Buffer.from([137,80,78,71,13,10,26,10])};
      const scheduleKnowledgePlanetLoginProbe=()=>({due:true,pageHintApplied:true,nextProbeAt:0});
      const authenticatedProbe=async()=>true; const hasAuthenticatedKnowledgePlanetSession=x=>x; const filteredState=x=>x;
      ${login}
      setInterval(()=>{},1000); // reproduce an open input/relay keeping the worker alive
      await runLogin({allowedOrigins:[],deadlineMs:Date.now()+240000,cookieDomains:[],stateOrigins:[]},{proxy:'http://127.0.0.1:1'});
    `
    const child = spawn(process.execPath, ['--input-type=module', '-e', program], { stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    const errors: Buffer[] = []
    child.stderr.on('data', (chunk) => errors.push(chunk))
    let deadline: NodeJS.Timeout | undefined
    try {
      const code = await Promise.race([
        new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) }),
        new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('worker failed to exit promptly')), 3000) }),
      ])
      assert.equal(code, 0, Buffer.concat(errors).toString())
      const output = Buffer.concat(chunks)
      assert.equal(output.includes(Buffer.from('SECRET')), false)
      decodeKnowledgePlanetWorkerFramesForTest(output)
      const events: Array<Record<string, unknown>> = []
      for (let offset = 0; offset < output.length;) {
        const size = output.readUInt32BE(offset)
        events.push(JSON.parse(output.subarray(offset + 4, offset + 4 + size).toString()))
        offset += 4 + size
      }
      const terminal = events.at(-1)
      if (mode === 'authenticated') assert.equal(terminal?.event, 'authenticated')
      else assert.deepEqual(terminal, { event: 'failed', code: mode === 'navigate' ? 'QR_GENERATION_FAILED' : 'QR_GENERATION_TIMEOUT', diagnostic: { stage: mode, reason: mode === 'navigate' ? 'proxy' : 'timeout' } })
    } finally { if (deadline) clearTimeout(deadline); child.kill(); child.stdin.destroy() }
  })
}

test('worker diagnostics reject arbitrary text and extra fields before logging', () => {
  assert.equal(decodeKnowledgePlanetWorkerFramesForTest(frame({ event: 'failed', code: 'QR_GENERATION_FAILED', diagnostic: { stage: 'capture_qr', reason: 'timeout' } })), 1)
  for (const diagnostic of [{ stage: 'capture_qr', reason: 'https://example.invalid/?token=SECRET' }, { stage: 'capture_qr', reason: 'timeout', cookie: 'SECRET' }]) {
    assert.throws(() => decodeKnowledgePlanetWorkerFramesForTest(frame({ event: 'failed', code: 'QR_GENERATION_FAILED', diagnostic })))
  }
})

test('abandoned setup expires and stops without any status polling', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = setupHarness()
  try {
    await h.manager.start(4, true)
    h.advance()
    t.mock.timers.tick(240_000)
    assert.equal(h.workers[0].stops, 1)
  } finally { await h.manager.closeAndDrain(); t.mock.timers.reset() }
})

test('late QR and authentication after the deadline cannot win ahead of the expiry timer', async () => {
  const h = setupHarness()
  try {
    const setup = await h.manager.start(4, true)
    h.advance()
    h.workers[0].args.onAuthenticated({ cookies: [], origins: [] })
    h.workers[0].args.onQr(Buffer.from('late'))
    const failed = await h.manager.status(4, setup.sessionId)
    assert.equal(failed.errorCode, 'QR_GENERATION_TIMEOUT')
    assert.equal(failed.qrReady, false)
    assert.equal(h.workers[0].stops, 1)
    assert.equal(h.creates(), 0)
  } finally { await h.manager.closeAndDrain() }
})
