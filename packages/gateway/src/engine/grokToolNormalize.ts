/**
 * Map official Grok CLI tool events onto the existing product tool cards.
 *
 * Grok Build emits snake_case names (`run_terminal_command`) and internally
 * tagged outputs whose `output`/`stdout` fields are UTF-8 byte arrays. The
 * web/mobile cards already know Bash/Read/Edit/… — this layer is the single
 * adapter-side translation so neither frontend has to special-case Grok.
 */

const GROK_PRODUCT_NAMES: Record<string, string> = {
  run_terminal_command: 'Bash',
  run_terminal_cmd: 'Bash',
  bash: 'Bash',
  powershell: 'Bash',
  read_file: 'Read',
  hashline_read: 'Read',
  search_replace: 'Edit',
  hashline_edit: 'Edit',
  str_replace: 'Edit',
  write_file: 'Write',
  grep: 'Grep',
  hashline_grep: 'Grep',
  grep_search: 'Grep',
  list_dir: 'Glob',
  glob: 'Glob',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  todo_write: 'TodoWrite',
  ask_user_question: 'AskUserQuestion',
  enter_plan_mode: 'EnterPlanMode',
  exit_plan_mode: 'ExitPlanMode',
  spawn_subagent: 'Task',
  task: 'Task',
  get_task_output: 'TaskOutput',
  get_command_or_subagent_output: 'TaskOutput',
  get_terminal_command_output: 'TaskOutput',
  kill_command_or_subagent: 'TaskStop',
  kill_terminal_command: 'TaskStop',
  skill: 'Skill',
  scheduler_create: 'CronCreate',
  scheduler_delete: 'CronDelete',
  scheduler_list: 'CronList',
}

const MAX_BYTE_DECODE = 2 * 1024 * 1024

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function grokNativeKey(name: string): string {
  const trimmed = name.trim()
  if (!trimmed || trimmed.startsWith('mcp__')) return trimmed.toLowerCase()
  const colon = trimmed.lastIndexOf(':')
  const bare = colon >= 0 ? trimmed.slice(colon + 1) : trimmed
  return bare.replace(/-/g, '_').toLowerCase()
}

function pickString(input: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value) return value
  }
  return ''
}

/** UTF-8 byte arrays from Grok's serde of `Vec<u8>`. Anything else → null. */
export function decodeGrokUtf8Bytes(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  if (value.length === 0) return ''
  if (value.length > MAX_BYTE_DECODE) return null
  const bytes = new Uint8Array(value.length)
  for (let i = 0; i < value.length; i += 1) {
    const n = value[i]
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 255) return null
    bytes[i] = n
  }
  return Buffer.from(bytes).toString('utf8')
}

function stringifyFallback(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function textField(value: unknown): string | null {
  if (typeof value === 'string') return value
  return decodeGrokUtf8Bytes(value)
}

/**
 * Collapse Grok ToolOutput tagged unions into the string the product cards
 * already render. Byte arrays become UTF-8; prompt-oriented summaries win
 * over the raw tagged JSON.
 */
export function grokProductToolOutput(raw: unknown): string {
  if (raw === undefined || raw === null) return ''
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    // Only re-enter for JSON objects. A top-level number array is usually
    // line numbers / ids, not a Vec<u8> envelope.
    if (trimmed.startsWith('{') && trimmed.length < 4_000_000) {
      try {
        return grokProductToolOutput(JSON.parse(trimmed))
      } catch {
        return raw
      }
    }
    return raw
  }
  if (Array.isArray(raw)) return stringifyFallback(raw)
  const obj = recordOf(raw)
  if (!obj) return stringifyFallback(raw)

  const stdout = textField(obj.output) ?? textField(obj.stdout)
  const stderr = textField(obj.stderr)
  if (stdout !== null || stderr !== null) {
    const parts = [stdout, stderr].filter((part): part is string => part !== null && part !== '')
    let text = parts.join(parts[0]?.endsWith('\n') ? '' : '\n')
    if (typeof obj.exit_code === 'number' && obj.exit_code !== 0) {
      text = `${text}${text && !text.endsWith('\n') ? '\n' : ''}exit ${obj.exit_code}`
    }
    return text
  }

  for (const key of ['content', 'text', 'tool_output_for_prompt', 'summary_for_prompt', 'markdown', 'body'] as const) {
    const text = textField(obj[key])
    if (text) return text
  }
  return stringifyFallback(raw)
}

