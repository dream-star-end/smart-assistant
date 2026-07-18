/**
 * Turn 错误语义单一权威表(2026-07-18 turn-retry 批,Codex 设计审 v3 PASS)。
 *
 * 背景:错误码→UX 语义此前散在三处手写映射(gateway errorClassify、前端
 * ERROR_LABELS 标题表、前端 friendlyBridgeErrorMessage 正文表),key 集合
 * 互相漂移(upstream_failed 有正文没标题→红卡标题回退「出错了」;capacity
 * 词表缺失→裸串直达用户)。本表收敛为唯一权威:
 *
 *   - **这里只放跨端稳定语义**:retryable / cta / allowPublicServerMessage /
 *     expected / waivable。**中文文案不进 protocol**(标题/正文留在前端,按
 *     本表 key 派生;gateway 的 provider 原文识别正则留在 errorClassify,
 *     server-only)。三方靠契约测试锁 key 集合同源,不靠 import 同一份文案。
 *   - gateway 发出的一切 turn 级错误码(outbound.error.code、tape _errorCode、
 *     bridge error 帧 code)归一化后必须 ∈ 本表;新增码先加表再发帧。
 *   - legacy tape 控制码(大写 ENGINE_ERROR/NO_RESPONSE/…)通过
 *     normalizeTurnErrorCode 映射到小写语义码;**大写原值仍原样持久化**
 *     (免单查询 internalTurnWaive 按大写码精确匹配,不迁移存量)。
 */

/** 红卡/错误气泡的行动引导。前端按枚举渲染按钮,不自由发挥。 */
export type TurnErrorCta =
  /** 精确重发原轮(需 _clientMessageId 命中,见 CTA 硬门) */
  | 'retry'
  /** 重试或切换模型(容量类:同模型稍后可用,换模型立即可用) */
  | 'retry_or_switch'
  | 'topup'
  | 'refresh'
  | 'switch_model'
  | 'relogin'
  | 'none'

export interface TurnErrorSemantics {
  /** 瞬时错误:同请求稍后重试有意义(自动重试资格的必要非充分条件)。 */
  retryable: boolean
  cta: TurnErrorCta
  /**
   * 帧携带的服务端 message 允许直接展示给用户(白名单;展示侧仍须过
   * 长度 ≤200 字符且非 JSON/堆栈形态的守卫)。缺省 false:未知/上游原文
   * 只进服务端日志与「查看详情」的脱敏摘要。
   */
  allowPublicServerMessage?: boolean
  /** 预期业务态(用户意图/业务规则的正常分支,非故障)。 */
  expected?: boolean
  /**
   * 是否进错误遥测(前端 reportTurnError)。**与 expected 解耦**(Codex 审计
   * R4-5c 裁定):capacity/图片繁忙这类"对单用户是预期态"的码,对平台是
   * 运营故障信号,必须保持上报聚合。缺省 true;只有用户主动行为(停止/
   * 取消)与纯业务规则拒绝(未开通/配置变更)才 false。
   */
  reportable?: boolean
  /** 免单类:命中即走自动免单展示分支(前端 WAIVED_ERROR_CODES 由此派生)。 */
  waivable?: boolean
}

/**
 * key = 归一化语义码(小写 snake_case)。
 * 注释标注每码的发射源,防止"表里有码但无人发射"的僵尸项。
 */
