import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { WEIBO_WRITE_FAILURE_CODES } from './weiboWriteObservability.js'
import {
  PLUGIN_PASSTHROUGH_ERROR_CODES,
  UNKNOWN_WRITE_NEXT_ACTION,
  connectorRpcErrorEnvelope,
  connectorRpcReplayEnvelope,
  isPluginPassthroughErrorCode,
  resolvePluginErrorGuidance,
  weiboRuntimePublicMessage,
  type PluginRetrySafe,
  type PluginSideEffect,
} from './pluginErrorGuidance.js'

type Exact = {
  retrySafe: PluginRetrySafe
  requiresReauth: boolean
  sideEffect: PluginSideEffect
  nextAction: string
  message?: string
}

function assertExact(code: string, extra: { status?: string }, expected: Exact): void {
  const g = resolvePluginErrorGuidance({ code, ...extra })
  assert.equal(g.retrySafe, expected.retrySafe, `${code} ${extra.status ?? 'read'} retrySafe`)
  assert.equal(
    g.requiresReauth,
    expected.requiresReauth,
    `${code} ${extra.status ?? 'read'} requiresReauth`,
  )
  assert.equal(g.sideEffect, expected.sideEffect, `${code} ${extra.status ?? 'read'} sideEffect`)
  assert.equal(g.nextAction, expected.nextAction, `${code} ${extra.status ?? 'read'} nextAction`)
  if (expected.message !== undefined) {
    assert.equal(g.message, expected.message, `${code} message`)
  }
  assert.notEqual(g.message, 'Weibo action failed')
  assert.notEqual(g.message, code)
}

const WRITE_OUTCOME_CODES = [
  ...WEIBO_WRITE_FAILURE_CODES,
  'EXECUTION_FAILED',
  'PROTOCOL',
  'CLEANUP_FAILED',
  'UNAVAILABLE',
  'IMAGE_MISMATCH',
  'CLOSING',
  'CAPACITY_EXCEEDED',
  'LOGIN_EXPIRED_ACCOUNT',
] as const

const FAILED_RETRY: Record<(typeof WRITE_OUTCOME_CODES)[number], PluginRetrySafe> = {
  WEIBO_WRITE_MEDIA: 'no',
  WEIBO_WRITE_MEDIA_CHOOSER: 'no',
  WEIBO_WRITE_MEDIA_UPLOAD: 'no',
  WEIBO_WRITE_MEDIA_PREVIEW: 'no',
  WEIBO_WRITE_MEDIA_PREVIEW_TIMEOUT: 'no',
  WEIBO_WRITE_COMPOSER: 'no',
  WEIBO_WRITE_COMPOSER_EDITOR: 'no',
  WEIBO_WRITE_COMPOSER_READBACK: 'no',
  WEIBO_WRITE_COMPOSER_LONGTEXT: 'no',
  WEIBO_WRITE_SEND: 'no',
  WEIBO_WRITE_SEND_BUTTON: 'no',
  WEIBO_WRITE_SEND_CLICK: 'no',
  WEIBO_WRITE_SEND_UNCLEARED: 'no',
  WEIBO_WRITE_RESULT: 'no',
  WEIBO_WORKER_BUSY: 'yes',
  WEIBO_WORKER_DEADLINE: 'yes',
  WEIBO_WORKER_INCOMPLETE: 'yes',
  WEIBO_ACTION_FAILED: 'after_reauth',
  UPSTREAM_FAILED: 'no',
  EXECUTION_FAILED: 'no',
  PROTOCOL: 'yes',
  CLEANUP_FAILED: 'yes',
  UNAVAILABLE: 'yes',
  IMAGE_MISMATCH: 'yes',
  CLOSING: 'yes',
  CAPACITY_EXCEEDED: 'yes',
  LOGIN_EXPIRED_ACCOUNT: 'after_reauth',
}

