import { cursorModelById } from '@openclaude/protocol'
import { describe, expect, it } from 'vitest'
import {
  lockedModelUnlockNotice,
  longContextCostConfirmationRequired,
  modelPickerRows,
  pickCursorPublicModel,
  resolveContextPickerSelection,
  resolveCursorPickerSelection,
} from './cursorModelPicker'
import type { LockedPublicModel, PublicModel } from './types'

const CURSOR_PUBLIC: PublicModel[] = [
  { id: 'cursor-auto', display_name: 'Cursor Auto' },
  { id: 'cursor-grok-4.6-high', display_name: 'Grok 4.6 High' },
  { id: 'cursor-grok-4.6-high-fast', display_name: 'Grok 4.6 High Fast' },
  { id: 'cursor-grok-4.6-low', display_name: 'Grok 4.6 Low' },
  { id: 'glm-5.2', display_name: 'GLM-5.2' },
  { id: 'cursor-composer-2.5-fast', display_name: 'Composer 2.5 Fast' },
  { id: 'cursor-composer-2.5', display_name: 'Composer 2.5' },
  { id: 'cursor-opus-5-high', display_name: 'Opus 5 High' },
  { id: 'cursor-opus-5-high-fast', display_name: 'Opus 5 High Fast' },
  { id: 'cursor-opus-4.8-high', display_name: 'Opus 4.8 High' },
  { id: 'cursor-opus-4.8-high-fast', display_name: 'Opus 4.8 High Fast' },
  { id: 'cursor-fable-5-high', display_name: 'Fable 5 High (Non-ZDR)' },
  { id: 'cursor-fable-5.1-high', display_name: 'Fable 5.1 High (Non-ZDR)' },
  { id: 'cursor-fable-5.1-max', display_name: 'Fable 5.1 Max (Non-ZDR)' },
  { id: 'cursor-gemini-3.8-flash-medium', display_name: 'Gemini 3.8 Flash Medium' },
  { id: 'cursor-gemini-3.8-flash-high', display_name: 'Gemini 3.8 Flash High' },
]

function rowKey(row: ReturnType<typeof modelPickerRows>[number]): string {
  if (row.kind === 'plain' || row.kind === 'locked-plain') return row.model.id
  return row.row.family
}

