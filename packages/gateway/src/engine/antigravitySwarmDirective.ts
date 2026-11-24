/**
 * Antigravity per-turn Swarm directive & historical-swarm detection (OCV5-842).
 *
 * Keeps `inboundDispatch.ts` concise and directly unit-testable for both:
 *   1. Swarm ON (`swarmMode: true` toggle or `/swarm` slash command)
 *   2. Swarm OFF follow-up on a session that previously created a swarm
 *      (injects an explicit suppression directive so resumed coordinators do
 *      not keep waking historical workers from earlier turns).
 */
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ANTIGRAVITY_ENGINE_MODELS,
  isAntigravitySwarmMemberModel,
  parseSwarmSlashCommand,
} from '@openclaude/protocol'
import { antigravityRoot, antigravitySessionBrainDir } from './antigravityPlatform.js'
import { remoteSwarmLocationForSession } from '../remoteSwarmRuntime.js'

function formatLocalSwarmCliModelGroup(canonicalModelId: string): string | null {
  const entry = ANTIGRAVITY_ENGINE_MODELS.find((m) => m.id === canonicalModelId)
  if (!entry) return null
  const cliModels = entry.cliModels as Readonly<Record<string, string>>
  const efforts = entry.efforts as readonly string[]
  if (efforts.length === 0) {
    return cliModels[entry.defaultEffort] ?? Object.values(cliModels)[0] ?? null
  }
  const values = efforts.map((e) => cliModels[e]).filter((v): v is string => Boolean(v))
  if (values.length === 0) return null
  if (values.length === 1) return values[0]!
  const first = values[0]!
  const suffix = `-${efforts[0]}`
  if (first.endsWith(suffix)) {
    const prefix = first.slice(0, -suffix.length)
    const allMatch = efforts.every((e, i) => values[i] === `${prefix}-${e}`)
    if (allMatch) return `${prefix}-{${efforts.join(',')}}`
  }
  return values.join(' / ')
}

const MAX_ROUTE_SWARM_ALLOWED_MODELS = 32

/**
 * Parse master-injected `_antigravitySwarmAllowedModels` (OCV5-881).
 * Returns `undefined` when absent (legacy master fallback to local catalog view),
 * or an authoritative deduplicated list of built-in local swarm member model ids
 * actually supported by the bound OAuth account for this turn (possibly empty when
 * no extra member models are available beyond an orchestrator primary).
 */
