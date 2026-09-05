/**
 * Stable, additive agent-facing guidance for Plugin / connector errors.
 *
 * Envelope fields (`retrySafe` / `requiresReauth` / `sideEffect` / `nextAction`)
 * are appended next to the existing `code`. Unknown codes keep the historical
 * CONNECTION_ERROR fallback; messages never include pin/hash/DNS internals.
 */
import { WEIBO_WRITE_FAILURE_CODES } from './weiboWriteObservability.js'
import { ZHIHU_WRITE_FAILURE_CODES } from './zhihuWriteObservability.js'

export type PluginRetrySafe = 'yes' | 'no' | 'after_reauth' | 'check_first'
export type PluginSideEffect = 'none' | 'possible' | 'likely'

export type PluginErrorGuidance = {
  retrySafe: PluginRetrySafe
  requiresReauth: boolean
  sideEffect: PluginSideEffect
  nextAction: string
  message: string
}

export type PluginErrorGuidanceInput = {
  code: string
  status?: string | null
  /**
   * Reserved narrowing signals from the worker protocol. The current
   * worker→gateway failed frame is still `{event,code}` only, and RPC
   * `sendReplay` does not pass these. Callers may supply them later without
   * a worker change if the protocol grows; do not scrape jsonl to invent them.
   */
  attempted?: boolean
  pids?: number
}

/** Required nextAction fragment for every write code with ledger status=unknown. */
export const UNKNOWN_WRITE_NEXT_ACTION =
  '先 list_user_posts 核对是否已发出，确认未发出才可新开确认卡重发'

export const PLUGIN_PASSTHROUGH_ERROR_CODES = [
  ...WEIBO_WRITE_FAILURE_CODES,
  ...ZHIHU_WRITE_FAILURE_CODES,
  'LOGIN_EXPIRED',
  'LOGIN_EXPIRED_ACCOUNT',
  'PRECONDITION_CHANGED',
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
  'SETUP_NOT_FOUND',
  'QR_NOT_READY',
  'TERMS_REQUIRED',
  'ACCOUNT_ALREADY_EXISTS',
] as const

export type PluginPassthroughErrorCode = (typeof PLUGIN_PASSTHROUGH_ERROR_CODES)[number]

const PASSTHROUGH_SET = new Set<string>(PLUGIN_PASSTHROUGH_ERROR_CODES)

const SEND_OR_RESULT = new Set([
  'WEIBO_WRITE_SEND',
  'WEIBO_WRITE_SEND_BUTTON',
  'WEIBO_WRITE_SEND_CLICK',
  'WEIBO_WRITE_SEND_UNCLEARED',
  'WEIBO_WRITE_RESULT',
  'ZHIHU_WRITE_SEND',
  'ZHIHU_WRITE_SEND_BUTTON',
  'ZHIHU_WRITE_SEND_CLICK',
  'ZHIHU_WRITE_RESULT',
])

export function isPluginPassthroughErrorCode(code: string): code is PluginPassthroughErrorCode {
  return PASSTHROUGH_SET.has(code)
}

function isUnknownWrite(status: string | null | undefined): boolean {
  return status === 'unknown'
}

function isFailedWrite(status: string | null | undefined): boolean {
  return status === 'failed' || status === 'denied' || status === 'expired'
}

function writeSideEffect(code: string, input: PluginErrorGuidanceInput): PluginSideEffect {
  if (code === 'PRECONDITION_CHANGED') return 'none'
  if (isFailedWrite(input.status)) return 'none'
  if (input.attempted === false && !SEND_OR_RESULT.has(code)) return 'none'
  if (isUnknownWrite(input.status)) {
    if (SEND_OR_RESULT.has(code) || input.attempted === true || (input.pids ?? 0) > 0) return 'likely'
    return 'possible'
  }
  return 'none'
}

type Row = {
  retrySafe: PluginRetrySafe
  requiresReauth: boolean
  message: string
  nextAction: string
}

