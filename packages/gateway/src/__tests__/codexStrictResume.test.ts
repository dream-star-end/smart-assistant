/** Actual adapter -> queued kernel submit -> real child stdio JSON-RPC.
 * App-server is synthetic; process enrollment and SessionManager/source eligibility
 * remain separate work. No paid upstream, real user's rollout or global flags. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import { CodexAdapter } from '../engine/codexAdapter.js'
import { CodexAppServerRunner } from '../engine/codexAppServerRunner.js'
import { codexRolloutArtifact } from '../engine/resumeArtifacts.js'
import type { TurnParams, StrictNativeResume } from '../engine/engineAdapter.js'
import type { EngineCreateOpts } from '../engine/registry.js'

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'codex-strict-private-')), id = '8aef3dc0-cd8b-4fe5-9743-af842e17b605'
  const dir = join(home, 'sessions', '2026', '01', '01'); mkdirSync(dir, { recursive: true })
  const artifact = join(dir, `rollout-private-${id}.jsonl`), log = join(home, 'rpc.jsonl')
  writeFileSync(artifact, JSON.stringify({ privateNativeId: id }) + '\n')
  const kernel = new CodexAppServerRunner({ sessionKey: 'private-retry', agentId: 'child', cwd: home, resumeSessionId: id })
  const runner: any = kernel, messages: unknown[] = []
  kernel.on('message', message => messages.push(message)); kernel.on('error', () => {})
  const rpc = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/codexStrictResumeRpc.fixture.mjs', import.meta.url)), artifact, log],
    { env: { PATH: process.env.PATH, HOME: home, NODE_ENV: 'test' }, stdio: ['pipe', 'pipe', 'pipe'] })
  const closed = once(rpc, 'close'); let errors = ''
  rpc.stderr.on('data', b => { errors += b })
  const lines = createInterface({ input: rpc.stdout }); lines.on('line', line => runner.handleLine(line))
  runner.proc = rpc; runner.initialized = true
  let beforeAttach = () => {}
  // Only process enrollment is a seam: sendRequest/handleLine transport and
  // native attach/fallback/runTurn are original implementations.
  runner.ensureSpawned = async () => { beforeAttach() }
  const adapter = new CodexAdapter({ sessionKey: 'private-retry', agentId: 'child', resumeSessionId: id } as EngineCreateOpts, kernel)
  const strict: StrictNativeResume = { engine: 'codex', nativeSessionId: id }
  async function submit(policy?: StrictNativeResume) {
    const turn = adapter.submitTurn({ input: 'private retry', requireNativeResume: policy, onEvent: () => {},
      sessionTotals: { totalCostUSD: 0, turns: 0 }, toolUseIdToName: new Map() } as TurnParams)
    await turn.submitted; await turn.summary
  }
  const requests = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(s => JSON.parse(s) as { method: string; threadId?: string }) : []
  return { id, home, artifact, kernel, runner, adapter, strict, submit, requests, messages,
    beforeAttach(fn: () => void) { beforeAttach = fn },
    async close() { rpc.kill('SIGKILL'); await closed; lines.close(); assert.equal(errors, '') },
  }
}

test('strict actual attach after valid artifact is removed cannot fresh or start a model turn', { timeout: 12000 }, async () => {
  const f = fixture()
  try {
    const probe = codexRolloutArtifact(f.id, f.home); assert.ok(probe && probe !== 'unknown' && probe.exists)
    f.beforeAttach(() => { if (existsSync(f.artifact)) unlinkSync(f.artifact) })
    let fallback = 0; f.runner.opts.resolveResumeFallback = () => { fallback++; return 'another-private-thread' }
    await f.submit(f.strict)
    assert.deepEqual(f.requests().map(r => r.method), ['thread/resume'])
    assert.equal(fallback, 0); assert.equal(f.runner.threadId, f.id)
    assert.match(JSON.stringify(f.messages), /STRICT_NATIVE_RESUME_UNAVAILABLE/)
  } finally { await f.close() }
})

test('reused attached runner consumes per-turn strict constraint; following ordinary turn still self-heals', { timeout: 12000 }, async () => {
  const f = fixture()
  try {
    await f.submit(); assert.equal(f.runner.attached, true)
    const before = f.requests().length; unlinkSync(f.artifact)
    await f.submit(f.strict)
    assert.deepEqual(f.requests().slice(before).map(r => r.method), ['thread/resume'])
    assert.match(JSON.stringify(f.messages), /STRICT_NATIVE_RESUME_UNAVAILABLE/)
    // A strict attach failure must revoke stale attached=true before ordinary
    // reuse; otherwise the next call could incorrectly skip native attachment.
    await f.submit()
    const after = f.requests().slice(before + 1).map(r => r.method)
    assert.ok(after.includes('thread/start')); assert.ok(after.includes('turn/start'))
  } finally { await f.close() }
})

test('strict mismatched native identity does not send an RPC; queue captures immutable constraint', { timeout: 12000 }, async () => {
  const f = fixture()
  try {
    await f.submit({ engine: 'codex', nativeSessionId: 'wrong-private-native' })
    assert.deepEqual(f.requests(), []); assert.match(JSON.stringify(f.messages), /STRICT_NATIVE_RESUME_IDENTITY_MISMATCH/)
    const policy = { engine: 'codex' as const, nativeSessionId: f.id }
    const turn = f.submit(policy); policy.nativeSessionId = 'changed-after-submit'
    await turn
    assert.equal(f.requests().find(r => r.method === 'thread/resume')?.threadId, f.id)
    assert.equal(f.requests().filter(r => r.method === 'turn/start').length, 1)
  } finally { await f.close() }
})
