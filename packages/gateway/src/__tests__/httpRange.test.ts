import * as assert from 'node:assert/strict'
/**
 * Tests for httpRange.parseByteRange — 容器下载 Range(断点续传)解析纯函数。
 * 锁死边界:单段合法/收敛、suffix 形式、越界/倒置/非法/多段/空文件 → null。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/httpRange.test.ts
 */
import { describe, it } from 'node:test'
import { parseByteRange } from '../httpRange.js'

const SIZE = 1000

describe('parseByteRange — 合法单段', () => {
  it('bytes=start-end 闭区间', () => {
    assert.deepEqual(parseByteRange('bytes=0-499', SIZE), { start: 0, end: 499 })
    assert.deepEqual(parseByteRange('bytes=500-999', SIZE), { start: 500, end: 999 })
    assert.deepEqual(parseByteRange('bytes=200-200', SIZE), { start: 200, end: 200 })
  })

  it('bytes=start- 到文件末尾', () => {
    assert.deepEqual(parseByteRange('bytes=500-', SIZE), { start: 500, end: 999 })
    assert.deepEqual(parseByteRange('bytes=0-', SIZE), { start: 0, end: 999 })
  })

  it('bytes=-suffix 末尾 N 字节', () => {
    assert.deepEqual(parseByteRange('bytes=-500', SIZE), { start: 500, end: 999 })
    assert.deepEqual(parseByteRange('bytes=-1', SIZE), { start: 999, end: 999 })
  })

  it('end 超过文件末尾 → 收敛到 size-1', () => {
    assert.deepEqual(parseByteRange('bytes=900-5000', SIZE), { start: 900, end: 999 })
  })

  it('suffix >= size → 整段', () => {
    assert.deepEqual(parseByteRange('bytes=-1000', SIZE), { start: 0, end: 999 })
    assert.deepEqual(parseByteRange('bytes=-99999', SIZE), { start: 0, end: 999 })
  })

  it('单位大小写不敏感 + 前后空白容忍', () => {
    assert.deepEqual(parseByteRange('BYTES=0-9', SIZE), { start: 0, end: 9 })
    assert.deepEqual(parseByteRange('  bytes=0-9  ', SIZE), { start: 0, end: 9 })
  })
})

describe('parseByteRange — 退回全量(null)', () => {
  it('缺省 / 空 / 非字符串', () => {
    assert.equal(parseByteRange(undefined, SIZE), null)
    assert.equal(parseByteRange(null, SIZE), null)
    assert.equal(parseByteRange('', SIZE), null)
    assert.equal(parseByteRange('   ', SIZE), null)
  })

  it('非 bytes 单位 / 缺 =', () => {
    assert.equal(parseByteRange('items=0-10', SIZE), null)
    assert.equal(parseByteRange('bytes 0-10', SIZE), null)
    assert.equal(parseByteRange('0-10', SIZE), null)
  })

  it('多段(逗号)不支持', () => {
    assert.equal(parseByteRange('bytes=0-99,200-299', SIZE), null)
    assert.equal(parseByteRange('bytes=0-99, 200-', SIZE), null)
  })

  it('语法非法 / 非数字 / 负数 / 缺 dash', () => {
    assert.equal(parseByteRange('bytes=', SIZE), null)
    assert.equal(parseByteRange('bytes=-', SIZE), null)
    assert.equal(parseByteRange('bytes=abc-def', SIZE), null)
    assert.equal(parseByteRange('bytes=10', SIZE), null)
    assert.equal(parseByteRange('bytes=1.5-9', SIZE), null)
    assert.equal(parseByteRange('bytes=-1.5', SIZE), null)
    assert.equal(parseByteRange('bytes=-5-10', SIZE), null) // 解析成 suffix '5-10' → 非纯数字
  })

  it('bytes=-0 suffix 为 0 不可满足', () => {
    assert.equal(parseByteRange('bytes=-0', SIZE), null)
  })

  it('start 越界(>= size)', () => {
    assert.equal(parseByteRange('bytes=1000-1100', SIZE), null)
    assert.equal(parseByteRange('bytes=1500-', SIZE), null)
  })

  it('区间倒置 start > end', () => {
    assert.equal(parseByteRange('bytes=500-200', SIZE), null)
  })

  it('空文件 / 非法 size 任何 Range → null', () => {
    assert.equal(parseByteRange('bytes=0-10', 0), null)
    assert.equal(parseByteRange('bytes=-5', 0), null)
    assert.equal(parseByteRange('bytes=0-', Number.NaN), null)
  })
})
