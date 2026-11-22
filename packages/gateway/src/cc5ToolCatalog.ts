/** The remote model's tool catalog: the container tool host's own tools under the Box alias rules
 * (OCV5-300), so a remote chat names tools exactly like a Box chat (`mcp__ocbridge__<alias>`). */
import { createHash } from 'node:crypto'

export interface Cc5HostTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}
/** Tool sources of the container tool host: the same files a local chat's CLI is started with. */
export interface Cc5HostProfile {
  cwd: string
  mcpConfigPath: string | null
  settingsPath: string | null
  disallowedTools: string[]
}
export interface Cc5ToolCatalog {
  /** Exact bytes the node serves as its MCP tools/list; bounded by cc5-host-controller.py. */
  readonly json: string
  readonly sha256: string
  /** `mcp__ocbridge__<alias>` -> the container tool host's name. */
  readonly clientNameByRemoteName: Readonly<Record<string, string>>
}

const NATURAL_ALIAS = /^[A-Za-z0-9_-]{1,48}$/
const OPAQUE_ALIAS = /^t[0-9]{1,3}$/
const DESCRIPTION_MAX_BYTES = 20480
const CATALOG_MAX_BYTES = 1048576
export const CC5_PROMPT_MAX_BYTES = 262144
export const REMOTE_V4_PROMPT_MAX_BYTES = 1024 * 1024

function requireCatalog(value: unknown): asserts value {
  if (!value) throw new Error('CC5_TOOL_CATALOG_INVALID')
}
function utf8Head(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString('utf8')
}

export function compileCc5ToolCatalog(hostTools: readonly Cc5HostTool[]): Cc5ToolCatalog {
  requireCatalog(hostTools.length >= 1 && hostTools.length <= 128)
  const clientNameByRemoteName: Record<string, string> = {}
  const tools = hostTools.map((tool, index) => {
    const alias = NATURAL_ALIAS.test(tool.name) && !OPAQUE_ALIAS.test(tool.name) ? tool.name : `t${index}`
    const remote = `mcp__ocbridge__${alias}`
    requireCatalog(!Object.hasOwn(clientNameByRemoteName, remote))
    clientNameByRemoteName[remote] = tool.name
    // An opaque alias keeps the real name visible, as Box does.
    const description = alias === tool.name ? tool.description : `OpenClaude tool name: ${tool.name}. ${tool.description}`
    const note = '\n[description truncated]'
    return { name: alias, inputSchema: tool.inputSchema,
      description: Buffer.byteLength(description) <= DESCRIPTION_MAX_BYTES ? description
        : utf8Head(description, DESCRIPTION_MAX_BYTES - Buffer.byteLength(note)) + note }
  })
  const json = JSON.stringify({ tools })
  requireCatalog(Buffer.byteLength(json) <= CATALOG_MAX_BYTES)
  return { json, sha256: createHash('sha256').update(json).digest('hex'),
    clientNameByRemoteName: Object.freeze(clientNameByRemoteName) }
}

/** Same wording as the Box notice (commercial boxToolAliasNotice), plus where the tools run. */
export function cc5ToolNamingNotice(catalog: Cc5ToolCatalog, cwd: string): string {
  const names = Object.entries(catalog.clientNameByRemoteName)
  return ['<tool-naming>',
    'In this session every tool is provided by the MCP server "ocbridge" under an alias.',
    'Wherever the instructions, tool descriptions or earlier messages name a tool by its plain name,',
    'call its alias instead. Plain names are not callable here and fail with "No such tool available".',
    ...names.map(([remote, client]) => `- ${client} → ${remote}`),
    ...(names.some(([, client]) => client === 'ExecuteExtraTool') ? [
      'Only the tools listed above exist in this run. Platform and MCP tools that are not listed',
      '(mcp__<server>__<tool>, e.g. mcp__openclaude-memory__delegate_task) are deferred tools: calling them',
      'by their own name fails with "No such tool available". Reach them through the listed ExecuteExtraTool',
      'alias with {"tool_name": "<full tool name>", "params": {...}}, and use SearchExtraTools first when unsure of the name.',
    ] : []),
    `Every tool runs in the user's container with working directory ${cwd} and the user's normal read/write`,
    "access; the user's timezone is the user_tz given above. Any environment, sandbox, permission, timezone or",
    'working-directory details the runtime adds on its own (e.g. <environment_context> or an environment',
    'section) describe an internal machine this run does not use: ignore them, and never mention that',
    'machine, its paths or its limits to the user.',
    '</tool-naming>'].join('\n')
}

