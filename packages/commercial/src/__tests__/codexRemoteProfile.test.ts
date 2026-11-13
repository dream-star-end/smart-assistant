import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { modelReasoningPolicy } from '@openclaude/protocol'
import { projectCodexRemoteCapabilities } from '../account-pool/codexRemoteProfile.js'
import { parseCapabilityProfile } from '../billing/modelCatalog.js'

// Actual node model/list records from the OCV5-746 rollout, not platform seed models.
const models = JSON.parse(readFileSync(new URL('./fixtures/codex-remote-model-list.json', import.meta.url), 'utf8'))
function profile(model: Record<string, any>) {
  return { probe_snapshot: { execution_snapshot: {
    version: 1, modelList: [model], modelCatalog: { models: [{ slug: model.model }] },
    cliSha256: 'a'.repeat(64), nativeSha256: 'b'.repeat(64), controllerSha256: 'c'.repeat(64),
  } } }
}
function project(supported: string[], def: string | null = 'low') {
  const model = { ...models[0], supportedReasoningEfforts: supported.map(reasoningEffort => ({ reasoningEffort })),
    defaultReasoningEffort: def }
  return projectCodexRemoteCapabilities(profile(model), model.model)
}

for (const model of models) test(`native ${model.model} projects only platform efforts and preserves its observed default`, () => {
  const input = profile(model), before = structuredClone(input)
  const projected = parseCapabilityProfile(`${model.model}-remote`, projectCodexRemoteCapabilities(input, model.model))
  assert.deepEqual(projected.reasoning.supported, modelReasoningPolicy(model.model).supported)
  assert.equal(projected.reasoning.codexModelDefault, model.defaultReasoningEffort)
  assert.equal(projected.supportsVision, false)
  assert.equal(projected.remote?.supports_fast, false)
  assert.equal(projected.remote?.observed_vision, true)
  assert.deepEqual(input, before, 'projection must not rewrite the native execution snapshot')
})

test('ultra filtering also applies if Luna starts advertising it', () => {
  const model = structuredClone(models.find((m: any) => m.model === 'gpt-6-luna'))
  model.supportedReasoningEfforts.push({ reasoningEffort: 'ultra', description: 'Automatic task delegation' })
  assert.deepEqual(projectCodexRemoteCapabilities(profile(model), model.model).reasoning,
    { supported: ['low', 'medium', 'high', 'xhigh', 'max'], codex_model_default: 'medium' })
})

test('only ultra is removed: observed subsets are neither expanded nor reordered', () => {
  assert.deepEqual(project(['max', 'ultra', 'low'], 'max').reasoning,
    { supported: ['max', 'low'], codex_model_default: 'max' })
  assert.deepEqual(project(['low']).reasoning, { supported: ['low'], codex_model_default: 'low' })
  assert.deepEqual(project([], null).reasoning, { supported: [], codex_model_default: null })
})

for (const supported of [['low', 'future'], ['low', 'ultra', 'future'], ['low', 'low'], ['low', 'ultra', 'ultra']]) {
  test(`unknown or duplicate native efforts remain rejected: ${supported}`, () => {
    assert.throws(() => project(supported), /CODEX_REASONING_PROFILE_INVALID/)
  })
}
for (const def of ['ultra', 'high', 'future']) test(`unusable observed default remains rejected: ${def}`, () => {
  assert.throws(() => project(['low', 'ultra'], def), /CODEX_REASONING_PROFILE_INVALID/)
})
test('ultra-only models cannot publish an ultra default', () => {
  assert.throws(() => project(['ultra'], 'ultra'), /CODEX_REASONING_PROFILE_INVALID/)
})
