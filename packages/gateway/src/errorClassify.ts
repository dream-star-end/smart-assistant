/**
 * P1-3 — 流式错误分类。
 *
 * CCB 子进程 / runner 抛出的 error.message 是裸字符串,内含 HTTP 状态码、
 * Anthropic JSON、`INSUFFICIENT_CREDITS` 等关键字。前端要按错误"种类"渲染
 * 不同 UX(余额不足给"去充值",限流给"稍后再试",上游故障给"系统繁忙"),
 * 所以服务端用纯字符串匹配做一次粗分类。
 *
 * 故意只识别少量高确定性场景,其它一律回退 'unknown' → caller 仍发老的
 * `[error] ${msg}` 文本气泡,UX 不变。
 *
 * 新增 code 是跨包契约动作,必须三处同步:
 *   1. 本文件 ClassifiedErrorCode + PATTERNS(server-only 的 provider 原文识别);
 *   2. protocol turnErrorTaxonomy 的 TURN_ERROR_TAXONOMY(唯一权威语义表,决定
 *      retryable/cta/expected 等跨端语义);
 *   3. 若该 code 会进 wire OutboundError.code,同步 protocol frames.ts 的
 *      OutboundError.code Type.Union()。
 * 契约测试(turnErrorTaxonomyContract)锁 1↔2↔3 的 code 集合同源。
 */

export type ClassifiedErrorCode =
  | 'insufficient_credits'
  | 'rate_limited'
  | 'model_capacity'
  | 'model_config_changed_retry_turn'
  | 'upstream_failed'
  | 'context_too_long'
  | 'bad_request'
  | 'unknown'

export interface ClassifiedError {
  code: ClassifiedErrorCode
  /** 用户可见的简短文案 */
  message: string
}

export interface DelegateOutputError {
  code: ClassifiedErrorCode
  /** 用户可见的简短文案 */
  message: string
  /** 原始 CCB/API 错误文本,用于日志和 tool detail */
  detail: string
}

