import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import {
  ADVISOR_AGENT_ID,
  type CollaborationMode,
  DEFAULT_ADVISOR_MODEL,
} from '@openclaude/protocol'
import type { MessageLike } from '@openclaude/storage'
import { isPathWithinRoot } from './pathAcl.js'

/** Phase-1 consult identity is proven only for CCB parent turns. */
export const ADVISOR_CONSULT_PARENT_ENGINES = ['ccb'] as const
export const ADVISOR_CONSULT_PARENT_REASON =
  '一期仅 CCB 主会话（如 glm/MiniMax）可咨询顾问。Codex/Grok/Cursor 主引擎尚未证明稳定 tool_use 身份，不能选择顾问后在 consult 上必失败。主模型不会因此被切换。'

export function isAdvisorConsultParentEngine(engine: string | undefined): boolean {
  return engine === 'ccb'
}

export const ADVISOR_PREAMBLE = [
  '【顾问模式已开启】当前主模型不切换。你可以使用 consult_advisor 向无工具顾问提问（question 必填，可选 concern）。',
  '顾问只给建议，没有工具、不能改文件或再委派。你必须用自己的工具验证建议后再交付。',
  '咨询失败时向用户说明并可继续执行，不要把它当成正式审计或审批。',
  '',
].join('\n')

export function openAdvisorEngines(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env.OC_ADVISOR_OPEN_ENGINES
  if (raw === '') return new Set()
  if (typeof raw === 'string' && raw.trim()) {
    return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))
  }
  // Empty until an authenticated hermetic honey-pot PASS. Set OC_ADVISOR_OPEN_ENGINES=codex to open.
  return new Set()
}

export function isAdvisorEngineOpen(
  engine: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  provenEngines?: Iterable<string>,
): boolean {
  if (!engine) return false
  if (openAdvisorEngines(env).has(engine)) return true
  if (!provenEngines) return false
  for (const item of provenEngines) {
    if (item === engine) return true
  }
  return false
}

export type AdvisorCatalogModel = {
  modelId: string
  displayName: string
  engine: string
  available?: boolean
}

export type AdvisorModelOption = { id: string; label: string; engine: string }

export function assertAdvisorModelAllowed(input: {
  requested: string
  advisorModels: readonly AdvisorModelOption[]
  unavailableReason?: string
}): { ok: true; model: string } | { ok: false; error: string } {
  const requested = input.requested.trim()
  if (input.advisorModels.length === 0) {
    return { ok: false, error: input.unavailableReason || '顾问型号目录不可用或尚未证明' }
  }
  if (!requested) return { ok: false, error: 'advisorModel required' }
  if (!input.advisorModels.some((row) => row.id === requested)) {
    return { ok: false, error: `advisorModel ${requested} 不在已证明 catalog 中` }
  }
  return { ok: true, model: requested }
}

export function listProvenAdvisorModels(input: {
  catalog: readonly AdvisorCatalogModel[]
  provenEngines: Iterable<string>
}): { advisorModels: AdvisorModelOption[]; advisorUnavailableReason?: string } {
  const proven = new Set([...input.provenEngines].map((s) => s.trim()).filter(Boolean))
  if (proven.size === 0) {
    return {
      advisorModels: [],
      advisorUnavailableReason: '顾问引擎尚未完成无工具证明',
    }
  }
  const advisorModels = input.catalog
    .filter((row) => row.available !== false && proven.has(row.engine))
    .map((row) => ({ id: row.modelId, label: row.displayName, engine: row.engine }))
  if (advisorModels.length === 0) {
    return {
      advisorModels: [],
      advisorUnavailableReason: 'catalog 中没有已证明引擎的可用顾问型号',
    }
  }
  return { advisorModels }
}

function historyText(row: MessageLike): string | undefined {
  if (typeof row.text === 'string' && row.text) return row.text
  if (typeof row.content === 'string' && row.content) return row.content
  return undefined
}

function historyToolName(row: MessageLike): string | undefined {
  if (typeof row.toolName === 'string' && row.toolName) return row.toolName
  if (typeof row.tool_name === 'string' && row.tool_name) return row.tool_name
  return undefined
}

function historyToolResult(row: MessageLike): string | undefined {
  if (typeof row.toolResult === 'string' && row.toolResult) return row.toolResult
  if (typeof row.tool_result === 'string' && row.tool_result) return row.tool_result
  if (row.role === 'tool' && typeof row.content === 'string') return row.content
  return undefined
}

