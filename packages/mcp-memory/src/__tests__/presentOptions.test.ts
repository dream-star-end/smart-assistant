import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createPresentOptionsCallBudget,
  formatPresentOptionsFence,
  handlePresentOptions,
  normalizePresentOptions,
  shouldListPresentOptions,
} from '../presentOptions.js'

describe('normalizePresentOptions', () => {
  it('接受 OptionsBlock 契约并丢掉空白 question', () => {
    assert.deepEqual(
      normalizePresentOptions({
        question: '  ',
        options: [{ label: '现在换', desc: '重建容器' }, { label: '先不换' }],
      }),
      { options: [{ label: '现在换', desc: '重建容器' }, { label: '先不换' }] },
    )
  })

  it('仅 multi === true / multiSelect === true 才写出 multi', () => {
    assert.equal(normalizePresentOptions({ multi: false, options: ['A', 'B'] })?.multi, undefined)
    assert.equal(normalizePresentOptions({ multiSelect: true, options: ['A', 'B'] })?.multi, true)
  })

  it('description 别名收敛成 desc;超过 12 项或空标签失败', () => {
    assert.deepEqual(normalizePresentOptions({ options: [{ label: 'A', description: '说明' }] }), {
      options: [{ label: 'A', desc: '说明' }],
    })
    assert.equal(normalizePresentOptions({ options: Array.from({ length: 13 }, (_, i) => `o${i}`) }), null)
    assert.equal(normalizePresentOptions({ options: [{ label: '   ' }] }), null)
  })

  it('单元素 questions[] 可解包,多题拒绝', () => {
    assert.deepEqual(
      normalizePresentOptions({
        questions: [{ question: '何时部?', multiSelect: true, options: [{ label: '现在' }, { label: '稍后' }] }],
      }),
      { question: '何时部?', multi: true, options: [{ label: '现在' }, { label: '稍后' }] },
    )
    assert.equal(
      normalizePresentOptions({
        questions: [
          { question: 'a', options: ['1', '2'] },
          { question: 'b', options: ['3', '4'] },
        ],
      }),
      null,
    )
  })
})

describe('formatPresentOptionsFence', () => {
  it('产出可被 OptionsBlock 解析的围栏,闭围栏独占一行', () => {
    const fence = formatPresentOptionsFence({
      question: '要不要换 baseline？',
      options: [{ label: '现在换' }, { label: '先不换' }],
    })
    assert.equal(
      fence,
      '```options\n{"question":"要不要换 baseline？","options":[{"label":"现在换"},{"label":"先不换"}]}\n```',
    )
  })

  it('非法参数不产出半截围栏', () => {
    assert.equal(formatPresentOptionsFence({ options: [] }), null)
  })
})

describe('handlePresentOptions', () => {
  const good = { question: '选一个', options: [{ label: 'A' }, { label: 'B' }] }

  it('Cursor 主会话立刻返回已投递,不假装在等用户', () => {
    const result = handlePresentOptions(good, { engineId: 'cursor', delegationDepth: 0 })
    assert.equal(result.ok, true)
    assert.match(result.message, /选项卡已投递/)
    assert.match(result.message, /不要轮询/)
  })

  it('子 agent 短路 skipped,非 Cursor 报错,坏参数报错', () => {
    const skipped = handlePresentOptions(good, { engineId: 'cursor', delegationDepth: 1 })
    assert.equal(skipped.ok, true)
    assert.match(skipped.message, /"status":"skipped"/)
    const other = handlePresentOptions(good, { engineId: 'ccb', delegationDepth: 0 })
    assert.equal(other.ok, false)
    assert.match(other.message, /only available on the Cursor engine/)
    const bad = handlePresentOptions({ options: [] }, { engineId: 'cursor', delegationDepth: 0 })
    assert.equal(bad.ok, false)
  })
})

describe('createPresentOptionsCallBudget', () => {
  it('每个 MCP 进程只放行前四次调用', () => {
    const consume = createPresentOptionsCallBudget(4)
    assert.deepEqual(Array.from({ length: 5 }, () => consume()), [true, true, true, true, false])
  })
})

describe('shouldListPresentOptions', () => {
  it('只对 Cursor 主会话暴露,不看 OC_ASK_USER_MCP', () => {
    assert.equal(shouldListPresentOptions('cursor', 0), true)
    assert.equal(shouldListPresentOptions('cursor', 1), false)
    assert.equal(shouldListPresentOptions('ccb', 0), false)
    assert.equal(shouldListPresentOptions('', 0), false)
  })
})
