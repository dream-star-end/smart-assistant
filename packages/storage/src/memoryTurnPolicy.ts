import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { paths } from './paths.js'

export const MEMORY_TURN_POLICY_TTL_MS = 120_000
export const MEMORY_TURN_POLICY_REFRESH_MS = 60_000

/** Durable V5 sandbox volume. Used only when HOME is a Cursor ephemeral dir
 *  and neither OPENCLAUDE_HOME nor OC_MEMORY_POLICY_HOME is set. */
export const MANAGED_AGENT_OPENCLAUDE_HOME = '/home/agent/.openclaude'

/** Cursor's oc-cursor wrapper replaces HOME with /tmp/openclaude-cursor.*. */
export const CURSOR_EPHEMERAL_HOME_RE = /^\/tmp\/openclaude-cursor[./]/

export type MemoryTurnPolicyReason =
  | 'clean_default'
  | 'on_demand_core'
  | 'on_demand_session'
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
  'clean_default', 'on_demand_core', 'on_demand_session', 'explicit_ignore',
  'explicit_continuity', 'trusted_cron',
  'inherited_parent_core', 'inherited_parent_allow', 'inherited_parent_deny',
])

/** Default when the user did not ask to ignore history. Core + session-search
 *  are in-scope. Archival is also reachable today because mcp-memory gates
 *  session/archival with the same `on_demand_core` check — a new reason is
 *  the only way to open session-search without editing that package. */
export const DEFAULT_MEMORY_SEARCH_POLICY: MemoryTurnPolicyDecision = {
  allowed: true,
  reason: 'on_demand_session',
}

const IGNORE_MEMORY_RE =
  /(?:忽略|不要|不用|无需|禁止|不需要|不再).{0,16}(?:历史|记忆|过去|旧(?:会话|信息))|(?:从头|重新|全新)开始|新开会话不要加载记忆|ignore.{0,16}(?:history|memory)|forget.{0,16}(?:history|memory)|start (?:over|fresh)/iu
const CONTINUITY_RES = [
  // Explicit references to prior work or stored user facts.
  /(?:之前|上次)(?:的)?(?:会话|讨论|决定|任务|结果|建议|方案)|过去(?:的)?(?:会话|讨论|决定)|(?:你)?还记得|回忆(?:一下)?(?:我们|我之前|上次)/u,
  // Deictic “that earlier one” and bounded 之前/上次 … 会话 (the live miss
  // “之前那个参照 dashi-taskboard … 的会话，继续推进” lives here).
  /(?:之前|上次|刚才|上一次)那个|(?:之前|上次|上一次).{0,48}(?:会话|讨论|任务)/u,
  /(?:按|按照|根据)我的(?:偏好|习惯|要求|持仓|投资组合|病史|项目)|我的(?:持仓|投资组合|病史|长期偏好|长期习惯)/u,
  /(?:用|使用|基于|根据|检索|查找|搜索).{0,12}(?:已保存(?:的)?(?:资料|记录|内容)?|记忆|历史|会话|记录|归档)/u,
  // Imperative/deictic continuation. Bare language keywords or nouns such as
  // “继续教育” / “continue in JavaScript” deliberately do not match.
  /^\s*(?:(?:请)?(?:继续|接着)\s*[。！？!?]?\s*$|(?:请)?(?:继续|接着)(?:处理|完成|分析|做|审查|回答|生成|修改|执行|推进|说|给|这个|该|刚才|上次|之前|往下))/u,
  // Same verbs mid-sentence (“…会话，继续推进” / “接着上次” / “延续上次”).
  /(?:请)?(?:继续|接着)(?:推进|上次|刚才|之前|往下)|接着上次|延续(?:上次|之前|这个|该|会话|讨论|工作|任务)/u,
  /(?:基于|按照).{0,12}(?:会话|讨论|历史)/u,
  /(?:our|the|my) (?:previous|last) (?:conversation|discussion|decision|session|task|result|recommendation)|last time/iu,
  /^(?:please\s+)?continue(?:\s+(?:with|from|where|this|that|the|working\s+on)|\s*[.!?]?\s*$)/iu,
  /\bfollow[- ]ups?\b/iu,
  /^(?:please\s+)?resume(?:\s+(?:from|where|this|that|the|with)|\s*[.!?]?\s*$)/iu,
  /\bresume\s+(?:the\s+)?(?:previous|last|prior|earlier)\b/iu,
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
  return { ...DEFAULT_MEMORY_SEARCH_POLICY }
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

export function resolveMemoryTurnPolicyRoot(
  env: NodeJS.ProcessEnv = process.env,
  loadedHome: string = paths.home,
  markerExists: (path: string) => boolean = existsSync,
  durableFallback: string = MANAGED_AGENT_OPENCLAUDE_HOME,
): string {
  const pinned = firstNonEmpty(env.OC_MEMORY_POLICY_HOME, env.OPENCLAUDE_HOME)
  if (pinned) return pinned
  const home = env.HOME ?? ''
  if (CURSOR_EPHEMERAL_HOME_RE.test(home) && markerExists(durableFallback)) {
    return durableFallback
  }
  return loadedHome
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

function policyPath(sessionKey: string, root = resolveMemoryTurnPolicyRoot()): string {
  const key = createHash('sha256').update(sessionKey).digest('hex')
  return join(root, '.memory-turn-policy', `${key}.json`)
}

function isStickyDeny(decision: MemoryTurnPolicyDecision): boolean {
  return !decision.allowed
    || decision.reason === 'explicit_ignore'
    || decision.reason === 'inherited_parent_deny'
}

function asDecision(parsed: Partial<MemoryTurnPolicyRecord>): MemoryTurnPolicyDecision | null {
  if (
    parsed.schemaVersion !== 1
    || typeof parsed.allowed !== 'boolean'
    || typeof parsed.reason !== 'string'
    || !MEMORY_TURN_POLICY_REASONS.has(parsed.reason as MemoryTurnPolicyReason)
  ) return null
  return { allowed: parsed.allowed, reason: parsed.reason as MemoryTurnPolicyReason }
}

export async function writeMemoryTurnPolicy(
  sessionKey: string,
  decision: MemoryTurnPolicyDecision,
  now = Date.now(),
): Promise<void> {
  const root = resolveMemoryTurnPolicyRoot()
  const target = policyPath(sessionKey, root)
  const dir = join(root, '.memory-turn-policy')
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
): Promise<MemoryTurnPolicyDecision> {
  try {
    const parsed = JSON.parse(await readFile(policyPath(sessionKey), 'utf8')) as Partial<MemoryTurnPolicyRecord>
    const decision = asDecision(parsed)
    if (!decision) return { ...DEFAULT_MEMORY_SEARCH_POLICY }
    const expired = !Number.isSafeInteger(parsed.expiresAt) || (parsed.expiresAt as number) <= now
    if (expired) {
      // Expiry / a broken timestamp must not lift an explicit deny.
      return isStickyDeny(decision) ? decision : { ...DEFAULT_MEMORY_SEARCH_POLICY }
    }
    return decision
  } catch {
    return { ...DEFAULT_MEMORY_SEARCH_POLICY }
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
