import { describe, expect, it } from 'vitest'
import { modelSwitchCompactionReason } from './modelSwitch'
import type { PublicModel } from './types'

const models: PublicModel[] = [
  { id: 'vision-long', supports_vision: true, context_window: 1_000_000 },
  { id: 'text-short', supports_vision: false, context_window: 200_000 },
  { id: 'vision-long-2', supports_vision: true, context_window: 1_000_000 },
]

describe('modelSwitchCompactionReason', () => {
  it('requires one combined native compact for vision and context downgrade', () => {
    expect(modelSwitchCompactionReason(models, 'vision-long', 'text-short', true)).toEqual({
      visionDowngrade: true,
      contextDowngrade: true,
    })
  })
  it('does not compact an empty session or a compatible switch', () => {
    expect(modelSwitchCompactionReason(models, 'vision-long', 'text-short', false)).toBeNull()
    expect(modelSwitchCompactionReason(models, 'vision-long', 'vision-long-2', true)).toBeNull()
  })
})