export const TURN_ERROR_TAXONOMY = {
  // ── 计费/配额 ────────────────────────────────────────────
  insufficient_credits: { retryable: false, cta: 'topup', expected: true, reportable: false },
  rate_limited: { retryable: true, cta: 'retry', expected: true },

  // ── 上游模型服务(errorClassify / codex runner 分类产物)────
  /** 新增:模型容量满载("at capacity"/overloaded/model busy 词族)。 */
  model_capacity: { retryable: true, cta: 'retry_or_switch', expected: true },
  upstream_failed: { retryable: true, cta: 'retry' },
  /** 上游请求超时(errorClassify 词族;历史前端码 upstream_timeout 归并于此)。 */
  upstream_timeout: { retryable: true, cta: 'retry' },
  network_error: { retryable: true, cta: 'retry' },
  context_too_long: { retryable: false, cta: 'none' },
  bad_request: { retryable: false, cta: 'none' },

  // ── 引擎/平台执行 ────────────────────────────────────────
  engine_error: { retryable: true, cta: 'retry' },
  internal_error: { retryable: true, cta: 'retry' },
  auth_error: { retryable: false, cta: 'relogin' },
  service_restart: { retryable: true, cta: 'retry', expected: true },
  session_persist_unavailable: { retryable: true, cta: 'retry' },
  stopped: { retryable: false, cta: 'none', expected: true, reportable: false },
  user_cancelled: { retryable: false, cta: 'none', expected: true, reportable: false },
  runner_crashed: { retryable: true, cta: 'retry' },

  // ── 免单类(tape 大写码归一化后落这里;waive 查询仍用大写原值)──
  model_authority_expired: { retryable: false, cta: 'retry', waivable: true },
  liveness_timeout: { retryable: false, cta: 'retry', waivable: true },
  idle_timeout: { retryable: false, cta: 'retry', waivable: true },
  no_response: { retryable: false, cta: 'retry', waivable: true },
  phantom_turn: { retryable: false, cta: 'retry', waivable: true },
  turn_limit: { retryable: false, cta: 'none', waivable: true },

  // ── 模型权威 gate 拒帧(bridge/egress)─────────────────────
  model_config_changed_retry_turn: { retryable: false, cta: 'retry', expected: true, reportable: false },
  model_not_available: { retryable: false, cta: 'switch_model', expected: true, reportable: false },
  unresolved_agent_model: { retryable: false, cta: 'switch_model' },
  model_authority_unavailable: { retryable: true, cta: 'retry' },
  model_catalog_unavailable: { retryable: true, cta: 'retry' },
  unauthorized_model: { retryable: false, cta: 'switch_model', expected: true, reportable: false },

  // ── 连接/环境(bridge error 帧码归一化产物)────────────────
  unauthorized: { retryable: false, cta: 'relogin' },
  maintenance: { retryable: false, cta: 'none', expected: true, reportable: false },
  conn_kicked: { retryable: true, cta: 'none', expected: true, reportable: false },
  /** 运行环境已重建:重试无效,必须刷新页面(服务端 message 指路,可信展示)。 */
  container_outdated: { retryable: false, cta: 'refresh', allowPublicServerMessage: true },
  err_container: { retryable: true, cta: 'retry' },
  err_container_timeout: { retryable: true, cta: 'retry' },
  err_internal: { retryable: true, cta: 'retry' },
  forbidden: { retryable: false, cta: 'none' },
  err_frame_too_big: { retryable: false, cta: 'none' },
  bad_json: { retryable: false, cta: 'none' },
  bad_sequence: { retryable: true, cta: 'retry' },
  unknown_control: { retryable: false, cta: 'none' },

  // ── 媒体/子系统(服务端已产出用户向原因,白名单展示)────────
  /** 图片生成/编辑上游拒绝(含审核拦截:服务端 message 说明换图/改词)。 */
  image_upstream_rejected: { retryable: false, cta: 'none', allowPublicServerMessage: true },
  image_server_busy: { retryable: true, cta: 'retry', expected: true },
  voice_upstream_error: { retryable: true, cta: 'retry' },
  voice_timeout: { retryable: true, cta: 'retry' },

  // ── 遗留兼容(新 bridge 不再发射;归一化仍认,防旧 master 回滚窗残帧)──
  codex_turn_busy: { retryable: true, cta: 'none', expected: true, reportable: false },
  codex_pool_busy: { retryable: true, cta: 'retry', expected: true, reportable: false },
  codex_route_unavailable: { retryable: true, cta: 'retry', expected: true, reportable: false },
  codex_container_recycled: { retryable: true, cta: 'retry', expected: true, reportable: false },
  codex_billing: { retryable: true, cta: 'retry' },
  /** 历史前端码(与 upstream_failed 语义重复,仅存量会话水合可见)。 */
  upstream_error: { retryable: true, cta: 'retry' },
} as const satisfies Record<string, TurnErrorSemantics>

export type TurnErrorCode = keyof typeof TURN_ERROR_TAXONOMY

