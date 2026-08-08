import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { paths } from './paths.js'

export const MEMORY_TURN_POLICY_TTL_MS = 120_000
export const MEMORY_TURN_POLICY_REFRESH_MS = 60_000

export type MemoryTurnPolicyReason =
  | 'clean_default'
  | 'on_demand_core'
  | 'explicit_ignore'
  | 'explicit_continuity'
  | 'trusted_cron'
  | 'inherited_parent_core'
  | 'inherited_parent_allow'
  | 'inherited_parent_deny'

export interface MemoryTurnPolicyDecision {
  allowed: boolean
  reason: MemoryTurnPolicyReason
}

interface MemoryTurnPolicyRecord extends MemoryTurnPolicyDecision {
  schemaVersion: 1
  expiresAt: number
}
const MEMORY_TURN_POLICY_REASONS = new Set<MemoryTurnPolicyReason>([
  'clean_default', 'on_demand_core', 'explicit_ignore', 'explicit_continuity', 'trusted_cron',
  'inherited_parent_core', 'inherited_parent_allow', 'inherited_parent_deny',
])

const IGNORE_MEMORY_RE =
  /(?:忽略|不要|不用|无需|禁止|不需要|不再).{0,16}(?:历史|记忆|过去|旧(?:会话|信息))|(?:从头|重新|全新)开始|新开会话不要加载记忆|ignore.{0,16}(?:history|memory)|forget.{0,16}(?:history|memory)|start (?:over|fresh)/iu
const CONTINUITY_RES = [
  // Explicit references to prior work or stored user facts.
  /(?:之前|上次)(?:的)?(?:会话|讨论|决定|任务|结果|建议|方案)|过去(?:的)?(?:会话|讨论|决定)|(?:你)?还记得|回忆(?:一下)?(?:我们|我之前|上次)/u,
  /(?:按|按照|根据)我的(?:偏好|习惯|要求|持仓|投资组合|病史|项目)|我的(?:持仓|投资组合|病史|长期偏好|长期习惯)/u,
  /(?:用|使用|基于|根据|检索|查找|搜索).{0,12}(?:已保存(?:的)?(?:资料|记录|内容)?|记忆|历史|会话|记录|归档)/u,
  // Imperative/deictic continuation. Bare language keywords or nouns such as
  // “继续教育” / “continue in JavaScript” deliberately do not match.
  /^\s*(?:(?:请)?(?:继续|接着)\s*[。！？!?]?\s*$|(?:请)?(?:继续|接着)(?:处理|完成|分析|做|审查|回答|生成|修改|执行|推进|说|给|这个|该|刚才|上次|之前|往下))/u,
  /(?:基于|按照).{0,12}(?:会话|讨论|历史)/u,
  /(?:our|the|my) (?:previous|last) (?:conversation|discussion|decision|session|task|result|recommendation)|last time/iu,
  /^(?:please\s+)?continue(?:\s+(?:with|from|where|this|that|the|working\s+on)|\s*[.!?]?\s*$)/iu,
  /(?:based on|according to|using|use).{0,20}(?:my (?:preferences|habits|requirements|portfolio|medical history|saved (?:facts|records|material))|what you know about me)|what (?:do )?you (?:know|remember) about me/iu,
  /(?:search|find|retrieve|recall).{0,20}(?:saved|memory|history|conversation|session|archive|record)/iu,
]

export function classifyMemoryTurnPolicy(
  userText: string,
  channel?: string,
): MemoryTurnPolicyDecision {
  if (channel === 'cron') return { allowed: true, reason: 'trusted_cron' }
  if (IGNORE_MEMORY_RE.test(userText)) return { allowed: false, reason: 'explicit_ignore' }
  if (CONTINUITY_RES.some((pattern) => pattern.test(userText)))
    return { allowed: true, reason: 'explicit_continuity' }
  // Default is a capability for high-confidence Core lookup, not permission to
  // scan old sessions/archives. The agent instructions still require a concrete
  // task dependency, and Core's semantic no-match gate filters unrelated topics.
  return { allowed: true, reason: 'on_demand_core' }
}

export function inheritMemoryTurnPolicy(
  parent: MemoryTurnPolicyDecision | null,
): MemoryTurnPolicyDecision {
  if (!parent?.allowed) return { allowed: false, reason: 'inherited_parent_deny' }
  if (parent.reason === 'on_demand_core' || parent.reason === 'inherited_parent_core') {
    return { allowed: true, reason: 'inherited_parent_core' }
  }
  return { allowed: true, reason: 'inherited_parent_allow' }
}

function policyPath(sessionKey: string): string {
  const key = createHash('sha256').update(sessionKey).digest('hex')
  return join(paths.home, '.memory-turn-policy', `${key}.json`)
}

export async function writeMemoryTurnPolicy(
  sessionKey: string,
  decision: MemoryTurnPolicyDecision,
  now = Date.now(),
): Promise<void> {
  const target = policyPath(sessionKey)
  const dir = join(paths.home, '.memory-turn-policy')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const tmp = `${target}.tmp-${randomUUID()}`
  const record: MemoryTurnPolicyRecord = {
    schemaVersion: 1,
    allowed: decision.allowed,
    reason: decision.reason,
    expiresAt: now + MEMORY_TURN_POLICY_TTL_MS,
  }
  try {
    await writeFile(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    await rename(tmp, target)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

export async function readMemoryTurnPolicy(
  sessionKey: string,
  now = Date.now(),
): Promise<MemoryTurnPolicyDecision | null> {
  try {
    const parsed = JSON.parse(await readFile(policyPath(sessionKey), 'utf8')) as Partial<MemoryTurnPolicyRecord>
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.allowed !== 'boolean' ||
      typeof parsed.reason !== 'string' ||
      !MEMORY_TURN_POLICY_REASONS.has(parsed.reason as MemoryTurnPolicyReason) ||
      !Number.isSafeInteger(parsed.expiresAt) ||
      (parsed.expiresAt as number) <= now
    ) return null
    return { allowed: parsed.allowed, reason: parsed.reason as MemoryTurnPolicyReason }
  } catch {
    return null
  }
}

export async function clearMemoryTurnPolicy(sessionKey: string): Promise<void> {
  await rm(policyPath(sessionKey), { force: true })
}

export function isManagedAgentRuntime(
  markerExists: (path: string) => boolean = existsSync,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.OC_MANAGED_AGENT_RUNTIME === '1' || markerExists('/run/oc/claude-config')
}
