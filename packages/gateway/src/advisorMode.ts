import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import {
  ADVISOR_AGENT_ID,
  ADVISOR_NO_WRITE_CONSTRAINT,
  type CollaborationMode,
  DEFAULT_ADVISOR_MODEL,
  contextFamilyByModelId,
  detectAdvisorNoWrite,
  isCodexLongContextModel,
} from '@openclaude/protocol'

export { ADVISOR_NO_WRITE_CONSTRAINT, detectAdvisorNoWrite }
import type { MessageLike } from '@openclaude/storage'
import { isPathWithinRoot } from './pathAcl.js'

/** Any catalog main engine may turn advisor mode on. Unknown engines stay closed. */
export const ADVISOR_CONSULT_PARENT_ENGINES = ['ccb', 'codex', 'grok', 'cursor', 'antigravity'] as const
export const ADVISOR_CONSULT_PARENT_REASON =
  '这个会话暂时不能开顾问。主模型不会被换掉。'
const CONSULT_INVOCATION_RE = /^[A-Za-z0-9:_-]{8,128}$/

export function isAdvisorConsultParentEngine(engine: string | undefined): boolean {
  return (ADVISOR_CONSULT_PARENT_ENGINES as readonly string[]).includes(engine ?? '')
}

/** Unknown parent engines fail closed. Known main engines may enable advisor mode. */
export function advisorConsultParentGate(engine: string | undefined | null): {
  allowed: boolean
  engine?: string
  reason?: string
} {
  const normalized = typeof engine === 'string' ? engine.trim() : ''
  if (!normalized) {
    return {
      allowed: false,
      reason: '当前会话还不知道用的是哪个模型，暂时不能开顾问。主模型不会被换掉。',
    }
  }
  if (!isAdvisorConsultParentEngine(normalized)) {
    return { allowed: false, engine: normalized, reason: ADVISOR_CONSULT_PARENT_REASON }
  }
  return { allowed: true, engine: normalized }
}

export type LiveConsultTool = {
  toolName?: string
  toolUseId?: string
  completed?: boolean
  inputJson?: unknown
}

const EAGER_MCP_CONSULT_RE = /^mcp_[A-Za-z0-9][A-Za-z0-9.-]*_consult_advisor$/

export function isConsultAdvisorToolName(name: string | undefined): boolean {
  const trimmed = (name ?? '').trim()
  return (
    trimmed === 'consult_advisor' ||
    trimmed.endsWith('__consult_advisor') ||
    EAGER_MCP_CONSULT_RE.test(trimmed)
  )
}

function isLazyMcpConsultCall(name: string | undefined, input: unknown): boolean {
  if ((name ?? '').trim() !== 'call_mcp_tool') return false
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  const record = input as Record<string, unknown>
  return typeof record.ToolName === 'string' && isConsultAdvisorToolName(record.ToolName)
}