function unknownWritePrefix(code: string): string {
  switch (code) {
    case 'WEIBO_WRITE_MEDIA_UPLOAD':
      return '商业版图片上传链路当前不可用，建议改纯文字发布；不要重放同一条确认卡。'
    case 'WEIBO_ACTION_FAILED':
      return '写操作结果不明，不要重新授权后直接重发。'
    case 'LOGIN_EXPIRED_ACCOUNT':
    case 'LOGIN_EXPIRED':
    case 'RELINK_REQUIRED':
      return '授权可能已失效且写结果不明。'
    case 'UPSTREAM_FAILED':
      return '验证码出现前可能已有写副作用。'
    case 'WEIBO_WRITE_SEND':
    case 'WEIBO_WRITE_SEND_BUTTON':
    case 'WEIBO_WRITE_SEND_CLICK':
    case 'WEIBO_WRITE_SEND_UNCLEARED':
    case 'WEIBO_WRITE_RESULT':
      return '可能已点发送。'
    case 'ZHIHU_ACTION_FAILED':
      return '写操作结果不明，不要重新授权后直接重发。'
    case 'ZHIHU_UPSTREAM_CHALLENGE':
      return '验证码出现前可能已有写副作用。'
    case 'ZHIHU_WRITE_SEND':
    case 'ZHIHU_WRITE_SEND_BUTTON':
    case 'ZHIHU_WRITE_SEND_CLICK':
    case 'ZHIHU_WRITE_RESULT':
      return '可能已点发送。'
    default:
      return ''
  }
}

function applyUnknownWriteOverride(
  code: string,
  guidance: PluginErrorGuidance,
): PluginErrorGuidance {
  if (code === 'PRECONDITION_CHANGED') return guidance
  const prefix = unknownWritePrefix(code)
  const next =
    code.startsWith('ZHIHU_')
      ? '先 get_self 或 list_my_answers 核对是否已发出，确认未发出才可新开确认卡重发'
      : UNKNOWN_WRITE_NEXT_ACTION
  return {
    ...guidance,
    retrySafe: 'check_first',
    nextAction: `${prefix}${next}`,
  }
}

