import { describe, expect, it } from 'vitest'
import {
  freshSessionRequiredForSwitch,
  freshSessionSwitchNotice,
  isFreshSessionOnlyModel,
  modelSwitchCompactionReason,
} from './modelSwitch'
import type { PublicModel } from './types'

const models: PublicModel[] = [
  { id: 'vision-long', supports_vision: true, context_window: 1_000_000 },
  { id: 'text-short', supports_vision: false, context_window: 200_000 },
  { id: 'vision-long-2', supports_vision: true, context_window: 1_000_000 },
  { id: 'gpt-5.6-sol-1m', supports_vision: false, context_window: 1_000_000 },
  { id: 'gpt-5.6-sol', supports_vision: false, context_window: null },
]

describe('modelSwitchCompactionReason', () => {
  it('requires one combined native compact for vision and context downgrade', () => {
    expect(modelSwitchCompactionReason(models, 'vision-long', 'text-short', true)).toEqual({
      visionDowngrade: true,
      contextDowngrade: true,
    })
  })
  it('treats an explicit Codex 1m → standard family switch as a context downgrade', () => {
    expect(modelSwitchCompactionReason(models, 'gpt-5.6-sol-1m', 'gpt-5.6-sol', true)).toEqual({
      visionDowngrade: false,
      contextDowngrade: true,
    })
  })
  it('does not compact an empty session or a compatible switch', () => {
    expect(modelSwitchCompactionReason(models, 'vision-long', 'text-short', false)).toBeNull()
    expect(modelSwitchCompactionReason(models, 'vision-long', 'vision-long-2', true)).toBeNull()
  })
})

describe('freshSessionRequiredForSwitch (Opus / Fable 只能新会话起手)', () => {
  it('flags opus and fable cursor families only', () => {
    expect(isFreshSessionOnlyModel('cursor-opus-5-high')).toBe(true)
    expect(isFreshSessionOnlyModel('cursor-fable-5.1-high')).toBe(true)
    expect(isFreshSessionOnlyModel('cursor-grok-4.6-low')).toBe(false)
    expect(isFreshSessionOnlyModel('gpt-5.6-sol')).toBe(false)
    expect(isFreshSessionOnlyModel(undefined)).toBe(false)
  })
  it('requires a fresh session when a non-opus/fable session switches to opus/fable', () => {
    expect(freshSessionRequiredForSwitch('gpt-5.6-sol', 'cursor-opus-5-high', true)).toBe(true)
    expect(
      freshSessionRequiredForSwitch('cursor-grok-4.6-low', 'cursor-fable-5.1-high', true),
    ).toBe(true)
  })
  it('does not block empty sessions, opus↔fable moves, or leaving opus/fable', () => {
    expect(freshSessionRequiredForSwitch('gpt-5.6-sol', 'cursor-opus-5-high', false)).toBe(false)
    expect(freshSessionRequiredForSwitch('cursor-opus-5-high', 'cursor-fable-5.1-high', true)).toBe(
      false,
    )
    expect(freshSessionRequiredForSwitch('cursor-opus-5-high', 'gpt-5.6-sol', true)).toBe(false)
    expect(freshSessionRequiredForSwitch(undefined, 'cursor-opus-5-high', true)).toBe(false)
    expect(freshSessionRequiredForSwitch('cursor-opus-5-high', 'cursor-opus-5-high', true)).toBe(
      false,
    )
  })
  it('explains cache/context reason and offers 新建会话', () => {
    const notice = freshSessionSwitchNotice('cursor-opus-5-high')
    expect(notice.title).toBe('「Opus 5」仅支持在新会话中使用')
    expect(notice.paragraphs.join('\n')).toContain('无法命中提示缓存')
    expect(notice.paragraphs.join('\n')).toContain('初始上下文过大')
    expect(notice.confirmText).toBe('新建会话')
    expect(notice.cancelText).toBe('留在当前会话')
    expect(freshSessionSwitchNotice('unknown-id', 'Some Model').title).toBe(
      '「Some Model」仅支持在新会话中使用',
    )
  })
})