export function grokProductToolName(nativeName: string, input?: unknown): string {
  const trimmed = nativeName.trim()
  if (trimmed.startsWith('mcp__')) return trimmed
  const sep = trimmed.lastIndexOf('__')
  if (sep > 0) {
    const server = trimmed.slice(0, sep)
    const tool = trimmed.slice(sep + 2)
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(server) && /^[A-Za-z0-9_]+$/.test(tool)) {
      return `mcp__${server}__${tool}`
    }
  }
  const key = grokNativeKey(nativeName)
  if (key.startsWith('mcp__')) return nativeName
  if (key === 'call_mcp_tool' || key === 'mcp') {
    const obj = recordOf(input)
    const server = obj ? pickString(obj, 'server', 'server_name', 'serverIdentifier') : ''
    const tool = obj ? pickString(obj, 'tool_name', 'tool', 'name') : ''
    if (server && tool) return `mcp__${server}__${tool}`
  }
  const mapped = GROK_PRODUCT_NAMES[key]
  if (!mapped) return nativeName || 'GrokTool'
  if (mapped === 'Edit') {
    const obj = recordOf(input)
    const oldString = obj ? pickString(obj, 'old_string', 'oldString') : ''
    const newString = obj ? pickString(obj, 'new_string', 'newString', 'content', 'contents') : ''
    if (!oldString && newString) return 'Write'
  }
  return mapped
}

export function grokProductToolInput(nativeName: string, input: unknown): unknown {
  const obj = recordOf(input)
  if (!obj) return input ?? null
  const product = grokProductToolName(nativeName, input)
  const filePath = pickString(obj, 'file_path', 'path', 'absolute_path', 'target_file')
  switch (product) {
    case 'Bash':
      return {
        ...obj,
        command: pickString(obj, 'command', 'cmd') || stringifyFallback(obj.command),
        ...(pickString(obj, 'description') ? { description: pickString(obj, 'description') } : {}),
      }
    case 'Read':
      return {
        ...obj,
        ...(filePath ? { file_path: filePath } : {}),
      }
    case 'Write':
      return {
        ...obj,
        ...(filePath ? { file_path: filePath } : {}),
        content: pickString(obj, 'content', 'contents', 'new_string', 'newString') || stringifyFallback(obj.content),
      }
    case 'Edit':
      return {
        ...obj,
        ...(filePath ? { file_path: filePath } : {}),
        old_string: pickString(obj, 'old_string', 'oldString'),
        new_string: pickString(obj, 'new_string', 'newString'),
      }
    case 'Grep':
      return {
        ...obj,
        pattern: pickString(obj, 'pattern', 'query', 'search'),
        ...(pickString(obj, 'path', 'file_path') ? { path: pickString(obj, 'path', 'file_path') } : {}),
      }
    case 'Glob':
      return {
        ...obj,
        pattern: pickString(obj, 'glob_pattern', 'pattern', 'glob') || '*',
        ...(pickString(obj, 'path', 'target_directory') ? { path: pickString(obj, 'path', 'target_directory') } : {}),
      }
    case 'WebSearch':
      return {
        ...obj,
        query: pickString(obj, 'query', 'search_term', 'q'),
      }
    case 'WebFetch':
      return {
        ...obj,
        url: pickString(obj, 'url', 'href'),
      }
    case 'Task':
    case 'TaskOutput':
    case 'TaskStop':
      return {
        ...obj,
        description: pickString(obj, 'description', 'prompt', 'goal', 'title') || stringifyFallback(obj.description),
      }
    default:
      return obj
  }
}