function commandRequestsConsult(input: unknown): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  const record = input as Record<string, unknown>
  const command = typeof record.command === 'string'
    ? record.command
    : typeof record.cmd === 'string'
      ? record.cmd
      : typeof record.CommandLine === 'string'
        ? record.CommandLine
        : ''
  return /(^|[\s;&|`(])oc-memory\s+consult-advisor(?:\s|$)/.test(command)
}

/** Bind a retry identity to the single in-flight consult call. Never mint one. */
export function uniquePendingConsultInvocationId(
  tools: readonly LiveConsultTool[] | undefined,
): { ok: true; invocationId: string } | { ok: false; reason: 'none' | 'ambiguous' } {
  const pending = (tools ?? []).filter(
    (tool) =>
      tool.completed !== true &&
      (isConsultAdvisorToolName(tool.toolName) ||
        isLazyMcpConsultCall(tool.toolName, tool.inputJson) ||
        ((tool.toolName === 'Bash' || tool.toolName === 'Shell' || tool.toolName === 'run_command') &&
          commandRequestsConsult(tool.inputJson))),
  )
  if (pending.length > 1) return { ok: false, reason: 'ambiguous' }
  const id = pending.length === 1 && typeof pending[0]?.toolUseId === 'string'
    ? pending[0].toolUseId.trim()
    : ''
  if (!id || !CONSULT_INVOCATION_RE.test(id)) return { ok: false, reason: 'none' }
  return { ok: true, invocationId: id }
}

export const ADVISOR_PREAMBLE = [
  '【顾问模式已开启】当前主模型不切换。你可以使用 consult_advisor 向无工具顾问提问（question 必填，可选 concern）。',
  '顾问只给建议，没有工具、不能改文件或再委派。你必须用自己的工具验证建议后再交付。',
  '用户禁止改文件或要求只读、只给建议时，验证只能用只读工具，交付只写回复；不得 Write、Edit 或通过命令、MCP、委派改文件，也不要把顾问的措辞建议落实到文件。',
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
  if (!engine || engine === 'ccb') return false
  if (openAdvisorEngines(env).has(engine)) return true
  if (!provenEngines) return false
  for (const item of provenEngines) {
    if (item === engine) return true
  }
  return false
}

export const CCB_ADVISOR_PROFILE_VERSION = 'ccb-advisor-v1' as const
export const CCB_ADVISOR_HERMETIC_ENV = 'OPENCLAUDE_CCB_ADVISOR_HERMETIC'

export type ProvenCcbAdvisorModel = {
  modelId: string
  providerId: string
  profileVersion: typeof CCB_ADVISOR_PROFILE_VERSION
}

export type AdvisorConsultExecution = {
  modelId: string
  engine: 'ccb' | 'codex'
  providerId: string
  profileVersion?: typeof CCB_ADVISOR_PROFILE_VERSION
}

export type AdvisorCatalogModel = {
  modelId: string
  displayName: string
  engine: string
  providerId?: string | null
  available?: boolean
}

export type AdvisorModelOption = { id: string; label: string; engine: string; providerId?: string }

/** Map Codex 1M twins onto the standard catalog id used in the advisor picker. */
export function advisorCanonicalModelId(modelId: string): string {
  const requested = modelId.trim()
  if (!isCodexLongContextModel(requested)) return requested
  return contextFamilyByModelId(requested)?.standardId ?? requested
}

export function assertAdvisorModelAllowed(input: {
  requested: string
  advisorModels: readonly AdvisorModelOption[]
  unavailableReason?: string
}): { ok: true; model: string } | { ok: false; error: string } {
  const requested = advisorCanonicalModelId(input.requested)
  if (input.advisorModels.length === 0) {
    return { ok: false, error: input.unavailableReason || '顾问型号目录不可用或尚未证明' }
  }
  if (!requested) return { ok: false, error: 'advisorModel required' }
  if (!input.advisorModels.some((row) => row.id === requested)) {
    return { ok: false, error: `advisorModel ${requested} 不在已证明 catalog 中` }
  }
  return { ok: true, model: requested }
}

export function parseProvenCcbModels(raw: unknown): ProvenCcbAdvisorModel[] {
  if (raw == null) return []
  if (!Array.isArray(raw)) throw new Error('provenCcbModels invalid')
  const out: ProvenCcbAdvisorModel[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('provenCcbModels invalid')
    }
    const rec = item as Record<string, unknown>
    if (typeof rec.modelId !== 'string' || !rec.modelId.trim() || rec.modelId.length > 64) {
      throw new Error('provenCcbModels invalid')
    }
    if (typeof rec.providerId !== 'string' || !rec.providerId.trim() || rec.providerId.length > 64) {
      throw new Error('provenCcbModels invalid')
    }
    if (rec.profileVersion !== CCB_ADVISOR_PROFILE_VERSION) {
      throw new Error('provenCcbModels invalid')
    }
    out.push({
      modelId: rec.modelId.trim(),
      providerId: rec.providerId.trim(),
      profileVersion: CCB_ADVISOR_PROFILE_VERSION,
    })
  }
  return out
}

export function isCcbAdvisorModelProven(input: {
  modelId: string
  providerId: string | null | undefined
  provenCcbModels?: Iterable<ProvenCcbAdvisorModel>
}): boolean {
  const modelId = input.modelId.trim()
  const providerId = (input.providerId ?? '').trim()
  if (!modelId || !providerId) return false
  for (const row of input.provenCcbModels ?? []) {
    if (
      row.modelId === modelId &&
      row.providerId === providerId &&
      row.profileVersion === CCB_ADVISOR_PROFILE_VERSION
    ) {
      return true
    }
  }
  return false
}

export function listProvenAdvisorModels(input: {
  catalog: readonly AdvisorCatalogModel[]
  provenEngines: Iterable<string>
  provenCcbModels?: Iterable<ProvenCcbAdvisorModel>
}): { advisorModels: AdvisorModelOption[]; advisorUnavailableReason?: string } {
  const proven = new Set(
    [...input.provenEngines].map((s) => s.trim()).filter((s) => s && s !== 'ccb'),
  )
  const provenCcb = [...(input.provenCcbModels ?? [])]
  const advisorModels: AdvisorModelOption[] = []
  const seen = new Set<string>()
  for (const row of input.catalog) {
    if (row.available === false) continue
    if (row.engine === 'codex' && proven.has('codex')) {
      if (isCodexLongContextModel(row.modelId)) continue
      const key = `${row.engine}:${row.modelId}`
      if (seen.has(key)) continue
      seen.add(key)
      advisorModels.push({ id: row.modelId, label: row.displayName, engine: 'codex' })
      continue
    }
    if (
      row.engine === 'ccb' &&
      isCcbAdvisorModelProven({
        modelId: row.modelId,
        providerId: row.providerId,
        provenCcbModels: provenCcb,
      })
    ) {
      const key = `${row.engine}:${row.modelId}:${row.providerId ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      advisorModels.push({
        id: row.modelId,
        label: row.displayName,
        engine: 'ccb',
        providerId: row.providerId ?? undefined,
      })
    }
  }
  if (advisorModels.length === 0) {
    return {
      advisorModels: [],
      advisorUnavailableReason:
        proven.size === 0 && provenCcb.length === 0
          ? '顾问引擎尚未完成无工具证明'
          : 'catalog 中没有已证明引擎的可用顾问型号',
    }
  }
  return { advisorModels }
}