export function extractRouteAllowedLocalSwarmModels(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (out.length >= MAX_ROUTE_SWARM_ALLOWED_MODELS) break
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (!id || seen.has(id) || !isAntigravitySwarmMemberModel(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

export function filterAvailableLocalSwarmModels(
  models: readonly { modelId: string; engine: string; available: boolean }[],
): string[] {
  return models
    .filter(
      (m) =>
        m.available &&
        m.engine === 'antigravity' &&
        isAntigravitySwarmMemberModel(m.modelId),
    )
    .map((m) => m.modelId)
}

export function formatAvailableLocalSwarmModelsHint(
  modelIds?: readonly string[] | null,
): string | null {
  if (!modelIds || modelIds.length === 0) return null
  const groups: string[] = []
  const seen = new Set<string>()
  for (const raw of modelIds) {
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (!id || seen.has(id) || !isAntigravitySwarmMemberModel(id)) continue
    seen.add(id)
    const formatted = formatLocalSwarmCliModelGroup(id)
    if (formatted) groups.push(`\`${formatted}\``)
  }
  return groups.length > 0 ? groups.join('、') : null
}

const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_MEMBERS_JSON_BYTES = 512 * 1024
const MAX_LIVE_MONITORS_REPORTED = 16
/** Strict allowlist for native built-in auxiliary worker names (`monitor` / `narrator`) safe to interpolate into prompts. */
const STRICT_NATIVE_AUX_NAME_RE = /^(?:monitor|narrator)(?:-\d{1,4})?$/i

function isSafeLegacyAuxiliaryName(name: string): boolean {
  const trimmed = name.trim()
  return trimmed.length > 0 && trimmed.length <= 20 && STRICT_NATIVE_AUX_NAME_RE.test(trimmed)
}

export const ANTIGRAVITY_SWARM_ACTIVE_MARKER = '[OpenClaude Antigravity 蜂群模式已激活]'
export const ANTIGRAVITY_SWARM_RESUMED_PREFIX = '续聊蜂群规则（精简提醒）：'
export const ANTIGRAVITY_SWARM_OFF_MARKER = '[OpenClaude 蜂群模式已关闭]'

export const ANTIGRAVITY_SWARM_OFF_DIRECTIVE = [
  ANTIGRAVITY_SWARM_OFF_MARKER,
  '用户已在界面关闭本轮蜂群开关。请以单 Agent 模式直接回复并完成本轮任务，禁止调用 `swarm`、`post_message`、`read_board`、`swarm_wait` 工具，也不要唤醒、检查或复用此前的蜂群成员（除非用户在本轮消息中明确要求使用蜂群或 `/swarm`）。',
  '',
].join('\n')

export interface AntigravitySwarmCompactionContext {
  readonly isAntigravityTurn: boolean
  readonly isRemoteAntigravity: boolean
  readonly swarmMode: boolean
  readonly rawUserText: string
  readonly appliedMode?: 'on_full' | 'on_resumed' | 'off_with_history'
  readonly appliedDirectivePrefix?: string
  readonly availableLocalSwarmModels?: readonly string[]
  readonly liveMonitorNames?: readonly string[]
}

export type AntigravitySwarmTurnInput =
  | string
  | Array<{ type: string; [key: string]: unknown }>

function resolveRegularFileNoSymlink(
  rootDir: string,
  segments: readonly string[],
): { fullPath: string; dev: number; ino: number } | null {
  try {
    const rootStat = lstatSync(rootDir)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null
    let cur = rootDir
    for (let i = 0; i < segments.length - 1; i += 1) {
      cur = join(cur, segments[i]!)
      const st = lstatSync(cur)
      if (st.isSymbolicLink() || !st.isDirectory()) return null
    }
    const leaf = join(cur, segments[segments.length - 1]!)
    const leafStat = lstatSync(leaf)
    if (leafStat.isSymbolicLink() || !leafStat.isFile()) return null
    return { fullPath: leaf, dev: leafStat.dev, ino: leafStat.ino }
  } catch {
    return null
  }
}

function isRegularFileNoSymlink(rootDir: string, segments: readonly string[]): boolean {
  return resolveRegularFileNoSymlink(rootDir, segments) !== null
}

function readBoundedRegularJsonNoSymlink(
  rootDir: string,
  segments: readonly string[],
): Record<string, unknown> | null {
  const resolved = resolveRegularFileNoSymlink(rootDir, segments)
  if (!resolved) return null
  let fd: number | null = null
  try {
    const flags =
      fsConstants.O_RDONLY |
      (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0)
    fd = openSync(resolved.fullPath, flags)
    const st = fstatSync(fd)
    if (!st.isFile() || st.dev !== resolved.dev || st.ino !== resolved.ino) return null
    if (st.size <= 0 || st.size > MAX_MEMBERS_JSON_BYTES) return null
    const parsed = JSON.parse(readFileSync(fd, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
}

/**
 * List any live (non-killed) built-in `monitor` / `monitor-N` workers lingering
 * in an existing swarm roster so the coordinator can reclaim them instead of
 * letting their 3-minute cron burn tokens (OCV5-848).
 */
export function listLiveAntigravitySwarmMonitors(opts: {
  sessionKey: string
  isRemote: boolean
  conversationId?: string
  antigravityRootDir?: string
  remoteSwarmRootBase?: string
}): string[] {
  let roster: Record<string, unknown> | null = null
  if (opts.isRemote) {
    const loc = remoteSwarmLocationForSession(opts.sessionKey, opts.remoteSwarmRootBase)
    roster = readBoundedRegularJsonNoSymlink(loc.brainDir, [
      loc.swarmId,
      '.system_generated',
      'swarm',
      'members.json',
    ])
  } else {
    const convId = opts.conversationId?.trim()
    if (!convId || !CONVERSATION_ID_RE.test(convId)) return []
    const brainDir = antigravitySessionBrainDir(opts.antigravityRootDir ?? antigravityRoot(), opts.sessionKey)
    roster = readBoundedRegularJsonNoSymlink(brainDir, [
      convId,
      '.system_generated',
      'swarm',
      'members.json',
    ])
  }
  const members = roster?.members
  if (!members || typeof members !== 'object' || Array.isArray(members)) return []
  const live: string[] = []
  for (const [name, raw] of Object.entries(members as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const rec = raw as Record<string, unknown>
    if (rec.killed === true) continue
    // Only accept strictly validated built-in auxiliary names (`monitor` / `narrator` / `*-N`)
    // so untrusted or corrupted roster keys can never inject arbitrary text into prompts.
    if (isSafeLegacyAuxiliaryName(name)) {
      live.push(name.trim())
    }
  }
  return live.sort().slice(0, MAX_LIVE_MONITORS_REPORTED)
}

/**
 * Returns true if this Antigravity session already has a persisted swarm roster
 * (`members.json`) on disk for the active local conversation or remote session.
 */
export function hasHistoricalAntigravitySwarm(opts: {
  sessionKey: string
  isRemote: boolean
  conversationId?: string
  antigravityRootDir?: string
  remoteSwarmRootBase?: string
}): boolean {
  if (opts.isRemote) {
    const loc = remoteSwarmLocationForSession(opts.sessionKey, opts.remoteSwarmRootBase)
    return isRegularFileNoSymlink(loc.brainDir, [loc.swarmId, '.system_generated', 'swarm', 'members.json'])
  }
  const convId = opts.conversationId?.trim()
  if (!convId || !CONVERSATION_ID_RE.test(convId)) return false
  const brainDir = antigravitySessionBrainDir(opts.antigravityRootDir ?? antigravityRoot(), opts.sessionKey)
  return isRegularFileNoSymlink(brainDir, [convId, '.system_generated', 'swarm', 'members.json'])
}

export interface AntigravitySwarmTurnDirectiveResult {
  readonly text: string
  readonly mode: 'on' | 'off_with_history' | 'none'
  readonly viaSlash: boolean
  readonly viaToggle: boolean
  readonly isResumedCompact?: boolean
  readonly appliedDirectivePrefix?: string
}

function buildAntigravitySwarmOnDirective(opts: {
  isRemoteAntigravity: boolean
  hasHistoricalSwarm: boolean
  liveMonitorNames?: readonly string[]
  availableLocalSwarmModels?: readonly string[]
}): string {
  const swarmToolsIntro = opts.isRemoteAntigravity
    ? '用户已显式开启远端 Antigravity 蜂群（Swarm）模式（由容器侧蜂群运行时驱动，通过 `swarm`、`post_message`、`read_board`、`swarm_wait` 四个 MCP 工具编排并行成员，每个成员同样运行在远端 Gemini 并拥有完整的本地工作区工具与 Git Worktree 隔离）。请按以下规则作为 Coordinator 编排蜂群：'
    : '用户已显式开启 Antigravity 原生蜂群（Swarm）模式。本 OpenClaude 蜂群指令覆盖原生蜂群说明中的模型选择、工作分派、看板链接与推送条款；请按以下规则作为 Coordinator 编排蜂群：'
  const liveMonitors = (opts.liveMonitorNames ?? [])
    .map((n) => n.trim())
    .filter((n) => isSafeLegacyAuxiliaryName(n))
    .slice(0, MAX_LIVE_MONITORS_REPORTED)
  const legacyMonitorCleanupLine =
    liveMonitors.length > 0
      ? `   - 检测到历史蜂群仍有残留原生辅助成员（${liveMonitors.map((n) => `\`${n}\``).join('、')}），请优先调用 \`swarm{action:"kill", name:"..."}\` 将其回收，避免后台定时空转消耗上下文。`
      : null
  const hasExplicitLocalAllowlist =
    !opts.isRemoteAntigravity && Array.isArray(opts.availableLocalSwarmModels)
  const localModelsHint = opts.isRemoteAntigravity
    ? null
    : formatAvailableLocalSwarmModelsHint(opts.availableLocalSwarmModels)
  const modelRuleLine = opts.isRemoteAntigravity
    ? '2. 招募成员时**不要指定 `model` 参数**（留空以继承当前会话模型，确保计费与权限一致）。'
    : localModelsHint
      ? `2. **按成员模型选择**：默认留空 \`model\` 继承当前会话模型；如需按分工或用户要求为特定成员指定不同模型，可在 \`swarm{action:"add", model:"..."}\` 中指定（或对 \`waiting\` 成员用 \`swarm{action:"model", name:"...", model:"..."}\` 切换）。仅可使用本次已放行的 Antigravity 自带模型：${localModelsHint}（即使 \`swarm{action:"models"}\` 显示其他未授权或旧版模型也请勿选用，中继会按白名单拒放；不支持外部非 Antigravity 模型，系统按各成员实际模型独立计费）。`
      : hasExplicitLocalAllowlist
        ? '2. **按成员模型选择**：本轮绑定账号未放行额外蜂群成员模型，招募成员时请留空 `model` 继承当前会话模型（切勿指定未放行或外部模型）。'
        : '2. **按成员模型选择**：默认留空 `model` 继承当前会话模型；如需按分工或用户要求为特定成员指定不同模型，可先用 `swarm{action:"models"}` 查看 Antigravity 自带可用模型，再在 `swarm{action:"add", model:"..."}` 中指定（或对 `waiting` 成员用 `swarm{action:"model", name:"...", model:"..."}` 切换；仅限平台已放行的 Antigravity 自带模型，不支持外部模型，系统按实际模型独立计费）。'
  const resumedModelRule = opts.isRemoteAntigravity
    ? '招募成员不传 `model`'
    : localModelsHint
      ? `招募成员默认留空 \`model\` 继承主模型，也可按需指定已放行的 Antigravity 自带模型（${localModelsHint}；勿选列表外模型）`
      : hasExplicitLocalAllowlist
        ? '招募成员留空 `model` 继承主模型'
        : '招募成员默认留空 `model` 继承主模型，也可按需指定已放行的 Antigravity 自带模型'
  const resumedLocalWorkerBoundary = opts.isRemoteAntigravity
    ? ''
    : '；原生 worker 无 MCP 工具（`brief` 勿要求调 MCP）'

  // Remote Antigravity runs via containerLane.ts and cannot inspect remote CLI
  // internal 512k compaction (`step_type=23`), so remote swarm-ON turns always
  // send the full 6-rule directive rather than the compact resumed reminder (OCV5-882).
  if (opts.hasHistoricalSwarm && !opts.isRemoteAntigravity) {
    return [
      ANTIGRAVITY_SWARM_ACTIVE_MARKER,
      `${ANTIGRAVITY_SWARM_RESUMED_PREFIX}同任务可复用既有蜂群，多写手并行改码传 \`workspace:"share"\` 划清文件所有权，**同任务收口或切换无关新任务前均须先合入所有 \`share\`/\`branch\` 改动**再 \`swarm{action:"kill"}\`；${resumedModelRule}${resumedLocalWorkerBoundary}；**严禁招募 \`monitor\` / \`monitor-N\` 与 \`narrator\` / \`narrator-N\`**；收口前先 \`kill\` 已完工且不再需要的 worker，再发不带 \`@all\` 的 \`[done] <总结>\`（**严禁 \`@all [done]\`**），切勿输出本地 \`open_board\` 链接。`,
      ...(legacyMonitorCleanupLine ? [legacyMonitorCleanupLine] : []),
      '',
    ].join('\n')
  }

  return [
    ANTIGRAVITY_SWARM_ACTIVE_MARKER,
    swarmToolsIntro,
    opts.isRemoteAntigravity
      ? '1. 若任务可拆分为 2 个及以上可并行推进的独立子方向（或需要独立校验者 review），先用 `swarm{action:"title", title:"..."}` 命名蜂群，再用 `swarm{action:"add", name:"...", brief:"..."}` 招募精简、职责不重叠的成员（蜂群内 `verifier` 仅做功能自测/交叉核验，T0/T1 无需配，不替代 T2 跨家族独立 `auditor`；需跨引擎/跨家族审计时用 `delegate_task`；**严禁招募 `monitor` / `monitor-N` 与 `narrator` / `narrator-N`**，OpenClaude 网关已内置零推理停滞检测与网页端实时 SwarmBoard 渲染），随后调用 `swarm_wait{since:...}` 等待成员汇报并用 `read_board` 审阅结果。'
      : '1. **自包含编排与工具边界**：若任务可拆分为 2 个及以上可并行推进的独立子方向，先用 `swarm{action:"title", title:"..."}` 命名蜂群，再用 `swarm{action:"add", name:"...", brief:"..."}` 招募精简、职责不重叠的成员，随后调用 `swarm_wait{since:...}` 等待汇报并用 `read_board` 审阅结果。注意：① 原生蜂群 worker **仅有 Antigravity 内置工具、不含 `openclaude-memory` MCP 工具**（写 `brief` 时勿要求 worker 调用 `oc_bash` / `oc_grep` / `skill_view` 等 MCP 工具）；② 蜂群内 `verifier` 仅做功能自测/交叉核验（T0/T1 无需配，不替代 T2 跨家族独立 `auditor`；需跨引擎/跨家族审计时请改用 `delegate_task`）；③ **严禁招募 `monitor` / `monitor-N` 与 `narrator` / `narrator-N` 成员**（OpenClaude 网关已接管零推理停滞检测与网页端 SwarmBoard 实时渲染）。',
    ...(legacyMonitorCleanupLine ? [legacyMonitorCleanupLine] : []),
    modelRuleLine,
    '3. **生命周期边界（仅限本轮蜂群开启时）**：同任务续聊可复用既有蜂群；若切换到全新无关任务，确认旧成员无未合入改动后再 `swarm{action:"kill"}` 回收旧 worker（或开独立频道隔离）并更新 `title`。后续若关闭蜂群开关，不得再自动复用旧蜂群。',
    '4. **Git 仓库并行写手与防丢合入**：`workspace:"share"` 仅用于零交集文件切片的并行写码，须在 `brief` 中划分清晰文件所有权（只读调研/校验成员保留默认 `inherit`）；worker 禁止自行 `git push`，收尾由 coordinator 检查并合入所有 `share`/`branch` 改动到主工作区再 `kill`，最后按项目规范统一 commit/push。',
    '5. OpenClaude 网页端会实时原生渲染蜂群看板，**切勿**在回复中输出本地 `open_board` 链接或终端 `/swarm board` 命令。',
    '6. 所有成员收口后，先调用 `swarm{action:"kill"}` 清理已完工且不再需要的 worker（避免残留空挂），再在讨论板发一行不带 `@all` 的 `[done] <总结>`（**严禁使用 `@all [done]`**，避免无谓唤醒休眠成员），最后向用户交付清晰、完整的最终汇总（含各独立 worktree 的合入确认结果）。',
    '',
  ].join('\n')
}

export function applyAntigravitySwarmTurnDirective(opts: {
  finalText: string
  rawUserText: string
  isAntigravityTurn: boolean
  isRemoteAntigravity: boolean
  swarmMode: boolean
  hasHistoricalSwarm: boolean
  liveMonitorNames?: readonly string[]
  /** Server-projected local Antigravity canonical model ids available to this user (OCV5-879). */
  availableLocalSwarmModels?: readonly string[]
}): AntigravitySwarmTurnDirectiveResult {
  const slashSwarm = parseSwarmSlashCommand(opts.rawUserText)
  const viaSlash = Boolean(slashSwarm?.matched)
  const viaToggle = opts.swarmMode
  const swarmRequested = viaToggle || viaSlash

  if (!opts.isAntigravityTurn) {
    return { text: opts.finalText, mode: 'none', viaSlash, viaToggle }
  }

  if (swarmRequested) {
    let nextText = opts.finalText
    if (viaSlash && opts.rawUserText && nextText.endsWith(opts.rawUserText)) {
      const prefixPart = nextText.slice(0, nextText.length - opts.rawUserText.length)
      const taskBody =
        slashSwarm?.task ||
        '请先了解当前工作区与上下文，并告知我可以如何拆分为并行蜂群任务。'
      nextText = `${prefixPart}${taskBody}`
    }
    const swarmDirective = buildAntigravitySwarmOnDirective({
      isRemoteAntigravity: opts.isRemoteAntigravity,
      hasHistoricalSwarm: opts.hasHistoricalSwarm,
      liveMonitorNames: opts.liveMonitorNames,
      availableLocalSwarmModels: opts.availableLocalSwarmModels,
    })
    const appliedDirectivePrefix = `${swarmDirective}\n`
    return {
      text: `${appliedDirectivePrefix}${nextText}`,
      mode: 'on',
      viaSlash,
      viaToggle,
      isResumedCompact: opts.hasHistoricalSwarm && !opts.isRemoteAntigravity,
      appliedDirectivePrefix,
    }
  }

  if (opts.hasHistoricalSwarm) {
    const appliedDirectivePrefix = `${ANTIGRAVITY_SWARM_OFF_DIRECTIVE}\n`
    return {
      text: `${appliedDirectivePrefix}${opts.finalText}`,
      mode: 'off_with_history',
      viaSlash,
      viaToggle,
      isResumedCompact: false,
      appliedDirectivePrefix,
    }
  }

  return { text: opts.finalText, mode: 'none', viaSlash, viaToggle, isResumedCompact: false, appliedDirectivePrefix: '' }
}

const HIST_JSON_OPEN = '<openclaude_previous_context_json>\n'
const HIST_JSON_CUR_OPEN = '\n<current_user_message_json>\n'
const HIST_JSON_CUR_CLOSE = '\n</current_user_message_json>'
const STRUCTURAL_XML_ENVELOPES: ReadonlyArray<{ open: string; curOpen: string; curClose: string }> = [
  {
    open: '<openclaude_rolling_checkpoint>\n',
    curOpen: '\n</openclaude_rolling_checkpoint>\n\n<current_user_message>\n',
    curClose: '\n</current_user_message>',
  },
  {
    open: '<openclaude_native_model_handoff>\n',
    curOpen: '\n</openclaude_native_model_handoff>\n\n<current_user_message>\n',
    curClose: '\n</current_user_message>',
  },
]

/**
 * Structurally reconcile an Antigravity turn's gateway-authored swarm directive
 * prefix after context compaction or conversation reset (OCV5-882 P0-3):
 *   1. Never scans arbitrary text inside the user body — only replaces the exact
 *      gateway-authored prefix at offset 0 of the current turn text (or inside
 *      the structural `<current_user_message_json>` / `<current_user_message>`
 *      envelope produced by gateway history/checkpoint wrappers).
 *   2. If the turn already received the full 6-rule directive (`appliedMode === 'on_full'`),
 *      returns immediately without inspecting user text.
 *   3. Strictly idempotent: calling repeatedly never double-prepends or alters
 *      user text even if the user quotes swarm directive markers verbatim.
 */
export function reconcileAntigravitySwarmDirectiveAfterCompaction<
  T extends AntigravitySwarmTurnInput,
>(
  input: T,
  ctx: AntigravitySwarmCompactionContext | undefined | null,
  opts: { resetKind: 'rolling_checkpoint' | 'cli_internal_compaction' },
): T {
  if (!ctx || !ctx.isAntigravityTurn) return input
  if (ctx.appliedMode === 'on_full') return input

  const swarmRequested =
    ctx.swarmMode || Boolean(parseSwarmSlashCommand(ctx.rawUserText)?.matched)
  const resumedHeaderPrefix = `${ANTIGRAVITY_SWARM_ACTIVE_MARKER}\n${ANTIGRAVITY_SWARM_RESUMED_PREFIX}`
  const offBlock = `${ANTIGRAVITY_SWARM_OFF_DIRECTIVE}\n`

const EFFICIENCY_GUARD_OPEN = '<oc-efficiency-guard>\n'
const EFFICIENCY_GUARD_CLOSE = '\n</oc-efficiency-guard>\n\n'

  const reconcileDirectPrefix = (text: string): string => {
    if (swarmRequested) {
      let body: string | null = null
      if (ctx.appliedDirectivePrefix) {
        if (!ctx.appliedDirectivePrefix.startsWith(resumedHeaderPrefix)) return text
        if (!text.startsWith(ctx.appliedDirectivePrefix)) return text
        body = text.slice(ctx.appliedDirectivePrefix.length)
      } else if (text.startsWith(resumedHeaderPrefix)) {
        const endSepIdx = text.indexOf('\n\n')
        body = endSepIdx !== -1 ? text.slice(endSepIdx + 2) : ''
      }
      if (body === null) return text
      const fullDirective = buildAntigravitySwarmOnDirective({
        isRemoteAntigravity: ctx.isRemoteAntigravity,
        hasHistoricalSwarm: false,
        liveMonitorNames:
          opts.resetKind === 'rolling_checkpoint' && !ctx.isRemoteAntigravity
            ? []
            : ctx.liveMonitorNames,
        availableLocalSwarmModels: ctx.availableLocalSwarmModels,
      })
      return `${fullDirective}\n${body}`
    }

    if (opts.resetKind === 'rolling_checkpoint' && !ctx.isRemoteAntigravity) {
      const targetOffPrefix = ctx.appliedDirectivePrefix || offBlock
      if (targetOffPrefix === offBlock && text.startsWith(offBlock)) {
        return text.slice(offBlock.length)
      }
    }

    return text
  }

  const reconcileAtOffsetZero = (text: string): string => {
    // Unwrap gateway-authored `<oc-efficiency-guard>...</oc-efficiency-guard>\n\n` prefix
    // if prepended by sessionSubmit.ts before swarm reconciliation (OCV5-882).
    if (text.startsWith(EFFICIENCY_GUARD_OPEN)) {
      const closeIdx = text.indexOf(EFFICIENCY_GUARD_CLOSE)
      if (closeIdx !== -1) {
        const guardEnd = closeIdx + EFFICIENCY_GUARD_CLOSE.length
        const afterGuard = text.slice(guardEnd)
        const reconciled = reconcileDirectPrefix(afterGuard)
        return reconciled !== afterGuard ? `${text.slice(0, guardEnd)}${reconciled}` : text
      }
    }
    return reconcileDirectPrefix(text)
  }

  const reconcileText = (text: string): string => {
    // 1. Structural JSON historical-context envelope (historicalContextPrompt.ts)
    if (text.startsWith(HIST_JSON_OPEN) && text.endsWith(HIST_JSON_CUR_CLOSE)) {
      const markerIdx = text.lastIndexOf(HIST_JSON_CUR_OPEN)
      if (markerIdx !== -1) {
        const jsonStart = markerIdx + HIST_JSON_CUR_OPEN.length
        const jsonEnd = text.length - HIST_JSON_CUR_CLOSE.length
        if (jsonEnd > jsonStart) {
          try {
            const parsed = JSON.parse(text.slice(jsonStart, jsonEnd)) as unknown
            if (typeof parsed === 'string') {
              const reconciled = reconcileAtOffsetZero(parsed)
              if (reconciled !== parsed) {
                const encoded = JSON.stringify(reconciled).replace(/</g, '\\u003c')
                return `${text.slice(0, jsonStart)}${encoded}${HIST_JSON_CUR_CLOSE}`
              }
            }
          } catch {
            // Malformed JSON envelope: leave untouched rather than corrupting user input.
          }
        }
        return text
      }
    }

    // 2. Structural rolling-checkpoint / native-handoff envelopes (sessionManager.ts)
    for (const env of STRUCTURAL_XML_ENVELOPES) {
      if (text.startsWith(env.open) && text.endsWith(env.curClose)) {
        const markerIdx = text.indexOf(env.curOpen)
        if (markerIdx !== -1) {
          const innerStart = markerIdx + env.curOpen.length
          const innerEnd = text.length - env.curClose.length
          if (innerEnd >= innerStart) {
            const inner = text.slice(innerStart, innerEnd)
            const reconciled = reconcileAtOffsetZero(inner)
            if (reconciled !== inner) {
              return `${text.slice(0, innerStart)}${reconciled}${env.curClose}`
            }
          }
          return text
        }
      }
    }

    // 3. Direct unwrapped gateway-authored text (offset 0 only)
    return reconcileAtOffsetZero(text)
  }

  if (typeof input === 'string') {
    return reconcileText(input) as T
  }

  if (Array.isArray(input)) {
    let changed = false
    const next = input.map((block) => {
      if (changed) return block
      if (block && block.type === 'text' && typeof block.text === 'string') {
        const reconciled = reconcileText(block.text)
        if (reconciled !== block.text) {
          changed = true
          return { ...block, text: reconciled }
        }
      }
      return block
    })
    return (changed ? next : input) as T
  }

  return input
}

/**
 * Cohesive inbound helper used by `inboundDispatch.ts` to compute the turn's
 * Antigravity swarm directive and compaction-reconciliation metadata in one call.
 */
export async function prepareAntigravitySwarmInboundDirective(opts: {
  finalText: string
  rawUserText: string
  sessionKey: string
  isAntigravityTurn: boolean
  isRemoteAntigravity: boolean
  swarmMode: boolean
  swarmRequested: boolean
  boundSwarmConversationId?: string
  antigravityRootDir?: string
  remoteSwarmRootBase?: string
  routeAllowedModelsRaw: unknown
  loadLocalCatalogModels: () => Promise<readonly { modelId: string; engine: string; available: boolean }[]>
}): Promise<{
  result: AntigravitySwarmTurnDirectiveResult
  compactionCtx?: AntigravitySwarmCompactionContext
}> {
  let availableLocalSwarmModels: string[] | undefined
  if (opts.isAntigravityTurn && !opts.isRemoteAntigravity && opts.swarmRequested) {
    const routeAllowed = extractRouteAllowedLocalSwarmModels(opts.routeAllowedModelsRaw)
    if (routeAllowed !== undefined) {
      availableLocalSwarmModels = routeAllowed
    } else {
      try {
        const localModels = filterAvailableLocalSwarmModels(await opts.loadLocalCatalogModels())
        if (localModels.length > 0) availableLocalSwarmModels = localModels
      } catch {
        // Best-effort discovery hint only; relay enforces authoritative allowlist server-side.
      }
    }
  }
  const liveMonitorNames =
    opts.isAntigravityTurn && opts.swarmRequested
      ? listLiveAntigravitySwarmMonitors({
          sessionKey: opts.sessionKey,
          isRemote: opts.isRemoteAntigravity,
          conversationId: opts.boundSwarmConversationId,
          ...(opts.antigravityRootDir ? { antigravityRootDir: opts.antigravityRootDir } : {}),
          ...(opts.remoteSwarmRootBase ? { remoteSwarmRootBase: opts.remoteSwarmRootBase } : {}),
        })
      : []
  const result = applyAntigravitySwarmTurnDirective({
    finalText: opts.finalText,
    rawUserText: opts.rawUserText,
    isAntigravityTurn: opts.isAntigravityTurn,
    isRemoteAntigravity: opts.isRemoteAntigravity,
    swarmMode: opts.swarmMode,
    hasHistoricalSwarm: opts.isAntigravityTurn
      ? hasHistoricalAntigravitySwarm({
          sessionKey: opts.sessionKey,
          isRemote: opts.isRemoteAntigravity,
          conversationId: opts.boundSwarmConversationId,
          ...(opts.antigravityRootDir ? { antigravityRootDir: opts.antigravityRootDir } : {}),
          ...(opts.remoteSwarmRootBase ? { remoteSwarmRootBase: opts.remoteSwarmRootBase } : {}),
        })
      : false,
    liveMonitorNames,
    ...(availableLocalSwarmModels !== undefined ? { availableLocalSwarmModels } : {}),
  })
  const compactionCtx: AntigravitySwarmCompactionContext | undefined =
    opts.isAntigravityTurn && result.mode !== 'none'
      ? {
          isAntigravityTurn: opts.isAntigravityTurn,
          isRemoteAntigravity: opts.isRemoteAntigravity,
          swarmMode: opts.swarmMode,
          rawUserText: opts.rawUserText,
          appliedMode:
            result.mode === 'off_with_history'
              ? 'off_with_history'
              : result.isResumedCompact
                ? 'on_resumed'
                : 'on_full',
          ...(result.appliedDirectivePrefix
            ? { appliedDirectivePrefix: result.appliedDirectivePrefix }
            : {}),
          ...(availableLocalSwarmModels !== undefined ? { availableLocalSwarmModels } : {}),
          ...(liveMonitorNames.length > 0 ? { liveMonitorNames } : {}),
        }
      : undefined
  return { result, compactionCtx }
}
