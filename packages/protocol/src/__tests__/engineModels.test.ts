import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  CODEX_ENGINE_MODEL_IDS,
  DEFAULT_CODEX_ENGINE_MODEL,
  PLATFORM_REASONING_EFFORTS,
  isCodexEngineModel,
  modelReasoningPolicy,
} from '../engineModels.js'

describe('GPT-5.6 engine model authority', () => {
  test('exactly the three GPT-5.6 series are Codex models; GPT-5.5 is retired', () => {
    assert.deepEqual(CODEX_ENGINE_MODEL_IDS, [
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ])
    assert.equal(DEFAULT_CODEX_ENGINE_MODEL, 'gpt-5.6-sol')
    for (const id of CODEX_ENGINE_MODEL_IDS) assert.equal(isCodexEngineModel(id), true)
    assert.equal(isCodexEngineModel('gpt-5.5'), false)
    assert.equal(isCodexEngineModel('gpt-5.6-ultra'), false)
  })

  test('platform effort excludes ultra and preserves per-model defaults', () => {
    assert.deepEqual(PLATFORM_REASONING_EFFORTS, [
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    assert.equal(modelReasoningPolicy('gpt-5.6-sol').codexModelDefault, 'low')
    assert.equal(modelReasoningPolicy('gpt-5.6-terra').codexModelDefault, 'medium')
    assert.equal(modelReasoningPolicy('gpt-5.6-luna').codexModelDefault, 'medium')
    assert.equal(modelReasoningPolicy('gpt-5.6-sol').supported.includes('ultra' as never), false)
  })

  test('static-provider effort policy is projected from the same registry', () => {
    assert.deepEqual(modelReasoningPolicy('glm-5.2').supported, ['high', 'max'])
    assert.deepEqual(modelReasoningPolicy('MiniMax-M3').supported, [])
    assert.deepEqual(modelReasoningPolicy('deepseek-v4-pro').supported, PLATFORM_REASONING_EFFORTS)
  })
})