const PATTERNS: Array<{
  re: RegExp
  code: Exclude<ClassifiedErrorCode, 'unknown'>
  message: string
}> = [
  {
    re: /(?:"code"\s*:\s*"MODEL_CONFIG_CHANGED_RETRY_TURN")|(?:\\"code\\"\s*:\s*\\"MODEL_CONFIG_CHANGED_RETRY_TURN\\")/,
    code: 'model_config_changed_retry_turn',
    message: '模型配置已更新,请重发',
  },
  // anthropicProxy.ts:1362 sendJsonError(res, 402, "INSUFFICIENT_CREDITS", ...)
  // CCB 抛出的 message 形如 "402 INSUFFICIENT_CREDITS: insufficient credits: balance=... required=..."
  {
    re: /(?:insufficient[_ ]credits|INSUFFICIENT_CREDITS|\b402\b.*credit)/i,
    code: 'insufficient_credits',
    message: '余额不足,请充值后继续',
  },
  // 429 / RATE_LIMITED — Anthropic 直接返还,或本地 RATE_LIMITED reject
  {
    re: /(?:\b429\b|rate[_ ]?limit(?:ed)?|RATE_LIMITED)/i,
    code: 'rate_limited',
    message: '当前账号被限流,请稍后再试',
  },
  {
    re: /PROMPT_TOO_LONG|ran out of room in the model(?:'|’)s context window|context window (?:was )?(?:exceeded|too long)/i,
    code: 'context_too_long',
    message: '上下文长度超过模型上限',
  },
  {
    // CCB result terminals wrap the canonical assistant diagnostic inside
    // `{subtype,result}` JSON, so the marker is not necessarily at offset 0.
    re: /API Error:\s*400\b[\s\S]{0,500}(?:INVALID_REQUEST|invalid request)/i,
    code: 'bad_request',
    message: '这条请求无法被模型处理，请调整内容后重试',
  },
  // 模型容量满载 —— 上游"at capacity"/overloaded/model busy 词族。与 upstream_failed
  // 的区别是语义可行动:同模型稍后可用、换模型立即可用(taxonomy cta=retry_or_switch)。
  // 必须排在 upstream_failed 之前:"overloaded" 常与 5xx/upstream 措辞同现,先命中
  // 更精确的容量语义,否则被泛化上游正则吞成 upstream_failed。本函数只喂错误串,
  // 不会误伤用户正文里的 "capacity"。
  //
  // 审计 R1:裸 `529` 归容量档(Anthropic 529 = overloaded,是容量语义而非泛上游
  // 故障)。它必须在此(upstream 之前)显式命中,否则会被下面的通用 `\b5\d{2}\b`
  // 吞成 upstream_failed。词族之外单列 `\b529\b`,与词族 OR 平级。
  {
    re: /at capacity|capacity.{0,40}(?:limit|exceed|full)|overloaded|model.{0,20}busy|try a different model|\b529\b/i,
    code: 'model_capacity',
    message: '模型繁忙,请稍后重试或切换模型',
  },
  // 通用 5xx / 上游连接失败。
  // 审计 R1:
  //   - `\b5\d{2}\b` 覆盖全部 5xx(不再只认 502/503/504)。边界写法与旧
  //     `\b50[234]\b` 一致 —— 只匹配被非字词字符界定的三位数,不误伤 "523ms"
  //     这类嵌字词的数字(3 与 m 之间无 \b),把误伤面控制在与旧正则同一量级。
  //     529 已被上面的容量档抢先命中(顺序 credits→429→capacity→upstream),
  //     402/429 分别归 credits/rate_limited(均排在本档之前),不会被本正则劫走。
  //   - ECONNREFUSED / EAI_AGAIN 补齐连接被拒与 DNS 瞬时失败两类网络错误。
  {
    re: /(?:\b5\d{2}\b|upstream|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ACCOUNT_POOL_(?:BUSY|UNAVAILABLE)|UPSTREAM_FAILED)/i,
    code: 'upstream_failed',
    message: 'Anthropic 上游异常,请稍后重试',
  },
]

export function classifyRunError(raw: string | undefined | null): ClassifiedError {
  const s = String(raw ?? '')
  if (!s) return { code: 'unknown', message: '' }
  for (const p of PATTERNS) {
    if (p.re.test(s)) return { code: p.code, message: p.message }
  }
  return { code: 'unknown', message: '' }
}

/**
 * 已知语义码 → 规范中文文案。给 runner 已预分类(errorClass)但没有可再匹配的
 * 原文时用:server.ts 拿到 errorClass 后按码取文案,与 classifyRunError 的 message
 * 同源(PATTERNS 是唯一权威,不另建平行文案表)。未在 PATTERNS 出现的码返回空串。
 */
export function classifiedMessageForCode(code: Exclude<ClassifiedErrorCode, 'unknown'>): string {
  const hit = PATTERNS.find((p) => p.code === code)
  return hit ? hit.message : ''
}

export function classifyDelegateOutputError(
  raw: string | undefined | null,
): DelegateOutputError | null {
  const detail = String(raw ?? '').trim()
  if (!detail) return null
  // CCB's createAssistantAPIErrorMessage emits upstream API failures as a
  // normal assistant text block that starts with this prefix.  Do not classify
  // arbitrary prose that merely mentions "API Error".
  if (!/^API Error:\s*(?:\d{3}\b|\{)/i.test(detail)) return null

  if (/\b400\b[\s\S]{0,200}\bBAD_BODY\b|\bBAD_BODY\b[\s\S]{0,200}\binvalid request body\b|"code"\s*:\s*"BAD_BODY"/i.test(detail)) {
    return {
      code: 'bad_request',
      message: '子 agent 请求体无效,请降低思考深度或稍后重试',
      detail,
    }
  }

  const cls = classifyRunError(detail)
  return cls.code === 'unknown'
    ? null
    : { code: cls.code, message: cls.message, detail }
}
