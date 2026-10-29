import { HTTP_ERROR_GROUPS } from './userErrorCodes.js'
import {
  TURN_ERROR_TAXONOMY, normalizeTurnErrorCode, turnErrorSemantics,
  type TurnErrorCode, type TurnErrorCta,
} from './turnErrorTaxonomy.js'
import type { UserError, UserErrorAction, UserErrorCategory } from './userErrorTypes.js'
export type { UserError, UserErrorAction, UserErrorCategory, AutomaticRetryStatus } from './userErrorTypes.js'

type Copy = readonly [category: UserErrorCategory, message: string, actions: readonly UserErrorAction[]]
const GROUP_COPY: Record<UserErrorCategory, Copy> = {
  auth: ['auth', '当前认证未通过，请重新登录或重新连接账号后再试。', ['relogin', 'contact_admin']],
  permission: ['permission', '你暂时没有执行此操作的权限，请检查账号权限或联系管理员。', ['check_settings', 'contact_admin']],
  input: ['input', '提交的内容不符合要求，请检查填写内容后再试。', ['edit_message']],
  size: ['size', '本次内容超过了处理上限，请精简消息或分批提交文件。', ['edit_message', 'switch_model']],
  context: ['context', '当前模型无法一次处理这段对话，请精简本条消息，或切换支持更长上下文的模型继续。', ['edit_message', 'switch_model']],
  capacity: ['capacity', '当前服务繁忙或已达到使用限额，请稍后再试；也可以尝试其他模型。', ['wait', 'switch_model']],
  model: ['model', '当前模型暂时无法处理这条消息，请重新选择模型后再试。', ['switch_model', 'contact_admin']],
  connection: ['connection', '连接暂时未能完成，请稍后再试；如果持续失败，请联系管理员。', ['wait', 'contact_admin']],
  execution: ['execution', '这次操作未能完成。请检查当前结果后重新尝试，持续失败时联系管理员。', ['check_settings', 'contact_admin']],
  storage: ['storage', '内容暂时无法读取或保存，请稍后刷新确认结果，持续失败时联系管理员。', ['refresh', 'contact_admin']],
  billing: ['billing', '当前无法完成费用或额度校验，请查看账户状态；如有疑问，请联系管理员。', ['check_settings', 'contact_admin']],
  cancelled: ['cancelled', '本次操作已停止。你可以发送新消息继续。', []],
  configuration: ['configuration', '此功能暂时不可用，请检查设置或联系管理员。', ['check_settings', 'contact_admin']],
  state: ['state', '当前任务状态不支持此操作，请等待任务结束或刷新后再试。', ['wait', 'refresh']],
  conflict: ['conflict', '相关内容或状态已发生变化，请刷新确认后再操作。', ['refresh']],
  not_found: ['not_found', '要访问的内容不存在或已失效，请刷新后重新选择。', ['refresh']],
  unknown: ['unknown', '这次操作未能完成，请确认当前结果；如果仍有问题，请联系管理员。', ['contact_admin']],
}