const ROWS: Record<string, Row> = {
  LOGIN_EXPIRED: {
    retrySafe: 'after_reauth',
    requiresReauth: true,
    message: '微博登录已过期',
    nextAction: '引导用户重新扫码授权微博',
  },
  LOGIN_EXPIRED_ACCOUNT: {
    retrySafe: 'after_reauth',
    requiresReauth: true,
    message: '微博登录已过期',
    nextAction: '引导用户重新扫码授权微博',
  },
  RELINK_REQUIRED: {
    retrySafe: 'after_reauth',
    requiresReauth: true,
    message: '插件授权已失效，需要重新绑定',
    nextAction: '引导用户重新扫码授权微博',
  },
  WEIBO_ACTION_FAILED: {
    retrySafe: 'after_reauth',
    requiresReauth: false,
    message: '微博动作失败，页面未能完成操作',
    nextAction:
      '可再试一次读操作确认；若仍失败，引导用户重新扫码授权微博（设置里可能仍显示已授权）',
  },
  UPSTREAM_FAILED: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '微博触发了验证码或风控，无法自动继续',
    nextAction: '请用户本人在浏览器完成验证后再试，不要自动重试',
  },
  PRECONDITION_CHANGED: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '发送前目标已变化，本次未发出',
    nextAction: '目标未发送。请重新检查后开一条新的确认，不要重放同一 confirmId',
  },
  WEIBO_WRITE_MEDIA_UPLOAD: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '商业版微博图片上传链路当前不可用',
    nextAction: '商业版图片上传链路当前不可用，请改纯文字发布；不要重放同一条确认卡',
  },
  WEIBO_WRITE_MEDIA_CHOOSER: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '微博图片选择器未能打开或已超时',
    nextAction: '图片控件未就绪。可改纯文字发布，或稍后重开一条新确认',
  },
  WEIBO_WRITE_MEDIA: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '微博配图处理失败',
    nextAction: '配图未完成。可改纯文字发布，不要重放同一条确认卡',
  },
  WEIBO_WRITE_MEDIA_PREVIEW: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '微博配图预览未出现',
    nextAction: '图片可能未进入编辑器。可改纯文字发布',
  },
  WEIBO_WRITE_MEDIA_PREVIEW_TIMEOUT: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '微博配图预览等待超时',
    nextAction: '图片预览超时。可改纯文字发布，不要重放同一条确认卡',
  },
  WEIBO_WRITE_COMPOSER: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '微博编辑器未能就绪',
    nextAction: '正文未发出。可稍后重开一条新确认，不要重放同一 confirmId',
  },
  WEIBO_WRITE_COMPOSER_EDITOR: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '微博编辑器无法定位或填写',
    nextAction: '正文未发出。可稍后重开一条新确认',
  },
  WEIBO_WRITE_COMPOSER_READBACK: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '微博正文回读校验失败',
    nextAction: '正文未发出。请检查文案后重开一条新确认',
  },
  WEIBO_WRITE_COMPOSER_LONGTEXT: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '微博长文编辑失败',
    nextAction: '长文未发出。可缩短文案后重开一条新确认',
  },
  WEIBO_WRITE_SEND: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '微博发送步骤失败，可能已点过发送',
    nextAction: '发送未执行。可重开一条新确认',
  },
  WEIBO_WRITE_SEND_BUTTON: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '找不到微博发送按钮',
    nextAction: '发送未执行。可重开一条新确认',
  },
  WEIBO_WRITE_SEND_CLICK: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '微博发送按钮点击未确认成功',
    nextAction: '发送未执行。可重开一条新确认',
  },
  WEIBO_WRITE_SEND_UNCLEARED: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '微博发送后编辑器未清空',
    nextAction: '发送未执行。可重开一条新确认',
  },
  WEIBO_WRITE_RESULT: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '微博发送后未能确认新帖',
    nextAction: '发送未执行。可重开一条新确认',
  },
  WEIBO_WORKER_BUSY: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: '微博工作槽位正忙',
    nextAction: '请稍后重试；本次未发送',
  },
  WEIBO_WORKER_DEADLINE: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: '微博工作器执行超时',
    nextAction: '超时发生在发送前，可稍后重试',
  },
  WEIBO_WORKER_INCOMPLETE: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: '微博工作器未正常结束',
    nextAction: '工作器未完成且未发送，可稍后重试',
  },
  EXECUTION_FAILED: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '微博动作执行失败',
    nextAction: '执行失败且未发送。请检查参数后重开，不要无依据重试同一确认卡',
  },
  CAPACITY_EXCEEDED: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: '微博工作容量已满',
    nextAction: '请稍后重试，本次未发送',
  },
  UNAVAILABLE: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: '微博运行时暂不可用',
    nextAction: '请稍后重试；若持续失败请联系管理员',
  },
  IMAGE_MISMATCH: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: '微博工作镜像与期望不一致',
    nextAction: '平台故障，请稍后重试或联系管理员',
  },
  PROTOCOL: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: '微博工作协议异常',
    nextAction: '协议异常且未发送，请稍后重试',
  },
  CLEANUP_FAILED: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: '微博工作器清理失败',
    nextAction: '平台清理异常。请稍后重试',
  },
  CLOSING: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: '微博运行时正在关闭',
    nextAction: '请稍后重试',
  },
  ZHIHU_ACTION_FAILED: {
    retrySafe: 'after_reauth',
    requiresReauth: false,
    message: '知乎动作失败，页面未能完成操作',
    nextAction:
      '可再试一次读操作确认；若仍失败，引导用户重新扫码授权知乎（设置里可能仍显示已授权）',
  },
  ZHIHU_UPSTREAM_CHALLENGE: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '知乎触发了验证码或风控，无法自动继续',
    nextAction: '请用户本人在浏览器完成验证后再试，不要自动重试',
  },
  ZHIHU_WRITE_COMPOSER: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '知乎编辑器未能就绪',
    nextAction: '正文未发出。可稍后重开一条新确认，不要重放同一 confirmId',
  },
  ZHIHU_WRITE_COMPOSER_EDITOR: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '知乎编辑器无法定位或填写',
    nextAction: '正文未发出。可稍后重开一条新确认',
  },
  ZHIHU_WRITE_COMPOSER_READBACK: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '知乎正文回读校验失败',
    nextAction: '正文未发出。请检查文案后重开一条新确认',
  },
  ZHIHU_WRITE_SEND: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '知乎发送步骤失败，可能已点过发送',
    nextAction: '发送未执行。可重开一条新确认',
  },
  ZHIHU_WRITE_SEND_BUTTON: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '找不到知乎发送按钮',
    nextAction: '发送未执行。可重开一条新确认',
  },
  ZHIHU_WRITE_SEND_CLICK: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '知乎发送按钮点击未确认成功',
    nextAction: '发送未执行。可重开一条新确认',
  },
  ZHIHU_WRITE_RESULT: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '知乎发送后未能确认结果',
    nextAction: '请先到知乎核实是否已发出，不要重放',
  },
  ZHIHU_WRITE_UNSUPPORTED: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '该知乎写动作尚未实现',
    nextAction: '请改用已实现的回答、评论、投票或关注动作',
  },
  ZHIHU_WRITE_MEDIA_CHOOSER: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '知乎图片选择控件不可用',
    nextAction: '图片控件未就绪。可改纯文字发布，或稍后重开一条新确认',
  },
  ZHIHU_WRITE_MEDIA_UPLOAD: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '知乎图片上传失败',
    nextAction: '配图未完成。可改纯文字发布，不要重放同一条确认卡',
  },
  ZHIHU_WRITE_MEDIA_PREVIEW_TIMEOUT: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '知乎图片预览超时',
    nextAction: '图片预览超时。可改纯文字发布，不要重放同一条确认卡',
  },
  ZHIHU_WORKER_BUSY: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: '知乎工作槽位正忙',
    nextAction: '请稍后重试；本次未发送',
  },
  ZHIHU_WORKER_DEADLINE: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: '知乎工作器执行超时',
    nextAction: '请先到知乎核实是否已发出',
  },
  ZHIHU_WORKER_INCOMPLETE: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: '知乎工作器未正常结束',
    nextAction: '工作器未完成且未发送，可稍后重试',
  },
  PLUGIN_RUNTIME_UNAVAILABLE: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: 'Plugin 授权服务暂不可用',
    nextAction: '请稍后重试；若持续失败请联系管理员',
  },
  PLUGIN_SETUP_FAILED: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: 'Plugin 授权未完成',
    nextAction: '请重新扫码授权',
  },
  NOT_INSTALLED: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '尚未安装该 Plugin',
    nextAction: '请先从 AI 市场安装或更新微博插件',
  },
  SETUP_ACTIVE: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '已有一个扫码授权正在进行',
    nextAction: '请先完成或取消当前扫码会话，不要并行再开一个',
  },
  ACCOUNT_ALREADY_EXISTS: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '该 Plugin 账号已授权',
    nextAction: '无需重复绑定。若动作仍失败，引导用户重新扫码刷新会话',
  },
  SETUP_NOT_FOUND: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: '扫码会话已失效',
    nextAction: '请重新生成二维码',
  },
  QR_NOT_READY: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: '二维码尚未就绪',
    nextAction: '请稍后重试获取二维码',
  },
  TERMS_REQUIRED: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '需要先接受使用条款',
    nextAction: '请先阅读并接受微博插件使用条款',
  },
  CONNECTION_ERROR: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: '插件运行时不可用',
    nextAction:
      '请稍后重试。若微博已授权仍反复失败，不要当成单纯网络故障，引导用户重新扫码授权',
  },
  CONNECTION_NOT_FOUND: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '连接不存在或已解绑',
    nextAction: '请重新绑定该插件账号',
  },
  CONNECTION_REVOKED: {
    retrySafe: 'no',
    requiresReauth: true,
    message: '连接已解除',
    nextAction: '请重新绑定该插件账号',
  },
  RATE_LIMITED: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: '操作过于频繁或账号正忙',
    nextAction: '请稍后重试，不要立即连打',
  },
  BAD_REQUEST: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '请求参数无效',
    nextAction: '请修正参数后重试，不要原样重放',
  },
  WRITE_DISABLED: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '插件写入未开启',
    nextAction: '请先在设置中阅读免责声明并开启微博写入',
  },
  ACTION_UNKNOWN: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '未知的插件动作',
    nextAction: '请核对动作名后重试',
  },
  INTERNAL: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: '服务暂时不可用',
    nextAction: '请稍后重试；若持续失败请联系管理员',
  },
}

