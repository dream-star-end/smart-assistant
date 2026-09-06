/**
 * Run: npx tsx --test packages/mcp-memory/src/__tests__/delegateArgs.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  goalRequiredError,
  normalizeDelegateGoal,
  SELF_DELEGATE_ERROR,
  normalizeDelegateAgentId,
  normalizeDelegateModel,
  rejectSelfDelegate,
  rewriteSelfDelegateErrorForMcp,
} from '../delegateArgs.js'

describe('normalizeDelegateModel', () => {
  it('缺省 / 空白 → 不指定', () => {
    assert.deepEqual(normalizeDelegateModel(undefined), { ok: true })
    assert.deepEqual(normalizeDelegateModel(''), { ok: true })
    assert.deepEqual(normalizeDelegateModel('  '), { ok: true })
  })

  it('合法 catalog 型号(含点)透传', () => {
    const r = normalizeDelegateModel(' cursor-grok-4.6-high-fast ')
    assert.deepEqual(r, { ok: true, model: 'cursor-grok-4.6-high-fast' })
  })

  it('非法字符拒绝', () => {
    const r = normalizeDelegateModel('cursor grok')
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /model 无效/)
  })
})

describe('normalizeDelegateAgentId', () => {
  it('成员 id 透传', () => {
    assert.deepEqual(normalizeDelegateAgentId('coding-assistant'), {
      ok: true,
      agentId: 'coding-assistant',
    })
  })

  it('把型号当 agentId → 指向 model 参数', () => {
    const r = normalizeDelegateAgentId('cursor-grok-4.6-high-fast')
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.match(r.error, /agentId 只能是平台成员/)
      assert.match(r.error, /model=/)
    }
  })
})

describe('rejectSelfDelegate', () => {
  it('caller===target 拒绝并提示 --allow-self', () => {
    const r = rejectSelfDelegate({ callerAgentId: 'main', targetAgentId: 'main' })
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.match(r.error, /不能把任务委派给自己/)
      assert.match(r.error, /--allow-self/)
    }
  })

  it('allowSelf 覆盖', () => {
    assert.equal(
      rejectSelfDelegate({ callerAgentId: 'main', targetAgentId: 'main', allowSelf: true }).ok,
      true,
    )
  })

  it('其他成员放行', () => {
    assert.equal(
      rejectSelfDelegate({ callerAgentId: 'main', targetAgentId: 'coding-assistant' }).ok,
      true,
    )
  })
})

describe('rewriteSelfDelegateErrorForMcp', () => {
  it('把 CLI 口径的 --allow-self 提示改写为 MCP 参数 allowSelf', () => {
    const out = rewriteSelfDelegateErrorForMcp(`委派失败: ${SELF_DELEGATE_ERROR}`)
    assert.doesNotMatch(out, /--allow-self/)
    assert.match(out, /allowSelf: true/)
    assert.match(out, /coding-assistant/)
  })
  it('其它文本原样返回', () => {
    assert.equal(rewriteSelfDelegateErrorForMcp('foo'), 'foo')
  })
})

describe('normalizeDelegateGoal / goalRequiredError(缺 goal 自愈)', () => {
  it('缺 goal → 点名正确字段名 + 最小示例,保留 goal required 前缀', () => {
    const r = normalizeDelegateGoal(undefined, {})
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.match(r.error, /^goal required/)
      assert.match(r.error, /字段名不是 task\/message\/prompt/)
      assert.match(r.error, /\{"goal":"\.\.\."\}/)
    }
  })
  it('任务写进了 task/message → 直接指出改名', () => {
    const r = normalizeDelegateGoal(undefined, { task: '修 bug', message: 'x' })
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /你填的 "task"\/"message" 请改名为 "goal"/)
  })
  it('空白 goal 视为缺失;正常 goal trim 后返回', () => {
    assert.equal(normalizeDelegateGoal('   ', {}).ok, false)
    assert.deepEqual(normalizeDelegateGoal('  do it ', {}), { ok: true, goal: 'do it' })
  })
  it('goalRequiredError 无同义字段时不出现改名提示', () => {
    assert.doesNotMatch(goalRequiredError({ agentId: 'main' }), /请改名为/)
    assert.doesNotMatch(goalRequiredError(null), /请改名为/)
  })
})
