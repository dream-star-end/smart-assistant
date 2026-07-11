import { describe, expect, test } from 'vitest'
import { classifyMediaRef } from './media'

describe('classifyMediaRef', () => {
  test('/api/media uploads are same-origin direct images rather than permanent placeholders', () => {
    expect(classifyMediaRef({ kind: 'image', url: '/api/media/example.png' })).toEqual({
      mode: 'direct',
      kind: 'image',
      src: '/api/media/example.png',
      filename: undefined,
      mimeType: undefined,
    })
  })

  test('container absolute paths still require a signed URL', () => {
    expect(
      classifyMediaRef({ kind: 'image', url: '/home/agent/.openclaude/generated/a.png' }),
    ).toMatchObject({
      mode: 'sign',
      path: '/home/agent/.openclaude/generated/a.png',
      kind: 'image',
    })
  })
})