export function advisorExecutionFromSnapshotJson(snapshotJson: string | null | undefined): AdvisorConsultExecution | null {
  if (!snapshotJson) return null
  try {
    const parsed = JSON.parse(snapshotJson) as { execution?: unknown }
    const exec = parsed?.execution
    if (!exec || typeof exec !== 'object' || Array.isArray(exec)) return null
    const rec = exec as Record<string, unknown>
    if (rec.engine !== 'ccb' && rec.engine !== 'codex') return null
    if (typeof rec.modelId !== 'string' || !rec.modelId.trim()) return null
    if (typeof rec.providerId !== 'string' || !rec.providerId.trim()) return null
    return {
      modelId: rec.modelId.trim(),
      engine: rec.engine,
      providerId: rec.providerId.trim(),
      ...(rec.engine === 'ccb' && rec.profileVersion === CCB_ADVISOR_PROFILE_VERSION
        ? { profileVersion: CCB_ADVISOR_PROFILE_VERSION }
        : {}),
    }
  } catch {
    return null
  }
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

const TRUSTED_FILE_TOOL_RE =
  /^(read|read_file|view_file|write|write_file|write_to_file|edit|edit_file|replace_file_content|multi_replace_file_content|search_replace|oc-web parse|oc_web_parse)$/i

/** Target path fields on Read/Write/Edit (not content/new_string/patch). Includes Antigravity PascalCase keys. */
const TRUSTED_FILE_TARGET_KEYS = [
  'file_path',
  'path',
  'target_file',
  'absolute_path',
  'filePath',
  'Path',
  'AbsolutePath',
  'TargetFile',
] as const

/** Read/Write/Edit this turn are current-task file tools. Web/shell stdout is not. */
export function isTrustedCurrentTaskFileTool(name?: string): boolean {
  return TRUSTED_FILE_TOOL_RE.test(String(name ?? '').trim())
}

export function trustedFileToolTargetPaths(input: unknown): string[] {
  if (typeof input === 'string') {
    const trimmed = input.trim()
    const found = extractGeneratedPaths([trimmed])
    return found.length === 1 && found[0] === trimmed ? found : []
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return []
  const rec = input as Record<string, unknown>
  const targets: string[] = []
  for (const key of TRUSTED_FILE_TARGET_KEYS) {
    const value = rec[key]
    if (typeof value === 'string' && value.trim()) targets.push(value)
  }
  return extractGeneratedPaths(targets)
}

export function parentAuthorizedArtifactTexts(input: {
  userTask?: string
  currentTools?: Array<{ name?: string; result?: string; input?: unknown }>
}): string[] {
  const mentioned = extractGeneratedPaths([input.userTask])
  for (const tool of input.currentTools ?? []) {
    if (!isTrustedCurrentTaskFileTool(tool.name)) continue
    mentioned.push(...trustedFileToolTargetPaths(tool.input))
  }
  return [...new Set(mentioned)]
}

export function stripAdvisorPreambleFromInjected(text: string): string {
  if (text.startsWith(ADVISOR_PREAMBLE)) return text.slice(ADVISOR_PREAMBLE.length)
  return text
}

export type AdvisorSnapshotInput = {
  userTask: string
  /** Permission frozen by the active submit, independent of queued-turn prompt fields. */
  readOnly?: boolean
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
  execution?: AdvisorConsultExecution
}

const CONSTRAINT_CAP = 8_000
const TOOL_CAP = 8_000
const TOOL_INPUT_CAP = 2_000
const ARTIFACT_FILE_CAP = 64 * 1024
const ARTIFACT_TOTAL_CAP = 256 * 1024
const GENERATED_PATH_RE = /\/home\/agent\/\.openclaude\/generated\/[A-Za-z0-9._@+=,-]{1,180}/g
const ADVISOR_SECRET_RE =
  /(\b(?:password|secret|api[_-]?key|token)\s*[:=]\s*)\S+|(\bbearer\s+)\S+|(\bsk-|xai-|ghp_|github_pat_)[A-Za-z0-9._-]{8,}/gi

function redactAdvisorSecrets(text: string): string {
  return text.replace(ADVISOR_SECRET_RE, (match, prefix?: string, bearer?: string, keyPrefix?: string) => {
    if (typeof prefix === 'string' && prefix) return `${prefix}[redacted]`
    if (typeof bearer === 'string' && bearer) return `${bearer}[redacted]`
    if (typeof keyPrefix === 'string' && keyPrefix) return `${keyPrefix}[redacted]`
    return '[redacted]'
  })
}

export function formatAdvisorToolInput(input: unknown): { text: string; missing?: string } {
  if (input == null || input === '') return { text: '', missing: 'input_missing' }
  const raw = typeof input === 'string' ? input : JSON.stringify(input)
  if (!raw) return { text: '', missing: 'input_missing' }
  const redacted = redactAdvisorSecrets(raw)
  const capped = cap(redacted, TOOL_INPUT_CAP)
  return {
    text: capped.text,
    missing: capped.truncated ? 'input_truncated' : undefined,
  }
}

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
  execution?: AdvisorConsultExecution
}): AdvisorSnapshot {
  const missing: string[] = []
  let truncated = false
  const noWrite = input.source.readOnly === true || detectAdvisorNoWrite(input.source.userTask)
  const injectedConstraints = [
    ...(noWrite ? [ADVISOR_NO_WRITE_CONSTRAINT] : []),
    input.source.injectedConstraints ?? '',
  ].filter(Boolean).join('\n')
  const constraints = cap(injectedConstraints, CONSTRAINT_CAP)
  truncated = truncated || constraints.truncated
  if (!injectedConstraints) missing.push('injected_constraints')
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
    ...(input.execution ? { execution: input.execution } : {}),
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
      const formatted = formatAdvisorToolInput(tool.input)
      const missing = formatted.missing ? ` [${formatted.missing}]` : ''
      const inputText = formatted.text || '（未提供）'
      return `- ${tool.name ?? 'tool'} [${status}] input=${inputText}${missing}: ${tool.result ?? ''}`
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
    '请给出建议、风险和需要主模型自行验证的步骤。用户禁止改文件时，仅建议只读验证和回复，不要建议主模型改文件。建议可能有错。',
  ]
    .filter(Boolean)
    .join('\n\n')
}

