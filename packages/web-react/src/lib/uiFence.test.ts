import { describe, expect, test } from 'vitest'
import { uiFencesToMarkdown } from '../components/iui/toMarkdown'
import { nextPredictionOf } from './inputPrediction'
import { normalizeInlineUiFences } from './uiFence'

// 2026-10-17 商业发布门里官方 DeepSeek 的真实回答(deepseek-v4-flash,OCV5-482)。
const GATE_RAW = '2```ui{"type":"next","text":"2+2等于几?"}\n```'

describe('normalizeInlineUiFences(OCV5-482)', () => {
  test('贴在正文后的 ui 块挪到单独一行,JSON 离开围栏行', () => {
    expect(normalizeInlineUiFences(GATE_RAW)).toBe(
      '2\n```ui\n{"type":"next","text":"2+2等于几?"}\n```',
    )
  })

  test('收围栏也贴在 JSON 后面', () => {
    expect(normalizeInlineUiFences('好的。```ui {"type":"next","text":"继续"}```')).toBe(
      '好的。\n```ui\n{"type":"next","text":"继续"}\n```',
    )
  })

  test('行首围栏上直接写 JSON', () => {
    expect(normalizeInlineUiFences('答案\n\n```ui{"type":"next","text":"再来"}\n```')).toBe(
      '答案\n\n```ui\n{"type":"next","text":"再来"}\n```',
    )
  })

  test('标准写法、正文里提到 ```ui 写法、其它代码块里的 ```ui 都不动', () => {
    const standard = '答案\n\n```ui\n{"type":"next","text":"x"}\n```'
    expect(normalizeInlineUiFences(standard)).toBe(standard)
    const prose = '用 ```ui fences 写组件'
    expect(normalizeInlineUiFences(prose)).toBe(prose)
    const code = '```md\n示例:2```ui{"type":"next"}\n```'
    expect(normalizeInlineUiFences(code)).toBe(code)
    expect(normalizeInlineUiFences('没有组件')).toBe('没有组件')
  })

  test('缩进代码块里的 ```ui 示例不动,后续正文保留(Codex r1)', () => {
    const indented = '示例:\n\n    ```ui\n    {"type":"next","text":"继续"}\n    ```\n\n后续回答。'
    expect(normalizeInlineUiFences(indented)).toBe(indented)
    const indentedGlued = '    示例 2```ui{"type":"next"}\n    ```\n\n后续回答。'
    expect(normalizeInlineUiFences(indentedGlued)).toBe(indentedGlued)
  })

  test('输入预测与 Markdown 转换都认得贴行的块', () => {
    expect(nextPredictionOf(GATE_RAW)).toBe('2+2等于几?')
    expect(uiFencesToMarkdown(GATE_RAW).trim()).toBe('2')
  })
})
