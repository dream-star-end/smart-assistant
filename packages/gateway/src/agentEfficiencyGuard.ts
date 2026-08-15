/**
 * Agent efficiency guardrails — cheap runtime linter + session verification budget.
 *
 * Why this file exists: prompt-only rules are ignored (47h audit: 81% wall clock
 * in tools, 2275 remote cat/rg, 8.3h of foreground waits). This module is the
 * platform-layer enforcement that sits on the existing engine-neutral
 * `tool_use_detected` hook in sessionManager — no parallel interceptor.
 *
 * Cost model: lint path is string/regex only (no fs, no spawn). Persist I/O
 * happens once per turn start/end, never per tool call.
 *
 * Mode (OPENCLAUDE_EFFICIENCY_GUARD):
 *   off  — no-op
 *   warn — default; return executable correction, do not fail the tool
 *   deny — same hits, action='deny' (wording upgrades; CCB still executes —
 *          gateway cannot preempt an in-flight builtin Bash)
 */
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { paths } from '@openclaude/storage'

export type GuardMode = 'off' | 'warn' | 'deny'
export type ChangeTier = 'T0' | 'T1' | 'T2' | 'unknown'
export type LintCode =
  | 'sleep_ge_60'
  | 'fg_watch'
  | 'heartbeat_loop'
  | 'local_file_via_shell'
  | 'bash_count'
  | 'tool_count'
  | 'fanout'

export interface LintHit {
  code: LintCode
  action: 'warn' | 'deny'
  message: string
}

export interface TurnGuardState {
  toolCount: number
  bashCount: number
  consecutiveReadProbes: number
  delegatedThisTurn: boolean
  emitted: Set<LintCode>
}

export interface VerificationBudget {
  schemaVersion: 1
  tier: ChangeTier
  waived: boolean
  upgradeConfirmed: boolean
  verifyOnly: boolean
  startedAt: number | null
  accumulatedMs: number
  lastTurnStartedAt: number | null
}

export interface EfficiencySessionState {
  _efficiencyTurn?: TurnGuardState
  _efficiencyPendingHits?: LintHit[]
  _efficiencyBudget?: VerificationBudget
  sessionKey?: string
}

export const DEFAULT_VERIFICATION_BUDGET_MS = 15 * 60_000
export const DEFAULT_BASH_COUNT_WARN = 24
export const DEFAULT_TOOL_COUNT_WARN = 80
export const FANOUT_READ_PROBE_THRESHOLD = 3
/** 命令中带此标记则单次豁免拦截(仍写审计日志)。 */
export const EFFICIENCY_ESCAPE_TOKEN = 'OC_EFFICIENCY_ALLOW'

const SLEEP_CMD_RE =
  /(?:^|[;&|\n]|(?:\b(?:then|do)\s+))\s*sleep\s+(\d+(?:\.\d+)?)([smhd])?\b/gi
const SLEEP_WORD_RE =
  /(?:^|[;&|\n]|(?:\b(?:then|do)\s+))\s*sleep\s+(\d+)\s*(min(?:ute)?s?|hours?|hrs?)\b/gi
const FG_WATCH_RE =
  /\bgh\s+pr\s+checks\b[^\n;|&]*--watch|\bgh\s+run\s+watch\b|\bgh\s+workflow\s+view\b[^\n;|&]*--web/i
const HEARTBEAT_LOOP_RE =
  /(?:^|[;&|\n])\s*while\s+(?:true|:)\s*(?:;|do\b)[\s\S]{0,500}\b(?:heartbeat|renew|keep-?alive|liveness)\b/i
const HOST_PREFIX_RE = /(?:^|[\s;|&])(?:export\s+\w+=\S+\s+)*\S*host\s+/
const HEREDOC_OR_REDIRECT_RE = /\bcat\s*(?:<<|>>?)/
const LOCAL_READ_RE =
  /(?:^|[;&|\n])\s*(?:sudo\s+)?(cat|sed\s+-n|head|tail|rg|grep)\b([^\n;|&]*)/
