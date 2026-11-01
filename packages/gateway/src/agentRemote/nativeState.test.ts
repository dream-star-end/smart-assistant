import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import {
  type NativeCheckpointIdentity,
  checkpointMatchesIdentity,
  nativeSessionPathAllowed,
} from '@openclaude/protocol/agentRemoteState'
import { NativeStateRepository, assertNativeWriterLock } from './nativeState.js'

const childPath = fileURLToPath(new URL('./fixtures/stateChild.ts', import.meta.url))
const nativeSessionId = '00000000-0000-4000-8000-000000000001'
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'agentremote-native-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const options = { nativeRoot: join(root, 'native'), stateRoot: join(root, 'state') }
  const repo = new NativeStateRepository(options)
  const identity: NativeCheckpointIdentity = {
    principalId: 'u1',
    sessionId: 's1',
    nativeSessionId,
    engine: 'ccb',
    engineVersion: '2.8.4',
    cwd: '/workspace',
    environmentId: 'e1',
    environmentGeneration: 1,
  }
  const transcriptRelativePath = `projects/-workspace/${nativeSessionId}.jsonl`
  const transcript = join(options.nativeRoot, transcriptRelativePath)
  mkdirSync(dirname(transcript), { recursive: true, mode: 0o700 })
  writeFileSync(
    transcript,
    `${JSON.stringify({ type: 'user', uuid: 'head1', sessionId: nativeSessionId, message: { role: 'user', content: 'synthetic' } })}\n`,
    { mode: 0o600 },
  )
  const request = {
    identity,
    bindingRevision: 1,
    authority: { dispatchId: 'd1', turnKey: 'turn1', tapeCursor: 1, nativeHeadUuid: 'head1' },
    transcriptRelativePath,
    createdAtMs: 1000,
  }
  const pointer = join(root, 'pointer.json')
  return { root, options, repo, identity, transcript, request, pointer }
}
function start(f: ReturnType<typeof fixture>, mode: string, extra: Record<string, unknown> = {}) {
  const config = {
    options: f.options,
    identity: f.identity,
    request: f.request,
    transcript: f.transcript,
    pointer: f.pointer,
    ...extra,
  }
  const path = join(f.root, `config-${mode}-${Math.random().toString(16).slice(2)}.json`)
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 })
  const args = ['--import', 'tsx', childPath, mode, path]
  const command =
    mode === 'manager'
      ? { executable: process.execPath, args }
      : mode === 'writer'
        ? f.repo.writerCommand(config.identity, process.execPath, args)
        : f.repo.stateTaskCommand(config.identity, process.execPath, args)
  const child = spawn(command.executable, command.args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', (b) => {
    out += b
  })
  child.stderr.on('data', (b) => {
    err += b
  })
  const done = once(child, 'close').then(([code, signal]) => ({ code, signal, out, err }))
  return { child, done, diagnostics: () => err }
}
async function waitFor(path: string, diagnostics: () => string) {
  // Cold Node/tsx startup is not the lock assertion or a product latency budget.
  // Keep a bounded startup allowance and retain child errors for diagnosis.
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (existsSync(path)) return
    await delay(50)
  }
  throw new Error(`fixture-ready-timeout:${path}: ${diagnostics()}`)
}

async function checkpoint(f: ReturnType<typeof fixture>) {
  const result = await start(f, 'checkpoint').done
  assert.equal(result.code, 0, result.err)
  return JSON.parse(readFileSync(f.pointer, 'utf8'))
}

test('actual Writer owns flock; parent SIGKILL cannot permit another writer or checkpoint, including aliases', async (t) => {
  const f = fixture(t)
  assert.throws(
    () => assertNativeWriterLock(f.repo.prepareLock(f.identity)),
    /native-lock-not-held/,
  )
  const ready = join(f.root, 'writer-ready')
  const manager = start(f, 'manager', { ready })
  t.after(() => manager.child.kill('SIGKILL'))
  await waitFor(ready, manager.diagnostics)
  const writerPid = Number(readFileSync(ready, 'utf8'))
  let writerNeedsCleanup = true
  t.after(() => {
    try {
      if (writerNeedsCleanup) process.kill(writerPid, 'SIGKILL')
    } catch {}
  })
  const managerExit = once(manager.child, 'exit')
  manager.child.kill('SIGKILL')
  await managerExit
  process.kill(writerPid, 0)
  const alias = { ...f.identity, principalId: 'u2', sessionId: 'alias' }
  assert.equal(f.repo.lockPath(alias), f.repo.lockPath(f.identity))
  assert.equal(f.repo.markerPath(alias), f.repo.markerPath(f.identity))
  const contender = await start(f, 'checkpoint', {
    identity: alias,
    request: { ...f.request, identity: alias },
  }).done
  assert.equal(contender.code, 1)
  assert.equal(existsSync(f.pointer), false)
  process.kill(writerPid, 'SIGKILL')
  writerNeedsCleanup = false
  // Killing a real process is asynchronous; wait for the kernel lock, not a TTL.
  let acquired = false
  const lockDeadline = Date.now() + 15000
  while (Date.now() < lockDeadline) {
    const attempt = await start(f, 'checkpoint').done
    if (attempt.code === 0) {
      acquired = true
      break
    }
    await delay(20)
  }
  assert.equal(acquired, true)
})

