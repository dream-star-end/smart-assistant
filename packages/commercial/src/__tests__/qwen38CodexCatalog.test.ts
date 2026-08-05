import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const CATALOG = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../agent-sandbox/platform-runtime/etc-codex/model-catalog.local.json',
)

test('qwen3.8-max Codex catalog matches the signed execution capability', () => {
  const parsed = JSON.parse(readFileSync(CATALOG, 'utf8')) as {
    models: Array<Record<string, unknown>>
  }
  assert.equal(parsed.models.length, 1)
  const model = parsed.models[0]
  assert.equal(model.slug, 'qwen3.8-max')
  assert.equal(model.default_reasoning_level, 'xhigh')
  assert.deepEqual(
    (model.supported_reasoning_levels as Array<{ effort: string }>).map(({ effort }) => effort),
    ['low', 'medium', 'xhigh'],
  )
  assert.equal(model.context_window, 983_616)
  assert.equal(model.effective_context_window_percent, 95)
  assert.equal(model.supports_parallel_tool_calls, false)
  assert.equal(model.supports_image_detail_original, true)
  assert.deepEqual(model.input_modalities, ['text', 'image'])
})