const FAILED_NEXT: Record<(typeof WRITE_OUTCOME_CODES)[number], string> = {
  WEIBO_WRITE_MEDIA: '配图未完成。可改纯文字发布，不要重放同一条确认卡',
  WEIBO_WRITE_MEDIA_CHOOSER: '图片控件未就绪。可改纯文字发布，或稍后重开一条新确认',
  WEIBO_WRITE_MEDIA_UPLOAD: '商业版图片上传链路当前不可用，请改纯文字发布；不要重放同一条确认卡',
  WEIBO_WRITE_MEDIA_PREVIEW: '图片可能未进入编辑器。可改纯文字发布',
  WEIBO_WRITE_MEDIA_PREVIEW_TIMEOUT: '图片预览超时。可改纯文字发布，不要重放同一条确认卡',
  WEIBO_WRITE_COMPOSER: '正文未发出。可稍后重开一条新确认，不要重放同一 confirmId',
  WEIBO_WRITE_COMPOSER_EDITOR: '正文未发出。可稍后重开一条新确认',
  WEIBO_WRITE_COMPOSER_READBACK: '正文未发出。请检查文案后重开一条新确认',
  WEIBO_WRITE_COMPOSER_LONGTEXT: '长文未发出。可缩短文案后重开一条新确认',
  WEIBO_WRITE_SEND: '发送未执行。可重开一条新确认',
  WEIBO_WRITE_SEND_BUTTON: '发送未执行。可重开一条新确认',
  WEIBO_WRITE_SEND_CLICK: '发送未执行。可重开一条新确认',
  WEIBO_WRITE_SEND_UNCLEARED: '发送未执行。可重开一条新确认',
  WEIBO_WRITE_RESULT: '发送未执行。可重开一条新确认',
  WEIBO_WORKER_BUSY: '请稍后重试；本次未发送',
  WEIBO_WORKER_DEADLINE: '超时发生在发送前，可稍后重试',
  WEIBO_WORKER_INCOMPLETE: '工作器未完成且未发送，可稍后重试',
  WEIBO_ACTION_FAILED:
    '可再试一次读操作确认；若仍失败，引导用户重新扫码授权微博（设置里可能仍显示已授权）',
  UPSTREAM_FAILED: '请用户本人在浏览器完成验证后再试，不要自动重试',
  EXECUTION_FAILED: '执行失败且未发送。请检查参数后重开，不要无依据重试同一确认卡',
  PROTOCOL: '协议异常且未发送，请稍后重试',
  CLEANUP_FAILED: '平台清理异常。请稍后重试',
  UNAVAILABLE: '请稍后重试；若持续失败请联系管理员',
  IMAGE_MISMATCH: '平台故障，请稍后重试或联系管理员',
  CLOSING: '请稍后重试',
  CAPACITY_EXCEEDED: '请稍后重试，本次未发送',
  LOGIN_EXPIRED_ACCOUNT: '引导用户重新扫码授权微博',
}

const UNKNOWN_PREFIX: Partial<Record<(typeof WRITE_OUTCOME_CODES)[number], string>> = {
  WEIBO_WRITE_MEDIA_UPLOAD:
    '商业版图片上传链路当前不可用，建议改纯文字发布；不要重放同一条确认卡。',
  WEIBO_ACTION_FAILED: '写操作结果不明，不要重新授权后直接重发。',
  LOGIN_EXPIRED_ACCOUNT: '授权可能已失效且写结果不明。',
  UPSTREAM_FAILED: '验证码出现前可能已有写副作用。',
  WEIBO_WRITE_SEND: '可能已点发送。',
  WEIBO_WRITE_SEND_BUTTON: '可能已点发送。',
  WEIBO_WRITE_SEND_CLICK: '可能已点发送。',
  WEIBO_WRITE_SEND_UNCLEARED: '可能已点发送。',
  WEIBO_WRITE_RESULT: '可能已点发送。',
}

