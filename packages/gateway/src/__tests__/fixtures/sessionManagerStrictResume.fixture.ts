import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { SessionManager } from '../../sessionManager.js'
import { probeStrictNativeResume, probeResumeArtifact } from '../../engine/resumeArtifacts.js'
import type { OpenClaudeConfig, AgentDef } from '@openclaude/storage'

async function main() {
const mode = process.argv[2]!, home = process.env.OPENCLAUDE_HOME!, codexHome = process.env.CODEX_HOME!
assert.ok(home.includes('sm-strict-private-')); assert.equal(process.env.HOME, home)
const id = '8aef3dc0-cd8b-4fe5-9743-af842e17b605', key = 'agent:child:delegate:parent:private-retry'
const config = { version: 1, gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
  auth: { mode: 'subscription', claudeCodePath: '' }, sessions: { dbPath: join(home, 'sessions.db') },
  defaults: { model: 'gpt-6-astra' } } as unknown as OpenClaudeConfig
const sm = new SessionManager(config), ins: any = sm
const artifactDir = join(codexHome, 'sessions', '2026', '01', '01')
mkdirSync(artifactDir, { recursive: true })
const artifact = join(artifactDir, `rollout-private-${id}.jsonl`), rpcLog = join(home, 'rpc.jsonl')
writeFileSync(artifact, '{"private":true}\n')
ins._resumeMap.set(key, id); ins._resumeMapProvider.set(key, 'codex')
const required = { engine: 'codex' as const, nativeSessionId: id }
const opts = { sessionKey: key, agent: { id: 'child', model: 'gpt-6-astra', provider: 'codex-native', cwd: home } as AgentDef,
  model: 'gpt-6-astra', channel: 'delegate', peerId: 'private-retry', userId: 'private-user',
  hermeticNoTools: true, requireNativeResume: required }
let rpc: ReturnType<typeof spawn> | undefined, closed: Promise<unknown> | undefined
try {
  if (mode === 'unknown') {
    // An unprobeable identity preserves the ordinary fallback contract but
    // cannot authorize a strict retry; do not mutate its durable mapping.
    ins._resumeMap.set(key, 'unprobeable')
    assert.equal(probeResumeArtifact('codex', 'unprobeable').exists, true)
    assert.equal(probeStrictNativeResume('codex', 'unprobeable'), 'unknown')
    assert.equal(sm.resolveStrictNativeResume(key), undefined)
    await assert.rejects(sm.getOrCreate(opts), /STRICT_NATIVE_RESUME/)
    await assert.rejects(sm.getOrCreate({ ...opts, requireNativeResume: { engine: 'codex' } as any }), /STRICT_NATIVE_RESUME/)
    assert.equal(ins._resumeMap.get(key), 'unprobeable'); assert.equal(sm.getByKey(key), undefined)
    ins._resumeMap.set(key, id)
    const obstructed = join(codexHome, 'sessions', '000-not-a-directory')
    writeFileSync(obstructed, 'private filesystem read fault')
    assert.equal(probeStrictNativeResume('codex', id), 'unknown')
    assert.equal(sm.resolveStrictNativeResume(key), undefined)
    await assert.rejects(sm.getOrCreate(opts), /STRICT_NATIVE_RESUME/)
    unlinkSync(obstructed); unlinkSync(artifact)
    assert.equal(probeStrictNativeResume('codex', id), 'absent')
    await assert.rejects(sm.getOrCreate(opts), /STRICT_NATIVE_RESUME/)
    assert.equal(ins._resumeMap.get(key), id)
  } else if (mode === 'unsupported') {
    ins._resumeMapProvider.set(key, 'ccb')
    assert.equal(sm.resolveStrictNativeResume(key), undefined)
    await assert.rejects(sm.getOrCreate(opts), /STRICT_NATIVE_RESUME/)
    assert.equal(sm.getByKey(key), undefined)
  } else {
    assert.deepEqual(sm.resolveStrictNativeResume(key), required)
    const session = await sm.getOrCreate(opts)
    assert.equal(session.runner.engineId, 'codex')
    assert.equal(session.runner.nativeSessionId, id)
    assert.equal((session as any)._identityCreationOpts.requireNativeResume, undefined)
    const kernel: any = (session.runner as any).kernel
    rpc = spawn(process.execPath, [fileURLToPath(new URL('./codexStrictResumeRpc.fixture.mjs', import.meta.url)), artifact, rpcLog, mode],
      { env: { PATH: process.env.PATH, HOME: home, NODE_ENV: 'test' }, stdio: ['pipe', 'pipe', 'pipe'] })
    closed = once(rpc, 'close')
    rpc.stderr!.on('data', b => process.stderr.write(b))
    const lines = createInterface({ input: rpc.stdout! }); lines.on('line', line => kernel.handleLine(line))
    kernel.proc = rpc; kernel.initialized = true
    kernel.ensureSpawned = async () => {
      if (mode === 'missing-late' && existsSync(artifact)) unlinkSync(artifact)
    }
    const beforeActivityListeners = session.runner.listenerCount('activity')
    if (mode === 'before-submit-delete') {
      const run = ins.runOneTurnWithRetry.bind(sm)
      ins.runOneTurnWithRetry = async (...args: unknown[]) => { unlinkSync(artifact); return run(...args) }
    }
    const events: unknown[] = []
    let release = () => {}
    if (mode === 'locked-change') session.lock = new Promise<void>(r => { release = r })
    const submitted = sm.submit(session, 'Continue the original task.', e => events.push(e),
      undefined, undefined, undefined, undefined, undefined, { requireNativeResume: required })
    if (mode === 'locked-change') {
      for (let n = 0; n < 500 && !(session as any)._activeTurnCount; n++) await new Promise(r => setTimeout(r, 2))
      assert.equal((session as any)._activeTurnCount, 1)
      session.runner.setResumeSessionId?.('another-native-identity')
      release()
    }
    let failure: unknown
    try { await submitted } catch (e) { failure = e }
    const requests = existsSync(rpcLog) ? readFileSync(rpcLog, 'utf8').trim().split('\n').map(s => JSON.parse(s)) : []
    assert.equal(requests.filter(r => r.method === 'thread/start').length, 0)
    if (mode === 'locked-change' || mode === 'before-submit-delete') {
      assert.equal(session.runner.listenerCount('activity'), beforeActivityListeners)
      assert.match(String(failure), /STRICT_NATIVE_RESUME/); assert.equal(requests.length, 0)
    } else if (mode === 'missing-late') {
      assert.equal(requests.filter(r => r.method === 'turn/start').length, 0)
      assert.match(JSON.stringify(events) + String(failure), /STRICT_NATIVE_RESUME_UNAVAILABLE/)
      assert.equal(session.runner.nativeSessionId, id)
    } else {
      if (mode === 'success') {
        assert.equal(failure, undefined)
        assert.match(JSON.stringify(events), /PRIVATE_NATIVE_CONTINUATION_RESULT/)
      }
      assert.equal(requests.filter(r => r.method === 'turn/start').length, 1)
      assert.equal(session.runner.nativeSessionId, id)
      if (mode === 'context') assert.match(JSON.stringify(events), /context window exceeded/)
    }
    assert.equal((session as any)._activeTurnCount, 0)
    assert.equal((session as any)._currentTurnKey, undefined)
    await session.lock
    lines.close()
    process.stdout.write(JSON.stringify({ mode, methods: requests.map(r => r.method), failure: String(failure) }) + '\n')
  }
  process.stdout.write(`SM_STRICT_PASS ${mode}\n`)
} finally {
  if (rpc) { rpc.kill('SIGKILL'); await closed }
  await sm.awaitResumeMapFlush()
}

}
main().catch(error => { process.stderr.write(String(error?.stack ?? error) + '\n'); process.exitCode = 1 })
