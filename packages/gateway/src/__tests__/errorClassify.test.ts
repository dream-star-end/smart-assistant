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
  it('model_config_changed_retry_turn: production model-authority 409', () => {
    const raw =
      'API Error: 409 {"error":{"code":"MODEL_CONFIG_CHANGED_RETRY_TURN","message":"model configuration changed, please retry in a new turn"},"request_id":"req-1"}'
    const r = classifyRunError(raw)
    assert.equal(r.code, 'model_config_changed_retry_turn')
    assert.equal(r.message, '模型配置已更新，请重发')
    assert.equal(
      classifyRunError(JSON.stringify({ subtype: 'success', result: raw })).code,
      'model_config_changed_retry_turn',
    )
  })

  it('model_config_changed_retry_turn: similar codes do not match', () => {
    const raw =
      'API Error: 409 {"error":{"code":"MODEL_CONFIG_CHANGED_RETRY_TURN_LATER","message":"different contract"}}'
    assert.equal(classifyRunError(raw).code, 'unknown')
  })

  it('insufficient_credits: anthropicProxy 402 INSUFFICIENT_CREDITS', () => {
    const r = classifyRunError(
      '402 INSUFFICIENT_CREDITS: insufficient credits: balance=10 required=500',
    )
    assert.equal(r.code, 'insufficient_credits')
    assert.equal(r.message, '积分已耗尽，请充值')
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

  it('context_too_long: Codex exact context exhaustion error', () => {
    const r = classifyRunError(
      "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
    )
    assert.equal(r.code, 'context_too_long')
    assert.equal(r.message, '上下文长度超过模型上限')
  })

  it('context_too_long: proxy PROMPT_TOO_LONG is provider-confirmed overflow', () => {
    const r = classifyRunError(
      'API Error: 413 {"error":{"code":"PROMPT_TOO_LONG","message":"Prompt exceeds the model context window"}}',
    )
    assert.equal(r.code, 'context_too_long')
  })

  it('context_too_long: CCB canonical prompt-too-long success envelope', () => {
    const raw = JSON.stringify({
      subtype: 'success',
      result: 'Prompt is too long',
    })
    const r = classifyRunError(raw)
    assert.equal(r.code, 'context_too_long')
    assert.equal(r.message, '上下文长度超过模型上限')
  })

  it('bad_request: generic upstream invalid request is not called an outage', () => {
    const apiError =
      'API Error: 400 {"error":{"code":"INVALID_REQUEST","message":"The upstream provider rejected this request"}}'
    for (const raw of [apiError, JSON.stringify({
      subtype: 'error_during_execution',
      result: apiError,
    })]) {
      const r = classifyRunError(raw)
      assert.equal(r.code, 'bad_request')
      assert.match(r.message, /无法被模型处理/)
    }
  })

  it('Cursor Sand Box transport fault is an upstream outage, not a bad request (INC-20260909-CURSOR-SAND-BOX-NOT-RUNNING)', () => {
    // Exact production terminal row (oc-v5-u3, trace b7ab039c, 2026-09-09T15:41:50Z):
    // the relay wraps every CursorSandBoxError as a 400 invalid_request_error with
    // the internal [non-retryable] marker so CCB's own request loop stops; the
    // gateway must still see transient infrastructure, not user content.
    const production =
      '{"subtype":"success","result":"API Error: 400 {\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"CURSOR_SAND_BOX_NOT_RUNNING [non-retryable]\\"}}"}'
    const r = classifyRunError(production)
    assert.equal(r.code, 'upstream_failed')
    assert.equal(r.message, classifiedMessageForCode('upstream_failed'))
    assert.doesNotMatch(r.message, /调整内容/)
    // Every other Box transport code that the relay can emit takes the same path.
    for (const code of [
      'NOT_RUNNING', 'NOT_READY', 'RELAY_NOT_READY', 'UPSTREAM_FAILED', 'STREAM_FAILED',
      'CONNECTION_REJECTED', 'CONTROL_UNAVAILABLE', 'CONTROL_FAILED', 'CONTROL_RESPONSE_INVALID',
      'CONTROL_RESPONSE_TOO_LARGE', 'DESCRIPTOR_INVALID', 'IDENTITY_MISMATCH', 'POLICY_INVALID',
      'POLICY_UNAVAILABLE', 'CANCELLED',
    ]) {
      const raw = `API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"CURSOR_SAND_BOX_${code} [non-retryable]"}}`
      assert.equal(classifyRunError(raw).code, 'upstream_failed', code)
      assert.equal(classifyDelegateOutputError(raw)?.code, 'upstream_failed', `delegate ${code}`)
    }
  })

  it('transient retry circuit-open marker classifies as capacity with switch-engine CTA copy', () => {
    const raw =
      'TRANSIENT_CIRCUIT_OPEN: 连续 3 次同类上游失败（upstream_failed），已停止自动重试。请切换引擎后再试。'
    const r = classifyRunError(raw)
    assert.equal(r.code, 'model_capacity')
    assert.match(r.message, /切换引擎/)
    assert.doesNotMatch(r.message, /请稍后重试$/)
  })

  it('Cursor Sand Box BUSY is model capacity (retry later or switch), not a bad request', () => {
    const raw =
      'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"CURSOR_SAND_BOX_BUSY [non-retryable]"}}'
    const r = classifyRunError(raw)
    assert.equal(r.code, 'model_capacity')
    assert.equal(r.message, classifiedMessageForCode('model_capacity'))
  })

  it('Cursor Sand Box INFERENCE_TICKET_REJECTED keeps its terminal classification (INC-20260909-CURSOR-SAND-BOX-TRANSPORT)', () => {
    // The ticket rejection is the account-level credential decision that the
    // Box transport incident locked as no-retry; the transport rule above must
    // not widen it into an auto-recovering outage.
    const raw =
      'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"CURSOR_SAND_BOX_INFERENCE_TICKET_REJECTED [non-retryable]"}}'
    const r = classifyRunError(raw)
    assert.notEqual(r.code, 'upstream_failed')
    assert.notEqual(r.code, 'model_capacity')
    assert.equal(r.code, 'bad_request')
  })

  it('generic 400 invalid request without a Box marker still stays bad_request', () => {
    // Guard the new rules' boundary: only the CURSOR_SAND_BOX_ prefix is a
    // transport fault; a 400 that merely mentions "sand" or "box" is not.
    assert.equal(
      classifyRunError('API Error: 400 {"error":{"code":"INVALID_REQUEST","message":"the sand box parameter is invalid"}}').code,
      'bad_request',
    )
    assert.equal(
      classifyRunError('API Error: 400 {"error":{"code":"INVALID_REQUEST","message":"CURSOR_SAND_NOT_A_BOX_CODE"}}').code,
      'bad_request',
    )
  })

  it('upstream_failed: 502', () => {
    const r = classifyRunError('Anthropic returned 502 Bad Gateway')
    assert.equal(r.code, 'upstream_failed')
  })

  it('upstream_failed: 通用 5xx(500/511/599,审计 R1 不再只认 50[234])', () => {
    // 审计 R1:`\b5\d{2}\b` 覆盖全部 5xx。逐个钉死此前会漏成 unknown 的码。
    assert.equal(classifyRunError('500 Internal Server Error').code, 'upstream_failed')
    assert.equal(classifyRunError('gateway said 511 Network Authentication Required').code, 'upstream_failed')
    assert.equal(classifyRunError('HTTP 599 from relay').code, 'upstream_failed')
  })

  it('upstream_failed: 边界不误伤嵌字词数字(审计 R1,与旧 \\b50[234]\\b 同量级)', () => {
    // "523ms" 里 3 与 m 之间无 \b → 不命中 5xx 档 → 保持 unknown(误伤面不扩大)。
    assert.equal(classifyRunError('request took 523ms then failed with TypeError').code, 'unknown')
  })

  it('upstream_failed: ECONNRESET', () => {
    const r = classifyRunError('socket hang up: ECONNRESET')
    assert.equal(r.code, 'upstream_failed')
  })

  it('upstream_failed: ECONNREFUSED / EAI_AGAIN(审计 R1 补网络错误)', () => {
    assert.equal(classifyRunError('connect ECONNREFUSED 127.0.0.1:443').code, 'upstream_failed')
    assert.equal(classifyRunError('getaddrinfo EAI_AGAIN api.anthropic.com').code, 'upstream_failed')
  })

  it('upstream_failed: ACCOUNT_POOL_BUSY', () => {
    // "all accounts busy" 里的 "busy" 不带前置 "model" → 不误判 model_capacity,
    // 仍归 upstream(词族边界回归)。
    const r = classifyRunError('ACCOUNT_POOL_BUSY: all accounts busy')
    assert.equal(r.code, 'upstream_failed')
  })

  it('auth_error: 401 / unauthorized / invalid api key / AUTH_ERROR 词族', () => {
    assert.equal(
      classifyRunError('API Error: 401 {"error":{"type":"authentication_error","message":"invalid x-api-key"}}').code,
      'auth_error',
    )
    assert.equal(classifyRunError('401 Unauthorized from upstream').code, 'auth_error')
    assert.equal(classifyRunError('invalid api key provided').code, 'auth_error')
    assert.equal(classifyRunError('AUTH_ERROR: credential rejected').code, 'auth_error')
    assert.equal(
      classifyRunError('invalid api key provided').message,
      classifiedMessageForCode('auth_error'),
    )
  })

  it('auth_error 词族刻意窄:511 Network Authentication Required 仍归 upstream', () => {
    assert.equal(
      classifyRunError('gateway said 511 Network Authentication Required').code,
      'upstream_failed',
    )
  })

  it('model_capacity: at capacity + try a different model', () => {
    const r = classifyRunError('Selected model is at capacity. Please try a different model.')
    assert.equal(r.code, 'model_capacity')
    assert.equal(r.message, '模型繁忙，请稍后重试或切换模型')
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

  it('裸 529 → model_capacity(审计 R1:Anthropic 529=overloaded,容量语义)', () => {
    // 审计 R1 改判:529 是 Anthropic overloaded 状态码,语义=容量满载(可重试/
    // 可换模型),故显式命中容量档(排在通用 5xx upstream 之前),不再落 unknown。
    assert.equal(classifyRunError('HTTP 529 returned by gateway').code, 'model_capacity')
    // 与词族命中同码时 message 一致。
    assert.equal(
      classifyRunError('HTTP 529 returned by gateway').message,
      classifiedMessageForCode('model_capacity'),
    )
  })

  it('classifiedMessageForCode 与 PATTERNS 同源(无平行文案表)', () => {
    assert.equal(classifiedMessageForCode('model_capacity'), '模型繁忙，请稍后重试或切换模型')
    assert.equal(classifiedMessageForCode('rate_limited'), '当前账号被限流，请稍后再试')
    assert.equal(classifiedMessageForCode('insufficient_credits'), '积分已耗尽，请充值')
    // 不绑定具体厂商(E7):同一分类被 CCB/Codex/多提供商路径共用。
    assert.equal(classifiedMessageForCode('upstream_failed'), '模型服务上游暂时异常，请稍后重试')
    assert.equal(classifiedMessageForCode('auth_error'), '模型服务认证失败，请重新登录或检查凭据后重试')
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
    assert.equal(r.message, '积分已耗尽，请充值')
  })

  it('delegate output: API Error 400 BAD_BODY is treated as bad_request', () => {
    const r = classifyDelegateOutputError(
      'API Error: 400 {"error":{"code":"BAD_BODY","message":"invalid request body"}}',
    )
    assert.ok(r)
    assert.equal(r.code, 'bad_request')
    assert.equal(r.message, '子 agent 请求体无效，请降低思考深度或稍后重试')
  })

  it('delegate output: ordinary prose mentioning API Error is not classified', () => {
    assert.equal(classifyDelegateOutputError('请在文档里解释 API Error 这个概念'), null)
  })
})
