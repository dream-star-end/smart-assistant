import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  CODEX_ENGINE_MODEL_IDS,
  CURSOR_ENGINE_MODELS,
  CURSOR_ENGINE_MODEL_IDS,
  DEFAULT_CODEX_ENGINE_MODEL,
  PLATFORM_REASONING_EFFORTS,
  isCodexEngineModel,
  isCursorEngineModel,
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
    assert.equal(modelReasoningPolicy('gpt-5.6-sol').codexModelDefault, 'xhigh')
    assert.equal(modelReasoningPolicy('gpt-5.6-terra').codexModelDefault, 'xhigh')
    assert.equal(modelReasoningPolicy('gpt-5.6-luna').codexModelDefault, 'medium')
    assert.equal(modelReasoningPolicy('gpt-5.6-sol').supported.includes('ultra' as never), false)
  })

  test('static-provider effort policy is projected from the same registry', () => {
    assert.deepEqual(modelReasoningPolicy('glm-5.2').supported, ['high', 'max'])
    assert.deepEqual(modelReasoningPolicy('MiniMax-M3').supported, [])
    assert.deepEqual(modelReasoningPolicy('deepseek-v4-pro').supported, PLATFORM_REASONING_EFFORTS)
  })
})

describe('Cursor engine model authority', () => {
  test('uses only the pinned CLI allowlist and excludes GPT/Codex entries', () => {
    assert.deepEqual(CURSOR_ENGINE_MODELS, [
      { id: 'cursor-auto', displayName: 'Cursor Auto', upstreamModel: null },
      { id: 'cursor-grok-4.6-high', displayName: 'Cursor Grok 4.6 High', upstreamModel: 'cursor-grok-4.6-high' },
      { id: 'cursor-composer-2.5-fast', displayName: 'Cursor Composer 2.5 Fast', upstreamModel: 'composer-2.5-fast' },
      { id: 'cursor-opus-5-high', displayName: 'Cursor Opus 5 High', upstreamModel: 'claude-opus-5-thinking-high' },
      { id: 'cursor-fable-5-high', displayName: 'Cursor Fable 5 High (Non-ZDR)', upstreamModel: 'claude-fable-5-thinking-high' },
      { id: 'cursor-grok-4.5-high', displayName: 'Cursor Grok 4.5 High', upstreamModel: 'cursor-grok-4.5-high' },
    ])
    for (const id of CURSOR_ENGINE_MODEL_IDS) assert.equal(isCursorEngineModel(id), true)
    assert.equal(isCursorEngineModel('gpt-5.6-sol-medium'), false)
    assert.equal(isCursorEngineModel('gpt-5.3-codex'), false)
    assert.equal(isCursorEngineModel('cursor-auto --force'), false)
  })
})