test('quiescent checkpoint restores the same native ID into fresh directories; corruption and identity mismatch reject', async (t) => {
  const f = fixture(t)
  const original = readFileSync(f.transcript)
  const manifest = await checkpoint(f)
  assert.equal(manifest.nativeSessionId, nativeSessionId)
  checkpointMatchesIdentity(manifest, f.identity)
  assert.throws(
    () => checkpointMatchesIdentity(manifest, {} as NativeCheckpointIdentity),
    /bad-shape/,
  )
  assert.throws(
    () => f.repo.read(manifest.checkpointId, { ...f.identity, principalId: 'u2' }),
    /checkpoint-identity/,
  )
  rmSync(join(f.options.nativeRoot, 'projects'), { recursive: true })
  const restored = await start(f, 'restore', { checkpointId: manifest.checkpointId }).done
  assert.equal(restored.code, 0, restored.err)
  assert.deepEqual(readFileSync(f.transcript), original)
  assert.equal(existsSync(f.repo.markerPath(f.identity)), false)
  const objectFile = join(
    f.options.stateRoot,
    'objects',
    manifest.checkpointId,
    f.request.transcriptRelativePath,
  )
  // Fault injection into our synthetic sealed object must also work as non-root.
  chmodSync(objectFile, 0o600)
  writeFileSync(objectFile, 'corrupt')
  assert.throws(() => f.repo.read(manifest.checkpointId, f.identity), /checkpoint-file-corrupt/)
})

test('wrong committed native head, concurrent append and SIGKILL before publish cannot create a pointer', async (t) => {
  for (const fault of ['wrong-head', 'append', 'kill-before-publish']) {
    const f = fixture(t)
    const request =
      fault === 'wrong-head'
        ? { ...f.request, authority: { ...f.request.authority, nativeHeadUuid: 'wrong' } }
        : f.request
    const result = await start(f, 'checkpoint', { fault, request }).done
    assert.notEqual(result.code, 0)
    assert.equal(existsSync(f.pointer), false)
    if (fault === 'append') assert.match(result.err, /native-source-changed/)
    if (fault === 'wrong-head') assert.match(result.err, /native-boundary-mismatch/)
    if (fault === 'kill-before-publish') assert.equal(result.signal, 'SIGKILL')
  }
})

test('interrupted restore blocks all aliases until the identical checkpoint commits; conflicting local state never overwritten', async (t) => {
  const f = fixture(t)
  const manifest = await checkpoint(f)
  rmSync(join(f.options.nativeRoot, 'projects'), { recursive: true })
  const failed = await start(f, 'restore', { checkpointId: manifest.checkpointId, fault: 'commit' })
    .done
  assert.match(failed.err, /injected-before-commit/)
  assert.equal(existsSync(f.repo.markerPath(f.identity)), true)
  const alias = { ...f.identity, sessionId: 'alias' }
  const blocked = await start(f, 'writer', { identity: alias }).done
  assert.equal(blocked.code, 73)
  const resumed = await start(f, 'restore', { checkpointId: manifest.checkpointId }).done
  assert.equal(resumed.code, 0, resumed.err)
  assert.equal(existsSync(f.repo.markerPath(f.identity)), false)
  writeFileSync(f.transcript, 'newer-local-data\n')
  const conflict = await start(f, 'restore', { checkpointId: manifest.checkpointId }).done
  assert.match(conflict.err, /native-state-conflict/)
  assert.equal(readFileSync(f.transcript, 'utf8'), 'newer-local-data\n')
})

