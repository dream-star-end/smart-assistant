/**
 * Map Antigravity CLI tool steps onto the existing product tool cards.
 *
 * Names and parameter keys are the 1.3.4 function declarations seen on the
 * wire (PascalCase keys such as `CommandLine`, `AbsolutePath`). The CLI's
 * stream-json `tool_info.parameters` is a trimmed subset of the call: e.g.
 * `write_to_file` reports only `TargetFile`, never `CodeContent`, and
 * `view_file` reports a summary ("2 lines, 6 bytes") as output. Cards
 * therefore show what the CLI exposes; nothing here invents content.
 *
 * MCP tools are lazy in Antigravity: the model calls native `call_mcp_tool`
 * with `{ServerName, ToolName, Arguments}`. They become `mcp__server__tool`
 * with the inner Arguments as input, the same shape CCB produces.
 */

const PRODUCT_NAMES: Record<string, string> = {
  run_command: 'Bash',
  view_file: 'Read',
  read_file: 'Read',
  write_to_file: 'Write',
  write_file: 'Write',
  replace_file_content: 'Edit',
  multi_replace_file_content: 'Edit',
  edit_file: 'Edit',
  sed_file: 'Edit',
  grep_search: 'Grep',
  find_by_name: 'Glob',
  list_dir: 'Glob',
  read_url_content: 'WebFetch',
  search_web: 'WebSearch',
  notebook_edit: 'NotebookEdit',
  // Antigravity 1.5.8 native swarm tools (OCV5-809).
  swarm: 'SwarmManage',
  post_message: 'SwarmPost',
  read_board: 'SwarmReadBoard',
  swarm_wait: 'SwarmWait',
}

/** Only keys whose declarations were captured on the wire. Tools that appear
 * in `init.tools` but were not declared upstream in the probe (grep_search,
 * find_by_name, list_dir, sed_file, …) keep their native keys untouched. */
const INPUT_KEYS: Record<string, Record<string, string>> = {
  run_command: { CommandLine: 'command', Cwd: 'cwd' },
  view_file: { AbsolutePath: 'file_path', StartLine: 'offset', EndLine: 'end_line' },
  read_file: { Path: 'file_path', StartLine: 'offset', EndLine: 'end_line' },
  write_to_file: { TargetFile: 'file_path', CodeContent: 'content' },
  write_file: { Path: 'file_path', Content: 'content' },
  replace_file_content: { TargetFile: 'file_path', TargetContent: 'old_string', ReplacementContent: 'new_string' },
  edit_file: { Path: 'file_path', Target: 'old_string', Replacement: 'new_string' },
  read_url_content: { Url: 'url' },
  search_web: { query: 'query', domain: 'domain' },
}

const SERVER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const TOOL_RE = /^[A-Za-z0-9_-]+$/
/** Antigravity 1.5+ eager MCP declaration name: `mcp_<server>_<tool>` (server has no `_`). */
const EAGER_MCP_RE = /^mcp_([A-Za-z0-9][A-Za-z0-9.-]*)_([A-Za-z0-9_-]+)$/

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function mcpTarget(input: unknown): { server: string; tool: string; args: unknown } | null {
  const obj = recordOf(input)
  if (!obj) return null
  const server = typeof obj.ServerName === 'string' ? obj.ServerName : ''
  const tool = typeof obj.ToolName === 'string' ? obj.ToolName : ''
  if (!SERVER_RE.test(server) || !TOOL_RE.test(tool)) return null
  return { server, tool, args: obj.Arguments ?? {} }
}

function eagerMcpTarget(nativeName: string): { server: string; tool: string } | null {
  const match = EAGER_MCP_RE.exec(nativeName)
  if (!match) return null
  return { server: match[1]!, tool: match[2]! }
}

export function antigravityProductToolName(nativeName: string, input?: unknown): string {
  const name = nativeName.trim()
  if (name === 'call_mcp_tool') {
    const target = mcpTarget(input)
    if (target) return `mcp__${target.server}__${target.tool}`
  }
  const eager = eagerMcpTarget(name)
  if (eager) return `mcp__${eager.server}__${eager.tool}`
  return PRODUCT_NAMES[name] ?? (name || 'AntigravityTool')
}

export function antigravityProductToolInput(nativeName: string, input: unknown): unknown {
  const name = nativeName.trim()
  if (name === 'call_mcp_tool') {
    const target = mcpTarget(input)
    if (target) return target.args
  }
  const eager = eagerMcpTarget(name)
  if (eager) {
    const obj = recordOf(input)
    if (!obj) return input ?? {}
    if (eager.server === 'openclaude-memory' && 'toolSummary' in obj) {
      const { toolSummary: _ignored, ...rest } = obj
      return rest
    }
    return { ...obj }
  }
  const obj = recordOf(input)
  const keys = INPUT_KEYS[name]
  if (!obj || !keys) return input ?? {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    out[keys[key] ?? key] = value
  }
  return out
}

export function antigravityToolOutput(raw: unknown, nativeName?: string): string {
  if (raw === undefined || raw === null) return ''
  let text: string
  if (typeof raw === 'string') {
    text = raw.replace(/\r\n/g, '\n')
  } else {
    try {
      text = JSON.stringify(raw)
    } catch {
      text = String(raw)
    }
  }
  if (nativeName === 'swarm') {
    return sanitizeSwarmToolOutput(text)
  }
  return text
}

/** Strip local CLI `open_board` URLs/commands from swarm tool output because OpenClaude
 * renders the live Swarm Board natively in the web UI (OCV5-809). */
export function sanitizeSwarmToolOutput(text: string): string {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const copy = { ...(parsed as Record<string, unknown>) }
        if ('open_board' in copy) {
          delete copy.open_board
          return JSON.stringify(copy)
        }
      }
    } catch {
      // Fall through to text cleanup.
    }
  }
  return text
    .replace(/^\s*open_board\s*[:=].*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
