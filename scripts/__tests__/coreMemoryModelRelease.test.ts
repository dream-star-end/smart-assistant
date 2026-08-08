import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { CORE_MEMORY_MODEL_MANIFEST } from '../core-memory-model-manifest.mjs'

const root = join(import.meta.dirname, '..', '..')

test('Core memory local model manifest pins the complete q8 asset set', () => {
  assert.equal(CORE_MEMORY_MODEL_MANIFEST.repository, 'Xenova/multilingual-e5-small')
  assert.match(CORE_MEMORY_MODEL_MANIFEST.revision, /^[0-9a-f]{40}$/)
  assert.equal(CORE_MEMORY_MODEL_MANIFEST.dtype, 'q8')
  assert.deepEqual(
    CORE_MEMORY_MODEL_MANIFEST.files.map((file) => file.path).sort(),
    ['config.json', 'onnx/model_quantized.onnx', 'tokenizer.json', 'tokenizer_config.json'],
  )
  for (const file of CORE_MEMORY_MODEL_MANIFEST.files) {
    assert.ok(file.bytes > 0)
    assert.match(file.sha256, /^[0-9a-f]{64}$/)
  }
})

test('official deploy verifies real offline inference before publishing the master release', () => {
  const deploy = readFileSync(join(root, 'scripts/deploy-v5.sh'), 'utf8')
  const materializeAt = deploy.indexOf('node scripts/materialize-core-memory-model.mjs')
  const smokeAt = deploy.indexOf('npx --no-install tsx scripts/core-memory-local-ranker-smoke.ts')
  const versionAt = deploy.indexOf('if ! write_version "$staging"')
  const publishAt = deploy.indexOf('if ! publish_strong_release "$staging"')
  assert.ok(materializeAt > 0)
  assert.ok(smokeAt > materializeAt)
  assert.ok(versionAt > smokeAt)
  assert.ok(publishAt > versionAt)
  assert.match(deploy, /--reuse "\$current\/\.models\/core-memory\/multilingual-e5-small"/)
})

test('master handler loads only the fixed release-relative model path', () => {
  const ranker = readFileSync(
    join(root, 'packages/commercial/src/http/coreMemoryLocalRanker.ts'),
    'utf8',
  )
  assert.match(ranker, /new URL\('\.\.\/\.\.\/\.\.\/\.\.\/\.models\/core-memory\/multilingual-e5-small\/'/)
  assert.doesNotMatch(ranker, /process\.env/)
  assert.match(ranker, /allowRemoteModels = false/)
})