const SOURCE_EXT_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|md|json|ya?ml|toml|sh)\b/
const CODE_ROOT_RE = /(?:^|[\s"'=])(?:\/opt\/openclaude|\/home\/agent|\/run\/oc|\.\/|src\/|packages\/)/
const PROC_PATH_RE = /(?:^|[\s"'=])(?:\/proc\/|\/sys\/|\/dev\/)/
const TAIL_FOLLOW_RE = /\btail\s+(?:-\w*f\w*|--follow)\b/
const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'ls'])
const DELEGATE_TOOLS = new Set(['delegate_task', 'delegate_tasks', 'send_to_agent'])
const BASH_TOOLS = new Set(['Bash', 'Shell', 'bash', 'shell'])

const WAIVER_RE =
  /不用验证|无需验证|不要验证|不用你验证|本次不用你验证|上线就行|直接上|skip verification|no need to verify|just ship|just deploy/i
const VERIFY_ONLY_RE = /验一下|实际去验|你实际去验|只验不修|先验证(?:一下)?|verify only|just verify|just check/i
const UPGRADE_RE = /升级到全量|走完整列车|全量门|跑全量|按\s*T2\b/
const T2_RE = /跨包|协议变更|迁移|migration|protocol change|完整列车|全量门/
const T0_RE = /catalog|配置文件|模型目录|yaml 配置|json 配置|--with-dist/
const T1_RE = /单包|这个包|packages\/[\w-]+|修一个|bugfix/

export function resolveGuardMode(env: NodeJS.ProcessEnv = process.env): GuardMode {
  const raw = (env.OPENCLAUDE_EFFICIENCY_GUARD ?? 'warn').trim().toLowerCase()
  if (raw === 'off' || raw === '0' || raw === 'false') return 'off'
  if (raw === 'deny' || raw === 'block') return 'deny'
  return 'warn'
}

export function verificationBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.OPENCLAUDE_VERIFICATION_BUDGET_MS)
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_VERIFICATION_BUDGET_MS
}

export function createTurnGuardState(): TurnGuardState {
  return {
    toolCount: 0,
    bashCount: 0,
    consecutiveReadProbes: 0,
    delegatedThisTurn: false,
    emitted: new Set(),
  }
}

export function emptyVerificationBudget(): VerificationBudget {
  return {
    schemaVersion: 1,
    tier: 'unknown',
    waived: false,
    upgradeConfirmed: false,
    verifyOnly: false,
    startedAt: null,
    accumulatedMs: 0,
    lastTurnStartedAt: null,
  }
}

function actionOf(mode: GuardMode): 'warn' | 'deny' {
  return mode === 'deny' ? 'deny' : 'warn'
}

function sleepSeconds(value: string, unit?: string): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  const u = (unit ?? 's').toLowerCase()
  if (u === 'm' || u.startsWith('min')) return n * 60
  if (u === 'h' || u.startsWith('hour') || u === 'hrs') return n * 3600
  if (u === 'd') return n * 86400
  return n
}