export function coerceHistoryMessages(raw: unknown): MessageLike[] | undefined {
  if (raw == null) return undefined
  if (!Array.isArray(raw)) return undefined
  return raw.filter((row): row is MessageLike => Boolean(row) && typeof row === 'object' && !Array.isArray(row))
}

export function historyFromSessionMessages(
  messages: readonly MessageLike[] | undefined,
  opts?: { archivedThroughSeq?: number; hasMore?: boolean },
): {
  records?: AdvisorSnapshotInput['historyRecords']
  missing: string[]
  truncated: boolean
} {
  const missing: string[] = []
  if (!messages) return { missing: ['history_tape'], truncated: false }
  const records = messages
    .filter((row) => {
      const role = typeof row.role === 'string' ? row.role : ''
      return role === 'user' || role === 'assistant' || role === 'tool' || role === 'agent-group'
    })
    .map((row) => ({
      role: String(row.role),
      text: historyText(row),
      toolName: historyToolName(row),
      toolResult: historyToolResult(row),
    }))
  if ((opts?.archivedThroughSeq ?? 0) > 0) missing.push('tape_archived_prefix')
  if (opts?.hasMore) missing.push('tape_unfinalized')
  return { records, missing, truncated: missing.length > 0 }
}

export function parentAuthorizedArtifactTexts(input: {
  userTask?: string
  currentTools?: Array<{ result?: string; input?: unknown }>
}): string[] {
  return extractGeneratedPaths([
    input.userTask,
    ...(input.currentTools ?? []).map((tool) => tool.result),
    ...(input.currentTools ?? []).map((tool) =>
      typeof tool.input === 'string' ? tool.input : JSON.stringify(tool.input ?? ''),
    ),
  ])
}

export function stripAdvisorPreambleFromInjected(text: string): string {
  if (text.startsWith(ADVISOR_PREAMBLE)) return text.slice(ADVISOR_PREAMBLE.length)
  return text
}

export type AdvisorSnapshotInput = {
  userTask: string
  injectedConstraints?: string
  historyRecords?: Array<{ role?: string; text?: string; toolName?: string; toolResult?: string }>
  currentTools?: Array<{ name?: string; input?: unknown; result?: string; completed?: boolean }>
  authorizedArtifacts?: Array<{ path: string; content?: string; missing?: string }>
}

export type AdvisorSnapshot = {
  question: string
  concern: string
  advisorModel: string
  missing: string[]
  truncated: boolean
  userTask: string
  constraints: string
  history: AdvisorSnapshotInput['historyRecords']
  currentTools: AdvisorSnapshotInput['currentTools']
  artifacts: AdvisorSnapshotInput['authorizedArtifacts']
}

const CONSTRAINT_CAP = 8_000
const TOOL_CAP = 8_000
const ARTIFACT_FILE_CAP = 64 * 1024
const ARTIFACT_TOTAL_CAP = 256 * 1024
const GENERATED_PATH_RE = /\/home\/agent\/\.openclaude\/generated\/[A-Za-z0-9._@+=,-]{1,180}/g

function cap(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return {
    text: `${text.slice(0, max)}\n…(已截断,原文 ${text.length} 字)`,
    truncated: true,
  }
}

export function buildAdvisorSnapshot(input: {
  question: string
  concern: string
  advisorModel: string
  source: AdvisorSnapshotInput
}): AdvisorSnapshot {
  const missing: string[] = []
  let truncated = false
  const constraints = cap(input.source.injectedConstraints ?? '', CONSTRAINT_CAP)
  truncated = truncated || constraints.truncated
  if (!input.source.injectedConstraints) missing.push('injected_constraints')
  if (!input.source.historyRecords) missing.push('history_tape')
  const tools = (input.source.currentTools ?? []).map((tool) => {
    const result = typeof tool.result === 'string' ? cap(tool.result, TOOL_CAP) : { text: '', truncated: false }
    truncated = truncated || result.truncated
    return { ...tool, result: result.text }
  })
  if (!input.source.currentTools) missing.push('current_turn_tools')
  const artifacts = input.source.authorizedArtifacts ?? []
  if (artifacts.length === 0) missing.push('authorized_artifacts')
  return {
    question: input.question,
    concern: input.concern,
    advisorModel: input.advisorModel || DEFAULT_ADVISOR_MODEL,
    missing,
    truncated,
    userTask: input.source.userTask,
    constraints: constraints.text,
    history: (input.source.historyRecords ?? []).filter((row) => row.role !== 'thinking'),
    currentTools: tools,
    artifacts,
  }
}

