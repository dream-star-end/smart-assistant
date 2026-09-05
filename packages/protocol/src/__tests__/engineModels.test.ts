import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  CODEX_ENGINE_MODEL_IDS,
  COLLAPSED_CONTEXT_FAMILY_GROUP_LABEL,
  CONTEXT_TIER_FAMILIES,
  CURSOR_CONTEXT_TIERS,
  CURSOR_CONTEXT_TIER_FAMILIES,
  CURSOR_CONTEXT_TIER_WINDOW,
  CURSOR_ENGINE_MODELS,
  CURSOR_ENGINE_MODEL_IDS,
  DEFAULT_CURSOR_CONTEXT_TIER,
  DEFAULT_CODEX_ENGINE_MODEL,
  PLATFORM_REASONING_EFFORTS,
  cursorFamilyDefaultFast,
  cursorFamilyEfforts,
  cursorFamilySupportsContextTier,
  cursorFamilySupportsFast,
  cursorCredentialModelFamily,
  findCursorEngineModel,
  isCodexEngineModel,
  isCodexLongContextModel,
  isCursorContextTier,
  isCursorEngineModel,
  cursorModelSupportsContextTier,
  contextFamilyByModelId,
  contextFamilyCollapsedByDefault,
  projectContextWindowForCursorTier,
  isZcodeEngineModel,
  modelReasoningPolicy,
  codexTransportModelId,
  zcodeTransportModelId,
  ZCODE_ENGINE_MODEL_IDS,
  ZCODE_HOSTED_PERMISSION_MODE,
} from '../engineModels.js'

