import { describe, expect, it } from 'vitest'
import {
  inspectModelSwitchSession,
  modelSwitchCompactionReason,
} from './modelSwitch'
import type { PublicModel } from './types'

const models: PublicModel[] = [
  { id: 'vision-long', supports_vision: true, context_window: 1_000_000 },
  { id: 'text-short', supports_vision: false, context_window: 200_000 },
  { id: 'vision-long-2', supports_vision: true, context_window: 1_000_000 },
  { id: 'gpt-5.6-sol-1m', supports_vision: false, context_window: 1_000_000 },
  { id: 'gpt-5.6-sol', supports_vision: false, context_window: null },
  { id: 'tiny', supports_vision: false, context_window: 100 },
]

const empty = { hasContent: false, hasVisual: false, estimatedTokens: 0 }
const textOnly = { hasContent: true, hasVisual: false, estimatedTokens: 800 }
const withImage = { hasContent: true, hasVisual: true, estimatedTokens: 2_000 }
const huge = { hasContent: true, hasVisual: false, estimatedTokens: 250_000 }

describe('inspectModelSwitchSession', () => {
  it('detects visual media and ignores thinking when estimating tokens', () => {
    const snapshot = inspectModelSwitchSession([
      { role: 'thinking', text: 'x'.repeat(10_000) },
      { role: 'user', text: 'hello', _media: [{ kind: 'image', mimeType: 'image/png' }] },
    ], 0)
    expect(snapshot).toEqual({
      hasContent: true,
      hasVisual: true,
      estimatedTokens: Math.ceil(5 / 4) + 1024,
    })
  })
  it('treats list messageCount as content even before messages hydrate', () => {
    expect(inspectModelSwitchSession([], 3)).toEqual({
      hasContent: true,
      hasVisual: false,
      estimatedTokens: 0,
    })
  })
})

describe('modelSwitchCompactionReason', () => {
  it('does not compact a vision-capable source that has no images', () => {
    expect(modelSwitchCompactionReason(models, 'vision-long', 'text-short', textOnly)).toBeNull()
  })
  it('compacts only when the session actually has visuals the target cannot see', () => {
    expect(modelSwitchCompactionReason(models, 'vision-long', 'text-short', withImage)).toEqual({
      visionDowngrade: true,
      contextDowngrade: false,
    })
    expect(modelSwitchCompactionReason(models, 'vision-long', 'vision-long-2', withImage)).toBeNull()
  })
  it('compacts context only when estimated tokens exceed the target window', () => {
    expect(modelSwitchCompactionReason(models, 'vision-long', 'text-short', huge)).toEqual({
      visionDowngrade: false,
      contextDowngrade: true,
    })
    expect(modelSwitchCompactionReason(models, 'gpt-5.6-sol-1m', 'tiny', huge)).toEqual({
      visionDowngrade: false,
      contextDowngrade: true,
    })
    expect(modelSwitchCompactionReason(models, 'gpt-5.6-sol-1m', 'text-short', textOnly)).toBeNull()
  })
  it('does not treat 1m → standard as compact when the target window is unknown or the session is small', () => {
    expect(modelSwitchCompactionReason(models, 'gpt-5.6-sol-1m', 'gpt-5.6-sol', textOnly)).toBeNull()
    expect(modelSwitchCompactionReason(models, 'gpt-5.6-sol-1m', 'gpt-5.6-sol', huge)).toBeNull()
  })
  it('does not compact an empty session', () => {
    expect(modelSwitchCompactionReason(models, 'vision-long', 'text-short', empty)).toBeNull()
    expect(modelSwitchCompactionReason(models, 'vision-long', 'text-short', {
      hasContent: false,
      hasVisual: true,
      estimatedTokens: 9_000,
    })).toBeNull()
  })
})
