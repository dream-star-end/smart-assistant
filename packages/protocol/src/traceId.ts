/**
 * V3 S12e trace_id primitives — shared by master / gateway / node-agent Go side
 * via fixture (packages/protocol/testdata/trace-id-cases.json).
 *
 * Two functions, single responsibility each (v3 MAJOR 1 应对,拆分原 v2 normalizeTraceId):
 *   - newTraceId()            纯生成 canonical(16 bytes hex, 32 chars)
 *   - parseTraceIdCandidate() 纯校验,不做 fallback —— 调用方根据语义决定 fallback / log / drop
 *
 * 设计动机:不同调用点 fallback 策略不同:
 *   - master inbound canonical 生成 → 直接 newTraceId(),不读客户端 turn-level 值
 *   - gateway WS upgrade connection trace → ok 用 raw,issue 用 newTraceId() + warn
 *   - master observation clientTraceId → ok 存 logger,issue 只记 issue 名不存 raw(防 log injection)
 *
 * Issue 枚举单独导出,logger 用于记录"非法 client 值"事件而**不**带 raw 值
 * —— 攻击者无法通过 raw 字符串污染日志 / 撑大字段。
 */

import { randomBytes } from 'node:crypto'

/** trace id 合法字符集 + 长度。Go 端的 ParseTraceIDCandidate 必须遵守同一 regex。 */
export const TRACE_ID_REGEX = /^[A-Za-z0-9_-]{16,64}$/

// 字符集本身(任意长度,含空字符串):用于诊断时优先判定 bad-charset 而非
// too-short(语义:"   " 三个空格 → bad-charset,不是 too-short — 见 plan §3.6
// fixture 与 v4 NIT 2)。这是 helper 精度;Go ParseTraceIDCandidate 必须遵循
// 同一优先级:missing → wrong-type → empty → bad-charset → too-short → too-long。
const TRACE_ID_CHARSET = /^[A-Za-z0-9_-]+$/

/** 16 bytes hex = 32 chars, 与 ensureRequestId 一致;落到 TRACE_ID_REGEX 合法范围内。 */
export function newTraceId(): string {
  return randomBytes(16).toString('hex')
}

/**
 * HTTP / WS upgrade 请求里 trace 透传的标准头名。
 *
 * - **小写**:符合 HTTP/1.1 header field 名大小写不敏感 + Node http 的 req.headers
 *   总是小写键的实现,也是 Go net/http CanonicalMIMEHeaderKey 解析后等价的形式
 * - 用途:
 *   - master → node-agent mTLS RPC(CG3)
 *   - master → node-agent WS tunnel upgrade(CG4)
 *   - node-agent → container 内部转发头(CG5)
 *   - node-agent Go 端通过 CanonicalMIMEHeaderKey 转 "X-Openclaude-Trace-Id"
 *     读出,跨语言由 fixture(CG10)对齐
 */
export const TRACE_ID_HEADER = 'x-openclaude-trace-id'

/** parseTraceIdCandidate 失败原因枚举。logger 只记此 enum,**不**记 raw 值。 */
export type TraceIdIssue =
  | 'missing' //     undefined / null
  | 'wrong-type' //  非 string
  | 'empty' //       空字符串
  | 'too-short' //   长度 < 16
  | 'too-long' //    长度 > 64
  | 'bad-charset' // 不符 TRACE_ID_REGEX

/**
 * 校验 raw 是否符合 trace id 格式。
 * - 合法:`{ ok: true, traceId }`
 * - 非法:`{ ok: false, issue }` —— 调用方决定 fallback,helper 不隐藏决策
 *
 * Header 数组(Node HTTP API 多值头 `string[]`)由调用方做 "first value unwrap"
 * 后再传入;本函数直接收到数组会按 `wrong-type` 拒绝。
 */
export function parseTraceIdCandidate(
  raw: unknown,
): { ok: true; traceId: string } | { ok: false; issue: TraceIdIssue } {
  if (raw === undefined || raw === null) return { ok: false, issue: 'missing' }
  if (typeof raw !== 'string') return { ok: false, issue: 'wrong-type' }
  if (raw.length === 0) return { ok: false, issue: 'empty' }
  // charset 优先于 length:`"   "` 这种 whitespace-only 应归 bad-charset 而非
  // too-short(空格不在合法字符集内)。否则 logger 会得到误导性的 "too-short"
  // 警告,排查时怀疑长度问题反而忽略了真正的注入风险。
  if (!TRACE_ID_CHARSET.test(raw)) return { ok: false, issue: 'bad-charset' }
  if (raw.length < 16) return { ok: false, issue: 'too-short' }
  if (raw.length > 64) return { ok: false, issue: 'too-long' }
  return { ok: true, traceId: raw }
}
