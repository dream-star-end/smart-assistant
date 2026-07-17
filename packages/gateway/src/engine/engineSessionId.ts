/**
 * engineSessionId — engine-reported 计费底座(codex 等)turn 记账用的稳定
 * session id 口径(v5-engine-adapter-PLAN §engineSessionId.ts)。
 *
 * 背景:CCB turn 的 usage_records.session_id = CCB 原生 session_id(anthropicProxy
 * 从 LLM metadata 提取)。codex 没有等价物(thread_id 会随 recycle 轮换,containerId
 * 粒度错误)，因此 usage_records.session_id 需要一个从 sessionKey 派生、
 * 跨重启稳定的合法 id，用于会话聚合、费用审计和重连恢复。
 *
 * 算法钉死(方案评审吸收项,禁止各模块自行 hash):
 *   engineSessionId(sessionKey) = 'oceng-' + sha256(sessionKey).hex.slice(0, 48)
 * 共 54 字符('oceng-' 6 + hex 48)。本 helper 是该会话维度的唯一权威。
 * 免单/退款不再使用这个 id，而按 turnKey / parentTurnKey 精确归因。
 *
 * M0 只落 helper + 测试;接线在 M2 计费。
 */
import { createHash } from 'node:crypto'

export const ENGINE_SESSION_ID_PREFIX = 'oceng-'

export function engineSessionId(sessionKey: string): string {
  const digest = createHash('sha256').update(sessionKey, 'utf8').digest('hex')
  return ENGINE_SESSION_ID_PREFIX + digest.slice(0, 48)
}
