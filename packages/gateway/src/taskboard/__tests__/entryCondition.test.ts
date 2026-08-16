import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  type EntryConditionContext,
  evaluateEntryCondition,
  parseEntryCondition,
} from '../entryCondition.js'

const BASE: EntryConditionContext = {
  body: '只是一段普通描述,没有标题。',
  labels: [],
  hasOpenBlockers: false,
  commentAuthorKinds: [],
  priority: 'P2',
  lastRunSucceeded: null,
}

function ev(expr: string, over: Partial<EntryConditionContext> = {}): boolean {
  const parsed = parseEntryCondition(expr)
  if (!parsed.ok) throw new Error(parsed.error)
  return evaluateEntryCondition(parsed.ast, { ...BASE, ...over })
}

describe('空表达式放行', () => {
  for (const expr of [null, undefined, '', '   ', '\n\t']) {
    it(`parse(${JSON.stringify(expr)}) → always`, () => {
      const parsed = parseEntryCondition(expr)
      assert.equal(parsed.ok, true)
      if (parsed.ok) {
        assert.equal(parsed.ast.type, 'always')
        assert.equal(evaluateEntryCondition(parsed.ast, BASE), true)
      }
    })
  }
})

describe('解析错误(中文)', () => {
  it('未知谓词', () => {
    const p = parseEntryCondition('has_repro')
    assert.equal(p.ok, false)
    if (!p.ok) assert.match(p.error, /未知谓词/)
  })

  it('has_body_section 缺参数', () => {
    const p = parseEntryCondition('has_body_section')
    assert.equal(p.ok, false)
    if (!p.ok) assert.match(p.error, /复现步骤/)
  })

  it('has_body_section() 空括号', () => {
    const p = parseEntryCondition('has_body_section()')
    assert.equal(p.ok, false)
    if (!p.ok) assert.match(p.error, /章节名/)
  })

  it('no_open_blockers 拒参数', () => {
    const p = parseEntryCondition('no_open_blockers("x")')
    assert.equal(p.ok, false)
    if (!p.ok) assert.match(p.error, /不接受参数/)
  })

  it('中文参数未加引号', () => {
    const p = parseEntryCondition('has_label(已确认)')
    assert.equal(p.ok, false)
    if (!p.ok) assert.match(p.error, /不能识别的字符/)
  })

  it('括号未闭合', () => {
    const p = parseEntryCondition('(always')
    assert.equal(p.ok, false)
    if (!p.ok) assert.match(p.error, /括号/)
  })

  it('运算符后缺谓词', () => {
    const p = parseEntryCondition('always &&')
    assert.equal(p.ok, false)
    if (!p.ok) assert.match(p.error, /不完整/)
  })

  it('末尾多余 token', () => {
    const p = parseEntryCondition('always always')
    assert.equal(p.ok, false)
    if (!p.ok) assert.match(p.error, /多余/)
  })

  it('字符串未闭合', () => {
    const p = parseEntryCondition('has_label("已确认)')
    assert.equal(p.ok, false)
    if (!p.ok) assert.match(p.error, /没有闭合/)
  })

  it('has_comment_from 非法角色', () => {
    const p = parseEntryCondition('has_comment_from(robot)')
    assert.equal(p.ok, false)
    if (!p.ok) assert.match(p.error, /human、agent 或 system/)
  })

  it('priority_at_least 非法档', () => {
    const p = parseEntryCondition('priority_at_least(P9)')
    assert.equal(p.ok, false)
    if (!p.ok) assert.match(p.error, /P0、P1、P2 或 P3/)
  })
})

describe('各谓词真值', () => {
  it('always / !always', () => {
    assert.equal(ev('always'), true)
    assert.equal(ev('!always'), false)
    assert.equal(ev('always()'), true)
  })

  it('no_open_blockers', () => {
    assert.equal(ev('no_open_blockers'), true)
    assert.equal(ev('no_open_blockers', { hasOpenBlockers: true }), false)
  })

  it('has_body_section 只认 ATX 标题', () => {
    const body = ['前言', '## 复现步骤', '1. 打开页面', '### 期望', ''].join('\n')
    assert.equal(ev('has_body_section("复现步骤")', { body }), true)
    assert.equal(ev('has_body_section("期望")', { body }), true)
    assert.equal(ev('has_body_section("前言")', { body }), false)
    assert.equal(ev('has_body_section("复现步骤")', { body: '请补充复现步骤。' }), false)
    assert.equal(ev("has_body_section('复现步骤 ##')", { body: '## 复现步骤 ##\n' }), false)
    assert.equal(ev('has_body_section("复现步骤")', { body: '## 复现步骤 ##\n' }), true)
  })

  it('has_label', () => {
    assert.equal(ev('has_label("已确认")', { labels: ['已确认', 'P0'] }), true)
    assert.equal(ev('has_label("已确认")', { labels: ['待确认'] }), false)
  })

  it('has_comment_from', () => {
    assert.equal(ev('has_comment_from(human)', { commentAuthorKinds: ['human'] }), true)
    assert.equal(ev('has_comment_from("agent")', { commentAuthorKinds: ['human'] }), false)
    assert.equal(ev('has_comment_from(system)', { commentAuthorKinds: ['system', 'agent'] }), true)
  })

  it('priority_at_least:P0 最高', () => {
    assert.equal(ev('priority_at_least(P1)', { priority: 'P0' }), true)
    assert.equal(ev('priority_at_least(P1)', { priority: 'P1' }), true)
    assert.equal(ev('priority_at_least(P1)', { priority: 'P2' }), false)
    assert.equal(ev('priority_at_least(P3)', { priority: 'P2' }), true)
    assert.equal(ev('priority_at_least("P0")', { priority: 'P0' }), true)
  })

  it('last_run_succeeded', () => {
    assert.equal(ev('last_run_succeeded', { lastRunSucceeded: true }), true)
    assert.equal(ev('last_run_succeeded', { lastRunSucceeded: false }), false)
    assert.equal(ev('last_run_succeeded', { lastRunSucceeded: null }), false)
  })
})

describe('布尔组合与优先级', () => {
  it('&& 高于 ||', () => {
    // !always && always || always  =  (false && true) || true  = true
    assert.equal(ev('!always && always || always'), true)
    // always || !always && always  =  true || (false && true)  = true
    assert.equal(ev('always || !always && always'), true)
    // !always && always  = false
    assert.equal(ev('!always && always'), false)
  })

  it('括号改变结合', () => {
    assert.equal(ev('(always || !always) && !always'), false)
    assert.equal(ev('!(always && !always)'), true)
  })

  it('业务组合', () => {
    const ctx: Partial<EntryConditionContext> = {
      body: '## 复现步骤\n打开控制台\n',
      hasOpenBlockers: false,
      labels: ['已确认'],
      priority: 'P1',
    }
    assert.equal(
      ev('has_body_section("复现步骤") && no_open_blockers && has_label("已确认")', ctx),
      true,
    )
    assert.equal(
      ev('has_body_section("复现步骤") && no_open_blockers', { ...ctx, hasOpenBlockers: true }),
      false,
    )
    assert.equal(ev('has_label("已确认") || has_comment_from(human)', { labels: [] }), false)
    assert.equal(
      ev('has_label("已确认") || has_comment_from(human)', {
        labels: [],
        commentAuthorKinds: ['human'],
      }),
      true,
    )
  })
})
