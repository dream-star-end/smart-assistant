/**
 * Tests for {@link classifyRunError} — P1-3 流式错误分类。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/errorClassify.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { classifyRunError } from '../errorClassify.js'

describe('classifyRunError', () => {
  it('insufficient_credits: anthropicProxy 402 INSUFFICIENT_CREDITS', () => {
    const r = classifyRunError(
      '402 INSUFFICIENT_CREDITS: insufficient credits: balance=10 required=500',
    )
    assert.equal(r.code, 'insufficient_credits')
    assert.equal(r.message, '余额不足,请充值后继续')
  })

  it('insufficient_credits: 大小写无关', () => {
    const r = classifyRunError('insufficient credits, balance too low')
    assert.equal(r.code, 'insufficient_credits')
  })

  it('rate_limited: HTTP 429', () => {
    const r = classifyRunError('429 Too Many Requests from upstream')
    assert.equal(r.code, 'rate_limited')
  })

  it('rate_limited: RATE_LIMITED literal', () => {
    const r = classifyRunError('RATE_LIMITED: account quota exhausted')
    assert.equal(r.code, 'rate_limited')
  })

  it('upstream_failed: 502', () => {
    const r = classifyRunError('Anthropic returned 502 Bad Gateway')
    assert.equal(r.code, 'upstream_failed')
  })

  it('upstream_failed: ECONNRESET', () => {
    const r = classifyRunError('socket hang up: ECONNRESET')
    assert.equal(r.code, 'upstream_failed')
  })

  it('upstream_failed: ACCOUNT_POOL_BUSY', () => {
    const r = classifyRunError('ACCOUNT_POOL_BUSY: all accounts busy')
    assert.equal(r.code, 'upstream_failed')
  })

  it('unknown: 普通运行时错误', () => {
    const r = classifyRunError('TypeError: Cannot read property foo of undefined')
    assert.equal(r.code, 'unknown')
    assert.equal(r.message, '')
  })

  it('unknown: 空 / null / undefined', () => {
    assert.equal(classifyRunError('').code, 'unknown')
    assert.equal(classifyRunError(null).code, 'unknown')
    assert.equal(classifyRunError(undefined).code, 'unknown')
  })

  it('insufficient_credits 优先级高于 unknown', () => {
    // 同时包含的字符串以最先匹配的为准 —— PATTERNS 顺序定义优先级
    const r = classifyRunError('something something INSUFFICIENT_CREDITS something')
    assert.equal(r.code, 'insufficient_credits')
  })
})
