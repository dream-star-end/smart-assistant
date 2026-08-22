// Cron — periodic self-reflection jobs for the learning loop.
//
// Jobs are defined in ~/.openclaude/cron.yaml:
//
//   jobs:
//     - id: daily-reflection
//       schedule: "0 3 * * *"          # crontab syntax
//       agent: main                    # which agent runs it
//       prompt: |
//         回顾最近 24 小时所有对话...
//       deliver: local                 # local | webchat | telegram
//       deliverTarget: {}              # optional { channel, peerId } for non-local
//
// The scheduler runs every 60 seconds. If the current minute matches a cron
// expression AND the job hasn't run in that minute, it fires.
//
// Bounded catch-up (OC_CRON_CATCHUP_MIN, default 15, 0=off): when the current
// minute does not match but the container was asleep/evicted across a scheduled
// minute, the tick scans backwards up to N minutes for the MOST RECENT missed
// match M and fires it once (only that one — multiple missed fires collapse to
// one, same semantics as Claude Code). Guarded by lastRun (cross-restart
// idempotent, last-run.json rides the volume) and job.createdAt (never re-fire
// a schedule point that predates the job's creation). This is what lets a
// master-woken container actually run a "9am daily" job it slept through, while
// staying bounded so a long sleep never replays a full backlog.
//
// Last-run times are persisted to ~/.openclaude/cron/last-run.json.
//
// Job output: run_id + timestamp written to ~/.openclaude/cron/outputs/<id>-<ts>.md.
// If the agent's final text starts with [SILENT], output is archived but not delivered.

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { type AgentDef, type OpenClaudeConfig, paths, readAgentsConfig } from '@openclaude/storage'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { createLogger } from './logger.js'
import type { SessionManager } from './sessionManager.js'
import { isHiddenSystemAgentId } from './agentVisibility.js'
// 引擎 API 错误识别的单一权威(delegate 输出错误同款):CCB 把上游失败以
// "API Error: …" 文本块流出而不抛,cron 侧必须把这类"产出"当失败而非结果。
import { classifyDelegateOutputError } from './errorClassify.js'
// 合成首帧执行模型解析(codex 计费旁路封堵的对偶面):cron 无 per-user 计费主体,
// 落 codex 会被 CODEX_BILLING_GUARD fail-closed 拒 —— 解析为 codex 时改用显式非 codex
// 兜底模型。与 sessionManager.getOrCreate 的 engine 判定同点收口(单一权威)。
// 注:server.ts ↔ cron.ts 已存在被容忍的模块循环(server import CronScheduler;
// sessionManager 亦 `import { resolveExecutionModel } from './server.js'`),本函数只在
// runJob 运行期调用,非模块初始化期,live-binding 安全,沿用既有模式。
import {
  localExecutionOverride,
  resolveLocalExecutionIfEnforced,
  resolveSyntheticTurnModel,
  type LocalExecutionDecision,
} from './server.js'
import { localExecutionRejectCode, type LocalExecutionRejectCode } from './modelCatalogClient.js'
import {
  postCronIndex,
  readV3CronIndexConfig,
  type CronIndexPayload,
} from './v3CronIndexPush.js'
import type { V3WechatOutboundConfig } from './v3WechatOutbound.js'
import {
  type CronOriginFireResult,
} from './cronOriginSession.js'

const logger = createLogger({ module: 'cron' })

const LAST_RUN_FILE = join(paths.home, 'cron', 'last-run.json')
const RETRY_STATE_FILE = join(paths.home, 'cron', 'retry-state.json')
const OCCURRENCE_DIR = join(paths.home, 'cron', 'occurrences')
const OCCURRENCE_SETTLED_DIR = join(paths.home, 'cron', 'occurrences-settled')
const OCCURRENCE_TAPE_DIR = join(paths.home, 'cron', 'occurrence-tapes')

type CronOccurrenceState =
  | 'prepared'
  | 'executing'
  | 'completed'
  | 'delivery_pending'
  | 'delivered'
  | 'delivery_terminal'
  | 'execution_terminal'
  | 'needs_confirmation'

interface CronOccurrenceRecord {
  version: 1
  deliveryId: string
  jobId: string
  dueMinuteKey: number
  schedule: string
  state: CronOccurrenceState
  sessionKey: string
  tapeEvents: number
  outputFile?: string
  updatedAt: number
}

export function classifyCronOccurrenceRecovery(
  record: Pick<CronOccurrenceRecord, 'state'> & Partial<Pick<CronOccurrenceRecord, 'tapeEvents' | 'outputFile'>>,
  executionTape: readonly unknown[] = [],
): 'rerun' | 'deliver_only' | 'done' | 'unknown' {
  if (record.state === 'prepared') return 'rerun'
  if (record.state === 'executing' && cronExecutionTapeIsReplaySafe(executionTape)) return 'rerun'
  if (
    (record.state === 'completed' || record.state === 'delivery_pending') &&
    typeof record.outputFile === 'string'
  ) return 'deliver_only'
  if (
    record.state === 'delivered' ||
    record.state === 'delivery_terminal' ||
    record.state === 'execution_terminal' ||
    record.state === 'needs_confirmation'
  ) return 'done'
  // Once submit_started is durable, even an empty tape cannot prove that no
  // tool ran immediately before the process died. Safe-tool replay remains
  // fail-closed until the complete exposed tool set can be proven read-only.
  return 'unknown'
}

const CRON_RECOVERY_READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep'])

/** A post-submit retry is allowed only when the fsynced tape proves that at
 * least one tool ran, every tool is in the exact read-only registry, and every
 * observed use has its matching terminal result. Empty/partial/unknown tapes
 * deliberately require confirmation rather than repeating effects. */
export function cronExecutionTapeIsReplaySafe(events: readonly unknown[]): boolean {
  const pending = new Map<string, string>()
  let observedTool = false
  for (const value of events) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const event = value as Record<string, unknown>
    if (event.kind === 'permission_request') return false
    if (event.kind === 'tool_use_detected') {
      const tool = event.tool
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return false
      const row = tool as Record<string, unknown>
      if (
        typeof row.id !== 'string' || !row.id ||
        typeof row.name !== 'string' || !CRON_RECOVERY_READ_ONLY_TOOLS.has(row.name)
      ) return false
      observedTool = true
      pending.set(row.id, row.name)
    }
    if (event.kind === 'block') {
      const block = event.block
      if (!block || typeof block !== 'object' || Array.isArray(block)) return false
      const row = block as Record<string, unknown>
      if (row.kind === 'tool_use') {
        if (
          typeof row.blockId !== 'string' || !row.blockId ||
          typeof row.toolName !== 'string' || !CRON_RECOVERY_READ_ONLY_TOOLS.has(row.toolName)
        ) return false
        observedTool = true
        pending.set(row.blockId, row.toolName)
      } else if (row.kind === 'tool_result') {
        if (
          typeof row.toolUseBlockId !== 'string' ||
          typeof row.toolName !== 'string' ||
          pending.get(row.toolUseBlockId) !== row.toolName
        ) return false
        pending.delete(row.toolUseBlockId)
      }
    }
    if (event.kind === 'tool_result_detected') {
      const result = event.result
      if (!result || typeof result !== 'object' || Array.isArray(result)) return false
      const row = result as Record<string, unknown>
      if (
        typeof row.toolUseId !== 'string' ||
        typeof row.toolName !== 'string' ||
        pending.get(row.toolUseId) !== row.toolName
      ) return false
      pending.delete(row.toolUseId)
    }
  }
  return observedTool && pending.size === 0
}

function occurrencePath(deliveryId: string): string {
  return join(OCCURRENCE_DIR, `${deliveryId}.json`)
}

function durableJsonWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${++_writeCounter}.tmp`
  const fd = openSync(temporary, 'w', 0o600)
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, path)
  const dir = openSync(dirname(path), 'r')
  try { fsyncSync(dir) } finally { closeSync(dir) }
}

function writeOccurrence(record: CronOccurrenceRecord): void {
  durableJsonWrite(occurrencePath(record.deliveryId), record)
}

function settleOccurrence(
  record: CronOccurrenceRecord,
  state: 'delivered' | 'delivery_terminal' | 'execution_terminal' | 'needs_confirmation' = 'delivered',
): void {
  writeOccurrence({ ...record, state, updatedAt: Date.now() })
  mkdirSync(OCCURRENCE_SETTLED_DIR, { recursive: true })
  renameSync(
    occurrencePath(record.deliveryId),
    join(OCCURRENCE_SETTLED_DIR, `${record.deliveryId}.json`),
  )
  for (const directory of [OCCURRENCE_DIR, OCCURRENCE_SETTLED_DIR]) {
    const fd = openSync(directory, 'r')
    try { fsyncSync(fd) } finally { closeSync(fd) }
  }
}

function readOccurrence(deliveryId: string): CronOccurrenceRecord | null {
  try {
    const raw = JSON.parse(readFileSync(occurrencePath(deliveryId), 'utf8')) as CronOccurrenceRecord
    return raw?.version === 1 && raw.deliveryId === deliveryId ? raw : null
  } catch {
    return null
  }
}

function appendOccurrenceTape(deliveryId: string, event: unknown): number {
  mkdirSync(OCCURRENCE_TAPE_DIR, { recursive: true })
  const path = join(OCCURRENCE_TAPE_DIR, `${deliveryId}.jsonl`)
  const fd = openSync(path, 'a', 0o600)
  try {
    appendFileSync(fd, `${JSON.stringify({ observedAt: Date.now(), event })}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  const record = readOccurrence(deliveryId)
  return (record?.tapeEvents ?? 0) + 1
}

function readOccurrenceTape(deliveryId: string): unknown[] {
  try {
    return readFileSync(join(OCCURRENCE_TAPE_DIR, `${deliveryId}.jsonl`), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event?: unknown })
      .map((row) => row.event)
  } catch {
    return []
  }
}

// 连续「余额不足」失败自动暂停阈值。余额不足是**持续性**失败(用户不充值不会自愈),
// 放任任务按 schedule 空转 = 每次产出同一段 "API Error: 402…"(线上事故:每 5 分钟
// 一次的任务 35 小时给用户刷了 424 条同文站内信)。3 次给足偶发误判余量(如充值与
// 扣费的竞态),又保证 5 分钟粒度的任务最迟 15 分钟内熔断。rate_limited / upstream
// 等瞬时错误**不**计入 —— 平台侧故障不该替用户关任务。
// (行注释而非 docblock:注释里出现 crontab 星号斜杠写法会截断 docblock,历史炸过套件。)
const CREDIT_FAIL_PAUSE_THRESHOLD = 3

export type CronRunOutcome =
  | { kind: 'completed' }
  | { kind: 'silent' }
  | { kind: 'terminal_failure'; code: string }
  | {
      kind: 'retryable_failure'
      code: string
      retry?: { phase: 'execution' } | { phase: 'delivery'; outputFile: string }
    }

export interface CronRetryEntry {
  dueMinuteKey: number
  schedule: string
  failures: number
  nextAttemptAt: number
  code: string
  phase: 'execution' | 'delivery'
  outputFile?: string
  /** Stable sink idempotency key for this exact owned occurrence. */
  deliveryId?: string
}

