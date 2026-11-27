/**
 * Pure SwarmSnapshot formatting, terminal settlement, and durable persistence helpers.
 */
import { basename } from 'node:path'
import {
  compactSwarmSnapshotToByteBudget,
  type SwarmPhase,
  type SwarmSnapshot,
} from '@openclaude/protocol'

const SWARM_MCP_TOOL_PREFIX = 'mcp_openclaude-memory_'

/** Strip the container MCP prefix (`mcp_openclaude-memory_`) so remote swarm tools
 *  (`mcp_openclaude-memory_swarm_wait` / `_post_message` / `_read_board` / `_swarm`)
 *  normalize to the same canonical names as native Antigravity CLI tools. */
export function normalizeSwarmToolName(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.toLowerCase().startsWith(SWARM_MCP_TOOL_PREFIX)) {
    return trimmed.slice(SWARM_MCP_TOOL_PREFIX.length)
  }
  return trimmed
}

function shortFileTarget(args: Record<string, unknown> | null): string {
  if (!args) return ''
  const raw =
    strOf(args.Path) ||
    strOf(args.AbsolutePath) ||
    strOf(args.TargetFile) ||
    strOf(args.file_path) ||
    strOf(args.path)
  if (!raw) return ''
  return basename(raw) || raw
}

const FILE_VERB_BY_TOOL: Readonly<Record<string, [string, string]>> = {
  read_file: ['阅读 ', '阅读文件'],
  view_file: ['阅读 ', '阅读文件'],
  write_file: ['写入 ', '写入文件'],
  write_to_file: ['写入 ', '写入文件'],
  edit_file: ['编辑 ', '编辑文件'],
  replace_file_content: ['编辑 ', '编辑文件'],
  multi_replace_file_content: ['编辑 ', '编辑文件'],
  sed_file: ['编辑 ', '编辑文件'],
}

const STATIC_LABEL_BY_TOOL: Readonly<Record<string, string>> = {
  run_command: '运行命令',
  oc_bash: '运行命令',
  grep_search: '检索代码',
  oc_grep: '检索代码',
  find_by_name: '浏览目录',
  list_dir: '浏览目录',
  oc_glob: '浏览目录',
  search_web: '联网检索',
  read_url_content: '抓取网页',
  post_message: '发送讨论消息',
  read_board: '查看讨论板',
  swarm_wait: '等待讨论板消息',
}

const SWARM_ACTION_LABEL: Readonly<Record<string, string>> = {
  add: '招募蜂群成员',
  status: '检查蜂群状态',
  kill: '回收蜂群成员',
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
  if (name === 'swarm') {
    const action = args ? strOf(args.action) : ''
    return SWARM_ACTION_LABEL[action] ?? '调度蜂群'
  }
  if (rawName.startsWith('mcp_')) return `调用 ${rawName.split('_').slice(-1)[0] || rawName}`
  return name ? `执行 ${name}` : '处理中…'
}

export function settleSwarmSnapshotTerminal(snap: SwarmSnapshot, phase: SwarmPhase): SwarmSnapshot {
  const { postsMode: _pm, deltaBaseSeq: _dbs, ...clean } = structuredClone(snap)
  return {
    ...clean,
    phase,
    revision: snap.revision + 1,
    updatedAt: Date.now(),
    members: snap.members.map((m) => ({
      ...m,
      status: m.status === 'killed' ? 'killed' : 'waiting',
    })),
  }
}

/** Concise one-line status text for the live turn_status working bar. */
export function formatSwarmWorkingDetail(snap: SwarmSnapshot): string {
  const working = snap.members.filter((m) => m.status === 'working' && m.role !== 'monitor' && m.role !== 'narrator').length
  const live = snap.members.filter((m) => m.status !== 'killed').length
  const parts: string[] = [`蜂群「${snap.title}」`]
  if (working > 0) parts.push(`${working} 成员运行中`)
  else parts.push(`${live} 成员协作中`)
  if (snap.totalPosts > 0) parts.push(`${snap.totalPosts} 条讨论`)
  return parts.join(' · ')
}

export interface DurableSwarmBoardInput {
  swarmId: string
  title: string
  phase: SwarmPhase
  snapshot: SwarmSnapshot
}

function durableEnvelopeFor(snapshot: SwarmSnapshot): DurableSwarmBoardInput {
  return {
    swarmId: snapshot.swarmId,
    title: snapshot.title,
    phase: snapshot.phase,
    snapshot,
  }
}

/**
 * Produce a UTF-8 byte-bounded copy of a SwarmSnapshot whose COMPLETE
 * `{ swarmId, title, phase, snapshot }` envelope fits safely inside
 * `ToolEntrySchema.inputJson` (16 KB server-authored durability cap).
 */
export function compactSwarmSnapshotForPersistence(
  snap: SwarmSnapshot,
  maxBytes: number = 13_000,
): SwarmSnapshot {
  return structuredClone(compactSwarmSnapshotToByteBudget(snap, maxBytes))
}

export function buildDurableSwarmBoardInput(
  snap: SwarmSnapshot,
  maxBytes: number = 13_000,
): DurableSwarmBoardInput {
  return durableEnvelopeFor(compactSwarmSnapshotForPersistence(snap, maxBytes))
}

const BOARD_COORD_TOOLS = new Set(['swarm_wait', 'post_message', 'read_board'])

