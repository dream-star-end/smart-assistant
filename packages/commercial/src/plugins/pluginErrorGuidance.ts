/**
 * Stable, additive agent-facing guidance for Plugin / connector errors.
 *
 * Envelope fields (`retrySafe` / `requiresReauth` / `sideEffect` / `nextAction`)
 * are appended next to the existing `code`. Unknown codes keep the historical
 * CONNECTION_ERROR fallback; messages never include pin/hash/DNS internals.
 */
import { BILI_ACCOUNT_FAILURE_CODES } from './biliAccountObservability.js'
import { DOUYIN_FAILURE_CODES } from './douyinObservability.js'
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
  provider?: string | null
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
  ...BILI_ACCOUNT_FAILURE_CODES,
  ...DOUYIN_FAILURE_CODES,
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
  'DOCUMENT_EXPIRED',
  'TIMEOUT',
  'RESPONSE_INVALID',
  'WRITE_DAILY_LIMIT',
  // 文献数据库（OCV5-585）：暂存容量与上游异常分类各有独立码，不再折成 RATE_LIMITED / CONNECTION_ERROR。
  'LITERATURE_ARTIFACT_CAPACITY',
  'LITERATURE_NO_ACCESS',
  'LITERATURE_UPSTREAM_RATE_LIMITED',
  'LITERATURE_UPSTREAM_CHALLENGE',
  'LITERATURE_UPSTREAM_CHANGED',
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
    if (SEND_OR_RESULT.has(code) || input.attempted === true || (input.pids ?? 0) > 0)
      return 'likely'
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
  const next = code.startsWith('ZHIHU_')
    ? '先 get_self 或 list_my_answers 核对是否已发出，确认未发出才可新开确认卡重发'
    : UNKNOWN_WRITE_NEXT_ACTION
  return {
    ...guidance,
    retrySafe: 'check_first',
    nextAction: `${prefix}${next}`,
  }
}