export interface AdvisorToolPolicy {
  toolsDisabled: boolean
  allowedTools?: readonly string[]
}

const ADVISOR_WRITE_TOOL_RE =
  /^(write|write_file|write_to_file|edit|edit_file|replace_file_content|multi_replace_file_content|sed_file|bash|shell|run_command|notebook_edit|delete|rm|swarm|post_message)$/i

/**
 * 硬约束:顾问会话严禁任何写入或执行工具(无工具只读契约)。
 * 拒绝任何尝试向顾问开启工具或下放写入工具的策略。
 */
export function assertAdvisorReadOnlyNoTools(
  policy: AdvisorToolPolicy,
): { ok: true } | { ok: false; error: string } {
  if (!policy.toolsDisabled) {
    return { ok: false, error: '顾问必须运行在无工具只读模式(toolsDisabled=true)' }
  }
  const extra = (policy.allowedTools ?? []).map((t) => t.trim()).filter(Boolean)
  if (extra.length > 0) {
    const hasWrite = extra.some((t) => ADVISOR_WRITE_TOOL_RE.test(t))
    return {
      ok: false,
      error: hasWrite
        ? `顾问严禁持有写入/执行工具: ${extra.join(', ')}`
        : `顾问严禁持有任何工具: ${extra.join(', ')}`,
    }
  }
  return { ok: true }
}

