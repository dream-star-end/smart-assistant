import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  CODEX_ENGINE_MODEL_IDS,
  CURSOR_ENGINE_MODELS,
  CURSOR_ENGINE_MODEL_IDS,
  DEFAULT_CODEX_ENGINE_MODEL,
  PLATFORM_REASONING_EFFORTS,
  cursorFamilyDefaultFast,
  cursorFamilyEfforts,
  cursorFamilySupportsFast,
  findCursorEngineModel,
  isCodexEngineModel,
  isCodexLongContextModel,
  isCursorEngineModel,
  isZcodeEngineModel,
  modelReasoningPolicy,
  codexTransportModelId,
  zcodeTransportModelId,
  ZCODE_ENGINE_MODEL_IDS,
  ZCODE_HOSTED_PERMISSION_MODE,
} from '../engineModels.js'

describe('GPT-5.6 engine model authority', () => {
  test('exactly the three GPT-5.6 series are Codex models; GPT-5.5 is retired', () => {
    assert.deepEqual(CODEX_ENGINE_MODEL_IDS, [
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.6-sol-1m',
      'gpt-5.6-terra-1m',
      'gpt-5.6-luna-1m',
    ])
    assert.equal(DEFAULT_CODEX_ENGINE_MODEL, 'gpt-5.6-sol')
    for (const id of CODEX_ENGINE_MODEL_IDS) assert.equal(isCodexEngineModel(id), true)
    assert.equal(isCodexEngineModel('gpt-5.5'), false)
    assert.equal(isCodexEngineModel('gpt-5.6-ultra'), false)
    assert.equal(isCodexLongContextModel('gpt-5.6-sol'), false)
    assert.equal(isCodexLongContextModel('gpt-5.6-sol-1m'), true)
    assert.equal(codexTransportModelId('gpt-5.6-sol-1m'), 'gpt-5.6-sol')
    assert.equal(codexTransportModelId('gpt-5.6-sol'), 'gpt-5.6-sol')
    assert.equal(modelReasoningPolicy('gpt-5.6-sol-1m').codexModelDefault, 'xhigh')
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
  test('pins CLI families with effort/fast metadata and excludes GPT/Codex entries', () => {
    assert.equal(CURSOR_ENGINE_MODELS.length, 37)
    assert.equal(CURSOR_ENGINE_MODELS[0].id, 'cursor-auto')
    assert.deepEqual(
      CURSOR_ENGINE_MODELS.find((m) => m.id === 'cursor-grok-4.6-high'),
      {
        id: 'cursor-grok-4.6-high',
        displayName: 'Cursor Grok 4.6 High',
        upstreamModel: 'cursor-grok-4.6-high',
        family: 'grok-4.6',
        familyLabel: 'Cursor Grok 4.6',
        effort: 'high',
        fast: false,
      },
    )
    assert.equal(
      findCursorEngineModel('opus-5', 'high', true)?.upstreamModel,
      'claude-opus-5-thinking-high-fast',
    )
    assert.equal(
      findCursorEngineModel('opus-4.8', 'high', true)?.upstreamModel,
      'claude-opus-4-8-thinking-high-fast',
    )
    assert.deepEqual(cursorFamilyEfforts('opus-4.8'), ['low', 'medium', 'high', 'xhigh', 'max'])
    assert.equal(cursorFamilySupportsFast('opus-4.8'), true)
    assert.equal(findCursorEngineModel('composer-2.5', null, false)?.upstreamModel, 'composer-2.5')
    assert.deepEqual(cursorFamilyEfforts('grok-4.6'), ['low', 'medium', 'high', 'xhigh'])
    assert.equal(cursorFamilySupportsFast('fable-5'), false)
    assert.equal(cursorFamilyDefaultFast('composer-2.5'), false)
    assert.equal(cursorFamilyDefaultFast('grok-4.6'), false)
    assert.equal(modelReasoningPolicy('cursor-grok-4.6-high').supported.length, 0)
    for (const id of CURSOR_ENGINE_MODEL_IDS) assert.equal(isCursorEngineModel(id), true)
    assert.equal(isCursorEngineModel('gpt-5.6-sol-medium'), false)
    assert.equal(isCursorEngineModel('gpt-5.3-codex'), false)
    assert.equal(isCursorEngineModel('cursor-auto --force'), false)
  })
})

describe('ZCode experimental engine model authority', () => {
  test('keeps canonical id separate from the 0.16.3 config upstream id', () => {
    assert.deepEqual(ZCODE_ENGINE_MODEL_IDS, ['zcode-experimental'])
    assert.equal(isZcodeEngineModel('zcode-experimental'), true)
    assert.equal(isZcodeEngineModel('zai/glm-5.1'), false)
    assert.equal(isZcodeEngineModel('zai-coding-plan/glm-5.3'), false)
    assert.equal(isZcodeEngineModel('glm-5.3-zai'), false)
    assert.equal(zcodeTransportModelId('zcode-experimental'), 'zai-coding-plan/glm-5.3')
    assert.equal(zcodeTransportModelId('glm-5.3-zai'), 'zai-coding-plan/glm-5.3')
    assert.equal(zcodeTransportModelId('zai-coding-plan/glm-5.3'), undefined)
    assert.equal(ZCODE_HOSTED_PERMISSION_MODE, 'yolo')
    assert.equal(modelReasoningPolicy('zcode-experimental').supported.length, 0)
  })
})