/** Complete turn coverage checked by TypeScript; retry/billing policy stays in the taxonomy. */
const TURN_COPY: Record<TurnErrorCode, readonly [UserErrorCategory, string]> = {
  insufficient_credits: ['billing', '可用积分不足，请补充积分或联系管理员后继续。'],
  rate_limited: ['capacity', '请求暂时较多，请稍后重试本条消息。'],
  model_capacity: ['capacity', '当前模型访问量较大，请稍后重试，或切换其他模型继续。'],
  upstream_failed: ['model', '模型服务暂时中断，请稍后重试本条消息。'],
  upstream_timeout: ['connection', '模型响应超时，请稍后重试本条消息。'],
  network_error: ['connection', '网络波动导致本轮中断，请检查连接后重试。'],
  context_too_long: ['context', GROUP_COPY.context[1]],
  request_too_large: ['size', GROUP_COPY.size[1]],
  bad_request: ['input', '这条请求无法处理，请调整消息或附件后再试。'],
  engine_error: ['execution', '本轮执行遇到问题，请重试；如果再次失败，可以换模型或联系管理员。'],
  internal_error: ['execution', '服务暂时遇到问题，请重试；如果持续失败，请联系管理员。'],
  auth_error: ['auth', '模型服务认证暂时失败，请重新尝试；如果持续失败，请联系管理员。'],
  platform_credential_expired: ['auth', '本轮模型访问凭证已过期，执行已停止。请重新发送消息继续。'],
  box_capacity_held: ['capacity', '上一轮任务仍在收尾，本条消息尚未开始。请稍后重新发送。'],
  service_restart: ['execution', '服务重启打断了本轮任务，请重新尝试。'],
  session_persist_unavailable: ['storage', '本轮内容暂时未能安全保存，请稍后刷新确认结果。'],
  session_deleted: ['not_found', '这个会话已被删除，请从回收站恢复，或新建会话继续。'],
  project_context_unavailable: ['storage', '会话所属项目的指令和文件暂时没有加载出来，请稍后重试。'],
  durable_dispatch_unavailable: ['execution', '本条消息暂时未能接入执行通道，请稍后重试。'],
  admission_restart_unexecuted: ['execution', '服务重启时任务尚未开始执行，请重新尝试。'],
  stopped: ['cancelled', '本轮生成已停止。'],
  user_cancelled: ['cancelled', '本轮已取消。'],
  runner_crashed: ['execution', '执行环境意外中断，请重新尝试。'],
  model_authority_expired: ['auth', '长任务的模型访问凭证未能续期，请重新尝试。'],
  liveness_timeout: ['execution', '任务长时间没有新进展，本轮已停止。请重新尝试或切换模型。'],
  idle_timeout: ['execution', '任务长时间没有新进展，本轮已停止。请重新尝试或切换模型。'],
  no_response: ['model', '模型未能产生有效回复，请重新尝试或切换模型。'],
  phantom_turn: ['model', '模型未能产生有效回复，请重新尝试或切换模型。'],
  turn_limit: ['execution', '任务达到本轮运行上限，请发送新消息继续。'],
  model_config_changed_retry_turn: ['model', '模型配置刚刚更新，本轮已停止。请重新发送消息继续。'],
  model_not_available: ['model', '当前模型暂时无法接收请求，请切换模型后重新发送。'],
  unresolved_agent_model: ['model', '没能确定本轮使用的模型，请重新选择模型后发送。'],
  model_authority_unavailable: ['model', '模型配置暂时无法读取，请稍后重试。'],
  model_catalog_unavailable: ['model', '模型列表暂时无法读取，请稍后重试。'],
  unauthorized_model: ['permission', '当前账号尚未开通此模型，请切换模型或联系管理员。'],
  unauthorized: ['auth', '登录状态已失效，请重新登录后继续。'],
  maintenance: ['configuration', '服务正在维护，请稍后再试。'],
  conn_kicked: ['connection', '连接已断开，正在重新连接。'],
  container_outdated: ['configuration', '运行环境需要更新，请刷新页面后重试；本地运行时请先更新。'],
  err_container: ['execution', '运行环境暂时不可用，请稍后重试。'],
  err_container_timeout: ['connection', '运行环境响应超时，请稍后重试。'],
  err_internal: ['execution', '服务暂时遇到问题，请稍后重试。'],
  forbidden: ['permission', GROUP_COPY.permission[1]],
  err_frame_too_big: ['size', GROUP_COPY.size[1]],
  bad_json: ['input', '消息格式无法识别，请刷新页面后重新发送。'],
  bad_sequence: ['state', '消息状态暂时未同步，请刷新确认后重试。'],
  unknown_control: ['input', '当前版本无法执行此操作，请刷新页面后重试。'],
  image_upstream_rejected: ['input', '图片请求未被接受，请调整描述或更换图片后再试。'],
  image_server_busy: ['capacity', '图片服务当前繁忙，请稍后重试。'],
  voice_upstream_error: ['connection', '语音识别服务暂时不可用，请重新录音或输入文字。'],
  voice_timeout: ['connection', '语音识别超时，请重新录音或输入文字。'],
  codex_turn_busy: ['state', '上一轮任务仍在运行，请等它结束后再发送。'],
  codex_pool_busy: ['capacity', '当前模型服务繁忙，请稍后重试或切换模型。'],
  codex_route_unavailable: ['connection', '模型连接暂时不可用，请稍后重试。'],
  codex_container_recycled: ['execution', '运行环境已重建，请刷新页面后重新发送。'],
  codex_billing: ['billing', '本轮费用校验暂时无法完成，请稍后重试。'],
  upstream_error: ['model', '模型服务暂时不可用，请稍后重试。'],
}

const CTA_ACTIONS: Record<TurnErrorCta, readonly UserErrorAction[]> = {
  retry: ['retry'], retry_or_switch: ['retry', 'switch_model'], topup: ['topup'],
  refresh: ['refresh'], switch_model: ['switch_model'], relogin: ['relogin'],
  new_session: ['new_session'], none: [],
}
const HTTP_COPY: Record<string, Copy> = {
  invalid_credentials: ['auth', '邮箱或密码不正确，请检查后重新输入。', ['edit_message', 'relogin']],
  email_not_verified: ['auth', '邮箱还未验证，请完成邮箱验证后再登录。', ['relogin']],
  turnstile_failed: ['input', '安全验证未通过，请刷新页面后再试。', ['refresh']],
  email_domain_blocked: ['permission', '暂不支持这个邮箱域名，请换一个邮箱或联系管理员。', ['edit_message', 'contact_admin']],
  weak_password: ['input', '密码强度不够，请按页面要求设置更安全的密码。', ['edit_message']],
  model_switch_insufficient_balance: ['billing', '可用积分不足，暂时无法完成模型切换。请补充积分或联系管理员。', ['topup', 'contact_admin']],
  model_switch_in_progress: ['state', '模型正在切换，请等待切换完成后再发送消息。', ['wait']],
  model_switch_expired: ['conflict', '这次模型切换确认已过期，请重新选择模型。', ['switch_model']],
  model_switch_stale: ['conflict', '会话状态已变化，请重新选择模型并确认切换。', ['switch_model']],
  model_switch_failed: ['model', '模型切换未完成，请重新选择模型；如果持续失败，请联系管理员。', ['switch_model', 'contact_admin']],
  model_authority_rejected: ['model', '本轮模型配置未通过校验，请重新选择模型后发送。', ['switch_model', 'contact_admin']],
  provision_timeout: ['connection', '运行环境启动超时，请稍后重试；如果持续失败，请联系管理员。', ['wait', 'contact_admin']],
}
function entry(code: string, copy: Copy, retryable = false): UserError {
  return { code, category: copy[0], retryable, userMessageKey: `errors.${code}`, message: copy[1], actions: copy[2] }
}