export interface CronDeliveryContext {
  dueMinuteKey: number
  deliveryId: string
}

export function cronDeliveryId(jobId: string, dueMinuteKey: number): string {
  return `cron.${createHash('sha256').update(`${jobId}\0${dueMinuteKey}`).digest('hex')}`
}

/** Production adapter boundary: completion means the adapter promise resolved;
 * rejection must propagate to the durable cron delivery outbox. */
export async function deliverCronViaAdapter<T>(
  adapter: { send(value: T): Promise<void> },
  value: T,
): Promise<void> {
  await adapter.send(value)
}

interface CronRunDurabilityHooks {
  /** Persist the owned due occurrence before submit can execute tools. */
  consumeOccurrence(): Promise<void>
  /** Cross the fail-closed boundary immediately before submit can run tools. */
  markSubmitStarted?(): Promise<void>
  /** Append-only, fsynced observation tape. */
  recordEvent?(event: unknown): void
  /** Persist the immutable archived result before delivery. */
  markCompleted?(outputFile: string): Promise<void>
  markDelivered?(): Promise<void>
  markDeliveryTerminal?(): Promise<void>
  /** Persist the archived delivery payload before the first channel send. */
  stageDelivery(outputFile: string): Promise<void>
  /** Convert an executing occurrence back to prepared only when its fsynced
   * tool tape proves full read-only completion. */
  recoverInterruptedExecution?(): Promise<boolean>
}

export const CRON_MAX_ATTEMPTS = 4
const CRON_RETRY_DELAYS_MS = [60_000, 120_000, 300_000] as const

export function planCronRetry(
  previous: CronRetryEntry | undefined,
  args: {
    dueMinuteKey: number
    schedule: string
    nowEpoch: number
    code: string
    phase?: 'execution' | 'delivery'
    outputFile?: string
    deliveryId?: string
  },
): { kind: 'retry'; entry: CronRetryEntry; delayMs: number } | { kind: 'exhausted'; attempts: number } {
  const phase = args.phase ?? 'execution'
  const samePhase = previous?.phase === phase && (
    phase !== 'delivery' || previous.outputFile === args.outputFile
  )
  const failures = previous?.dueMinuteKey === args.dueMinuteKey && previous.schedule === args.schedule && samePhase
    ? previous.failures + 1
    : 1
  if (phase !== 'delivery' && failures >= CRON_MAX_ATTEMPTS)
    return { kind: 'exhausted', attempts: failures }
  const delayMs = CRON_RETRY_DELAYS_MS[Math.min(failures - 1, CRON_RETRY_DELAYS_MS.length - 1)]
  return {
    kind: 'retry',
    delayMs,
    entry: {
      dueMinuteKey: args.dueMinuteKey,
      schedule: args.schedule,
      failures,
      nextAttemptAt: args.nowEpoch + delayMs,
      code: args.code,
      phase,
      ...(phase === 'delivery' && args.outputFile ? { outputFile: args.outputFile } : {}),
      ...(args.deliveryId ? { deliveryId: args.deliveryId } : {}),
    },
  }
}

function stableCronErrorClass(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string' && /^[A-Z0-9_]{1,48}$/.test(code)) return code
    if (err instanceof Error && err.name === 'AbortError') return 'AbortError'
    if (err instanceof Error) return 'Error'
  }
  return typeof err
}

/** Unknown delivery exceptions are transient by default. A delivery adapter
 * may explicitly tag a stable code with retryable=false for a permanent target
 * rejection. Transient delivery retries retain the immutable archived payload
 * and back off indefinitely; they never re-run the Agent. */
export function deliveryFailureOutcome(err: unknown):
  | { kind: 'terminal_failure'; code: string }
  | { kind: 'retryable_failure'; code: string } {
  const tagged = typeof err === 'object' && err !== null
    ? err as { code?: unknown; retryable?: unknown }
    : null
  const code = typeof tagged?.code === 'string' && /^[A-Z0-9_]{1,48}$/.test(tagged.code)
    ? tagged.code
    : 'DELIVERY_TRANSIENT'
  return tagged?.retryable === false
    ? { kind: 'terminal_failure', code }
    : { kind: 'retryable_failure', code }
}

export function catalogRejectOutcome(code: LocalExecutionRejectCode): CronRunOutcome {
  return code === 'MODEL_CATALOG_UNAVAILABLE'
    ? { kind: 'retryable_failure', code }
    : { kind: 'terminal_failure', code }
}

export interface CronJob {
  id: string
  schedule: string
  agent: string
  prompt: string
  deliver?: 'local' | 'webchat' | 'telegram'
  deliverTarget?: { channel?: string; peerId?: string }
  enabled?: boolean
  oneshot?: boolean // fire once then auto-disable
  label?: string // human-readable label (for reminders)
  // Marks the job as a proactive "heartbeat check" — purely a UI/delivery
  // hint (frontend uses it to style the push and skip the "system cron"
  // badge). Execution uses an isolated session just like any other cron job.
  heartbeat?: boolean
  // Epoch ms when the job was created (stamped by every creation entry point:
  // POST /api/cron + the CCB CronCreate bridge). Optional so legacy jobs and
  // personal DEFAULT_JOBS (no field on disk) still load. Used by bounded
  // catch-up to refuse re-firing a scheduled minute that predates creation —
  // otherwise a job created at 09:03 whose schedule is "0 9 * * *" would be
  // falsely "caught up" for the 09:00 tick it never missed. Legacy jobs
  // without createdAt are only bounded by the catch-up window itself.
  createdAt?: number
  // origin-session: fire by injecting a new inbound turn into the conversation
  // that created the job. Default / omitted = isolated cron session (legacy).
  // sourceSessionKey / sourceUserId are gateway-stamped; never accept them
  // from model tool args.
  resume?: 'isolated' | 'origin-session'
  sourceSessionKey?: string
  sourceUserId?: string
}

/**
 * 用户发起的提醒/定时任务 vs 系统自省 job 的判定。
 *
 * 用户 cron 入口(都该可推送到微信):
 *   - `POST /api/cron`  → `remind-<ts>-<rand>`(server.ts)
 *   - CronCreate tool_use bridge → `ccb-<ts>-<rand>`(sessionManager)
 * 系统自省 job(personal DEFAULT_JOBS;commercial OC_SEED_DEFAULT_CRON=0 不 seed,绝不外发到微信):
 *   - heartbeat(job.heartbeat=true)
 *   - daily-reflection / weekly-curation / skill-check 及任何含 reflection/skill 的变体
 *
 * 采用「反向排除系统」而非「白名单用户前缀」:任何新增的用户 cron 入口都自动获得微信投递,
 * 不会像 startsWith('ccb-') 那样漏掉 remind-(本类 bug 的根因)。系统 job 是封闭已知集。
 */
export function isUserInitiatedCronJob(job: Pick<CronJob, 'id' | 'heartbeat'>): boolean {
  if (job.heartbeat) return false
  const id = job.id
  if (id === 'daily-reflection' || id === 'weekly-curation' || id === 'skill-check') return false
  if (id.includes('reflection') || id.includes('skill')) return false
  return true
}

export interface CronFile {
  jobs: CronJob[]
}

const DEFAULT_JOBS: CronJob[] = [
  {
    id: 'daily-reflection',
    schedule: '17 3 * * *', // 3:17 AM user local time (Asia/Shanghai by default)
    agent: 'main',
    enabled: true,
    deliver: 'local',
    prompt: `You are doing a DAILY REFLECTION pass. It is currently early morning.

1. Run \`oc-memory session-search "<query>"\` in the shell with query terms that cover yesterday's activity (e.g. the current date, common topics).
2. Review the last 5-10 turns you find.
3. Extract durable facts, user preferences, and patterns that should persist across sessions.
4. Save anything worth keeping as Core memory the memdir way (see the \`# Memory\` section of your system prompt): use Write to create a \`memory/<slug>.md\` file with frontmatter (name / description / type = user|feedback|project|reference), then use Edit to append one index line \`- [标题](memory/<slug>.md) — 钩子\` to \`MEMORY.md\`. Prefer updating an existing file over creating a near-duplicate. Be selective — only things that will actually help next time.
5. If you notice a pattern of tasks that could be reused, use \`skill_save\` to distill it into a reusable skill.
6. IMPORTANT: 重点检查今天是否有超过 3 次工具调用的复杂任务。如果有且没有对应 skill,立即用 skill_save 创建。
7. 如果某条 \`memory/<slug>.md\` 正文过于冗长,先用 \`oc-memory archival-add "..."\` 迁到归档记忆,再删掉该文件并同步移除 \`MEMORY.md\` 里对应那一行。
8. Write a SHORT summary of what you learned today (max 200 words).
9. If you learned nothing significant, reply with exactly "[SILENT]" and nothing else.`,
  },
  {
    id: 'weekly-curation',
    schedule: '31 4 * * 0',
    agent: 'main',
    enabled: true,
    deliver: 'local',
    prompt: `You are doing a WEEKLY CURATION pass.

1. Read \`MEMORY.md\` (the Core memory index) and open the \`memory/<slug>.md\` files it points at with Read to see everything currently stored; also Read the shared \`user.md\` user profile.
2. Call \`skill_list()\` to see accumulated skills.
3. Run \`oc-memory archival-search "*"\` to review archival memory entries.
4. Look for:
   - Duplicate or contradictory memory files → Edit one file to consolidate, delete the redundant \`memory/<slug>.md\`, and sync \`MEMORY.md\` (remove its index line).
   - Obsolete facts (outdated preferences, stale technical details) → delete the stale \`memory/<slug>.md\` and remove its \`MEMORY.md\` index line.
   - Index lines pointing at files that no longer exist, or files missing from the index → fix \`MEMORY.md\` so index and files agree.
   - Skills that are too narrow/specific → consider deleting with \`skill_delete\`.
   - Skills with updated_at 超过 30 天 → 检查是否需要刷新或删除。
   - Archival 中过时的知识 → \`oc-memory archival-delete <id>\`。
5. Write a SHORT summary of curation actions taken (max 200 words).
6. If no curation was needed, reply with exactly "[SILENT]".`,
  },
  {
    id: 'skill-check',
    schedule: '47 */6 * * *',
    agent: 'main',
    enabled: true,
    deliver: 'local',
    prompt: `Quick skill extraction pass (every 6 hours). Use the current local time to search.

1. \`oc-memory session-search "<query>"\` with today's date or recent keywords to find conversations from the last 6 hours.
2. If no results, try broader search terms (e.g. common topics the user discusses).
3. For any multi-step task found (3+ tool calls), check \`skill_list()\` for existing coverage.
4. If a useful new skill pattern is found, \`skill_save\` immediately with concrete steps and commands.
5. Also skim \`MEMORY.md\` and open any relevant \`memory/<slug>.md\` — if an entry is stale or incorrect, Edit the file (or delete it and remove its index line).
6. If genuinely nothing new to extract or update, reply with exactly "[SILENT]".`,
  },
  {
    id: 'heartbeat',
    schedule: '13 */4 * * *',
    agent: 'main',
    enabled: true,
    deliver: 'webchat',
    heartbeat: true, // UI hint only — execution is isolated like other cron jobs
    prompt: `Periodic heartbeat check (every 4 hours). You are proactively checking on the user's standing items.

1. Read \`MEMORY.md\` and open any \`memory/<slug>.md\` it points at — scan for time-sensitive items, deadlines, or follow-ups.
2. \`oc-memory archival-search "pending OR reminder OR TODO OR deadline"\` — check for stored reminders/tasks.
3. \`oc-memory session-search "<query>"\` with the current date or recent keywords — look for conversations where the user said "later", "tomorrow", or "remind me".
4. If you find something actionable (missed deadline, pending follow-up, stale reminder), compose a SHORT proactive update for the user.
5. If everything is normal and nothing to report, reply with exactly "HEARTBEAT_OK".
6. DO NOT report that you checked and found nothing — that's what HEARTBEAT_OK is for.`,
  },
]

function canonicalCronSeedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalCronSeedValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalCronSeedValue(child)]),
    )
  }
  return value
}

function cronSeedFingerprint(job: CronJob): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalCronSeedValue(job)))
    .digest('hex')
}

/** Every exact personal DEFAULT_JOBS semantic fingerprint that existed in
 * repository history and could have reached a persistent commercial volume.
 * Generated from the full git history of this file; groups are current/memdir
 * (147a14e8), oc-memory CLI (80697968), original MCP defaults (948f69ab and
 * earlier), plus the two older heartbeat prompt revisions. Do not replace this
 * allowlist with fuzzy id/name matching. */
const KNOWN_DEFAULT_CRON_SEED_FINGERPRINTS = new Set([
  // 147a14e8+
  '1080714f0958de174435357d007ecc2bff95cad6272f8415ff677b37f2b7e81c',
  '4290bc62d5dac58463c532212843042224d97f91dda84f54d563b3018e3711f7',
  'ada7d700379a8de7813cd7f1e94ac4087741f7da85da509696e204e1b00fb0b3',
  '367fb7b20f1a6e56555f52e49ddeb89bef295fd00c633c5c4f1396fcb26dd624',
  // 80697968
  'bc694c21d0d73bc7f5eb3e529ebd8582ad8c3f8f0c93cdf8a7efc0dace5ba0ea',
  '86a297d04726ef85ad3628e84a03eab60ed6f662e1326491df3d190bc1bc76cf',
  'b9f396f9279c17a57a42fe79bf35602cf94bcef24ad963477a6e0c156e2c8e6d',
  'f8d1b45da9c29e8c9fa0d8b07917d32200fba468dbf2bc48573e7573ab3c7332',
  // 948f69ab and earlier production defaults
  '10645f9c4032d6bd43d54463b51ff5f0cef515fb3aa2c989607130fdb9c2c66f',
  '33dd9c4010e3ce17e8ea8f4ffe74e4de1e5c980a1a05e1a05c669a9d88914741',
  '3e732d9b8413b60f618288545674c54fe1678a6f5024a1e7953318c7759099c4',
  'faffde435d553e2b6b637e4c7c87afb1f8a3263c6eedfd718619ffcd59efd88e',
  '98192ae8724857e481c1e961d2082fedeac9ef6bb4155c5d97ab8bcd5d5bc311',
  'f50a77b27538aa330348cf2e88489447abf5249e9a438e4195a3ec342f5bba34',
])

/** Exact legacy seed fingerprint. Commercial containers may remove only an
 * untouched known personal default. Any top-level/nested field addition or
 * edit changes the canonical fingerprint and preserves the user's job. */
export function isUntouchedDefaultCronJob(job: CronJob): boolean {
  return KNOWN_DEFAULT_CRON_SEED_FINGERPRINTS.has(cronSeedFingerprint(job))
}

export async function ensureCronFile(): Promise<CronFile> {
  const path = paths.cronYaml
  if (!existsSync(path)) {
    await mkdir(dirname(path), { recursive: true })
    // Controls first-time bootstrap. Existing commercial files are also
    // scrubbed below, but only for exact untouched legacy seed fingerprints.
    // Set OC_SEED_DEFAULT_CRON=0 in v3 commercial containers to skip seeding
    // the personal-version self-reflection jobs (they would burn user credits).
    const seedDefaults = process.env.OC_SEED_DEFAULT_CRON !== '0'
    const initialJobs = seedDefaults ? DEFAULT_JOBS : []
    await atomicWriteYaml(path, { jobs: initialJobs })
    return { jobs: initialJobs }
  }
  try {
    const raw = await readFile(path, 'utf-8')
    const file = parseYaml(raw) as CronFile
    // Commercial images historically inherited the personal seed before
    // OC_SEED_DEFAULT_CRON=0 was introduced. Remove only byte-for-byte semantic
    // defaults; modified or user-created jobs remain untouched.
    if (process.env.OC_SEED_DEFAULT_CRON === '0' && Array.isArray(file.jobs)) {
      const kept = file.jobs.filter((job) => !isUntouchedDefaultCronJob(job))
      if (kept.length !== file.jobs.length) {
        file.jobs = kept
        await atomicWriteYaml(path, file)
      }
    }
    return file
  } catch {
    return { jobs: [] }
  }
}

async function loadLastRun(): Promise<Record<string, number>> {
  if (!existsSync(LAST_RUN_FILE)) return {}
  try {
    return JSON.parse(await readFile(LAST_RUN_FILE, 'utf-8'))
  } catch {
    return {}
  }
}
let _writeCounter = 0
async function saveLastRun(map: Record<string, number>): Promise<void> {
  await mkdir(dirname(LAST_RUN_FILE), { recursive: true })
  const tmp = LAST_RUN_FILE + `.${process.pid}.${++_writeCounter}.tmp`
  await writeFile(tmp, JSON.stringify(map, null, 2))
  await rename(tmp, LAST_RUN_FILE)
}