const DEFAULT_ROW: Row = {
  retrySafe: 'no',
  requiresReauth: false,
  message: '操作失败',
  nextAction: '请按错误码处理，不要无依据重试',
}

export function resolvePluginErrorGuidance(input: PluginErrorGuidanceInput): PluginErrorGuidance {
  const code = input.code
  const row = ROWS[code] ?? DEFAULT_ROW
  const base: PluginErrorGuidance = {
    retrySafe: row.retrySafe,
    requiresReauth: row.requiresReauth,
    sideEffect: writeSideEffect(code, input),
    nextAction: row.nextAction,
    message: row.message,
  }
  if (isUnknownWrite(input.status)) return applyUnknownWriteOverride(code, base)
  return base
}

export function weiboRuntimePublicMessage(code: string): string {
  return resolvePluginErrorGuidance({ code }).message
}

export function zhihuRuntimePublicMessage(code: string): string {
  return resolvePluginErrorGuidance({ code }).message
}

export type PluginErrorGuidanceFields = Pick<
  PluginErrorGuidance,
  'retrySafe' | 'requiresReauth' | 'sideEffect' | 'nextAction'
> & { message: string }

export function pluginErrorGuidanceFields(input: PluginErrorGuidanceInput): PluginErrorGuidanceFields {
  const g = resolvePluginErrorGuidance(input)
  return {
    message: g.message,
    retrySafe: g.retrySafe,
    requiresReauth: g.requiresReauth,
    sideEffect: g.sideEffect,
    nextAction: g.nextAction,
  }
}