describe('cursorModelPicker', () => {
  it('collapses Cursor combos into one row per family and keeps non-cursor models', () => {
    const rows = modelPickerRows(CURSOR_PUBLIC)
    expect(rows.map(rowKey)).toEqual([
      'auto',
      'grok-4.6',
      'glm-5.2',
      'composer-2.5',
      'opus-5',
      'opus-4.8',
      'fable-5',
      'fable-5.1',
      'gemini-3.8-flash',
    ])
  })

  it('drops Fast when switching from Grok Fast onto Gemini 3.8 Flash and keeps effort', () => {
    const gemini = CURSOR_PUBLIC.filter((m) => m.id.startsWith('cursor-gemini-3.8-flash'))
    expect(
      resolveCursorPickerSelection(gemini, 'gemini-3.8-flash', 'cursor-grok-4.6-high-fast'),
    ).toBe('cursor-gemini-3.8-flash-high')
    // Fable Max has no Gemini twin (no max tier) -> fall back to the family default High.
    expect(resolveCursorPickerSelection(gemini, 'gemini-3.8-flash', 'cursor-fable-5.1-max')).toBe(
      'cursor-gemini-3.8-flash-high',
    )
    // Requesting Fast on a family without Fast rows lands on the non-Fast twin.
    expect(pickCursorPublicModel(gemini, 'gemini-3.8-flash', 'high', true)?.id).toBe(
      'cursor-gemini-3.8-flash-high',
    )
  })

  it('drops Fast when switching from Grok Fast onto Fable 5.1 (family without Fast)', () => {
    const fable51 = CURSOR_PUBLIC.filter((m) => m.id.startsWith('cursor-fable-5.1'))
    expect(resolveCursorPickerSelection(fable51, 'fable-5.1', 'cursor-grok-4.6-high-fast')).toBe(
      'cursor-fable-5.1-high',
    )
  })

  it('picks High Fast when staying on Grok and requesting fast', () => {
    const grok = CURSOR_PUBLIC.filter((m) => m.id.startsWith('cursor-grok-4.6'))
    expect(pickCursorPublicModel(grok, 'grok-4.6', 'high', true)?.id).toBe(
      'cursor-grok-4.6-high-fast',
    )
  })

  it('falls back to the non-fast sibling when Fast is missing for that effort', () => {
    const grokHighOnly = CURSOR_PUBLIC.filter((m) => m.id === 'cursor-grok-4.6-high')
    expect(pickCursorPublicModel(grokHighOnly, 'grok-4.6', 'high', true)?.id).toBe(
      'cursor-grok-4.6-high',
    )
  })

  it('preserves Fast when switching from Grok Fast onto a family that has High Fast', () => {
    const opus = CURSOR_PUBLIC.filter((m) => m.id.startsWith('cursor-opus-5'))
    expect(resolveCursorPickerSelection(opus, 'opus-5', 'cursor-grok-4.6-high-fast')).toBe(
      'cursor-opus-5-high-fast',
    )
  })

  it('preserves Fast when switching onto Opus 4.8', () => {
    const opus48 = CURSOR_PUBLIC.filter((m) => m.id.startsWith('cursor-opus-4.8'))
    expect(resolveCursorPickerSelection(opus48, 'opus-4.8', 'cursor-grok-4.6-high-fast')).toBe(
      'cursor-opus-4.8-high-fast',
    )
  })

  it('defaults Composer to standard when entering the family', () => {
    const composer = CURSOR_PUBLIC.filter((m) => m.id.startsWith('cursor-composer-2.5'))
    expect(resolveCursorPickerSelection(composer, 'composer-2.5', 'glm-5.2')).toBe(
      'cursor-composer-2.5',
    )
  })

  it('sinks degraded rows to the bottom while keeping catalog order otherwise', () => {
    const models: PublicModel[] = [
      { id: 'glm-5.3', display_name: 'GLM-5.3', degraded: true } as PublicModel,
      { id: 'glm-5.3-zai', display_name: 'GLM-5.3 (Z.AI)' },
      { id: 'minimax-m3', display_name: 'MiniMax M3' },
    ]
    const rows = modelPickerRows(models)
    expect(rows.map(rowKey)).toEqual(['glm-5.3-zai', 'minimax-m3', 'glm-5.3'])
  })

  it('sinks a family row only when every member is degraded', () => {
    const models: PublicModel[] = [
      { id: 'cursor-grok-4.6-high', display_name: 'Grok High', degraded: true } as PublicModel,
      { id: 'cursor-grok-4.6-low', display_name: 'Grok Low' },
      { id: 'glm-5.2', display_name: 'GLM-5.2' },
    ]
    const rows = modelPickerRows(models)
    // 家族仅部分成员降级时不沉底
    expect(rows.map(rowKey)).toEqual(['grok-4.6', 'glm-5.2'])
    const allDegraded: PublicModel[] = [
      { id: 'cursor-grok-4.6-high', display_name: 'Grok High', degraded: true } as PublicModel,
      { id: 'cursor-grok-4.6-low', display_name: 'Grok Low', degraded: true } as PublicModel,
      { id: 'glm-5.2', display_name: 'GLM-5.2' },
    ]
    const rows2 = modelPickerRows(allDegraded)
    expect(rows2.map(rowKey)).toEqual(['glm-5.2', 'grok-4.6'])
  })

  it('uses protocol family labels without the Cursor prefix (except Auto)', () => {
    expect(cursorModelById('cursor-grok-4.6-high')?.familyLabel).toBe('Grok 4.6')
    expect(cursorModelById('cursor-opus-5-high')?.displayName).toBe('Opus 5 High')
    expect(cursorModelById('cursor-fable-5.1-xhigh')?.displayName).toBe(
      'Fable 5.1 Extra High (Non-ZDR)',
    )
    expect(cursorModelById('cursor-auto')?.familyLabel).toBe('Cursor Auto')
    const grok = modelPickerRows(CURSOR_PUBLIC).find(
      (row) => row.kind === 'cursor-family' && row.row.family === 'grok-4.6',
    )
    expect(grok && grok.kind === 'cursor-family' ? grok.row.label : undefined).toBe('Grok 4.6')
  })

  it('appends locked rows after usable models and before degraded, skipping families with a usable member', () => {
    const models: PublicModel[] = [
      { id: 'glm-5.2', display_name: 'GLM-5.2' },
      { id: 'cursor-grok-4.6-high', display_name: 'Grok 4.6 High' },
      { id: 'glm-5.3', display_name: 'GLM-5.3', degraded: true } as PublicModel,
    ]
    const locked: LockedPublicModel[] = [
      {
        id: 'cursor-opus-5-high',
        display_name: 'Opus 5 High',
        min_plan_code: 'lite',
        min_plan_name: 'Lite',
        promo_label: '限时半价',
      },
      {
        id: 'cursor-opus-5-high-fast',
        display_name: 'Opus 5 High Fast',
        min_plan_code: 'lite',
        min_plan_name: 'Lite',
      },
      {
        id: 'cursor-fable-5.1-high',
        display_name: 'Fable 5.1 High (Non-ZDR)',
        min_plan_code: 'lite',
        min_plan_name: 'Lite',
      },
      {
        id: 'secret-model',
        display_name: 'Secret',
        min_plan_code: 'pro',
        min_plan_name: 'Pro',
      },
      {
        id: 'cursor-grok-4.6-low',
        display_name: 'Grok 4.6 Low',
        min_plan_code: 'lite',
        min_plan_name: 'Lite',
      },
    ]
    const rows = modelPickerRows(models, locked)
    expect(rows.map(rowKey)).toEqual([
      'glm-5.2',
      'grok-4.6',
      'opus-5',
      'fable-5.1',
      'secret-model',
      'glm-5.3',
    ])
    const opus = rows.find(
      (row) => row.kind === 'locked-cursor-family' && row.row.family === 'opus-5',
    )
    expect(opus && opus.kind === 'locked-cursor-family' ? opus.row.label : undefined).toBe('Opus 5')
    expect(opus && opus.kind === 'locked-cursor-family' ? opus.row.minPlanCode : undefined).toBe(
      'lite',
    )
    expect(
      opus && opus.kind === 'locked-cursor-family' ? opus.row.representative.id : undefined,
    ).toBe('cursor-opus-5-high')
    expect(
      rows.some((row) => row.kind === 'locked-cursor-family' && row.row.family === 'grok-4.6'),
    ).toBe(false)
  })
})