export const USER_ERROR_ACTION_LABELS: Record<UserErrorAction, string> = {
  retry: '重新发送', switch_model: '换个模型', contact_admin: '联系管理员',
  edit_message: '修改消息', relogin: '重新登录', refresh: '刷新', topup: '补充积分',
  new_session: '新建会话', wait: '稍后再试', check_settings: '检查设置',
}

export const USER_ERROR_CATALOG: Readonly<Record<string, UserError>> = Object.freeze({
  ...Object.fromEntries(Object.entries(HTTP_ERROR_GROUPS).flatMap(([category, codes]) =>
    codes.map((code) => [code, entry(code, HTTP_COPY[code] ?? GROUP_COPY[category as UserErrorCategory])]))),
  ...Object.fromEntries((Object.keys(TURN_ERROR_TAXONOMY) as TurnErrorCode[]).map((code) => {
    const semantics = turnErrorSemantics(code)
    const [category, message] = TURN_COPY[code]
    const actions = category === 'context' || category === 'size'
      ? GROUP_COPY[category][2]
      : CTA_ACTIONS[semantics.cta].length ? CTA_ACTIONS[semantics.cta] : GROUP_COPY[category][2]
    return [code, entry(code, [category, message, actions], semantics.retryable)]
  })),
  unexpected_error: entry('unexpected_error', GROUP_COPY.unknown),
  automatic_retry_exhausted: entry('automatic_retry_exhausted', ['execution',
    '已达到自动重试上限。你可以换个模型、重新发送，或联系管理员。', ['switch_model', 'retry', 'contact_admin']]),
  automatic_retry_paused: entry('automatic_retry_paused', ['execution',
    '自动重试已暂停，任务没有继续取得进展。请确认已有结果，再换模型、重新发送或联系管理员。',
    ['switch_model', 'retry', 'contact_admin']]),
  automatic_retry_refused: entry('automatic_retry_refused', ['execution',
    '自动重试未能开始执行。请确认已有结果，再换模型、重新发送或联系管理员。',
    ['switch_model', 'retry', 'contact_admin']]),
})

/** Display-only aliases; deliberately do not change normalizeTurnErrorCode's recovery/billing semantics. */
const DISPLAY_ALIASES: Record<string, string> = {
  prompt_too_large: 'context_too_long', prompt_too_long: 'context_too_long',
  antigravity_prompt_too_large: 'context_too_long',
  context_length_exceeded: 'context_too_long', max_context_length: 'context_too_long',
  payload_too_large: 'request_too_large', body_too_large: 'request_too_large',
  body_field_too_large: 'request_too_large', box_context_too_large: 'request_too_large',
  antigravity_credential_expired: 'platform_credential_expired',
  antigravity_route_expired: 'upstream_failed', antigravity_error_step: 'upstream_failed',
  dispatch_not_accepted: 'durable_dispatch_unavailable', codex_unavailable: 'codex_route_unavailable',
}
export function getUserError(rawCode: unknown): UserError {
  const code = normalizeTurnErrorCode(rawCode)
  const key = DISPLAY_ALIASES[code] ?? code
  return Object.prototype.hasOwnProperty.call(USER_ERROR_CATALOG, key)
    ? USER_ERROR_CATALOG[key]!
    : USER_ERROR_CATALOG.unexpected_error!
}

/** Add a presentation envelope without changing any legacy field, prompt or billing payload. */
export function withUserError<T>(body: T, httpStatus?: number): T & { userError?: UserError }
export function withUserError(body: unknown, httpStatus?: number): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body
  const record = body as Record<string, unknown>
  const isErrorFrame = record.type === 'error' || record.type === 'outbound.error'
  if (!isErrorFrame && !(httpStatus !== undefined && httpStatus >= 400)) return body
  const error = record.error && typeof record.error === 'object'
    ? record.error as Record<string, unknown> : undefined
  const code = record.code ?? error?.code ?? record.error
  return { ...body, userError: getUserError(code) }
}
