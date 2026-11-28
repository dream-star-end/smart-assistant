/**
 * Pure SwarmSnapshot formatting, terminal settlement, and durable persistence helpers.
 * Background-task lifecycle and turn-window reduction live in dedicated Strangler-Fig
 * sibling modules (`antigravitySwarmBgTasks.ts` and `antigravitySwarmTurnReducer.ts`).
 */
import { basename } from 'node:path'
import { compactSwarmSnapshotToByteBudget, type SwarmPhase, type SwarmSnapshot } from '@openclaude/protocol'
import {
  analyzeBackgroundTasksInSteps, createBackgroundTaskState, mergeBackgroundTaskStates,
  type BackgroundTaskState, type BackgroundTaskTelemetrySummary, type MergedBackgroundTaskState, type TrackedBackgroundTask,
} from './antigravitySwarmBgTasks.js'
import {
  analyzeTurnWindow, findActiveNonBoardToolInTurn, findTurnStartIndex, firstNonBoardToolCall,
  getTurnReductionCandidateVisitsForTests, getTurnReductionMetricsForTests, resetTurnReductionCandidateVisitsForTests,
  type TurnReductionResult,
} from './antigravitySwarmTurnReducer.js'

export {
  analyzeBackgroundTasksInSteps, createBackgroundTaskState, mergeBackgroundTaskStates,
  type BackgroundTaskState, type BackgroundTaskTelemetrySummary, type MergedBackgroundTaskState, type TrackedBackgroundTask,
  analyzeTurnWindow, findActiveNonBoardToolInTurn, findTurnStartIndex, firstNonBoardToolCall,
  getTurnReductionCandidateVisitsForTests, getTurnReductionMetricsForTests, resetTurnReductionCandidateVisitsForTests,
  type TurnReductionResult,
}

const SWARM_MCP_TOOL_PREFIX = 'mcp_openclaude-memory_'

function strOf(v: unknown): string { return typeof v === 'string' ? v.trim() : '' }

/** Strip the container MCP prefix (`mcp_openclaude-memory_`) so remote swarm tools
 *  normalize to the same canonical names as native Antigravity CLI tools. */
export function normalizeSwarmToolName(raw: string): string {
  const trimmed = raw.trim()
  return trimmed.toLowerCase().startsWith(SWARM_MCP_TOOL_PREFIX) ? trimmed.slice(SWARM_MCP_TOOL_PREFIX.length) : trimmed
}

function shortFileTarget(args: Record<string, unknown> | null): string {
  if (!args) return ''
  const raw = strOf(args.Path) || strOf(args.AbsolutePath) || strOf(args.TargetFile) || strOf(args.file_path) || strOf(args.path)
  return raw ? (basename(raw) || raw) : ''
}

const FILE_VERB_BY_TOOL: Readonly<Record<string, [string, string]>> = {
  read_file: ['阅读 ', '阅读文件'], view_file: ['阅读 ', '阅读文件'],
  write_file: ['写入 ', '写入文件'], write_to_file: ['写入 ', '写入文件'],
  edit_file: ['编辑 ', '编辑文件'], replace_file_content: ['编辑 ', '编辑文件'],
  multi_replace_file_content: ['编辑 ', '编辑文件'], sed_file: ['编辑 ', '编辑文件'],
}

const STATIC_LABEL_BY_TOOL: Readonly<Record<string, string>> = {
  run_command: '运行命令', oc_bash: '运行命令', grep_search: '检索代码', oc_grep: '检索代码',
  find_by_name: '浏览目录', list_dir: '浏览目录', oc_glob: '浏览目录',
  search_web: '联网检索', read_url_content: '抓取网页',
  post_message: '发送讨论消息', read_board: '查看讨论板', swarm_wait: '等待讨论板消息',
}

const SWARM_ACTION_LABEL: Readonly<Record<string, string>> = {
  add: '招募蜂群成员', status: '检查蜂群状态', kill: '回收蜂群成员',
}

export function describeToolActivity(toolName: string, args: Record<string, unknown> | null): string {
  const rawName = toolName.trim()
  const name = normalizeSwarmToolName(rawName)
  const fileVerb = FILE_VERB_BY_TOOL[name]
  if (fileVerb) {
    const target = shortFileTarget(args)
    return target ? `${fileVerb[0]}${target}` : fileVerb[1]
  }
  const staticLabel = STATIC_LABEL_BY_TOOL[name]
  if (staticLabel) return staticLabel
  if (name === 'swarm') return SWARM_ACTION_LABEL[args ? strOf(args.action) : ''] ?? '调度蜂群'
  if (rawName.startsWith('mcp_')) return `调用 ${rawName.split('_').slice(-1)[0] || rawName}`
  return name ? `执行 ${name}` : '处理中…'
}

export function settleSwarmSnapshotTerminal(snap: SwarmSnapshot, phase: SwarmPhase): SwarmSnapshot {
  const { postsMode: _pm, deltaBaseSeq: _dbs, ...clean } = structuredClone(snap)
  return {
    ...clean, phase, revision: snap.revision + 1, updatedAt: Date.now(),
    members: snap.members.map((m) => ({ ...m, status: m.status === 'killed' ? 'killed' : 'waiting' })),
  }
}

/** Concise one-line status text for the live turn_status working bar. */
export function formatSwarmWorkingDetail(snap: SwarmSnapshot): string {
  const working = snap.members.filter((m) => m.status === 'working' && m.role !== 'monitor' && m.role !== 'narrator').length
  const live = snap.members.filter((m) => m.status !== 'killed').length
  const parts: string[] = [`蜂群「${snap.title}」`, working > 0 ? `${working} 成员运行中` : `${live} 成员协作中`]
  if (snap.totalPosts > 0) parts.push(`${snap.totalPosts} 条讨论`)
  return parts.join(' · ')
}

export interface DurableSwarmBoardInput { swarmId: string; title: string; phase: SwarmPhase; snapshot: SwarmSnapshot }

export function compactSwarmSnapshotForPersistence(snap: SwarmSnapshot, maxBytes = 13_000): SwarmSnapshot {
  return structuredClone(compactSwarmSnapshotToByteBudget(snap, maxBytes))
}

export function buildDurableSwarmBoardInput(snap: SwarmSnapshot, maxBytes = 13_000): DurableSwarmBoardInput {
  const snapshot = compactSwarmSnapshotForPersistence(snap, maxBytes)
  return { swarmId: snapshot.swarmId, title: snapshot.title, phase: snapshot.phase, snapshot }
}