describe('longContextCostConfirmationRequired', () => {
  it('warns whenever a non-1M source resolves to a selectable 1M target', () => {
    expect(longContextCostConfirmationRequired('gpt-5.6-sol', 'gpt-5.6-sol-1m')).toBe(true)
    expect(longContextCostConfirmationRequired(undefined, 'kimi-k3')).toBe(true)
    expect(longContextCostConfirmationRequired('glm-5.3', 'gpt-5.6-terra-1m')).toBe(true)
  })

  it('does not re-warn across 1M families or when leaving/staying standard', () => {
    expect(longContextCostConfirmationRequired('gpt-5.6-sol-1m', 'gpt-5.6-terra-1m')).toBe(false)
    expect(longContextCostConfirmationRequired('gpt-5.6-sol-1m', 'gpt-5.6-sol')).toBe(false)
    expect(longContextCostConfirmationRequired('gpt-5.6-sol', 'gpt-5.6-terra')).toBe(false)
  })
})

describe('context family picker', () => {
  const MODELS: PublicModel[] = [
    { id: 'glm-5.3', display_name: 'GLM-5.3' },
    { id: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol' },
    { id: 'gpt-5.6-sol-1m', display_name: 'GPT-5.6-Sol' },
    { id: 'k3-256k', display_name: 'Kimi K3 256K' },
    { id: 'kimi-k3', display_name: 'Kimi K3' },
  ]

  it('collapses GPT and Kimi context twins into one row each', () => {
    const rows = modelPickerRows(MODELS)
    expect(rows.map(rowKey)).toEqual(['glm-5.3', 'gpt-5.6-sol', 'kimi-k3'])
  })

  it('defaults GPT/Kimi to the standard window', () => {
    const gpt = MODELS.filter((m) => m.id.startsWith('gpt-5.6-sol'))
    const spec = {
      family: 'gpt-5.6-sol',
      familyLabel: 'GPT-5.6-Sol',
      standardId: 'gpt-5.6-sol',
      longId: 'gpt-5.6-sol-1m',
    } as const
    expect(resolveContextPickerSelection(gpt, spec, 'glm-5.3')).toBe('gpt-5.6-sol')
    const kimi = MODELS.filter((m) => m.id === 'k3-256k' || m.id === 'kimi-k3')
    const kimiSpec = {
      family: 'kimi-k3',
      familyLabel: 'Kimi K3',
      standardId: 'k3-256k',
      longId: 'kimi-k3',
    } as const
    expect(resolveContextPickerSelection(kimi, kimiSpec, 'glm-5.3')).toBe('k3-256k')
  })

  it('preserves 1M when switching GPT families', () => {
    const terra: PublicModel[] = [
      { id: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra' },
      { id: 'gpt-5.6-terra-1m', display_name: 'GPT-5.6-Terra' },
    ]
    const spec = {
      family: 'gpt-5.6-terra',
      familyLabel: 'GPT-5.6-Terra',
      standardId: 'gpt-5.6-terra',
      longId: 'gpt-5.6-terra-1m',
    } as const
    expect(resolveContextPickerSelection(terra, spec, 'gpt-5.6-sol-1m')).toBe('gpt-5.6-terra-1m')
  })
})

describe('lockedModelUnlockNotice (OCV5-86)', () => {
  it('lite gate says any paid subscription unlocks and offers 前往订阅 / 暂不', () => {
    const n = lockedModelUnlockNotice({ label: 'Opus 5', minPlanCode: 'lite', minPlanName: 'Lite' })
    expect(n.title).toBe('「Opus 5」为订阅专享模型')
    expect(n.paragraphs[0]).toContain('任意订阅套餐')
    expect(n.paragraphs[0]).toContain('Lite 及以上任一档')
    expect(n.paragraphs[0]).toContain('即可解锁')
    expect(n.paragraphs.join('\n')).toContain('订阅后立即生效')
    expect(n.confirmText).toBe('前往订阅')
    expect(n.cancelText).toBe('暂不')
  })

  it('higher gate names the plan tier instead of 任意', () => {
    const n = lockedModelUnlockNotice({
      label: 'Fable 5.1 Max',
      minPlanCode: 'pro',
      minPlanName: 'Pro',
    })
    expect(n.paragraphs[0]).toContain('需订阅 Pro 及以上套餐')
    expect(n.paragraphs[0]).not.toContain('任意')
  })

  it('falls back to plan code and generic label when names are missing', () => {
    const n = lockedModelUnlockNotice({ label: '  ', minPlanCode: 'LITE' })
    expect(n.title).toBe('「该模型」为订阅专享模型')
    expect(n.paragraphs[0]).toContain('LITE 及以上任一档')
    expect(n.paragraphs[0]).toContain('任意订阅套餐')
  })
})