function recOf(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function strOf(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function normTool(raw: string): string {
  const t = raw.trim().toLowerCase()
  return t.startsWith('mcp_openclaude-memory_') ? t.slice('mcp_openclaude-memory_'.length) : t
}

export function firstNonBoardToolCall(calls: readonly unknown[]): Record<string, unknown> | null {
  for (const c of calls) {
    const obj = recOf(c)
    const name = normTool(strOf(obj?.name))
    if (name && !BOARD_COORD_TOOLS.has(name)) return obj
  }
  return null
}

function stepCallId(obj: Record<string, unknown> | null): string {
  if (!obj) return ''
  return strOf(obj.tool_call_id || obj.call_id || obj.id)
}

function stepToolName(obj: Record<string, unknown> | null): string {
  if (!obj) return ''
  return normTool(strOf(obj.tool_name || obj.name))
}

interface PlannerNonBoardCall {
  readonly name: string
  readonly norm: string
  readonly id: string
  readonly args: Record<string, unknown> | null
}

function findDirectUnfinishedNonBoardStep(
  turnSteps: readonly Record<string, unknown>[],
): { name: string; args: Record<string, unknown> | null } | null {
  for (let i = turnSteps.length - 1; i >= 0; i -= 1) {
    const step = turnSteps[i]!
    const st = strOf(step.status).toUpperCase()
    if (st === 'DONE' || st === 'ERROR') continue
    const direct = strOf(step.tool_name || step.name)
    if (direct && !BOARD_COORD_TOOLS.has(normTool(direct))) {
      return { name: direct, args: recOf(step.arguments ?? step.args) }
    }
    const stepType = strOf(step.type).toUpperCase()
    if ((stepType === 'TOOL_CALL' || stepType === 'TOOL_USE') && Array.isArray(step.tool_calls)) {
      const nonBoard = firstNonBoardToolCall(step.tool_calls)
      if (nonBoard) return { name: strOf(nonBoard.name), args: recOf(nonBoard.arguments ?? nonBoard.args) }
    }
  }
  return null
}

function extractPlannerNonBoardCalls(lastPlannerCalls: readonly unknown[]): PlannerNonBoardCall[] {
  const out: PlannerNonBoardCall[] = []
  for (const raw of lastPlannerCalls) {
    const obj = recOf(raw)
    const name = strOf(obj?.name)
    const norm = normTool(name)
    if (!norm || BOARD_COORD_TOOLS.has(norm)) continue
    out.push({ name, norm, id: stepCallId(obj), args: recOf(obj?.arguments ?? obj?.args) })
  }
  return out
}

function collectAfterPlannerCompletion(afterPlanner: readonly Record<string, unknown>[]): {
  completedIds: Set<string>
  completedByName: Map<string, number>
  totalTerminalResults: number
  anyUnfinishedStep: boolean
} {
  const completedIds = new Set<string>()
  const completedByName = new Map<string, number>()
  let totalTerminalResults = 0
  let anyUnfinishedStep = false
  for (const s of afterPlanner) {
    const st = strOf(s.status).toUpperCase()
    if (st === 'DONE' || st === 'ERROR') {
      totalTerminalResults += 1
      const cid = stepCallId(s)
      if (cid) completedIds.add(cid)
      const tname = stepToolName(s)
      if (tname) completedByName.set(tname, (completedByName.get(tname) ?? 0) + 1)
    } else if (st !== '') {
      anyUnfinishedStep = true
    }
  }
  return { completedIds, completedByName, totalTerminalResults, anyUnfinishedStep }
}

function firstUnaccountedPlannerCall(
  nonBoardCalls: readonly PlannerNonBoardCall[],
  completedIds: ReadonlySet<string>,
  completedByName: Map<string, number>,
): { name: string; args: Record<string, unknown> | null } | null {
  for (const call of nonBoardCalls) {
    if (call.id && completedIds.has(call.id)) {
      const n = completedByName.get(call.norm) ?? 0
      if (n > 0) completedByName.set(call.norm, n - 1)
      continue
    }
    const remaining = completedByName.get(call.norm) ?? 0
    if (remaining > 0) {
      completedByName.set(call.norm, remaining - 1)
      continue
    }
    return { name: call.name, args: call.args }
  }
  return null
}

/**
 * B5: Detect whether the current turn still has an active/unfinished non-board
 * tool (any tool other than `swarm_wait`/`post_message`/`read_board`), including
 * mixed batches like `[run_command, swarm_wait]`.
 */
export function findActiveNonBoardToolInTurn(
  turnSteps: readonly Record<string, unknown>[],
  lastPlannerIdx: number,
  lastPlannerCalls: readonly unknown[],
): { name: string; args: Record<string, unknown> | null } | null {
  const directActive = findDirectUnfinishedNonBoardStep(turnSteps)
  if (directActive) return directActive
  if (lastPlannerIdx < 0 || lastPlannerCalls.length === 0) return null
  const nonBoardCalls = extractPlannerNonBoardCalls(lastPlannerCalls)
  if (nonBoardCalls.length === 0) return null
  const { completedIds, completedByName, totalTerminalResults, anyUnfinishedStep } =
    collectAfterPlannerCompletion(turnSteps.slice(lastPlannerIdx + 1))
  if (totalTerminalResults >= lastPlannerCalls.length && !anyUnfinishedStep) return null
  return firstUnaccountedPlannerCall(nonBoardCalls, completedIds, completedByName)
}