async function loadRetryState(): Promise<Map<string, CronRetryEntry>> {
  if (!existsSync(RETRY_STATE_FILE)) return new Map()
  try {
    const parsed = JSON.parse(await readFile(RETRY_STATE_FILE, 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return new Map()
    const out = new Map<string, CronRetryEntry>()
    for (const [jobId, value] of Object.entries(parsed)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      const row = value as Partial<CronRetryEntry>
      const phase = row.phase === 'delivery' ? 'delivery' : 'execution'
      const validOutput = phase === 'execution' || (
        typeof row.outputFile === 'string' &&
        row.outputFile === basename(row.outputFile) &&
        row.outputFile.length >= 1 && row.outputFile.length <= 240
      )
      const deliveryId = typeof row.deliveryId === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(row.deliveryId)
        ? row.deliveryId
        : cronDeliveryId(jobId, Number(row.dueMinuteKey))
      if (
        Number.isSafeInteger(row.dueMinuteKey) &&
        typeof row.schedule === 'string' && row.schedule.length <= 128 &&
        Number.isSafeInteger(row.failures) &&
        Number(row.failures) >= (phase === 'delivery' ? 0 : 1) &&
        (phase === 'delivery' || Number(row.failures) < CRON_MAX_ATTEMPTS) &&
        Number.isSafeInteger(row.nextAttemptAt) && Number(row.nextAttemptAt) >= 0 &&
        typeof row.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(row.code) &&
        validOutput
      ) {
        out.set(jobId, {
          dueMinuteKey: row.dueMinuteKey!, schedule: row.schedule!, failures: row.failures!,
          nextAttemptAt: row.nextAttemptAt!, code: row.code!, phase,
          ...(phase === 'delivery' ? { outputFile: row.outputFile! } : {}),
          deliveryId,
        })
      }
    }
    return out
  } catch {
    return new Map()
  }
}

async function saveRetryState(map: Map<string, CronRetryEntry>): Promise<void> {
  await mkdir(dirname(RETRY_STATE_FILE), { recursive: true })
  const tmp = RETRY_STATE_FILE + `.${process.pid}.${++_writeCounter}.tmp`
  await writeFile(tmp, JSON.stringify(Object.fromEntries(map), null, 2))
  await rename(tmp, RETRY_STATE_FILE)
}

async function loadOccurrenceRecords(): Promise<CronOccurrenceRecord[]> {
  if (!existsSync(OCCURRENCE_DIR)) return []
  const records: CronOccurrenceRecord[] = []
  for (const name of await readdir(OCCURRENCE_DIR)) {
    if (!name.endsWith('.json')) continue
    try {
      const row = JSON.parse(await readFile(join(OCCURRENCE_DIR, name), 'utf8')) as CronOccurrenceRecord
      if (
        row?.version === 1 &&
        typeof row.deliveryId === 'string' &&
        name === `${row.deliveryId}.json` &&
        typeof row.jobId === 'string' &&
        Number.isSafeInteger(row.dueMinuteKey) &&
        typeof row.schedule === 'string' &&
        typeof row.sessionKey === 'string'
      ) records.push(row)
    } catch {
      // Invalid/torn records are fail-closed and never authorize execution.
    }
  }
  return records
}

/** Atomically write a YAML file by writing to a unique .tmp then renaming. */
async function atomicWriteYaml(filePath: string, data: unknown): Promise<void> {
  const tmp = filePath + `.${process.pid}.${++_writeCounter}.tmp`
  await writeFile(tmp, stringifyYaml(data))
  await rename(tmp, filePath)
}

// Minimal crontab matcher: 5 fields, supports *, */N, N, N,M, N-M
// Uses user's timezone (TZ env var or default Asia/Shanghai) instead of UTC
function getLocalDate(): Date {
  const tz = process.env.TZ || 'Asia/Shanghai'
  try {
    const str = new Date().toLocaleString('en-US', { timeZone: tz })
    return new Date(str)
  } catch {
    return new Date() // fallback to server local time
  }
}

export function cronMatches(expr: string, d?: Date): boolean {
  const local = d ?? getLocalDate()
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return false
  const vals = [
    local.getMinutes(),
    local.getHours(),
    local.getDate(),
    local.getMonth() + 1,
    local.getDay(),
  ]
  for (let i = 0; i < 5; i++) {
    if (!fieldMatches(fields[i], vals[i])) return false
  }
  return true
}

function fieldMatches(field: string, val: number): boolean {
  for (const part of field.split(',')) {
    if (matchPart(part, val)) return true
  }
  return false
}
function matchPart(part: string, val: number): boolean {
  if (part === '*') return true
  const stepMatch = part.match(/^(.+)\/(\d+)$/)
  if (stepMatch) {
    const base = stepMatch[1]
    const step = Number(stepMatch[2])
    if (base === '*') return val % step === 0
    const range = base.split('-')
    if (range.length === 2) {
      const start = Number(range[0])
      const end = Number(range[1])
      return val >= start && val <= end && (val - start) % step === 0
    }
    return false
  }
  const rangeMatch = part.match(/^(\d+)-(\d+)$/)
  if (rangeMatch) {
    const start = Number(rangeMatch[1])
    const end = Number(rangeMatch[2])
    return val >= start && val <= end
  }
  const n = Number(part)
  if (!Number.isNaN(n)) return n === val
  return false
}

/** 单字段的取值边界(matcher 语义:dow 用 getDay() 取 0-6,7 永不命中)。 */
interface CronFieldSpec {
  label: string
  min: number
  max: number
  /** dow=7 是"周日应写 0"的常见笔误,越界时追加提示。 */
  sundayHint?: boolean
}

const CRON_FIELDS: readonly CronFieldSpec[] = [
  { label: 'minute', min: 0, max: 59 },
  { label: 'hour', min: 0, max: 23 },
  { label: 'day-of-month', min: 1, max: 31 },
  { label: 'month', min: 1, max: 12 },
  { label: 'day-of-week', min: 0, max: 6, sundayHint: true },
]

function cronValueError(n: number, raw: string, spec: CronFieldSpec): string | null {
  if (n < spec.min || n > spec.max) {
    const hint = spec.sundayHint && n === 7 ? ' (use 0 for Sunday)' : ''
    return `${spec.label} field "${raw}" out of range ${spec.min}-${spec.max}${hint}`
  }
  return null
}

function cronRangeError(startStr: string, endStr: string, raw: string, spec: CronFieldSpec): string | null {
  return (
    cronValueError(Number(startStr), startStr, spec) ??
    cronValueError(Number(endStr), endStr, spec) ??
    (Number(startStr) > Number(endStr)
      ? `${spec.label} field "${raw}" has an inverted range (${startStr} > ${endStr})`
      : null)
  )
}

function cronPartError(part: string, spec: CronFieldSpec): string | null {
  const { label } = spec
  // 空 part:matcher 里 Number('')===0 会误匹配 0(尾逗号 / 连续逗号)——显式拒绝。
  if (part === '') return `${label} field has an empty part (stray or trailing comma)`
  if (part === '*') return null
  // step 形态 base/S:matcher 只认 base ∈ {*, N-M} 且 S 为正整数;数字底的 step
  // (如 5/2)matcher 恒 false,*/0 因 val%0===NaN 永不命中——都拒绝。
  const slash = part.indexOf('/')
  if (slash !== -1) {
    const base = part.slice(0, slash)
    const step = part.slice(slash + 1)
    if (!/^\d+$/.test(step) || Number(step) < 1) {
      return `${label} field "${part}" has invalid step "${step}" (step must be an integer >= 1)`
    }
    if (base === '*') return null
    const range = base.match(/^(\d+)-(\d+)$/)
    if (!range) {
      return `${label} field "${part}" has invalid step base "${base}" (only * or N-M can take a step)`
    }
    return cronRangeError(range[1], range[2], part, spec)
  }
  const range = part.match(/^(\d+)-(\d+)$/)
  if (range) return cronRangeError(range[1], range[2], part, spec)
  if (/^\d+$/.test(part)) return cronValueError(Number(part), part, spec)
  return `${label} field "${part}" is not a valid cron term`
}

/**
 * 校验 crontab 表达式的字段数与每字段的数值范围/形态。返回 null=合法,否则返回具体
 * 错误信息(英文,指明字段与非法值,如 `minute field "60" out of range 0-59`)。
 *
 * 与 matcher(cronMatches/matchPart)严格对齐——只接受 matcher 真正能命中的形态:
 * 星号、N、N-M(N<=M)、星号/S(S>=1)、N-M/S(S>=1)、以及以上的逗号列表。
 * (形态描述用"星号"是因为字面星号斜杠会终止本块注释。)
 * 纯字符正则(旧实现)拦不住越界与静默失效写法:AI 走 create_reminder 幻觉出的
 * `60 25 * * *` 能过旧校验却让 cronMatches 永不命中(落库即失效)。
 */
export function validateCronSchedule(expr: string): string | null {
  const trimmed = expr.trim()
  const fields = trimmed === '' ? [] : trimmed.split(/\s+/)
  if (fields.length !== 5) {
    return `expected 5 fields (minute hour dom month dow), got ${fields.length}`
  }
  for (let i = 0; i < 5; i++) {
    const spec = CRON_FIELDS[i]
    for (const part of fields[i].split(',')) {
      const err = cronPartError(part, spec)
      if (err) return err
    }
  }
  return null
}

// ── Bounded catch-up (see file header) ──────────────────────────────────────

/** Parse OC_CRON_CATCHUP_MIN. Default 15; "0" disables catch-up; invalid/negative
 *  → default (fail-safe: a garbage env never silently turns catch-up off). */
export function getCatchupMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OC_CRON_CATCHUP_MIN
  if (raw === undefined || raw.trim() === '') return 15
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return 15
  return Math.trunc(n)
}

/**
 * Decide, for a single job, which minute (if any) should fire on this tick, and
 * return the minuteKey to record into lastRun — or null if nothing is due.
 *
 * Pure & side-effect-free so it can be unit-tested without a live scheduler /
 * sessions. tick() layers agent-existence + hidden-agent checks on top and only
 * writes lastRun with the returned key.
 *
 * Two clocks, deliberately separated:
 *   - real epoch ms (nowEpoch, minute boundaries) → minuteKey / createdAt compare.
 *     Cross-restart idempotency lives here; must not drift with the TZ view.
 *   - wall-clock view (localNow, already TZ-shifted by getLocalDate) → cronMatches.
 *     Shifting it back k minutes with getTime()-k*60000 keeps the same TZ offset,
 *     so matching a past minute uses the same calendar fields the live tick would.
 *
 * Current minute wins over any catch-up. Catch-up scans k=1..catchupMin looking
 * for the MOST RECENT missed match and fires only that one; older misses are
 * intentionally dropped (collapse a long sleep to a single run). The most-recent
 * miss's guards (lastRun strictly behind it; its fire boundary >= createdAt)
 * subsume all older misses, so breaking at the first match loses nothing.
 */
export function resolveDueMinute(
  job: Pick<CronJob, 'id' | 'schedule' | 'createdAt'>,
  lastRun: Record<string, number>,
  nowEpoch: number,
  localNow: Date,
  catchupMin: number,
): number | null {
  const nowMinuteKey = Math.floor(nowEpoch / 60_000)
  const last = lastRun[job.id]
  // Current minute: exact same rule as the pre-catch-up scheduler.
  if (cronMatches(job.schedule, localNow) && (last === undefined || last < nowMinuteKey)) {
    return nowMinuteKey
  }
  if (catchupMin <= 0) return null
  for (let k = 1; k <= catchupMin; k++) {
    // Subtracting exact 60000-ms multiples preserves the sub-minute remainder,
    // so this minuteKey equals nowMinuteKey - k regardless of nowEpoch's offset.
    const missedMinuteKey = nowMinuteKey - k
    const localCandidate = new Date(localNow.getTime() - k * 60_000)
    if (!cronMatches(job.schedule, localCandidate)) continue
    // Most recent missed match. Fire once iff we have not already run at/after
    // this minute AND the schedule point is not older than the job's creation.
    // createdAt compared against the minute's fire boundary (missedMinuteKey*60000):
    // a cron nominally fires at the minute start, so a job created strictly after
    // that boundary never actually missed this fire — refuse it (false catch-up).
    const notYetRun = last === undefined || last < missedMinuteKey
    const afterCreation =
      job.createdAt === undefined || missedMinuteKey * 60_000 >= job.createdAt
    if (notYetRun && afterCreation) return missedMinuteKey
    // Most recent miss is stale (already run) or predates creation; all older
    // misses are even more so → stop, do not catch up further.
    return null
  }
  return null
}

/** Selects the exact occurrence owned by a job. A valid persisted retry takes
 * precedence over current/catch-up matches, so high-frequency schedules cannot
 * merge a newer occurrence into an older failed delivery. */
export function resolveCronOccurrence(
  job: Pick<CronJob, 'id' | 'schedule' | 'createdAt'>,
  lastRun: Record<string, number>,
  retry: CronRetryEntry | undefined,
  nowEpoch: number,
  localNow: Date,
  catchupMin: number,
): number | null {
  if (retry && retry.schedule === job.schedule) {
    // Execution retries are stale once the occurrence is consumed. Delivery
    // outbox entries are different: submit/tool execution was intentionally
    // consumed before the send, and the archived payload must still drain.
    if (
      retry.phase !== 'delivery' &&
      lastRun[job.id] !== undefined && lastRun[job.id]! >= retry.dueMinuteKey
    ) return null
    if (retry.nextAttemptAt > nowEpoch) return null
    return retry.dueMinuteKey
  }
  return resolveDueMinute(job, lastRun, nowEpoch, localNow, catchupMin)
}

// ── Runtime quotas (container API create/update paths only) ──────────────────

/** OC_CRON_MAX_JOBS: cap total jobs in cron.yaml. Default 50, "0"/invalid → 50.
 *  Only enforced on addJob (API/tool create), never on personal seed. */
export function getMaxJobs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OC_CRON_MAX_JOBS
  if (raw === undefined || raw.trim() === '') return 50
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 50
  return Math.trunc(n)
}

/** OC_CRON_MAX_PER_HOUR: cap how many minutes in an hour a schedule may hit.
 *  Default 12 (=every 5 minutes). "0"/invalid → 12. */
export function getMaxPerHour(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OC_CRON_MAX_PER_HOUR
  if (raw === undefined || raw.trim() === '') return 12
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 12
  return Math.trunc(n)
}

/**
 * Count how many of minutes 0-59 the schedule's minute field matches — i.e. the
 * per-hour firing frequency for schedules whose other fields let the hour run.
 * Uses the same matcher (fieldMatches) as execution so the quota can never
 * disagree with what actually fires. Returns 0 for an invalid expression
 * (validateCronSchedule already rejects those upstream).
 */
export function countMinuteHitsPerHour(schedule: string): number {
  const fields = schedule.trim().split(/\s+/)
  if (fields.length !== 5) return 0
  const minuteField = fields[0]
  let hits = 0
  for (let m = 0; m <= 59; m++) {
    if (fieldMatches(minuteField, m)) hits++
  }
  return hits
}

/**
 * Return an English rejection message (透传给模型) when a schedule fires more
 * often than OC_CRON_MAX_PER_HOUR per hour, else null. Prefixed with
 * `Invalid cron schedule` so tool callers surface it consistently with the
 * range/shape validator; the message tells the model how to fix it (5-min floor).
 * (字面星号斜杠会终止本块注释,故文中用 "N-minute" 而非符号写法。)
 */
export function frequencyQuotaError(
  schedule: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const max = getMaxPerHour(env)
  const hits = countMinuteHitsPerHour(schedule)
  if (hits > max) {
    return (
      `Invalid cron schedule "${schedule}": fires ${hits} times per hour, ` +
      `exceeding the limit of ${max}. Use a coarser minute field ` +
      `(recommended minimum interval is 5 minutes) or raise OC_CRON_MAX_PER_HOUR.`
    )
  }
  return null
}

