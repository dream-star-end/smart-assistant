/**
 * Tests for {@link classifyRunError} — P1-3 流式错误分类。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/errorClassify.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  classifiedMessageForCode,
  classifyDelegateOutputError,
  classifyRunError,
} from '../errorClassify.js'

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
    // "all accounts busy" 里的 "busy" 不带前置 "model" → 不误判 model_capacity,
    // 仍归 upstream(词族边界回归)。
    const r = classifyRunError('ACCOUNT_POOL_BUSY: all accounts busy')
    assert.equal(r.code, 'upstream_failed')
  })

  it('model_capacity: at capacity + try a different model', () => {
    const r = classifyRunError('Selected model is at capacity. Please try a different model.')
    assert.equal(r.code, 'model_capacity')
    assert.equal(r.message, '模型繁忙,请稍后重试或切换模型')
  })

  it('model_capacity: overloaded', () => {
    assert.equal(classifyRunError('model is overloaded').code, 'model_capacity')
  })

  it('model_capacity: model ... busy', () => {
    assert.equal(
      classifyRunError('The model is currently busy, retry shortly').code,
      'model_capacity',
    )
  })

  it('model_capacity: capacity limit exceeded', () => {
    assert.equal(classifyRunError('capacity limit exceeded for this deployment').code, 'model_capacity')
  })

  it('model_capacity 优先于 upstream:529 Overloaded', () => {
    // Anthropic 529 "Overloaded" 串含 overloaded → 命中容量档(排在 upstream 之前)。
    assert.equal(
      classifyRunError('529 {"type":"error","error":{"type":"overloaded_error"}}').code,
      'model_capacity',
    )
  })

  it('现状钉死:裸 529(无容量词/无 50[234])→ unknown', () => {
    // 任务备注对 529 归类不确定;此处钉死真实现状:529 既不在 rate(429)也不在
    // upstream(50[234])正则,且无容量词 → unknown(caller 压成 upstream_failed 发帧)。
    assert.equal(classifyRunError('HTTP 529 returned by gateway').code, 'unknown')
  })

  it('classifiedMessageForCode 与 PATTERNS 同源(无平行文案表)', () => {
    assert.equal(classifiedMessageForCode('model_capacity'), '模型繁忙,请稍后重试或切换模型')
    assert.equal(classifiedMessageForCode('rate_limited'), '当前账号被限流,请稍后再试')
    assert.equal(classifiedMessageForCode('insufficient_credits'), '余额不足,请充值后继续')
    assert.equal(classifiedMessageForCode('upstream_failed'), 'Anthropic 上游异常,请稍后重试')
    // classifyRunError 命中同码时,message 与 classifiedMessageForCode 完全一致。
    assert.equal(
      classifyRunError('model is overloaded').message,
      classifiedMessageForCode('model_capacity'),
    )
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

  it('delegate output: API Error 402 is treated as a failed delegation', () => {
    const r = classifyDelegateOutputError(
      'API Error: 402 {"error":{"code":"INSUFFICIENT_CREDITS","message":"insufficient credits: balance=284 required=293"}}',
    )
    assert.ok(r)
    assert.equal(r.code, 'insufficient_credits')
    assert.equal(r.message, '余额不足,请充值后继续')
  })

  it('delegate output: API Error 400 BAD_BODY is treated as bad_request', () => {
    const r = classifyDelegateOutputError(
      'API Error: 400 {"error":{"code":"BAD_BODY","message":"invalid request body"}}',
    )
    assert.ok(r)
    assert.equal(r.code, 'bad_request')
    assert.equal(r.message, '子 agent 请求体无效,请降低思考深度或稍后重试')
  })

  it('delegate output: ordinary prose mentioning API Error is not classified', () => {
    assert.equal(classifyDelegateOutputError('请在文档里解释 API Error 这个概念'), null)
  })
})