const PROMPT_SECTION_SEPARATOR = '\n\n---\n\n'
const REMOTE_SKILLS_COMPACT =
  '# Skills\n\n技能摘要已因远端提示预算折叠；相关任务请先调用 `skill_search` 再 `skill_view` 按需加载。'

function trimSectionIndexBody(section: string, heading: string, targetBytes: number): string {
  const idx = section.indexOf(heading)
  if (idx < 0) return section
  const prefix = section.slice(0, idx).trimEnd()
  if (Buffer.byteLength(prefix, 'utf8') >= targetBytes) return prefix
  const indexBody = section.slice(idx + heading.length).trim()
  const lines = indexBody.split('\n')
  const suffix = '\n- ... (已因远端预算折叠，请按需检索)'
  const budget = targetBytes - Buffer.byteLength(`${prefix}\n\n${heading}\n\n`, 'utf8') - Buffer.byteLength(suffix, 'utf8')
  if (budget <= 0) return prefix
  const kept: string[] = []
  let used = 0
  for (const line of lines) {
    const cost = Buffer.byteLength(line, 'utf8') + (kept.length > 0 ? 1 : 0)
    if (used + cost > budget) break
    kept.push(line)
    used += cost
  }
  return kept.length > 0 ? `${prefix}\n\n${heading}\n\n${kept.join('\n')}${suffix}` : prefix
}

function stripSectionAssets(section: string): string {
  const startMarker = '<!-- oc-project-assets:start -->'
  const endMarker = '<!-- oc-project-assets:end -->'
  const start = section.indexOf(startMarker)
  const end = section.indexOf(endMarker)
  if (start < 0 || end <= start) return section
  const before = section.slice(0, start).trimEnd()
  const after = section.slice(end + endMarker.length).trimStart()
  const note = '（项目参考资料索引已因远端提示预算折叠，请调用 `project_search` 或读取项目目录。）'
  return [before, note, after].filter(Boolean).join('\n\n')
}

function stripAgentsDynamic(section: string): string {
  for (const heading of ['\n## 多 Agent 协作', '\n## 委派可用型号']) {
    const idx = section.indexOf(heading)
    if (idx >= 0) {
      return section.slice(0, idx).trimEnd()
    }
  }
  return section
}

/**
 * OCV5-840: Priority-preserving budget trim for remote prompts.
 * Trims low-priority dynamic sections (SKILLS -> MEMORY index -> PROJECT_MEMORY index
 * -> PROJECT assets -> AGENTS dynamic -> SOUL) before ever falling back to utf8Head,
 * so high-priority tail slots (REPO / RESEARCH / MODEL_HINT / TOOLS) survive.
 */