export class CronScheduler {
  private timer: NodeJS.Timeout | null = null
  private bootTickTimer: NodeJS.Timeout | null = null
  private stopped = false
  private running = false
  /** Reference to last-active-channel map for heartbeat session routing.
   *  Shape must stay in sync with Gateway's `lastActiveChannel` — the
   *  `userId` field was added so gateway can route heartbeats per-user. */
  public lastActiveChannel?: Map<
    string,
    {
      channel: string
      peerId: string
      sessionKey: string
      userId: string
      at: number
    }
  >
  /** Master wake-index push config; null on personal/dev (no master env) → every
   *  maybePushCronIndex is a cheap no-op. Read once in start() (env is fixed for
   *  the process lifetime), so a personal container never even computes the index. */
  private cronIndexCfg: V3WechatOutboundConfig | null = null
  /** Last (nextFireAt, enabledCount) actually reported to master. Push only when
   *  the value changes — avoids a POST every tick. Updated optimistically (before
   *  the fire-and-forget send resolves): a dropped push is recovered by master's
   *  periodic rescan, so we trade at-least-once for far fewer POSTs. */
  private lastCronIndex: CronIndexPayload | null = null
  /** job.id → 连续「余额不足」失败次数(内存态,容器重启清零 —— 失败仍在就会重新累积,
   *  最多多试 CREDIT_FAIL_PAUSE_THRESHOLD 轮,可接受)。成功产出即清零。 */
  private creditFailStreak = new Map<string, number>()
  /** Retry state is persisted and bound to the exact due minute + schedule.
   * It survives catch-up expiry/restarts and cannot be mixed with a newer fire. */
  private retryState = new Map<string, CronRetryEntry>()

  private async persistRetryState(): Promise<void> {
    await saveRetryState(this.retryState)
  }

  private async persistLastRun(map: Record<string, number>): Promise<void> {
    await saveLastRun(map)
  }

  private async stageDeliveryOutbox(
    job: CronJob,
    dueMinuteKey: number,
    nowEpoch: number,
    outputFile: string,
  ): Promise<void> {
    const entry: CronRetryEntry = {
      dueMinuteKey,
      schedule: job.schedule,
      failures: 0,
      nextAttemptAt: nowEpoch,
      code: 'DELIVERY_PENDING',
      phase: 'delivery',
      outputFile,
      deliveryId: cronDeliveryId(job.id, dueMinuteKey),
    }
    this.retryState.set(job.id, entry)
    try {
      await this.persistRetryState()
    } catch (err) {
      this.retryState.delete(job.id)
      throw err
    }
  }

  constructor(
    private config: OpenClaudeConfig,
    private sessions: SessionManager,
    private onDeliver: (
      text: string,
      job: CronJob,
      delivery?: CronDeliveryContext,
    ) => void | Promise<void>,
    private onOriginSessionFire?: (
      job: CronJob,
      delivery: CronDeliveryContext,
    ) => Promise<CronOriginFireResult>,
  ) {}

  /**
   * Push the derived wake-index payload to master when it changed since the last
   * report. Fire-and-forget; no-op entirely when master env absent.
   */
  private maybePushCronIndex(file: CronFile): void {
    if (!this.cronIndexCfg) return
    const payload = deriveCronIndexPayload(file, new Date())
    if (
      this.lastCronIndex &&
      this.lastCronIndex.nextFireAt === payload.nextFireAt &&
      this.lastCronIndex.enabledCount === payload.enabledCount
    ) {
      return
    }
    this.lastCronIndex = payload
    void postCronIndex(payload, { config: this.cronIndexCfg }).catch(() => {})
  }

