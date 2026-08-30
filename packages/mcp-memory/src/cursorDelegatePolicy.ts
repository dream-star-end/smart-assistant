/** Cursor hides sync MCP delegate tools; the bounded foreground path is `oc-memory delegate`. */

export const CURSOR_HIDDEN_DELEGATE_TOOLS = [
  'delegate_task',
  'delegate_tasks',
  'request_review',
] as const

export type CursorHiddenDelegateTool = (typeof CURSOR_HIDDEN_DELEGATE_TOOLS)[number]

export const DELEGATE_WAIT_TOOL_NAME = 'delegate_wait'

const HIDDEN = new Set<string>(CURSOR_HIDDEN_DELEGATE_TOOLS)

export function isCursorEngine(engine: string | undefined = process.env.OPENCLAUDE_ENGINE): boolean {
  return (engine || '').trim().toLowerCase() === 'cursor'
}

/** R4 档 A′. Default off. A lone non-1 value (including unset) keeps the tool hidden. */
export function isCursorMcpWaitEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.OC_DELEGATE_CURSOR_MCP_WAIT ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'on'
}

/** Cursor + flag on: list/call `delegate_wait`. Other engines keep today's tool list. */
export function shouldExposeDelegateWait(
  engine: string | undefined = process.env.OPENCLAUDE_ENGINE,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isCursorEngine(engine) && isCursorMcpWaitEnabled(env)
}

export function isCursorHiddenDelegateTool(
  name: string,
  engine: string | undefined = process.env.OPENCLAUDE_ENGINE,
): boolean {
  return isCursorEngine(engine) && HIDDEN.has(name)
}

/** ListTools filter: still hide the sync trio on Cursor; wait is flag-gated. */
export function filterListedDelegateTools<T extends { name: string }>(
  tools: readonly T[],
  engine: string | undefined = process.env.OPENCLAUDE_ENGINE,
  env: NodeJS.ProcessEnv = process.env,
): T[] {
  const exposeWait = shouldExposeDelegateWait(engine, env)
  return tools.filter((t) => {
    if (t.name === DELEGATE_WAIT_TOOL_NAME) return exposeWait
    return !isCursorHiddenDelegateTool(t.name, engine)
  })
}

export function delegateWaitDisabledText(): string {
  return [
    'status=disabled tool=delegate_wait',
    'OC_DELEGATE_CURSOR_MCP_WAIT=0（默认关）。Cursor MCP 未注册 delegate_wait。',
    '请用 Bash: oc-memory delegate-wait <jobId>',
  ].join('\n')
}

export function cursorDelegateCliHint(name = 'delegate_task'): string {
  if (name === 'request_review') {
    return [
      'Cursor MCP 已不再提供 request_review（60 秒硬超时，模型经常不等就交卷）。',
      '请立刻用 Bash 阻塞送审，不要再调 MCP：',
      '  oc-memory request-review --draft "<完整答复草稿>"',
    ].join('\n')
  }
  if (name === 'delegate_tasks') {
    return [
      'Cursor MCP 已不再提供 delegate_tasks。',
      '请在同一回合并行发起多条 Bash（超长任务会安全返回 jobId）：',
      '  oc-memory delegate --goal "<子任务>" [--agent-id <成员>] [--model <型号>]',
    ].join('\n')
  }
  return [
    'Cursor MCP 已不再提供 delegate_task（tools/call 60 秒硬超时，不能在 MCP 里等子任务）。',
    '请立刻用 Bash 前台委派，不要再调 MCP，也不要先交卷：',
    '  oc-memory delegate --goal "<任务>" [--agent-id <成员>] [--model <型号>] [--context "<上下文>"]',
    '该命令会开工并前台等待；超过安全窗口会返回 jobId，立即按 stdout 调 `oc-memory delegate-wait`，禁止改用 Cursor TaskOutput。',
  ].join('\n')
}
