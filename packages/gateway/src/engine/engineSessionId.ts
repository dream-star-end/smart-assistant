/**
 * engineSessionId — engine-reported 计费底座(codex 等)turn 记账用的稳定
 * session id 口径(v5-engine-adapter-PLAN §engineSessionId.ts)。
 *
 * 背景:CCB turn 的 usage_records.session_id = CCB 原生 session_id(anthropicProxy
 * 从 LLM metadata 提取)。codex 没有等价物(thread_id 会随 recycle 轮换,containerId
 * 粒度错误),而 idle-timeout 退款(refund.ts)与免单上报(internalTurnWaive.ts)都按
 * session_id 圈定退款窗口 —— 需要一个从 sessionKey 派生、跨重启稳定、且满足端点校验
 * `SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/` 的合法 id。
 *
 * 算法钉死(方案评审吸收项,禁止各模块自行 hash):
 *   engineSessionId(sessionKey) = 'oceng-' + sha256(sessionKey).hex.slice(0, 48)
 * 共 54 字符('oceng-' 6 + hex 48),不放宽端点校验。settle 落库与 waive 上报
 * 必须用同一值 —— 本 helper 是唯一权威。
 *
 * M0 只落 helper + 测试;接线在 M2 计费。
 */
import { createHash } from 'node:crypto'

export const ENGINE_SESSION_ID_PREFIX = 'oceng-'

export function engineSessionId(sessionKey: string): string {
  const digest = createHash('sha256').update(sessionKey, 'utf8').digest('hex')
  return ENGINE_SESSION_ID_PREFIX + digest.slice(0, 48)
}
