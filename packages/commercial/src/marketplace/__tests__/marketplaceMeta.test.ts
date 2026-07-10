/**
 * 单测(无 DB):人向商品层元数据校验权威 marketplaceMeta.parseHumanMeta 的边界。
 * 两条发布路由都靠它做唯一校验,故在这里锁死约束(category 必填 ∈ 枚举 / useCases 1-4 条
 * 每条 4-120 / outcomes 0-4 条 ≤200 空行丢弃 / humanMd ≤16384)。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  HUMAN_MD_MAX,
  HumanMetaError,
  humanMetaScanBody,
  parseHumanMeta,
} from '../marketplaceMeta.js'

/** 一份合法的最小 body(仅必填项)。 */
function ok(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { category: 'office-docs', useCases: ['写周报月报'], ...over }
}

function expectCode(body: Record<string, unknown>, code: string): void {
  assert.throws(
    () => parseHumanMeta(body),
    (e: unknown) => {
      assert.ok(e instanceof HumanMetaError, `expected HumanMetaError, got ${e}`)
      assert.equal(e.code, code)
      return true
    },
  )
}

// ── category ──
test('category:合法枚举通过;缺失/未知/非串 → BAD_CATEGORY', () => {
  assert.equal(parseHumanMeta(ok()).category, 'office-docs')
  expectCode(ok({ category: undefined }), 'BAD_CATEGORY')
  expectCode(ok({ category: 'nope' }), 'BAD_CATEGORY')
  expectCode(ok({ category: 123 }), 'BAD_CATEGORY')
})

// ── useCases ──
test('useCases:1-4 条、每条 4-120 字符,trim 后回填', () => {
  const m = parseHumanMeta(ok({ useCases: ['  写周报月报  ', '做汇报 PPT'] }))
  assert.deepEqual(m.useCases, ['写周报月报', '做汇报 PPT'])
})

test('useCases:缺失/空数组/非数组 → BAD_USE_CASES', () => {
  expectCode(ok({ useCases: undefined }), 'BAD_USE_CASES')
  expectCode(ok({ useCases: [] }), 'BAD_USE_CASES')
  expectCode(ok({ useCases: '写周报' }), 'BAD_USE_CASES')
})

test('useCases:过短(<4)/过长(>120)/超 4 条 → BAD_USE_CASES', () => {
  expectCode(ok({ useCases: ['abc'] }), 'BAD_USE_CASES') // trim 后 3 字符
  expectCode(ok({ useCases: ['x'.repeat(121)] }), 'BAD_USE_CASES')
  expectCode(ok({ useCases: ['用例一二', '用例三四', '用例五六', '用例七八', '用例九十'] }), 'BAD_USE_CASES')
  expectCode(ok({ useCases: ['正常用例', 42] }), 'BAD_USE_CASES')
})

// ── outcomeExamples ──
test('outcomeExamples:选填,缺省 → [];空行丢弃;trim 回填', () => {
  assert.deepEqual(parseHumanMeta(ok()).outcomeExamples, [])
  const m = parseHumanMeta(ok({ outcomeExamples: ['  给它要点→得到周报  ', '   ', ''] }))
  assert.deepEqual(m.outcomeExamples, ['给它要点→得到周报'])
})

test('outcomeExamples:>200 字符/超 4 条/非数组 → BAD_OUTCOMES', () => {
  expectCode(ok({ outcomeExamples: ['x'.repeat(201)] }), 'BAD_OUTCOMES')
  expectCode(ok({ outcomeExamples: ['a', 'b', 'c', 'd', 'e'] }), 'BAD_OUTCOMES')
  expectCode(ok({ outcomeExamples: '不是数组' }), 'BAD_OUTCOMES')
})

// ── humanMd ──
test('humanMd:选填,缺省/空白 → null;正常回填 trim', () => {
  assert.equal(parseHumanMeta(ok()).humanMd, null)
  assert.equal(parseHumanMeta(ok({ humanMd: '   ' })).humanMd, null)
  assert.equal(parseHumanMeta(ok({ humanMd: '  ## 亮点  ' })).humanMd, '## 亮点')
})

test('humanMd:超上限/非串 → BAD_HUMAN_MD', () => {
  expectCode(ok({ humanMd: 'x'.repeat(HUMAN_MD_MAX + 1) }), 'BAD_HUMAN_MD')
  expectCode(ok({ humanMd: 12345 }), 'BAD_HUMAN_MD')
})

// ── humanMetaScanBody ──
test('humanMetaScanBody:拼接用例+效果+富介绍供扫描(category 不进)', () => {
  const meta = parseHumanMeta(
    ok({ useCases: ['写周报月报'], outcomeExamples: ['得到周报'], humanMd: '内网 http://10.0.0.1' }),
  )
  const body = humanMetaScanBody(meta)
  assert.ok(body.includes('写周报月报'))
  assert.ok(body.includes('得到周报'))
  assert.ok(body.includes('10.0.0.1'))
  assert.ok(!body.includes('office-docs')) // category 是枚举 id,不进扫描文本
})