const SEND_OR_RESULT = new Set([
  'WEIBO_WRITE_SEND',
  'WEIBO_WRITE_SEND_BUTTON',
  'WEIBO_WRITE_SEND_CLICK',
  'WEIBO_WRITE_SEND_UNCLEARED',
  'WEIBO_WRITE_RESULT',
])

const READ_AUTH_EXACT: Record<string, Exact> = {
  LOGIN_EXPIRED: {
    retrySafe: 'after_reauth',
    requiresReauth: true,
    sideEffect: 'none',
    nextAction: '引导用户重新扫码授权微博',
    message: '微博登录已过期',
  },
  LOGIN_EXPIRED_ACCOUNT: {
    retrySafe: 'after_reauth',
    requiresReauth: true,
    sideEffect: 'none',
    nextAction: '引导用户重新扫码授权微博',
    message: '微博登录已过期',
  },
  RELINK_REQUIRED: {
    retrySafe: 'after_reauth',
    requiresReauth: true,
    sideEffect: 'none',
    nextAction: '引导用户重新扫码授权微博',
    message: '插件授权已失效，需要重新绑定',
  },
  WEIBO_ACTION_FAILED: {
    retrySafe: 'after_reauth',
    requiresReauth: false,
    sideEffect: 'none',
    nextAction:
      '可再试一次读操作确认；若仍失败，引导用户重新扫码授权微博（设置里可能仍显示已授权）',
    message: '微博动作失败，页面未能完成操作',
  },
  CONNECTION_ERROR: {
    retrySafe: 'yes',
    requiresReauth: false,
    sideEffect: 'none',
    nextAction:
      '请稍后重试。若微博已授权仍反复失败，不要当成单纯网络故障，引导用户重新扫码授权',
    message: '插件运行时不可用',
  },
  PLUGIN_RUNTIME_UNAVAILABLE: {
    retrySafe: 'yes',
    requiresReauth: false,
    sideEffect: 'none',
    nextAction: '请稍后重试；若持续失败请联系管理员',
    message: 'Plugin 授权服务暂不可用',
  },
  PLUGIN_SETUP_FAILED: {
    retrySafe: 'yes',
    requiresReauth: false,
    sideEffect: 'none',
    nextAction: '请重新扫码授权',
    message: 'Plugin 授权未完成',
  },
  NOT_INSTALLED: {
    retrySafe: 'no',
    requiresReauth: false,
    sideEffect: 'none',
    nextAction: '请先从 AI 市场安装或更新微博插件',
    message: '尚未安装该 Plugin',
  },
  SETUP_ACTIVE: {
    retrySafe: 'no',
    requiresReauth: false,
    sideEffect: 'none',
    nextAction: '请先完成或取消当前扫码会话，不要并行再开一个',
    message: '已有一个扫码授权正在进行',
  },
  ACCOUNT_ALREADY_EXISTS: {
    retrySafe: 'no',
    requiresReauth: false,
    sideEffect: 'none',
    nextAction: '无需重复绑定。若动作仍失败，引导用户重新扫码刷新会话',
    message: '该 Plugin 账号已授权',
  },
  SETUP_NOT_FOUND: {
    retrySafe: 'yes',
    requiresReauth: false,
    sideEffect: 'none',
    nextAction: '请重新生成二维码',
    message: '扫码会话已失效',
  },
  QR_NOT_READY: {
    retrySafe: 'yes',
    requiresReauth: false,
    sideEffect: 'none',
    nextAction: '请稍后重试获取二维码',
    message: '二维码尚未就绪',
  },
  TERMS_REQUIRED: {
    retrySafe: 'no',
    requiresReauth: false,
    sideEffect: 'none',
    nextAction: '请先阅读并接受微博插件使用条款',
    message: '需要先接受使用条款',
  },
  PRECONDITION_CHANGED: {
    retrySafe: 'no',
    requiresReauth: false,
    sideEffect: 'none',
    nextAction: '目标未发送。请重新检查后开一条新的确认，不要重放同一 confirmId',
    message: '发送前目标已变化，本次未发出',
  },
  UPSTREAM_FAILED: {
    retrySafe: 'no',
    requiresReauth: false,
    sideEffect: 'none',
    nextAction: '请用户本人在浏览器完成验证后再试，不要自动重试',
    message: '微博触发了验证码或风控，无法自动继续',
  },
  RATE_LIMITED: {
    retrySafe: 'yes',
    requiresReauth: false,
    sideEffect: 'none',
    nextAction: '请稍后重试，不要立即连打',
  },
  BAD_REQUEST: {
    retrySafe: 'no',
    requiresReauth: false,
    sideEffect: 'none',
    nextAction: '请修正参数后重试，不要原样重放',
  },
  WRITE_DISABLED: {
    retrySafe: 'no',
    requiresReauth: false,
    sideEffect: 'none',
    nextAction: '请先在设置中阅读免责声明并开启微博写入',
  },
  CONNECTION_NOT_FOUND: {
    retrySafe: 'no',
    requiresReauth: false,
    sideEffect: 'none',
    nextAction: '请重新绑定该插件账号',
  },
  CONNECTION_REVOKED: {
    retrySafe: 'no',
    requiresReauth: true,
    sideEffect: 'none',
    nextAction: '请重新绑定该插件账号',
  },
}

