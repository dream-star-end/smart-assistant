/**
 * 巡检产出整理:结论提取与重复错误归并。
 *
 * Run: npx tsx --test packages/gateway/src/taskboard/__tests__/runOutput.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  SUMMARY_MAX,
  UNSTRUCTURED_TAIL_MARK,
  collapseRepeatedOutput,
  extractConclusion,
  summarizeRunOutput,
} from '../runOutput.js'

describe('extractConclusion', () => {
  it('取最后一次「## 结论」到下一同级标题之间的正文', () => {
    const output = [
      '收到,这是需求澄清阶段。我先读任务面板操作规则…',
      '',
      '## 过程',
      '读了 skill,列了目录。',
      '',
      '## 结论',
      '目标用户是自用维护者。',
      '验收:面板能建单并推进。',
      '产物: generated/clarification.md',
      '',
      '## 附录',
      '过程流水不应进评论。',
    ].join('\n')
    const got = extractConclusion(output)
    assert.equal(got.structured, true)
    assert.match(got.text, /目标用户是自用维护者/)
    assert.match(got.text, /generated\/clarification.md/)
    assert.doesNotMatch(got.text, /我先读任务面板/)
    assert.doesNotMatch(got.text, /过程流水/)
  })

  it('识别 ```conclusion 围栏', () => {
    const output = '过程过程\n```conclusion\n改了 X;用 Y 验证;风险 Z\n```\n尾'
    const got = extractConclusion(output)
    assert.equal(got.structured, true)
    assert.match(got.text, /改了 X/)
    assert.doesNotMatch(got.text, /过程过程/)
  })

  it('没有结构时取文末两段并标明未结构化', () => {
    const output = [
      '收到，这是 E2E-1 的『需求澄清』阶段任务。我先读任务面板操作规则…',
      '',
      '接着扫了 generated/ 目录。',
      '',
      '需求是做巡检自愈。',
      '',
      '产物在 generated/e2e-1-clarification.md。',
    ].join('\n')
    const got = extractConclusion(output)
    assert.equal(got.structured, false)
    assert.ok(got.text.includes(UNSTRUCTURED_TAIL_MARK))
    assert.match(got.text, /产物在 generated/)
    assert.doesNotMatch(got.text, /我先读任务面板/)
  })
})

describe('collapseRepeatedOutput', () => {
  it('连续相同行归并为「同一错误重复 N 次」', () => {
    const line = 'API Error: 502 {"type":"error","error":{"type":"UPSTREAM_ERROR"}}'
    const text = [line, line, line, line].join('\n')
    const got = collapseRepeatedOutput(text)
    assert.match(got, /同一错误重复 4 次/)
    assert.equal(got.split(line).length - 1, 1)
  })

  it('无分隔拼接的同一 API Error 也能归并,评论里能看出错因', () => {
    const unit = 'API Error: 502 {"type":"error","error":{"type":"UPSTREAM_ERROR","message":"bad"}}'
    const text = unit.repeat(20)
    const got = collapseRepeatedOutput(text)
    assert.match(got, /UPSTREAM_ERROR/)
    assert.match(got, /同一错误重复 20 次/)
    assert.ok(got.length < text.length / 5)
  })
})

describe('summarizeRunOutput', () => {
  it(`成功时评论用结论,summary 不超过 ${SUMMARY_MAX} 字`, () => {
    const output = `我先读规则。\n\n## 结论\n${'验收通过。产物 generated/a.md。'.repeat(3)}`
    const got = summarizeRunOutput(output)
    assert.equal(got.structured, true)
    assert.match(got.commentBody, /验收通过/)
    assert.doesNotMatch(got.commentBody, /我先读规则/)
    assert.ok(got.summary.length <= SUMMARY_MAX)
  })

  it('失败时归并重复错误写入评论,不丢关键错因', () => {
    const unit = 'API Error: 502 {"type":"error","error":{"type":"UPSTREAM_ERROR"}}'
    const got = summarizeRunOutput(unit.repeat(50), { failed: true, error: 'delegate failed' })
    assert.match(got.commentBody, /UPSTREAM_ERROR/)
    assert.match(got.commentBody, /同一错误重复/)
    assert.ok(got.summary.length <= SUMMARY_MAX)
    assert.doesNotMatch(got.summary, /API …$/)
  })
})