export function connectorRpcErrorEnvelope(code: string): {
  kind: 'error'
  code: string
  message: string
  retrySafe: PluginRetrySafe
  requiresReauth: boolean
  sideEffect: PluginSideEffect
  nextAction: string
} {
  const g = resolvePluginErrorGuidance({ code })
  return {
    kind: 'error',
    code,
    message: g.message,
    retrySafe: g.retrySafe,
    requiresReauth: g.requiresReauth,
    sideEffect: g.sideEffect,
    nextAction: g.nextAction,
  }
}

export function connectorRpcReplayEnvelope(input: {
  status: string
  errorCode?: string | null
  resultDigest?: string | null
}): {
  kind: 'replay'
  status: string
  errorCode?: string
  resultDigest?: string
  message?: string
  retrySafe?: PluginRetrySafe
  requiresReauth?: boolean
  sideEffect?: PluginSideEffect
  nextAction?: string
} {
  const body: ReturnType<typeof connectorRpcReplayEnvelope> = {
    kind: 'replay',
    status: input.status,
  }
  if (input.errorCode) body.errorCode = input.errorCode
  if (input.resultDigest) body.resultDigest = input.resultDigest
  if (input.errorCode && input.status !== 'succeeded') {
    const g = resolvePluginErrorGuidance({
      code: input.errorCode,
      status: input.status,
    })
    body.message = g.message
    body.retrySafe = g.retrySafe
    body.requiresReauth = g.requiresReauth
    body.sideEffect = g.sideEffect
    body.nextAction = g.nextAction
  }
  return body
}