function deepFreezeSnapshot<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const v of Object.values(value as Record<string, unknown>)) {
      if (v && typeof v === 'object' && !Object.isFrozen(v)) {
        deepFreezeSnapshot(v)
      }
    }
  }
  return value
}

export interface FreezeAdvisorConsultInput {
  parentEngine: string | undefined | null
  requestedAdvisorModel: string
  advisorModels: readonly AdvisorModelOption[]
  unavailableReason?: string
  question: string
  concern: string
  source: AdvisorSnapshotInput
  execution?: AdvisorConsultExecution
  toolPolicy?: AdvisorToolPolicy
}

export type FreezeAdvisorConsultResult =
  | {
      ok: true
      parentEngine: string
      advisorModel: string
      snapshot: Readonly<AdvisorSnapshot>
      prompt: string
    }
  | { ok: false; code: 'PARENT_ENGINE_DENIED' | 'ADVISOR_MODEL_DENIED' | 'ADVISOR_TOOLS_FORBIDDEN'; error: string }

/**
 * 冻结主引擎(含 Antigravity)发起 consult_advisor 时的上下文快照与无工具只读契约:
 *   1. 校验主引擎在 ADVISOR_CONSULT_PARENT_ENGINES 白名单内(含 antigravity);
 *   2. 校验目标顾问型号在已证明 catalog 中,绝不静默降级到弱模型;
 *   3. 校验无工具只读顾问硬约束(严禁写入/执行工具);
 *   4. 深拷贝并深度冻结 AdvisorSnapshot,防止后续主会话变更污染已提交的互审证据。
 */
export function freezeAdvisorConsultContext(
  input: FreezeAdvisorConsultInput,
): FreezeAdvisorConsultResult {
  const parentGate = advisorConsultParentGate(input.parentEngine)
  if (!parentGate.allowed || !parentGate.engine) {
    return {
      ok: false,
      code: 'PARENT_ENGINE_DENIED',
      error: parentGate.reason || ADVISOR_CONSULT_PARENT_REASON,
    }
  }
  const modelGate = assertAdvisorModelAllowed({
    requested: input.requestedAdvisorModel,
    advisorModels: input.advisorModels,
    unavailableReason: input.unavailableReason,
  })
  if (!modelGate.ok) {
    return {
      ok: false,
      code: 'ADVISOR_MODEL_DENIED',
      error: modelGate.error,
    }
  }
  const toolCheck = assertAdvisorReadOnlyNoTools(
    input.toolPolicy ?? { toolsDisabled: true, allowedTools: [] },
  )
  if (!toolCheck.ok) {
    return {
      ok: false,
      code: 'ADVISOR_TOOLS_FORBIDDEN',
      error: toolCheck.error,
    }
  }

  const built = buildAdvisorSnapshot({
    question: input.question,
    concern: input.concern,
    advisorModel: modelGate.model,
    source: {
      ...input.source,
      historyRecords: input.source.historyRecords
        ? input.source.historyRecords.map((r) => ({ ...r }))
        : undefined,
      currentTools: input.source.currentTools
        ? input.source.currentTools.map((t) => ({ ...t }))
        : undefined,
      authorizedArtifacts: input.source.authorizedArtifacts
        ? input.source.authorizedArtifacts.map((a) => ({ ...a }))
        : undefined,
    },
    execution: input.execution ? { ...input.execution } : undefined,
  })
  const frozenSnapshot = deepFreezeSnapshot(built)
  const prompt = formatAdvisorConsultPrompt(frozenSnapshot)
  return {
    ok: true,
    parentEngine: parentGate.engine,
    advisorModel: modelGate.model,
    snapshot: frozenSnapshot,
    prompt,
  }
}

export { ADVISOR_AGENT_ID }
