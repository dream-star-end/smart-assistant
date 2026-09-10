import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import {
  ADVISOR_AGENT_ID,
  type CollaborationMode,
  DEFAULT_ADVISOR_MODEL,
} from '@openclaude/protocol'
import { isPathWithinRoot } from './pathAcl.js'

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

export function isAdvisorEngineOpen(engine: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!engine) return false
  return openAdvisorEngines(env).has(engine)
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
    .map((row) => `- ${row.role ?? 'unknown'}: ${(row.text ?? row.toolResult ?? '').slice(0, 2000)}`)
    .join('\n')
  const tools = (snapshot.currentTools ?? [])
    .map((tool) => {
      const status = tool.completed ? 'completed' : 'in_progress'
      return `- ${tool.name ?? 'tool'} [${status}]: ${(tool.result ?? '').slice(0, 2000)}`
    })
    .join('\n')
  const artifacts = (snapshot.artifacts ?? [])
    .map((row) =>
      row.missing
        ? `- ${row.path} (missing: ${row.missing})`
        : `- ${row.path}\n${(row.content ?? '').slice(0, 4000)}`,
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