describe('GPT-5.6 / GPT-6 engine model authority', () => {
  test('exactly the GPT-5.6 series plus GPT-6-Astra are Codex models; GPT-5.5 is retired', () => {
    assert.deepEqual(CODEX_ENGINE_MODEL_IDS, [
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.6-sol-1m',
      'gpt-5.6-terra-1m',
      'gpt-5.6-luna-1m',
      'gpt-6-astra',
      'gpt-6-astra-1m',
    ])
    assert.equal(DEFAULT_CODEX_ENGINE_MODEL, 'gpt-5.6-sol')
    assert.equal(isCodexLongContextModel('gpt-6-astra'), false)
    assert.equal(isCodexLongContextModel('gpt-6-astra-1m'), true)
    assert.equal(codexTransportModelId('gpt-6-astra-1m'), 'gpt-6-astra')
    assert.equal(modelReasoningPolicy('gpt-6-astra').codexModelDefault, 'xhigh')
    assert.equal(modelReasoningPolicy('gpt-6-astra-1m').codexModelDefault, 'xhigh')
    assert.equal(isCodexEngineModel('gpt-6'), false)
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

  test('context-tier families: Astra first, Terra/Luna collapsed by default', () => {
    assert.deepEqual(
      CONTEXT_TIER_FAMILIES.map((f) => f.family),
      ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'kimi-k3'],
    )
    assert.deepEqual(
      CONTEXT_TIER_FAMILIES.filter((f) => f.collapsedByDefault).map((f) => f.family),
      ['gpt-5.6-terra', 'gpt-5.6-luna'],
    )
    assert.equal(contextFamilyCollapsedByDefault('gpt-6-astra'), false)
    assert.equal(contextFamilyCollapsedByDefault('gpt-5.6-sol'), false)
    assert.equal(contextFamilyCollapsedByDefault('gpt-5.6-terra'), true)
    assert.equal(contextFamilyCollapsedByDefault('gpt-5.6-luna'), true)
    assert.equal(contextFamilyCollapsedByDefault('kimi-k3'), false)
    assert.equal(contextFamilyByModelId('gpt-6-astra-1m')?.family, 'gpt-6-astra')
    assert.equal(COLLAPSED_CONTEXT_FAMILY_GROUP_LABEL, '更多 GPT 模型')
    for (const family of CONTEXT_TIER_FAMILIES) {
      if (family.family === 'kimi-k3') continue
      assert.equal(isCodexEngineModel(family.standardId), true, family.standardId)
      assert.equal(isCodexEngineModel(family.longId), true, family.longId)
    }
  })

  test('static-provider effort policy is projected from the same registry', () => {
    assert.deepEqual(modelReasoningPolicy('glm-5.2').supported, ['high', 'max'])
    assert.deepEqual(modelReasoningPolicy('MiniMax-M3').supported, [])
    assert.deepEqual(modelReasoningPolicy('deepseek-v4-pro').supported, PLATFORM_REASONING_EFFORTS)
  })
})

describe('Cursor engine model authority', () => {
  test('pins CLI families with effort/fast metadata and excludes GPT/Codex entries', () => {
    assert.equal(CURSOR_ENGINE_MODELS.length, 60)
    assert.equal(CURSOR_ENGINE_MODELS[0].id, 'cursor-auto')
    assert.deepEqual(
      CURSOR_ENGINE_MODELS.find((m) => m.id === 'cursor-grok-4.6-high'),
      {
        id: 'cursor-grok-4.6-high',
        displayName: 'Grok 4.6 High',
        upstreamModel: 'cursor-grok-4.6-high',
        family: 'grok-4.6',
        familyLabel: 'Grok 4.6',
        effort: 'high',
        fast: false,
      },
    )
    assert.equal(
      CURSOR_ENGINE_MODELS.find((m) => m.id === 'cursor-auto')?.familyLabel,
      'Cursor Auto',
    )
    assert.equal(
      CURSOR_ENGINE_MODELS.find((m) => m.id === 'cursor-auto')?.displayName,
      'Cursor Auto',
    )
    assert.equal(
      CURSOR_ENGINE_MODELS.find((m) => m.id === 'cursor-opus-5-high')?.displayName,
      'Opus 5 High',
    )
    assert.equal(
      CURSOR_ENGINE_MODELS.find((m) => m.id === 'cursor-fable-5.1-xhigh')?.displayName,
      'Fable 5.1 Extra High (Non-ZDR)',
    )
    assert.equal(
      CURSOR_ENGINE_MODELS.find((m) => m.id === 'cursor-composer-2.5')?.familyLabel,
      'Composer 2.5',
    )
    for (const model of CURSOR_ENGINE_MODELS) {
      if (model.family === 'auto') continue
      assert.equal(model.familyLabel.startsWith('Cursor '), false, model.id)
      assert.equal(model.displayName.startsWith('Cursor '), false, model.id)
    }
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
    assert.equal(cursorFamilySupportsFast('fable-5.1'), false)
    assert.deepEqual(cursorFamilyEfforts('fable-5.1'), ['low', 'medium', 'high', 'xhigh', 'max'])
    assert.equal(
      findCursorEngineModel('fable-5.1', 'high', false)?.upstreamModel,
      'claude-fable-5-1-thinking-high',
    )
    assert.equal(findCursorEngineModel('fable-5.1', 'high', true), undefined)
    assert.equal(cursorFamilySupportsFast('gemini-3.8-flash'), false)
    assert.deepEqual(cursorFamilyEfforts('gemini-3.8-flash'), ['low', 'medium', 'high'])
    assert.equal(
      findCursorEngineModel('gemini-3.8-flash', 'high', false)?.upstreamModel,
      'gemini-3.8-flash-high',
    )
    assert.equal(findCursorEngineModel('gemini-3.8-flash', 'xhigh', false), undefined)
    assert.equal(findCursorEngineModel('gemini-3.8-flash', 'high', true), undefined)
    assert.equal(
      CURSOR_ENGINE_MODELS.find((m) => m.id === 'cursor-gemini-3.8-flash-medium')?.displayName,
      'Gemini 3.8 Flash Medium',
    )
    assert.equal(cursorFamilySupportsContextTier('gemini-3.8-flash'), false)
    assert.equal(cursorFamilyDefaultFast('composer-2.5'), false)
    assert.equal(cursorFamilyDefaultFast('grok-4.6'), false)
    assert.equal(modelReasoningPolicy('cursor-grok-4.6-high').supported.length, 0)
    for (const id of CURSOR_ENGINE_MODEL_IDS) assert.equal(isCursorEngineModel(id), true)
    assert.equal(isCursorEngineModel('gpt-5.6-sol-medium'), false)
    assert.equal(isCursorEngineModel('gpt-5.3-codex'), false)
    assert.equal(isCursorEngineModel('cursor-auto --force'), false)
    assert.equal(cursorCredentialModelFamily('cursor-auto'), 'cursor_models')
    assert.equal(cursorCredentialModelFamily('cursor-grok-4.6-high'), 'cursor_models')
    assert.equal(cursorCredentialModelFamily('composer-2.5-fast'), 'cursor_models')
    assert.equal(cursorCredentialModelFamily('cursor-opus-5-high'), 'other_models')
    assert.equal(cursorCredentialModelFamily('claude-fable-5-thinking-high'), 'other_models')
    assert.equal(cursorCredentialModelFamily('cursor-fable-5.1-high'), 'other_models')
    assert.equal(cursorCredentialModelFamily('cursor-sonnet-5-high'), 'other_models')
    assert.equal(cursorFamilySupportsFast('sonnet-5'), false)
    assert.deepEqual(cursorFamilyEfforts('sonnet-5'), ['low', 'medium', 'high', 'xhigh', 'max'])
    assert.equal(findCursorEngineModel('sonnet-5', 'high', false)?.upstreamModel, 'claude-sonnet-5-thinking-high')
    assert.equal(cursorCredentialModelFamily('cursor-gemini-3.8-flash-high'), 'other_models')
    assert.equal(cursorCredentialModelFamily('gemini-3.8-flash-low'), 'other_models')
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

describe('Cursor context tier (300k default / 1M opt-in, turn-level execution axis)', () => {
  test('tier vocabulary + default + windows are pinned', () => {
    assert.deepEqual([...CURSOR_CONTEXT_TIERS], ['300k', '1m'])
    assert.equal(DEFAULT_CURSOR_CONTEXT_TIER, '300k')
    assert.equal(CURSOR_CONTEXT_TIER_WINDOW['300k'], 300_000)
    assert.equal(CURSOR_CONTEXT_TIER_WINDOW['1m'], 1_000_000)
    assert.equal(isCursorContextTier('300k'), true)
    assert.equal(isCursorContextTier('1m'), true)
    assert.equal(isCursorContextTier('1M'), false)
    assert.equal(isCursorContextTier('200k'), false)
    assert.equal(isCursorContextTier(null), false)
    assert.equal(isCursorContextTier(undefined), false)
  })

  test('exactly opus-5 / opus-4.8 / fable-5 / fable-5.1 / sonnet-5 families are tiered', () => {
    assert.deepEqual([...CURSOR_CONTEXT_TIER_FAMILIES], ['opus-5', 'opus-4.8', 'fable-5', 'fable-5.1', 'sonnet-5'])
    for (const model of CURSOR_ENGINE_MODELS) {
      assert.equal(
        cursorModelSupportsContextTier(model.id),
        CURSOR_CONTEXT_TIER_FAMILIES.includes(model.family),
        `${model.id} tier support must follow its family`,
      )
    }
    assert.equal(cursorFamilySupportsContextTier('auto'), false)
    assert.equal(cursorModelSupportsContextTier('gpt-5.6-sol'), false)
    assert.equal(cursorModelSupportsContextTier(null), false)
    assert.equal(cursorModelSupportsContextTier(undefined), false)
  })

  test('projectContextWindowForCursorTier only narrows, never widens, and passes through non-tier models', () => {
    // 缺省档 = 300k;显式 1m 保留目录上限(1M)
    assert.equal(projectContextWindowForCursorTier('cursor-fable-5.1-high', 1_000_000, null), 300_000)
    assert.equal(projectContextWindowForCursorTier('cursor-fable-5.1-high', 1_000_000, undefined), 300_000)
    assert.equal(projectContextWindowForCursorTier('cursor-fable-5.1-high', 1_000_000, '300k'), 300_000)
    assert.equal(projectContextWindowForCursorTier('cursor-fable-5.1-high', 1_000_000, '1m'), 1_000_000)
    assert.equal(projectContextWindowForCursorTier('cursor-opus-5-high', 1_000_000, '1m'), 1_000_000)
    assert.equal(projectContextWindowForCursorTier('cursor-opus-4.8-high', 1_000_000, '300k'), 300_000)
    // 目录窗口低于档位:取 min(不放宽)
    assert.equal(projectContextWindowForCursorTier('cursor-fable-5-high', 200_000, '1m'), 200_000)
    assert.equal(projectContextWindowForCursorTier('cursor-fable-5-high', 200_000, '300k'), 200_000)
    // null 窗口(目录未声明)透传
    assert.equal(projectContextWindowForCursorTier('cursor-fable-5-high', null, '1m'), null)
    // 非分档模型原样透传,无论 tier
    assert.equal(projectContextWindowForCursorTier('cursor-auto', 1_000_000, '300k'), 1_000_000)
    assert.equal(projectContextWindowForCursorTier('kimi-k3', 1_048_576, '300k'), 1_048_576)
    assert.equal(projectContextWindowForCursorTier('gpt-5.6-sol', 400_000, '1m'), 400_000)
  })
})