function splitSegments(command: string): string[] {
  return command
    .split(/(?:&&|\|\||;|\n)/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function looksLikeSourcePath(argStr: string): boolean {
  if (PROC_PATH_RE.test(argStr)) return false
  return SOURCE_EXT_RE.test(argStr) || CODE_ROOT_RE.test(argStr)
}

/** 去掉 heredoc 体、注释、引号字面量,避免把脚本内容/字符串里的 sleep/while 当成交。 */
export function stripNonCodeContext(command: string): string {
  let out = command.replace(/<<-?['"]?(\w+)['"]?[\s\S]*?\n\1\b/g, ' ')
  out = out.replace(/#[^\n]*/g, ' ')
  out = out.replace(/'(?:\\'|[^'])*'/g, "''")
  out = out.replace(/"(?:\\.|[^"\\])*"/g, '""')
  return out
}

export function hasEfficiencyEscape(command: string): boolean {
  return command.includes(EFFICIENCY_ESCAPE_TOKEN)
}

export function suggestAlternative(hit: LintHit): string {
  switch (hit.code) {
    case 'sleep_ge_60':
      return '替代: `nohup <长任务> >/tmp/oc-job.log 2>&1 & echo $!; tail -n 50 /tmp/oc-job.log`'
    case 'fg_watch':
      return '替代: `gh pr checks` 或 `gh run view --json status`(不要 --watch)'
    case 'heartbeat_loop':
      return '替代: 后台跑任务并 `tail` 日志,不要 `while true` + renew/heartbeat'
    case 'local_file_via_shell':
      return '替代: 用原生 Read/Grep/Glob 读容器内文件;宿主文件才用 `host cat/rg`'
    default:
      return hit.message
  }
}

export function lintBashCommand(command: string, mode: GuardMode = 'warn'): LintHit[] {
  if (mode === 'off' || !command) return []
  const hits: LintHit[] = []
  const act = actionOf(mode)
  const visible = stripNonCodeContext(command)

  SLEEP_CMD_RE.lastIndex = 0
  SLEEP_WORD_RE.lastIndex = 0
  for (const re of [SLEEP_CMD_RE, SLEEP_WORD_RE]) {
    let m: RegExpExecArray | null
    while ((m = re.exec(visible))) {
      const before = visible.slice(Math.max(0, m.index - 12), m.index)
      if (/\becho\b/.test(before)) continue
      const secs = sleepSeconds(m[1], m[2])
      if (secs >= 60) {
        hits.push({
          code: 'sleep_ge_60',
          action: act,
          message:
            `禁止 sleep ${m[1]}${m[2] ?? 's'}(>=60s)。改为后台跑长任务并回看日志,或用更短的 sleep 分片轮询。`,
        })
        break
      }
    }
    if (hits.some((h) => h.code === 'sleep_ge_60')) break
  }

  if (FG_WATCH_RE.test(visible)) {
    hits.push({
      code: 'fg_watch',
      action: act,
      message:
        '禁止前台 `gh pr checks --watch` / `gh run watch`。去掉 --watch,后台跑 CI,期间做别的事,再回看日志。',
    })
  }

  if (HEARTBEAT_LOOP_RE.test(visible)) {
    hits.push({
      code: 'heartbeat_loop',
      action: act,
      message:
        '禁止 `while true` + heartbeat/renew 手写空转。改用平台已有租约/超时,或后台任务 + 回看日志。',
    })
  }

  for (const seg of splitSegments(command)) {
    if (HOST_PREFIX_RE.test(seg)) continue
    if (HEREDOC_OR_REDIRECT_RE.test(seg)) continue
    if (TAIL_FOLLOW_RE.test(seg)) continue
    const read = LOCAL_READ_RE.exec(seg)
    if (!read) continue
    const args = read[2] ?? ''
    if (!looksLikeSourcePath(args)) continue
    hits.push({
      code: 'local_file_via_shell',
      action: act,
      message:
        `本容器内文件请用原生 Read/Grep/Glob,不要 \`${read[1].trim()}\` 隔空读。host 读宿主文件可以保留。`,
    })
    break
  }

  return hits
}

function bashCommandOf(tool: { name: string; input?: Record<string, unknown> }): string | null {
  if (!BASH_TOOLS.has(tool.name)) return null
  const input = tool.input ?? {}
  for (const key of ['command', 'cmd', 'script']) {
    const v = input[key]
    if (typeof v === 'string' && v.trim()) return v
  }
  return null
}

function isReadProbe(tool: { name: string; input?: Record<string, unknown> }, command: string | null): boolean {
  if (READ_ONLY_TOOLS.has(tool.name)) return true
  if (!command) return false
  return /(?:^|[;&|\n])\s*(?:ls|find|cat|rg|grep|sed\s+-n|head|tail|stat|wc)\b/.test(command)
}

export function observeToolUse(
  state: TurnGuardState,
  tool: { name: string; input?: Record<string, unknown> },
  mode: GuardMode = 'warn',
): LintHit[] {
  if (mode === 'off') return []
  const hits: LintHit[] = []
  const act = actionOf(mode)
  const command = bashCommandOf(tool)

  if (command) {
    state.bashCount++
    hits.push(...lintBashCommand(command, mode))
  }

  if (DELEGATE_TOOLS.has(tool.name)) {
    state.delegatedThisTurn = true
    state.consecutiveReadProbes = 0
  } else if (isReadProbe(tool, command)) {
    state.consecutiveReadProbes++
  } else {
    state.consecutiveReadProbes = 0
  }

  if (
    !state.delegatedThisTurn &&
    state.consecutiveReadProbes >= FANOUT_READ_PROBE_THRESHOLD &&
    !state.emitted.has('fanout')
  ) {
    state.emitted.add('fanout')
    hits.push({
      code: 'fanout',
      action: 'warn',
      message:
        `本 turn 已连续 ${state.consecutiveReadProbes} 次彼此独立的只读探活。请用 delegate_tasks 一次并行委派(最多 4 项),不要串行自己做完。`,
    })
  }

  if (state.bashCount === DEFAULT_BASH_COUNT_WARN && !state.emitted.has('bash_count')) {
    state.emitted.add('bash_count')
    hits.push({
      code: 'bash_count',
      action: act,
      message: `本 turn 已 ${state.bashCount} 次 Bash。请合并探活或拆分交付,不要继续碎命令。`,
    })
  }

  if (state.toolCount >= DEFAULT_TOOL_COUNT_WARN && !state.emitted.has('tool_count')) {
    state.emitted.add('tool_count')
    hits.push({
      code: 'tool_count',
      action: act,
      message: `本 turn 已 ${state.toolCount} 次工具调用(阈值 ${DEFAULT_TOOL_COUNT_WARN})。请拆分交付后再继续。`,
    })
  }

  return hits
}

export function classifyUserEfficiencyIntent(userText: string): {
  tier: ChangeTier
  waived: boolean
  verifyOnly: boolean
  upgradeConfirmed: boolean
} {
  const text = userText ?? ''
  return {
    tier: T2_RE.test(text) ? 'T2' : T1_RE.test(text) ? 'T1' : T0_RE.test(text) ? 'T0' : 'unknown',
    waived: WAIVER_RE.test(text),
    verifyOnly: VERIFY_ONLY_RE.test(text),
    upgradeConfirmed: UPGRADE_RE.test(text),
  }
}

export function beginTurnBudget(
  prev: VerificationBudget | null,
  userText: string,
  now = Date.now(),
): VerificationBudget {
  const intent = classifyUserEfficiencyIntent(userText)
  const next: VerificationBudget = { ...(prev ?? emptyVerificationBudget()) }
  if (intent.tier !== 'unknown') next.tier = intent.tier
  if (next.tier === 'unknown') next.tier = 'T0'
  if (intent.waived) next.waived = true
  if (intent.upgradeConfirmed) {
    next.upgradeConfirmed = true
    next.tier = 'T2'
  }
  if (intent.verifyOnly) next.verifyOnly = true
  if (!next.waived && !next.upgradeConfirmed && (next.tier === 'T0' || next.tier === 'T1')) {
    if (next.startedAt == null) next.startedAt = now
    next.lastTurnStartedAt = now
  } else {
    next.lastTurnStartedAt = null
  }
  return next
}

export function endTurnBudget(budget: VerificationBudget, now = Date.now()): VerificationBudget {
  if (budget.lastTurnStartedAt != null && !budget.waived && !budget.upgradeConfirmed) {
    budget.accumulatedMs += Math.max(0, now - budget.lastTurnStartedAt)
    budget.lastTurnStartedAt = null
  }
  return budget
}

export function shouldAskVerificationUpgrade(
  budget: VerificationBudget,
  limitMs = DEFAULT_VERIFICATION_BUDGET_MS,
): boolean {
  if (budget.waived || budget.upgradeConfirmed) return false
  if (budget.tier !== 'T0' && budget.tier !== 'T1') return false
  return budget.accumulatedMs >= limitMs
}

export function formatGuardNote(
  hits: LintHit[],
  opts: { budgetAlert?: boolean; verifyOnly?: boolean; mode?: GuardMode } = {},
): string | null {
  const lines: string[] = []
  const seen = new Set<string>()
  for (const hit of hits) {
    if (seen.has(hit.code)) continue
    seen.add(hit.code)
    const prefix = hit.action === 'deny' ? '拒绝建议' : '纠正'
    lines.push(`- ${prefix}: ${hit.message}`)
  }
  if (opts.verifyOnly) {
    lines.push('- 用户说「验一下」:只验不修,要不要改由用户决定。')
  }
  if (opts.budgetAlert) {
    lines.push(
      '- 本会话 T0/T1 验证已超过 15 分钟。先向用户确认是否升级到全量门;用户说「不用验证/直接上」可豁免。',
    )
  }
  if (lines.length === 0) return null
  return `<oc-efficiency-guard>\n平台效率护栏(本轮提醒,不是用户原话):\n${lines.join('\n')}\n</oc-efficiency-guard>`
}

function budgetPath(sessionKey: string): string {
  const key = createHash('sha256').update(sessionKey).digest('hex')
  return join(paths.home, '.verification-budget', `${key}.json`)
}

export async function readVerificationBudget(sessionKey: string): Promise<VerificationBudget | null> {
  try {
    const parsed = JSON.parse(await readFile(budgetPath(sessionKey), 'utf8')) as Partial<VerificationBudget>
    if (parsed.schemaVersion !== 1) return null
    return { ...emptyVerificationBudget(), ...parsed, schemaVersion: 1 }
  } catch {
    return null
  }
}

export async function writeVerificationBudget(
  sessionKey: string,
  budget: VerificationBudget,
): Promise<void> {
  const target = budgetPath(sessionKey)
  const dir = join(paths.home, '.verification-budget')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const tmp = `${target}.tmp-${randomUUID()}`
  try {
    await writeFile(tmp, `${JSON.stringify(budget)}\n`, { mode: 0o600 })
    await rename(tmp, target)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

export function applyEfficiencyToolObservation(
  session: EfficiencySessionState,
  tool: { name: string; input?: Record<string, unknown> },
  toolCount: number,
): LintHit[] {
  const mode = resolveGuardMode()
  if (mode === 'off') return []
  const state = (session._efficiencyTurn ??= createTurnGuardState())
  state.toolCount = toolCount
  const hits = observeToolUse(state, tool, mode)
  if (hits.length) {
    session._efficiencyPendingHits = [...(session._efficiencyPendingHits ?? []), ...hits]
  }
  return hits
}

export async function prepareEfficiencyTurnNote(
  session: EfficiencySessionState & { sessionKey: string },
  userText: string,
  now = Date.now(),
): Promise<string | null> {
  const mode = resolveGuardMode()
  if (mode === 'off') return null
  let stored: VerificationBudget | null = null
  try {
    stored = await readVerificationBudget(session.sessionKey)
  } catch {
    stored = null
  }
  const budget = beginTurnBudget(session._efficiencyBudget ?? stored, userText, now)
  session._efficiencyBudget = budget
  session._efficiencyTurn = createTurnGuardState()
  try {
    await writeVerificationBudget(session.sessionKey, budget)
  } catch {
    // persist is best-effort; turn must not fail closed on a reminder file
  }
  const hits = session._efficiencyPendingHits ?? []
  session._efficiencyPendingHits = []
  return formatGuardNote(hits, {
    budgetAlert: shouldAskVerificationUpgrade(budget, verificationBudgetMs()),
    verifyOnly: budget.verifyOnly,
    mode,
  })
}

export async function finalizeEfficiencyTurn(
  session: EfficiencySessionState & { sessionKey: string },
  now = Date.now(),
): Promise<void> {
  if (resolveGuardMode() === 'off') return
  if (!session._efficiencyBudget) return
  const budget = endTurnBudget(session._efficiencyBudget, now)
  session._efficiencyBudget = budget
  try {
    await writeVerificationBudget(session.sessionKey, budget)
  } catch {
    // same fail-soft as prepare
  }
}

export interface HookDecision {
  decision: 'allow' | 'deny'
  escaped: boolean
  hits: LintHit[]
  message: string | null
}

/** 前置钩子与事后观测共用的判定。deny 模式命中则 decision='deny'。 */
export function evaluateShellForHook(
  command: string,
  mode: GuardMode = resolveGuardMode(),
): HookDecision {
  if (mode === 'off' || !command) {
    return { decision: 'allow', escaped: false, hits: [], message: null }
  }
  if (hasEfficiencyEscape(command)) {
    return { decision: 'allow', escaped: true, hits: [], message: null }
  }
  const hits = lintBashCommand(command, mode)
  if (hits.length === 0) return { decision: 'allow', escaped: false, hits: [], message: null }
  const lines = hits.map((h) => `${h.message} ${suggestAlternative(h)}`)
  if (mode === 'deny') {
    lines.push(`逃生: 命令中加 ${EFFICIENCY_ESCAPE_TOKEN} 可单次豁免(会记审计日志)。`)
    return { decision: 'deny', escaped: false, hits, message: lines.join('\n') }
  }
  return { decision: 'allow', escaped: false, hits, message: lines.join('\n') }
}

export async function auditEfficiencyEscape(
  command: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const preview = command.replace(/\s+/g, ' ').slice(0, 240)
  const rec = {
    ts: new Date().toISOString(),
    event: 'efficiency_escape',
    token: EFFICIENCY_ESCAPE_TOKEN,
    commandPreview: preview,
    ...extra,
  }
  console.error(`[oc-efficiency-guard] escape used ${JSON.stringify(rec)}`)
  try {
    const dir = join(paths.home, '.efficiency-guard')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await appendFile(join(dir, 'audit.jsonl'), `${JSON.stringify(rec)}\n`, { mode: 0o600 })
  } catch {
    // stderr already has the record
  }
}
