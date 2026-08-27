import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { WEIBO_WRITE_FAILURE_CODES } from './weiboWriteObservability.js'
import {
  PLUGIN_PASSTHROUGH_ERROR_CODES,
  connectorRpcErrorEnvelope,
  connectorRpcReplayEnvelope,
  isPluginPassthroughErrorCode,
  resolvePluginErrorGuidance,
  weiboRuntimePublicMessage,
} from './pluginErrorGuidance.js'

const REQUIRED = [
  'WEIBO_ACTION_FAILED',
  'LOGIN_EXPIRED_ACCOUNT',
  'PRECONDITION_CHANGED',
  'UPSTREAM_FAILED',
  'WEIBO_WRITE_MEDIA_UPLOAD',
  'WEIBO_WRITE_MEDIA_CHOOSER',
  'WEIBO_WRITE_MEDIA',
  'WEIBO_WRITE_MEDIA_PREVIEW',
  'WEIBO_WRITE_MEDIA_PREVIEW_TIMEOUT',
  'WEIBO_WRITE_COMPOSER',
  'WEIBO_WRITE_COMPOSER_EDITOR',
  'WEIBO_WRITE_COMPOSER_READBACK',
  'WEIBO_WRITE_COMPOSER_LONGTEXT',
  'WEIBO_WRITE_SEND',
  'WEIBO_WRITE_SEND_BUTTON',
  'WEIBO_WRITE_SEND_CLICK',
  'WEIBO_WRITE_SEND_UNCLEARED',
  'WEIBO_WRITE_RESULT',
  'WEIBO_WORKER_BUSY',
  'WEIBO_WORKER_DEADLINE',
  'WEIBO_WORKER_INCOMPLETE',
  'EXECUTION_FAILED',
  'CAPACITY_EXCEEDED',
  'UNAVAILABLE',
  'IMAGE_MISMATCH',
  'PROTOCOL',
  'CLEANUP_FAILED',
  'CLOSING',
  'PLUGIN_RUNTIME_UNAVAILABLE',
  'PLUGIN_SETUP_FAILED',
  'NOT_INSTALLED',
  'SETUP_ACTIVE',
  'ACCOUNT_ALREADY_EXISTS',
  'SETUP_NOT_FOUND',
  'QR_NOT_READY',
  'TERMS_REQUIRED',
  'CONNECTION_ERROR',
  'RELINK_REQUIRED',
] as const