test('native path whitelist and dangling symlinks reject credential/config/temporary files and traversal', async (t) => {
  const f = fixture(t)
  for (const name of [
    `projects/-workspace/${nativeSessionId}/auth.json`,
    `projects/-workspace/${nativeSessionId}/secrets.env`,
    `projects/-workspace/${nativeSessionId}/subagents/agent-a.jsonl.agent-remote-leftover`,
    `projects/-workspace/../${nativeSessionId}.jsonl`,
    '.credentials.json',
    `projects/-workspace/${nativeSessionId}/settings.json`,
  ]) {
    assert.equal(nativeSessionPathAllowed(name, nativeSessionId), false, name)
  }
  rmSync(f.transcript)
  symlinkSync(join(f.root, 'missing'), f.transcript)
  const rejected = await start(f, 'checkpoint').done
  assert.match(rejected.err, /native-path-symlink/)
  assert.equal(existsSync(f.pointer), false)
})

test('verified subagent/tool-result layouts are sealed; extra local native files and credential lookalikes reject', async (t) => {
  const f = fixture(t)
  const prefix = `projects/-workspace/${nativeSessionId}`
  const contents = new Map([
    [`${prefix}/subagents/agent-a0123456789abcdef.jsonl`, '{"type":"assistant"}\n'],
    [`${prefix}/subagents/agent-a0123456789abcdef.meta.json`, '{"agentType":"synthetic"}\n'],
    [`${prefix}/tool-results/toolu_fixture.txt`, 'synthetic 中文\n'],
    [
      `${prefix}/tool-results/toolu_g4_${'a'.repeat(64)}.json`,
      '[{"type":"text","text":"synthetic"}]\n',
    ],
  ])
  for (const [name, content] of contents) {
    const path = join(f.options.nativeRoot, name)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, content)
  }
  const manifest = await checkpoint(f)
  assert.equal(manifest.files.length, 5)
  rmSync(join(f.options.nativeRoot, 'projects'), { recursive: true })
  const restored = await start(f, 'restore', { checkpointId: manifest.checkpointId }).done
  assert.equal(restored.code, 0, restored.err)
  for (const [name, content] of contents)
    assert.equal(readFileSync(join(f.options.nativeRoot, name), 'utf8'), content)
  writeFileSync(join(f.options.nativeRoot, prefix, 'tool-results/toolu_extra.txt'), 'unexpected')
  const mixed = await start(f, 'restore', { checkpointId: manifest.checkpointId }).done
  assert.match(mixed.err, /native-state-extra-files/)
  assert.equal(existsSync(f.repo.markerPath(f.identity)), true)
  const g = fixture(t)
  const credential = join(g.options.nativeRoot, prefix, 'auth.json')
  mkdirSync(dirname(credential), { recursive: true, mode: 0o700 })
  writeFileSync(credential, 'synthetic-fixture-only')
  const rejected = await start(g, 'checkpoint').done
  assert.match(rejected.err, /checkpoint-path/)
  assert.equal(existsSync(g.pointer), false)
})

for (const delta of [-1, 0, 1])
  test(`checkpoint final JSONL line limit delta=${delta} includes LF across the read boundary`, async (t) => {
    const f = fixture(t)
    const limit = 64 * 1024 * 1024
    const empty = {
      type: 'user',
      uuid: 'head1',
      sessionId: nativeSessionId,
      message: { role: 'user', content: '' },
    }
    const envelope = Buffer.byteLength(JSON.stringify(empty))
    const row = {
      ...empty,
      message: { role: 'user', content: 'x'.repeat(limit + delta - envelope) },
    }
    writeFileSync(f.transcript, `${JSON.stringify(row)}\n`, { mode: 0o600 })
    const result = await start(f, 'checkpoint').done
    if (delta <= 0) {
      assert.equal(result.code, 0, result.err)
      assert.ok(existsSync(f.pointer))
    } else {
      assert.notEqual(result.code, 0)
      assert.match(result.err, /native-line-bound/)
      assert.equal(existsSync(f.pointer), false)
    }
  })
test('checkpoint rejects a later line BOM before publishing the native boundary', async (t) => {
  const f = fixture(t)
  const row = {
    type: 'user',
    uuid: 'head1',
    sessionId: nativeSessionId,
    message: { role: 'user', content: 'synthetic' },
  }
  writeFileSync(f.transcript, `${JSON.stringify(row)}\n\uFEFF${JSON.stringify(row)}\n`, {
    mode: 0o600,
  })
  const result = await start(f, 'checkpoint').done
  assert.notEqual(result.code, 0)
  assert.equal(existsSync(f.pointer), false)
})
