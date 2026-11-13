import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULT_PROMPT_PRIVACY, effectivePromptPrivacy, parsePromptPrivacyPolicy } from '@openclaude/protocol'
process.env.OPENCLAUDE_HOME = mkdtempSync(join(tmpdir(), 'oc-prompt-privacy-proof-'))
const { promptPrivacyFingerprint, buildPromptContext } = await import('../promptSlots.js')
const { getDesiredPromptPrivacy } = await import('../promptPrivacyDesired.js')
test('normalized privacy hashes ignore unrelated settings and scope does not expand', () => {
  const on = { schemaVersion: 1 as const, profile: { nickname: '小林', sessionId: 'scope-a' } }
  const off = promptPrivacyFingerprint(DEFAULT_PROMPT_PRIVACY, 'scope-a')
  assert.notEqual(promptPrivacyFingerprint(on, 'scope-a'), off)
  assert.equal(promptPrivacyFingerprint(on, 'scope-b'), off)
  assert.equal(promptPrivacyFingerprint({ schemaVersion: 2, profile: on.profile }, 'scope-a'), off)
  assert.equal(parsePromptPrivacyPolicy({ ...on, updated_at: 'ignore' }), null)
  assert.deepEqual(effectivePromptPrivacy(on, undefined), DEFAULT_PROMPT_PRIVACY)
})
test('new turns fetch consent fresh with IUI absent; frozen spawn snapshot is reused', async () => {
  let hits = 0
  let policy = { schemaVersion: 1 as const, profile: { nickname: '小林', sessionId: 'scope-a' } as { nickname: string; sessionId: string } | null }
  const server = createServer((req, res) => {
    hits++
    assert.equal(new URL(req.url!, 'http://fixture').searchParams.get('sessionId'), 'scope-a')
    res.end(JSON.stringify({ slots: [], promptPolicy: policy }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const env = { OPENCLAUDE_V3_MASTER_BASE_URL: `http://127.0.0.1:${port}`, OPENCLAUDE_V3_CONTAINER_TOKEN: 'synthetic-fixture-only' }
  try {
    const first = await getDesiredPromptPrivacy('scope-a', { env })
    policy = { schemaVersion: 1, profile: null }
    const second = await getDesiredPromptPrivacy('scope-a', { env })
    assert.equal(hits, 2)
    assert.notEqual(promptPrivacyFingerprint(first, 'scope-a'), promptPrivacyFingerprint(second, 'scope-a'))
    const r = await buildPromptContext({ agentId: 'privacy-fixture', sessionId: 'scope-a', sessionKey: 'agent:main:webchat:dm:scope-a', promptPolicy: second })
    assert.equal(r.applied.some(s => s.name === 'USER'), false)
    assert.equal(r.promptPolicyFingerprint, promptPrivacyFingerprint(second, 'scope-a'))
  } finally { await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())) }
})
test('unverifiable policy cannot silently keep a warm personal-data prompt', async () => {
  await assert.rejects(getDesiredPromptPrivacy('scope-a', { env: { OPENCLAUDE_V3_MASTER_BASE_URL: 'http://127.0.0.1:1', OPENCLAUDE_V3_CONTAINER_TOKEN: 'synthetic-fixture-only' }, timeoutMs: 50 }), /无法核验/)
})