const ROWS: Record<string, Row> = {
  WEIBO_ACTION_FAILED: {
    retrySafe: 'after_reauth',
    requiresReauth: false,
    message: '微博动作失败，页面未能完成操作',
    nextAction:
      '可再试一次读操作确认；若仍失败，引导用户重新扫码授权微博（设置里可能仍显示已授权）',
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
  // OCV5-402 · 哔哩哔哩账号插件(只读,没有写副作用)。
  BILI_ACCOUNT_ACTION_FAILED: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: 'B 站账号插件读取失败',
    nextAction: '可以再试一次;仍失败时引导用户在 管理中心 → 插件 重新扫码登录 B 站',
  },
  BILI_ACCOUNT_UPSTREAM_CHALLENGE: {
    retrySafe: 'no',
    requiresReauth: false,
    message: 'B 站触发了风控验证,无法自动继续',
    nextAction: '如实告诉用户稍后再试,不要自动重试,也不要索要 cookie',
  },
  BILI_ACCOUNT_LOGIN_UNSUPPORTED: {
    retrySafe: 'no',
    requiresReauth: false,
    message: 'B 站返回的登录凭据无法安全保存,本次登录未生效',
    nextAction: '告诉用户这是平台侧限制,不要反复扫码;请联系管理员',
  },
  BILI_ACCOUNT_WORKER_BUSY: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: 'B 站账号插件正忙',
    nextAction: '请稍后重试',
  },
  BILI_ACCOUNT_WORKER_DEADLINE: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: 'B 站账号插件执行超时',
    nextAction: '只读操作,可稍后重试',
  },
  BILI_ACCOUNT_WORKER_INCOMPLETE: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: 'B 站账号插件未正常结束',
    nextAction: '只读操作,可稍后重试',
  },
  // OCV5-553 · 抖音插件(本版只读:扫码登录 + me)。
  DOUYIN_ACTION_FAILED: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: '抖音插件读取失败',
    nextAction: '可以再试一次;仍失败时引导用户到 管理中心 → 插件 → 抖音 重新扫码登录',
  },
  DOUYIN_UPSTREAM_CHALLENGE: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '抖音触发了验证码或风控,已停止,无法自动继续',
    nextAction:
      '如实告诉用户抖音触发了风控,请稍后再试;不要自动重试、不要换动作绕过,也不要索要 cookie 或验证码',
  },
  DOUYIN_VERIFICATION_REQUIRED: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '抖音要求账号本人完成身份验证,本次登录未生效',
    nextAction:
      '请用户在手机抖音上完成身份验证后,再到 管理中心 → 插件 → 抖音 重新扫码;不要自动重试,也不要索要短信验证码',
  },
  DOUYIN_LOGIN_UNSUPPORTED: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '抖音返回的登录凭据无法安全保存,本次登录未生效',
    nextAction: '告诉用户这是平台侧限制,不要反复扫码;请联系管理员',
  },
  DOUYIN_WORKER_BUSY: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: '抖音插件正忙',
    nextAction: '请稍后重试',
  },
  DOUYIN_WORKER_DEADLINE: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: '抖音插件执行超时',
    nextAction: '只读操作,可稍后重试',
  },
  DOUYIN_WORKER_INCOMPLETE: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: '抖音插件未正常结束',
    nextAction: '只读操作,可稍后重试',
  },
  PLUGIN_RUNTIME_UNAVAILABLE: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: '插件授权服务暂不可用',
    nextAction: '请稍后重试；若持续失败请联系管理员',
  },
  PLUGIN_SETUP_FAILED: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: '插件授权未完成',
    nextAction: '请重新扫码授权',
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
    message: '该插件账号已授权',
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
  CONNECTION_ERROR: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: '插件运行时不可用',
    nextAction:
      '请稍后重试；若该插件已授权仍反复失败，不要当成单纯网络故障，引导用户到 管理中心 → 插件 重新绑定或刷新授权',
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
    nextAction: '请稍后重试，不要立即连打；下载文献时请一篇一篇下，每篇间隔 20-30 秒',
  },
  DOCUMENT_EXPIRED: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '文献编号已过期或校验失败',
    nextAction: '请重新 search 获取新编号后再下载，不要重放旧 documentId',
  },
  LITERATURE_ARTIFACT_CAPACITY: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: '平台为你暂存的文献 PDF 已满，本篇未下载',
    nextAction:
      '请先让用户在已就绪的文献卡片上点「保存 PDF」存到本地（已保存的文件会优先腾出空间），或等较早的文件约 30 分钟到期后再下载这一篇；不要连续重试',
  },
  LITERATURE_NO_ACCESS: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '文献源拒绝访问：该文献不在已授权的订阅范围内，或机构通道暂时拒绝访问',
    nextAction: '请换一篇文献或稍后再试；账号登录正常，无需重新绑定，不要反复重试同一篇',
  },
  LITERATURE_UPSTREAM_RATE_LIMITED: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: '文献源限流（访问过于频繁）',
    nextAction: '请等几分钟后再试，不要立即连打；多篇文献请一篇一篇检索或下载',
  },
  LITERATURE_UPSTREAM_CHALLENGE: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '文献源要求人机验证或触发了风控，无法自动继续',
    nextAction:
      '请稍后再试；若持续出现，请告诉用户联系管理员检查文献通道。账号无需重新绑定，不要自动重试',
  },
  LITERATURE_UPSTREAM_CHANGED: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: '文献源返回了无法识别的页面，并非零结果',
    nextAction:
      '可稍后重试一次；仍失败请告诉用户文献源页面可能已变化、需联系管理员，不要当成没有检索结果',
  },
  TIMEOUT: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: '文献源响应或下载超时',
    nextAction: '请稍后重试；下载多篇文献时请一篇一篇下，每篇间隔 20-30 秒',
  },
  RESPONSE_INVALID: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: '文献源返回格式异常或该文献暂无可用 PDF 全文',
    nextAction: '可稍后重试一次；若仍失败，说明上游暂无该篇有效 PDF，请换一篇文献',
  },
  BAD_REQUEST: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '请求参数无效',
    nextAction: '请修正参数后重试，不要原样重放',
  },
  // API 插件 / 连接器：参数不合签名的参数结构、上游拒绝凭据（401/403、IMAP 登录失败、换 token 失败等）、
  // 上游限流、结果超过平台硬限。措辞不假设具体鉴权方式；某个插件专属的说明写在它自己的说明里。
  VALIDATION_FAILED: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '参数不符合该操作的参数结构',
    nextAction: '先用 oc-plugin describe <插件> <操作> 查看参数名、类型和必填项，修正后再调用',
  },
  UPSTREAM_AUTH_FAILED: {
    retrySafe: 'after_reauth',
    requiresReauth: true,
    message: '插件服务拒绝了凭据：凭据无效、已过期或被撤销，或额度/配额已用完',
    nextAction:
      '请提示用户检查该插件的凭据（Token、授权或账号密码）是否有效、额度或配额是否用完，必要时到 管理中心 → 插件 重新绑定或填写；不要自动重试',
  },
  UPSTREAM_RATE_LIMITED: {
    retrySafe: 'yes',
    requiresReauth: false,
    message: '插件服务限流（HTTP 429）',
    nextAction: '稍后再试，不要立即连打；持续出现时提示用户检查该插件的配额',
  },
  RESULT_TOO_LARGE: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '结果超过单次返回上限',
    nextAction: '缩小查询范围、减少条数或分批读取后重试，不要原样重放',
  },
  PLUGIN_UNAVAILABLE: {
    message: '此插件已下架，无法连接或调用。',
    retrySafe: 'no',
    requiresReauth: false,
    nextAction: '请在管理中心 → 插件中选择当前支持的应用。',
  },
  PLUGIN_DISABLED: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '插件已停用',
    nextAction: '请告诉用户在 管理中心 → 插件 里打开这个插件后再试，不要绕过',
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
  WRITE_DAILY_LIMIT: {
    retrySafe: 'no',
    requiresReauth: false,
    message: '该账号今日此类写操作已达上限，本次未执行',
    nextAction: '本次未发送。请告诉用户明天再试，不要换动作或换确认卡绕过上限',
  },
}