/**
 * legacy 大写 tape/终态控制码 → 语义码。
 * **只用于展示/语义判定;持久化与免单查询继续用大写原值**(internalTurnWaive
 * 按 _errorCode=ANY('{NO_RESPONSE,PHANTOM_TURN,…}') 精确匹配存量,不迁移)。
 */
const LEGACY_CODE_ALIASES: Record<string, TurnErrorCode> = {
  ENGINE_ERROR: 'engine_error',
  AUTH_ERROR: 'auth_error',
  MODEL_AUTHORITY_EXPIRED: 'model_authority_expired',
  NO_RESPONSE: 'no_response',
  PHANTOM_TURN: 'phantom_turn',
  LIVENESS_TIMEOUT: 'liveness_timeout',
  IDLE_TIMEOUT: 'idle_timeout',
  TURN_LIMIT: 'turn_limit',
  USER_CANCELLED: 'user_cancelled',
  RUNNER_CRASHED: 'runner_crashed',
  CODEX_ERROR: 'engine_error',
  INSUFFICIENT_CREDITS: 'insufficient_credits',
  ERR_INSUFFICIENT_CREDITS: 'insufficient_credits',
  UNAUTHORIZED_MODEL: 'unauthorized_model',
  MAINTENANCE: 'maintenance',
  ERR_CONN_KICKED: 'conn_kicked',
  CONN_KICKED: 'conn_kicked',
  ERR_BACKPRESSURE: 'conn_kicked',
  RATE_LIMITED: 'rate_limited',
  UPSTREAM_FAILED: 'upstream_failed',
}

/**
 * 归一化任意来源的错误码(帧 code / tape _errorCode / bridge 码)到语义码。
 * 未知码返回小写原串(调用方可用 isKnownTurnErrorCode 判定后走兜底 UX),
 * 空值返回 'unknown'。
 */
export function normalizeTurnErrorCode(raw: unknown): string {
  const s = String(raw ?? '').trim()
  if (!s) return 'unknown'
  const alias = LEGACY_CODE_ALIASES[s.toUpperCase()]
  if (alias) return alias
  return s.toLowerCase()
}

export function isKnownTurnErrorCode(code: string): code is TurnErrorCode {
  return Object.prototype.hasOwnProperty.call(TURN_ERROR_TAXONOMY, code)
}

/** 语义查询:未知码按"不可自动重试、无 CTA、不可信 message"保守兜底。 */
export function turnErrorSemantics(code: string): TurnErrorSemantics {
  if (isKnownTurnErrorCode(code)) return TURN_ERROR_TAXONOMY[code]
  return { retryable: false, cta: 'none' }
}

/** 派生集合(前端 EXPECTED_TURN_ERR_CODES / WAIVED_ERROR_CODES 的权威源)。 */
const _taxonomyView: Record<string, TurnErrorSemantics> = TURN_ERROR_TAXONOMY
export const EXPECTED_TURN_ERROR_CODES: ReadonlySet<string> = new Set(
  Object.keys(_taxonomyView).filter((k) => _taxonomyView[k].expected === true),
)
export const WAIVED_TURN_ERROR_CODES: ReadonlySet<string> = new Set(
  Object.keys(_taxonomyView).filter((k) => _taxonomyView[k].waivable === true),
)
/** 不进错误遥测的码(前端 reportTurnError 豁免集;与 expected 解耦,见字段注释)。 */
export const REPORT_EXEMPT_TURN_ERROR_CODES: ReadonlySet<string> = new Set(
  Object.keys(_taxonomyView).filter((k) => _taxonomyView[k].reportable === false),
)

/**
 * allowPublicServerMessage 码的展示守卫:长度与形态约束(≤200 字符、
 * 非 JSON/堆栈/内部串形态)。两端(gateway 组帧、前端渲染)都必须调用;
 * 不通过则回退按码文案。
 */
export function isDisplayableServerMessage(message: unknown): message is string {
  if (typeof message !== 'string') return false
  const s = message.trim()
  if (!s || s.length > 200) return false
  if (/^[\[{]/.test(s)) return false
  if (/"(?:error|errors|status|code)"\s*:|\bat\s+\S+\s*\(|https?:\/\//i.test(s)) return false
  return true
}