export function advisorPreamble(mode: CollaborationMode): string {
  return mode === 'advisor' ? ADVISOR_PREAMBLE : ''
}

export function matchConsultIdentity(
  existing: { question: string; concern: string },
  incoming: { question: string; concern: string },
): boolean {
  return existing.question === incoming.question && existing.concern === incoming.concern
}

export function extractGeneratedPaths(texts: Array<string | undefined>): string[] {
  const found = new Set<string>()
  for (const text of texts) {
    if (!text) continue
    for (const match of text.matchAll(GENERATED_PATH_RE)) found.add(match[0])
  }
  return [...found]
}

export function collectAuthorizedArtifacts(input: {
  generatedRoot: string
  mentioned: string[]
}): Array<{ path: string; content?: string; missing?: string }> {
  const root = (() => {
    try {
      return realpathSync(input.generatedRoot)
    } catch {
      return input.generatedRoot
    }
  })()
  const out: Array<{ path: string; content?: string; missing?: string }> = []
  let total = 0
  for (const raw of input.mentioned) {
    if (!isAbsolute(raw)) {
      out.push({ path: raw, missing: 'not_absolute' })
      continue
    }
    try {
      const st = lstatSync(raw)
      if (st.isSymbolicLink()) {
        out.push({ path: raw, missing: 'symlink_rejected' })
        continue
      }
      const real = realpathSync(raw)
      if (!isPathWithinRoot(real, root)) {
        out.push({ path: raw, missing: 'escape_rejected' })
        continue
      }
      if (total >= ARTIFACT_TOTAL_CAP) {
        out.push({ path: raw, missing: 'total_cap' })
        continue
      }
      const buf = readFileSync(real)
      const slice = buf.subarray(0, ARTIFACT_FILE_CAP)
      total += slice.length
      out.push({
        path: real,
        content: slice.toString('utf8'),
        ...(buf.length > ARTIFACT_FILE_CAP ? { missing: 'file_truncated' } : {}),
      })
    } catch {
      out.push({ path: raw, missing: 'unreadable' })
    }
  }
  return out
}

export function formatAdvisorConsultPrompt(snapshot: AdvisorSnapshot): string {
  const missing = snapshot.missing.length
    ? `【缺失证据】${snapshot.missing.join(', ')}。未完整检查，不要假装审完全部。\n`
    : ''
  const truncated = snapshot.truncated ? '【快照已截断】部分工具结果或约束超上限。\n' : ''
  const history = (snapshot.history ?? [])
    .map((row) => `- ${row.role ?? 'unknown'}: ${row.text ?? row.toolResult ?? ''}`)
    .join('\n')
  const tools = (snapshot.currentTools ?? [])
    .map((tool) => {
      const status = tool.completed ? 'completed' : 'in_progress'
      return `- ${tool.name ?? 'tool'} [${status}]: ${tool.result ?? ''}`
    })
    .join('\n')
  const artifacts = (snapshot.artifacts ?? [])
    .map((row) =>
      row.missing ? `- ${row.path} (missing: ${row.missing})` : `- ${row.path}\n${row.content ?? ''}`,
    )
    .join('\n')
  return [
    '你是无工具顾问。不要尝试调用工具、改文件、执行命令或再委派。只给建议。',
    missing,
    truncated,
    `【顾问型号】${snapshot.advisorModel}`,
    `【用户任务】\n${snapshot.userTask || '（空）'}`,
    `【已注入约束】\n${snapshot.constraints || '（无）'}`,
    `【当前主工具】\n${tools || '（无）'}`,
    `【历史会话】\n${history || '（未提供）'}`,
    `【授权产物】\n${artifacts || '（无）'}`,
    `【咨询问题】\n${snapshot.question}`,
    snapshot.concern ? `【关注点】\n${snapshot.concern}` : '',
    '请给出可执行建议、风险和需要主模型自行验证的步骤。建议可能有错。',
  ]
    .filter(Boolean)
    .join('\n\n')
}

export { ADVISOR_AGENT_ID }