/**
 * 插件在用户可见文案里的称呼(按 provider slug)。通用码(登录过期、运行时故障、未安装、条款、写入开关)
 * 的文案按它生成:微博逐字保持历史原文;已知插件用自己的名字;未知或未传 provider 用中性措辞,
 * 不再一律说「微博」(OCV5-553)。
 */
type ProviderWording = {
  /** 拼进 message 的主语,如「微博登录已过期」;中性 = 「插件」。 */
  name: string
  /** 拼进「安装或更新 X」「接受 X 使用条款」「开启 X 写入」的宾语;中性 = 「该插件」。 */
  plugin: string
  write: string
  /** 授权失效时引导用户的动作。 */
  relink: string
}

const PROVIDER_WORDING: Record<string, ProviderWording> = {
  weibo: {
    name: '微博',
    plugin: '微博插件',
    write: '微博写入',
    relink: '引导用户重新扫码授权微博',
  },
  zhihu: {
    name: '知乎',
    plugin: '知乎插件',
    write: '知乎写入',
    relink: '引导用户重新扫码授权知乎',
  },
  'bili-account': {
    name: 'B 站账号插件',
    plugin: 'B 站账号插件',
    write: 'B 站账号插件写入',
    relink: '引导用户重新扫码授权 B 站账号',
  },
  douyin: {
    name: '抖音',
    plugin: '抖音插件',
    write: '抖音写入',
    relink: '引导用户到 管理中心 → 插件 → 抖音 重新扫码登录,不要重复调用',
  },
  'knowledge-planet': {
    name: '知识星球',
    plugin: '知识星球插件',
    write: '知识星球写入',
    relink: '引导用户到 管理中心 → 插件 重新授权知识星球账号',
  },
  'literature-db': {
    name: '文献数据库',
    plugin: '文献数据库插件',
    write: '文献数据库写入',
    relink: '引导用户到 管理中心 → 插件 重新连接文献数据库账号',
  },
}

const NEUTRAL_WORDING: ProviderWording = {
  name: '插件',
  plugin: '该插件',
  write: '该插件写入',
  relink: '引导用户到 管理中心 → 插件 重新授权该插件账号',
}

function providerWording(provider: string | null | undefined): ProviderWording {
  return (provider ? PROVIDER_WORDING[provider] : undefined) ?? NEUTRAL_WORDING
}

