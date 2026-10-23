import './helpers/subprocessRunnerSpawnEnvIsolate.js'
import { test, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SubprocessRunner, __setCcbSpawnForTests, __setCcbTranscriptRestoreSocketFactoryForTests } from '../subprocessRunner.js'

class FakeProc extends EventEmitter {
  pid = 4243
  killed = false
  stdout = Object.assign(new EventEmitter(), { setEncoding() { return this } })
  stderr = Object.assign(new EventEmitter(), { setEncoding() { return this } })
  stdin = Object.assign(new EventEmitter(), { write: (_line: string, cb?: () => void) => { cb?.(); return true }, end() {} })
  kill(): boolean { this.killed = true; return true }
  finish(): void { this.emit('exit', 0, null); this.stdout.emit('close'); this.stderr.emit('close'); this.emit('close', 0, null) }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { resolve, promise } }
function capability(name: string) {
  let closes = 0
  return { socketPath: `/synthetic/${name}.sock`, async close() { closes++ }, get closes() { return closes } }
}
let directory: string, saved: Record<string, string | undefined>
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'g607-generation-'))
  saved = Object.fromEntries(['OC_CONTAINER_ID', 'CLAUDE_CONFIG_DIR'].map(key => [key, process.env[key]]))
  process.env.OC_CONTAINER_ID = '607'; process.env.CLAUDE_CONFIG_DIR = join(directory, 'config')
  await mkdir(process.env.CLAUDE_CONFIG_DIR, { mode: 0o700 })
})
afterEach(async () => {
  __setCcbSpawnForTests(null); __setCcbTranscriptRestoreSocketFactoryForTests(null)
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value
  await rm(directory, { recursive: true, force: true })
})
function runner(): SubprocessRunner {
  const r = new SubprocessRunner({ sessionKey: 'agent:main:webchat:dm:g607-synthetic', peerId: 'g607-synthetic', agentId: 'main', agentBaseDir: directory,
    harness: 'ccb', resumeSessionId: '60700000-0000-4000-8000-000000000001',
    config: { auth: { mode: 'subscription', claudeCodePath: directory, claudeCodeRuntime: 'node' }, defaults: { permissionMode: 'default' }, terminal: { type: 'local' } },
  } as never)
  Reflect.set(r, 'buildLearningContext', async () => ({ workingDir: directory }))
  return r
}

test('a failed spawn releases its exact restore capability before start rejects', async () => {
  const cap = capability('failed')
  __setCcbTranscriptRestoreSocketFactoryForTests(async () => cap)
  __setCcbSpawnForTests(() => { throw Error('SYNTHETIC_SPAWN_FAILURE') })
  const r = runner()
  await assert.rejects(r.start(), /SYNTHETIC_SPAWN_FAILURE/)
  assert.equal(cap.closes, 1); assert.equal(r.isRunning, false)
  assert.equal(Reflect.get(r, 'transcriptRestoreSocket'), null)
  await r.shutdown()
})

test('a late old capability closes itself without spawning or replacing the new generation', async () => {
  const a = capability('old'), b = capability('new'), entered = deferred<void>(), release = deferred<typeof a>()
  let factories = 0
  __setCcbTranscriptRestoreSocketFactoryForTests(async () => { if (++factories === 1) { entered.resolve(); return release.promise } return b })
  const child = new FakeProc(), envs: Array<Record<string, string | undefined>> = []
  __setCcbSpawnForTests(opts => { envs.push({ ...opts.env }); return child as never })
  const r = runner(), first = r.start()
  await entered.promise
  await r.shutdown()
  await r.start()
  assert.equal(envs.length, 1); assert.equal(envs[0]!.OPENCLAUDE_TRANSCRIPT_RECOVERY_SOCKET, b.socketPath)
  release.resolve(a); await first
  assert.equal(a.closes, 1); assert.equal(b.closes, 0); assert.equal(r.isRunning, true)
  assert.equal(Reflect.get(r, 'transcriptRestoreSocket'), b)
  child.finish()
  assert.equal(b.closes, 1)
  assert.equal(r.isRunning, false); assert.equal(Reflect.get(r, 'transcriptRestoreSocket'), null)
  await r.shutdown()
})
