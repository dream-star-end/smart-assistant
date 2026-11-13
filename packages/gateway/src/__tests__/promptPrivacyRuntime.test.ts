import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { PromptPrivacyPolicy } from '@openclaude/protocol'
process.env.OPENCLAUDE_HOME = mkdtempSync(join(tmpdir(), 'oc-privacy-boundary-proof-'))
const { withFreshPromptPrivacy } = await import('../promptPrivacyRuntime.js')
const { promptPrivacyFingerprint } = await import('../promptPrivacyPolicy.js')
const on: PromptPrivacyPolicy = { schemaVersion: 1, profile: { nickname: 'fixture-only', sessionId: 'scope-a' } }
const off: PromptPrivacyPolicy = { schemaVersion: 1, profile: null }
async function withMaster(run: (set: (p: PromptPrivacyPolicy | null) => void, hits: () => number) => Promise<void>) {
  let policy: PromptPrivacyPolicy | null = off
  let count = 0
  const server = createServer((_req, res) => {
    count++
    if (!policy) { res.statusCode = 503; res.end(); return }
    res.end(JSON.stringify({ slots: [], promptPolicy: policy }))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const previousUrl = process.env.OPENCLAUDE_V3_MASTER_BASE_URL
  const previousToken = process.env.OPENCLAUDE_V3_CONTAINER_TOKEN
  process.env.OPENCLAUDE_V3_MASTER_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'synthetic-fixture-only'
  try { await run(p => { policy = p }, () => count) } finally {
    if (previousUrl === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_V3_MASTER_BASE_URL'); else process.env.OPENCLAUDE_V3_MASTER_BASE_URL = previousUrl
    if (previousToken === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_V3_CONTAINER_TOKEN'); else process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = previousToken
    await new Promise<void>(r => server.close(() => r()))
  }
}
function fixture() {
  return { promptPolicyFingerprint: promptPrivacyFingerprint(on, 'scope-a'), desired: undefined as PromptPrivacyPolicy | undefined,
    running: true, stops: 0, clears: 0,
    setPromptPrivacy(p: PromptPrivacyPolicy) { this.desired = structuredClone(p) },
    clearPromptPrivacy() { this.desired = undefined; this.clears++ },
    async shutdown() { this.stops++; this.running = false },
    assertPromptPrivacyStopped() { if (this.running) throw new Error('still running') },
  }
}
test('idle/preheat/native-compact boundary refreshes with IUI absent and holds the snapshot until completion', async () => {
  await withMaster(async (_set, hits) => {
    const runner = fixture()
    let release!: () => void
    const barrier = new Promise<void>(r => { release = r })
    let entered!: () => void
    const started = new Promise<void>(r => { entered = r })
    const task = withFreshPromptPrivacy(runner, 'scope-a', async () => { entered(); await barrier; return 'operation-done' })
    await started
    assert.equal(runner.stops, 1)
    assert.deepEqual(runner.desired, off)
    assert.equal(runner.clears, 0)
    release()
    assert.equal(await task, 'operation-done')
    assert.equal(runner.desired, undefined)
    assert.equal(runner.clears, 1)
    assert.equal(hits(), 1)
  })
})
test('a resolved shutdown with a live process never reaches an internal model operation', async () => {
  await withMaster(async () => {
    const runner = fixture()
    runner.shutdown = async () => { runner.stops++ }
    let effects = 0
    await assert.rejects(withFreshPromptPrivacy(runner, 'scope-a', async () => { effects++ }), /尚未生效/)
    assert.equal(effects, 0)
    assert.equal(runner.desired, undefined)
  })
})
test('each operation checks fresh consent; failure does not claim completion or keep a snapshot', async () => {
  await withMaster(async (set, hits) => {
    const runner = fixture()
    await withFreshPromptPrivacy(runner, 'scope-a', async () => {})
    set(null)
    let effects = 0
    await assert.rejects(withFreshPromptPrivacy(runner, 'scope-a', async () => { effects++ }), /尚未生效/)
    assert.equal(effects, 0)
    assert.equal(runner.desired, undefined)
    assert.equal(hits(), 2)
  })
})
