/**
 * connectors/canonicalJson 单测(无 DB):
 *   - 跨键序稳定(§11:canonical 跨键序稳定)
 *   - 嵌套/数组/unicode/数字边界
 *   - 拒绝 NaN/Infinity/undefined(顶层)/bigint/函数/循环/非 plain object
 *   - hash 与 digest 的确定性
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  CANONICALIZATION_VERSION,
  CanonicalJsonError,
  canonicalDigestHex,
  canonicalHash,
  canonicalStringify,
} from '../connectors/canonicalJson.js'

describe('canonicalStringify', () => {
  test('键排序:不同插入序 → 同一输出', () => {
    const a = { b: 1, a: 2, c: { z: 1, y: 2 } }
    const b = { c: { y: 2, z: 1 }, a: 2, b: 1 }
    assert.equal(canonicalStringify(a), canonicalStringify(b))
    assert.equal(canonicalStringify(a), '{"a":2,"b":1,"c":{"y":2,"z":1}}')
  })

  test('数组保序,不排序', () => {
    assert.equal(canonicalStringify([3, 1, 2]), '[3,1,2]')
  })

  test('unicode 中文/emoji 稳定', () => {
    const s = canonicalStringify({ 标题: '你好🌍', b: 'ascii' })
    assert.equal(s, JSON.parse(JSON.stringify(s)) as string) // 自洽
    assert.ok(s.includes('你好🌍'))
  })

  test('-0 归一化为 0;整数/小数走 JSON 短表示', () => {
    assert.equal(canonicalStringify({ a: -0, b: 1.5 }), '{"a":0,"b":1.5}')
  })

  test('object 内 undefined 属性省略(与 JSON.stringify 对齐)', () => {
    assert.equal(canonicalStringify({ a: 1, b: undefined }), '{"a":1}')
  })

  test('拒绝 NaN / Infinity', () => {
    assert.throws(() => canonicalStringify({ a: Number.NaN }), CanonicalJsonError)
    assert.throws(() => canonicalStringify({ a: Number.POSITIVE_INFINITY }), CanonicalJsonError)
  })

  test('拒绝 bigint / function / 顶层 undefined', () => {
    assert.throws(() => canonicalStringify(10n), CanonicalJsonError)
    assert.throws(() => canonicalStringify({ f: () => 1 }), CanonicalJsonError)
    assert.throws(() => canonicalStringify(undefined), CanonicalJsonError)
  })

  test('拒绝循环引用', () => {
    const a: Record<string, unknown> = {}
    a.self = a
    assert.throws(() => canonicalStringify(a), CanonicalJsonError)
  })

  test('拒绝非 plain object(Date/Map/Buffer)', () => {
    assert.throws(() => canonicalStringify({ d: new Date() }), CanonicalJsonError)
    assert.throws(() => canonicalStringify({ m: new Map() }), CanonicalJsonError)
    assert.throws(() => canonicalStringify({ b: Buffer.from('x') }), CanonicalJsonError)
  })

  test('同值重复引用(非循环)允许', () => {
    const shared = { x: 1 }
    assert.equal(canonicalStringify({ a: shared, b: shared }), '{"a":{"x":1},"b":{"x":1}}')
  })
})

describe('canonicalHash / digest', () => {
  test('hash = 32 字节;跨键序一致;不同值不同 hash', () => {
    const h1 = canonicalHash({ a: 1, b: 2 })
    const h2 = canonicalHash({ b: 2, a: 1 })
    const h3 = canonicalHash({ a: 1, b: 3 })
    assert.equal(h1.length, 32)
    assert.ok(h1.equals(h2))
    assert.ok(!h1.equals(h3))
  })

  test('digest hex 64 字符', () => {
    assert.match(canonicalDigestHex({ a: 1 }), /^[0-9a-f]{64}$/)
  })

  test('canonicalization version 钉在 1(bump 需保留 v1 实现)', () => {
    assert.equal(CANONICALIZATION_VERSION, 1)
  })
})