describe('plugin error guidance table', () => {
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
    assertExact('LOGIN_EXPIRED_ACCOUNT', {}, READ_AUTH_EXACT.LOGIN_EXPIRED_ACCOUNT!)
  })

  test('WEIBO_ACTION_FAILED is not swallowed as a generic connection error', () => {
    assertExact('WEIBO_ACTION_FAILED', {}, READ_AUTH_EXACT.WEIBO_ACTION_FAILED!)
    assert.notEqual(weiboRuntimePublicMessage('WEIBO_ACTION_FAILED'), 'Weibo action failed')
  })

  test('read and auth codes have exact guidance', () => {
    for (const [code, expected] of Object.entries(READ_AUTH_EXACT)) {
      assertExact(code, {}, expected)
    }
  })

  test('each write code × failed/unknown has exact retrySafe/sideEffect/nextAction', () => {
    for (const code of WRITE_OUTCOME_CODES) {
      assertExact(
        code,
        { status: 'failed' },
        {
          retrySafe: FAILED_RETRY[code],
          requiresReauth: code === 'LOGIN_EXPIRED_ACCOUNT',
          sideEffect: 'none',
          nextAction: FAILED_NEXT[code],
        },
      )

      const unknownSideEffect: PluginSideEffect = SEND_OR_RESULT.has(code) ? 'likely' : 'possible'
      assertExact(
        code,
        { status: 'unknown' },
        {
          retrySafe: 'check_first',
          requiresReauth: code === 'LOGIN_EXPIRED_ACCOUNT',
          sideEffect: unknownSideEffect,
          nextAction: `${UNKNOWN_PREFIX[code] ?? ''}${UNKNOWN_WRITE_NEXT_ACTION}`,
        },
      )
      const unknown = resolvePluginErrorGuidance({ code, status: 'unknown' })
      assert.match(unknown.nextAction, /list_user_posts/)
      assert.match(unknown.nextAction, /确认未发出/)
      assert.match(unknown.nextAction, /新开确认卡重发/)
    }
  })

  test('WEIBO_WRITE_MEDIA_UPLOAD tells the agent the image path is unavailable', () => {
    const failed = resolvePluginErrorGuidance({
      code: 'WEIBO_WRITE_MEDIA_UPLOAD',
      status: 'failed',
    })
    assert.equal(failed.retrySafe, 'no')
    assert.equal(failed.sideEffect, 'none')
    assert.equal(
      failed.nextAction,
      '商业版图片上传链路当前不可用，请改纯文字发布；不要重放同一条确认卡',
    )
    assert.doesNotMatch(failed.nextAction, /list_user_posts/)

    const unknown = resolvePluginErrorGuidance({
      code: 'WEIBO_WRITE_MEDIA_UPLOAD',
      status: 'unknown',
    })
    assert.equal(unknown.sideEffect, 'possible')
    assert.equal(unknown.retrySafe, 'check_first')
    assert.match(unknown.nextAction, /纯文字/)
    assert.equal(
      unknown.nextAction,
      `商业版图片上传链路当前不可用，建议改纯文字发布；不要重放同一条确认卡。${UNKNOWN_WRITE_NEXT_ACTION}`,
    )
  })

  test('attempted=false reserved narrowing only changes sideEffect, never retrySafe on unknown', () => {
    const narrowed = resolvePluginErrorGuidance({
      code: 'WEIBO_WRITE_MEDIA_UPLOAD',
      status: 'unknown',
      attempted: false,
      pids: 0,
    })
    assert.equal(narrowed.sideEffect, 'none')
    assert.equal(narrowed.retrySafe, 'check_first')
    assert.equal(
      narrowed.nextAction,
      `商业版图片上传链路当前不可用，建议改纯文字发布；不要重放同一条确认卡。${UNKNOWN_WRITE_NEXT_ACTION}`,
    )
  })

  test('PRECONDITION_CHANGED is proven not sent even if status is unknown', () => {
    assertExact(
      'PRECONDITION_CHANGED',
      { status: 'unknown' },
      {
        retrySafe: 'no',
        requiresReauth: false,
        sideEffect: 'none',
        nextAction: '目标未发送。请重新检查后开一条新的确认，不要重放同一 confirmId',
      },
    )
  })

  test('setup 503 stays generic and does not leak pin/hash details', () => {
    const g = resolvePluginErrorGuidance({ code: 'PLUGIN_RUNTIME_UNAVAILABLE' })
    assert.equal(g.retrySafe, 'yes')
    assert.doesNotMatch(g.message, /pin|hash|mismatch|DNS/i)
    assert.doesNotMatch(g.nextAction, /pin|hash|mismatch|DNS/i)
  })

  test('RPC envelopes are additive and keep the original code', () => {
    const error = connectorRpcErrorEnvelope('WEIBO_ACTION_FAILED')
    assert.equal(error.kind, 'error')
    assert.equal(error.code, 'WEIBO_ACTION_FAILED')
    assert.equal(error.retrySafe, 'after_reauth')
    assert.equal(error.nextAction, READ_AUTH_EXACT.WEIBO_ACTION_FAILED!.nextAction)

    const replay = connectorRpcReplayEnvelope({
      status: 'unknown',
      errorCode: 'WEIBO_WRITE_MEDIA_UPLOAD',
      resultDigest: null,
    })
    assert.equal(replay.kind, 'replay')
    assert.equal(replay.status, 'unknown')
    assert.equal(replay.errorCode, 'WEIBO_WRITE_MEDIA_UPLOAD')
    assert.equal(replay.retrySafe, 'check_first')
    assert.equal(replay.sideEffect, 'possible')
    assert.equal(
      replay.nextAction,
      `商业版图片上传链路当前不可用，建议改纯文字发布；不要重放同一条确认卡。${UNKNOWN_WRITE_NEXT_ACTION}`,
    )
  })

  test('unknown codes keep a conservative default and are not passthrough', () => {
    assert.equal(isPluginPassthroughErrorCode('TOTALLY_NEW_CODE'), false)
    assertExact('TOTALLY_NEW_CODE', {}, {
      retrySafe: 'no',
      requiresReauth: false,
      sideEffect: 'none',
      nextAction: '请按错误码处理，不要无依据重试',
      message: '操作失败',
    })
  })
})
