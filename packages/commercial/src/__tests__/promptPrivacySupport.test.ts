import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { makePromptPrivacySupportResolver, readRuntimeReleaseCapabilities, type PrivacyRuntimeStatus } from '../user/promptPrivacySupport.js'
import { handlePatchMyPreferences, type CommercialHttpDeps } from '../http/handlers.js'
import { signAccess } from '../auth/jwt.js'
const key = 'com.openclaude.runtime.release'
const release = 'rel-aaaaaaaaaaaa'
const imageId = `sha256:${'b'.repeat(64)}`
function resolver(status: () => PrivacyRuntimeStatus | null) {
  return makePromptPrivacySupportResolver({ inspect: async () => status(), validatedReleasePath: `/trusted/${release}`, readCapabilities: () => new Set(['prompt-privacy-v1']) })
}
test('a matching actual release and a declared source capability are both required', async () => {
  let actual = { state: 'running', imageId, labels: { [key]: release } }
  const read = resolver(() => actual)
  assert.equal((await read('765')).state, 'ready')
  actual = { ...actual, labels: { [key]: 'rel-cccccccccccc' } }
  assert.equal((await read('765')).state, 'upgrade_required', 'same immutable image does not imply same mounted source release')
  actual = { ...actual, labels: { [key]: '../../escape' } }
  assert.equal((await read('765')).state, 'unknown')
})
test('stopped, missing, invalid manifest and inspect failure never imply privacy is effective', async () => {
  assert.equal((await resolver(() => null)('765')).state, 'unknown')
  assert.equal((await resolver(() => ({ state: 'stopped', labels: { [key]: release } }))('765')).state, 'unknown')
  const invalid = makePromptPrivacySupportResolver({ inspect: async () => ({ state: 'running', labels: { [key]: release } }), validatedReleasePath: `/trusted/${release}`, readCapabilities: () => null })
  assert.equal((await invalid('765')).state, 'unknown')
  const failed = makePromptPrivacySupportResolver({ inspect: async () => { throw new Error('synthetic inspect unavailable') } })
  assert.equal((await failed('765')).state, 'unknown')
})
test('only an actual embedded source image can use image-declared privacy features', async () => {
  let actual = { state: 'running', imageId, labels: { 'oc.runtime.embed_source': '1', 'oc.runtime.features': 'v3-sink prompt-privacy-v1' } }
  const read = resolver(() => actual)
  assert.equal((await read('765')).state, 'ready')
  actual = { ...actual, labels: { ...actual.labels, 'oc.runtime.embed_source': '0' } }
  assert.equal((await read('765')).state, 'unknown')
})
test('release metadata capabilities are bounded and malformed declarations stay unknown', () => {
  const root = mkdtempSync(join(tmpdir(), 'oc-privacy-capabilities-'))
  const file = join(root, 'MANIFEST.json')
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, capabilities: ['prompt-privacy-v1'] }))
  assert.equal(readRuntimeReleaseCapabilities(root)?.has('prompt-privacy-v1'), true)
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, capabilities: ['prompt-privacy-v1', {}] }))
  assert.equal(readRuntimeReleaseCapabilities(root), null)
})
test('a stale or unknown runtime cannot accept a new profile grant through a direct API call', async () => {
  const secret = 'synthetic-runtime-support-test-secret-only'
  const access = await signAccess({ sub: '765', role: 'user' }, secret)
  const req = new IncomingMessage(new Socket())
  req.method = 'PATCH'; req.headers.authorization = `Bearer ${access.token}`; req.headers['content-type'] = 'application/json'
  req.push(JSON.stringify({ system_assistant_profile: { enabled: true, nickname: 'fixture', sessionId: 'scope-a' } })); req.push(null)
  const res = new ServerResponse(req)
  await assert.rejects(handlePatchMyPreferences(req, res, {} as never, { jwtSecret: secret, resolvePromptPrivacySupport: async () => ({ version: 1, state: 'upgrade_required' }) } as unknown as CommercialHttpDeps), e => e instanceof Error && e.message.includes('更新运行环境'))
})