describe('plugin error guidance table', () => {
  test('covers every listed public Weibo / setup / read / write code', () => {
    for (const code of REQUIRED) {
      const g = resolvePluginErrorGuidance({ code })
      assert.equal(typeof g.message, 'string')
      assert.notEqual(g.message, 'Weibo action failed')
      assert.notEqual(g.message, code)
      assert.match(g.message, /./)
      assert.match(g.nextAction, /[\u4e00-\u9fff]/)
      assert.equal(['yes', 'no', 'after_reauth', 'check_first'].includes(g.retrySafe), true)
      assert.equal(typeof g.requiresReauth, 'boolean')
      assert.equal(['none', 'possible', 'likely'].includes(g.sideEffect), true)
    }
  })

  test('every write-failure protocol code is in the passthrough whitelist', () => {
    for (const code of WEIBO_WRITE_FAILURE_CODES) {
      assert.equal(isPluginPassthroughErrorCode(code), true, code)
    }
    assert.equal(isPluginPassthroughErrorCode('LOGIN_EXPIRED_ACCOUNT'), true)
    assert.equal(isPluginPassthroughErrorCode('PRECONDITION_CHANGED'), true)
    assert.equal(isPluginPassthroughErrorCode('WEATHER_FORECAST'), false)
    assert.equal(PLUGIN_PASSTHROUGH_ERROR_CODES.includes('WEIBO_ACTION_FAILED'), true)
  })

  test('LOGIN_EXPIRED_ACCOUNT tells the agent to rescan and is not retry-safe', () => {
    const g = resolvePluginErrorGuidance({ code: 'LOGIN_EXPIRED_ACCOUNT' })
    assert.equal(g.requiresReauth, true)
    assert.equal(g.retrySafe, 'after_reauth')
    assert.equal(g.sideEffect, 'none')
    assert.match(g.nextAction, /重新扫码/)
  })

  test('WEIBO_ACTION_FAILED is not swallowed as a generic connection error', () => {
    const g = resolvePluginErrorGuidance({ code: 'WEIBO_ACTION_FAILED' })
    assert.equal(g.retrySafe, 'after_reauth')
    assert.equal(g.requiresReauth, false)
    assert.equal(g.sideEffect, 'none')
    assert.match(g.nextAction, /重新扫码/)
    assert.notEqual(weiboRuntimePublicMessage('WEIBO_ACTION_FAILED'), 'Weibo action failed')
  })

  test('WEIBO_WRITE_MEDIA_UPLOAD tells the agent the image path is unavailable', () => {
    const failed = resolvePluginErrorGuidance({
      code: 'WEIBO_WRITE_MEDIA_UPLOAD',
      status: 'failed',
    })
    assert.equal(failed.retrySafe, 'no')
    assert.equal(failed.sideEffect, 'none')
    assert.match(failed.message, /图片上传/)
    assert.match(failed.nextAction, /纯文字/)
    assert.doesNotMatch(failed.nextAction, /list_user_posts/)

    const unknown = resolvePluginErrorGuidance({
      code: 'WEIBO_WRITE_MEDIA_UPLOAD',
      status: 'unknown',
    })
    assert.equal(unknown.sideEffect, 'possible')
    assert.equal(unknown.retrySafe, 'no')
    assert.match(unknown.nextAction, /纯文字/)
    assert.match(unknown.nextAction, /list_user_posts/)

    const narrowed = resolvePluginErrorGuidance({
      code: 'WEIBO_WRITE_MEDIA_UPLOAD',
      status: 'unknown',
      attempted: false,
      pids: 0,
    })
    assert.equal(narrowed.sideEffect, 'none')
    assert.match(narrowed.nextAction, /纯文字/)
  })

  test('unknown send/result is likely and check_first; failed send is none', () => {
    const sendUnknown = resolvePluginErrorGuidance({
      code: 'WEIBO_WRITE_SEND_CLICK',
      status: 'unknown',
    })
    assert.equal(sendUnknown.sideEffect, 'likely')
    assert.equal(sendUnknown.retrySafe, 'check_first')
    assert.match(sendUnknown.nextAction, /list_user_posts/)

    const sendFailed = resolvePluginErrorGuidance({
      code: 'WEIBO_WRITE_SEND_CLICK',
      status: 'failed',
    })
    assert.equal(sendFailed.sideEffect, 'none')

    const resultUnknown = resolvePluginErrorGuidance({
      code: 'WEIBO_WRITE_RESULT',
      status: 'unknown',
    })
    assert.equal(resultUnknown.sideEffect, 'likely')
    assert.equal(resultUnknown.retrySafe, 'check_first')
  })

  test('PRECONDITION_CHANGED is proven not sent', () => {
    const g = resolvePluginErrorGuidance({
      code: 'PRECONDITION_CHANGED',
      status: 'unknown',
    })
    assert.equal(g.sideEffect, 'none')
    assert.equal(g.retrySafe, 'no')
    assert.match(g.nextAction, /未发送/)
  })

  test('UPSTREAM_FAILED is captcha and must not auto-retry', () => {
    const g = resolvePluginErrorGuidance({ code: 'UPSTREAM_FAILED' })
    assert.equal(g.retrySafe, 'no')
    assert.equal(g.requiresReauth, false)
    assert.match(g.nextAction, /验证/)
  })

  test('setup 503 stays generic and does not leak pin/hash details', () => {
    const g = resolvePluginErrorGuidance({ code: 'PLUGIN_RUNTIME_UNAVAILABLE' })
    assert.equal(g.retrySafe, 'yes')
    assert.match(g.nextAction, /管理员/)
    assert.doesNotMatch(g.message, /pin|hash|mismatch|DNS/i)
    assert.doesNotMatch(g.nextAction, /pin|hash|mismatch|DNS/i)
  })

  test('CAPACITY_EXCEEDED is retryable with no side effect', () => {
    const g = resolvePluginErrorGuidance({ code: 'CAPACITY_EXCEEDED' })
    assert.equal(g.retrySafe, 'yes')
    assert.equal(g.sideEffect, 'none')
    assert.match(g.nextAction, /稍后/)
  })

  test('RPC envelopes are additive and keep the original code', () => {
    const error = connectorRpcErrorEnvelope('WEIBO_ACTION_FAILED')
    assert.equal(error.kind, 'error')
    assert.equal(error.code, 'WEIBO_ACTION_FAILED')
    assert.equal(error.retrySafe, 'after_reauth')
    assert.match(error.nextAction, /重新扫码/)

    const replay = connectorRpcReplayEnvelope({
      status: 'unknown',
      errorCode: 'WEIBO_WRITE_MEDIA_UPLOAD',
      resultDigest: null,
    })
    assert.equal(replay.kind, 'replay')
    assert.equal(replay.status, 'unknown')
    assert.equal(replay.errorCode, 'WEIBO_WRITE_MEDIA_UPLOAD')
    assert.equal(replay.sideEffect, 'possible')
    assert.match(String(replay.nextAction), /纯文字/)
  })

  test('unknown codes keep a conservative default and are not passthrough', () => {
    assert.equal(isPluginPassthroughErrorCode('TOTALLY_NEW_CODE'), false)
    const g = resolvePluginErrorGuidance({ code: 'TOTALLY_NEW_CODE' })
    assert.equal(g.retrySafe, 'no')
    assert.equal(g.requiresReauth, false)
    assert.equal(g.sideEffect, 'none')
    assert.match(g.nextAction, /[\u4e00-\u9fff]/)
  })
})
