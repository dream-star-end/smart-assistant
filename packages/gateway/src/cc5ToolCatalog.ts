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
    `Every tool runs in the user's container with working directory ${cwd}; the environment section's`,
    'working directory and platform describe the model host, not where files and commands live.',
    '</tool-naming>'].join('\n')
}

/** The platform prompt (persona, platform, skills, memory) plus the notice, within the node's bound. */
export function cc5RemotePrompt(platformPrompt: string, catalog: Cc5ToolCatalog, cwd: string): string {
  const notice = cc5ToolNamingNotice(catalog, cwd)
  const room = CC5_PROMPT_MAX_BYTES - Buffer.byteLength(notice) - 2
  requireCatalog(room > 0 && !platformPrompt.includes('\0') && !notice.includes('\0'))
  return `${utf8Head(platformPrompt, room)}\n\n${notice}`
}