  async start(): Promise<void> {
    // Read wake-index config once (env fixed for process lifetime).
    this.cronIndexCfg = readV3CronIndexConfig()
    const initialFile = await ensureCronFile()
    // Seed master with the current index right after boot so a just-restarted
    // container advertises its next fire even before the first tick.
    this.maybePushCronIndex(initialFile)
    // Tick once per minute
    this.timer = setInterval(() => {
      if (this.stopped) return
      if (!this.running) this.tick().catch((err) => logger.error('tick failed', {
        errorClass: stableCronErrorClass(err),
      }))
    }, 60_000)
    // Fire an initial tick 10s after boot (not immediate, to avoid startup race).
    // Track the handle so stop() can cancel it during shutdown.
    this.bootTickTimer = setTimeout(() => {
      this.bootTickTimer = null
      if (this.stopped) return
      this.tick().catch(() => {})
    }, 10_000)
    logger.info('scheduler started')
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.bootTickTimer) clearTimeout(this.bootTickTimer)
    this.bootTickTimer = null
  }

  private async tick(): Promise<void> {
    this.running = true
    try {
      const file = await ensureCronFile()
      // Load lastRun once at the start of the tick — all updates accumulate in
      // memory and are flushed in a single write at the end, eliminating the
      // concurrent read-modify-write race condition.
      const lastRun = await loadLastRun()
      this.retryState = await loadRetryState()
      const now = new Date()
      const localNow = getLocalDate()
      const agentsConfig = await readAgentsConfig()
      const occurrenceRecords = await loadOccurrenceRecords()
      const pendingOccurrenceJobs = new Set(
        occurrenceRecords.filter((row) => row.state !== 'delivered').map((row) => row.jobId),
      )

      // Cleanup: remove completed oneshot jobs from yaml
      const before = file.jobs.length
      file.jobs = file.jobs.filter((j) => !(
        j.oneshot && j.enabled === false && !this.retryState.has(j.id) &&
        !pendingOccurrenceJobs.has(j.id)
      ))
      if (file.jobs.length < before) {
        await atomicWriteYaml(paths.cronYaml, file)
      }

      // Cleanup: delete output files older than 7 days
      this._cleanupOldOutputs().catch(() => {})

      const catchupMin = getCatchupMinutes()
      let lastRunDirty = false
      let retryStateDirty = false
      const completedRetryIds = new Set<string>()
      const liveJobs = new Map(file.jobs.map((job) => [job.id, job]))
      for (const occurrence of occurrenceRecords) {
        const job = liveJobs.get(occurrence.jobId)
        if (!job || job.schedule !== occurrence.schedule) continue
        const recovery = classifyCronOccurrenceRecovery(
          occurrence,
          occurrence.state === 'executing' ? readOccurrenceTape(occurrence.deliveryId) : [],
        )
        if (recovery === 'rerun') {
          if (occurrence.state === 'executing') {
            writeOccurrence({ ...occurrence, state: 'prepared', updatedAt: Date.now() })
          }
          const existing = this.retryState.get(job.id)
          if (!existing || existing.deliveryId !== occurrence.deliveryId) {
            this.retryState.set(job.id, {
              dueMinuteKey: occurrence.dueMinuteKey,
              schedule: occurrence.schedule,
              failures: 1,
              nextAttemptAt: 0,
              code: 'OCCURRENCE_PREPARED',
              phase: 'execution',
              deliveryId: occurrence.deliveryId,
            })
            retryStateDirty = true
          }
        } else if (recovery === 'deliver_only' && (job.deliver ?? 'local') === 'local') {
          // Execution and archive are already durable; local delivery is a
          // no-op, so a crash between markCompleted and markDelivered is done.
          settleOccurrence(occurrence)
        } else if (recovery === 'deliver_only') {
          const outputFile = occurrence.outputFile
          const existing = this.retryState.get(job.id)
          if (
            outputFile && outputFile === basename(outputFile) &&
            !(existing?.phase === 'delivery' && existing.deliveryId === occurrence.deliveryId)
          ) {
            this.retryState.set(job.id, {
              dueMinuteKey: occurrence.dueMinuteKey,
              schedule: occurrence.schedule,
              failures: 0,
              nextAttemptAt: 0,
              code: 'DELIVERY_PENDING',
              phase: 'delivery',
              outputFile,
              deliveryId: occurrence.deliveryId,
            })
            retryStateDirty = true
          }
        } else if (recovery === 'unknown') {
          if (lastRun[job.id] === undefined || lastRun[job.id]! < occurrence.dueMinuteKey) {
            lastRun[job.id] = occurrence.dueMinuteKey
            lastRunDirty = true
          }
          const existing = this.retryState.get(job.id)
          if (existing?.deliveryId === occurrence.deliveryId) {
            this.retryState.delete(job.id)
            retryStateDirty = true
          }
          job.enabled = false
          await atomicWriteYaml(paths.cronYaml, file)
          settleOccurrence(occurrence, 'needs_confirmation')
          if (isUserInitiatedCronJob(job)) {
            const label = job.label || job.id
            try {
              await this.onDeliver(
                `⏸️ 定时任务「${label}」上次执行中断，外部操作结果无法确认。` +
                  `为避免重复操作已自动暂停；请确认结果后再重新启用。`,
                (job.deliver ?? 'local') === 'local'
                  ? { ...job, deliver: 'webchat' }
                  : job,
                {
                  dueMinuteKey: occurrence.dueMinuteKey,
                  deliveryId: occurrence.deliveryId,
                },
              )
            } catch (err) {
              logger.warn(`needs-confirmation notice failed for ${job.id}`, {
                jobId: job.id,
                errorClass: stableCronErrorClass(err),
              })
            }
          }
        } else if (recovery === 'done') {
          settleOccurrence(occurrence)
        }
      }
      // A replaced/disabled job must not inherit an old occurrence. A retry
      // whose due minute was already durably consumed is stale after a crash
      // between last-run save and retry-file cleanup, so prune it without run.
      for (const [jobId, retry] of this.retryState) {
        const job = liveJobs.get(jobId)
        const consumed = lastRun[jobId] !== undefined && lastRun[jobId]! >= retry.dueMinuteKey
        const predatesCreation = job?.createdAt !== undefined && retry.dueMinuteKey * 60_000 < job.createdAt
        if (
          !job ||
          (job.enabled === false && !job.oneshot) ||
          job.schedule !== retry.schedule ||
          (consumed && retry.phase !== 'delivery') ||
          predatesCreation
        ) {
          this.retryState.delete(jobId)
          retryStateDirty = true
        }
      }
      try {
        for (const job of file.jobs ?? []) {
          const existingRetry = this.retryState.get(job.id)
          if (job.enabled === false && !(job.oneshot && existingRetry)) continue
          // A persisted retry owns its original occurrence even after the
          // catch-up window expires. New high-frequency occurrences wait until
          // this one reaches success/permanent failure/exhaustion.
          const dueMinuteKey = resolveCronOccurrence(
            job, lastRun, existingRetry, now.getTime(), localNow, catchupMin,
          )
          if (dueMinuteKey === null) continue
          const deliveryContext: CronDeliveryContext = {
            dueMinuteKey,
            deliveryId: existingRetry?.deliveryId ?? cronDeliveryId(job.id, dueMinuteKey),
          }
          let outcome: CronRunOutcome
          if (existingRetry?.phase === 'delivery') {
            outcome = await this.retryArchivedDelivery(job, existingRetry)
          } else if (isHiddenSystemAgentId(job.agent)) {
            logger.warn(`job ${job.id}: hidden system agent rejected`, {
              jobId: job.id,
              agent: job.agent,
            })
            outcome = { kind: 'terminal_failure', code: 'HIDDEN_SYSTEM_AGENT' }
          } else {
            const agent = agentsConfig.agents.find((a) => a.id === job.agent)
            if (!agent) {
              logger.warn(`job ${job.id}: agent ${job.agent} not found`, {
                jobId: job.id,
                agent: job.agent,
              })
              outcome = { kind: 'terminal_failure', code: 'AGENT_NOT_FOUND' }
            } else {
              try {
                outcome = await this.runJob(job, agent, {
                  consumeOccurrence: async () => {
                    const record: CronOccurrenceRecord = {
                      version: 1,
                      deliveryId: deliveryContext.deliveryId,
                      jobId: job.id,
                      dueMinuteKey,
                      schedule: job.schedule,
                      state: 'prepared',
                      sessionKey: `agent:${agent.id}:cron:dm:${job.id}:${deliveryContext.deliveryId}`,
                      tapeEvents: 0,
                      updatedAt: Date.now(),
                    }
                    const existing = readOccurrence(deliveryContext.deliveryId)
                    if (!existing) writeOccurrence(record)
                    this.retryState.set(job.id, {
                      dueMinuteKey,
                      schedule: job.schedule,
                      failures: Math.max(1, existingRetry?.failures ?? 1),
                      nextAttemptAt: 0,
                      code: 'OCCURRENCE_PREPARED',
                      phase: 'execution',
                      deliveryId: deliveryContext.deliveryId,
                    })
                    await this.persistRetryState()
                    retryStateDirty = false
                    if (job.oneshot && job.enabled !== false) {
                      job.enabled = false
                      await saveCronFile(await ensureCronFile(), job)
                    }
                  },
                  markSubmitStarted: async () => {
                    const record = readOccurrence(deliveryContext.deliveryId)
                    if (!record || record.state !== 'prepared')
                      throw new Error('cron occurrence is not prepared')
                    writeOccurrence({ ...record, state: 'executing', updatedAt: Date.now() })
                    lastRun[job.id] = dueMinuteKey
                    await this.persistLastRun(lastRun)
                    lastRunDirty = false
                  },
                  recordEvent: (event) => {
                    const record = readOccurrence(deliveryContext.deliveryId)
                    if (!record || record.state !== 'executing') return
                    const tapeEvents = appendOccurrenceTape(deliveryContext.deliveryId, event)
                    writeOccurrence({ ...record, tapeEvents, updatedAt: Date.now() })
                  },
                  markCompleted: async (outputFile) => {
                    const record = readOccurrence(deliveryContext.deliveryId)
                    if (!record) throw new Error('cron occurrence record missing')
                    writeOccurrence({
                      ...record,
                      state: 'completed',
                      outputFile,
                      updatedAt: Date.now(),
                    })
                  },
                  markDelivered: async () => {
                    const record = readOccurrence(deliveryContext.deliveryId)
                    if (!record) return
                    settleOccurrence(record)
                  },
                  markDeliveryTerminal: async () => {
                    const record = readOccurrence(deliveryContext.deliveryId)
                    if (!record) return
                    settleOccurrence(record, 'delivery_terminal')
                  },
                  stageDelivery: async (outputFile) => {
                    await this.stageDeliveryOutbox(
                      job, dueMinuteKey, now.getTime(), outputFile,
                    )
                    const record = readOccurrence(deliveryContext.deliveryId)
                    if (record) writeOccurrence({
                      ...record,
                      state: 'delivery_pending',
                      outputFile,
                      updatedAt: Date.now(),
                    })
                    retryStateDirty = false
                  },
                  recoverInterruptedExecution: async () => {
                    const record = readOccurrence(deliveryContext.deliveryId)
                    if (!record || record.state !== 'executing') return false
                    if (!cronExecutionTapeIsReplaySafe(readOccurrenceTape(record.deliveryId))) {
                      return false
                    }
                    writeOccurrence({ ...record, state: 'prepared', updatedAt: Date.now() })
                    return true
                  },
                }, deliveryContext)
              } catch (err) {
                logger.error(`job ${job.id} execution failed`, {
                  jobId: job.id,
                  errorClass: stableCronErrorClass(err),
                })
                // Unknown exceptions are conservative terminal failures. Once
                // submit may have started, replaying a fresh isolated session
                // can duplicate non-idempotent tool side effects.
                outcome = { kind: 'terminal_failure', code: 'EXECUTION_ERROR' }
              }
            }
          }
          if (outcome.kind === 'retryable_failure') {
            const planned = planCronRetry(this.retryState.get(job.id) ?? existingRetry, {
              dueMinuteKey,
              schedule: job.schedule,
              nowEpoch: now.getTime(),
              code: outcome.code,
              phase: outcome.retry?.phase,
              outputFile: outcome.retry?.phase === 'delivery' ? outcome.retry.outputFile : undefined,
              deliveryId: deliveryContext.deliveryId,
            })
            if (planned.kind === 'retry') {
              this.retryState.set(job.id, planned.entry)
              // Persist immediately. Execution retries exist only before
              // submit, so replay is safe. Delivery retries already have both
              // a consumed occurrence and a persisted pending outbox; if this
              // update fails, the older outbox still prevents agent replay.
              await this.persistRetryState()
              retryStateDirty = false
              logger.warn(`job ${job.id} will retry after transient failure`, {
                jobId: job.id,
                code: outcome.code,
                attempt: planned.entry.failures,
                retryInMs: planned.delayMs,
                dueMinuteKey,
              })
              continue
            }
            logger.warn(`job ${job.id} exhausted transient retries`, {
              jobId: job.id,
              code: outcome.code,
              attempts: planned.attempts,
              dueMinuteKey,
            })
            outcome = { kind: 'terminal_failure', code: 'RETRY_EXHAUSTED' }
          }
          if (outcome.kind === 'terminal_failure') {
            const occurrence = readOccurrence(deliveryContext.deliveryId)
            if (occurrence?.state === 'executing' && outcome.code === 'EXECUTION_ERROR') {
              job.enabled = false
              await saveCronFile(await ensureCronFile(), job)
              settleOccurrence(occurrence, 'needs_confirmation')
              if (isUserInitiatedCronJob(job)) {
                const label = job.label || job.id
                try {
                  await this.onDeliver(
                    `⏸️ 定时任务「${label}」执行中断，外部操作结果无法确认。` +
                      `为避免重复操作已自动暂停；请确认结果后再重新启用。`,
                    (job.deliver ?? 'local') === 'local'
                      ? { ...job, deliver: 'webchat' }
                      : job,
                    deliveryContext,
                  )
                } catch (err) {
                  logger.warn(`needs-confirmation notice failed for ${job.id}`, {
                    jobId: job.id,
                    errorClass: stableCronErrorClass(err),
                  })
                }
              }
            } else if (occurrence?.state === 'prepared' || occurrence?.state === 'executing') {
              settleOccurrence(occurrence, 'execution_terminal')
            }
          }
          // A one-shot remains enabled across retryable failures. Completed,
          // silent, permanent and explicitly exhausted outcomes consume it.
          if (job.oneshot) {
            job.enabled = false
            await saveCronFile(await ensureCronFile(), job)
          }
          // Record the minute that actually fired (catch-up records the missed
          // minute M, not "now") so it stays idempotent across restarts.
          lastRun[job.id] = dueMinuteKey
          lastRunDirty = true
          if (this.retryState.has(job.id)) completedRetryIds.add(job.id)
        }
      } finally {
        // Ordering is intentional:durably consume the due minute before deleting
        // its retry entry. A crash in between leaves a delivery outbox to drain
        // (never a reason to execute the agent again).
        if (lastRunDirty) {
          await this.persistLastRun(lastRun)
        }
        for (const jobId of completedRetryIds) {
          this.retryState.delete(jobId)
          retryStateDirty = true
        }
        if (retryStateDirty) await this.persistRetryState()
      }
      // Refresh master's wake index if the derived (nextFireAt, enabledCount)
      // changed this tick (jobs may have been disabled by oneshot cleanup/run).
      // Fire-and-forget; personal version (no master env) no-ops.
      this.maybePushCronIndex(file)
    } finally {
      this.running = false
    }
  }

  private async retryArchivedDelivery(job: CronJob, retry: CronRetryEntry): Promise<CronRunOutcome> {
    if (
      retry.phase !== 'delivery' || !retry.outputFile ||
      retry.outputFile !== basename(retry.outputFile)
    ) {
      return { kind: 'terminal_failure', code: 'DELIVERY_PAYLOAD_INVALID' }
    }
    let text: string
    try {
      text = await readFile(join(paths.cronOutputsDir, retry.outputFile), 'utf8')
    } catch (err) {
      const missing = typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT'
      logger.warn(`delivery payload read failed for ${job.id}`, {
        jobId: job.id,
        code: missing ? 'DELIVERY_PAYLOAD_MISSING' : 'DELIVERY_PAYLOAD_READ_FAILED',
        errorClass: stableCronErrorClass(err),
      })
      if (missing) {
        const deliveryId = retry.deliveryId ?? cronDeliveryId(job.id, retry.dueMinuteKey)
        const occurrence = readOccurrence(deliveryId)
        if (occurrence) settleOccurrence(occurrence, 'delivery_terminal')
        return { kind: 'terminal_failure', code: 'DELIVERY_PAYLOAD_MISSING' }
      }
      return {
            kind: 'retryable_failure', code: 'DELIVERY_PAYLOAD_READ_FAILED',
            retry: { phase: 'delivery', outputFile: retry.outputFile },
          }
    }
    try {
      await this.onDeliver(text.trim(), job, {
        dueMinuteKey: retry.dueMinuteKey,
        deliveryId: retry.deliveryId ?? cronDeliveryId(job.id, retry.dueMinuteKey),
      })
      const deliveryId = retry.deliveryId ?? cronDeliveryId(job.id, retry.dueMinuteKey)
      const occurrence = readOccurrence(deliveryId)
      if (occurrence) settleOccurrence(occurrence)
      return { kind: 'completed' }
    } catch (err) {
      const failure = deliveryFailureOutcome(err)
      logger.warn(`archived delivery failed for ${job.id}`, {
        jobId: job.id,
        code: failure.code,
        errorClass: stableCronErrorClass(err),
        retryable: failure.kind === 'retryable_failure',
      })
      if (failure.kind === 'retryable_failure')
        return { ...failure, retry: { phase: 'delivery', outputFile: retry.outputFile } }
      const deliveryId = retry.deliveryId ?? cronDeliveryId(job.id, retry.dueMinuteKey)
      const occurrence = readOccurrence(deliveryId)
      if (occurrence) settleOccurrence(occurrence, 'delivery_terminal')
      return failure
    }
  }

  /**
   * origin-session fire: Gateway injects a new inbound into the creating
   * conversation. Isolated runJob is the fallback when that session is gone.
   * Consume the occurrence before inject so a crash retries the same
   * deliveryId (inbound idempotency) instead of double-creating work.
   */
  private async runOriginSessionJob(
    job: CronJob,
    durability: CronRunDurabilityHooks,
    deliveryContext: CronDeliveryContext,
  ): Promise<CronRunOutcome | 'fallback'> {
    try {
      await durability.consumeOccurrence()
    } catch (err) {
      logger.warn(`job ${job.id} origin-session occurrence persist failed`, {
        jobId: job.id,
        errorClass: stableCronErrorClass(err),
      })
      return { kind: 'retryable_failure', code: 'OCCURRENCE_PERSIST_FAILED' }
    }
    let result: CronOriginFireResult
    try {
      result = await this.onOriginSessionFire!(job, deliveryContext)
    } catch (err) {
      logger.warn(`job ${job.id} origin-session inject threw`, {
        jobId: job.id,
        errorClass: stableCronErrorClass(err),
      })
      return { kind: 'retryable_failure', code: 'ORIGIN_SESSION_INJECT_FAILED' }
    }
    if (result.kind === 'fallback') return 'fallback'
    if (result.kind === 'retryable_failure' || result.kind === 'terminal_failure') {
      return result
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const outPath = join(paths.cronOutputsDir, `${job.id}-${ts}.md`)
    try {
      await mkdir(dirname(outPath), { recursive: true })
      await writeFile(outPath, `[origin-session injected]\n${job.prompt}\n`)
    } catch (err) {
      logger.warn(`job ${job.id} origin-session output archive failed`, {
        jobId: job.id,
        errorClass: stableCronErrorClass(err),
      })
      return { kind: 'terminal_failure', code: 'OUTPUT_ARCHIVE_FAILED' }
    }
    const archived = basename(outPath)
    try {
      await durability.markSubmitStarted?.()
      await durability.markCompleted?.(archived)
      await durability.markDelivered?.()
    } catch (err) {
      logger.warn(`job ${job.id} origin-session durability mark failed`, {
        jobId: job.id,
        errorClass: stableCronErrorClass(err),
      })
      return { kind: 'retryable_failure', code: 'ORIGIN_SESSION_SETTLE_FAILED' }
    }
    logger.info(`job ${job.id} origin-session injected`, { jobId: job.id })
    return { kind: 'completed' }
  }

  private async runJob(
    job: CronJob,
    agent: AgentDef,
    durability: CronRunDurabilityHooks,
    deliveryContext: CronDeliveryContext = {
      dueMinuteKey: Math.floor(Date.now() / 60_000),
      deliveryId: cronDeliveryId(job.id, Math.floor(Date.now() / 60_000)),
    },
  ): Promise<CronRunOutcome> {
    logger.info(`running job ${job.id}`, { jobId: job.id, heartbeat: !!job.heartbeat })

    if (job.resume === 'origin-session' && job.sourceSessionKey && this.onOriginSessionFire) {
      const originOutcome = await this.runOriginSessionJob(job, durability, deliveryContext)
      if (originOutcome !== 'fallback') return originOutcome
      logger.info(`job ${job.id} origin-session fell back to isolated execution`, {
        jobId: job.id,
      })
    }

    // Isolated session per execution for ALL jobs (heartbeat included).
    // Sharing the user's main session polluted conversation history and, when
    // the heartbeat turn crashed mid-execution, left a broken trailing turn
    // that caused the user's follow-up messages to return "本轮响应为空".
    // Delivery still targets the user's last-active channel via server.ts
    // (see onDeliver), which reads lastActiveChannel independently.
    const sessionKey = `agent:${agent.id}:cron:dm:${job.id}:${deliveryContext.deliveryId}`

    // 合成首帧路由字段补齐:cron 是进程内直接派发的会话首帧,完全绕过 master bridge
    // 的 codex 计费编排(preCheck / server-owned requestId / inflight journal)。host
    // 平台 agent(如 `main`)的 cron 又无 per-user 计费主体,因此**不能落 codex engine**
    // (会被 CODEX_BILLING_GUARD 100% fail-closed 拒)。这里显式解析出非 codex 执行模型,
    // 与 agent 交互态默认(可能是 gpt-5.5=codex)解耦;非 codex agent 返回 undefined,
    // 沿用原默认(行为不变)。同点传入 getOrCreate(决定 runner engine)+ submit(路由字段)。
    const cronRoute = resolveSyntheticTurnModel(agent, this.config.defaults.model)
    // ── 模型权威 §3:cron 是**无 envelope 的本地路径** ────────────────────────
    // flag 开(托管)→ 判定源换成 master 的 per-uid catalog 投影:归一 / 可用性(active)/
    // engine **全取投影**,容器镜像里 baked 的两张表不再参与(它们与 catalog 必然漂移)。
    // codex 意图仍按真值表**降级为非 codex**(既有语义,cron 无 server-owned requestId)。
    // 投影拉不到 → 抛 → 本 job 本次不执行(**无 baked 回落**,R1-B1)。
    // flag 未开(个人版/过渡期)→ undefined → 完全沿用上面的 baked 合成降级,零变化。
    // 判定失败用结构化 outcome 返回:catalog 临时不可用不消费本次 schedule,
    // 永久不支持则消费；tick 对每个 job 独立处理，单项失败不会饿死后续任务。
    let cronExec: LocalExecutionDecision | undefined
    try {
      cronExec = await resolveLocalExecutionIfEnforced({
        agent,
        kind: 'synthetic',
        model: cronRoute?.model,
        defaultModel: this.config.defaults.model,
      })
    } catch (err) {
      const code = localExecutionRejectCode(err)
      if (!code) throw err
      logger.error(`job ${job.id} rejected by model catalog`, {
        jobId: job.id,
        agent: agent.id,
        code,
      })
      return catalogRejectOutcome(code)
    }
    const cronModel = cronExec?.canonicalModel ?? cronRoute?.model
    // MAJOR-2 透明化:cron 是 host 平台维护 turn(无用户面),降级记 runLog/日志即可,不需用户可见。
    const downgradedFrom = cronExec?.downgradedFrom ?? (cronRoute?.downgraded ? cronRoute.originalModel : undefined)
    if (downgradedFrom) {
      logger.info(`job ${job.id} synthetic model downgraded off codex`, {
        jobId: job.id,
        from: downgradedFrom,
        to: cronModel,
      })
    }

    let session: Awaited<ReturnType<SessionManager['getOrCreate']>>
    try {
      session = await this.sessions.getOrCreate({
        sessionKey,
        agent,
        ...(cronModel ? { model: cronModel } : {}),
        ...localExecutionOverride(cronExec),
        channel: 'cron',
        peerId: job.id,
        title: job.heartbeat ? '[heartbeat]' : `[cron] ${job.id}`,
        // Tag this run as a cron workload so CCB stamps
        // `cc_workload=cron;` into the attribution billing-header.
        workload: 'cron',
      })
    } catch (err) {
      // No submit/tool execution has started, so a bounded retry is safe.
      logger.warn(`job ${job.id} session creation failed`, {
        jobId: job.id,
        errorClass: stableCronErrorClass(err),
      })
      return { kind: 'retryable_failure', code: 'SESSION_CREATE_FAILED' }
    }
    try {
      await durability.consumeOccurrence()
    } catch (err) {
      await this.sessions.destroySession(sessionKey).catch(() => {})
      logger.warn(`job ${job.id} occurrence persistence failed before submit`, {
        jobId: job.id,
        errorClass: stableCronErrorClass(err),
      })
      return { kind: 'retryable_failure', code: 'OCCURRENCE_PERSIST_FAILED' }
    }
    let output = ''
    let submitError: unknown = null
    try {
      await durability.markSubmitStarted?.()
      await this.sessions.submit(
        session,
        job.prompt,
        (e) => {
          durability.recordEvent?.(e)
          if (e.kind === 'block' && e.block.kind === 'text') output += e.block.text
        },
        // effortLevel: 不指定(cron 用模型默认档位)
        undefined,
        // model: 与 getOrCreate 同源;非 codex agent 为 undefined(不覆盖)。
        cronModel,
      )
    } catch (err) {
      submitError = err
    } finally {
      // All jobs use isolated sessions — always destroy, even if submit()
      // threw, otherwise the subprocess + resume-map entry would leak until
      // the eviction loop catches it on the next sweep.
      await this.sessions
        .destroySession(sessionKey)
        .catch((err) =>
          logger.warn(`destroySession failed for ${job.id}`, {
            jobId: job.id,
            errorClass: stableCronErrorClass(err),
          }),
        )
    }
    // Persist output
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const outPath = join(paths.cronOutputsDir, `${job.id}-${ts}.md`)
    let archivedOutputFile: string | null = null
    try {
      await mkdir(dirname(outPath), { recursive: true })
      await writeFile(outPath, output)
      archivedOutputFile = basename(outPath)
    } catch (err) {
      logger.warn(`job ${job.id} output archive failed`, {
        jobId: job.id,
        errorClass: stableCronErrorClass(err),
      })
    }
    if (submitError !== null) {
      logger.warn(`job ${job.id} submit failed after execution began`, {
        jobId: job.id,
        errorClass: stableCronErrorClass(submitError),
      })
      if (await durability.recoverInterruptedExecution?.()) {
        return { kind: 'retryable_failure', code: 'SAFE_CHECKPOINT_RECOVERY' }
      }
      return { kind: 'terminal_failure', code: 'EXECUTION_ERROR' }
    }
    // Skip delivery for silence markers AND genuinely empty output. The empty
    // case covers subprocess crashes / API failures mid-turn: without this
    // guard, the user sees an orphan "💓 heartbeat" card with no content.
    const trimmed = output.trim()
    if (!trimmed) {
      logger.warn(`job ${job.id} produced empty output`, { jobId: job.id })
      return { kind: 'terminal_failure', code: 'EMPTY_OUTPUT' }
    }
    if (trimmed.startsWith('[SILENT]') || trimmed === 'HEARTBEAT_OK') {
      if (!archivedOutputFile) return { kind: 'terminal_failure', code: 'OUTPUT_ARCHIVE_FAILED' }
      await durability.markCompleted?.(archivedOutputFile)
      await durability.markDelivered?.()
      logger.info(`job ${job.id} silent/empty, not delivering`, {
        jobId: job.id,
        reason: trimmed.startsWith('[SILENT]') ? 'silent' : 'heartbeat_ok',
      })
      return { kind: 'silent' }
    }

    // 引擎 API 错误产出 = 失败,不是结果。CCB 把上游失败以 "API Error: …" 文本块
    // 流出(不抛),若不识别就会被当正常产出送达 —— 线上事故:402 余额不足叠加
    // 高频 schedule,同一段错误文本被离线兜底反复写成站内信。处理:
    //   - 一律不送达裸错误文本(用户视角它不是任务结果);
    //   - insufficient_credits 是持续性失败 → 连续 CREDIT_FAIL_PAUSE_THRESHOLD 次
    //     持久化停用任务,并送**一条**明确的暂停通知(状态变更通知,凌驾 deliver=local);
    //   - 其余错误类(rate_limited/upstream/bad_request)视为瞬时,只记日志等下轮自愈。
    const apiErr = classifyDelegateOutputError(trimmed)
    if (apiErr) {
      logger.warn(`job ${job.id} produced engine API error, suppressing delivery`, {
        jobId: job.id,
        code: apiErr.code,
      })
      if (apiErr.code === 'insufficient_credits') {
        const fails = (this.creditFailStreak.get(job.id) ?? 0) + 1
        this.creditFailStreak.set(job.id, fails)
        if (fails >= CREDIT_FAIL_PAUSE_THRESHOLD) {
          this.creditFailStreak.delete(job.id)
          job.enabled = false
          await saveCronFile(await ensureCronFile(), job)
          logger.warn(`job ${job.id} auto-paused after consecutive insufficient-credit failures`, {
            jobId: job.id,
            fails,
          })
          const label = job.label || job.id
          try {
            await this.onDeliver(
              `⏸️ 定时任务「${label}」已自动暂停:连续 ${fails} 次因积分余额不足执行失败。` +
                `充值后在管理中心重新启用该任务,或直接在对话里让我帮你重新开启。`,
              job,
              deliveryContext,
            )
          } catch (err) {
            logger.warn(`pause notice delivery failed for ${job.id}`, {
              jobId: job.id,
              errorClass: stableCronErrorClass(err),
            })
          }
        }
      }
      // The engine error is observed only after submit completed and may follow
      // successful tool calls. Consume this occurrence; a fresh session replay
      // would be an unsafe at-least-once execution of those side effects.
      return { kind: 'terminal_failure', code: apiErr.code.toUpperCase() }
    }
    // 正常产出 → 清失败计数(偶发失败不累积成误杀)。
    this.creditFailStreak.delete(job.id)
    if (!archivedOutputFile) return { kind: 'terminal_failure', code: 'OUTPUT_ARCHIVE_FAILED' }
    await durability.markCompleted?.(archivedOutputFile)
    logger.info(`job ${job.id} completed`, {
      jobId: job.id,
      chars: trimmed.length,
      deliver: job.deliver ?? 'local',
    })
    if ((job.deliver ?? 'local') === 'local') {
      // local = just log, don't push to any channel
      await durability.markDelivered?.()
    } else {
      if (!archivedOutputFile) {
        return { kind: 'terminal_failure', code: 'DELIVERY_PAYLOAD_UNAVAILABLE' }
      }
      try {
        await durability.stageDelivery(archivedOutputFile)
      } catch (err) {
        logger.warn(`delivery outbox persistence failed for ${job.id}`, {
          jobId: job.id,
          errorClass: stableCronErrorClass(err),
        })
        // The occurrence was already consumed before submit. Do not send
        // without an outbox and, crucially, never re-run model/tool effects.
        return { kind: 'terminal_failure', code: 'DELIVERY_OUTBOX_WRITE_FAILED' }
      }
      logger.info(`delivering job ${job.id} to ${job.deliver}`, {
        jobId: job.id,
        deliver: job.deliver,
      })
      try {
        await this.onDeliver(trimmed, job, deliveryContext)
        await durability.markDelivered?.()
      } catch (err) {
        const failure = deliveryFailureOutcome(err)
        logger.warn(`delivery failed for ${job.id}`, {
          jobId: job.id,
          code: failure.code,
          errorClass: stableCronErrorClass(err),
          retryable: failure.kind === 'retryable_failure',
        })
        if (failure.kind === 'retryable_failure') {
          return archivedOutputFile
            ? { ...failure, retry: { phase: 'delivery', outputFile: archivedOutputFile } }
            : { kind: 'terminal_failure', code: 'DELIVERY_PAYLOAD_UNAVAILABLE' }
        }
        await durability.markDeliveryTerminal?.()
        return failure
      }
    }
    return { kind: 'completed' }
  }

  /**
   * 平台内部通知直投:复用 cron 的送达管线(webchat 推送 + 微信主动投递联动),
   * 但不经过 LLM 执行 —— 给确定性的系统通知(如技能自动回归失败提醒)用。
   */
  async deliverNotice(text: string, job: CronJob): Promise<void> {
    await this.onDeliver(text, job)
  }

  // ── Runtime job management (called by /api/cron) ──

  async addJob(job: CronJob): Promise<void> {
    // 字段数 + 数值范围/形态校验(纯字符正则拦不住 60 分 / 25 时 / dow 7 这类静默失效)。
    const schedErr = validateCronSchedule(job.schedule)
    if (schedErr) {
      throw new Error(`Invalid cron schedule "${job.schedule}": ${schedErr}`)
    }
    // 频率闸:分钟字段每小时命中次数超上限即拒(默认 12 = 星号/5,最短建议 5 分钟间隔)。
    // 错误信息经工具透传给模型,给出可执行的整改方向而非只报错。
    const freqErr = frequencyQuotaError(job.schedule)
    if (freqErr) throw new Error(freqErr)
    const file = await ensureCronFile()
    // Replace if same ID exists — filter first so the count check treats a
    // replace as size-neutral (only genuinely new IDs grow the file).
    const filtered = file.jobs.filter((j) => j.id !== job.id)
    const maxJobs = getMaxJobs()
    if (filtered.length >= maxJobs) {
      // 数量闸:仅 addJob 计数(个人版 seed 走 ensureCronFile 不经此路,不受限)。
      throw new Error(
        `Invalid cron schedule: reminder limit reached (${filtered.length}/${maxJobs} jobs). ` +
          `Delete an existing reminder before creating a new one, or raise OC_CRON_MAX_JOBS.`,
      )
    }
    filtered.push(job)
    file.jobs = filtered
    await atomicWriteYaml(paths.cronYaml, file)
    logger.info(`added job ${job.id}`, { jobId: job.id, schedule: job.schedule })
    // 增删后刷新 master 唤醒索引(handler 不用重复调,scheduler 收口)。
    this.maybePushCronIndex(file)
  }

  async removeJob(id: string): Promise<boolean> {
    const file = await ensureCronFile()
    const before = file.jobs.length
    file.jobs = file.jobs.filter((j) => j.id !== id)
    if (file.jobs.length === before) return false
    await atomicWriteYaml(paths.cronYaml, file)
    logger.info(`removed job ${id}`, { jobId: id })
    this.maybePushCronIndex(file)
    return true
  }

  async updateJob(
    id: string,
    updates: Partial<
      Pick<CronJob, 'enabled' | 'schedule' | 'prompt' | 'label' | 'deliver' | 'oneshot'>
    >,
  ): Promise<boolean> {
    const file = await ensureCronFile()
    const job = file.jobs.find((j) => j.id === id)
    if (!job) return false
    if (updates.enabled !== undefined) job.enabled = updates.enabled
    if (updates.schedule) {
      const schedErr = validateCronSchedule(updates.schedule)
      if (schedErr) {
        throw new Error(`Invalid cron schedule "${updates.schedule}": ${schedErr}`)
      }
      // 改 schedule 同样过频率闸(否则可绕过 addJob 闸把任务改成每分钟)。
      const freqErr = frequencyQuotaError(updates.schedule)
      if (freqErr) throw new Error(freqErr)
      job.schedule = updates.schedule
    }
    if (updates.prompt) job.prompt = updates.prompt
    // label 显式携带即生效:空串 = 清空(回退到 prompt 显示),与 create 的可选语义对称。
    if (updates.label !== undefined) job.label = updates.label || undefined
    if (updates.deliver !== undefined) {
      if (!['local', 'webchat', 'telegram'].includes(updates.deliver as string)) {
        throw new Error(`Invalid deliver "${updates.deliver}": must be local | webchat | telegram`)
      }
      job.deliver = updates.deliver
    }
    // oneshot 可改:重复→一次性(下次触发后自动停用)或反向。改为重复时若任务曾因
    // oneshot 触发被自动停用,调用方应同时传 enabled=true 重新启用(UI 已这么做)。
    if (updates.oneshot !== undefined) job.oneshot = !!updates.oneshot
    await atomicWriteYaml(paths.cronYaml, file)
    logger.info(`updated job ${id}`, { jobId: id })
    this.maybePushCronIndex(file)
    return true
  }

  async listJobs(): Promise<CronJob[]> {
    const file = await ensureCronFile()
    return file.jobs ?? []
  }

  /** List jobs with computed next-run time for UI display */
  async listJobsWithMeta(): Promise<Array<CronJob & { nextRunAt?: string; lastRunAt?: string }>> {
    const file = await ensureCronFile()
    const lastRun = await loadLastRun()
    const now = new Date()
    return (file.jobs ?? []).map((job) => {
      const lastMinKey = lastRun[job.id]
      const lastRunAt = lastMinKey ? new Date(lastMinKey * 60_000).toISOString() : undefined
      const nextRunAt = job.enabled !== false ? computeNextRun(job.schedule, now) : undefined
      return { ...job, nextRunAt, lastRunAt }
    })
  }

  // Delete output files older than 7 days
  private async _cleanupOldOutputs(): Promise<void> {
    const dir = paths.cronOutputsDir
    if (!existsSync(dir)) return
    const cutoff = Date.now() - 7 * 24 * 3600_000
    try {
      const files = await readdir(dir)
      for (const f of files) {
        const fp = join(dir, f)
        const s = await stat(fp)
        if (s.mtimeMs < cutoff) {
          await unlink(fp)
        }
      }
    } catch {}
  }
}

