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
  write_to_file: 'Write',
  replace_file_content: 'Edit',
  multi_replace_file_content: 'Edit',
  sed_file: 'Edit',
  grep_search: 'Grep',
  find_by_name: 'Glob',
  list_dir: 'Glob',
  read_url_content: 'WebFetch',
  search_web: 'WebSearch',
  notebook_edit: 'NotebookEdit',
}

/** Only keys whose declarations were captured on the wire. Tools that appear
 * in `init.tools` but were not declared upstream in the probe (grep_search,
 * find_by_name, list_dir, sed_file, …) keep their native keys untouched. */
const INPUT_KEYS: Record<string, Record<string, string>> = {
  run_command: { CommandLine: 'command', Cwd: 'cwd' },
  view_file: { AbsolutePath: 'file_path', StartLine: 'offset', EndLine: 'end_line' },
  write_to_file: { TargetFile: 'file_path', CodeContent: 'content' },
  replace_file_content: { TargetFile: 'file_path', TargetContent: 'old_string', ReplacementContent: 'new_string' },
  read_url_content: { Url: 'url' },
  search_web: { query: 'query', domain: 'domain' },
}

const SERVER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const TOOL_RE = /^[A-Za-z0-9_-]+$/

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

export function antigravityProductToolName(nativeName: string, input?: unknown): string {
  const name = nativeName.trim()
  if (name === 'call_mcp_tool') {
    const target = mcpTarget(input)
    if (target) return `mcp__${target.server}__${target.tool}`
  }
  return PRODUCT_NAMES[name] ?? (name || 'AntigravityTool')
}

export function antigravityProductToolInput(nativeName: string, input: unknown): unknown {
  const name = nativeName.trim()
  if (name === 'call_mcp_tool') {
    const target = mcpTarget(input)
    if (target) return target.args
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

export function antigravityToolOutput(raw: unknown): string {
  if (raw === undefined || raw === null) return ''
  if (typeof raw === 'string') return raw.replace(/\r\n/g, '\n')
  try {
    return JSON.stringify(raw)
  } catch {
    return String(raw)
  }
}