function fitRemotePlatformPrompt(platformPrompt: string, room: number): string {
  if (Buffer.byteLength(platformPrompt, 'utf8') <= room) return platformPrompt
  if (!platformPrompt.includes(PROMPT_SECTION_SEPARATOR)) {
    return utf8Head(platformPrompt, room)
  }
  const sections = platformPrompt.split(PROMPT_SECTION_SEPARATOR)
  const joinSections = () => sections.filter((s) => s.length > 0).join(PROMPT_SECTION_SEPARATOR)
  const totalBytes = () => Buffer.byteLength(joinSections(), 'utf8')

  const isSkills = (s: string) => s.startsWith('# Skills')
  const isMemory = (s: string) => s.startsWith('# Memory') || s.startsWith('## 当前索引')
  const isProjectMemory = (s: string) => s.startsWith('# PROJECT MEMORY')
  const isProject = (s: string) => s.startsWith('# PROJECT INSTRUCTIONS')
  const isAgentsDynamicOnly = (s: string) => s.startsWith('## 多 Agent 协作') || s.startsWith('## 委派可用型号')
  const isAgentsCombined = (s: string) => s.startsWith('# Platform capabilities')
  const isSoul = (s: string) => s.startsWith('# WHO I AM')

  // Step 1: Collapse SKILLS to L0 compact notice
  for (let i = 0; i < sections.length && totalBytes() > room; i++) {
    if (isSkills(sections[i]!)) sections[i] = REMOTE_SKILLS_COMPACT
  }
  // Step 2: Shrink or drop MEMORY index (preserve # Memory rules)
  for (let i = 0; i < sections.length && totalBytes() > room; i++) {
    const s = sections[i]!
    if (s.startsWith('## 当前索引')) {
      const target = Math.max(0, Math.floor(Buffer.byteLength(s, 'utf8') / 2))
      sections[i] = target > 256 ? trimSectionIndexBody(`## 当前索引\n\n${s.slice('## 当前索引'.length).trim()}`, '## 当前索引', target) : ''
    } else if (s.startsWith('# Memory') && s.includes('## 当前索引')) {
      const target = Math.max(256, Math.floor(Buffer.byteLength(s, 'utf8') / 2))
      sections[i] = trimSectionIndexBody(s, '## 当前索引', target)
    }
  }
  // Step 3: Shrink PROJECT_MEMORY index (preserve header)
  for (let i = 0; i < sections.length && totalBytes() > room; i++) {
    const s = sections[i]!
    if (isProjectMemory(s) && s.includes('## 项目索引')) {
      const target = Math.max(256, Math.floor(Buffer.byteLength(s, 'utf8') / 2))
      sections[i] = trimSectionIndexBody(s, '## 项目索引', target)
    }
  }
  // Step 4: Drop PROJECT assets block (preserve instructions)
  for (let i = 0; i < sections.length && totalBytes() > room; i++) {
    if (isProject(sections[i]!)) sections[i] = stripSectionAssets(sections[i]!)
  }
  // Step 5: Drop AGENTS dynamic roster / model list (preserve Platform capabilities)
  for (let i = 0; i < sections.length && totalBytes() > room; i++) {
    if (isAgentsDynamicOnly(sections[i]!)) sections[i] = ''
    else if (isAgentsCombined(sections[i]!)) sections[i] = stripAgentsDynamic(sections[i]!)
  }
  // Step 6: If still over, strip remaining MEMORY / PROJECT_MEMORY index bodies completely
  for (let i = 0; i < sections.length && totalBytes() > room; i++) {
    const s = sections[i]!
    if (s.startsWith('## 当前索引')) sections[i] = ''
    else if (isMemory(s) && s.includes('## 当前索引')) sections[i] = s.slice(0, s.indexOf('## 当前索引')).trimEnd()
    else if (isProjectMemory(s) && s.includes('## 项目索引')) sections[i] = s.slice(0, s.indexOf('## 项目索引')).trimEnd()
  }
  // Step 7: Trim SOUL if still over budget
  for (let i = 0; i < sections.length && totalBytes() > room; i++) {
    if (isSoul(sections[i]!)) {
      const excess = totalBytes() - room
      const cur = Buffer.byteLength(sections[i]!, 'utf8')
      const keep = Math.max(512, cur - excess - 64)
      if (keep < cur) {
        sections[i] = `${utf8Head(sections[i]!, keep)}\n\n[... SOUL truncated for remote prompt budget]`
      }
    }
  }

  const candidate = joinSections()
  return Buffer.byteLength(candidate, 'utf8') <= room ? candidate : utf8Head(candidate, room)
}

/** The platform prompt (persona, platform, skills, memory) plus the notice, within the node's bound. */
export function cc5RemotePrompt(
  platformPrompt: string,
  catalog: Cc5ToolCatalog,
  cwd: string,
  maxBytes = CC5_PROMPT_MAX_BYTES,
): string {
  const notice = cc5ToolNamingNotice(catalog, cwd)
  const room = maxBytes - Buffer.byteLength(notice) - 2
  requireCatalog(room > 0 && !platformPrompt.includes('\0') && !notice.includes('\0'))
  return `${fitRemotePlatformPrompt(platformPrompt, room)}\n\n${notice}`
}
