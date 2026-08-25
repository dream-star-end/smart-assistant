import { describe, expect, it } from 'vitest'
import {
  longContextCostConfirmationRequired,
  modelPickerRows,
  pickCursorPublicModel,
  resolveContextPickerSelection,
  resolveCursorPickerSelection,
} from './cursorModelPicker'
import type { PublicModel } from './types'

const CURSOR_PUBLIC: PublicModel[] = [
  { id: 'cursor-auto', display_name: 'Cursor Auto' },
  { id: 'cursor-grok-4.6-high', display_name: 'Cursor Grok 4.6 High' },
  { id: 'cursor-grok-4.6-high-fast', display_name: 'Cursor Grok 4.6 High Fast' },
  { id: 'cursor-grok-4.6-low', display_name: 'Cursor Grok 4.6 Low' },
  { id: 'glm-5.2', display_name: 'GLM-5.2' },
  { id: 'cursor-composer-2.5-fast', display_name: 'Cursor Composer 2.5 Fast' },
  { id: 'cursor-composer-2.5', display_name: 'Cursor Composer 2.5' },
  { id: 'cursor-opus-5-high', display_name: 'Cursor Opus 5 High' },
  { id: 'cursor-opus-5-high-fast', display_name: 'Cursor Opus 5 High Fast' },
  { id: 'cursor-opus-4.8-high', display_name: 'Cursor Opus 4.8 High' },
  { id: 'cursor-opus-4.8-high-fast', display_name: 'Cursor Opus 4.8 High Fast' },
  { id: 'cursor-fable-5-high', display_name: 'Cursor Fable 5 High (Non-ZDR)' },
]

describe('cursorModelPicker', () => {
  it('collapses Cursor combos into one row per family and keeps non-cursor models', () => {
    const rows = modelPickerRows(CURSOR_PUBLIC)
    expect(rows.map((row) => (row.kind === 'plain' ? row.model.id : row.row.family))).toEqual([
      'auto',
      'grok-4.6',
      'glm-5.2',
      'composer-2.5',
      'opus-5',
      'opus-4.8',
      'fable-5',
    ])
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
    expect(rows.map((row) => (row.kind === 'plain' ? row.model.id : row.row.family))).toEqual([
      'glm-5.3',
      'gpt-5.6-sol',
      'kimi-k3',
    ])
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