const PROVIDER_ROWS: Record<string, (w: ProviderWording) => Row> = {
  LOGIN_EXPIRED: (w) => ({
    retrySafe: 'after_reauth',
    requiresReauth: true,
    message: `${w.name}登录已过期`,
    nextAction: w.relink,
  }),
  LOGIN_EXPIRED_ACCOUNT: (w) => ({
    retrySafe: 'after_reauth',
    requiresReauth: true,
    message: `${w.name}登录已过期`,
    nextAction: w.relink,
  }),
  RELINK_REQUIRED: (w) => ({
    retrySafe: 'after_reauth',
    requiresReauth: true,
    message: '插件授权已失效，需要重新绑定',
    nextAction: w.relink,
  }),
  UPSTREAM_FAILED: (w) => ({
    retrySafe: 'no',
    requiresReauth: false,
    message: `${w.name}触发了验证码或风控，无法自动继续`,
    nextAction: '请用户本人在浏览器完成验证后再试，不要自动重试',
  }),
  EXECUTION_FAILED: (w) => ({
    retrySafe: 'no',
    requiresReauth: false,
    message: `${w.name}动作执行失败`,
    nextAction: '执行失败且未发送。请检查参数后重开，不要无依据重试同一确认卡',
  }),
  CAPACITY_EXCEEDED: (w) => ({
    retrySafe: 'yes',
    requiresReauth: false,
    message: `${w.name}工作容量已满`,
    nextAction: '请稍后重试，本次未发送',
  }),
  UNAVAILABLE: (w) => ({
    retrySafe: 'yes',
    requiresReauth: false,
    message: `${w.name}运行时暂不可用`,
    nextAction: '请稍后重试；若持续失败请联系管理员',
  }),
  IMAGE_MISMATCH: (w) => ({
    retrySafe: 'yes',
    requiresReauth: false,
    message: `${w.name}工作镜像与期望不一致`,
    nextAction: '平台故障，请稍后重试或联系管理员',
  }),
  PROTOCOL: (w) => ({
    retrySafe: 'yes',
    requiresReauth: false,
    message: `${w.name}工作协议异常`,
    nextAction: '协议异常且未发送，请稍后重试',
  }),
  CLEANUP_FAILED: (w) => ({
    retrySafe: 'yes',
    requiresReauth: false,
    message: `${w.name}工作器清理失败`,
    nextAction: '平台清理异常。请稍后重试',
  }),
  CLOSING: (w) => ({
    retrySafe: 'yes',
    requiresReauth: false,
    message: `${w.name}运行时正在关闭`,
    nextAction: '请稍后重试',
  }),
  NOT_INSTALLED: (w) => ({
    retrySafe: 'no',
    requiresReauth: false,
    message: '尚未安装该插件',
    nextAction: `请先从 AI 市场安装或更新${w.plugin}`,
  }),
  TERMS_REQUIRED: (w) => ({
    retrySafe: 'no',
    requiresReauth: false,
    message: '需要先接受使用条款',
    nextAction: `请先阅读并接受${w.plugin}使用条款`,
  }),
  WRITE_DISABLED: (w) => ({
    retrySafe: 'no',
    requiresReauth: false,
    message: '插件写入未开启',
    nextAction: `请先在设置中阅读免责声明并开启${w.write}`,
  }),
}

function rowFor(code: string, provider: string | null | undefined): Row {
  const byProvider = PROVIDER_ROWS[code]
  if (byProvider) return byProvider(providerWording(provider))
  return ROWS[code] ?? DEFAULT_ROW
}

const DEFAULT_ROW: Row = {
  retrySafe: 'no',
  requiresReauth: false,
  message: '操作失败',
  nextAction: '请按错误码处理，不要无依据重试',
}

export function resolvePluginErrorGuidance(input: PluginErrorGuidanceInput): PluginErrorGuidance {
  const code = input.code
  const row = rowFor(code, input.provider)
  const nextAction =
    code === 'CONNECTION_ERROR' && input.provider === 'weibo'
      ? '请稍后重试。若微博已授权仍反复失败，不要当成单纯网络故障，引导用户重新扫码授权'
      : row.nextAction
  const base: PluginErrorGuidance = {
    retrySafe: row.retrySafe,
    requiresReauth: row.requiresReauth,
    sideEffect: writeSideEffect(code, input),
    nextAction,
    message: row.message,
  }
  if (isUnknownWrite(input.status)) return applyUnknownWriteOverride(code, base)
  return base
}

export function weiboRuntimePublicMessage(code: string): string {
  return resolvePluginErrorGuidance({ code, provider: 'weibo' }).message
}

export function zhihuRuntimePublicMessage(code: string): string {
  return resolvePluginErrorGuidance({ code, provider: 'zhihu' }).message
}

export function biliAccountRuntimePublicMessage(code: string): string {
  return resolvePluginErrorGuidance({ code, provider: 'bili-account' }).message
}

export function douyinRuntimePublicMessage(code: string): string {
  return resolvePluginErrorGuidance({ code, provider: 'douyin' }).message
}

export type PluginErrorGuidanceFields = Pick<
  PluginErrorGuidance,
  'retrySafe' | 'requiresReauth' | 'sideEffect' | 'nextAction'
> & { message: string }

export function pluginErrorGuidanceFields(
  input: PluginErrorGuidanceInput,
): PluginErrorGuidanceFields {
  const g = resolvePluginErrorGuidance(input)
  return {
    message: g.message,
    retrySafe: g.retrySafe,
    requiresReauth: g.requiresReauth,
    sideEffect: g.sideEffect,
    nextAction: g.nextAction,
  }
}

export function connectorRpcErrorEnvelope(
  code: string,
  provider?: string | null,
): {
  kind: 'error'
  code: string
  message: string
  retrySafe: PluginRetrySafe
  requiresReauth: boolean
  sideEffect: PluginSideEffect
  nextAction: string
} {
  const g = resolvePluginErrorGuidance({ code, provider })
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
  provider?: string | null
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
      provider: input.provider,
    })
    body.message = g.message
    body.retrySafe = g.retrySafe
    body.requiresReauth = g.requiresReauth
    body.sideEffect = g.sideEffect
    body.nextAction = g.nextAction
  }
  return body
}
