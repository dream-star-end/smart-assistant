import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { formatPresentOptionsFence, normalizePresentOptions } from '../engine/presentOptions.js'

describe('gateway presentOptions 与 OptionsBlock 契约对齐', () => {
  it('合法输入产出闭围栏独占一行的 options JSON', () => {
    assert.deepEqual(
      normalizePresentOptions({
        question: '要不要换 baseline？',
        multi: true,
        options: [{ label: '现在换', description: '重建' }, '先不换'],
      }),
      {
        question: '要不要换 baseline？',
        multi: true,
        options: [{ label: '现在换', desc: '重建' }, { label: '先不换' }],
      },
    )
    assert.equal(
      formatPresentOptionsFence({
        question: '要不要换 baseline？',
        options: [{ label: '现在换' }, { label: '先不换' }],
      }),
      '```options\n{"question":"要不要换 baseline？","options":[{"label":"现在换"},{"label":"先不换"}]}\n```',
    )
  })

  it('空 options / 超 12 项 / 非对象失败', () => {
    assert.equal(normalizePresentOptions(null), null)
    assert.equal(normalizePresentOptions({ options: [] }), null)
    assert.equal(formatPresentOptionsFence({ options: Array.from({ length: 13 }, (_, i) => `x${i}`) }), null)
  })
})