// Helper to update a single job in the cron file (used by oneshot disable)
async function saveCronFile(file: CronFile, updatedJob: CronJob): Promise<void> {
  const idx = file.jobs.findIndex((j) => j.id === updatedJob.id)
  if (idx >= 0) file.jobs[idx] = updatedJob
  await atomicWriteYaml(paths.cronYaml, file)
}

/** Brute-force scan the next 1440 minutes (24h) to find the next matching time.
 *  Exported so the wake-index push (maybePushCronIndex) uses the exact same cron
 *  parser as execution — the master index must never diverge from what fires. */
export function computeNextRun(schedule: string, from: Date): string | undefined {
  const d = new Date(from.getTime())
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1) // start from next minute
  for (let i = 0; i < 1440; i++) {
    if (cronMatches(schedule, d)) return d.toISOString()
    d.setMinutes(d.getMinutes() + 1)
  }
  return undefined
}

/**
 * 从 cron 文件派生上报给 master 的唤醒索引载荷(纯函数,供单测锁定过滤语义)。
 *
 * 只统计**用户发起的**任务(isUserInitiatedCronJob):系统自省 seed(daily-reflection/
 * skill-check/heartbeat 等,v3 迁移卷有存量遗留)不值得为其唤醒容器烧用户积分——
 * 它们仅在容器因其他原因活着时机会性运行(与无唤醒机制时的旧行为一致)。
 * master 侧 rescan(cronWake computeMinNextFire)用同一判定,两侧语义必须对齐。
 */
export function deriveCronIndexPayload(file: CronFile, now: Date): CronIndexPayload {
  let minTs: number | null = null
  let enabledCount = 0
  for (const job of file.jobs ?? []) {
    if (job.enabled === false) continue
    if (!isUserInitiatedCronJob(job)) continue
    enabledCount++
    const next = computeNextRun(job.schedule, now)
    if (next) {
      const ts = Date.parse(next)
      if (!Number.isNaN(ts) && (minTs === null || ts < minTs)) minTs = ts
    }
  }
  return {
    nextFireAt: minTs === null ? null : new Date(minTs).toISOString(),
    enabledCount,
  }
}
